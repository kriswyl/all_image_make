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
  statusEndpoint: string;
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
  readonly filePath: string;
  readonly assetsDir: string;
  private readonly db: DatabaseSync;

  constructor(dataDir = path.resolve("data")) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.assetsDir = path.join(dataDir, "assets");
    fs.mkdirSync(this.assetsDir, { recursive: true });
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
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS diagnostics (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        request_json TEXT,
        response_json TEXT,
        http_status INTEGER,
        duration_ms INTEGER,
        created_at TEXT NOT NULL
      );
    `);
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
      input.statusEndpoint ?? "",
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

  listPendingTasks(): TaskRow[] {
    const rows = this.db.prepare("SELECT * FROM tasks WHERE status = 'running' AND remote_task_id IS NOT NULL").all() as DbRow[];
    return rows.map((row) => this.taskFromRow(row));
  }

  insertAsset(asset: { id: string; taskId: string; fileName: string; mimeType: string; byteSize: number; relativePath: string; sha256: string }) {
    this.db.prepare(`
      INSERT INTO assets (id, task_id, file_name, mime_type, byte_size, relative_path, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(asset.id, asset.taskId, asset.fileName, asset.mimeType, asset.byteSize, asset.relativePath, asset.sha256, now());
  }

  listAssets(taskId: string): AssetRow[] {
    const rows = this.db.prepare("SELECT * FROM assets WHERE task_id = ? ORDER BY created_at ASC").all(taskId) as DbRow[];
    return rows.map((row) => ({
      id: String(row.id), taskId: String(row.task_id), fileName: String(row.file_name), mimeType: String(row.mime_type),
      byteSize: Number(row.byte_size), relativePath: String(row.relative_path), sha256: String(row.sha256), createdAt: String(row.created_at),
    }));
  }

  insertDiagnostic(input: { taskId: string; request: unknown; response: unknown; httpStatus?: number | null; durationMs?: number | null }) {
    this.db.prepare(`
      INSERT INTO diagnostics (id, task_id, request_json, response_json, http_status, duration_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), input.taskId, JSON.stringify(input.request), JSON.stringify(input.response), input.httpStatus ?? null, input.durationMs ?? null, now());
  }

  listDiagnostics(taskId: string): Diagnostic[] {
    const rows = this.db.prepare("SELECT * FROM diagnostics WHERE task_id = ? ORDER BY created_at DESC").all(taskId) as DbRow[];
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
      status: task.status, progress: task.progress, remoteTaskId: task.remoteTaskId, effectiveParameters: parseJson(task.effectiveJson, null),
      attemptCount: task.attemptCount, errorCode: task.errorCode, errorMessage: task.errorMessage, assets: this.listAssets(task.id).map((asset) => ({
        id: asset.id, taskId: asset.taskId, fileName: asset.fileName, mimeType: asset.mimeType, byteSize: asset.byteSize,
        url: `/api/assets/${asset.id}/file`, createdAt: asset.createdAt,
      })), createdAt: task.createdAt, startedAt: task.startedAt, finishedAt: task.finishedAt,
    };
  }

  private channelFromRow(row: DbRow): DbChannel {
    return {
      id: String(row.id), name: String(row.name), baseUrl: String(row.base_url), adapterType: String(row.adapter_type) as AdapterType,
      authType: String(row.auth_type) as AuthType, authHeaderName: String(row.auth_header_name ?? ""), secretEnv: String(row.secret_env ?? ""),
      endpoint: String(row.endpoint ?? ""), statusEndpoint: String(row.status_endpoint ?? ""), models: parseJson(row.models_json, []),
      allowPrivateNetwork: Boolean(row.allow_private_network), enabled: Boolean(row.enabled), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  private taskFromRow(row: DbRow): TaskRow {
    return {
      id: String(row.id), channelId: String(row.channel_id), channelName: row.channel_name == null ? null : String(row.channel_name),
      model: String(row.model), prompt: String(row.prompt), status: String(row.status) as TaskStatus,
      progress: row.progress == null ? null : Number(row.progress), remoteTaskId: row.remote_task_id == null ? null : String(row.remote_task_id),
      inputJson: String(row.input_json), effectiveJson: row.effective_json == null ? null : String(row.effective_json), attemptCount: Number(row.attempt_count),
      errorCode: row.error_code == null ? null : String(row.error_code), errorMessage: row.error_message == null ? null : String(row.error_message),
      createdAt: String(row.created_at), startedAt: row.started_at == null ? null : String(row.started_at), finishedAt: row.finished_at == null ? null : String(row.finished_at),
    };
  }
}

export interface TaskRow {
  id: string; channelId: string; channelName: string | null; model: string; prompt: string; status: TaskStatus; progress: number | null;
  remoteTaskId: string | null; inputJson: string; effectiveJson: string | null; attemptCount: number; errorCode: string | null;
  errorMessage: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
}

export interface AssetRow {
  id: string; taskId: string; fileName: string; mimeType: string; byteSize: number; relativePath: string; sha256: string; createdAt: string;
}
