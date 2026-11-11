import type { AppDatabase } from "./db.js";
import { createHash } from "node:crypto";
import { AppError } from "./tasks.js";
import { RemoteApiError } from "./adapters.js";
import { CHAT_DOCUMENT_TOOLS, executeChatDocumentTool } from "./chat-tools/documents.js";
import type { ChatToolRegistry } from "./chat-tools/registry.js";
import { protocolErrorFeature } from "./tool-protocol.js";
import { PresentationPaused, presentationEngine, readPresentationSubmission, type PresentationResume } from "./presentation-execution.js";
import { planPresentationWithAi } from "./ai-presentation.js";
import { evidencedPageCount, runTemplatePresentation } from "./presentation-workflow.js";
import { resolveThemeId } from "../shared/presentation-theme.js";
import { resolvePresentationSpec, runPresentationSpecUpdate } from "./chat-tools/presentation-spec-tool.js";
import { totalize } from "../shared/presentation-spec.js";
import { specCacheKey } from "./presentation-spec-store.js";
import { readProviderOutputCap, type StructuredWorkflowCall } from "./structured-workflow.js";
import { PresentationCheckQueue } from "./presentation-check-queue.js";
import { PublishPending } from "./document-publish.js";
import { presentationPageOperation, revisePresentation, type PresentationAction } from "./presentation-revision.js";
import { describeMindImages } from "./mind-image-vision.js";
import { renderWithLocalWps } from "./wps-auto-render.js";
import { reviewRenderedPresentation } from "./presentation-visual-review.js";
import type { BrainMessage, BrainResult, CallBrainOptions } from "./brain.js";
import { modelFingerprint } from "./capabilities.js";
import type { AgentStreamEvent, AgentToolName, ChatMessage, Conversation, ToolResult } from "../shared/agent-types.js";
import { isVisionBlocked } from "./agent-vision.js";
import type { BrainRunner } from "./agent-brain.js";

type BrainOptions = Parameters<BrainRunner["callBrainRaw"]>[4];

interface DocumentToolTurn {
  conversationId: string;
  turnConversation: Conversation;
  text: string | null;
  userMessage: ChatMessage | null;
  recoveredUser?: ChatMessage;
  resume: PresentationResume | null;
  signal: AbortSignal;
  callWithBudget(messages: BrainMessage[], options: BrainOptions, presentation?: boolean, onDispatch?: () => void): Promise<BrainResult>;
}

export class PresentationCoordinator {
  private readonly presentationChecks: PresentationCheckQueue;
  private readonly presentationOutputCaps = new Map<string, number>();

  constructor(private readonly db: AppDatabase, private readonly broadcast: (conversationId: string, event: AgentStreamEvent) => void) {
    this.presentationChecks = new PresentationCheckQueue(db);
    this.presentationChecks.recover();
  }

  dispose() {
    this.presentationChecks.dispose();
  }

  scheduleChecks() {
    this.presentationChecks.kick();
  }

  retryPresentationCheck(conversationId: string, fileId: string, sha256: string) {
    const version = this.db.getPresentationVersion(conversationId, fileId);
    if (!version || version.sha256 !== sha256) throw new AppError("DOCUMENT_NOT_FOUND", "找不到对应的 PPT 文件版本", 404);
    this.db.queuePresentationCheck(fileId, "unavailable");
    this.presentationChecks.kick();
  }

  async applyAction(input: {
    conversation: Conversation;
    fileId: string;
    sha256: string;
    action: PresentationAction;
    signal: AbortSignal;
    callModel(messages: BrainMessage[], options: BrainOptions): Promise<BrainResult>;
    isCurrent(): boolean;
  }) {
    const { conversation, fileId, sha256, action, signal, callModel, isCurrent } = input;
    const conversationId = conversation.id;
    let pending: ChatMessage | undefined;
    try {
      if (action.kind === "page" || action.kind === "review") {
        const operation = action.kind === "page" ? presentationPageOperation(fileId, sha256, action.page) : `ppt-visual:${fileId}:${sha256}:v1`;
        const previous = this.db.getWorkspaceDocumentByOperation(conversationId, operation);
        if (!previous || !this.db.getPresentationVersion(conversationId, previous.id)) {
          pending = this.db.startNativeToolCall(conversationId, "doc_edit", { fileId, ...(action.kind === "page" ? { page: action.page } : { action: "visual_review" }) }, operation, "doc_edit", sha256);
          this.broadcast(conversationId, { type: "message", message: pending });
        }
      }
      const capKey = this.presentationCapKey(conversation);
      let calls = 0, tokens = 0, usageMissing = false;
      const call: StructuredWorkflowCall = async (messages, schema, options) => {
        if (calls >= Math.min(60, conversation.chatModelCallLimit ?? 500) || tokens >= 200_000 || conversation.chatTokenLimit && (usageMissing || tokens >= conversation.chatTokenLimit)) throw new PresentationPaused("本次操作已达到模型预算，原文件保留，可从已保存的审阅步骤继续");
        calls++;
        const maxTokens = Math.min(options?.maxTokens ?? 8192, this.presentationOutputCaps.get(capKey) ?? Infinity);
        const tools = schema && !conversation.toolsUnsupported ? this.presentationSubmissionTools(schema) : {};
        try {
          const result = await callModel(messages, { silent: true, maxTokens, ...tools });
          if (result.usage?.complete) tokens += result.usage.promptTokens + result.usage.completionTokens;
          else usageMissing = true;
          return { ...result, content: readPresentationSubmission(result.toolCalls) ?? (result.toolCalls.length ? "" : result.content) };
        } catch (error) {
          if (this.rememberPresentationCap(error, capKey, maxTokens)) return { content: "", truncated: true };
          if (error instanceof RemoteApiError && /(?:tool_choice|tools|function.call).*(?:unsupported|not supported|不支持)|(?:unsupported|not supported|不支持).*(?:tools|tool_choice|function)/i.test(error.message)) {
            if (protocolErrorFeature(error) === "tools") conversation.toolsUnsupported = true;
            return { content: "", truncated: false };
          }
          throw error;
        }
      };
      const saved = await revisePresentation(this.db, conversationId, fileId, sha256, action, call, signal, text => {
        if (!pending || signal.aborted) return;
        this.db.updateMessage(pending.id, { content: `${text} · 模型调用 ${calls} · ${tokens.toLocaleString()} tokens` });
        const updated = this.db.getMessage(pending.id);
        if (updated) this.broadcast(conversationId, { type: "message", message: updated });
      });
      if (saved && pending) {
        const version = this.db.getPresentationVersion(conversationId, saved.id)!;
        this.publishPresentationAction(conversationId, pending, { ok: true, summary: action.kind === "page" ? `已补做第 ${action.page} 页并生成新版本。` : "视觉修复已另存新版本，请查看文件报告中的检查结果。", data: {
          workspaceFileId: saved.id, workspaceFileName: saved.name, byteSize: saved.byteSize, presentation: version.report,
        } });
        this.presentationChecks.kick();
      } else if (pending) {
        const report = this.db.getPresentationVersion(conversationId, fileId)?.report;
        this.publishPresentationAction(conversationId, pending, { ok: report?.visualReview?.status !== "unavailable", summary: report?.visualReview?.summary ?? "检查已结束，原文件保留" });
      }
      return { fileId: saved?.id ?? fileId };
    } catch (error) {
      if (error instanceof PublishPending) {
        if (pending && isCurrent()) this.publishPresentationAction(conversationId, pending, {
          ok: true, summary: `候选已产出并等待视觉检查；检查完成后会自动发布同一候选。`,
        });
        this.presentationChecks.kick();
        return { fileId, pendingVisualCheck: true };
      }
      if (pending && isCurrent()) this.publishPresentationAction(conversationId, pending, {
        ok: false, summary: signal.aborted ? "补做已停止" : error instanceof Error ? error.message : "补做失败",
      });
      throw error;
    }
  }

  private publishPresentationAction(conversationId: string, pending: ChatMessage, result: ToolResult) {
    const row = this.db.finishNativeToolCall(conversationId, pending.id, "doc_edit", result);
    const updated = this.db.getMessage(pending.id);
    if (updated) this.broadcast(conversationId, { type: "message", message: updated });
    this.broadcast(conversationId, { type: "message", message: row });
  }

  private presentationCapKey(conversation: Conversation) {
    return JSON.stringify([conversation.brainChannelId, this.db.getChannel(conversation.brainChannelId)?.updatedAt, conversation.brainModel]);
  }

  private rememberPresentationCap(error: unknown, key: string, requested: number) {
    if (!(error instanceof RemoteApiError) || error.status !== 400) return false;
    const cap = readProviderOutputCap(error.message, requested);
    if (!cap) return false;
    this.presentationOutputCaps.set(key, cap);
    return true;
  }

  private presentationSubmissionTools(schema: Record<string, unknown>): Pick<CallBrainOptions, "tools" | "toolChoice"> {
    return {
      tools: [{ type: "function", function: { name: "submit_presentation_result", description: "提交当前阶段的结构化结果", parameters: schema } }],
      toolChoice: { type: "function", function: { name: "submit_presentation_result" } },
    };
  }

  registerDocumentTools(registry: ChatToolRegistry, turn: DocumentToolTurn) {
    const { conversationId, turnConversation, text, userMessage, recoveredUser, resume, signal, callWithBudget } = turn;
    const channelFingerprint = JSON.stringify([
      turnConversation.brainChannelId, this.db.getChannel(turnConversation.brainChannelId)?.updatedAt,
      turnConversation.brainModel, turnConversation.visionEnabled,
    ]);
    for (const spec of CHAT_DOCUMENT_TOOLS) {
      const name = spec.function.name;
      registry.register({
        spec, displayName: name as AgentToolName, group: "docs", version: 1, kind: name === "doc_convert" ? "workflow" : "sync", resources: "conversation",
        ...(name === "doc_convert" ? { summary: "将 XMind、Markdown、文本或 CSV 转换为可编辑 PPT" } : {}),
        deduplicate: name === "doc_create" || name === "doc_edit" || name === "doc_convert",
        hideResult: name === "doc_read" || name === "doc_search" || name === "doc_list",
        run: async (raw, report, operationId) => {
          if (name === "presentation_spec_update") {
            // 证据必须来自会话里真实存在的用户消息，不能用模型提交的文本充当原文。
            const stored = userMessage?.id ? this.db.getMessage(userMessage.id) : null;
            const verifiedText = stored?.role === "user" && typeof stored.content === "string" ? stored.content : (text ?? "");
            return runPresentationSpecUpdate(this.db, conversationId, verifiedText, userMessage?.id ?? "current", raw);
          }
          const converting = name === "doc_convert";
          const resumed = converting ? resume : null;
          const engine = presentationEngine(resumed);
          const templated = converting && engine === "template";
          const currentRequest = resumed?.currentRequest ?? (resumed ? resumed.request : (userMessage ?? recoveredUser)?.content ?? "").slice(0, 8000);
          let targetPages = resumed?.targetPages;
          // A：优先用断点绑定的契约，其次继承唯一的 prepared 任务，最后才从当前消息新建。
          const specResolution = converting
            ? resolvePresentationSpec(this.db, conversationId, currentRequest, userMessage?.id ?? "current", resumed ?? undefined)
            : { spec: null, conflict: undefined };
          if (converting && specResolution.conflict) return { ok: false, summary: specResolution.conflict };
          let spec = specResolution.spec;
          // prepared 契约进入实际生成后必须激活，否则发布门禁按会话查不到当前任务，
          // 页数与必需内容校验会被整段跳过。续跑沿用已绑定的 revision，不重复激活。
          if (converting && spec && !resumed && spec.lifecycle !== "active") {
            spec = this.db.specs.setLifecycleOwned(conversationId, spec.specId, "active");
          }
          const requestText = resumed?.request ?? (converting ? this.db.listMessages(conversationId)
            .filter(message => message.role === "user" && (templated || !message.documents.length) && message.content && !/^(?:请)?(?:继续(?:PPT|制作PPT)?|重试|再试|重新试试)[。！!\s]*$/i.test(message.content.trim()))
            .slice(-5).map(message => message.content!.slice(0, 2000)).join("\n") : "");
          let calls = 0;
          let tokens = 0;
          let missingUsage = false;
          let completed = 0;
          let total: number | undefined;
          let sourceFingerprint: string | undefined;
          let textFallback = turnConversation.toolsUnsupported;
          const runId = resumed?.operationId ?? operationId!;
          let workflowStarted = false;
          const ensureWorkflow = () => {
            if (!converting || workflowStarted) return;
            this.db.workflows.begin({ id: runId, conversationId, capability: "doc_convert", version: 1,
              inputFingerprint: createHash("sha256").update(JSON.stringify([raw, requestText, channelFingerprint, engine])).digest("hex") });
            workflowStarted = true;
          };
          const capKey = this.presentationCapKey(turnConversation);
          const persistResume = () => {
            const state: PresentationResume = {
              engine, operationId: runId, args: raw, request: requestText, currentRequest, targetPages,
              specId: spec?.specId, specRevision: spec?.revision, channelFingerprint, sourceFingerprint,
              calls: (resumed?.calls ?? 0) + calls, tokens: (resumed?.tokens ?? 0) + tokens,
              usageMissing: Boolean(resumed?.usageMissing || missingUsage),
            };
            ensureWorkflow();
            this.db.workflows.checkpoint(conversationId, runId, state);
            this.db.savePresentationResume(conversationId, state);
            return state;
          };
          const modelRequest = async (messages: BrainMessage[], schema?: Record<string, unknown>, maxTokens?: number) => {
            signal.throwIfAborted();
            if (converting && calls >= 80) throw new PresentationPaused("本次执行已达到 PPT 模型调用上限（80 次）");
            if (converting && tokens >= 200_000) throw new PresentationPaused("本次执行已达到 PPT 用量上限（200,000 tokens）");
            const result = await callWithBudget(messages, {
              silent: true,
              // 推理模型可能把默认 16k 全用在思考上；PPT 单页结构化输出给足额度。
              maxTokens: templated ? maxTokens ?? 8192 : 32_000,
              ...(schema ? this.presentationSubmissionTools(schema) : {}),
            }, converting, () => {
              calls++;
              if (converting) persistResume();
            });
            if (result.usage?.complete) tokens += result.usage.promptTokens + result.usage.completionTokens;
            else missingUsage = true;
            if (converting) persistResume();
            return result;
          };
          const requestStructured: StructuredWorkflowCall = async (messages, schema, options) => {
            if (!schema || textFallback) return modelRequest(messages, undefined, options?.maxTokens);
            try {
              const result = await modelRequest(messages, schema, options?.maxTokens);
              const submission = readPresentationSubmission(result.toolCalls);
              if (submission !== undefined) return { ...result, content: submission };
              if (!result.toolCalls.length && result.content.trim()) return result;
              if (result.truncated) return result;
              if (templated) return { ...result, content: "" };
            } catch (error) {
              if (protocolErrorFeature(error) === "toolChoice") return modelRequest(messages, schema, options?.maxTokens);
              if (!(error instanceof RemoteApiError) || !/(?:tool_choice|tools|function.call).*(?:unsupported|not supported|不支持)|(?:unsupported|not supported|不支持).*(?:tools|tool_choice|function)/i.test(error.message)) throw error;
            }
            textFallback = true;
            report?.("渠道未返回唯一有效的结构化结果，本次 PPT 改用文本兼容格式");
            return modelRequest(messages, undefined, options?.maxTokens);
          };
          const structuredCall: StructuredWorkflowCall = async (messages, schema, options) => {
            const maxTokens = Math.min(options?.maxTokens ?? 8192, this.presentationOutputCaps.get(capKey) ?? Infinity);
            try { return await requestStructured(messages, schema, { maxTokens }); }
            catch (error) {
              if (templated && this.rememberPresentationCap(error, capKey, maxTokens)) return { content: "", truncated: true };
              throw error;
            }
          };
          const scope = channelFingerprint;
          const cache = {
            get: (key: string) => this.db.getPresentationBatch(conversationId, key),
            set: (key: string, value: string) => {
              this.db.savePresentationBatch(conversationId, key, value);
              if (workflowStarted && value !== "attempted") this.db.workflows.step(conversationId, runId, key, value);
            },
          };
          try {
            if (resumed && resumed.channelFingerprint !== channelFingerprint) return { ok: false, summary: "模型、渠道配置或看图设置已改变。请恢复原设置后继续 PPT，或发起新的制作要求。" };
            const existing = resumed ? this.db.getWorkspaceDocumentByOperation(conversationId, runId) : null;
            if (existing) {
              this.db.clearPresentationResume(conversationId);
              return { ok: true, summary: `PPT 已生成：${existing.name}`, data: { fileId: existing.id, fileName: existing.name, byteSize: existing.byteSize } };
            }
            ensureWorkflow();
            const result = await executeChatDocumentTool(this.db, conversationId, name, raw, async (mind, images, design, fingerprint, coverAssetId, pageCount, pageCountEvidence, style) => {
              if (resumed?.sourceFingerprint && resumed.sourceFingerprint !== fingerprint) throw new Error("源文件、风格参考或封面素材已变化，请发起新的 PPT 制作要求");
              sourceFingerprint = fingerprint;
              if (converting) persistResume();
              if (turnConversation.visionEnabled && !isVisionBlocked(this.db, turnConversation) && images.length) await describeMindImages(mind, images, async messages => {
                const key = createHash("sha256").update(JSON.stringify([scope, "image-v1", messages])).digest("hex");
                const saved = cache.get(key);
                if (saved) return { content: saved, truncated: false };
                const result = await modelRequest(messages);
                if (!result.truncated && result.content.trim()) cache.set(key, result.content.trim());
                return result;
              }, report, signal);
              if (templated) return runTemplatePresentation(mind, structuredCall, {
                request: requestText, currentRequest, targetPages,
                pageCount: resumed && resumed.currentRequest === undefined ? pageCount : evidencedPageCount(currentRequest, pageCount, pageCountEvidence),
                // 契约里的页数优先于当前消息与资料章节数，实现跨轮继承。
                ...(spec?.pageCount ? { pageCountConstraint: totalize(spec.pageCount, spec.pageCountBasis) } : {}),
                // 结构要求必须传给总策划，否则模型不知道要分配几个案例页。
                ...(spec?.structure?.some(item => item.kind === "case_count")
                  ? { requiredCaseCount: spec.structure.find(item => item.kind === "case_count")!.value }
                  : {}),
                // 语义必需内容交给内容审校逐项核验，结论随报告传到发布门禁。
                ...(spec?.requiredContent?.length
                  ? { requiredContent: spec.requiredContent.map(item => ({ id: item.id, description: item.description })) }
                  : {}),
                // D2：主题只决定皮肤，坐标仍由确定性渲染器计算。
                // 优先级：本次调用的 style 参数 > 契约里记录的风格原文。
                ...(resolveThemeId(style) ?? resolveThemeId(spec?.styleRequest?.text)
                  ? { themeId: (resolveThemeId(style) ?? resolveThemeId(spec?.styleRequest?.text))! }
                  : {}),
                ...(style ?? spec?.styleRequest?.text
                  ? { styleRequest: String(style ?? spec?.styleRequest?.text) }
                  : {}),
                // A 修复：把执行开始时的契约版本一直传到发布入口，
                // 不让 saveWorkspaceDocument 用 findActive 重新猜当前任务。
                ...(spec ? { specRef: { specId: spec.specId, specRevision: spec.revision } } : {}),
                onPageCount: count => { targetPages = count; persistResume(); },
                images, design, hasCover: Boolean(coverAssetId),
                scope: `${scope}\n${sourceFingerprint}\n${specCacheKey(spec)}`, ...cache, signal: signal, progress: report,
              });
              return planPresentationWithAi(mind, requestText, structuredCall, report, {
                scope: `${scope}\n${sourceFingerprint}`,
                ...cache,
              }, structuredCall, { pagewise: true, globalPlan: true, deepRead: true, images, design,
                onPageReady: (count, pageCount) => { completed = count; total = pageCount; },
              });
            }, runId, async (plan, images, pageNumbers) => {
              signal.throwIfAborted();
              if (!turnConversation.visionEnabled) return { plan, summary: "会话未启用看图，未进行实际页面视觉检查", status: "unavailable" as const };
              if (isVisionBlocked(this.db, turnConversation)) return { plan, summary: "当前模型不接受图片，未进行实际页面视觉检查", status: "unavailable" as const };
              // C：doc_edit 与 doc_convert 共用视觉缓存；键按「页内容+截图+主题+策略」复用，
              // 不再因文件哈希变化而整体失效。doc_edit 传入 ChangeScope 推导的原页码集合。
              const visualCache = { ...cache, scope, engineVersion: "visual-v2", modelFingerprint: scope };
              const result = await reviewRenderedPresentation(plan, images, bytes => renderWithLocalWps(this.db, bytes, signal), modelRequest, report, visualCache, pageNumbers);
              signal.throwIfAborted();
              // 发布层只认真实检查结论：complete 且无阻塞问题才能标成「已检查」。
              return {
                plan: result.plan, summary: result.summary, metrics: result.metrics,
                status: result.complete && !result.issues.length ? "complete" as const : "partial" as const,
                blocking: result.issues.map(issue => `第 ${issue.page} 页：${issue.detail}`),
                checkedPages: result.checkedPages,
              };
            }, {
              // A 收口：legacy 生成入口也显式绑定本次执行的契约版本。
              ...(spec ? { specRef: { specId: spec.specId, specRevision: spec.revision } } : {}),
            });
            signal.throwIfAborted();
            if (workflowStarted) {
              const usage = { calls: (resumed?.calls ?? 0) + calls, tokens: (resumed?.tokens ?? 0) + tokens, usageMissing: Boolean(resumed?.usageMissing || missingUsage) };
              this.db.workflows.checkpoint(conversationId, runId, usage);
              this.db.workflows.finish(conversationId, runId, result.paused || !result.ok && templated ? "paused" : result.ok ? "completed" : "failed", result.summary,
                typeof result.data?.fileId === "string" ? result.data.fileId : undefined);
              result.uiData = { ...result.uiData, workflow: { runId, ...usage } };
            }
            if (converting && result.ok && !result.paused) {
              this.db.clearPresentationResume(conversationId);
              // 任务真正完成才释放家族引用，暂停期间旧版本仍受保护。
              this.db.specs.releaseFamilyRef(`ppt-run:${runId}`);
            }
            if (templated && sourceFingerprint && !result.ok && !result.paused) {
              return { ...result, paused: true, summary: `${result.summary}。已保存通过的页面，发送「继续 PPT」可从断点续做。` };
            }
            if (templated && result.uiData) {
              const count = (resumed?.calls ?? 0) + calls;
              const usage = ((resumed?.tokens ?? 0) + tokens).toLocaleString();
              const partial = resumed?.usageMissing || missingUsage;
              return { ...result, summary: `${result.summary}累计 PPT 模型调用 ${count} 次，${partial ? "至少 " : ""}${usage} tokens${partial ? "（渠道用量不完整）" : ""}。` };
            }
            return result;
          } catch (error) {
            if (!(error instanceof PresentationPaused)) {
              if (workflowStarted) this.db.workflows.finish(conversationId, runId, signal.aborted ? "paused" : "failed", error instanceof Error ? error.message : "执行失败");
              throw error;
            }
            const state = persistResume();
            this.db.workflows.finish(conversationId, runId, "paused", error.message);
            const progress = total === undefined ? "正在准备页面目录" : `已通过内容审校 ${completed}/${total} 页`;
            const usage = state.usageMissing ? `至少 ${state.tokens.toLocaleString()} tokens（渠道用量不完整）` : `${state.tokens.toLocaleString()} tokens`;
            return { ok: false, paused: true, summary: `PPT 已暂停。${error.message}。${progress}。累计调用 ${state.calls} 次，${usage}。发送「继续 PPT」可从同一任务的断点继续。`, uiData: { workflow: { runId, calls:state.calls, tokens:state.tokens, usageMissing:state.usageMissing } } };
          }
        },
      });
    }
  }
}
