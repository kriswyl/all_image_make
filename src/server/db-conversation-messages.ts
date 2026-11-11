import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { AgentPlan, ChatDocumentRef, ChatMessage, ChatVideoFrames, ConfirmPreview, MessageRole, MessageStatus, ToolResult } from "../shared/agent-types.js";
import type { DocumentRepository } from "./db-documents.js";
import type { ConversationRepository } from "./db-conversations.js";
import { now, parseJson, type DbRow } from "./db-row.js";

export type AppendMessageInput = {
  conversationId: string; role: MessageRole; content?: string | null;
  plan?: AgentPlan | null; toolName?: string | null;
  toolArgs?: Record<string, unknown> | null; toolResult?: ToolResult | null;
  confirm?: ConfirmPreview | null; taskId?: string | null; assetId?: string | null;
  /** 这条消息引用的一组产物（用户从输入框拖进来的那些图） */
  assetRefs?: string[] | null;
  videoFrames?: ChatVideoFrames;
  /** 这条消息附带的脚本文档（只存引用，全文在 conversation_documents） */
  documents?: ChatDocumentRef[] | null;
  status?: MessageStatus; errorMessage?: string | null;
};

export type MessagePatch = Partial<Pick<ChatMessage, "content" | "status" | "errorMessage" | "taskId" | "assetId">> & {
  toolResult?: ToolResult | null; confirm?: ConfirmPreview | null; toolArgs?: Record<string, unknown> | null;
};

export class ConversationMessageRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly conversations: Pick<ConversationRepository, "setConversationStatus">,
    private readonly documents: Pick<DocumentRepository, "getWorkspaceDocumentByOperation" | "getPresentationVersion">,
    private readonly getDocumentsDir: () => string,
  ) {}

  /**
   * 把卡在 `running` 的会话收回 `idle`，返回改动了几条。
   *
   * 一轮的处理只活在内存里（`AgentService.activeTurns`），进程一没它就没了，
   * 而 `status` 已经落库成 `running`——界面于是永远在转圈（用户看到的就是
   * 「任务失败了还在转圈」）。启动时收拾一次即可，进程内的异常路径由
   * `startTurn` 的 finally 兜着。
   */
  resetConversationsStuckInRunning(): number {
    const interrupted = this.db.prepare("SELECT DISTINCT conversation_id FROM native_tool_calls WHERE status = 'running'").all() as DbRow[];
    for (const item of interrupted) {
      const conversationId = String(item.conversation_id);
      this.clearNativeTurnCheckpoint(conversationId);
      this.recoverNativeToolFiles(conversationId);
      this.interruptNativeToolCalls(conversationId);
    }
    const result = this.db.prepare("UPDATE conversations SET status = 'idle' WHERE status = 'running'").run();
    return Number(result.changes ?? 0);
  }

  beginNativeToolCall(conversationId: string, messageId: string, callId: string, toolName: string, argumentHash: string) {
    this.db.prepare("INSERT INTO native_tool_calls (message_id, conversation_id, call_id, tool_name, argument_hash, status, created_at) VALUES (?, ?, ?, ?, ?, 'running', ?)").run(messageId, conversationId, callId, toolName, argumentHash, now());
  }

  startNativeToolCall(conversationId: string, displayName: string, toolArgs: Record<string, unknown>, callId: string, toolName: string, argumentHash: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const message = this.appendMessage({ conversationId, role: "assistant", toolName: displayName, toolArgs, content: "", status: "pending" });
      this.beginNativeToolCall(conversationId, message.id, callId, toolName, argumentHash);
      this.db.exec("COMMIT");
      return message;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  finishNativeToolCall(conversationId: string, messageId: string, toolName: string, result: ToolResult) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const status = result.ok ? "ok" : "error";
      const changed = this.db.prepare("UPDATE native_tool_calls SET status = ?, finished_at = ? WHERE message_id = ? AND conversation_id = ? AND status = 'running'").run(status, now(), messageId, conversationId);
      if (Number(changed.changes) !== 1) throw new Error("工具调用状态已改变，无法重复写入结果");
      this.updateMessage(messageId, { content: "", status });
      const row = this.appendMessage({ conversationId, role: "tool", toolName, content: result.summary, toolResult: result, status, ...(result.ok ? {} : { errorMessage: result.summary }) });
      this.db.exec("COMMIT");
      return row;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  interruptNativeToolCalls(conversationId: string) {
    const message = "工具调用被中断，执行结果可能尚未记录；重试前请先检查已生成的文件。";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE messages SET status = 'error', content = '', error_message = ? WHERE id IN (SELECT message_id FROM native_tool_calls WHERE conversation_id = ? AND status = 'running')").run(message, conversationId);
      this.db.prepare("UPDATE native_tool_calls SET status = 'interrupted', finished_at = ? WHERE conversation_id = ? AND status = 'running'").run(now(), conversationId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  listNativeToolCalls(conversationId: string) {
    return this.db.prepare("SELECT message_id, call_id, tool_name, status, created_at, finished_at FROM native_tool_calls WHERE conversation_id = ? ORDER BY rowid").all(conversationId);
  }

  saveNativeTurnCheckpoint(conversationId: string, payload: string): boolean {
    if (payload.length > 2_000_000) { this.clearNativeTurnCheckpoint(conversationId); return false; }
    this.db.prepare("INSERT OR REPLACE INTO native_turn_checkpoints (conversation_id, payload, updated_at) VALUES (?, ?, ?)").run(conversationId, payload, now());
    return true;
  }

  getNativeTurnCheckpoint(conversationId: string): string | null {
    const row = this.db.prepare("SELECT payload FROM native_turn_checkpoints WHERE conversation_id = ?").get(conversationId) as DbRow | undefined;
    return row ? String(row.payload) : null;
  }

  clearNativeTurnCheckpoint(conversationId: string): void {
    this.db.prepare("DELETE FROM native_turn_checkpoints WHERE conversation_id = ?").run(conversationId);
  }

  recoverableNativeTurnIds(): string[] {
    const rows = this.db.prepare(`SELECT c.id FROM conversations c JOIN native_turn_checkpoints n ON n.conversation_id = c.id
      WHERE c.status = 'running' AND c.kind = 'chat' AND (c.tool_scope = 'all' OR (c.tool_scope IS NULL AND c.chat_mode = 'chat'))
      AND NOT EXISTS (SELECT 1 FROM native_tool_calls t WHERE t.conversation_id = c.id AND t.status = 'running')`).all() as DbRow[];
    return rows.map((row) => String(row.id));
  }

  /**
   * 这个会话里用户最后说的那句话。
   *
   * 「原话直发」用它当提示词——必须是**用户的原话**，不能是大脑改写过的版本。
   * 上传图片那类消息（role=user、内容是「上传了图片 x.png」）也在这里，但它们从来不是最后一条：
   * 发图时要求必须带一句话，那句话排在后头。
   */
  lastUserText(conversationId: string): string | null {
    const row = this.db.prepare(
      "SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' AND content IS NOT NULL ORDER BY seq DESC LIMIT 1",
    ).get(conversationId) as DbRow | undefined;
    const text = row ? String(row.content).trim() : "";
    return text || null;
  }

  listMessages(conversationId: string, limit = 400): ChatMessage[] {
    // 取最近 N 条再正序返回：对话长了以后不能整个表读进内存
    const rows = this.db.prepare(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?",
    ).all(conversationId, limit) as DbRow[];
    return rows.reverse().map((row) => this.messageFromRow(row));
  }

  listMessagesAfter(conversationId: string, seq: number): ChatMessage[] {
    const rows = this.db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC").all(conversationId, seq) as DbRow[];
    return rows.map((row) => this.messageFromRow(row));
  }

  getMessage(id: string): ChatMessage | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as DbRow | undefined;
    return row ? this.messageFromRow(row) : null;
  }

  appendMessage(input: AppendMessageInput): ChatMessage {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?")
      .get(input.conversationId) as DbRow;
    const seq = Number(row.next);
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO messages
      (id, conversation_id, seq, role, content, plan_json, tool_name, tool_args_json,
       tool_result_json, confirm_json, task_id, asset_id, asset_refs, video_frames_json, documents_json, status, error_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.conversationId, seq, input.role,
      input.content ?? null,
      input.plan ? JSON.stringify(input.plan) : null,
      input.toolName ?? null,
      input.toolArgs ? JSON.stringify(input.toolArgs) : null,
      input.toolResult ? JSON.stringify(input.toolResult) : null,
      input.confirm ? JSON.stringify(input.confirm) : null,
      input.taskId ?? null, input.assetId ?? null,
      input.assetRefs?.length ? JSON.stringify(input.assetRefs) : null,
      input.videoFrames ? JSON.stringify(input.videoFrames) : null,
      input.documents?.length ? JSON.stringify(input.documents) : null,
      input.status ?? "ok", input.errorMessage ?? null, now(),
    );
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now(), input.conversationId);
    return this.getMessage(id)!;
  }

  updateMessage(id: string, patch: MessagePatch) {
    const fields: string[] = [];
    const values: Array<string | null> = [];
    const mapping: Record<string, string> = {
      content: "content", status: "status", errorMessage: "error_message",
      taskId: "task_id", assetId: "asset_id",
    };
    for (const [key, column] of Object.entries(mapping)) {
      if (!(key in patch)) continue;
      fields.push(`${column} = ?`);
      values.push(((patch as Record<string, unknown>)[key] ?? null) as string | null);
    }
    if ("toolResult" in patch) {
      fields.push("tool_result_json = ?");
      values.push(patch.toolResult ? JSON.stringify(patch.toolResult) : null);
    }
    if ("confirm" in patch) {
      fields.push("confirm_json = ?");
      values.push(patch.confirm ? JSON.stringify(patch.confirm) : null);
    }
    if ("toolArgs" in patch) {
      fields.push("tool_args_json = ?");
      values.push(patch.toolArgs ? JSON.stringify(patch.toolArgs) : null);
    }
    if (!fields.length) return;
    values.push(id);
    this.db.prepare(`UPDATE messages SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  claimAgentConfirmation(message: ChatMessage, decision: "approve" | "reject", args?: Record<string, unknown>): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db.prepare(`
        UPDATE messages SET confirm_json = NULL, status = ?, error_message = ?,
          tool_args_json = COALESCE(?, tool_args_json)
        WHERE id = ? AND conversation_id = ? AND status = 'pending' AND confirm_json IS NOT NULL
      `).run(decision === "reject" ? "error" : "pending", decision === "reject" ? "用户取消了这次生成" : null,
        args ? JSON.stringify(args) : null, message.id, message.conversationId);
      if (Number(changed.changes) === 1) {
        const native = this.getNativeMediaConfirmation(message.id);
        const executionPath = native ? "native" : "legacy";
        const snapshot = JSON.stringify({ preview: message.confirm, plan: message.plan, args: args ?? message.toolArgs, executionPath });
        this.db.prepare("INSERT INTO agent_confirmation_decisions (message_id, decision, snapshot, created_at) VALUES (?, ?, ?, ?)")
          .run(message.id, decision, snapshot, now());
        if (native && decision === "reject") this.clearNativeMediaConfirmation(message.id);
      }
      this.db.exec("COMMIT");
      return Number(changed.changes) === 1;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  getNativeMediaConfirmation(messageId: string): import("./chat-tools/native-image.js").NativeMediaConfirmation | null {
    const row = this.db.prepare("SELECT payload FROM native_image_confirmations WHERE message_id = ?").get(messageId) as DbRow | undefined;
    if (!row) return null;
    const payload = JSON.parse(String(row.payload));
    // 旧图片确认卡仍可恢复，沿用现有表和操作 ID。
    if (!payload.target) payload.target = { kind: "image", channelId: payload.imageChannelId, channelVersion: payload.imageChannelVersion, model: payload.imageModel };
    return payload;
  }

  clearNativeMediaConfirmation(messageId: string): void {
    this.db.prepare("DELETE FROM native_image_confirmations WHERE message_id = ?").run(messageId);
  }

  completeNativeMediaTask(conversationId: string, pendingId: string, operationId: string, result: ToolResult,
    canResume: boolean, checkpoint: string | null): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.updateMessage(pendingId, {
        content: result.summary, toolResult: result, status: result.ok ? "ok" : "error",
        assetId: result.assetId ?? null, errorMessage: result.ok ? null : result.summary,
      });
      this.clearNativeMediaConfirmation(operationId);
      const resume = Boolean(canResume && checkpoint && this.saveNativeTurnCheckpoint(conversationId, checkpoint));
      if (canResume) this.conversations.setConversationStatus(conversationId, resume ? "running" : "idle", { touch: false });
      this.db.exec("COMMIT");
      return resume;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  hasUserMessageAfter(conversationId: string, seq: number): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND seq > ? AND role = 'user' LIMIT 1").get(conversationId, seq));
  }

  appendNativeMediaConfirmation(input: AppendMessageInput, state: import("./chat-tools/native-image.js").NativeMediaConfirmation) {
    const payload = JSON.stringify(state);
    if (payload.length > 2_000_000) throw new Error("当前对话内容过大，无法保存创作确认。请缩短对话后重试。");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const message = this.appendMessage(input);
      this.db.prepare("INSERT INTO native_image_confirmations (message_id, payload) VALUES (?, ?)").run(message.id, payload);
      this.db.exec("COMMIT");
      return message;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  interruptUnstartedAgentConfirmations(): void {
    const rows = this.db.prepare(`
      SELECT m.id, m.conversation_id FROM messages m
      JOIN agent_confirmation_decisions d ON d.message_id = m.id
      JOIN conversations c ON c.id = m.conversation_id
      WHERE d.decision = 'approve' AND m.status = 'pending'
        AND c.status IN ('running', 'awaiting_confirmation')
        AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.owner_conversation_id = c.id AND t.agent_operation_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM messages later WHERE later.conversation_id = c.id AND later.seq > m.seq)
    `).all() as DbRow[];
    for (const row of rows) {
      this.updateMessage(String(row.id), { status: "error", errorMessage: "确认后的操作被服务重启中断，请核对当前结果后再继续。" });
      this.clearNativeMediaConfirmation(String(row.id));
      this.conversations.setConversationStatus(String(row.conversation_id), "idle", { touch: false });
    }
  }

  /** 待确认的消息。用户发新消息时要把它们标成「已被取代」并让出 pending 状态 */
  listPendingMessages(conversationId: string): ChatMessage[] {
    const rows = this.db.prepare(
      "SELECT * FROM messages WHERE conversation_id = ? AND status = 'pending' ORDER BY seq ASC",
    ).all(conversationId) as DbRow[];
    return rows.map((row) => this.messageFromRow(row));
  }

  findTaskTimeoutMessage(conversationId: string, taskId: string): ChatMessage | null {
    const rows = this.db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND task_id = ? AND status = 'error' ORDER BY seq DESC").all(conversationId, taskId) as DbRow[];
    return rows.map(row => this.messageFromRow(row)).find(message => message.toolResult?.error === "VIDEO_TIMEOUT") ?? null;
  }

  /** Recover published local artifacts; unknown side effects remain interrupted and are never replayed. */
  private recoverNativeToolFiles(conversationId: string) {
    const rows = this.db.prepare("SELECT message_id, tool_name, call_id FROM native_tool_calls WHERE conversation_id = ? AND status = 'running' AND tool_name IN ('doc_create', 'doc_edit', 'doc_convert') ORDER BY rowid").all(conversationId) as DbRow[];
    for (const row of rows) {
      const messageId = String(row.message_id);
      const pageOperation = row.tool_name === "doc_edit" && /^ppt-page:[\da-f-]{36}:[a-f\d]{64}:\d{1,3}$/i.test(String(row.call_id));
      const file = this.documents.getWorkspaceDocumentByOperation(conversationId, pageOperation ? String(row.call_id) : messageId);
      if (!file || !/^[0-9a-f-]{36}$/i.test(conversationId)) continue;
      const root = path.resolve(file.baseDir || this.getDocumentsDir());
      const dir = path.resolve(root, conversationId);
      const full = path.resolve(dir, file.name);
      try {
        if (path.dirname(dir).toLowerCase() !== root.toLowerCase() || path.dirname(full).toLowerCase() !== dir.toLowerCase()) continue;
        if (fs.lstatSync(root).isSymbolicLink() || fs.lstatSync(dir).isSymbolicLink()) continue;
        const stat = fs.lstatSync(full);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== file.byteSize) continue;
      } catch { continue; }
      const summary = `已恢复中断前生成的文件 ${file.name}；请检查内容。`;
      const presentation = this.documents.getPresentationVersion(conversationId, file.id)?.report;
      this.finishNativeToolCall(conversationId, messageId, String(row.tool_name), { ok: true, summary, data: { workspaceFileId: file.id, workspaceFileName: file.name, byteSize: file.byteSize, pendingDelete: false, ...(presentation ? { presentation } : {}) } });
    }
  }

  private messageFromRow(row: DbRow): ChatMessage {
    return {
      id: String(row.id), conversationId: String(row.conversation_id), seq: Number(row.seq),
      role: String(row.role) as MessageRole,
      content: row.content == null ? null : String(row.content),
      plan: parseJson<AgentPlan | null>(row.plan_json, null),
      toolName: row.tool_name == null ? null : String(row.tool_name) as ChatMessage["toolName"],
      toolArgs: parseJson<Record<string, unknown> | null>(row.tool_args_json, null),
      toolResult: parseJson<ToolResult | null>(row.tool_result_json, null),
      confirm: parseJson<ConfirmPreview | null>(row.confirm_json, null),
      taskId: row.task_id == null ? null : String(row.task_id),
      assetId: row.asset_id == null ? null : String(row.asset_id),
      assetRefs: parseJson<string[]>(row.asset_refs, []),
      ...(row.video_frames_json ? { videoFrames: parseJson<ChatVideoFrames | undefined>(row.video_frames_json, undefined) } : {}),
      documents: parseJson<ChatDocumentRef[]>(row.documents_json, []),
      status: String(row.status) as MessageStatus,
      errorMessage: row.error_message == null ? null : String(row.error_message),
      createdAt: String(row.created_at),
    };
  }
}
