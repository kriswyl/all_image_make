import { planCalls, type AgentPlan, type AgentStreamEvent, type Conversation } from "../shared/agent-types.js";
import type { BatchExecutor } from "./agent-batch.js";
import type { BrainRunner } from "./agent-brain.js";
import { MAX_PARSE_RETRY, MAX_ROUNDS, MAX_VISION_READS_PER_ROUND } from "./agent-constants.js";
import { EMPTY_REPLY_CORRECTION, IDENTITY_CORRECTION, looksLikeIdentityDrift, type BuiltContext } from "./agent-context.js";
import { materializeLegacyCall, previewLegacyConfirmation } from "./agent-legacy-calls.js";
import { extractPlanText, parsePlan, repairPlan, resolveBatch, salvagePlan } from "./agent-plan.js";
import type { ToolContext, ToolOutcome } from "./agent-tools.js";
import { observeBoardImages, observeImages } from "./agent-vision.js";
import type { TurnTrigger } from "./agent.js";
import type { BrainMessage } from "./brain.js";
import type { AppDatabase } from "./db.js";

interface LegacyTurnHost {
  db: AppDatabase;
  batch: Pick<BatchExecutor, "announceNote" | "executeBatch">;
  brain: Pick<BrainRunner, "buildBrainMessages" | "callBrainWithRecovery" | "callBrainRaw">;
  defaultAliases(): ToolContext["defaultAliases"];
  broadcast(conversationId: string, event: AgentStreamEvent): void;
  setStatus(conversationId: string, status: Conversation["status"]): void;
  finishInterrupted(conversationId: string): void;
  stopOnUnknownSubmission(conversationId: string, outcomes: ToolOutcome[]): boolean;
}

export class AgentLegacyTurnRunner {
  constructor(private readonly host: LegacyTurnHost) {}

  async run(
    conversationId: string,
    trigger: TurnTrigger,
    controller: AbortController,
    startRound: number,
    turnAttachmentIds: string[] = [],
  ) {
    // 画布线程允许单独调大：多镜头「先建节点再逐镜生成」很容易超过 10 轮
    const opening = this.host.db.getConversation(conversationId);
    const maxRounds = opening?.kind === "board" ? opening.boardMaxRounds ?? MAX_ROUNDS : MAX_ROUNDS;
    for (let round = startRound; round < maxRounds; round += 1) {
      if (controller.signal.aborted) return this.host.finishInterrupted(conversationId);
      const conversation = this.host.db.getConversation(conversationId);
      if (!conversation) return;

      const turnConversation = conversation.kind === "chat" ? { ...conversation, chatMode: "creative" as const } : conversation;
      const outcome = await this.runOneRound(turnConversation, trigger, round, controller, turnAttachmentIds);
      if (outcome === "stop") return;
    }

    // 轮次用尽：大脑在循环里转圈，收尾说一句实话而不是让它一直烧钱
    const note = this.host.db.appendMessage({
      conversationId, role: "system", status: "error",
      content: `这一轮已经尝试了 ${maxRounds} 次，我先停下来了。可以换个说法再试，或者直接说明你想要的结果。`,
    });
    this.host.broadcast(conversationId, { type: "message", message: note });
    this.host.setStatus(conversationId, "idle");
    this.host.broadcast(conversationId, { type: "done", status: "idle" });
  }

  /** 返回 "stop" 表示这一轮结束（正常收尾 / 等任务 / 等确认），"continue" 表示继续下一轮 */
  private async runOneRound(
    conversation: Conversation,
    trigger: TurnTrigger,
    round: number,
    controller: AbortController,
    turnAttachmentIds: string[],
  ): Promise<"continue" | "stop"> {
    const built = await this.host.brain.buildBrainMessages(conversation, turnAttachmentIds);
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
    let result = await this.host.brain.callBrainWithRecovery(conversation, built, controller);

    /**
     * 身份被上游提示词盖住时纠正一次（见 `looksLikeIdentityDrift`）。
     *
     * 只在这一轮的原话里真的出现跑偏信号时才多花一次调用；纠正失败就把原文
     * 交给下面的解析/兜底，不再反复重试——中转站不听话时来回重试只是烧钱。
     */
    if (looksLikeIdentityDrift(result.content)) {
      this.host.broadcast(conversationId, { type: "reset" });
      try {
        result = await this.host.brain.callBrainRaw(conversation, [
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
      this.host.broadcast(conversationId, { type: "reset" });
      result = await this.host.brain.callBrainRaw(conversation, corrected, controller, conversationId, { silent: true });
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
      const message = this.host.db.appendMessage({
        conversationId, role: "assistant", content: fallback || emptyText,
        status: fallback ? "ok" : "error",
        errorMessage: fallback ? null : (exhausted ? "大脑把输出额度用在了思考上" : "大脑返回了空内容"),
      });
      this.host.broadcast(conversationId, { type: "message", message });
      this.host.setStatus(conversationId, "idle");
      this.host.broadcast(conversationId, { type: "done", status: "idle" });
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
        const note = this.host.db.appendMessage({ conversationId, role: "system", status: "error", content: "本轮看图次数已达上限，请缩小检查范围后继续。" });
        this.host.broadcast(conversationId, { type: "message", message: note });
        this.host.setStatus(conversationId, "idle");
        this.host.broadcast(conversationId, { type: "done", status: "idle" });
        return "stop";
      }
      const observed = await observeBoardImages(this.host.db, conversation, plan, built);
      this.host.broadcast(conversationId, { type: "reset" });
      return this.runRoundWithMessages(
        conversation, trigger, round, controller, observed, turnAttachmentIds, visionReads + 1,
      );
    }

    if (plan.tool === "view_images") {
      if (visionReads >= MAX_VISION_READS_PER_ROUND) {
        const note = this.host.db.appendMessage({
          conversationId, role: "system", status: "error",
          content: `这一轮已经看了 ${MAX_VISION_READS_PER_ROUND} 次图，我先停下来了。可以直接说要改哪一张（例如「画布第 2 张」），或把图拖进输入框再发一次。`,
        });
        this.host.broadcast(conversationId, { type: "message", message: note });
        this.host.setStatus(conversationId, "idle");
        this.host.broadcast(conversationId, { type: "done", status: "idle" });
        return "stop";
      }
      const observed = await observeImages({ db: this.host.db }, conversation, plan, built);
      // 刚才那串 view_images 的原始 JSON 不能留在输入框/流式气泡里
      this.host.broadcast(conversationId, { type: "reset" });
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
        this.host.broadcast(conversationId, { type: "reset" });
        try {
          const retried = await this.host.brain.callBrainRaw(conversation, [
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
        const note = this.host.db.appendMessage({
          conversationId, role: "system", status: "error",
          content: "助手这次没有返回正文（模型给了个空的回复），请再说一次。",
        });
        this.host.broadcast(conversationId, { type: "message", message: note });
        this.host.setStatus(conversationId, "idle");
        this.host.broadcast(conversationId, { type: "done", status: "idle" });
        return "stop";
      }

      // 把正文写回 plan：下一轮回放时，模型能看到自己上一条到底说了什么
      const normalizedPlan: AgentPlan = plan.tool === "ask"
        ? { ...plan, args: { ...plan.args, question: text } }
        : { ...plan, args: { ...plan.args, text } };
      const message = this.host.db.appendMessage({ conversationId, role: "assistant", content: text, plan: normalizedPlan });
      this.host.broadcast(conversationId, { type: "message", message });
      this.host.setStatus(conversationId, "idle");
      this.host.broadcast(conversationId, { type: "done", status: "idle" });
      return "stop";
    }

    return this.executePlan(conversation, plan, controller, turnAttachmentIds, trigger !== "user" || round > 0);
  }

  private async executePlan(
    conversation: Conversation,
    plan: AgentPlan,
    controller: AbortController,
    turnAttachmentIds: string[],
    isContinuation: boolean,
  ): Promise<"continue" | "stop"> {
    const conversationId = conversation.id;
    // §13 / §16：确认闸门。链条上的视频、以及超额度的任何生成都先问一句。
    // 闸门看的是 `resolveBatch` 之后**真正要跑的那几个**——卡片上问 N 张、
    // 实际提交 M 张是这里最不能出的错
    const resolvedBatch = resolveBatch(planCalls(plan));
    // 把「这一轮附带的图」固化成显式 imageRefs / mode：
    // 确认卡审批、跨轮续跑时附件集合已经没了，参数里必须已经写清楚用哪几张
    const calls = resolvedBatch.calls.map((call) =>
      materializeLegacyCall(this.host.db, conversation, call, turnAttachmentIds, this.host.defaultAliases));
    // 只跑了第一个 / 超上限被截断：在这里说，只此一处。放在执行器里说会漏掉
    // 「额度超了、这一批要用户先确认」那条路——那条路上执行器根本还没跑
    this.host.batch.announceNote(conversationId, resolvedBatch.note);
    const preview = previewLegacyConfirmation(this.host.db, conversation, calls, turnAttachmentIds, {
      isContinuation, consistency: plan.consistency, defaultAliases: this.host.defaultAliases,
    });
    if (preview) {
      // 待确认的是**整批**，所以 toolName 留空、calls 存在 plan 里：
      // 写一个 toolName 上去只会让 UI 把它当成「只画一张」，确认后也只知道要跑那一个
      const pendingPlan: AgentPlan = {
        tool: calls[0]!.tool, args: calls[0]!.args,
        ...(plan.say ? { say: plan.say } : {}),
        ...(calls.length > 1 ? { calls } : {}),
        // 一致性要跟着确认卡片一起落库，否则用户点头之后批量就退化成普通并行了
        ...(calls.length > 1 && plan.consistency ? { consistency: plan.consistency } : {}),
      };
      const message = this.host.db.appendMessage({
        conversationId, role: "assistant", content: plan.say ?? "", plan: pendingPlan,
        ...(calls.length === 1 ? { toolName: calls[0]!.tool, toolArgs: calls[0]!.args } : {}),
        confirm: preview, status: "pending",
      });
      this.host.broadcast(conversationId, { type: "plan", messageId: message.id, plan: pendingPlan });
      this.host.broadcast(conversationId, { type: "message", message });
      this.host.broadcast(conversationId, { type: "confirm", messageId: message.id, preview });
      this.host.setStatus(conversationId, "awaiting_confirmation");
      this.host.broadcast(conversationId, { type: "done", status: "awaiting_confirmation" });
      return "stop";
    }

    const outcome = await this.host.batch.executeBatch(conversation, {
      calls,
      ...(plan.say ? { say: plan.say } : {}),
      ...(plan.consistency ? { consistency: plan.consistency } : {}),
    }, controller, {}, turnAttachmentIds);
    if (this.host.stopOnUnknownSubmission(conversationId, outcome.results)) return "stop";
    if (outcome.terminal) {
      // 视频这类异步任务：交给 TaskRunner 的完成事件续跑（§12.2）
      this.host.setStatus(conversationId, "waiting_task");
      this.host.broadcast(conversationId, { type: "done", status: "waiting_task" });
      return "stop";
    }
    return "continue";
  }
}
