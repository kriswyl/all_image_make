import { createHash } from "node:crypto";
import { usesNativeCreativeTools, type AgentStreamEvent, type ChatMessage, type Conversation, type ToolResult } from "../shared/agent-types.js";
import { isVisionError } from "./agent-brain-errors.js";
import type { BrainRunner } from "./agent-brain.js";
import type { AgentConfirmationService } from "./agent-confirmation.js";
import { MAX_VISION_READS_PER_ROUND } from "./agent-constants.js";
import { createNativeTurnBudget } from "./agent-native-budget.js";
import { createNativeToolRegistry } from "./agent-native-tools.js";
import type { ToolContext } from "./agent-tools.js";
import type { BrainContentPart, BrainMessage, BrainResult } from "./brain.js";
import { initialToolGroups } from "./chat-tools/capability-search.js";
import { parseNativeTurnCheckpoint, type NativeTurnCheckpoint } from "./chat-tools/checkpoint.js";
import { compactNativeToolReads } from "./chat-tools/context.js";
import { nativeImageSpecs, nativeImageViewSpec, requestsDirectSingleImage, type NativeMediaConfirmation } from "./chat-tools/native-image.js";
import type { ChatTool, ChatToolResult, PreparedToolConfirmation } from "./chat-tools/registry.js";
import type { AppDatabase } from "./db.js";
import type { PresentationCoordinator } from "./presentation-coordinator.js";
import { protocolErrorFeature, readToolProtocol } from "./tool-protocol.js";

interface NativeTurnHost {
  db: AppDatabase;
  brain: Pick<BrainRunner, "buildBrainMessages" | "callBrainRaw" | "degradeVision">;
  presentations: Pick<PresentationCoordinator, "registerDocumentTools" | "scheduleChecks">;
  confirmations: Pick<AgentConfirmationService, "approve">;
  defaultAliases(): { image?: string; video?: string };
  toolContext(conversation: Conversation, controller: AbortController): ToolContext;
  broadcast(conversationId: string, event: AgentStreamEvent): void;
  setStatus(conversationId: string, status: Conversation["status"]): void;
  finishInterrupted(conversationId: string): void;
}

interface NativeTurn {
  turnConversation: Conversation;
  text: string | null;
  userMessage: ChatMessage | null;
  controller: AbortController;
  turnAttachmentIds: string[];
  recovering: boolean;
}

/**
 * 断点签名只覆盖真正会改变执行语义的工具。
 * capability_search 只是目录查询，加不加它不应该让旧断点失效。
 */
function toolSignatureOf(specs: ChatTool["spec"][]): string {
  return createHash("sha256").update(JSON.stringify(
    [...specs].filter((spec) => spec.function.name !== "capability_search")
      .sort((a, b) => a.function.name.localeCompare(b.function.name)),
  )).digest("hex");
}

export async function runNativeTurn(
  host: NativeTurnHost,
  { turnConversation, text, userMessage, controller, turnAttachmentIds, recovering }: NativeTurn,
): Promise<void> {
  const { db, brain, presentations, confirmations, broadcast } = host;
  const conversationId = turnConversation.id;
  const built = await brain.buildBrainMessages(turnConversation, turnAttachmentIds);
  const checkpoint = recovering ? parseNativeTurnCheckpoint(db.getNativeTurnCheckpoint(conversationId)) : null;
  if (recovering && !checkpoint) throw new Error("任务断点不可用，请检查已完成的操作后重新发送请求。");
  const budget = createNativeTurnBudget(host, turnConversation, controller, checkpoint);
  const { call: callWithBudget } = budget;
  const resumeRequested = /^(?:请)?继续(?:\s*PPT|制作\s*PPT)[。！!\s]*$/i.test(text?.trim() ?? "");
  const resume = resumeRequested && turnConversation.toolScope !== "conversation" ? db.getPresentationResume(conversationId) : null;
  const nativeCreative = usesNativeCreativeTools(turnConversation);
  const recoveredUser = recovering
    ? db.listMessages(conversationId).filter(message => message.role === "user").at(-1)
    : undefined;
  const frameMessage = turnConversation.toolScope === "all" ? recoveredUser ?? userMessage : userMessage;
  const turnVideoFrames = frameMessage?.videoFrames;
  const registry = createNativeToolRegistry({
    db, presentations, defaultAliases: host.defaultAliases,
    toolContext: () => host.toolContext(turnConversation, controller),
  }, {
    conversationId, turnConversation, text, userMessage, recoveredUser, resume,
    signal: controller.signal, callWithBudget, nativeCreative, turnAttachmentIds, turnVideoFrames,
  });
  // 能力组：首轮按用户意图和会话状态预加载；恢复轮沿用断点里记录的组。
  const initialGroups = initialToolGroups({
    text: userMessage?.content ?? text ?? db.lastUserText(conversationId) ?? null,
    hasAttachments: turnAttachmentIds.length > 0,
    hasDocuments: db.listConversationDocuments(conversationId).length > 0
      || db.listWorkspaceDocuments(conversationId).length > 0,
    hasImages: db.canvasImages(turnConversation).length > 0
      || db.listConversationAssets(conversationId).some(entry => entry.asset.mimeType.startsWith("image/")),
  });
  // 旧断点没有 activeTools：当时还没有能力组，恢复成全量工具，保持原签名可继续。
  const restoredSpecs = checkpoint
    ? (checkpoint.activeTools
      ? checkpoint.activeTools.map(name => registry.get(name)?.spec).filter((spec): spec is ChatTool["spec"] => Boolean(spec))
      : registry.specs())
    : [];
  // 渠道明确报过「不支持 tools」之后，这次对话不再发工具定义，省掉每轮一次的失败调用
  const protocolChannel = db.getChannel(turnConversation.brainChannelId);
  const toolsRejected = protocolChannel && readToolProtocol(db, protocolChannel, turnConversation.brainModel).tools?.supported === false;
  let toolSpecs = turnConversation.toolsUnsupported || toolsRejected || turnConversation.toolScope === "conversation"
    ? []
    : checkpoint
      ? restoredSpecs
      : registry.specs(initialGroups);
  let toolSignature = toolSignatureOf(toolSpecs);
  // A 新增 presentation_spec_update：旧版本保存的断点不含它，签名按「排除新工具」兼容一次。
  // 该工具只记录要求、不改变已有操作的执行语义，因此允许带旧签名继续恢复。
  const legacyToolSignature = toolSignatureOf(toolSpecs.filter(spec => spec.function.name !== "presentation_spec_update"));
  const channelVersion = db.getChannel(turnConversation.brainChannelId)?.updatedAt ?? "";
  if (checkpoint && (checkpoint.channelId !== turnConversation.brainChannelId || !channelVersion || checkpoint.channelVersion !== channelVersion || checkpoint.model !== turnConversation.brainModel || (checkpoint.toolSignature !== toolSignature && checkpoint.toolSignature !== legacyToolSignature))) throw new Error("模型、渠道配置或可用工具已改变，无法安全自动恢复；请检查已完成的操作后继续。");
  const lastPlan = db.listMessages(conversationId).filter((message) => message.role === "tool" && message.toolName === "plan_update" && message.status === "ok").at(-1);
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
  const snapshot = (messages = plainMessages): NativeTurnCheckpoint => ({
    version: 3,
    channelId: turnConversation.brainChannelId,
    channelVersion,
    model: turnConversation.brainModel,
    toolSignature,
    activeTools: toolSpecs.map((spec) => spec.function.name),
    messages,
    toolRounds,
    brainCalls: budget.brainCalls,
    elapsedMs: budget.elapsedMs,
    usedTokens: budget.usedTokens,
    usageMissing: budget.usageMissing,
    previousCalls: [...previousCalls.entries()],
  });
  if (checkpoint) {
    const note = db.appendMessage({ conversationId, role: "system", content: "已从上次完成的工具步骤继续；未完成的操作不会自动重放。" });
    broadcast(conversationId, { type: "message", message: note });
  }
  let result: BrainResult;
  try {
    result = resume ? {
      content: "", reasoning: "", finishReason: "tool_calls", usage: null, durationMs: 0, usedFallback: false, truncated: false,
      toolCalls: [{ id: `resume-${userMessage!.id}`, name: "doc_convert", arguments: resume.args }],
    } : await callWithBudget(plainMessages, { plain: true, ...(toolRounds < maxToolRounds ? { tools: toolSpecs } : {}) });
  } catch (error) {
    if (controller.signal.aborted) return host.finishInterrupted(conversationId);
    if (checkpoint) throw error;
    if (protocolErrorFeature(error) === "toolChoice") {
      result = await callWithBudget(plainMessages, { plain: true, tools: toolSpecs });
    } else if (protocolErrorFeature(error) === "tools") {
      const notice = db.appendMessage({ conversationId, role: "system", content: "当前渠道或模型不支持工具调用，本轮只能文字回答，不能生成文件。" });
      broadcast(conversationId, { type: "message", message: notice });
      const current = db.getConversation(conversationId);
      if (current?.brainChannelId === turnConversation.brainChannelId && current.brainModel === turnConversation.brainModel) {
        db.updateConversation(conversationId, { toolsUnsupported: true });
      }
      plainMessages = [...context, ...built.messages, { role: "system", content: "本轮工具不可用。只能回答文字，不能声称创建或修改了文件。" }];
      result = await callWithBudget(plainMessages, { plain: true });
    } else {
      if (!built.visionAttached || !isVisionError(error)) throw error;
      broadcast(conversationId, { type: "reset" });
      brain.degradeVision(turnConversation, error);
      const retry = await brain.buildBrainMessages({ ...turnConversation, visionEnabled: false }, turnAttachmentIds);
      plainMessages = [...context, ...retry.messages];
      result = await callWithBudget(plainMessages, { plain: true, tools: toolSpecs });
    }
  }
  if (turnConversation.toolScope === "conversation" && result.toolCalls.length) {
    result = { ...result, toolCalls: [], truncated: false, content: "当前会话的工具已关闭。需要使用工具时，可在对话设置中开启。" };
  }
  db.clearNativeTurnCheckpoint(conversationId);
  while (result.toolCalls.length && toolRounds < maxToolRounds) {
    if (controller.signal.aborted) return host.finishInterrupted(conversationId);
    if (result.truncated || result.toolCalls.length > 8 || result.toolCalls.some((call) => !call.id || !call.name) || new Set(result.toolCalls.map((call) => call.id)).size !== result.toolCalls.length) throw new Error("模型返回的工具调用不完整，请重试");
    toolRounds++;
    if (result.content.trim()) {
      const message = db.appendMessage({ conversationId, role: "assistant", content: result.content });
      broadcast(conversationId, { type: "message", message });
    }
    broadcast(conversationId, { type: "reset" });
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
      if (controller.signal.aborted) return host.finishInterrupted(conversationId);
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
            checkpoint: snapshot(),
          };
          const confirmation = db.appendNativeMediaConfirmation({
            conversationId, role: "assistant", toolName, toolArgs: prepared.args,
            plan: { tool: toolName, args: prepared.args }, confirm: prepared.preview, status: "pending",
          }, state);
          // A single edit with an unambiguous base image is a normal direct
          // instruction under the default policy; only multiple outputs need
          // a batch confirmation. Ambiguous targets already failed preparation
          // above and are left for the model to clarify.
          if (call.name === "edit_image" && !checkpoint && turnConversation.imageConfirmPolicy !== "always") {
            if (!db.claimAgentConfirmation(confirmation, "approve", prepared.args)) throw new Error("图片提交状态已变化");
            await confirmations.approve(conversationId, confirmation.id, toolName, prepared.args, controller, state);
            return;
          }
          broadcast(conversationId, { type: "message", message: confirmation });
          broadcast(conversationId, { type: "confirm", messageId: confirmation.id, preview: prepared.preview });
          host.setStatus(conversationId, "awaiting_confirmation");
          broadcast(conversationId, { type: "done", status: "awaiting_confirmation" });
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
      const pending = db.startNativeToolCall(conversationId, toolName, visibleArgs, call.id, call.name, createHash("sha256").update(call.arguments).digest("hex"));
      broadcast(conversationId, { type: "message", message: pending });
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
        const usageText = budget.usageMissing ? "用量不完整" : `${budget.usedTokens.toLocaleString()} tokens`;
        db.updateMessage(pending.id, { content: `${progress} · 模型调用 ${budget.brainCalls}/${budget.maxBrainCalls} · ${usageText}` });
        const updated = db.getMessage(pending.id);
        if (updated) broadcast(conversationId, { type: "message", message: updated });
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
        if (changed) toolSignature = toolSignatureOf(toolSpecs);
      }
      if (tool?.deduplicate && outcome.ok) previousCalls.set(key, outcome);
      const display = outcome.ok && tool?.hideResult ? "读取完成。" : outcome.summary;
      const file = outcome.data;
      const fileData = file && typeof file.fileId === "string" && typeof file.fileName === "string" && typeof file.byteSize === "number" ? { workspaceFileId: file.fileId, workspaceFileName: file.fileName, byteSize: file.byteSize, pendingDelete: file.pendingDelete === true } : undefined;
      const publicData = outcome.uiData || fileData || outcome.paused ? { ...outcome.uiData, ...fileData, ...(outcome.paused ? { presentationPaused: true } : {}) } : undefined;
      const toolResult: ToolResult = { ok: outcome.ok, summary: display, ...(publicData ? { data: publicData } : {}) };
      const row = db.finishNativeToolCall(conversationId, pending.id, toolName, toolResult);
      const updated = db.getMessage(pending.id);
      if (updated) broadcast(conversationId, { type: "message", message: updated });
      broadcast(conversationId, { type: "message", message: row });
      if (call.name === "doc_convert" && outcome.uiData?.presentation && fileData) presentations.scheduleChecks();
      if (outcome.paused || resume) {
        host.setStatus(conversationId, "idle");
        broadcast(conversationId, { type: "done", status: "idle" });
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
        checkpoint: snapshot(compactNativeToolReads(plainMessages)),
      };
      const confirmation = db.appendNativeMediaConfirmation({
        conversationId, role: "assistant", content: "",
        ...(!isBatch ? { toolName: first.tool, toolArgs: first.args } : {}),
        plan: { ...first, ...(isBatch ? { calls, ...(consistency ? { consistency } : {}) } : {}) },
        confirm: preview, status: "pending",
      }, state);
      if (!isBatch && userMessage && !checkpoint && turnConversation.imageConfirmPolicy !== "always" && requestsDirectSingleImage(userMessage.content ?? "")) {
        if (!db.claimAgentConfirmation(confirmation, "approve", first.args)) throw new Error("图片提交状态已变化");
        await confirmations.approve(conversationId, confirmation.id, first.tool, first.args, controller, state);
        return;
      }
      broadcast(conversationId, { type: "message", message: confirmation });
      broadcast(conversationId, { type: "confirm", messageId: confirmation.id, preview });
      host.setStatus(conversationId, "awaiting_confirmation");
      broadcast(conversationId, { type: "done", status: "awaiting_confirmation" });
      return;
    }
    if (imageContext) plainMessages.push({ role: "user", content: imageContext });
    plainMessages = compactNativeToolReads(plainMessages);
    const checkpointSaved = db.saveNativeTurnCheckpoint(conversationId, JSON.stringify(snapshot()));
    if (!checkpointSaved && !checkpointNoticeSent) {
      checkpointNoticeSent = true;
      const notice = db.appendMessage({ conversationId, role: "system", content: "当前上下文过大，无法保存自动续跑断点；如程序退出，请检查已完成的操作后继续。" });
      broadcast(conversationId, { type: "message", message: notice });
    }
    const options = { plain: true, ...(toolRounds < maxToolRounds ? { tools: toolSpecs } : {}) };
    try {
      result = await callWithBudget(plainMessages, options);
    } catch (error) {
      if (!imageContext || !isVisionError(error) || controller.signal.aborted) throw error;
      broadcast(conversationId, { type: "reset" });
      brain.degradeVision(turnConversation, error);
      plainMessages = plainMessages.map(message => message.role === "user" && Array.isArray(message.content)
        ? { ...message, content: message.content.filter(part => part.type === "text") } : message);
      plainMessages.push({ role: "system", content: "渠道拒绝图片输入，图片未传给模型。不得声称看到内容。请按明确的图片 ID 操作或向用户确认。" });
      result = await callWithBudget(plainMessages, options);
    }
    db.clearNativeTurnCheckpoint(conversationId);
  }
  if (result.toolCalls.length) throw new Error("工具调用次数已达上限，请缩小任务范围后重试");
  if (controller.signal.aborted) return host.finishInterrupted(conversationId);
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
  const message = db.appendMessage({ conversationId, role: "assistant", content: hasContent ? content : "（模型没有返回内容，请再试一次。）", status: hasContent ? "ok" : "error" });
  broadcast(conversationId, { type: "message", message });
  if (continuationNotice) {
    const notice = db.appendMessage({ conversationId, role: "system", content: continuationNotice });
    broadcast(conversationId, { type: "message", message: notice });
  }
  if (mutationNotice) {
    const notice = db.appendMessage({ conversationId, role: "system", status: "error", content: mutationNotice });
    broadcast(conversationId, { type: "message", message: notice });
  }
  host.setStatus(conversationId, "idle");
  broadcast(conversationId, { type: "done", status: "idle" });
}
