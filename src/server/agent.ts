/**
 * 对话式 Agent 的主循环（AGENT_PLAN.md §7、§9、§12、§13、§15）。
 *
 * 一句话概括这个文件在干什么：
 * **把任务列表里那份 §7 系统提示词，执行成一串 TaskRunner 调用。**
 *
 * 三个需要理解的设计：
 *
 * 1. **用 JSON 协议而不是原生 function calling**（§7.3）。中转站会把 `tools`
 *    参数改坏或直接丢掉，而模型对「只输出一个 JSON 对象」这种指令遵从度很高。
 *    代价是解析要写得宽容——去代码块、取第一个平衡花括号、包一层 `{"plan":{}}`
 *    也要认。
 * 2. **工具执行是串行的，一轮一个**（§16）。这样「先画图看结果再决定要不要改」
 *    才成立，也避免了并发提交把会话任务额度瞬间吃光。
 * 3. **这个类不持有 HTTP 请求**。SSE 靠每个会话一个订阅者集合广播，
 *    所以视频任务在几分钟后完成时，即使当初那个 HTTP 连接早就断了，
 *    自动续跑的输出照样能推给重新连上的客户端（§12.2）。
 */
import type { AppDatabase, AssetRow } from "./db.js";
import { createHash } from "node:crypto";
import type { TaskEvent, TaskRunner } from "./tasks.js";
import { AppError, isTerminalStatus } from "./tasks.js";
import type { KeyStore } from "./key-store.js";
import { RemoteApiError } from "./adapters.js";
import { CHAT_DOCUMENT_TOOLS, executeChatDocumentTool } from "./chat-tools/documents.js";
import { ChatToolRegistry, type ChatTool, type ChatToolResult, type PreparedToolConfirmation } from "./chat-tools/registry.js";
import { protocolErrorFeature, readToolProtocol } from "./tool-protocol.js";
import { createPlanTool } from "./chat-tools/planning.js";
import { compactNativeToolReads } from "./chat-tools/context.js";
import { parseNativeTurnCheckpoint, type NativeTurnCheckpoint } from "./chat-tools/checkpoint.js";
import { nativeImageSpecs, nativeImageViewSpec, prepareNativeImage, requestsDirectSingleImage, viewNativeImages, type NativeMediaConfirmation } from "./chat-tools/native-image.js";
import { nativeVideoSpec, prepareNativeVideo } from "./chat-tools/native-video.js";
import { nativeAudioSpecs, prepareNativeAudio } from "./chat-tools/native-audio.js";
import { createNativeTemplateTool } from "./chat-tools/native-templates.js";
import { createNativeUtilityTool } from "./chat-tools/native-utility.js";
import { createCapabilitySearchTool, initialToolGroups } from "./chat-tools/capability-search.js";
import { PresentationPaused, presentationEngine, readPresentationSubmission, type PresentationResume } from "./presentation-execution.js";
import { planPresentationWithAi } from "./ai-presentation.js";
import { evidencedPageCount, runTemplatePresentation } from "./presentation-workflow.js";
import { resolveThemeId } from "../shared/presentation-theme.js";
import { resolvePresentationSpec, runPresentationSpecUpdate } from "./chat-tools/presentation-spec-tool.js";
import { totalize } from "../shared/presentation-spec.js";
import { specCacheKey } from "./presentation-spec-store.js";
import { readProviderOutputCap, type StructuredWorkflowCall } from "./structured-workflow.js";
import { PresentationCheckQueue } from "./presentation-check-queue.js";
import { presentationPageOperation, revisePresentation, type PresentationAction } from "./presentation-revision.js";
import { describeMindImages } from "./mind-image-vision.js";
import { renderWithLocalWps } from "./wps-auto-render.js";
import { reviewRenderedPresentation } from "./presentation-visual-review.js";
import { BrainError, callBrain, type BrainContentPart, type BrainMessage, type BrainResult, type CallBrainOptions } from "./brain.js";
import {
  buildCapabilityAliases,
  buildCapabilityManifest,
  markVisionUnsupported,
  modelFingerprint,
  readVisionUnsupported,
  resolveAlias,
} from "./capabilities.js";
import {
  resolveAssetRef, resolveImageRefs, resolveVideoSelection, TOOL_SCHEMAS,
  type ToolContext, type ToolOutcome, type VideoSelection,
} from "./agent-tools.js";
import { assetVisionParts } from "./vision.js";
import {
  AGENT_TOOL_NAMES,
  GENERATION_TOOLS,
  IMAGE_PRODUCING_TOOLS,
  assetRef,
  planCalls,
  AUTO_TITLE_MAX_CHARS,
  DEFAULT_CONVERSATION_TITLE,
  usesPlainChat,
  usesNativeCreativeTools,
  type AgentPlan,
  type AgentStreamEvent,
  type AgentToolName,
  type ChatMessage,
  type ChatVideoFrames,
  type ConfirmPreview,
  type ConfirmVideoInput,
  type Conversation,
  type ConversationView,
  type GenerateVideoArgs,
  type PlannedCall,
  type ToolResult,
  type VideoConfirmPolicy,
} from "../shared/agent-types.js";
import { isImageAsset, MAX_CANVAS_IMAGES, taskKindFor } from "../shared/types.js";
import { midjourneyUsableButtons } from "../shared/midjourney.js";
import {
  MAX_ROUNDS, MAX_AUTO_CONTINUE, MAX_SESSION_TASKS, MAX_PARSE_RETRY,
  MAX_VISION_READS_PER_ROUND, MAX_VISION_IMAGES,
} from "./agent-constants.js";
import {
  BATCHABLE_TOOLS, asBool, asNumber, asString, extractPlanText, parsePlan, repairPlan,
  resolveBatch, salvagePlan,
} from "./agent-plan.js";
import {
  buildConfirmPreview, mergeConfirmArgs, shouldConfirm, withConfirmedVideoSelection,
} from "./agent-confirm.js";
import {
  EMPTY_REPLY_CORRECTION, IDENTITY_CORRECTION, collectTurnAttachmentIds, looksLikeIdentityDrift,
  toBrainMessage, type BuiltContext,
} from "./agent-context.js";
import {
  describeBrainFailure, isBrainDown, isBrainTimeout, isFatalBrainError, isVisionError,
} from "./agent-brain-errors.js";
import { buildSystemPrompt } from "./agent-prompt.js";
import { inspectBoardGeneration } from "./board-assistant.js";
import { previewBoardOps } from "./board-agent.js";
import { boardApplySchema, boardGenerateSchema } from "../shared/board-ops.js";
import { BatchExecutor, type BatchOutcome } from "./agent-batch.js";
import { isVisionBlocked, observeImages } from "./agent-vision.js";
import { handleTaskEvent } from "./agent-task-events.js";
import { BrainRunner } from "./agent-brain.js";

// 测试和外部调用仍从 `agent.ts` 导入这些纯函数，保留原来的入口
export {
  BATCHABLE_TOOLS, extractPlanText, parsePlan, repairPlan, resolveBatch, salvagePlan,
} from "./agent-plan.js";
export {
  mergeConfirmArgs, shouldConfirm, withConfirmedVideoSelection,
} from "./agent-confirm.js";
export { buildSystemPrompt } from "./agent-prompt.js";
export { collectTurnAttachmentIds, looksLikeIdentityDrift, toBrainMessage } from "./agent-context.js";
export {
  MAX_ROUNDS, MAX_AUTO_CONTINUE, MAX_SESSION_TASKS, MAX_PARSE_RETRY,
  MAX_VISION_READS_PER_ROUND, MAX_VISION_IMAGES,
} from "./agent-constants.js";

export type TurnTrigger = "user" | "task_finished" | "confirmation" | "recovered";

export class AgentService {
  /** 每个会话的 SSE 订阅者。HTTP 断开会退订，但会话本身继续跑（§12.2） */
  private readonly listeners = new Map<string, Set<(event: AgentStreamEvent) => void>>();
  /** 正在跑的那一轮。同一会话同时只允许一轮（§16 串行） */
  private readonly activeTurns = new Map<string, AbortController>();
  private readonly detachRunner: () => void;
  private readonly batch: BatchExecutor;
  private readonly brain: BrainRunner;
  private readonly presentationChecks: PresentationCheckQueue;
  private readonly presentationOutputCaps = new Map<string, number>();

  constructor(
    private readonly db: AppDatabase,
    private readonly runner: TaskRunner,
    private readonly sessionKeys: KeyStore,
  ) {
    this.batch = new BatchExecutor({
      db: this.db,
      executeTool: (conversation, plan, controller, options, turnAttachmentIds) =>
        this.executeTool(conversation, plan, controller, options, turnAttachmentIds),
      toolContext: (conversation, controller, options, turnAttachmentIds) =>
        this.toolContext(conversation, controller, options, turnAttachmentIds),
      broadcast: (conversationId, event) => this.broadcast(conversationId, event),
    });
    this.brain = new BrainRunner({
      db: this.db,
      sessionKeys: this.sessionKeys,
      broadcast: (conversationId, event) => this.broadcast(conversationId, event),
    });
    this.detachRunner = runner.onTaskEvent((event) => handleTaskEvent(this.taskEventHost(), event));
    this.presentationChecks = new PresentationCheckQueue(db);
    this.presentationChecks.recover();
  }

  private taskEventHost() {
    return {
      db: this.db,
      broadcast: (conversationId: string, event: AgentStreamEvent) => this.broadcast(conversationId, event),
      hasActiveTurn: (conversationId: string) => this.activeTurns.has(conversationId),
      startTurn: (conversationId: string, text: null, trigger: "task_finished") =>
        this.startTurn(conversationId, text, trigger),
      reportTurnFailure: (conversationId: string, error: unknown) =>
        this.reportTurnFailure(conversationId, error),
      finishNativeTask: (conversation: Conversation, pending: ChatMessage, operation: ChatMessage, result: ToolResult, state: NativeMediaConfirmation) =>
        this.finishNativeTask(conversation, pending, operation, result, state),
    };
  }

  dispose() {
    this.detachRunner();
    this.presentationChecks.dispose();
    this.db.workflows.releaseOwned();
    for (const controller of this.activeTurns.values()) controller.abort();
    this.activeTurns.clear();
    this.listeners.clear();
  }

  isRunning(conversationId: string) {
    return this.activeTurns.has(conversationId);
  }

  retryPresentationCheck(conversationId: string, fileId: string, sha256: string) {
    const version = this.db.getPresentationVersion(conversationId, fileId);
    if (!version || version.sha256 !== sha256) throw new AppError("DOCUMENT_NOT_FOUND", "找不到对应的 PPT 文件版本", 404);
    this.db.queuePresentationCheck(fileId, "unavailable");
    this.presentationChecks.kick();
  }

  async applyPresentationAction(conversationId: string, fileId: string, sha256: string, action: PresentationAction) {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation) throw new AppError("CONVERSATION_NOT_FOUND", "会话不存在", 404);
    if (conversation.toolScope === "conversation") throw new AppError("TOOLS_DISABLED", "请在对话设置中开启工具", 409);
    if (this.activeTurns.has(conversationId) || conversation.status !== "idle") throw new AppError("TURN_IN_FLIGHT", "当前会话正在处理，请稍候", 409);
    const version = this.db.getPresentationVersion(conversationId, fileId);
    if (!version) throw new AppError("DOCUMENT_NOT_FOUND", "找不到可操作的 PPT 版本", 404);
    if (version.sha256 !== sha256) throw new AppError("DOCUMENT_CHANGED", "PPT 文件版本已变化", 409);
    if (action.kind === "review" && (!conversation.visionEnabled || isVisionBlocked(this.db, conversation))) throw new AppError("VISION_DISABLED", "请先开启看图并选择支持图片输入的对话模型", 409);
    const controller = new AbortController();
    this.activeTurns.set(conversationId, controller);
    this.setStatus(conversationId, "running");
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
          const result = await this.brain.callBrainRaw(conversation, messages, controller, conversationId, { silent: true, maxTokens, ...tools });
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
      const saved = await revisePresentation(this.db, conversationId, fileId, sha256, action, call, controller.signal, text => {
        if (!pending || controller.signal.aborted) return;
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
      if (pending && this.activeTurns.get(conversationId) === controller) this.publishPresentationAction(conversationId, pending, {
        ok: false, summary: controller.signal.aborted ? "补做已停止" : error instanceof Error ? error.message : "补做失败",
      });
      throw error;
    } finally {
      if (this.activeTurns.get(conversationId) === controller) {
        this.activeTurns.delete(conversationId);
        this.setStatus(conversationId, "idle");
        this.broadcast(conversationId, { type: "done", status: "idle" });
      }
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

  /** 中断当前这一轮。任务已经提交出去的部分照常跑完，只是大脑不再往下规划 */
  interrupt(conversationId: string) {
    const controller = this.activeTurns.get(conversationId);
    if (!controller) return false;
    this.db.clearNativeTurnCheckpoint(conversationId);
    controller.abort();
    return true;
  }

  subscribe(conversationId: string, listener: (event: AgentStreamEvent) => void): () => void {
    const bucket = this.listeners.get(conversationId) ?? new Set();
    bucket.add(listener);
    this.listeners.set(conversationId, bucket);
    return () => {
      bucket.delete(listener);
      if (!bucket.size) this.listeners.delete(conversationId);
    };
  }

  private broadcast(conversationId: string, event: AgentStreamEvent) {
    const bucket = this.listeners.get(conversationId);
    if (!bucket) return;
    for (const listener of bucket) {
      try {
        listener(event);
      } catch {
        // 单个客户端写失败不能拖垮这一轮
      }
    }
  }

  /** 详情页要用的完整视图 */
  buildView(conversationId: string): ConversationView | null {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation) return null;
    const entries = this.db.listConversationAssets(conversationId);
    const toCanvasAsset = (entry: (typeof entries)[number]) => ({
      asset: this.db.assetView(entry.asset), round: entry.round, prompt: entry.prompt, source: entry.source,
    });
    return {
      ...conversation,
      visionBlocked: isVisionBlocked(this.db, conversation),
      contextSummary: this.db.getContextSummary(conversationId),
      // 老消息里没有 MJ 按钮；读视图时从任务 meta 补上，历史结果也能直接继续 U/V/R
      messages: this.db.listMessagesAfter(conversationId, 0).map((message) => this.withMidjourneyButtons(message)),
      // token 账本：状态行显示「上下文多大 / 这个会话一共花了多少 token」
      usage: this.db.conversationUsage(conversationId),
      // 当前画布那一组，顺序同 canvasAssetIds（不能按时间重排——第一张是画布序号 1）。
      // 走 db.canvasImages 而不是自己 map：它顺手滤掉已被删掉的产物和非图片
      canvasImages: this.db.canvasImages(conversation).map((asset) => this.db.assetView(asset)),
      // 「本会话的图」是仓库，按时间正序；只认图片——视频不给「加入画布」（§10.1 规则 2）
      sessionImages: entries.filter((entry) => isImageAsset(entry.asset)).map(toCanvasAsset),
      // 但「能点开看的」要连视频一起给——否则前端找不到视频的 mimeType，
      // 灯箱照旧当图片渲染，用户看到的就是一个裂图（需求.md 问题 3）
      mediaAssets: entries.map(toCanvasAsset),
      storyboardCount: this.db.countStoryboardShots(conversationId),
    };
  }

  /** 老 MJ 结果没有把按钮写进消息；视图层从任务 meta 补，不改库 */
  private withMidjourneyButtons(message: ChatMessage): ChatMessage {
    const result = message.toolResult;
    const taskId = result?.taskId;
    const data = result?.data;
    if (!taskId || !data || typeof data.model !== "string" || !data.model.startsWith("mj_")) return message;
    if (Array.isArray(data.midjourneyButtons)) return message;
    const task = this.db.getTaskView(taskId);
    const buttons = midjourneyUsableButtons(task?.remoteMeta?.midjourney?.buttons ?? []);
    if (!buttons.length) return message;
    return {
      ...message,
      toolResult: { ...result, data: { ...data, midjourneyButtons: buttons, midjourneyTaskId: taskId } },
    };
  }

  // ── 对外入口 ───────────────────────────────────────────────────────────────

  /**
   * 开始一轮。**立即返回**，产出全部走 SSE（§14）。
   *
   * 抛出的异常只有「本地就能判定」的那几种（会话不存在、上一轮没结束），
   * 大脑和上游的错误一律变成 `error` 事件推给前端。
   */
  startTurn(conversationId: string, text: string | null, trigger: TurnTrigger, assetRefs: string[] = [], videoFrames?: ChatVideoFrames) {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation) throw new AppError("CONVERSATION_NOT_FOUND", "会话不存在", 404);
    if (this.activeTurns.has(conversationId)) {
      throw new AppError("TURN_IN_FLIGHT", "上一条还在处理中，请稍候", 409);
    }
    if (text !== null) this.db.clearNativeTurnCheckpoint(conversationId);
    const controller = new AbortController();
    this.activeTurns.set(conversationId, controller);
    void this.turn(conversationId, text, trigger, controller, assetRefs, conversation, videoFrames)
      .catch((error) => this.reportTurnFailure(conversationId, error))
      .finally(() => {
        this.activeTurns.delete(conversationId);
        // 收尾时兜一下状态：正常路径都会自己设好，这里只防异常路径把会话永久卡在 running
        const latest = this.db.getConversation(conversationId);
        if (latest?.status === "running") {
          this.db.setConversationStatus(conversationId, "idle", { touch: false });
          this.broadcast(conversationId, { type: "done", status: "idle" });
        }
        /*
         * 任务比消息先结束的那种（提交即失败最快）：完成事件发出去的时候，
         * 工具消息还没落库，handleTaskEvent 找不到人接手；等消息落库了，
         * 这一轮又还没结束，会撞上它那道 `activeTurns` 的闸。
         * 现在这一轮真的结束了、闸也抬起来了——补查一次，让它照常收口。
         * 正常情况下（视频还在跑）这里是空转：任务没终态，什么都不做。
         */
        if (this.db.getConversation(conversationId)?.status === "waiting_task") {
          this.settleFinishedTasks(conversationId);
        }
      });
  }

  /** 手动压缩只整理历史，不启动创作循环或提交生成任务。 */
  async compressNow(conversationId: string) {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation) throw new AppError("CONVERSATION_NOT_FOUND", "会话不存在", 404);
    if (this.activeTurns.has(conversationId)) throw new AppError("TURN_IN_FLIGHT", "当前会话正在处理，请稍候", 409);
    if (conversation.status === "waiting_task") throw new AppError("TASK_IN_FLIGHT", "当前有任务等待自动续跑，请等任务结束后再手动压缩", 409);
    const controller = new AbortController();
    this.activeTurns.set(conversationId, controller);
    try {
      return await this.brain.prepareCompression(conversation, controller, [], true);
    } finally {
      this.activeTurns.delete(conversationId);
      const latest = this.db.getConversation(conversationId);
      if (latest) this.broadcast(conversationId, { type: "done", status: latest.status });
    }
  }

  /**
   * §13.5 确认卡片的两个出口。
   *
   * `argsOverride` 是用户在卡片上改过的视频参数（时长/分辨率/音频/提示词扩展）。
   * 只放行这几个旋钮：模型是大脑选的、渠道是别名解析出来的，卡片上那行只是给用户看的，
   * 改它不在卡片的设计意图里，放行反而会让「显示的和生成的不一致」。
   */
  async resolveConfirmation(
    conversationId: string,
    messageId: string,
    decision: "approve" | "reject",
    argsOverride?: Record<string, unknown>,
  ) {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation) throw new AppError("CONVERSATION_NOT_FOUND", "会话不存在", 404);
    const message = this.db.getMessage(messageId);
    if (!message || message.conversationId !== conversationId) throw new AppError("MESSAGE_NOT_FOUND", "消息不存在", 404);
    if (message.status !== "pending" || !message.confirm) throw new AppError("NOT_PENDING", "这条已经处理过了", 409);
    if (this.activeTurns.has(conversationId)) throw new AppError("TURN_IN_FLIGHT", "上一条还在处理中，请稍候", 409);

    if (decision === "reject") {
      // 卡片收起来，并把「用户取消了」记进上下文——下次大脑开口时知道这件事
      if (!this.db.claimAgentConfirmation(message, decision)) throw new AppError("NOT_PENDING", "这条已经处理过了", 409);
      const recorded = this.db.appendMessage({
        conversationId, role: "system", content: "已取消本次生成",
      });
      const updated = this.db.getMessage(messageId);
      if (updated) this.broadcast(conversationId, { type: "message", message: updated });
      this.broadcast(conversationId, { type: "message", message: recorded });
      this.db.setConversationStatus(conversationId, "idle", { touch: false });
      this.broadcast(conversationId, { type: "done", status: "idle" });
      return;
    }

    // 批量待确认的卡上**没有** toolName——写上去 UI 会把它当成「只画一张」，
    // 整批调用存在 plan.calls 里。两条路分开走：单调用那条一个字节都不动。
    const batch = planCalls(message.plan);
    const nativeMedia = this.db.getNativeMediaConfirmation(message.id);
    if (batch.length > 1) {
      if (nativeMedia) this.validateNativeConfirmation(conversation, nativeMedia, batch.map(call => call.args));
      if (!this.db.claimAgentConfirmation(message, decision)) throw new AppError("NOT_PENDING", "这条已经处理过了", 409);
      const batchController = new AbortController();
      this.activeTurns.set(conversationId, batchController);
      // 原生生图的批量带着断点；旧 JSON 批量没有，按原路径收尾。
      const nativeBatch = this.db.getNativeMediaConfirmation(message.id);
      // 批量里只可能是产图工具，没有时长/分辨率这类旋钮，所以卡片上不会有 argsOverride。
      // 真有也别悄悄套上去：那些字段对生图没有意义，套上去等于编造一份「用户改过的参数」
      void this.approveBatch(conversationId, message.id, batch, batchController, message.plan?.consistency, nativeBatch)
        .catch((error) => this.reportTurnFailure(conversationId, error))
        .finally(() => {
          this.activeTurns.delete(conversationId);
          if (this.db.getConversation(conversationId)?.status === "waiting_task") this.settleFinishedTasks(conversationId);
        });
      return;
    }

    const tool = message.toolName;
    if (!tool || !(AGENT_TOOL_NAMES as readonly string[]).includes(tool)) {
      throw new AppError("INVALID_PLAN", "这条待确认记录缺少工具信息", 400);
    }
    // 先落库再执行：执行中途刷新页面时，用户看到的参数必须是真正拿去生成的那份
    const merged = mergeConfirmArgs(message.toolName, message.toolArgs ?? {}, argsOverride);
    // 升级前就摆在那里的视频卡片没有 videoInputs / imageRefs：
    // 按卡片上当时显示的「主图当首帧」补回去，免得用户点确认时突然被要求重选
    const args = withConfirmedVideoSelection(merged, message.confirm);
    if (nativeMedia) this.validateNativeConfirmation(conversation, nativeMedia, [args]);
    if (!this.db.claimAgentConfirmation(message, decision, args)) throw new AppError("NOT_PENDING", "这条已经处理过了", 409);
    const controller = new AbortController();
    this.activeTurns.set(conversationId, controller);

    void this.approve(conversationId, message.id, tool, args, controller, nativeMedia)
      .catch((error) => this.reportTurnFailure(conversationId, error))
      .finally(() => {
        this.activeTurns.delete(conversationId);
        if (this.db.getConversation(conversationId)?.status === "waiting_task") this.settleFinishedTasks(conversationId);
      });
  }

  private validateNativeConfirmation(conversation: Conversation, state: NativeMediaConfirmation, calls: Record<string, unknown>[]) {
    const { target, checkpoint } = state;
    const mediaChannel = this.db.getChannel(target.channelId);
    const brainChannel = this.db.getChannel(conversation.brainChannelId);
    const aliases = buildCapabilityAliases(this.db.listChannels());
    if (conversation.brainChannelId !== checkpoint.channelId || conversation.brainModel !== checkpoint.model
      || brainChannel?.updatedAt !== checkpoint.channelVersion
      || !mediaChannel?.enabled || mediaChannel.updatedAt !== target.channelVersion
      || calls.some(args => {
        const resolved = resolveAlias(aliases, asString(args.modelHint), target.kind);
        return resolved?.channelId !== target.channelId || resolved.model !== target.model;
      })) {
      throw new AppError("CONFIRMATION_STALE", "生成或对话渠道已改变，请取消这张确认卡后重新发起请求。", 409);
    }
  }

  // ── 主循环 ─────────────────────────────────────────────────────────────────

  /**
   * 用第一条指令的前几个字当会话名（对齐 Codex）。
   *
   * 只在标题还是默认值时才动手——用户改过名字就说明这个名字是他要的，
   * 后面每一轮都去覆盖它会让「重命名」这个功能直接失效。
   * 之所以放在服务端而不是前端：会话名是库里的字段，从哪台设备、哪个入口发第一条消息都得生效。
   */
  private nameFromFirstMessage(conversationId: string, text: string) {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation || conversation.title !== DEFAULT_CONVERSATION_TITLE) return;
    // 消息可能是多行的，标题只取第一行的形状：折成一行再截断
    const line = text.replace(/\s+/g, " ").trim();
    if (!line) return;
    const title = line.length > AUTO_TITLE_MAX_CHARS ? `${line.slice(0, AUTO_TITLE_MAX_CHARS)}…` : line;
    this.db.updateConversation(conversationId, { title });
  }

  private async turn(
    conversationId: string,
    text: string | null,
    trigger: TurnTrigger,
    controller: AbortController,
    assetRefs: string[] = [],
    turnConversation: Conversation,
    videoFrames?: ChatVideoFrames,
  ) {
    const plain = usesPlainChat(turnConversation);
    let userMessage: ChatMessage | null = null;
    // 这一轮附带的图只算一次：工具执行到最后一条消息已经是助手计划行，
    // 再回头扫数据库找不到用户那几条，所以必须在这里锁住并一路传下去
    let turnAttachmentIds: string[] = [];
    if (text !== null) {
      // 引用的一组装在**同一条消息**上：用户拖了三张图说了句话，界面上就是一条气泡
      // 配三张缩略图，而不是四条消息
      userMessage = this.db.appendMessage({ conversationId, role: "user", content: text, assetRefs, videoFrames });
      turnAttachmentIds = collectTurnAttachmentIds(this.db, conversationId, userMessage.seq);
      this.broadcast(conversationId, { type: "message", message: userMessage });
      this.nameFromFirstMessage(conversationId, text);
      this.db.resetAutoContinue(conversationId);
      this.supersedePendingConfirmations(conversationId, plain);
    }
    this.setStatus(conversationId, "running");
    try {
      if (trigger !== "recovered") await this.brain.prepareCompression(turnConversation, controller, turnAttachmentIds);
      if (plain) {
        const built = await this.brain.buildBrainMessages(turnConversation, turnAttachmentIds);
        const checkpoint = trigger === "recovered" ? parseNativeTurnCheckpoint(this.db.getNativeTurnCheckpoint(conversationId)) : null;
        if (trigger === "recovered" && !checkpoint) throw new Error("任务断点不可用，请检查已完成的操作后重新发送请求。");
        const turnStartedAt = Date.now() - (checkpoint?.elapsedMs ?? 0);
        let brainCalls = checkpoint?.brainCalls ?? 0;
        let usedTokens = checkpoint?.usedTokens ?? 0;
        let usageMissing = checkpoint?.usageMissing ?? false;
        const maxTokens = turnConversation.chatTokenLimit ?? 0;
        const maxBrainCalls = turnConversation.chatModelCallLimit ?? 500;
        const maxTurnMinutes = turnConversation.chatTurnMinutes ?? 30;
        let toolProtocolRetried = false;
        const callWithBudget = async (messages: BrainMessage[], options: Parameters<typeof this.brain.callBrainRaw>[4], presentation = false, onDispatch?: () => void): Promise<BrainResult> => {
          const stop = (message: string): never => { throw presentation ? new PresentationPaused(message) : new Error(message); };
          if (brainCalls >= maxBrainCalls) stop(`本轮模型调用已达 ${maxBrainCalls} 次上限`);
          if (Date.now() - turnStartedAt > maxTurnMinutes * 60_000) stop(`本轮处理已超过 ${maxTurnMinutes} 分钟`);
          if (maxTokens && usageMissing) stop("渠道未提供完整 token 用量，无法执行本轮用量上限");
          if (maxTokens && usedTokens >= maxTokens) stop(`本轮已用 ${usedTokens} tokens，达到 ${maxTokens} 的上限`);
          // A resumed turn can include images collected before the user changed the setting.
          if (options?.plain && (!turnConversation.visionEnabled || isVisionBlocked(this.db, turnConversation))
            && messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url"))) {
            messages = [...messages.map((message): BrainMessage => message.role !== "tool" && Array.isArray(message.content)
              ? { ...message, content: message.content.filter(part => part.type !== "image_url") }
              : message), { role: "system", content: "本次请求没有传入图片，不能声称看到了画面。" }];
          }
          brainCalls++;
          onDispatch?.();
          let result: BrainResult;
          try {
            result = await this.brain.callBrainRaw(turnConversation, messages, controller, conversationId, options);
          } catch (error) {
            // A resumed image task may carry a generated-image attachment. If this
            // brain rejects images, degrade once and retry the same turn without them.
            const hasImage = messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url"));
            if (!hasImage || controller.signal.aborted || !isVisionError(error)) throw error;
            this.broadcast(conversationId, { type: "reset" });
            this.brain.degradeVision(turnConversation, error);
            const withoutImages = messages.map((message): BrainMessage => Array.isArray(message.content)
              ? { ...message, content: message.content.filter(part => part.type !== "image_url") } as BrainMessage
              : message);
            return callWithBudget([...withoutImages, { role: "system", content: "渠道拒绝了图片输入，图片没有传给模型。不得声称看到了画面内容；需要判断时请用户描述或换支持视觉的模型。" }], options, presentation, onDispatch);
          }
          const usage = result.usage;
          if (usage?.complete && usage.promptTokens + usage.completionTokens > 0) usedTokens += usage.promptTokens + usage.completionTokens;
          else usageMissing = true;
          if (options?.plain && result.invalidToolText) {
            this.broadcast(conversationId, { type: "reset" });
            if (toolProtocolRetried) throw new Error("渠道返回了无法验证的工具调用。请重试或切换对话模型。");
            toolProtocolRetried = true;
            return callWithBudget([...messages, { role: "system", content: "上一响应的工具调用格式无效。请使用 API 的原生工具调用字段，并完整提供参数。" }], options);
          }
          return result;
        };
        const channelFingerprint = JSON.stringify([
          turnConversation.brainChannelId, this.db.getChannel(turnConversation.brainChannelId)?.updatedAt,
          turnConversation.brainModel, turnConversation.visionEnabled,
        ]);
        const resumeRequested = /^(?:请)?继续(?:\s*PPT|制作\s*PPT)[。！!\s]*$/i.test(text?.trim() ?? "");
        const resume = resumeRequested && turnConversation.toolScope !== "conversation" ? this.db.getPresentationResume(conversationId) : null;
        const nativeCreative = usesNativeCreativeTools(turnConversation);
        const recoveredUser = trigger === "recovered"
          ? this.db.listMessages(conversationId).filter(message => message.role === "user").at(-1)
          : undefined;
        const frameMessage = turnConversation.toolScope === "all" ? recoveredUser ?? userMessage : userMessage;
        const turnVideoFrames = frameMessage?.videoFrames;
        const registry = new ChatToolRegistry({
          before: (event, raw) => this.db.executions.begin(event, createHash("sha256").update(raw).digest("hex")),
          after: (event, result) => {
            const workflow = result.uiData?.workflow as { runId?: string } | undefined;
            this.db.executions.finish(event.operationId, result.execution?.state ?? (result.paused ? "paused" : result.ok ? "completed" : "failed"), { workflowId: workflow?.runId });
          },
        });
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
                controller.signal.throwIfAborted();
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
                  }, report, controller.signal);
                  if (templated) return runTemplatePresentation(mind, structuredCall, {
                    request: requestText, currentRequest, targetPages,
                    pageCount: resumed && resumed.currentRequest === undefined ? pageCount : evidencedPageCount(currentRequest, pageCount, pageCountEvidence),
                    // 契约里的页数优先于当前消息与资料章节数，实现跨轮继承。
                    ...(spec?.pageCount ? { pageCountConstraint: totalize(spec.pageCount, spec.pageCountBasis) } : {}),
                    // 结构要求必须传给总策划，否则模型不知道要分配几个案例页。
                    ...(spec?.structure?.some(item => item.kind === "case_count")
                      ? { requiredCaseCount: spec.structure.find(item => item.kind === "case_count")!.value }
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
                    scope: `${scope}\n${sourceFingerprint}\n${specCacheKey(spec)}`, ...cache, signal: controller.signal, progress: report,
                  });
                  return planPresentationWithAi(mind, requestText, structuredCall, report, {
                    scope: `${scope}\n${sourceFingerprint}`,
                    ...cache,
                  }, structuredCall, { pagewise: true, globalPlan: true, deepRead: true, images, design,
                    onPageReady: (count, pageCount) => { completed = count; total = pageCount; },
                  });
                }, runId, async (plan, images, pageNumbers) => {
                  controller.signal.throwIfAborted();
                  if (!turnConversation.visionEnabled) return { plan, summary: "会话未启用看图，未进行实际页面视觉检查" };
                  if (isVisionBlocked(this.db, turnConversation)) return { plan, summary: "当前模型不接受图片，未进行实际页面视觉检查" };
                  // C：doc_edit 与 doc_convert 共用视觉缓存；键按「页内容+截图+主题+策略」复用，
                  // 不再因文件哈希变化而整体失效。doc_edit 传入 ChangeScope 推导的原页码集合。
                  const visualCache = { ...cache, scope, engineVersion: "visual-v2", modelFingerprint: scope };
                  const result = await reviewRenderedPresentation(plan, images, bytes => renderWithLocalWps(this.db, bytes, controller.signal), modelRequest, report, visualCache, pageNumbers);
                  controller.signal.throwIfAborted();
                  return result;
                });
                controller.signal.throwIfAborted();
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
                  if (workflowStarted) this.db.workflows.finish(conversationId, runId, controller.signal.aborted ? "paused" : "failed", error instanceof Error ? error.message : "执行失败");
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
        registry.register(createPlanTool());
        registry.register(createCapabilitySearchTool(registry));
        if (nativeCreative) {
          const registerConfirmed = (spec: ChatTool["spec"], name: AgentToolName, prepareConfirmation: NonNullable<ChatTool["prepareConfirmation"]>) => registry.register({
            spec, displayName: name,
            group: name === "generate_video" ? "video" : name === "generate_music" || name === "generate_speech" ? "audio" : "image",
            prepareConfirmation,
            run: async () => ({ ok: false, summary: "此生成调用需要单独处理，请先完成当前批次" }),
          });
          for (const name of ["generate_image", "edit_image"] as const) {
            registerConfirmed(nativeImageSpecs[name], name, raw => prepareNativeImage(this.db, turnConversation, name, raw, turnAttachmentIds, this.defaultAliases().image));
          }
          // 看图关闭时不挂 view_images：挂上去只会让模型多调一次、多一条失败卡。
          if (turnConversation.visionEnabled && !isVisionBlocked(this.db, turnConversation)) {
            registry.register({ spec: nativeImageViewSpec, displayName: "view_images", group: "image", run: raw => viewNativeImages(this.db, this.db.getConversation(conversationId) ?? turnConversation, raw) });
          }
          registerConfirmed(nativeVideoSpec, "generate_video", raw => prepareNativeVideo(this.db, turnConversation, raw, turnAttachmentIds, this.defaultAliases().video, turnVideoFrames));
          for (const name of ["generate_music", "generate_speech"] as const) {
            registerConfirmed(nativeAudioSpecs[name], name, raw => prepareNativeAudio(this.toolContext(turnConversation, controller, {}), name, raw));
          }
          for (const name of ["create_canvas_template", "create_storyboard_template"] as const) {
            registry.register(createNativeTemplateTool(name, () => this.toolContext(turnConversation, controller, {})));
          }
          for (const name of ["set_canvas", "optimize_prompt"] as const) {
            registry.register(createNativeUtilityTool(name, () => this.toolContext(turnConversation, controller, {})));
          }
        }
        // 能力组：首轮按用户意图和会话状态预加载；恢复轮沿用断点里记录的组。
        const initialGroups = initialToolGroups({
          text: userMessage?.content ?? text ?? this.db.lastUserText(conversationId) ?? null,
          hasAttachments: turnAttachmentIds.length > 0,
          hasDocuments: this.db.listConversationDocuments(conversationId).length > 0
            || this.db.listWorkspaceDocuments(conversationId).length > 0,
          hasImages: this.db.canvasImages(turnConversation).length > 0
            || this.db.listConversationAssets(conversationId).some(entry => entry.asset.mimeType.startsWith("image/")),
        });
        // 旧断点没有 activeTools：当时还没有能力组，恢复成全量工具，保持原签名可继续。
        const restoredSpecs = checkpoint
          ? (checkpoint.activeTools
            ? checkpoint.activeTools.map(name => registry.get(name)?.spec).filter((spec): spec is ChatTool["spec"] => Boolean(spec))
            : registry.specs())
          : [];
        // 渠道明确报过「不支持 tools」之后，这次对话不再发工具定义，省掉每轮一次的失败调用
        const protocolChannel = this.db.getChannel(turnConversation.brainChannelId);
        const toolsRejected = protocolChannel && readToolProtocol(this.db, protocolChannel, turnConversation.brainModel).tools?.supported === false;
        let toolSpecs = turnConversation.toolsUnsupported || toolsRejected || turnConversation.toolScope === "conversation"
          ? []
          : checkpoint
            ? restoredSpecs
            : registry.specs(initialGroups);
        let toolSignature = this.toolSignatureOf(toolSpecs);
        // A 新增 presentation_spec_update：旧版本保存的断点不含它，签名按「排除新工具」兼容一次。
        // 该工具只记录要求、不改变已有操作的执行语义，因此允许带旧签名继续恢复。
        const legacyToolSignature = this.toolSignatureOf(toolSpecs.filter(spec => spec.function.name !== "presentation_spec_update"));
        const channelVersion = this.db.getChannel(turnConversation.brainChannelId)?.updatedAt ?? "";
        if (checkpoint && (checkpoint.channelId !== turnConversation.brainChannelId || !channelVersion || checkpoint.channelVersion !== channelVersion || checkpoint.model !== turnConversation.brainModel || (checkpoint.toolSignature !== toolSignature && checkpoint.toolSignature !== legacyToolSignature))) throw new Error("模型、渠道配置或可用工具已改变，无法安全自动恢复；请检查已完成的操作后继续。");
        const lastPlan = this.db.listMessages(conversationId).filter((message) => message.role === "tool" && message.toolName === "plan_update" && message.status === "ok").at(-1);
        const context: BrainMessage[] = [{ role: "system", content: `复杂任务应分步规划、使用工具并检查结果；仅在实际完成后声称完成。${lastPlan?.content ? `\n本会话最近的任务计划（可能属于之前的任务，仅在相关时参考）：\n${lastPlan.content}` : ""}` }];
        let plainMessages = checkpoint?.messages ?? [...context, ...built.messages];
        if (toolsRejected && turnConversation.toolScope !== "conversation") plainMessages.push({ role: "system", content: "此渠道配置和模型已明确拒绝原生工具，本轮仅文字回答，不能声称创建文件或提交生成任务。用户可在模型设置重新测试工具能力。" });
        const previousCalls = new Map<string, ChatToolResult>(checkpoint?.previousCalls ?? []);
        let toolRounds = checkpoint?.toolRounds ?? 0;
        // 一轮里 PPT 失败后不允许模型自己换源再转一次；一次失败已经可能花掉十万级 token。
        // 但参数校验失败不是执行失败：模型把 to 写成 "PPT" 时，应该允许它修正后再试一次。
        let docConvertFailed = false;
        let docConvertValidationRetries = 0;
        let lastFileMutationFailure = "";
        let nativeVisionReads = checkpoint?.messages.reduce((count, message) => count + (message.role === "assistant" ? message.tool_calls?.filter(call => call.function.name === "view_images").length ?? 0 : 0), 0) ?? 0;
        const maxToolRounds = turnConversation.chatToolRoundLimit ?? 16;
        let checkpointNoticeSent = false;
        if (checkpoint) {
          const note = this.db.appendMessage({ conversationId, role: "system", content: "已从上次完成的工具步骤继续；未完成的操作不会自动重放。" });
          this.broadcast(conversationId, { type: "message", message: note });
        }
        let result: BrainResult;
        try {
          result = resume ? {
            content: "", reasoning: "", finishReason: "tool_calls", usage: null, durationMs: 0, usedFallback: false, truncated: false,
            toolCalls: [{ id: `resume-${userMessage!.id}`, name: "doc_convert", arguments: resume.args }],
          } : await callWithBudget(plainMessages, { plain: true, ...(toolRounds < maxToolRounds ? { tools: toolSpecs } : {}) });
        } catch (error) {
          if (controller.signal.aborted) return this.finishInterrupted(conversationId);
          if (checkpoint) throw error;
          if (protocolErrorFeature(error) === "toolChoice") {
            result = await callWithBudget(plainMessages, { plain: true, tools: toolSpecs });
          } else if (protocolErrorFeature(error) === "tools") {
            const notice = this.db.appendMessage({ conversationId, role: "system", content: "当前渠道或模型不支持工具调用，本轮只能文字回答，不能生成文件。" });
            this.broadcast(conversationId, { type: "message", message: notice });
            const current = this.db.getConversation(conversationId);
            if (current?.brainChannelId === turnConversation.brainChannelId && current.brainModel === turnConversation.brainModel) {
              this.db.updateConversation(conversationId, { toolsUnsupported: true });
            }
            plainMessages = [...context, ...built.messages, { role: "system", content: "本轮工具不可用。只能回答文字，不能声称创建或修改了文件。" }];
            result = await callWithBudget(plainMessages, { plain: true });
          } else {
          if (!built.visionAttached || !isVisionError(error)) throw error;
          this.broadcast(conversationId, { type: "reset" });
          this.brain.degradeVision(turnConversation, error);
          const retry = await this.brain.buildBrainMessages({ ...turnConversation, visionEnabled: false }, turnAttachmentIds);
          plainMessages = [...context, ...retry.messages];
          result = await callWithBudget(plainMessages, { plain: true, tools: toolSpecs });
          }
        }
        if (turnConversation.toolScope === "conversation" && result.toolCalls.length) {
          result = { ...result, toolCalls: [], truncated: false, content: "当前会话的工具已关闭。需要使用工具时，可在对话设置中开启。" };
        }
        this.db.clearNativeTurnCheckpoint(conversationId);
        while (result.toolCalls.length && toolRounds < maxToolRounds) {
          if (controller.signal.aborted) return this.finishInterrupted(conversationId);
          if (result.truncated || result.toolCalls.length > 8 || result.toolCalls.some((call) => !call.id || !call.name) || new Set(result.toolCalls.map((call) => call.id)).size !== result.toolCalls.length) throw new Error("模型返回的工具调用不完整，请重试");
          toolRounds++;
          if (result.content.trim()) {
            const message = this.db.appendMessage({ conversationId, role: "assistant", content: result.content });
            this.broadcast(conversationId, { type: "message", message });
          }
          this.broadcast(conversationId, { type: "reset" });
          plainMessages = [...plainMessages, { role: "assistant", content: result.content || null, tool_calls: result.toolCalls.map((call) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments } })) }];
          // Group image calls independently of plan updates and file reads in the same response.
          const generateTool = nativeCreative && toolSpecs.includes(nativeImageSpecs.generate_image) ? registry.get("generate_image") : undefined;
          const imageCalls = generateTool ? result.toolCalls.filter(call => call.name === "generate_image") : [];
          const preparedImages = imageCalls.map(call => generateTool?.prepareConfirmation?.(call.arguments));
          const validImages = preparedImages.filter((item): item is PreparedToolConfirmation => !!item && !("error" in item));
          const firstImage = validImages[0];
          const images = validImages.flatMap((item, index) => Array.from({ length: Number(item.args.count ?? 1) }, () => ({
            callId: imageCalls[index]!.id,
            plan: { tool: "generate_image" as const, args: { ...item.args, count: 1 } as Record<string, unknown> },
          })));
          const modes = new Set(images.map(image => image.plan.args.consistency)
            .filter((value): value is "character" | "style" => value === "character" || value === "style"));
          const badImage = preparedImages.find(item => item && "error" in item);
          const imageError = badImage && "error" in badImage ? badImage.error
            : images.length > 8 ? "一批最多生成 8 张图片，请把数量调整到 8 张以内。"
            : modes.size > 1 ? "一批图片只能使用一种一致性方式。"
            : firstImage && validImages.some(item => item.target.channelId !== firstImage.target.channelId || item.target.model !== firstImage.target.model)
              ? "同一批图片请使用同一个生图渠道和模型。" : undefined;
          const groupedImages = firstImage && !imageError && validImages.length === imageCalls.length ? images : [];
          const batchHasImageGeneration = nativeCreative
            && result.toolCalls.some(call => call.name === "generate_image" || call.name === "edit_image");
          let imageContext: BrainContentPart[] | undefined;
          for (const call of result.toolCalls) {
            if (controller.signal.aborted) return this.finishInterrupted(conversationId);
            if (groupedImages.length && call.name === "generate_image") continue;
            if (groupedImages.length && (call.name === "doc_convert" || call.name === "doc_edit")) {
              plainMessages.push({ role: "tool", tool_call_id: call.id, content: "未执行：等待本批图片。取得素材后再调用，使用实际生成的图片编号。" });
              continue;
            }
            const registered = registry.get(call.name);
            const tool = registered && (toolSpecs.includes(registered.spec) || resume && call.name === "doc_convert") ? registered : undefined;
            const toolName = tool?.displayName ?? "doc_read";
            let mediaError: string | undefined;
            if (tool?.prepareConfirmation && result.toolCalls.length === 1 && call.name !== "generate_image") {
              const prepared = tool.prepareConfirmation(call.arguments);
              if ("error" in prepared) mediaError = prepared.error;
              else {
                const state: NativeMediaConfirmation = {
                  callId: call.id,
                  target: prepared.target,
                  checkpoint: { version: 3, channelId: turnConversation.brainChannelId, channelVersion, model: turnConversation.brainModel,
                    toolSignature, activeTools: toolSpecs.map((spec) => spec.function.name),
                    messages: plainMessages, toolRounds, brainCalls, elapsedMs: Date.now() - turnStartedAt,
                    usedTokens, usageMissing, previousCalls: [...previousCalls.entries()] },
                };
                const confirmation = this.db.appendNativeMediaConfirmation({
                  conversationId, role: "assistant", toolName, toolArgs: prepared.args,
                  plan: { tool: toolName, args: prepared.args }, confirm: prepared.preview, status: "pending",
                }, state);
                // A single edit with an unambiguous base image is a normal direct
                // instruction under the default policy; only multiple outputs need
                // a batch confirmation. Ambiguous targets already failed preparation
                // above and are left for the model to clarify.
                if (call.name === "edit_image" && !checkpoint && turnConversation.imageConfirmPolicy !== "always") {
                  if (!this.db.claimAgentConfirmation(confirmation, "approve", prepared.args)) throw new Error("图片提交状态已变化");
                  await this.approve(conversationId, confirmation.id, toolName, prepared.args, controller, state);
                  return;
                }
                this.broadcast(conversationId, { type: "message", message: confirmation });
                this.broadcast(conversationId, { type: "confirm", messageId: confirmation.id, preview: prepared.preview });
                this.setStatus(conversationId, "awaiting_confirmation");
                this.broadcast(conversationId, { type: "done", status: "awaiting_confirmation" });
                return;
              }
            }
            // Keep only small, non-content arguments in the visible call record.
            let visibleArgs: Record<string, unknown> = {};
            try {
              const input: unknown = JSON.parse(call.arguments);
              if (input && typeof input === "object" && !Array.isArray(input)) {
                const values = input as Record<string, unknown>;
                for (const key of ["fileId", "to", "coverAssetId", "kind", "name", "offset", "limit"]) {
                  const value = values[key];
                  if (typeof value === "string") visibleArgs[key] = value.slice(0, 200);
                  else if (typeof value === "number" && Number.isFinite(value)) visibleArgs[key] = value;
                }
                if (call.name === "plan_update" && Array.isArray(values.steps)) visibleArgs.steps = values.steps.length;
              }
            } catch { /* Invalid arguments are reported by the tool. */ }
            const pending = this.db.startNativeToolCall(conversationId, toolName, visibleArgs, call.id, call.name, createHash("sha256").update(call.arguments).digest("hex"));
            this.broadcast(conversationId, { type: "message", message: pending });
            const key = `${call.name}\n${call.arguments}`;
            let validationError = call.name === "generate_image" ? imageError ?? mediaError : mediaError;
            if ((call.name === "doc_convert" || call.name === "doc_edit") && batchHasImageGeneration) {
              validationError = "请先取得素材后再调用 PPT 转换或修改，使用生成结果中的图片编号。";
            }
            if (call.name === "doc_convert" && docConvertFailed) {
              validationError = "本次 PPT 转换已经失败，不能自行创建骨架或换源重试；请向用户说明失败原因，等待新的指令。";
            }
            if (call.name === "view_images" && tool) {
              if (!toolSpecs.includes(nativeImageViewSpec) || imageContext || nativeVisionReads >= MAX_VISION_READS_PER_ROUND) {
                validationError = "本轮无法继续查看图片。请缩小图片范围或重新发送请求。";
              } else {
                nativeVisionReads++;
              }
            }
            const cached = tool?.deduplicate ? previousCalls.get(key) : undefined;
            const outcome: ChatToolResult = validationError ? { ok: false, summary: validationError } : cached ?? (tool ? await registry.execute(call.name, call.arguments, { operationId: pending.id, conversationId, signal: controller.signal, report: (progress) => {
              if (controller.signal.aborted) return;
              const usageText = usageMissing ? "用量不完整" : `${usedTokens.toLocaleString()} tokens`;
              this.db.updateMessage(pending.id, { content: `${progress} · 模型调用 ${brainCalls}/${maxBrainCalls} · ${usageText}` });
              const updated = this.db.getMessage(pending.id);
              if (updated) this.broadcast(conversationId, { type: "message", message: updated });
            } }) : { ok: false, summary: `未知工具：${call.name}` });
            if (outcome.imageContext) imageContext = outcome.imageContext;
            if (call.name === "doc_convert" && !batchHasImageGeneration && !outcome.ok && !outcome.paused) {
              const recoverable = /^(?:参数不合法|参数必须是有效 JSON)/.test(outcome.summary);
              if (recoverable && docConvertValidationRetries < 1) docConvertValidationRetries += 1;
              else docConvertFailed = true;
            }
            if (call.name === "doc_create" || call.name === "doc_edit" || call.name === "doc_convert") {
              lastFileMutationFailure = outcome.ok && !outcome.paused ? "" : outcome.paused ? "" : `${call.name}：${outcome.summary}`;
            }
            // capability_search 的结果：把查到的工具加进下一轮的工具定义。
            const activate = outcome.data?.activate;
            if (Array.isArray(activate)) {
              let changed = false;
              for (const name of activate) {
                if (typeof name !== "string" || toolSpecs.some((spec) => spec.function.name === name)) continue;
                const candidate = registry.get(name);
                if (!candidate) continue;
                toolSpecs = [...toolSpecs, candidate.spec];
                changed = true;
              }
              if (changed) toolSignature = this.toolSignatureOf(toolSpecs);
            }
            if (tool?.deduplicate && outcome.ok) previousCalls.set(key, outcome);
            const display = outcome.ok && tool?.hideResult ? "读取完成。" : outcome.summary;
            const file = outcome.data;
            const fileData = file && typeof file.fileId === "string" && typeof file.fileName === "string" && typeof file.byteSize === "number" ? { workspaceFileId: file.fileId, workspaceFileName: file.fileName, byteSize: file.byteSize, pendingDelete: file.pendingDelete === true } : undefined;
            const publicData = outcome.uiData || fileData || outcome.paused ? { ...outcome.uiData, ...fileData, ...(outcome.paused ? { presentationPaused: true } : {}) } : undefined;
            const toolResult: ToolResult = { ok: outcome.ok, summary: display, ...(publicData ? { data: publicData } : {}) };
            const row = this.db.finishNativeToolCall(conversationId, pending.id, toolName, toolResult);
            const updated = this.db.getMessage(pending.id);
            if (updated) this.broadcast(conversationId, { type: "message", message: updated });
            this.broadcast(conversationId, { type: "message", message: row });
            if (call.name === "doc_convert" && outcome.uiData?.presentation && fileData) this.presentationChecks.kick();
            if (outcome.paused || resume) {
              this.setStatus(conversationId, "idle");
              this.broadcast(conversationId, { type: "done", status: "idle" });
              return;
            }
            plainMessages.push({ role: "tool", tool_call_id: call.id, content: `${outcome.ok ? "成功" : "失败"}：${outcome.summary}${typeof outcome.data?.fileId === "string" ? `\n文件ID：${outcome.data.fileId}` : ""}${typeof outcome.data?.sha256 === "string" ? `\n此新文件版本的 SHA-256：${outcome.data.sha256}` : ""}` });
            if (lastFileMutationFailure) plainMessages.push({ role: "system", content: `上一次文件操作失败（${lastFileMutationFailure}），文件没有被修改。禁止声称该操作已经完成；请如实说明失败原因并等待用户指令。` });
          }
          if (groupedImages.length && firstImage) {
            const calls = groupedImages.map(image => image.plan), first = calls[0]!;
            const consistency = [...modes][0];
            const isBatch = calls.length > 1;
            const preview = isBatch ? {
              ...firstImage.preview, count: calls.length, ...(consistency ? { consistency } : {}),
              message: `将提交 ${calls.length} 张图片。${consistency ? "先生成基准图，再按同一参考生成其余图片。" : "确认后整批提交。"}`,
            } : firstImage.preview;
            const state: NativeMediaConfirmation = {
              callId: groupedImages[0]!.callId, ...(isBatch ? { callIds: groupedImages.map(image => image.callId) } : {}),
              target: firstImage.target, ...(imageContext ? { imageContext } : {}),
              checkpoint: {
                version: 3, channelId: turnConversation.brainChannelId, channelVersion, model: turnConversation.brainModel,
                toolSignature, activeTools: toolSpecs.map(spec => spec.function.name), messages: compactNativeToolReads(plainMessages),
                toolRounds, brainCalls, elapsedMs: Date.now() - turnStartedAt, usedTokens, usageMissing, previousCalls: [...previousCalls.entries()],
              },
            };
            const confirmation = this.db.appendNativeMediaConfirmation({
              conversationId, role: "assistant", content: "",
              ...(!isBatch ? { toolName: first.tool, toolArgs: first.args } : {}),
              plan: { ...first, ...(isBatch ? { calls, ...(consistency ? { consistency } : {}) } : {}) },
              confirm: preview, status: "pending",
            }, state);
            if (!isBatch && userMessage && !checkpoint && turnConversation.imageConfirmPolicy !== "always" && requestsDirectSingleImage(userMessage.content ?? "")) {
              if (!this.db.claimAgentConfirmation(confirmation, "approve", first.args)) throw new Error("图片提交状态已变化");
              await this.approve(conversationId, confirmation.id, first.tool, first.args, controller, state);
              return;
            }
            this.broadcast(conversationId, { type: "message", message: confirmation });
            this.broadcast(conversationId, { type: "confirm", messageId: confirmation.id, preview });
            this.setStatus(conversationId, "awaiting_confirmation");
            this.broadcast(conversationId, { type: "done", status: "awaiting_confirmation" });
            return;
          }
          if (imageContext) plainMessages.push({ role: "user", content: imageContext });
          plainMessages = compactNativeToolReads(plainMessages);
          const snapshot: NativeTurnCheckpoint = { version: 3, channelId: turnConversation.brainChannelId, channelVersion, model: turnConversation.brainModel, toolSignature, activeTools: toolSpecs.map((spec) => spec.function.name), messages: plainMessages, toolRounds, brainCalls, elapsedMs: Date.now() - turnStartedAt, usedTokens, usageMissing, previousCalls: [...previousCalls.entries()] };
          const checkpointSaved = this.db.saveNativeTurnCheckpoint(conversationId, JSON.stringify(snapshot));
          if (!checkpointSaved && !checkpointNoticeSent) {
            checkpointNoticeSent = true;
            const notice = this.db.appendMessage({ conversationId, role: "system", content: "当前上下文过大，无法保存自动续跑断点；如程序退出，请检查已完成的操作后继续。" });
            this.broadcast(conversationId, { type: "message", message: notice });
          }
          const options = { plain: true, ...(toolRounds < maxToolRounds ? { tools: toolSpecs } : {}) };
          try {
            result = await callWithBudget(plainMessages, options);
          } catch (error) {
            if (!imageContext || !isVisionError(error) || controller.signal.aborted) throw error;
            this.broadcast(conversationId, { type: "reset" });
            this.brain.degradeVision(turnConversation, error);
            plainMessages = plainMessages.map(message => message.role === "user" && Array.isArray(message.content)
              ? { ...message, content: message.content.filter(part => part.type === "text") } : message);
            plainMessages.push({ role: "system", content: "渠道拒绝图片输入，图片未传给模型。不得声称看到内容。请按明确的图片 ID 操作或向用户确认。" });
            result = await callWithBudget(plainMessages, options);
          }
          this.db.clearNativeTurnCheckpoint(conversationId);
        }
        if (result.toolCalls.length) throw new Error("工具调用次数已达上限，请缩小任务范围后重试");
        if (controller.signal.aborted) return this.finishInterrupted(conversationId);
        let content = result.content;
        let continuationNotice = "";
        const maxContinuations = turnConversation.chatAutoContinueLimit ?? 20;
        let continuations = 0;
        while (result.truncated && content.trim() && continuations < maxContinuations) {
          continuations += 1;
          let streamed = "";
          try {
            result = await callWithBudget([
              ...plainMessages,
              { role: "assistant", content },
              { role: "user", content: "请从刚才截断的位置直接继续，不要重复已有内容，不要解释或添加开场白。" },
            ], { plain: true, onContent: (text) => { streamed += text; } });
            content += result.content;
            if (!result.content.trim()) {
              continuationNotice = "自动续写没有返回正文，已保留之前的内容；可以发送消息要求继续。";
              break;
            }
          } catch (error) {
            content += streamed;
            continuationNotice = controller.signal.aborted
              ? "已停止自动续写，已生成的内容已保留。"
              : "自动续写未完成，已保留生成的内容；可以发送消息要求继续。";
            break;
          }
        }
        if (!continuationNotice && result.truncated) continuationNotice = content.trim()
          ? "回答达到输出上限，已保留现有内容；可以发送消息要求继续，或增加自动续写次数。"
          : "模型达到输出上限但没有返回正文，可能将额度用于思考；请重试或更换模型。";
        let mutationNotice = "";
        if (lastFileMutationFailure) {
          const honest = /(?:失败|未完成|没有|无法|未修改|保持原样|错误)/.test(content);
          if (!honest) {
            try {
              const corrected = await callWithBudget([
                ...plainMessages,
                { role: "assistant", content },
                { role: "system", content: `事实核查：本轮最后一次文件操作失败（${lastFileMutationFailure}），文件没有被修改。不要声称已经完成。请只说明实际失败原因和当前文件状态，等待用户指令。` },
              ], { plain: true });
              if (corrected.content.trim()) content = corrected.content;
            } catch { /* Keep the original answer; the notice below still states the truth. */ }
          }
          if (!/(?:失败|未完成|没有|无法|未修改|保持原样|错误)/.test(content)) {
            mutationNotice = `本轮文件操作没有成功：${lastFileMutationFailure.slice(0, 500)}。文件没有被修改。`;
          }
        }
        const hasContent = Boolean(content.trim());
        const message = this.db.appendMessage({ conversationId, role: "assistant", content: hasContent ? content : "（模型没有返回内容，请再试一次。）", status: hasContent ? "ok" : "error" });
        this.broadcast(conversationId, { type: "message", message });
        if (continuationNotice) {
          const notice = this.db.appendMessage({ conversationId, role: "system", content: continuationNotice });
          this.broadcast(conversationId, { type: "message", message: notice });
        }
        if (mutationNotice) {
          const notice = this.db.appendMessage({ conversationId, role: "system", status: "error", content: mutationNotice });
          this.broadcast(conversationId, { type: "message", message: notice });
        }
        this.setStatus(conversationId, "idle");
        this.broadcast(conversationId, { type: "done", status: "idle" });
        return;
      }
      await this.runLoop(conversationId, trigger, controller, 0, turnAttachmentIds);
    } catch (error) {
      if (controller.signal.aborted) return this.finishInterrupted(conversationId);
      // §15 直通模式。只在「这一轮什么也没发生」时才降级：如果大脑已经跑了几轮、
      // 图也画了，那问题就不在「大脑连不上」，再兜一次只会让上下文更乱。
      if (!plain && userMessage && isBrainDown(error) && !controller.signal.aborted
        && this.nothingHappenedSince(conversationId, userMessage.seq)) {
        this.offerPassthrough(conversationId, userMessage, error);
        return;
      }
      throw error;
    }
  }

  /**
   * 工具已经执行完、只是大脑接不上话时的收尾。
   *
   * 这条路的重点是**别把已经花掉的钱说成失败**：图已经生成、结果已经落库，
   * 这时候再甩一个红色报错，用户会以为没出图而重新生成一遍。
   */
  private finishAfterBrainLoss(conversationId: string, note: string) {
    const message = this.db.appendMessage({ conversationId, role: "system", content: note });
    this.broadcast(conversationId, { type: "message", message });
    this.setStatus(conversationId, "idle");
    this.broadcast(conversationId, { type: "done", status: "idle" });
  }

  private stopOnUnknownSubmission(conversationId: string, outcomes: ToolOutcome[]): boolean {
    if (!outcomes.some(outcome => outcome.result.error === "SUBMISSION_UNKNOWN")) return false;
    this.finishAfterBrainLoss(conversationId, "生成提交状态待核对。请在渠道确认原请求的结果后再决定是否重新生成。");
    return true;
  }

  /** 这一轮除了 `seq` 那条用户消息之外，还有没有落过别的消息（工具卡片、气泡、系统提示都算） */
  private nothingHappenedSince(conversationId: string, seq: number): boolean {
    return !this.db.listMessages(conversationId).some((message) => message.seq > seq && message.role !== "user");
  }

  /**
   * 大脑不可用时的退化出口（§15）。
   *
   * 计划里写的是「直接按原话生成」，落地时改成**先问一句**：这个工作区的提示词是
   * 给大脑看的（「把这张的手改一下」），原话当 prompt 拿去生成，轻则画出一张无关的图，
   * 重则白花一笔钱——而 §16 的全部精神就是不让任何东西替用户决定花钱。
   * 所以能力保留，决定权交回用户：卡片上就是他的原话，点一下才生成。
   */
  private offerPassthrough(conversationId: string, userMessage: ChatMessage, error: unknown) {
    const raw = (userMessage.content ?? "").trim();
    const aliases = buildCapabilityAliases(this.db.listChannels());
    const resolution = resolveAlias(aliases, undefined, "image", this.defaultAliases().image);
    const channel = resolution ? this.db.getChannel(resolution.channelId) : null;

    // 原话直接当 prompt：太长多半是整段需求而不是一句描述，截断总比把请求撑爆好
    const prompt = raw.length > 1000 ? raw.slice(0, 1000) : raw;

    const preview: ConfirmPreview = {
      reason: "brain_down",
      prompt,
      model: resolution?.model ?? "（还没有配置图片渠道）",
      channelName: channel?.name ?? "",
      message: `大脑用不了了（${describeBrainFailure(error)}）。要不要先按你这句话直接生成一张图？`,
    };

    const message = this.db.appendMessage({
      conversationId, role: "assistant", status: "pending",
      content: "我没有理解这句话的能力了，但生成还能用。确认的话，我就拿这句话当提示词画一张。",
      toolName: "generate_image", toolArgs: { prompt }, confirm: preview,
    });
    this.broadcast(conversationId, { type: "message", message });
    this.setStatus(conversationId, "awaiting_confirmation");
    this.broadcast(conversationId, { type: "done", status: "awaiting_confirmation" });
  }

  /** 用户点了「确认生成」：直接执行存下来的参数，不让大脑重新规划一遍（§13.5） */
  private async approve(
    conversationId: string,
    messageId: string,
    tool: AgentToolName,
    args: Record<string, unknown>,
    controller: AbortController,
    nativeMedia: NativeMediaConfirmation | null = null,
  ) {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation) return;
    this.setStatus(conversationId, "running");
    const outcome = await this.executeTool(nativeMedia ? { ...conversation, verbatimPrompt: false } : conversation, { tool, args }, controller, {
      existingMessageId: messageId,
      confirmed: true,
      strictSubmission: Boolean(nativeMedia),
      backgroundMedia: Boolean(nativeMedia),
    });
    if (nativeMedia && controller.signal.aborted) {
      this.db.clearNativeMediaConfirmation(messageId);
      this.finishInterrupted(conversationId);
      if (outcome.terminal) this.settleFinishedTasks(conversationId);
      return;
    }
    if (this.stopOnUnknownSubmission(conversationId, [outcome])) return;
    if (nativeMedia && !outcome.terminal) {
      this.db.clearNativeMediaConfirmation(messageId);
      const current = this.db.getConversation(conversationId);
      if (!current || !usesNativeCreativeTools(current)) {
        this.setStatus(conversationId, "idle");
        this.broadcast(conversationId, { type: "done", status: "idle" });
        return;
      }
      if (!this.db.saveNativeTurnCheckpoint(conversationId, this.nativeMediaCheckpoint(nativeMedia, outcome.result))) {
        return this.finishAfterBrainLoss(conversationId, "生成结果已保存，当前对话过长，请发送新消息继续。");
      }
      try {
        await this.turn(conversationId, null, "recovered", controller, [], this.db.getConversation(conversationId) ?? conversation);
      } catch {
        this.db.clearNativeTurnCheckpoint(conversationId);
        this.finishAfterBrainLoss(conversationId, "生成工具结果已保存，可以继续发送消息。");
      }
      return;
    }
    if (outcome.terminal) {
      this.setStatus(conversationId, "waiting_task");
      this.broadcast(conversationId, { type: "done", status: "waiting_task" });
      return;
    }
    if (usesPlainChat(this.db.getConversation(conversationId))) {
      this.setStatus(conversationId, "idle");
      this.broadcast(conversationId, { type: "done", status: "idle" });
      return;
    }
    try {
      await this.runLoop(conversationId, "confirmation", controller, 1);
    } catch (error) {
      if (!isBrainDown(error) || controller.signal.aborted) throw error;
      this.finishAfterBrainLoss(conversationId, "生成已经提交并完成，但助手暂时接不上话（对话渠道不可用）。");
    }
  }

  /**
   * 用户确认了一整批（§16 + 需求.md 问题 2b）。
   *
   * 和 `approve` 的差别只有一处：那张确认卡上记的是 N 个调用，不是「工具 + 参数」。
   * `existingMessageId` 同样传下去——卡片所在的那行就地变成这轮的表头气泡，
   * 而不是在它下面再冒一个内容一模一样的新气泡。展开出来的 N 对行
   * （表头 + N 条工具行）由 `executeParallel` 按批量的写法补齐。
   */
  private async approveBatch(
    conversationId: string,
    messageId: string,
    calls: PlannedCall[],
    controller: AbortController,
    consistency?: "character" | "style",
    nativeMedia: NativeMediaConfirmation | null = null,
  ) {
    const conversation = this.db.getConversation(conversationId);
    if (!conversation) return;
    this.setStatus(conversationId, "running");
    // `say` 不给：表头行就是那张卡片，它上面的话一个字都不用重写
    const outcome = await this.batch.executeBatch(nativeMedia ? { ...conversation, verbatimPrompt: false } : conversation, {
      calls,
      ...(consistency ? { consistency } : {}),
    }, controller, {
      existingMessageId: messageId,
      confirmed: true,
    });
    if (this.stopOnUnknownSubmission(conversationId, outcome.results)) return;
    // 原生生图批量是同步等结果的；把每个原始 tool_call_id 的结果接回断点，
    // 让模型能接着说话，而不是像旧批量那样停在「图出来了但助手不吭声」。
    if (nativeMedia && !outcome.terminal && outcome.results.length === calls.length) {
      this.db.clearNativeMediaConfirmation(messageId);
      const current = this.db.getConversation(conversationId);
      if (!current || !usesNativeCreativeTools(current)) {
        this.setStatus(conversationId, "idle");
        this.broadcast(conversationId, { type: "done", status: "idle" });
        return;
      }
      if (!this.db.saveNativeTurnCheckpoint(conversationId, this.nativeBatchCheckpoint(nativeMedia, outcome.results))) {
        return this.finishAfterBrainLoss(conversationId, "图片已生成，当前对话过长，请发送新消息继续。");
      }
      try {
        await this.turn(conversationId, null, "recovered", controller, [], current);
      } catch {
        this.db.clearNativeTurnCheckpoint(conversationId);
        this.finishAfterBrainLoss(conversationId, "图片已生成，可以继续发送消息。");
      }
      return;
    }
    if (outcome.terminal) {
      this.setStatus(conversationId, "waiting_task");
      this.broadcast(conversationId, { type: "done", status: "waiting_task" });
      return;
    }
    if (usesPlainChat(this.db.getConversation(conversationId))) {
      this.setStatus(conversationId, "idle");
      this.broadcast(conversationId, { type: "done", status: "idle" });
      return;
    }
    try {
      await this.runLoop(conversationId, "confirmation", controller, 1);
    } catch (error) {
      if (!isBrainDown(error) || controller.signal.aborted) throw error;
      this.finishAfterBrainLoss(conversationId, "生成已经提交并完成，但助手暂时接不上话（对话渠道不可用）。");
    }
  }

  /**
   * 补上「任务比消息先结束」那个时间窗。
   *
   * 提交即失败是最常见的例子（渠道没配 key、上游直接拒、参数不合法）：
   * `runner.create()` 把任务排进微任务，`run()` 立刻失败并发出 `finished` 事件，
   * 而那时工具消息还没落库——`handleTaskEvent` 按 taskId 找不到人接手，事情就彻底丢了：
   * 消息停在 pending、会话卡在 waiting_task，用户等不到任何回音（实测就是这样）。
   *
   * 所以要在**状态已经设成 waiting_task 之后**再自查一次（`handleTaskEvent` 开头那道
   * 状态门就是这么要求的），让它照常跑一遍收口。和 `TaskRunner.waitFor` 里那句
   * 「订阅之前任务可能已经结束，必须再查一次」是同一个道理。
   */
  /**
   * 启动时收拾上一进程留下的「进行中」会话尸体。
   *
   * 只收拾 `running`：`waiting_task` 要留着——那条视频可能还在上游跑，`runner.resume()`
   * 会接着轮询；`awaiting_confirmation` 也留着，那是在等用户点头。
   */
  recoverStaleConversations(): number {
    this.db.workflows.recoverInterrupted();
    this.db.executions.recoverInterrupted();
    const resumable = this.db.recoverableNativeTurnIds();
    const recoveredTasks = this.db.listUnlinkedAgentTasks();
    for (const task of recoveredTasks) {
      const operation = this.db.getMessage(task.agentOperationId!);
      if (!operation?.toolName) continue;
      const summary = "已找回此前提交的生成任务，正在核对结果。";
      const toolResult: ToolResult = { ok: true, async: true, summary, taskId: task.id, data: { agentOperationId: operation.id } };
      if (operation.role === "tool") {
        this.db.updateMessage(operation.id, { status: "pending", content: summary, taskId: task.id, toolResult });
      } else {
        this.db.appendMessage({ conversationId: operation.conversationId, role: "tool", toolName: operation.toolName,
          status: "pending", content: summary, taskId: task.id, toolResult });
      }
    }
    this.db.interruptUnstartedAgentConfirmations();
    const conversations = this.db.listConversations();
    for (const conversation of conversations) {
      if (conversation.status !== "running") continue;
      const waitingOnNativeTask = this.db.listPendingMessages(conversation.id).some(message => {
        const operationId = message.toolResult?.data?.agentOperationId;
        if (!message.taskId || message.toolResult?.async !== true || typeof operationId !== "string") return false;
        const operation = this.db.getMessage(operationId);
        return operation && this.db.getNativeMediaConfirmation(operation.id)
          && !this.db.hasUserMessageAfter(conversation.id, operation.seq);
      });
      if (waitingOnNativeTask) this.db.setConversationStatus(conversation.id, "waiting_task", { touch: false });
    }
    const count = this.db.resetConversationsStuckInRunning();
    for (const recovered of recoveredTasks) {
      const task = this.db.getTaskView(recovered.id);
      if (task && isTerminalStatus(task.status)) handleTaskEvent(this.taskEventHost(), { kind: "finished", task });
    }
    for (const conversation of conversations) this.settleFinishedTasks(conversation.id);
    for (const conversationId of resumable) this.startTurn(conversationId, null, "recovered");
    return count;
  }

  private settleFinishedTasks(conversationId: string) {
    for (const message of this.db.listPendingMessages(conversationId)) {
      if (!message.taskId || message.toolResult?.async !== true) continue;
      const task = this.db.getTaskView(message.taskId);
      if (task && isTerminalStatus(task.status)) handleTaskEvent(this.taskEventHost(), { kind: "finished", task });
    }
  }

  /**
   * 断点签名只覆盖真正会改变执行语义的工具。
   * capability_search 只是目录查询，加不加它不应该让旧断点失效。
   */
  private toolSignatureOf(specs: ChatTool["spec"][]): string {
    return createHash("sha256").update(JSON.stringify(
      [...specs].filter((spec) => spec.function.name !== "capability_search")
        .sort((a, b) => a.function.name.localeCompare(b.function.name)),
    )).digest("hex");
  }

  private nativeBatchCheckpoint(state: NativeMediaConfirmation, results: ToolOutcome[]): string {
    const callIds = state.callIds ?? [state.callId];
    const toolMessages = [...new Set(callIds)].map(id => {
      const batch = results.filter((_, index) => callIds[index] === id).map(item => item.result);
      const assetIds = batch.flatMap(result => result.assetIds ?? (result.assetId ? [result.assetId] : []));
      return { role: "tool" as const, tool_call_id: id,
        content: JSON.stringify({ ok: batch.every(result => result.ok), summary: batch.map(result => result.summary).join("\n"), assetIds,
          ...(assetIds.length ? { hint: "如需判断画面是否符合要求，请先调用 view_images 查看这些图片，再描述效果。" } : {}) }) };
    });
    return JSON.stringify({ ...state.checkpoint, messages: [...state.checkpoint.messages, ...toolMessages,
      ...(state.imageContext ? [{ role: "user", content: state.imageContext }] : [])] });
  }

  private nativeMediaCheckpoint(state: NativeMediaConfirmation, result: ToolResult, generatedImage?: BrainContentPart[]): string {
    const ids = result.assetIds ?? (result.assetId ? [result.assetId] : []);
    const checkpoint = {
      ...state.checkpoint, messages: [...state.checkpoint.messages, {
        role: "tool" as const, tool_call_id: state.callId,
        content: JSON.stringify({ ok: result.ok, summary: result.summary, assetIds: ids,
          ...(ids.length ? { hint: "如需判断画面是否符合要求，请先调用 view_images 查看这些图片，再描述效果。" } : {}) }),
      }, ...(state.imageContext ? [{ role: "user", content: state.imageContext }] : []),
      ...(generatedImage?.length ? [{ role: "user" as const, content: generatedImage }] : [])],
    };
    return JSON.stringify(checkpoint);
  }

  /** Feed one generated image back to a vision-capable brain so it can judge its own edit. */
  private async generatedImageContext(result: ToolResult): Promise<BrainContentPart[] | undefined> {
    const id = result.assetId ?? result.assetIds?.[0];
    if (!id) return undefined;
    const asset = this.db.getAsset(id);
    if (!asset || !isImageAsset(asset)) return undefined;
    const view = await assetVisionParts(this.db, asset, assetRef(asset.id), 6);
    if (!view.loaded) return undefined;
    return [
      { type: "text", text: `这是本轮生成/修改的图片 ${assetRef(asset.id)}。请以实际画面为准判断效果，不要凭空描述。${view.animated ? "它是动图，下面附了按时间抽取的帧。" : ""}` },
      ...view.parts,
    ];
  }

  private async finishNativeTask(conversation: Conversation, pending: ChatMessage, operation: ChatMessage, result: ToolResult, state: NativeMediaConfirmation): Promise<void> {
    const ownsWait = conversation.status === "waiting_task" && !this.isRunning(conversation.id)
      && !this.db.hasUserMessageAfter(conversation.id, operation.seq);
    const brainChannel = this.db.getChannel(conversation.brainChannelId);
    const { checkpoint } = state;
    const shouldResume = ownsWait && result.ok && usesNativeCreativeTools(conversation)
      && conversation.brainChannelId === checkpoint.channelId && conversation.brainModel === checkpoint.model
      && brainChannel?.updatedAt === checkpoint.channelVersion;
    const generatedImage = shouldResume && conversation.visionEnabled && !isVisionBlocked(this.db, conversation)
      ? await this.generatedImageContext(result).catch(() => undefined) : undefined;
    const stillOwnsWait = ownsWait && !this.isRunning(conversation.id) && !this.db.hasUserMessageAfter(conversation.id, operation.seq);
    const resume = this.db.completeNativeMediaTask(conversation.id, pending.id, operation.id, result,
      stillOwnsWait, shouldResume && stillOwnsWait ? this.nativeMediaCheckpoint(state, result, generatedImage) : null);
    const updated = this.db.getMessage(pending.id);
    if (updated) this.broadcast(conversation.id, { type: "message", message: updated });
    if (resume) {
      this.startTurn(conversation.id, null, "recovered");
      return;
    }
    if (stillOwnsWait) this.broadcast(conversation.id, { type: "done", status: "idle" });
  }

  private async runLoop(
    conversationId: string,
    trigger: TurnTrigger,
    controller: AbortController,
    startRound: number,
    turnAttachmentIds: string[] = [],
  ) {
    // 画布线程允许单独调大：多镜头「先建节点再逐镜生成」很容易超过 10 轮
    const opening = this.db.getConversation(conversationId);
    const maxRounds = opening?.kind === "board" ? opening.boardMaxRounds ?? MAX_ROUNDS : MAX_ROUNDS;
    for (let round = startRound; round < maxRounds; round += 1) {
      if (controller.signal.aborted) return this.finishInterrupted(conversationId);
      const conversation = this.db.getConversation(conversationId);
      if (!conversation) return;

      const turnConversation = conversation.kind === "chat" ? { ...conversation, chatMode: "creative" as const } : conversation;
      const outcome = await this.runOneRound(turnConversation, trigger, round, controller, turnAttachmentIds);
      if (outcome === "stop") return;
    }

    // 轮次用尽：大脑在循环里转圈，收尾说一句实话而不是让它一直烧钱
    const note = this.db.appendMessage({
      conversationId, role: "system", status: "error",
      content: `这一轮已经尝试了 ${maxRounds} 次，我先停下来了。可以换个说法再试，或者直接说明你想要的结果。`,
    });
    this.broadcast(conversationId, { type: "message", message: note });
    this.setStatus(conversationId, "idle");
    this.broadcast(conversationId, { type: "done", status: "idle" });
  }

  /** 返回 "stop" 表示这一轮结束（正常收尾 / 等任务 / 等确认），"continue" 表示继续下一轮 */
  private async runOneRound(
    conversation: Conversation,
    trigger: TurnTrigger,
    round: number,
    controller: AbortController,
    turnAttachmentIds: string[],
  ): Promise<"continue" | "stop"> {
    const built = await this.brain.buildBrainMessages(conversation, turnAttachmentIds);
    return this.runRoundWithMessages(conversation, trigger, round, controller, built, turnAttachmentIds, 0);
  }

  /**
   * 一轮里的「问大脑 → 解析 → 执行」。
   *
   * 单独拆出来是为了支持 `view_images`：大脑要求看图时，把缩略图作为一条临时
   * user 消息接在 `built.messages` 后面，再问一次——**不落库、不占轮次**。
   * 否则要么看不到图，要么得把「看过哪些图」永久写进上下文，每轮都重复付费。
   */
  private async runRoundWithMessages(
    conversation: Conversation,
    trigger: TurnTrigger,
    round: number,
    controller: AbortController,
    built: BuiltContext,
    turnAttachmentIds: string[],
    visionReads: number,
  ): Promise<"continue" | "stop"> {
    const conversationId = conversation.id;
    let result = await this.brain.callBrainWithRecovery(conversation, built, controller);

    /**
     * 身份被上游提示词盖住时纠正一次（见 `looksLikeIdentityDrift`）。
     *
     * 只在这一轮的原话里真的出现跑偏信号时才多花一次调用；纠正失败就把原文
     * 交给下面的解析/兜底，不再反复重试——中转站不听话时来回重试只是烧钱。
     */
    if (looksLikeIdentityDrift(result.content)) {
      this.broadcast(conversationId, { type: "reset" });
      try {
        result = await this.brain.callBrainRaw(conversation, [
          ...built.messages,
          { role: "assistant", content: result.content.slice(0, 2000) },
          { role: "user", content: IDENTITY_CORRECTION },
        ], controller, conversationId, { silent: true });
      } catch (error) {
        // 用户叫停时照常抛出；别的错误保留第一次的内容，让用户至少看到发生了什么
        if (controller.signal.aborted) throw error;
      }
    }

    let plan = parsePlan(result.content);
    for (let attempt = 0; !plan && attempt < MAX_PARSE_RETRY; attempt += 1) {
      // §15：模型偶尔会夹带解释文字或代码块，纠正一次而不是直接报错
      const corrected: BrainMessage[] = [
        ...built.messages,
        { role: "assistant", content: result.content.slice(0, 2000) },
        {
          role: "user",
          content: '你上面的输出不是合法 JSON。请只输出一个 JSON 对象，形如 {"tool": "工具名", "args": {...}, "say": "一句话"}，不要输出任何其他文字、不要用代码块包裹。',
        },
      ];
      this.broadcast(conversationId, { type: "reset" });
      result = await this.brain.callBrainRaw(conversation, corrected, controller, conversationId, { silent: true });
      plan = parsePlan(result.content) ?? salvagePlan(result.content) ?? repairPlan(result.content);
    }

    if (!plan) {
      // 实在解析不出来：把模型原话当成回答显示，用户至少看得到发生了什么
      const fallback = result.content.trim();
      const exhausted = result.truncated
        || (result.usage != null
          && result.usage.completionTokens > 0
          && result.usage.reasoningTokens >= result.usage.completionTokens);
      const emptyText = exhausted
        ? "（模型这次只输出了思考过程，正文被长度上限截断；已自动加长额度重试过一次。可以再发一次，或到模型设置换一个非推理模型。）"
        : "（大脑没有返回内容，请再发一次。）";
      const message = this.db.appendMessage({
        conversationId, role: "assistant", content: fallback || emptyText,
        status: fallback ? "ok" : "error",
        errorMessage: fallback ? null : (exhausted ? "大脑把输出额度用在了思考上" : "大脑返回了空内容"),
      });
      this.broadcast(conversationId, { type: "message", message });
      this.setStatus(conversationId, "idle");
      this.broadcast(conversationId, { type: "done", status: "idle" });
      return "stop";
    }

    /**
     * 大脑要求看画布。
     *
     * 这是「按指令选图」的关键：没有附带图时，它不该凭猜测默认主图，
     * 而是先看一眼。看图不生成、不花钱，但每看一次要多一趟大脑请求，
     * 所以有次数上限；超了就停下让用户重说，而不是无限循环。
     */
    if (plan.tool === "board_view_images" && conversation.kind === "board") {
      if (visionReads >= MAX_VISION_READS_PER_ROUND) {
        const note = this.db.appendMessage({ conversationId, role: "system", status: "error", content: "本轮看图次数已达上限，请缩小检查范围后继续。" });
        this.broadcast(conversationId, { type: "message", message: note });
        this.setStatus(conversationId, "idle"); this.broadcast(conversationId, { type: "done", status: "idle" }); return "stop";
      }
      const board = conversation.boardId ? this.db.getBoardRecord(conversation.boardId) : null;
      const parsed = TOOL_SCHEMAS.board_view_images.safeParse(plan.args);
      const refs = parsed.success ? [...new Set(parsed.data.nodeRefs)].slice(0, MAX_VISION_IMAGES) : [];
      const parts: BrainContentPart[] = [];
      const seen: string[] = []; const missed: string[] = [];
      if (!parsed.success || !board || !conversation.visionEnabled || isVisionBlocked(this.db, conversation)) {
        parts.push({ type: "text", text: "[画布看图失败] 参数无效、当前画布不存在或模型视觉不可用。没有看过任何图片，不能声称看过。" });
      } else {
        let remaining = MAX_VISION_IMAGES;
        for (const ref of refs) {
          if (remaining <= 0) { missed.push(`${ref}（附图已达上限）`); continue; }
          const node = board.doc.nodes.find((item) => item.ref === ref);
          const asset = node?.type === "image" && node.assetId ? this.db.getAsset(node.assetId) : null;
          const view = asset
            ? await assetVisionParts(this.db, asset, `画布图片 ${ref}「${node?.title ?? ""}」`, Math.max(1, Math.min(remaining, refs.length === 1 ? 6 : 2)))
            : null;
          if (!view?.loaded) { missed.push(ref); continue; }
          parts.push(...view.parts);
          remaining -= view.parts.filter((part) => part.type === "image_url").length;
          seen.push(ref);
        }
        if (parsed.success) {
          const taskIds = new Set(this.db.listBoardTasksByBoard(board.id).map((item) => item.taskId));
          for (const id of [...new Set(parsed.data.assetIds)]) {
            if (remaining <= 0) { missed.push(`素材 ${id}（附图已达上限）`); continue; }
            const asset = this.db.getAsset(id);
            const task = asset && this.db.getTaskRow(asset.taskId);
            const isPublic = task?.libraryScope === "public" || (task?.libraryScope === "legacy" && this.db.listLibraryTaskViews().some((item) => item.id === task.id));
            const permitted = asset && (isPublic || taskIds.has(asset.taskId) || this.db.findBoardAssetRefs(id).some((item) => item.boardId === board.id));
            const view = permitted && asset?.mimeType.startsWith("image/")
              ? await assetVisionParts(this.db, asset, `素材 ${id}（生成历史或公共素材）`, Math.max(1, Math.min(remaining, 4)))
              : null;
            if (!view?.loaded) { missed.push(`素材 ${id}`); continue; }
            parts.push(...view.parts);
            remaining -= view.parts.filter((part) => part.type === "image_url").length;
            seen.push(`素材 ${id}`);
          }
        }
        parts.unshift({ type: "text", text: `[画布看图] 实际附图：${seen.join("、") || "无"}；未能读取：${missed.join("、") || "无"}。只评价实际附图，未读取或未选中的图片不能声称看过。` });
      }
      this.broadcast(conversationId, { type: "reset" });
      return this.runRoundWithMessages(conversation, trigger, round, controller, { messages: [...built.messages, { role: "assistant", content: JSON.stringify({ tool: plan.tool, args: plan.args }) }, { role: "user", content: parts }], visionAttached: built.visionAttached || seen.length > 0 }, turnAttachmentIds, visionReads + 1);
    }

    if (plan.tool === "view_images") {
      if (visionReads >= MAX_VISION_READS_PER_ROUND) {
        const note = this.db.appendMessage({
          conversationId, role: "system", status: "error",
          content: `这一轮已经看了 ${MAX_VISION_READS_PER_ROUND} 次图，我先停下来了。可以直接说要改哪一张（例如「画布第 2 张」），或把图拖进输入框再发一次。`,
        });
        this.broadcast(conversationId, { type: "message", message: note });
        this.setStatus(conversationId, "idle");
        this.broadcast(conversationId, { type: "done", status: "idle" });
        return "stop";
      }
      const observed = await this.observeImages(conversation, plan, built, controller);
      // 刚才那串 view_images 的原始 JSON 不能留在输入框/流式气泡里
      this.broadcast(conversationId, { type: "reset" });
      return this.runRoundWithMessages(
        conversation, trigger, round, controller, observed, turnAttachmentIds, visionReads + 1,
      );
    }

    // 纯文本工具：落库就是模型的原话，不需要执行任何东西
    if (plan.tool === "reply" || plan.tool === "ask") {
      let text = extractPlanText(plan, result.content);

      /**
       * 空 reply 的自救。
       *
       * 模型只输出 `{"tool":"reply","args":{}}` 时，以前会原样落一条空消息——
       * 用户看到的就是「第一句话被吞了」。这里先纠正一次；纠正后仍然是空，
       * 就留一句系统提示，绝不落空气泡。
       */
      if (!text) {
        this.broadcast(conversationId, { type: "reset" });
        try {
          const retried = await this.brain.callBrainRaw(conversation, [
            ...built.messages,
            { role: "assistant", content: result.content.slice(0, 2000) },
            { role: "user", content: EMPTY_REPLY_CORRECTION },
          ], controller, conversationId, { silent: true });
          const retriedPlan = parsePlan(retried.content) ?? salvagePlan(retried.content) ?? repairPlan(retried.content);
          if (retriedPlan) {
            plan = retriedPlan;
            result = retried;
            text = extractPlanText(retriedPlan, retried.content);
          }
        } catch (error) {
          if (controller.signal.aborted) throw error;
        }
      }

      if (!text) {
        const note = this.db.appendMessage({
          conversationId, role: "system", status: "error",
          content: "助手这次没有返回正文（模型给了个空的回复），请再说一次。",
        });
        this.broadcast(conversationId, { type: "message", message: note });
        this.setStatus(conversationId, "idle");
        this.broadcast(conversationId, { type: "done", status: "idle" });
        return "stop";
      }

      // 把正文写回 plan：下一轮回放时，模型能看到自己上一条到底说了什么
      const normalizedPlan: AgentPlan = plan.tool === "ask"
        ? { ...plan, args: { ...plan.args, question: text } }
        : { ...plan, args: { ...plan.args, text } };
      const message = this.db.appendMessage({ conversationId, role: "assistant", content: text, plan: normalizedPlan });
      this.broadcast(conversationId, { type: "message", message });
      this.setStatus(conversationId, "idle");
      this.broadcast(conversationId, { type: "done", status: "idle" });
      return "stop";
    }

    // §13 / §16：确认闸门。链条上的视频、以及超额度的任何生成都先问一句。
    // 闸门看的是 `resolveBatch` 之后**真正要跑的那几个**——卡片上问 N 张、
    // 实际提交 M 张是这里最不能出的错
    const resolvedBatch = resolveBatch(planCalls(plan));
    // 把「这一轮附带的图」固化成显式 imageRefs / mode：
    // 确认卡审批、跨轮续跑时附件集合已经没了，参数里必须已经写清楚用哪几张
    const prepared = resolvedBatch.calls.map((call) => this.materializeCall(conversation, call, turnAttachmentIds));
    const calls = prepared.map((item) => item.call);
    // 只跑了第一个 / 超上限被截断：在这里说，只此一处。放在执行器里说会漏掉
    // 「额度超了、这一批要用户先确认」那条路——那条路上执行器根本还没跑
    this.batch.announceNote(conversationId, resolvedBatch.note);
    const isContinuation = trigger !== "user" || round > 0;
    const generating = calls.filter((call) => GENERATION_TOOLS.includes(call.tool));
    // 批量只有额度这一道闸门：里面全是产图工具，`shouldConfirm` 对它们恒为 false
    const overTaskLimit = generating.length > 0 && conversation.taskCount + generating.length > MAX_SESSION_TASKS;
    const videoSelection = calls.length === 1 && calls[0]!.tool === "generate_video"
      ? this.resolveVideoForCall(conversation, calls[0]!.args, turnAttachmentIds)
      : null;
    // 生图/改图也可能因为「画布多于一张又没选图」注定失败。那种情况同样先别摆确认卡：
    // 让工具把选图要求回灌给大脑，比让用户点一次「确认生成」再看到失败要好。
    const canvasCount = this.db.canvasImages(conversation).length;
    const imageSelectionMissing = canvasCount > 1 && turnAttachmentIds.length === 0
      && prepared.some(({ call }) => {
        if (call.tool !== "edit_image" && call.tool !== "generate_image") return false;
        if (call.tool === "generate_image" && call.args.fromScratch === true) return false;
        const refs = call.args.imageRefs;
        return !Array.isArray(refs) || refs.length === 0;
      });
    // 无限画布的删除类操作要确认；不删有内容节点时直接执行
    const boardOpsPreview = conversation.kind === "board" && conversation.boardId
      && calls.length === 1 && calls[0]!.tool === "board_apply"
      ? (() => {
        const parsed = boardApplySchema.safeParse(calls[0]!.args);
        if (!parsed.success) return null;
        try {
          return previewBoardOps(this.db, conversation.boardId!, parsed.data.ops);
        } catch {
          return null;
        }
      })()
      : null;
    const board = conversation.kind === "board" && conversation.boardId ? this.db.getBoardRecord(conversation.boardId) : null;
    const boardGeneration = board && calls.length === 1 && calls[0]!.tool === "board_generate" ? (() => {
      const args = boardGenerateSchema.safeParse(calls[0]!.args); if (!args.success) return null;
      const check = inspectBoardGeneration(this.db, board, buildCapabilityAliases(this.db.listChannels()), this.defaultAliases(), [args.data.nodeRef], args.data.overrides)[0];
      if (!check || check.errors.length || check.kind === "text") return null;
      const node = board.doc.nodes.find((item) => item.ref === args.data.nodeRef);
      const count = node?.type === "config" && node.mode === "image" ? (args.data.overrides?.count ?? node.count) : 1;
      calls[0]!.args = { ...calls[0]!.args, expectedBoardVersion: board.version };
      return { message: `将在节点 ${check.ref} 提交 1 个${check.kind === "video" ? "视频" : check.kind === "audio" ? "音频" : "图片"}生成任务${count > 1 ? `，请求 ${count} 张结果` : ""}；模型：${check.model}。${check.warnings.length ? `注意：${check.warnings.join("；")}。` : ""}实际费用由渠道决定。`, summary: `${check.ref} · 1 个任务` };
    })() : null;
    const batchGeneration = board && calls.length === 1 && calls[0]!.tool === "board_generate_batch" ? (() => {
      const args = TOOL_SCHEMAS.board_generate_batch.safeParse(calls[0]!.args); if (!args.success) return null;
      const checks = inspectBoardGeneration(this.db, board, buildCapabilityAliases(this.db.listChannels()), this.defaultAliases(), args.data.nodeRefs);
      if (checks.some((check) => check.errors.length || check.kind === "text")) return null;
      calls[0]!.args = { ...calls[0]!.args, expectedBoardVersion: board.version };
      const lines = checks.map((check) => { const node = board.doc.nodes.find((item) => item.ref === check.ref); const count = node?.type === "config" && node.mode === "image" ? node.count : 1; return `${check.ref}（${check.kind}，${check.model}${count > 1 ? `，请求 ${count} 张` : ""}）${check.warnings.length ? `：${check.warnings.join("、")}` : ""}`; }).join("；");
      return { message: `将提交 ${checks.length} 个生成任务：${lines}。实际费用由渠道决定，已生成节点可能被覆盖。`, summary: `${checks.length} 个节点 · ${checks.length} 个任务` };
    })() : null;
    const projectUpdate = board && calls.length === 1 && calls[0]!.tool === "board_storyboard_update" ? (() => {
      const input = TOOL_SCHEMAS.board_storyboard_update.safeParse(calls[0]!.args); if (!input.success) return null;
      const node = board.doc.nodes.find((item) => item.ref === input.data.nodeRef);
      const project = node?.storyboard && this.db.getStoryboardProject(node.storyboard.projectId);
      if (!node?.storyboard || !project || project.revision !== input.data.revision) return null;
      const index = project.data.shots.findIndex((shot) => shot.id === node.storyboard!.shotId);
      if (index < 0) return null;
      calls[0]!.args = { ...calls[0]!.args, expectedBoardVersion: board.version };
      const fields = Object.entries(input.data.patch).map(([key, value]) => `${key}：${(typeof value === "object" ? JSON.stringify(value) : String(value)).slice(0, 160)}`).join("；");
      return { message: `将修改分镜项目「${project.data.name}」第 ${index + 1} 镜：${fields}。当前画布不会自动改变。`, summary: `第 ${index + 1} 镜 · 项目版本 ${project.revision}` };
    })() : null;
    if (board && boardOpsPreview?.needsConfirm && calls[0]) calls[0].args = { ...calls[0].args, expectedBoardVersion: board.version };
    // 选图本身就不成立时先别摆确认卡：卡片上写不出「用哪几张」，
    // 用户点了确认也只会得到一个失败。直接执行，让工具把原因回灌给大脑去 ask / 重选。
    const needsConfirm = Boolean(boardOpsPreview?.needsConfirm || boardGeneration || batchGeneration || projectUpdate) || (!videoSelection?.error && !imageSelectionMissing && (overTaskLimit
      || (calls.length === 1 && shouldConfirm(calls[0]!.tool, isContinuation, conversation.videoConfirmPolicy))));
    if (needsConfirm) {
      const preview: ConfirmPreview = boardOpsPreview?.needsConfirm
        ? {
          reason: "board_destructive",
          prompt: "",
          model: "",
          channelName: "",
          message: boardOpsPreview.message,
          boardDeleteNodes: boardOpsPreview.deleteNodes,
          boardDeleteWithAssets: boardOpsPreview.deleteWithAssets,
          boardSummary: boardOpsPreview.summary,
        }
        : boardGeneration || batchGeneration || projectUpdate ? {
          reason: boardGeneration || batchGeneration ? "board_generation" : "board_project_update",
          prompt: "", model: "", channelName: "",
          message: (boardGeneration ?? batchGeneration ?? projectUpdate)!.message, boardSummary: (boardGeneration ?? batchGeneration ?? projectUpdate)!.summary,
        }
        : buildConfirmPreview(
          this.db, conversation, calls, overTaskLimit ? "session_limit" : "video_policy",
          videoSelection?.selection, plan.consistency, this.defaultAliases(),
        );
      // 待确认的是**整批**，所以 toolName 留空、calls 存在 plan 里：
      // 写一个 toolName 上去只会让 UI 把它当成「只画一张」，确认后也只知道要跑那一个
      const pendingPlan: AgentPlan = {
        tool: calls[0]!.tool, args: calls[0]!.args,
        ...(plan.say ? { say: plan.say } : {}),
        ...(calls.length > 1 ? { calls } : {}),
        // 一致性要跟着确认卡片一起落库，否则用户点头之后批量就退化成普通并行了
        ...(calls.length > 1 && plan.consistency ? { consistency: plan.consistency } : {}),
      };
      const message = this.db.appendMessage({
        conversationId, role: "assistant", content: plan.say ?? "", plan: pendingPlan,
        ...(calls.length === 1 ? { toolName: calls[0]!.tool, toolArgs: calls[0]!.args } : {}),
        confirm: preview, status: "pending",
      });
      this.broadcast(conversationId, { type: "plan", messageId: message.id, plan: pendingPlan });
      this.broadcast(conversationId, { type: "message", message });
      this.broadcast(conversationId, { type: "confirm", messageId: message.id, preview });
      this.setStatus(conversationId, "awaiting_confirmation");
      this.broadcast(conversationId, { type: "done", status: "awaiting_confirmation" });
      return "stop";
    }

    const outcome = await this.batch.executeBatch(conversation, {
      calls,
      ...(plan.say ? { say: plan.say } : {}),
      ...(plan.consistency ? { consistency: plan.consistency } : {}),
    }, controller, {}, turnAttachmentIds);
    if (this.stopOnUnknownSubmission(conversationId, outcome.results)) return "stop";
    if (outcome.terminal) {
      // 视频这类异步任务：交给 TaskRunner 的完成事件续跑（§12.2）
      this.setStatus(conversationId, "waiting_task");
      this.broadcast(conversationId, { type: "done", status: "waiting_task" });
      return "stop";
    }
    return "continue";
  }

  /**
   * 执行 `view_images`：把大脑点名的（或整组画布）缩略图接在上下文后面。
   *
   * 只看图、不落库、不生成。返回一份新的 `BuiltContext`——调用方拿它再问一次大脑。
   */
  private async observeImages(
    conversation: Conversation,
    plan: AgentPlan,
    built: BuiltContext,
    _controller: AbortController,
  ): Promise<BuiltContext> {
    return observeImages({ db: this.db }, conversation, plan, built);
  }

  /**
   * 把这一轮附带的图 / 已解析好的视频模式固化进参数。
   *
   * 这一步必须在**确认卡落库之前**做：用户过一会儿才点确认，那时
   * 「本条消息附带的图」早就无从查起，只有参数里的 imageRefs 还能复现。
   */
  private materializeCall(
    conversation: Conversation,
    call: PlannedCall,
    turnAttachmentIds: string[],
  ): { call: PlannedCall; selection?: VideoSelection } {
    if (call.tool === "generate_video") {
      const resolved = this.resolveVideoForCall(conversation, call.args, turnAttachmentIds);
      if (!resolved.selection) return { call };
      const selection = resolved.selection;
      const args: Record<string, unknown> = { ...call.args };
      if (selection.mode !== "text-to-video") args.mode = selection.mode;
      if (selection.assets.length) args.imageRefs = selection.assets.map((asset) => asset.id);
      return { call: { tool: call.tool, args }, selection };
    }
    if ((call.tool === "edit_image" || call.tool === "generate_image") && turnAttachmentIds.length) {
      const hasRefs = Array.isArray(call.args.imageRefs) && call.args.imageRefs.length > 0;
      const fromScratch = call.tool === "generate_image" && call.args.fromScratch === true;
      if (!hasRefs && !fromScratch) {
        return { call: { tool: call.tool, args: { ...call.args, imageRefs: [...turnAttachmentIds] } } };
      }
    }
    return { call };
  }

  /** 解析视频渠道并算出这次到底用哪几张图。确认卡和执行器共用这一份结果 */
  private resolveVideoForCall(
    conversation: Conversation,
    args: Record<string, unknown>,
    turnAttachmentIds: string[],
  ): { selection?: VideoSelection; error?: string } {
    const aliases = buildCapabilityAliases(this.db.listChannels());
    const resolution = resolveAlias(aliases, asString(args.modelHint), "video", this.defaultAliases().video);
    if (!resolution) return { error: "还没有可用的视频渠道，请先到「渠道配置」添加" };
    const channel = this.db.getChannel(resolution.channelId);
    if (!channel) return { error: "解析到的视频渠道不存在" };
    return resolveVideoSelection(
      this.db, conversation, args as unknown as GenerateVideoArgs, channel.adapterType, turnAttachmentIds,
      resolution.model,
    );
  }

  /**
   * 用户在设置里挑的默认生图 / 生视频模型（需求.md 问题 5），存的是 alias。
   *
   * 只在**大脑没点名**时才起作用（见 `resolveAlias`），空串按「没设」处理。
   * 存 alias 的代价是渠道被停用后它会失效，但那是正常情况而不是错误——
   * `resolveAlias` 会如实退回并标记出来，不假装一切正常。
   */
  private defaultAliases(): { image?: string; video?: string; music?: string; speech?: string } {
    // 旧版三个音频共用一个默认值；新键没设时把它同时交给音乐和语音，
    // 工具自己会按适配器筛掉不匹配的那个（写歌只认 suno，朗读只认 tts）。
    const legacyAudio = this.db.getSetting("agentDefaultAudioAlias") ?? "";
    // 用 ?? 而不是 ||：用户把新键显式清成空串时，不该再把旧值捡回来
    const music = this.db.getSetting("agentDefaultMusicAlias") ?? legacyAudio;
    const speech = this.db.getSetting("agentDefaultSpeechAlias") ?? legacyAudio;
    return {
      ...(this.db.getSetting("agentDefaultImageAlias") ? { image: this.db.getSetting("agentDefaultImageAlias")! } : {}),
      ...(this.db.getSetting("agentDefaultVideoAlias") ? { video: this.db.getSetting("agentDefaultVideoAlias")! } : {}),
      ...(music ? { music } : {}),
      ...(speech ? { speech } : {}),
    };
  }

  /**
   * 执行这一轮的调用（需求.md 问题 2：需要多张图时并行，等一个总时长而不是 N 个）。
   *
   * 单调用就是 `calls.length === 1` 的那个特例，**原样走 `executeTool`**——
   * 确认批准、被动直通、绝大多数普通回合都是它，所以它必须和批量之前一模一样。
   * 只有真的多个调用时才走 `executeParallel`。
   *
   * 收进来的 `calls` 必须**已经过 `resolveBatch`**（`runOneRound` 和 `approveBatch`
   * 都是这么传的）。这里不再自己截断一遍：截断这件事只发生在一个地方，
   * 「卡片上问几个」和「实际提交几个」才不可能分家。
   */
  /**
   * 批量的公共开头：**一条**表头助手行 + **N 条** pending 工具行。
   *
   * 表头 `toolName` 特意留空：写上的话 `buildRows` 会把它和后面某一条工具行
   * 折成同一张卡，N 张就少一张。N 条工具行先一次写完，用户立刻看到 N 张卡一起转。
   */
  private toolContext(
    conversation: Conversation,
    controller: AbortController,
    options: { confirmed?: boolean },
    turnAttachmentIds: string[] = [],
  ): ToolContext {
    const conversationId = conversation.id;
    // 一轮之内可能是确认后再执行，那时候要用最新的那一份（画布、开关都可能刚被改过）
    const effective = options.confirmed ? conversation : this.db.getConversation(conversationId) ?? conversation;
    return {
      db: this.db,
      runner: this.runner,
      sessionKeys: this.sessionKeys,
      conversation: effective,
      aliases: buildCapabilityAliases(this.db.listChannels()),
      defaultAliases: this.defaultAliases(),
      // 开了「原话直发」就把用户那句话的原文带上；工具层会用它替换掉大脑写的 prompt
      verbatimPrompt: effective.verbatimPrompt ? this.db.lastUserText(conversationId) : null,
      turnAttachmentIds,
      emit: (event) => this.broadcast(conversationId, event),
      signal: controller.signal,
    };
  }

  /**
   * 执行一个工具并落库。
   *
   * `existingMessageId` 用于「确认后执行」：复用那张确认卡片所在的行，
   * 卡片就地变成结果卡片，而不是再冒出来一条。
   */
  private async executeTool(
    conversation: Conversation,
    plan: { tool: AgentToolName; args: Record<string, unknown>; say?: string },
    controller: AbortController,
    options: { existingMessageId?: string; confirmed?: boolean; strictSubmission?: boolean; backgroundMedia?: boolean },
    turnAttachmentIds: string[] = [],
  ): Promise<ToolOutcome> {
    const conversationId = conversation.id;
    let callMessage: ChatMessage;
    if (options.existingMessageId) {
      this.db.updateMessage(options.existingMessageId, { confirm: null, toolResult: null, status: "pending" });
      callMessage = this.db.getMessage(options.existingMessageId)!;
    } else {
      callMessage = this.db.appendMessage({
        conversationId, role: "assistant", content: plan.say ?? null,
        plan: { tool: plan.tool, args: plan.args, ...(plan.say ? { say: plan.say } : {}) },
        toolName: plan.tool, toolArgs: plan.args,
      });
      this.broadcast(conversationId, { type: "plan", messageId: callMessage.id, plan: callMessage.plan! });
    }
    this.broadcast(conversationId, { type: "message", message: callMessage });

    const ctx = this.toolContext(conversation, controller, options, turnAttachmentIds);
    const outcome = await this.batch.callToolSafely({ tool: plan.tool, args: plan.args }, {
      ...ctx, operationId: callMessage.id, strictSubmission: options.strictSubmission, backgroundMedia: options.backgroundMedia,
    });

    // 新产物不自动进画布：画布是用户这一轮明确挑的图，生成结果先去素材库。
    const toolMessage = this.db.appendMessage({
      conversationId, role: "tool", content: outcome.result.summary,
      toolName: plan.tool, toolResult: { ...outcome.result, data: { ...outcome.result.data, agentOperationId: callMessage.id } },
      taskId: outcome.result.taskId ?? null, assetId: outcome.result.assetId ?? null,
      // 异步任务先挂 pending，等完成事件再定稿（§12.2）
      status: outcome.terminal ? "pending" : outcome.result.ok ? "ok" : "error",
      errorMessage: outcome.result.ok ? null : outcome.result.summary,
    });
    this.broadcast(conversationId, { type: "message", message: toolMessage });
    if (outcome.result.taskId) {
      this.broadcast(conversationId, {
        type: "progress", taskId: outcome.result.taskId,
        status: outcome.terminal ? "queued" : "succeeded", progress: outcome.terminal ? 0 : 100,
      });
    }
    return outcome;
  }

  // ── 大脑调用 ───────────────────────────────────────────────────────────────

  // ── 收尾 ───────────────────────────────────────────────────────────────────

  private supersedePendingConfirmations(conversationId: string, nativeOnly = false) {
    for (const message of this.db.listPendingMessages(conversationId)) {
      if (!message.confirm) continue;
      const native = Boolean(this.db.getNativeMediaConfirmation(message.id));
      if (nativeOnly && !native) continue;
      if (native && !this.db.claimAgentConfirmation(message, "reject")) continue;
      this.db.updateMessage(message.id, { confirm: null, status: "error", errorMessage: "已被用户的新消息取代" });
      const updated = this.db.getMessage(message.id);
      if (updated) this.broadcast(conversationId, { type: "message", message: updated });
    }
  }

  private finishInterrupted(conversationId: string) {
    this.db.clearNativeTurnCheckpoint(conversationId);
    this.db.interruptNativeToolCalls(conversationId);
    const note = this.db.appendMessage({ conversationId, role: "system", content: "已中断本轮处理" });
    this.broadcast(conversationId, { type: "message", message: note });
    this.setStatus(conversationId, "idle");
    this.broadcast(conversationId, { type: "done", status: "idle" });
  }

  private setStatus(conversationId: string, status: Conversation["status"]) {
    this.db.setConversationStatus(conversationId, status, { touch: false });
    this.broadcast(conversationId, { type: "status", status });
  }

  private reportTurnFailure(conversationId: string, error: unknown) {
    this.db.clearNativeTurnCheckpoint(conversationId);
    this.db.interruptNativeToolCalls(conversationId);
    // 大脑这一侧的报错原样透传会把上游返回体（可能含 Base URL、请求片段）落进
    // SQLite 和界面，所以这类只留下翻译过的一句话，本地校验类错误才用原文
    const message = isBrainTimeout(error)
      ? "对话模型思考超时了。可以把剧本拆短一点 / 少要求一些细节，或者到模型设置换一个非推理模型再试。"
      : isBrainDown(error)
        ? `助手用不了了：${describeBrainFailure(error)}。检查一下「渠道配置」里的对话渠道。`
        : error instanceof AppError
          ? error.message
          : error instanceof Error ? error.message : "处理这一轮时出错了";
    const note = this.db.appendMessage({
      conversationId, role: "system", status: "error", content: message, errorMessage: message,
    });
    this.broadcast(conversationId, { type: "message", message: note });
    this.broadcast(conversationId, { type: "error", message });
    this.db.setConversationStatus(conversationId, "idle", { touch: false });
    this.broadcast(conversationId, { type: "done", status: "idle" });
  }
}

