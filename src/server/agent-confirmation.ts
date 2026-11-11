import {
  AGENT_TOOL_NAMES, planCalls, usesNativeCreativeTools, usesPlainChat,
  type AgentStreamEvent, type AgentToolName, type Conversation, type PlannedCall,
} from "../shared/agent-types.js";
import type { BatchExecutor } from "./agent-batch.js";
import { isBrainDown } from "./agent-brain-errors.js";
import { mergeConfirmArgs, withConfirmedVideoSelection } from "./agent-confirm.js";
import { nativeBatchCheckpoint, nativeMediaCheckpoint } from "./agent-media-checkpoint.js";
import { asString } from "./agent-plan.js";
import type { ToolOutcome } from "./agent-tools.js";
import { buildCapabilityAliases, resolveAlias } from "./capabilities.js";
import type { NativeMediaConfirmation } from "./chat-tools/native-image.js";
import type { AppDatabase } from "./db.js";
import { AppError } from "./tasks.js";

interface ConfirmationHost {
  db: AppDatabase;
  batch: Pick<BatchExecutor, "executeBatch">;
  hasActiveTurn(conversationId: string): boolean;
  broadcast(conversationId: string, event: AgentStreamEvent): void;
  setStatus(conversationId: string, status: Conversation["status"]): void;
  launchConfirmedTurn(conversationId: string, run: (controller: AbortController) => Promise<void>): void;
  executeTool(
    conversation: Conversation,
    plan: { tool: AgentToolName; args: Record<string, unknown> },
    controller: AbortController,
    options: { existingMessageId: string; confirmed: boolean; strictSubmission: boolean; backgroundMedia: boolean },
  ): Promise<ToolOutcome>;
  resumeNativeTurn(conversation: Conversation, controller: AbortController): Promise<void>;
  resumeLegacyTurn(conversationId: string, controller: AbortController): Promise<void>;
  finishInterrupted(conversationId: string): void;
  finishAfterBrainLoss(conversationId: string, note: string): void;
  settleFinishedTasks(conversationId: string): void;
  stopOnUnknownSubmission(conversationId: string, outcomes: ToolOutcome[]): boolean;
}

export class AgentConfirmationService {
  constructor(private readonly host: ConfirmationHost) {}

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
    const { db } = this.host;
    const conversation = db.getConversation(conversationId);
    if (!conversation) throw new AppError("CONVERSATION_NOT_FOUND", "会话不存在", 404);
    const message = db.getMessage(messageId);
    if (!message || message.conversationId !== conversationId) throw new AppError("MESSAGE_NOT_FOUND", "消息不存在", 404);
    if (message.status !== "pending" || !message.confirm) throw new AppError("NOT_PENDING", "这条已经处理过了", 409);
    if (this.host.hasActiveTurn(conversationId)) throw new AppError("TURN_IN_FLIGHT", "上一条还在处理中，请稍候", 409);

    if (decision === "reject") {
      // 卡片收起来，并把「用户取消了」记进上下文——下次大脑开口时知道这件事
      if (!db.claimAgentConfirmation(message, decision)) throw new AppError("NOT_PENDING", "这条已经处理过了", 409);
      const recorded = db.appendMessage({
        conversationId, role: "system", content: "已取消本次生成",
      });
      const updated = db.getMessage(messageId);
      if (updated) this.host.broadcast(conversationId, { type: "message", message: updated });
      this.host.broadcast(conversationId, { type: "message", message: recorded });
      db.setConversationStatus(conversationId, "idle", { touch: false });
      this.host.broadcast(conversationId, { type: "done", status: "idle" });
      return;
    }

    // 批量待确认的卡上**没有** toolName——写上去 UI 会把它当成「只画一张」，
    // 整批调用存在 plan.calls 里。
    const batch = planCalls(message.plan);
    const nativeMedia = db.getNativeMediaConfirmation(message.id);
    if (batch.length > 1) {
      if (nativeMedia) this.validateNativeConfirmation(conversation, nativeMedia, batch.map(call => call.args));
      if (!db.claimAgentConfirmation(message, decision)) throw new AppError("NOT_PENDING", "这条已经处理过了", 409);
      // 批量只使用卡片中保存的生图参数，原生批量还会接回对话断点。
      this.host.launchConfirmedTurn(conversationId, (controller) =>
        this.approveBatch(conversationId, message.id, batch, controller, message.plan?.consistency,
          db.getNativeMediaConfirmation(message.id)));
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
    if (!db.claimAgentConfirmation(message, decision, args)) throw new AppError("NOT_PENDING", "这条已经处理过了", 409);
    this.host.launchConfirmedTurn(conversationId, (controller) =>
      this.approve(conversationId, message.id, tool, args, controller, nativeMedia));
  }

  private validateNativeConfirmation(conversation: Conversation, state: NativeMediaConfirmation, calls: Record<string, unknown>[]) {
    const { db } = this.host;
    const { target, checkpoint } = state;
    const mediaChannel = db.getChannel(target.channelId);
    const brainChannel = db.getChannel(conversation.brainChannelId);
    const aliases = buildCapabilityAliases(db.listChannels());
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

  /** 用户点了「确认生成」：直接执行存下来的参数，不让大脑重新规划一遍（§13.5） */
  async approve(
    conversationId: string,
    messageId: string,
    tool: AgentToolName,
    args: Record<string, unknown>,
    controller: AbortController,
    nativeMedia: NativeMediaConfirmation | null = null,
  ) {
    const { db } = this.host;
    const conversation = db.getConversation(conversationId);
    if (!conversation) return;
    this.host.setStatus(conversationId, "running");
    const outcome = await this.host.executeTool(nativeMedia ? { ...conversation, verbatimPrompt: false } : conversation, { tool, args }, controller, {
      existingMessageId: messageId,
      confirmed: true,
      strictSubmission: Boolean(nativeMedia),
      backgroundMedia: Boolean(nativeMedia),
    });
    if (nativeMedia && controller.signal.aborted) {
      db.clearNativeMediaConfirmation(messageId);
      this.host.finishInterrupted(conversationId);
      if (outcome.terminal) this.host.settleFinishedTasks(conversationId);
      return;
    }
    if (this.host.stopOnUnknownSubmission(conversationId, [outcome])) return;
    if (nativeMedia && !outcome.terminal) {
      db.clearNativeMediaConfirmation(messageId);
      const current = db.getConversation(conversationId);
      if (!current || !usesNativeCreativeTools(current)) {
        this.host.setStatus(conversationId, "idle");
        this.host.broadcast(conversationId, { type: "done", status: "idle" });
        return;
      }
      if (!db.saveNativeTurnCheckpoint(conversationId, nativeMediaCheckpoint(nativeMedia, outcome.result))) {
        return this.host.finishAfterBrainLoss(conversationId, "生成结果已保存，当前对话过长，请发送新消息继续。");
      }
      try {
        await this.host.resumeNativeTurn(db.getConversation(conversationId) ?? conversation, controller);
      } catch {
        db.clearNativeTurnCheckpoint(conversationId);
        this.host.finishAfterBrainLoss(conversationId, "生成工具结果已保存，可以继续发送消息。");
      }
      return;
    }
    if (outcome.terminal) {
      this.host.setStatus(conversationId, "waiting_task");
      this.host.broadcast(conversationId, { type: "done", status: "waiting_task" });
      return;
    }
    if (usesPlainChat(db.getConversation(conversationId))) {
      this.host.setStatus(conversationId, "idle");
      this.host.broadcast(conversationId, { type: "done", status: "idle" });
      return;
    }
    try {
      await this.host.resumeLegacyTurn(conversationId, controller);
    } catch (error) {
      if (!isBrainDown(error) || controller.signal.aborted) throw error;
      this.host.finishAfterBrainLoss(conversationId, "生成已经提交并完成，但助手暂时接不上话（对话渠道不可用）。");
    }
  }

  /** 把确认卡就地转为批量表头，并执行卡片中保存的调用。 */
  private async approveBatch(
    conversationId: string,
    messageId: string,
    calls: PlannedCall[],
    controller: AbortController,
    consistency?: "character" | "style",
    nativeMedia: NativeMediaConfirmation | null = null,
  ) {
    const { db } = this.host;
    const conversation = db.getConversation(conversationId);
    if (!conversation) return;
    this.host.setStatus(conversationId, "running");
    // `say` 不给：表头行就是那张卡片，它上面的话一个字都不用重写
    const outcome = await this.host.batch.executeBatch(nativeMedia ? { ...conversation, verbatimPrompt: false } : conversation, {
      calls,
      ...(consistency ? { consistency } : {}),
    }, controller, {
      existingMessageId: messageId,
      confirmed: true,
    });
    if (this.host.stopOnUnknownSubmission(conversationId, outcome.results)) return;
    // 原生生图批量是同步等结果的；把每个原始 tool_call_id 的结果接回断点，
    // 让模型能接着说话，而不是像旧批量那样停在「图出来了但助手不吭声」。
    if (nativeMedia && !outcome.terminal && outcome.results.length === calls.length) {
      db.clearNativeMediaConfirmation(messageId);
      const current = db.getConversation(conversationId);
      if (!current || !usesNativeCreativeTools(current)) {
        this.host.setStatus(conversationId, "idle");
        this.host.broadcast(conversationId, { type: "done", status: "idle" });
        return;
      }
      if (!db.saveNativeTurnCheckpoint(conversationId, nativeBatchCheckpoint(nativeMedia, outcome.results))) {
        return this.host.finishAfterBrainLoss(conversationId, "图片已生成，当前对话过长，请发送新消息继续。");
      }
      try {
        await this.host.resumeNativeTurn(current, controller);
      } catch {
        db.clearNativeTurnCheckpoint(conversationId);
        this.host.finishAfterBrainLoss(conversationId, "图片已生成，可以继续发送消息。");
      }
      return;
    }
    if (outcome.terminal) {
      this.host.setStatus(conversationId, "waiting_task");
      this.host.broadcast(conversationId, { type: "done", status: "waiting_task" });
      return;
    }
    if (usesPlainChat(db.getConversation(conversationId))) {
      this.host.setStatus(conversationId, "idle");
      this.host.broadcast(conversationId, { type: "done", status: "idle" });
      return;
    }
    try {
      await this.host.resumeLegacyTurn(conversationId, controller);
    } catch (error) {
      if (!isBrainDown(error) || controller.signal.aborted) throw error;
      this.host.finishAfterBrainLoss(conversationId, "生成已经提交并完成，但助手暂时接不上话（对话渠道不可用）。");
    }
  }

  supersedePendingConfirmations(conversationId: string, nativeOnly = false) {
    const { db } = this.host;
    for (const message of db.listPendingMessages(conversationId)) {
      if (!message.confirm) continue;
      const native = Boolean(db.getNativeMediaConfirmation(message.id));
      if (nativeOnly && !native) continue;
      if (native && !db.claimAgentConfirmation(message, "reject")) continue;
      db.updateMessage(message.id, { confirm: null, status: "error", errorMessage: "已被用户的新消息取代" });
      const updated = db.getMessage(message.id);
      if (updated) this.host.broadcast(conversationId, { type: "message", message: updated });
    }
  }
}
