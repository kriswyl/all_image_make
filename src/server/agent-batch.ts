/**
 * 批量执行：并行产图、一致性批量（先生成基准图）、单调用直通。
 *
 * 这里只依赖一个很小的 `BatchHost`，不依赖整个 AgentService；
 * AgentService 负责主循环和状态，批量执行器负责把一批调用跑完并落库。
 */
import type { AppDatabase } from "./db.js";
import { runAgentTool, type ToolContext, type ToolOutcome } from "./agent-tools.js";
import type {
  AgentPlan,
  AgentStreamEvent,
  ChatMessage,
  Conversation,
  PlannedCall,
} from "../shared/agent-types.js";

export interface BatchOutcome {
  /** 本轮到此为止，等任务完成事件再续跑（异步视频/音乐） */
  terminal: boolean;
  /** 每个调用的结果，**按计划顺序**，不按完成顺序 */
  results: ToolOutcome[];
}

export interface BatchHost {
  db: AppDatabase;
  executeTool(
    conversation: Conversation,
    plan: { tool: PlannedCall["tool"]; args: Record<string, unknown>; say?: string },
    controller: AbortController,
    options: { existingMessageId?: string; confirmed?: boolean },
    turnAttachmentIds?: string[],
  ): Promise<ToolOutcome>;
  toolContext(
    conversation: Conversation,
    controller: AbortController,
    options: { confirmed?: boolean },
    turnAttachmentIds?: string[],
  ): ToolContext;
  broadcast(conversationId: string, event: AgentStreamEvent): void;
}

/** 一致性批量里，其余几张自动加在提示词前面的约束（第 1 张是基准，不改它的原话） */
const CHARACTER_CONSISTENCY_PREFIX = "以参考图中的同一位人物为准，严格保持脸型、五官、发型、肤色、体型、服装和整体风格完全一致，只改变场景、姿态与构图：\n";
const STYLE_CONSISTENCY_PREFIX = "以参考图的画风、色调、光线、质感和整体风格为准，保持完全一致，只改变画面内容：\n";

/** `Promise.allSettled` 的一条 → 工具结果。单个调用炸掉不能带走整批 */
function settleToolOutcome(item: PromiseSettledResult<ToolOutcome>): ToolOutcome {
  if (item.status === "fulfilled") return item.value;
  return {
    result: {
      ok: false,
      summary: `工具执行时出错：${item.reason instanceof Error ? item.reason.message : "未知错误"}`,
      error: "TOOL_THREW",
    },
    terminal: false,
  };
}

export class BatchExecutor {
  constructor(private readonly host: BatchHost) {}

  async executeBatch(
    conversation: Conversation,
    plan: { calls: PlannedCall[]; say?: string; consistency?: "character" | "style" },
    controller: AbortController,
    options: { existingMessageId?: string; confirmed?: boolean },
    turnAttachmentIds: string[] = [],
  ): Promise<BatchOutcome> {
    const first = plan.calls[0];
    if (!first) return { terminal: false, results: [] };
    if (plan.calls.length === 1) {
      const outcome = await this.host.executeTool(
        conversation,
        { tool: first.tool, args: first.args, ...(plan.say ? { say: plan.say } : {}) },
        controller,
        options,
        turnAttachmentIds,
      );
      return { terminal: outcome.terminal, results: [outcome] };
    }
    // 要同一人物 / 同一画风的批量：先生成第 1 张当基准，其余以它为参考并行改。
    // 只有「全部是 generate_image」才走这条路。
    if (plan.consistency && plan.calls.every((call) => call.tool === "generate_image")) {
      return this.executeConsistent(
        conversation, plan.calls, plan.say, plan.consistency, controller, options, turnAttachmentIds,
      );
    }
    return this.executeParallel(conversation, plan.calls, plan.say, controller, options, turnAttachmentIds);
  }

  /**
   * 批量的公共开头：**一条**表头助手行 + **N 条** pending 工具行。
   *
   * 表头 `toolName` 特意留空：写上的话 `buildRows` 会把它和后面某一条工具行
   * 折成同一张卡，N 张就少一张。
   */
  beginBatch(
    conversationId: string,
    calls: PlannedCall[],
    say: string | undefined,
    options: { existingMessageId?: string; consistency?: AgentPlan["consistency"] } = {},
  ): { header: ChatMessage; rows: ChatMessage[] } {
    const db = this.host.db;
    let header: ChatMessage;
    if (options.existingMessageId) {
      db.updateMessage(options.existingMessageId, { confirm: null, status: "ok" });
      header = db.getMessage(options.existingMessageId)!;
    } else {
      header = db.appendMessage({
        conversationId, role: "assistant", content: say ?? null,
        plan: {
          tool: calls[0]!.tool, args: calls[0]!.args, calls,
          ...(say ? { say } : {}),
          ...(options.consistency ? { consistency: options.consistency } : {}),
        },
      });
      this.host.broadcast(conversationId, { type: "plan", messageId: header.id, plan: header.plan! });
    }
    this.host.broadcast(conversationId, { type: "message", message: header });

    const rows = calls.map((call) => {
      const row = db.appendMessage({
        conversationId, role: "tool", content: null, toolName: call.tool, toolArgs: call.args,
        status: "pending",
      });
      this.host.broadcast(conversationId, { type: "message", message: row });
      return row;
    });
    return { header, rows };
  }

  /** 批量收尾：结果按**计划顺序**返回；画布保持用户这次明确挑的那组，不自动替换 */
  finishBatch(_conversation: Conversation, _calls: PlannedCall[], results: ToolOutcome[]): BatchOutcome {
    return { terminal: results.some((item) => item.terminal), results };
  }

  /**
   * N 个产图调用**同时**提交、一起等。
   *
   * 拿到的钱是一样的（N 个任务就是 N 笔），省下来的只有等待时间——
   * 所以**绝不能顺手把失败的那几个偷偷重试**。
   */
  async executeParallel(
    conversation: Conversation,
    calls: PlannedCall[],
    say: string | undefined,
    controller: AbortController,
    options: { existingMessageId?: string } = {},
    turnAttachmentIds: string[] = [],
  ): Promise<BatchOutcome> {
    const { rows } = this.beginBatch(conversation.id, calls, say, options);
    const ctx = this.host.toolContext(conversation, controller, { confirmed: true }, turnAttachmentIds);
    const settled = await Promise.allSettled(
      calls.map((call, index) => this.runOneTool(call, ctx, rows[index]!.id)),
    );
    return this.finishBatch(conversation, calls, settled.map(settleToolOutcome));
  }

  /**
   * 需要保持一致的批量：**先生成第 1 张当基准**，再以它为参考图并行生成其余几张。
   *
   * 基准图失败时退回普通并行——接下来几张至少还有机会出，不能让一整批白跑。
   */
  async executeConsistent(
    conversation: Conversation,
    calls: PlannedCall[],
    say: string | undefined,
    consistency: "character" | "style",
    controller: AbortController,
    options: { existingMessageId?: string } = {},
    turnAttachmentIds: string[] = [],
  ): Promise<BatchOutcome> {
    const { rows } = this.beginBatch(conversation.id, calls, say, { ...options, consistency });
    const ctx = this.host.toolContext(conversation, controller, { confirmed: true }, turnAttachmentIds);

    const base = await this.runOneTool(calls[0]!, ctx, rows[0]!.id);
    const results: ToolOutcome[] = [base];

    if (base.producedAssetId) {
      // 后续几张必须参考**基准图**，不能又去参考用户最开始附带的那几张
      const consistentCtx = this.host.toolContext(
        { ...conversation, canvasAssetIds: [base.producedAssetId] },
        controller,
        { confirmed: true },
        [],
      );
      const baseAlias = typeof base.result.data?.alias === "string" ? base.result.data.alias : undefined;
      const settled = await Promise.allSettled(
        calls.slice(1).map((call, index) => this.runOneTool(
          this.consistentCall(call, consistency, base.producedAssetId!, baseAlias), consistentCtx, rows[index + 1]!.id,
        )),
      );
      results.push(...settled.map(settleToolOutcome));
    } else {
      // 基准图没出来：退回普通并行，别让剩下几张连试都不试
      const settled = await Promise.allSettled(
        calls.slice(1).map((call, index) => this.runOneTool(call, ctx, rows[index + 1]!.id)),
      );
      results.push(...settled.map(settleToolOutcome));
    }
    return this.finishBatch(conversation, calls, results);
  }

  /**
   * 把「并行批量里的第 N 句提示词」改写成「以基准图为准的改图指令」。
   *
   * `fromScratch: false` 是必须的：大脑可能在 args 里写了 `true`，
   * 照抄就会把参考图丢掉，一致性直接失效。
   */
  consistentCall(
    call: PlannedCall,
    mode: "character" | "style",
    baseImageId: string,
    baseAlias?: string,
  ): PlannedCall {
    const prompt = typeof call.args.prompt === "string" ? call.args.prompt : "";
    const prefix = mode === "style" ? STYLE_CONSISTENCY_PREFIX : CHARACTER_CONSISTENCY_PREFIX;
    return {
      tool: call.tool,
      args: {
        ...call.args,
        prompt: `${prefix}${prompt}`,
        fromScratch: false,
        imageRefs: [baseImageId],
        ...(baseAlias ? { modelHint: baseAlias } : {}),
      },
    };
  }

  /** 「为什么只跑了第一个 / 有几个没提交」——说给用户听 */
  announceNote(conversationId: string, note: string) {
    if (!note) return;
    const message = this.host.db.appendMessage({ conversationId, role: "system", content: note });
    this.host.broadcast(conversationId, { type: "message", message });
  }

  /** 批量里的单个调用：跑它，然后把它自己那条 pending 行定稿 */
  async runOneTool(call: PlannedCall, ctx: ToolContext, rowId: string): Promise<ToolOutcome> {
    const outcome = await this.callToolSafely(call, ctx);
    this.host.db.updateMessage(rowId, {
      content: outcome.result.summary,
      toolResult: outcome.result,
      taskId: outcome.result.taskId ?? null,
      assetId: outcome.result.assetId ?? null,
      status: outcome.terminal ? "pending" : outcome.result.ok ? "ok" : "error",
      errorMessage: outcome.result.ok ? null : outcome.result.summary,
    });
    const updated = this.host.db.getMessage(rowId);
    if (updated) this.host.broadcast(ctx.conversation.id, { type: "message", message: updated });
    if (outcome.result.taskId) {
      this.host.broadcast(ctx.conversation.id, {
        type: "progress", taskId: outcome.result.taskId,
        status: outcome.terminal ? "queued" : "succeeded", progress: outcome.terminal ? 0 : 100,
      });
    }
    return outcome;
  }

  /** 工具抛出来的异常翻译成一条失败结果，别让它带着堆栈冲掉整批 */
  async callToolSafely(call: PlannedCall, ctx: ToolContext): Promise<ToolOutcome> {
    try {
      return await runAgentTool(call.tool, call.args, ctx);
    } catch (error) {
      return {
        result: {
          ok: false,
          summary: `工具执行时出错：${error instanceof Error ? error.message : "未知错误"}`,
          error: "TOOL_THREW",
        },
        terminal: false,
      };
    }
  }
}
