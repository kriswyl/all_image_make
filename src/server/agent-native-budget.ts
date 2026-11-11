import type { AgentStreamEvent, Conversation } from "../shared/agent-types.js";
import { isVisionError } from "./agent-brain-errors.js";
import type { BrainRunner } from "./agent-brain.js";
import { isVisionBlocked } from "./agent-vision.js";
import type { BrainMessage, BrainResult } from "./brain.js";
import type { NativeTurnCheckpoint } from "./chat-tools/checkpoint.js";
import type { AppDatabase } from "./db.js";
import { PresentationPaused } from "./presentation-execution.js";

interface NativeBudgetHost {
  db: AppDatabase;
  brain: Pick<BrainRunner, "callBrainRaw" | "degradeVision">;
  broadcast(conversationId: string, event: AgentStreamEvent): void;
}

export function createNativeTurnBudget(
  { db, brain, broadcast }: NativeBudgetHost,
  turnConversation: Conversation,
  controller: AbortController,
  checkpoint: NativeTurnCheckpoint | null,
) {
  const conversationId = turnConversation.id;
  const turnStartedAt = Date.now() - (checkpoint?.elapsedMs ?? 0);
  let brainCalls = checkpoint?.brainCalls ?? 0;
  let usedTokens = checkpoint?.usedTokens ?? 0;
  let usageMissing = checkpoint?.usageMissing ?? false;
  const maxTokens = turnConversation.chatTokenLimit ?? 0;
  const maxBrainCalls = turnConversation.chatModelCallLimit ?? 500;
  const maxTurnMinutes = turnConversation.chatTurnMinutes ?? 30;
  let toolProtocolRetried = false;
  const callWithBudget = async (messages: BrainMessage[], options: Parameters<BrainRunner["callBrainRaw"]>[4], presentation = false, onDispatch?: () => void): Promise<BrainResult> => {
    const stop = (message: string): never => { throw presentation ? new PresentationPaused(message) : new Error(message); };
    if (brainCalls >= maxBrainCalls) stop(`本轮模型调用已达 ${maxBrainCalls} 次上限`);
    if (Date.now() - turnStartedAt > maxTurnMinutes * 60_000) stop(`本轮处理已超过 ${maxTurnMinutes} 分钟`);
    if (maxTokens && usageMissing) stop("渠道未提供完整 token 用量，无法执行本轮用量上限");
    if (maxTokens && usedTokens >= maxTokens) stop(`本轮已用 ${usedTokens} tokens，达到 ${maxTokens} 的上限`);
    // A resumed turn can include images collected before the user changed the setting.
    if (options?.plain && (!turnConversation.visionEnabled || isVisionBlocked(db, turnConversation))
      && messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url"))) {
      messages = [...messages.map((message): BrainMessage => message.role !== "tool" && Array.isArray(message.content)
        ? { ...message, content: message.content.filter(part => part.type !== "image_url") }
        : message), { role: "system", content: "本次请求没有传入图片，不能声称看到了画面。" }];
    }
    brainCalls++;
    onDispatch?.();
    let result: BrainResult;
    try {
      result = await brain.callBrainRaw(turnConversation, messages, controller, conversationId, options);
    } catch (error) {
      // A resumed image task may carry a generated-image attachment. If this
      // brain rejects images, degrade once and retry the same turn without them.
      const hasImage = messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === "image_url"));
      if (!hasImage || controller.signal.aborted || !isVisionError(error)) throw error;
      broadcast(conversationId, { type: "reset" });
      brain.degradeVision(turnConversation, error);
      const withoutImages = messages.map((message): BrainMessage => Array.isArray(message.content)
        ? { ...message, content: message.content.filter(part => part.type !== "image_url") } as BrainMessage
        : message);
      return callWithBudget([...withoutImages, { role: "system", content: "渠道拒绝了图片输入，图片没有传给模型。不得声称看到了画面内容；需要判断时请用户描述或换支持视觉的模型。" }], options, presentation, onDispatch);
    }
    const usage = result.usage;
    if (usage?.complete && usage.promptTokens + usage.completionTokens > 0) usedTokens += usage.promptTokens + usage.completionTokens;
    else usageMissing = true;
    if (options?.plain && result.invalidToolText) {
      broadcast(conversationId, { type: "reset" });
      if (toolProtocolRetried) throw new Error("渠道返回了无法验证的工具调用。请重试或切换对话模型。");
      toolProtocolRetried = true;
      return callWithBudget([...messages, { role: "system", content: "上一响应的工具调用格式无效。请使用 API 的原生工具调用字段，并完整提供参数。" }], options);
    }
    return result;
  };

  return {
    call: callWithBudget,
    maxBrainCalls,
    get brainCalls() { return brainCalls; },
    get usedTokens() { return usedTokens; },
    get usageMissing() { return usageMissing; },
    get elapsedMs() { return Date.now() - turnStartedAt; },
  };
}
