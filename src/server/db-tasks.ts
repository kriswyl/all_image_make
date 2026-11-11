import type { DatabaseSync } from "node:sqlite";
import type { AdapterType, Diagnostic, Task, TaskKind, TaskStatus } from "../shared/types.js";
import { AUDIO_ADAPTER_TYPES, VIDEO_ADAPTER_TYPES, taskKindFor } from "../shared/kinds.js";
import { summarizeTaskInput } from "../shared/video-snapshot.js";
import { auditParameters } from "./diagnose.js";
import type { AssetRepository } from "./db-assets.js";
import { now, parseJson, type DbRow } from "./db-row.js";

/**
 * `generate` = 走 runner 的真实生成；`upload` = 用户在对话框里自己传的图（需求.md 问题 4）。
 * 后者只是为了给 `assets.task_id` 找个可指的主键，**不是**一次生成，
 * 所以历史列表、清空历史、诊断入口都按 `generate` 过滤。
 */
export type TaskOrigin = "generate" | "upload";
export type TaskLibraryScope = "public" | "conversation" | "legacy";

export interface TaskRow {
  id: string; channelId: string; channelName: string | null;
  /** 渠道适配器，参数核对要用它选映射表；`SELECT *` 那种查询拿不到，所以可空 */
  channelAdapterType: AdapterType | null;
  model: string; prompt: string; status: TaskStatus; progress: number | null;
  /** 上游异步任务 id：重启后用它接着轮询，不用从头发起 */
  remoteTaskId: string | null;
  remotePollAfter: number | null;
  /** 上游附加元数据 JSON（Midjourney 按钮等） */
  remoteMeta: string | null;
  inputJson: string; effectiveJson: string | null; attemptCount: number; errorCode: string | null;
  errorMessage: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
  origin: TaskOrigin;
  libraryScope: TaskLibraryScope;
  ownerConversationId: string | null;
  agentOperationId: string | null;
}

export type CreateTaskInput = {
  id: string; channelId: string; model: string; prompt: string; input: unknown;
  /** 默认就是一次正常生成；上传素材那条传 `"upload"` */
  origin?: TaskOrigin;
  libraryScope?: "public" | "conversation";
  ownerConversationId?: string;
  agentOperationId?: string;
  /** 上传的图生下来就是完成的，没有排队这一步 */
  status?: TaskStatus;
};

export type TaskPatch = Partial<Pick<TaskRow, "status" | "progress" | "remoteTaskId" | "remotePollAfter" | "remoteMeta" | "effectiveJson" | "attemptCount" | "errorCode" | "errorMessage" | "startedAt" | "finishedAt">>;

export type InsertDiagnosticInput = { taskId: string; request: unknown; response: unknown; httpStatus?: number | null; durationMs?: number | null };

export type LibraryTaskQuery = { limit: number; offset: number; query: string; kind: "all" | "image" | "video" | "audio"; mode: "all" | "assets" | "records"; includeChatImages?: boolean };

export class TaskRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly assets: Pick<AssetRepository, "listAssets" | "assetView">,
  ) {}

  /** 任务品类：和前后端共用同一份规则，避免「历史页和清空接口各判各的」 */
  taskKindRow(row: TaskRow, adapterByChannel: Map<string, string>): TaskKind {
    return taskKindFor(
      adapterByChannel.get(row.channelId),
      this.assets.listAssets(row.id).map((asset) => asset.mimeType),
    );
  }

  createTask(input: CreateTaskInput): TaskRow {
    const createdAt = now();
    this.db.prepare(`
      INSERT INTO tasks (id, channel_id, model, prompt, status, input_json, created_at, origin, library_scope, owner_conversation_id, agent_operation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.channelId, input.model, input.prompt,
      input.status ?? "queued", JSON.stringify(input.input), createdAt, input.origin ?? "generate", input.libraryScope ?? (input.origin === "upload" ? "legacy" : "public"), input.ownerConversationId ?? null, input.agentOperationId ?? null,
    );
    return this.getTaskRow(input.id)!;
  }

  getTaskRow(id: string): TaskRow | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow | undefined;
    return row ? this.taskFromRow(row) : null;
  }

  taskHasConversationReferences(taskId: string): boolean {
    const assetIds = this.assets.listAssets(taskId).map((asset) => asset.id);
    const direct = this.db.prepare(`SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.kind = 'chat' AND m.task_id = ? LIMIT 1`).get(taskId);
    if (direct) return true;
    for (const assetId of assetIds) {
      if (this.db.prepare(`SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.kind = 'chat' AND (m.asset_id = ? OR m.asset_refs LIKE ?) LIMIT 1`).get(assetId, `%${assetId}%`)) return true;
      if (this.db.prepare(`SELECT 1 FROM conversations WHERE kind = 'chat' AND (current_asset_id = ? OR canvas_asset_ids LIKE ? OR storyboard_reference_asset_id = ?) LIMIT 1`).get(assetId, `%${assetId}%`, assetId)) return true;
      if (this.db.prepare(`SELECT 1 FROM conversation_shots WHERE first_frame_asset_id = ? OR last_frame_asset_id = ? OR reference_asset_ids LIKE ? OR task_id = ? OR video_task_id = ? OR voice_task_id = ? LIMIT 1`).get(assetId, assetId, `%${assetId}%`, taskId, taskId, taskId)) return true;
      if (this.db.prepare(`SELECT 1 FROM conversation_characters WHERE asset_id = ? OR task_id = ? UNION ALL SELECT 1 FROM conversation_scenes WHERE asset_id = ? OR task_id = ? LIMIT 1`).get(assetId, taskId, assetId, taskId)) return true;
    }
    return false;
  }

  listTaskRows(limit = 40): TaskRow[] {
    const rows = this.db.prepare(`
      SELECT tasks.*, COALESCE(channels.name, '已删除渠道') AS channel_name,
             channels.adapter_type AS channel_adapter_type
      FROM tasks LEFT JOIN channels ON channels.id = tasks.channel_id
      WHERE tasks.origin = 'generate'
      ORDER BY tasks.created_at DESC LIMIT ?
    `).all(limit) as DbRow[];
    return rows.map((row) => this.taskFromRow(row));
  }

  /** 清空历史要把整个表过一遍，不受列表分页限制。上传素材不算历史，跟着会话一起走 */
  listAllTaskRows(): TaskRow[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE origin = 'generate' ORDER BY created_at DESC").all() as DbRow[];
    return rows.map((row) => this.taskFromRow(row));
  }

  updateTask(id: string, patch: TaskPatch) {
    const fields: string[] = [];
    const values: Array<string | number | bigint | null | Uint8Array> = [];
    const mapping: Record<string, string> = {
      status: "status",
      progress: "progress",
      remoteTaskId: "remote_task_id",
      remotePollAfter: "remote_poll_after",
      remoteMeta: "remote_meta",
      effectiveJson: "effective_json",
      attemptCount: "attempt_count",
      errorCode: "error_code",
      errorMessage: "error_message",
      startedAt: "started_at",
      finishedAt: "finished_at",
    };
    for (const [key, column] of Object.entries(mapping)) {
      if (!(key in patch)) continue;
      fields.push(`${column} = ?`);
      const value = (patch as Record<string, unknown>)[key] ?? null;
      values.push(typeof value === "string" || typeof value === "number" || typeof value === "bigint" || value instanceof Uint8Array || value === null ? value : String(value));
    }
    if (!fields.length) return;
    values.push(id);
    this.db.prepare(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  /** 进程重启后仍停留在进行中状态的任务，需要被标记为失败 */
  listPendingTasks(): TaskRow[] {
    const rows = this.db.prepare(
      "SELECT * FROM tasks WHERE status IN ('queued', 'validating', 'submitting', 'running')",
    ).all() as DbRow[];
    return rows.map((row) => this.taskFromRow(row));
  }

  insertDiagnostic(input: InsertDiagnosticInput) {
    this.db.prepare(`
      INSERT INTO diagnostics (id, task_id, request_json, response_json, http_status, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), input.taskId, JSON.stringify(input.request), JSON.stringify(input.response), input.httpStatus ?? null, input.durationMs ?? null, now());
  }

  listDiagnostics(taskId: string): Diagnostic[] {
    // created_at 只到毫秒，一次轮询的「上一条精简行 + 本次完整行」常落在同一毫秒，
    // 必须再用 rowid 兜底，否则诊断列表顺序会随机颠倒
    const rows = this.db.prepare("SELECT * FROM diagnostics WHERE task_id = ? ORDER BY created_at DESC, rowid DESC").all(taskId) as DbRow[];
    return rows.map((row) => ({
      id: String(row.id), taskId: String(row.task_id), request: parseJson(row.request_json, null), response: parseJson(row.response_json, null),
      httpStatus: row.http_status == null ? null : Number(row.http_status), durationMs: row.duration_ms == null ? null : Number(row.duration_ms), createdAt: String(row.created_at),
    }));
  }

  listUnlinkedAgentTasks(): TaskRow[] {
    const rows = this.db.prepare(`
      SELECT t.* FROM tasks t
      JOIN messages op ON op.id = t.agent_operation_id AND op.conversation_id = t.owner_conversation_id
      JOIN conversations c ON c.id = op.conversation_id
      WHERE c.status = 'running' AND op.tool_name IS NOT NULL AND op.confirm_json IS NULL
        AND op.status IN ('ok', 'pending')
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.task_id = t.id AND m.conversation_id = c.id)
        AND t.rowid = (
          SELECT MAX(other.rowid) FROM tasks other
          WHERE other.owner_conversation_id = c.id AND other.agent_operation_id = op.id
        )
    `).all() as DbRow[];
    return rows.map(row => this.taskFromRow(row));
  }

  getTaskView(id: string): Task | null {
    const row = this.db.prepare(`
      SELECT tasks.*, COALESCE(channels.name, '已删除渠道') AS channel_name,
             channels.adapter_type AS channel_adapter_type
      FROM tasks LEFT JOIN channels ON channels.id = tasks.channel_id WHERE tasks.id = ?
    `).get(id) as DbRow | undefined;
    if (!row) return null;
    const task = this.taskFromRow(row);
    return this.taskView(task);
  }

  listTaskViews(limit = 40): Task[] {
    return this.listTaskRows(limit).map((task) => this.taskView(task));
  }

  listLibraryTaskViews(options?: LibraryTaskQuery): Task[] {
    const videoTypes = VIDEO_ADAPTER_TYPES.map((value) => `'${value}'`).join(",");
    const audioTypes = AUDIO_ADAPTER_TYPES.map((value) => `'${value}'`).join(",");
    const kindSql = `(CASE WHEN channels.adapter_type IN (${videoTypes}) THEN 'video' WHEN channels.adapter_type IN (${audioTypes}) THEN 'audio' WHEN channels.adapter_type IS NOT NULL THEN 'image' WHEN EXISTS (SELECT 1 FROM assets k WHERE k.task_id = tasks.id AND k.mime_type LIKE 'audio/%') THEN 'audio' WHEN EXISTS (SELECT 1 FROM assets k WHERE k.task_id = tasks.id AND k.mime_type LIKE 'video/%') THEN 'video' ELSE 'image' END)`;
    const query = options?.query.trim().toLowerCase() ?? "";
    const hasChatMessage = `EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN assets a ON a.id = m.asset_id WHERE c.kind = 'chat' AND (m.task_id = tasks.id OR a.task_id = tasks.id))`;
    const chatImage = options?.includeChatImages ? `(tasks.origin = 'generate' AND ${kindSql} = 'image' AND (
      (tasks.library_scope = 'conversation' AND tasks.owner_conversation_id IS NOT NULL)
      OR (tasks.library_scope = 'legacy' AND ${hasChatMessage})
    ))` : "0";
    const rows = this.db.prepare(`
      SELECT tasks.*, COALESCE(channels.name, '已删除渠道') AS channel_name,
             channels.adapter_type AS channel_adapter_type, CASE WHEN ${chatImage} THEN 'chat' END AS history_source
      FROM tasks LEFT JOIN channels ON channels.id = tasks.channel_id
      WHERE (tasks.library_scope = 'public' OR ${chatImage} OR (tasks.library_scope = 'legacy' AND (
        EXISTS (SELECT 1 FROM board_tasks bt WHERE bt.task_id = tasks.id)
        OR EXISTS (SELECT 1 FROM assets a JOIN board_assets ba ON ba.asset_id = a.id WHERE a.task_id = tasks.id)
        OR (tasks.origin = 'upload' AND tasks.prompt = '无限画布上传')
        OR (tasks.origin = 'generate'
          AND NOT ${hasChatMessage}
          AND NOT EXISTS (SELECT 1 FROM conversation_shots s WHERE s.task_id = tasks.id OR s.video_task_id = tasks.id OR s.voice_task_id = tasks.id)
          AND NOT EXISTS (SELECT 1 FROM conversation_characters c WHERE c.task_id = tasks.id OR c.asset_id IN (SELECT id FROM assets WHERE task_id = tasks.id))
          AND NOT EXISTS (SELECT 1 FROM conversation_scenes s WHERE s.task_id = tasks.id OR s.asset_id IN (SELECT id FROM assets WHERE task_id = tasks.id))
        )
      )))
      AND (? = 'all' OR ${kindSql} = ?)
      AND (? <> 'records' OR tasks.origin = 'generate')
      AND (? <> 'assets' OR EXISTS (SELECT 1 FROM assets a WHERE a.task_id = tasks.id))
      AND (? = '' OR instr(lower(tasks.prompt || ' ' || tasks.model || ' ' || COALESCE(channels.name, '')), ?) > 0 OR EXISTS (SELECT 1 FROM assets a WHERE a.task_id = tasks.id AND instr(lower(a.file_name || ' ' || a.title), ?) > 0))
      ORDER BY tasks.created_at DESC, tasks.id DESC LIMIT ? OFFSET ?
    `).all(options?.kind ?? "all", options?.kind ?? "all", options?.mode ?? "all", options?.mode ?? "all", query, query, query, options?.limit ?? -1, options?.offset ?? 0) as DbRow[];
    return rows.map(row => ({ ...this.taskView(this.taskFromRow(row)), ...(row.history_source === "chat" ? { historySource: "chat" as const } : {}) }));
  }

  collectInputImagePaths(id: string): string[] {
    const row = this.db.prepare("SELECT input_json FROM tasks WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) return [];
    const input = parseJson<{
      referenceImages?: Array<{ relativePath?: string }>;
      referenceImage?: { relativePath?: string };
      maskImage?: { relativePath?: string };
      referenceVideo?: { relativePath?: string };
      referenceVideos?: Array<{ relativePath?: string }>;
      referenceAudio?: { relativePath?: string };
      referenceAudios?: Array<{ relativePath?: string }>;
    }>(row.input_json, {});
    const stored = input.referenceImages?.length ? input.referenceImages : input.referenceImage ? [input.referenceImage] : [];
    // 局部重绘蒙版和参考图一样落在 inputs/，删任务时要一起收走
    if (input.maskImage) stored.push(input.maskImage);
    if (input.referenceVideo) stored.push(input.referenceVideo);
    if (input.referenceAudio) stored.push(input.referenceAudio);
    stored.push(...(input.referenceVideos ?? []), ...(input.referenceAudios ?? []));
    return [...new Set(stored.map((item) => item?.relativePath).filter((value): value is string => typeof value === "string"))];
  }

  private taskView(task: TaskRow): Task {
    // 工作台也要「看得见」（需求.md 问题 1 D）：核对用的是任务自己落库的两份原料——
    // input_json 是请求时写的，effective_json 是**发送前**就存下的脱敏请求体。
    // 适配器认不出来（渠道已删除、上传素材的空 channel_id）就不硬猜，如实不给这一项。
    const parameterNotes = task.channelAdapterType
      ? auditParameters(task.channelAdapterType, parseJson<Record<string, unknown>>(task.inputJson, {}), parseJson<Record<string, unknown> | null>(task.effectiveJson, null))
      : [];
    return {
      id: task.id, origin: task.origin, channelId: task.channelId, channelName: task.channelName ?? "已删除渠道", model: task.model, prompt: task.prompt,
      status: task.status, progress: task.progress, effectiveParameters: parseJson(task.effectiveJson, null),
      // 脱敏参数快照：界面展示「本次参数」与「复用参数」都用它，原始 input 里的
      // base64 图片不会跟着列表一起回传。
      inputParameters: summarizeTaskInput(parseJson<Record<string, unknown>>(task.inputJson, {})),
      ...(parameterNotes.length ? { parameterNotes } : {}),
      attemptCount: task.attemptCount, errorCode: task.errorCode, errorMessage: task.errorMessage,
      ...(task.remoteMeta ? { remoteMeta: parseJson<NonNullable<Task["remoteMeta"]>>(task.remoteMeta, {}) } : {}),
      assets: this.assets.listAssets(task.id).map((asset) => this.assets.assetView(asset)),
      createdAt: task.createdAt, startedAt: task.startedAt, finishedAt: task.finishedAt,
    };
  }

  private taskFromRow(row: DbRow): TaskRow {
    return {
      id: String(row.id), channelId: String(row.channel_id), channelName: row.channel_name == null ? null : String(row.channel_name),
      channelAdapterType: row.channel_adapter_type == null ? null : String(row.channel_adapter_type) as AdapterType,
      model: String(row.model), prompt: String(row.prompt), status: String(row.status) as TaskStatus,
      progress: row.progress == null ? null : Number(row.progress),
      remoteTaskId: row.remote_task_id == null ? null : String(row.remote_task_id),
      remotePollAfter: row.remote_poll_after == null ? null : Number(row.remote_poll_after),
      remoteMeta: row.remote_meta == null ? null : String(row.remote_meta),
      inputJson: String(row.input_json), effectiveJson: row.effective_json == null ? null : String(row.effective_json), attemptCount: Number(row.attempt_count),
      errorCode: row.error_code == null ? null : String(row.error_code), errorMessage: row.error_message == null ? null : String(row.error_message),
      createdAt: String(row.created_at), startedAt: row.started_at == null ? null : String(row.started_at), finishedAt: row.finished_at == null ? null : String(row.finished_at),
      origin: (row.origin == null ? "generate" : String(row.origin)) as TaskOrigin,
      libraryScope: (row.library_scope == null ? "legacy" : String(row.library_scope)) as TaskLibraryScope,
      ownerConversationId: row.owner_conversation_id == null ? null : String(row.owner_conversation_id),
      agentOperationId: row.agent_operation_id == null ? null : String(row.agent_operation_id),
    };
  }
}
