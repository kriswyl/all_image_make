import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { AdapterType, AuthType, Channel, ChannelInput, Diagnostic, Task, TaskStatus, Asset } from "../shared/types.js";

export interface DbChannel {
  id: string;
  name: string;
  baseUrl: string;
  adapterType: AdapterType;
  authType: AuthType;
  authHeaderName: string;
  secretEnv: string;
  endpoint: string;
  models: string[];
  allowPrivateNetwork: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

type DbRow = Record<string, string | number | null>;

function now() {
  return new Date().toISOString();
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class AppDatabase {
  readonly dataDir: string;
  readonly filePath: string;
  readonly inputsDir: string;
  /** 默认产物目录。用户改过素材目录后，历史记录里旧产物仍指向这个目录 */
  readonly defaultAssetsDir: string;
  private currentAssetsDir: string;
  private readonly db: DatabaseSync;

  /** 产物目录可以在运行时改，所以是 getter 而不是 readonly 字段 */
  get assetsDir(): string {
    return this.currentAssetsDir;
  }

  constructor(dataDir = path.resolve("data")) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.defaultAssetsDir = path.join(dataDir, "assets");
    this.inputsDir = path.join(dataDir, "inputs");
    fs.mkdirSync(this.defaultAssetsDir, { recursive: true });
    fs.mkdirSync(this.inputsDir, { recursive: true });
    this.filePath = path.join(dataDir, "app.db");
    this.db = new DatabaseSync(this.filePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        adapter_type TEXT NOT NULL,
        auth_type TEXT NOT NULL,
        auth_header_name TEXT NOT NULL DEFAULT '',
        secret_env TEXT NOT NULL DEFAULT '',
        endpoint TEXT NOT NULL DEFAULT '',
        status_endpoint TEXT NOT NULL DEFAULT '',
        models_json TEXT NOT NULL DEFAULT '[]',
        allow_private_network INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        progress REAL,
        remote_task_id TEXT,
        input_json TEXT NOT NULL,
        effective_json TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS tasks_created_idx ON tasks(created_at DESC);
      CREATE INDEX IF NOT EXISTS tasks_remote_idx ON tasks(channel_id, remote_task_id);
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        relative_path TEXT NOT NULL,
        base_dir TEXT NOT NULL DEFAULT '',
        sha256 TEXT NOT NULL,
        duration REAL,
        created_at TEXT NOT NULL
      );
      -- 列表里每个任务都要按 task_id 取产物，没有索引会退化成全表扫描
      CREATE INDEX IF NOT EXISTS assets_task_idx ON assets(task_id);
      CREATE TABLE IF NOT EXISTS diagnostics (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        request_json TEXT,
        response_json TEXT,
        http_status INTEGER,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // Migration: add duration column to assets if it doesn't exist
    const columnsResult = this.db.prepare("PRAGMA table_info(assets)").all() as Array<{name: string}>;
    const hasDuration = columnsResult.some((col) => col.name === "duration");
    if (!hasDuration) {
      this.db.exec("ALTER TABLE assets ADD COLUMN duration REAL");
    }
    // Migration: 每条产物记住自己所在的目录，用户改素材目录后旧历史仍然可读
    const hasBaseDir = columnsResult.some((col) => col.name === "base_dir");
    if (!hasBaseDir) {
      this.db.exec("ALTER TABLE assets ADD COLUMN base_dir TEXT NOT NULL DEFAULT ''");
    }
    // 新生成的记录自带 base_dir；加列前留下的行回填成默认目录
    this.db.prepare("UPDATE assets SET base_dir = ? WHERE base_dir = ''").run(this.defaultAssetsDir);

    this.currentAssetsDir = this.resolveAssetsDir();
    fs.mkdirSync(this.currentAssetsDir, { recursive: true });
  }

  /** 读取用户配置的产物目录；配置缺失或不可用时退回数据目录下的 assets/ */
  private resolveAssetsDir(): string {
    const stored = this.getSetting("assetsDir");
    if (!stored || !path.isAbsolute(stored)) return this.defaultAssetsDir;
    try {
      const resolved = path.resolve(stored);
      fs.mkdirSync(resolved, { recursive: true });
      return resolved;
    } catch {
      return this.defaultAssetsDir;
    }
  }

  /** 切换产物目录：只影响之后生成的产物，已落盘的文件留在原目录 */
  setAssetsDir(dir: string): string {
    if (!path.isAbsolute(dir)) throw new Error("素材目录必须是绝对路径");
    const resolved = path.resolve(dir);
    fs.mkdirSync(resolved, { recursive: true });
    if (resolved !== this.defaultAssetsDir && resolved.startsWith(this.dataDir + path.sep)) {
      throw new Error("自定义素材目录不能放在应用数据目录内部");
    }
    this.setSetting("assetsDir", resolved);
    this.currentAssetsDir = resolved;
    return resolved;
  }

  resetAssetsDir(): string {
    this.setSetting("assetsDir", "");
    this.currentAssetsDir = this.defaultAssetsDir;
    fs.mkdirSync(this.currentAssetsDir, { recursive: true });
    return this.currentAssetsDir;
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as DbRow | undefined;
    return row ? String(row.value) : null;
  }

  setSetting(key: string, value: string) {
    this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  close() {
    this.db.close();
  }

  listChannels(): DbChannel[] {
    const rows = this.db.prepare("SELECT * FROM channels ORDER BY created_at ASC").all() as DbRow[];
    return rows.map((row) => this.channelFromRow(row));
  }

  getChannel(id: string): DbChannel | null {
    const row = this.db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as DbRow | undefined;
    return row ? this.channelFromRow(row) : null;
  }

  saveChannel(input: ChannelInput, existingId?: string): DbChannel {
    const id = existingId ?? crypto.randomUUID();
    const createdAt = existingId ? this.getChannel(id)?.createdAt ?? now() : now();
    const updatedAt = now();
    const values = [
      id,
      input.name,
      input.baseUrl,
      input.adapterType,
      input.authType,
      input.authHeaderName ?? "",
      input.secretEnv ?? "",
      input.endpoint ?? "",
      "",
      JSON.stringify(input.models ?? []),
      input.allowPrivateNetwork ? 1 : 0,
      input.enabled === false ? 0 : 1,
      createdAt,
      updatedAt,
    ];
    this.db.prepare(`
      INSERT INTO channels
      (id, name, base_url, adapter_type, auth_type, auth_header_name, secret_env, endpoint, status_endpoint,
       models_json, allow_private_network, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, base_url=excluded.base_url, adapter_type=excluded.adapter_type,
        auth_type=excluded.auth_type, auth_header_name=excluded.auth_header_name, secret_env=excluded.secret_env,
        endpoint=excluded.endpoint, status_endpoint=excluded.status_endpoint, models_json=excluded.models_json,
        allow_private_network=excluded.allow_private_network, enabled=excluded.enabled, updated_at=excluded.updated_at
    `).run(...values);
    return this.getChannel(id)!;
  }

  deleteChannel(id: string) {
    this.db.prepare("DELETE FROM channels WHERE id = ?").run(id);
  }

  /**
   * 删除任务及其图片、诊断记录。
   *
   * `keepFiles` 为真时只删记录、不动磁盘：产物文件留在各自目录里，
   * 参考图留在 inputs/，返回给调用方的待删列表为空。
   */
  deleteTask(id: string, options: { keepFiles?: boolean } = {}): { assets: StoredFileRef[]; inputs: string[] } {
    const assets = this.listAssets(id).map((asset) => ({ baseDir: asset.baseDir, relativePath: asset.relativePath }));
    const inputs = this.collectInputImagePaths(id);
    this.db.prepare("DELETE FROM diagnostics WHERE task_id = ?").run(id);
    this.db.prepare("DELETE FROM assets WHERE task_id = ?").run(id);
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    if (options.keepFiles) return { assets: [], inputs: [] };
    return { assets, inputs };
  }

  /** 批量删除：清空历史走这条，避免前端逐条发请求 */
  deleteTasks(ids: string[], options: { keepFiles?: boolean } = {}): { deleted: string[]; assets: StoredFileRef[]; inputs: string[] } {
    const assets: StoredFileRef[] = [];
    const inputs: string[] = [];
    const deleted: string[] = [];
    for (const id of ids) {
      if (!this.getTaskRow(id)) continue;
      const removed = this.deleteTask(id, options);
      assets.push(...removed.assets);
      inputs.push(...removed.inputs);
      deleted.push(id);
    }
    return { deleted, assets, inputs };
  }

  /** 供清空历史按「图片 / 视频 / 全部」筛选：渠道适配器优先，渠道已删则看产物类型 */
  isVideoTaskRow(row: TaskRow, adapterByChannel: Map<string, string>): boolean {
    const adapterType = adapterByChannel.get(row.channelId);
    if (adapterType) return adapterType.endsWith("-video");
    return this.listAssets(row.id).some((asset) => asset.mimeType.startsWith("video/"));
  }

  private collectInputImagePaths(id: string): string[] {
    const row = this.db.prepare("SELECT input_json FROM tasks WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) return [];
    const input = parseJson<{ referenceImages?: Array<{ relativePath?: string }>; referenceImage?: { relativePath?: string } }>(row.input_json, {});
    const stored = input.referenceImages?.length ? input.referenceImages : input.referenceImage ? [input.referenceImage] : [];
    return stored.map((item) => item?.relativePath).filter((value): value is string => typeof value === "string");
  }

  createTask(input: { id: string; channelId: string; model: string; prompt: string; input: unknown }): TaskRow {
    const createdAt = now();
    this.db.prepare(`
      INSERT INTO tasks (id, channel_id, model, prompt, status, input_json, created_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?)
    `).run(input.id, input.channelId, input.model, input.prompt, JSON.stringify(input.input), createdAt);
    return this.getTaskRow(input.id)!;
  }

  getTaskRow(id: string): TaskRow | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow | undefined;
    return row ? this.taskFromRow(row) : null;
  }

  listTaskRows(limit = 40): TaskRow[] {
    const rows = this.db.prepare(`
      SELECT tasks.*, COALESCE(channels.name, '已删除渠道') AS channel_name
      FROM tasks LEFT JOIN channels ON channels.id = tasks.channel_id
      ORDER BY tasks.created_at DESC LIMIT ?
    `).all(limit) as DbRow[];
    return rows.map((row) => this.taskFromRow(row));
  }

  /** 清空历史要把整个表过一遍，不受列表分页限制 */
  listAllTaskRows(): TaskRow[] {
    const rows = this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as DbRow[];
    return rows.map((row) => this.taskFromRow(row));
  }

  updateTask(id: string, patch: Partial<Pick<TaskRow, "status" | "progress" | "remoteTaskId" | "effectiveJson" | "attemptCount" | "errorCode" | "errorMessage" | "startedAt" | "finishedAt">>) {
    const fields: string[] = [];
    const values: Array<string | number | bigint | null | Uint8Array> = [];
    const mapping: Record<string, string> = {
      status: "status",
      progress: "progress",
      remoteTaskId: "remote_task_id",
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

  insertAsset(asset: { id: string; taskId: string; fileName: string; mimeType: string; byteSize: number; relativePath: string; baseDir: string; sha256: string; duration?: number | null }) {
    this.db.prepare(`
      INSERT INTO assets (id, task_id, file_name, mime_type, byte_size, relative_path, base_dir, sha256, duration, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(asset.id, asset.taskId, asset.fileName, asset.mimeType, asset.byteSize, asset.relativePath, asset.baseDir, asset.sha256, asset.duration ?? null, now());
  }

  listAssets(taskId: string): AssetRow[] {
    const rows = this.db.prepare("SELECT * FROM assets WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as DbRow[];
    return rows.map((row) => this.assetFromRow(row));
  }

  /** 按主键取单个产物：媒体请求（每个缩略图一次）用它，别走 listTaskRows */
  getAsset(id: string): AssetRow | null {
    const row = this.db.prepare("SELECT * FROM assets WHERE id = ?").get(id) as DbRow | undefined;
    return row ? this.assetFromRow(row) : null;
  }

  private assetFromRow(row: DbRow): AssetRow {
    return {
      id: String(row.id), taskId: String(row.task_id), fileName: String(row.file_name), mimeType: String(row.mime_type),
      byteSize: Number(row.byte_size), relativePath: String(row.relative_path),
      baseDir: row.base_dir == null || row.base_dir === "" ? this.defaultAssetsDir : String(row.base_dir),
      sha256: String(row.sha256),
      duration: row.duration == null ? null : Number(row.duration), createdAt: String(row.created_at),
    };
  }

  insertDiagnostic(input: { taskId: string; request: unknown; response: unknown; httpStatus?: number | null; durationMs?: number | null }) {
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

  getTaskView(id: string): Task | null {
    const row = this.db.prepare(`
      SELECT tasks.*, COALESCE(channels.name, '已删除渠道') AS channel_name
      FROM tasks LEFT JOIN channels ON channels.id = tasks.channel_id WHERE tasks.id = ?
    `).get(id) as DbRow | undefined;
    if (!row) return null;
    const task = this.taskFromRow(row);
    return this.taskView(task);
  }

  listTaskViews(limit = 40): Task[] {
    return this.listTaskRows(limit).map((task) => this.taskView(task));
  }

  private taskView(task: TaskRow): Task {
    return {
      id: task.id, channelId: task.channelId, channelName: task.channelName ?? "已删除渠道", model: task.model, prompt: task.prompt,
      status: task.status, progress: task.progress, effectiveParameters: parseJson(task.effectiveJson, null),
      attemptCount: task.attemptCount, errorCode: task.errorCode, errorMessage: task.errorMessage, assets: this.listAssets(task.id).map((asset) => ({
        id: asset.id, taskId: asset.taskId, fileName: asset.fileName, mimeType: asset.mimeType, byteSize: asset.byteSize,
        url: `/api/assets/${asset.id}/file`, duration: asset.duration, createdAt: asset.createdAt,
      })), createdAt: task.createdAt, startedAt: task.startedAt, finishedAt: task.finishedAt,
    };
  }

  private channelFromRow(row: DbRow): DbChannel {
    return {
      id: String(row.id), name: String(row.name), baseUrl: String(row.base_url), adapterType: String(row.adapter_type) as AdapterType,
      authType: String(row.auth_type) as AuthType, authHeaderName: String(row.auth_header_name ?? ""), secretEnv: String(row.secret_env ?? ""),
      endpoint: String(row.endpoint ?? ""), models: parseJson(row.models_json, []),
      allowPrivateNetwork: Boolean(row.allow_private_network), enabled: Boolean(row.enabled), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  private taskFromRow(row: DbRow): TaskRow {
    return {
      id: String(row.id), channelId: String(row.channel_id), channelName: row.channel_name == null ? null : String(row.channel_name),
      model: String(row.model), prompt: String(row.prompt), status: String(row.status) as TaskStatus,
      progress: row.progress == null ? null : Number(row.progress),
      remoteTaskId: row.remote_task_id == null ? null : String(row.remote_task_id),
      inputJson: String(row.input_json), effectiveJson: row.effective_json == null ? null : String(row.effective_json), attemptCount: Number(row.attempt_count),
      errorCode: row.error_code == null ? null : String(row.error_code), errorMessage: row.error_message == null ? null : String(row.error_message),
      createdAt: String(row.created_at), startedAt: row.started_at == null ? null : String(row.started_at), finishedAt: row.finished_at == null ? null : String(row.finished_at),
    };
  }
}

export interface TaskRow {
  id: string; channelId: string; channelName: string | null; model: string; prompt: string; status: TaskStatus; progress: number | null;
  /** 上游异步任务 id：重启后用它接着轮询，不用从头发起 */
  remoteTaskId: string | null;
  inputJson: string; effectiveJson: string | null; attemptCount: number; errorCode: string | null;
  errorMessage: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
}

export interface AssetRow {
  id: string; taskId: string; fileName: string; mimeType: string; byteSize: number; relativePath: string;
  /** 该产物所在目录：用户换过素材目录后，老记录仍指向写入时的目录 */
  baseDir: string;
  sha256: string; duration: number | null; createdAt: string;
}

/** 待清理的落盘文件：目录随记录走，不能用当前素材目录去猜 */
export interface StoredFileRef {
  baseDir: string;
  relativePath: string;
}
