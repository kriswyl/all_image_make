import type { DatabaseSync } from "node:sqlite";
import type { ChatToolScope, Conversation, ConversationKind, ConversationPatch, ConversationStatus, ConversationUsage, VideoConfirmPolicy } from "../shared/agent-types.js";
import { canvasIdsFromRow, now, stringArrayFromJson, type DbRow } from "./db-row.js";

export type CreateConversationInput = {
  title: string; brainChannelId: string; brainModel: string;
  videoConfirmPolicy: VideoConfirmPolicy; visionEnabled: boolean; verbatimPrompt: boolean;
  imageConfirmPolicy?: "batch_only" | "always";
  /** 缺省是普通对话；无限画布线程由 board 服务显式传 board */
  kind?: ConversationKind;
  boardId?: string | null;
  toolScope?: ChatToolScope;
};

export class ConversationRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** Global image-confirm policy; the composer no longer exposes a per-conversation switch. */
  setAllImageConfirmPolicy(policy: "batch_only" | "always") {
    this.db.prepare("UPDATE conversations SET image_confirm_policy = ?").run(policy);
  }

  // ── 对话式 Agent（AGENT_PLAN.md §5） ──────────────────────────────────────

  createConversation(input: CreateConversationInput): Conversation {
    const id = crypto.randomUUID();
    const at = now();
    this.db.prepare(`
      INSERT INTO conversations
      (id, title, kind, board_id, brain_channel_id, brain_model, current_asset_id, canvas_asset_ids, status,
       video_confirm_policy, vision_enabled, verbatim_prompt, image_confirm_policy, context_budget, chat_auto_continue_limit,
       board_max_rounds, board_auto_continue_limit, auto_continue_count, tool_scope, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, '[]', 'idle', ?, ?, ?, ?, 350000, 20, 10, 3, 0, ?, ?, ?)
    `).run(
      id, input.title, input.kind ?? "chat", input.boardId ?? null, input.brainChannelId, input.brainModel,
      input.videoConfirmPolicy, input.visionEnabled ? 1 : 0, input.verbatimPrompt ? 1 : 0, input.imageConfirmPolicy ?? "batch_only", input.toolScope ?? null, at, at,
    );
    return this.getConversation(id)!;
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as DbRow | undefined;
    return row ? this.conversationFromRow(row) : null;
  }

  listConversations(): Conversation[] {
    // 无限画布的 Agent 线程也是 conversation，但它是板的一部分，不能混进对话侧栏
    const rows = this.db.prepare("SELECT * FROM conversations WHERE kind = 'chat' ORDER BY updated_at DESC").all() as DbRow[];
    return rows.map((row) => this.conversationFromRow(row));
  }

  /**
   * 一条消息都没有的会话 id。
   *
   * 新建会话时用它清掉上一条没动过的空壳——点几下「新对话」就堆几条，
   * 侧栏会被一串「新对话」刷屏。空会话没有消息，也就没有产物和上传图，删掉不丢东西。
   */
  emptyConversationIds(): string[] {
    // 只清普通对话。无限画布线程刚建出来时也没有消息，但它不是空壳——
    // 放进这个清理里，用户新建一块板再点「新对话」就会把板的线程删掉。
    const rows = this.db.prepare(
      `SELECT conversations.id AS id FROM conversations
       WHERE conversations.kind = 'chat'
         AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.conversation_id = conversations.id)`,
    ).all() as DbRow[];
    return rows.map((row) => String(row.id));
  }

  /** 只改传进来的字段；`canvasAssetIds: []` 是「清空画布」，和「没传」是两回事 */
  updateConversation(id: string, patch: ConversationPatch): Conversation | null {
    const fields: string[] = [];
    const values: Array<string | number | null> = [];
    const mapping: Record<string, string> = {
      title: "title",
      brainChannelId: "brain_channel_id",
      brainModel: "brain_model",
      videoConfirmPolicy: "video_confirm_policy",
      chatMode: "chat_mode",
      toolScope: "tool_scope",
      contextBudget: "context_budget",
      chatAutoContinueLimit: "chat_auto_continue_limit",
      chatToolRoundLimit: "chat_tool_round_limit",
      toolsUnsupported: "tools_unsupported",
      nativeImagePilot: "native_image_pilot",
      imageConfirmPolicy: "image_confirm_policy",
      chatModelCallLimit: "chat_model_call_limit",
      chatTurnMinutes: "chat_turn_minutes",
      chatTokenLimit: "chat_token_limit",
      boardMaxRounds: "board_max_rounds",
      boardAutoContinueLimit: "board_auto_continue_limit",
    };
    for (const [key, column] of Object.entries(mapping)) {
      if (!(key in patch)) continue;
      const value = (patch as Record<string, unknown>)[key];
      fields.push(`${column} = ?`);
      // SQLite 只认 0/1，布尔值直接塞进去会报 "cannot be bound"
      values.push(typeof value === "boolean" ? (value ? 1 : 0) : value as string | null);
    }
    // 画布是数组，不能走上面那个把值强转成 string | null 的循环——得像 visionEnabled 一样单开一支
    if ("canvasAssetIds" in patch && patch.canvasAssetIds) {
      fields.push("canvas_asset_ids = ?");
      values.push(JSON.stringify(patch.canvasAssetIds));
    }
    if ("visionEnabled" in patch) {
      fields.push("vision_enabled = ?");
      values.push(patch.visionEnabled ? 1 : 0);
    }
    if ("verbatimPrompt" in patch) {
      fields.push("verbatim_prompt = ?");
      values.push(patch.verbatimPrompt ? 1 : 0);
    }
    if (!fields.length) return this.getConversation(id);
    fields.push("updated_at = ?");
    values.push(now(), id);
    this.db.prepare(`UPDATE conversations SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.getConversation(id);
  }

  /** 会话状态机（§12.3）与自动续跑计数；不给 updated_at 让列表顺序被内部状态变化打乱 */
  setConversationStatus(id: string, status: ConversationStatus, options: { touch?: boolean } = {}) {
    if (options.touch === false) {
      this.db.prepare("UPDATE conversations SET status = ? WHERE id = ?").run(status, id);
      return;
    }
    this.db.prepare("UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
  }

  bumpAutoContinue(id: string) {
    this.db.prepare("UPDATE conversations SET auto_continue_count = auto_continue_count + 1, updated_at = ? WHERE id = ?").run(now(), id);
  }

  resetAutoContinue(id: string) {
    this.db.prepare("UPDATE conversations SET auto_continue_count = 0 WHERE id = ?").run(id);
  }

  recordBrainCall(conversationId: string, usage: { promptTokens: number; completionTokens: number; reasoningTokens: number }) {
    this.db.prepare(`
      INSERT INTO brain_calls (id, conversation_id, prompt_tokens, completion_tokens, reasoning_tokens, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), conversationId, usage.promptTokens, usage.completionTokens, usage.reasoningTokens, now());
  }

  /** 会话的 token 账本：累计输入/输出，以及**最近一次**请求的输入大小（≈ 当前上下文） */
  conversationUsage(conversationId: string): ConversationUsage {
    const totals = this.db.prepare(`
      SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt,
             COALESCE(SUM(completion_tokens), 0) AS completion,
             COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
             COUNT(*) AS calls
      FROM brain_calls WHERE conversation_id = ?
    `).get(conversationId) as DbRow;
    // rowid 兜底：同一毫秒内的两次调用 created_at 可能一模一样
    const last = this.db.prepare(`
      SELECT prompt_tokens FROM brain_calls WHERE conversation_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT 1
    `).get(conversationId) as DbRow | undefined;
    return {
      contextTokens: last ? Number(last.prompt_tokens) : 0,
      promptTokens: Number(totals.prompt),
      completionTokens: Number(totals.completion),
      reasoningTokens: Number(totals.reasoning),
      calls: Number(totals.calls),
    };
  }

  getContextSummary(id: string): { text: string; throughSeq: number; anchorIds: string[] } | null {
    const row = this.db.prepare("SELECT context_summary, context_summary_seq, context_anchors FROM conversations WHERE id = ?").get(id) as DbRow | undefined;
    if (!row || !row.context_summary || !Number(row.context_summary_seq)) return null;
    return { text: String(row.context_summary), throughSeq: Number(row.context_summary_seq), anchorIds: stringArrayFromJson(row.context_anchors) };
  }

  saveContextSummary(id: string, text: string, throughSeq: number, anchorIds: string[]) {
    this.db.prepare("UPDATE conversations SET context_summary = ?, context_summary_seq = ?, context_anchors = ? WHERE id = ?").run(text, throughSeq, JSON.stringify(anchorIds), id);
  }

  /** 视频任务完成后靠它找回会话（§9.1）；一个任务只会属于一个会话 */
  findConversationByTask(taskId: string): Conversation | null {
    const row = this.db.prepare(
      "SELECT conversations.* FROM conversations JOIN messages ON messages.conversation_id = conversations.id WHERE messages.task_id = ? ORDER BY messages.seq DESC LIMIT 1",
    ).get(taskId) as DbRow | undefined;
    return row ? this.conversationFromRow(row) : null;
  }

  private conversationFromRow(row: DbRow): Conversation {
    return {
      id: String(row.id), title: String(row.title),
      kind: (row.kind == null ? "chat" : String(row.kind)) as ConversationKind,
      boardId: row.board_id == null ? null : String(row.board_id),
      brainChannelId: String(row.brain_channel_id), brainModel: String(row.brain_model),
      // JSON 坏了或者还是 NULL（没迁移到的老行）都当成空画布，别让一行坏数据炸掉整个会话列表
      canvasAssetIds: canvasIdsFromRow(row.canvas_asset_ids),
      status: String(row.status) as ConversationStatus,
      videoConfirmPolicy: String(row.video_confirm_policy) as VideoConfirmPolicy,
      visionEnabled: Boolean(row.vision_enabled),
      verbatimPrompt: Boolean(row.verbatim_prompt),
      chatMode: row.kind === "board" ? "creative" : row.chat_mode === "chat" ? "chat" : "creative",
      toolScope: row.kind !== "board" && (row.tool_scope === "all" || row.tool_scope === "conversation") ? row.tool_scope : null,
      contextBudget: Number(row.context_budget) || 350000,
      chatAutoContinueLimit: row.chat_auto_continue_limit == null ? 20 : Number(row.chat_auto_continue_limit),
      chatToolRoundLimit: row.chat_tool_round_limit == null ? 16 : Number(row.chat_tool_round_limit),
      toolsUnsupported: Boolean(row.tools_unsupported),
      nativeImagePilot: Boolean(row.native_image_pilot),
      imageConfirmPolicy: row.image_confirm_policy === "always" ? "always" : "batch_only",
      chatModelCallLimit: row.chat_model_call_limit == null ? 500 : Number(row.chat_model_call_limit),
      chatTurnMinutes: row.chat_turn_minutes == null ? 30 : Number(row.chat_turn_minutes),
      chatTokenLimit: row.chat_token_limit == null ? 0 : Number(row.chat_token_limit),
      boardMaxRounds: row.board_max_rounds == null ? 10 : Number(row.board_max_rounds),
      boardAutoContinueLimit: row.board_auto_continue_limit == null ? 3 : Number(row.board_auto_continue_limit),
      autoContinueCount: Number(row.auto_continue_count),
      taskCount: this.countConversationTasks(String(row.id)),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  private countConversationTasks(conversationId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ? AND task_id IS NOT NULL",
    ).get(conversationId) as DbRow;
    return Number(row.total);
  }
}
