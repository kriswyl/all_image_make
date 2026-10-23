import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { AdapterType, AuthType, Channel, ChannelInput, Diagnostic, Task, TaskStatus, Asset, TaskKind } from "../shared/types.js";
import { isAudioAsset, isImageAsset } from "../shared/types.js";
import { taskKindFor } from "../shared/kinds.js";
// 参数核对（需求.md 问题 1）：纯函数、无 IO、不碰 db，所以放在这里不构成环
import { auditParameters } from "./diagnose.js";
import type {
  AgentPlan, ChatDocumentRef, ConfirmPreview, ChatMessage, Conversation, ConversationPatch,
  ConversationStatus, ConversationUsage, MessageRole, MessageStatus, ToolResult, VideoConfirmPolicy,
} from "../shared/agent-types.js";
import type { StoryboardShot, StoryboardShotKind, StoryboardShotStatus } from "../shared/storyboard.js";

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

/** 会话产物的来源：正常生成、用户上传，或分镜面板直接提交 */
export type ConversationAssetSource = TaskOrigin | "storyboard";

export interface StoredDocument {
  id: string;
  conversationId: string;
  fileName: string;
  content: string;
  charCount: number;
  createdAt: string;
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

/**
 * 画布列 → `string[]`。这一列有三种"不是正常数组"的可能：NULL（加列之前就存在、又没被回填到的老行）、
 * 坏 JSON、以及被人手工改成别的形状。三种都当成**空画布**——一行坏数据不该让会话列表或大脑上下文炸掉。
 */
function canvasIdsFromRow(value: unknown): string[] {
  const parsed = parseJson<unknown>(value, []);
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
}

export class AppDatabase {
  readonly dataDir: string;
  readonly filePath: string;
  readonly inputsDir: string;
  /**
   * 缩略图目录（AGENT_PLAN.md §11.4）。
   *
   * 刻意放在数据目录而不是可配置的素材目录：缩略图是派生数据不是产物，
   * 用户改了素材目录后它跟着跑没有意义，而且历史产物跨目录读取时反而会失效。
   */
  readonly thumbsDir: string;
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
    this.thumbsDir = path.join(dataDir, "thumbs");
    fs.mkdirSync(this.defaultAssetsDir, { recursive: true });
    fs.mkdirSync(this.inputsDir, { recursive: true });
    fs.mkdirSync(this.thumbsDir, { recursive: true });
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
        remote_meta TEXT NOT NULL DEFAULT '',
        input_json TEXT NOT NULL,
        effective_json TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        -- 'generate' 是正常生成；'upload' 是用户在对话框里自己传的图（需求.md 问题 4），
        -- 它借这条表占一个 task_id 给 assets 指，但**不是**一次生成
        origin TEXT NOT NULL DEFAULT 'generate'
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
        -- 音乐产物的歌名 / 歌词 / 曲风 / Suno custom_id；图片/视频为空
        title TEXT NOT NULL DEFAULT '',
        lyrics TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '',
        remote_clip_id TEXT NOT NULL DEFAULT '',
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
      -- 对话式 Agent（AGENT_PLAN.md §5）。产物不复制，靠 task_id / asset_id 指向现有表
      CREATE TABLE IF NOT EXISTS conversations (
        id                   TEXT PRIMARY KEY,
        title                TEXT NOT NULL,
        brain_channel_id     TEXT NOT NULL,
        brain_model          TEXT NOT NULL,
        -- 已废弃：老版本的单图画布指针。只被下面那次回填读一次，新代码不读也不写。
        -- 留着这列的另一个原因：回填要 SELECT 它，从建表语句里删掉的话，新库上跑回填会直接 no such column
        current_asset_id     TEXT,
        -- 画布：有序产物 id 的 JSON 数组（[0] 是主图，上限见 MAX_CANVAS_IMAGES）。
        -- NULL 是「还没迁移过」（只可能出现在加列之前就存在的老会话上），'[]' 才是「画布是空的」
        canvas_asset_ids     TEXT,
        status               TEXT NOT NULL DEFAULT 'idle',
        video_confirm_policy TEXT NOT NULL DEFAULT 'auto_only',
        vision_enabled       INTEGER NOT NULL DEFAULT 1,
        verbatim_prompt      INTEGER NOT NULL DEFAULT 0,
        -- 分镜的角色参考：auto = 用第一个已完成的图片镜头；manual = 指定产物；off = 不用
        storyboard_reference_asset_id TEXT,
        storyboard_reference_mode     TEXT NOT NULL DEFAULT 'auto',
        auto_continue_count  INTEGER NOT NULL DEFAULT 0,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT NOT NULL,
        seq              INTEGER NOT NULL,
        role             TEXT NOT NULL,
        content          TEXT,
        plan_json        TEXT,
        tool_name        TEXT,
        tool_args_json   TEXT,
        tool_result_json TEXT,
        confirm_json     TEXT,
        task_id          TEXT,
        asset_id         TEXT,
        -- 这条消息附带的脚本文档（[{id,name,charCount}]）；全文存在 conversation_documents 里
        documents_json   TEXT,
        status           TEXT NOT NULL DEFAULT 'ok',
        error_message    TEXT,
        created_at       TEXT NOT NULL
      );
      -- 用户上传的脚本文档。全文只在这一轮喂给大脑，后续靠分镜表的 source_text 回溯
      CREATE TABLE IF NOT EXISTS conversation_documents (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT NOT NULL,
        file_name        TEXT NOT NULL,
        content          TEXT NOT NULL,
        char_count       INTEGER NOT NULL,
        created_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_documents_conv_idx
        ON conversation_documents(conversation_id, created_at);
      -- 会话内分镜表：一个会话一张，镜号从 1 开始。
      -- task_id 只指向**最近一次**生成；重跑会覆盖它，旧产物仍在生成历史里
      CREATE TABLE IF NOT EXISTS conversation_shots (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT NOT NULL,
        shot_index       INTEGER NOT NULL,
        source_text      TEXT NOT NULL DEFAULT '',
        prompt           TEXT NOT NULL DEFAULT '',
        -- 出场角色名；空串 = 空镜 / 道具 / 字幕，不带角色参考
        character_name   TEXT NOT NULL DEFAULT '',
        kind             TEXT NOT NULL DEFAULT 'image',
        aspect_ratio     TEXT NOT NULL DEFAULT '',
        task_id          TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_shots_conv_idx
        ON conversation_shots(conversation_id, shot_index);
      -- 分镜里的角色和各自绑定的参考图。名字由助手标注或用户手动输入
      CREATE TABLE IF NOT EXISTS conversation_characters (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT NOT NULL,
        name             TEXT NOT NULL,
        asset_id         TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        UNIQUE(conversation_id, name)
      );
      CREATE INDEX IF NOT EXISTS conversation_characters_conv_idx
        ON conversation_characters(conversation_id, name);
      CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages(conversation_id, seq);
      CREATE INDEX IF NOT EXISTS messages_task_idx ON messages(task_id);
      CREATE INDEX IF NOT EXISTS conversations_updated_idx ON conversations(updated_at DESC);
      -- 一次大脑调用的 token 用量。单独一张表而不是塞进 messages：
      -- 解析重试、身份纠正这些「同一个消息对应的额外调用」也要算进账里，
      -- 挂在消息上反而得在一堆执行路径里手动累加。
      CREATE TABLE IF NOT EXISTS brain_calls (
        id                TEXT PRIMARY KEY,
        conversation_id   TEXT NOT NULL,
        prompt_tokens     INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        reasoning_tokens  INTEGER NOT NULL,
        created_at        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS brain_calls_conv_idx ON brain_calls(conversation_id, created_at);
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
    // Migration: 看图改（AGENT_PLAN.md §11）用的缩略图。存的是相对 thumbs/ 的文件名，
    // 不是绝对路径——数据目录被搬走时它跟着走
    const hasThumbPath = columnsResult.some((col) => col.name === "thumb_path");
    if (!hasThumbPath) {
      this.db.exec("ALTER TABLE assets ADD COLUMN thumb_path TEXT NOT NULL DEFAULT ''");
    }
    // 音乐产物的歌名；老行默认空串，不影响图片/视频
    if (!columnsResult.some((col) => col.name === "title")) {
      this.db.exec("ALTER TABLE assets ADD COLUMN title TEXT NOT NULL DEFAULT ''");
    }
    if (!columnsResult.some((col) => col.name === "lyrics")) {
      this.db.exec("ALTER TABLE assets ADD COLUMN lyrics TEXT NOT NULL DEFAULT ''");
    }
    if (!columnsResult.some((col) => col.name === "tags")) {
      this.db.exec("ALTER TABLE assets ADD COLUMN tags TEXT NOT NULL DEFAULT ''");
    }
    // Suno 的 custom_id：翻唱 / 混音要引用已有歌曲，必须存下来
    if (!columnsResult.some((col) => col.name === "remote_clip_id")) {
      this.db.exec("ALTER TABLE assets ADD COLUMN remote_clip_id TEXT NOT NULL DEFAULT ''");
    }
    // messages 建表早于「视频确认卡片」，补上待确认计划的列（§13.6 ①）
    const messageColumns = this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    if (!messageColumns.some((col) => col.name === "confirm_json")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN confirm_json TEXT");
    }
    // 一条用户消息可以引用**多张**已有产物（从画布或消息里拖进输入框的那几张）。
    // asset_id 是个单列，装不下，所以单开一个 JSON 数组；老行读出来就是空数组。
    if (!messageColumns.some((col) => col.name === "asset_refs")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN asset_refs TEXT");
    }
    // 脚本文档：气泡上只显示文件条，全文在 conversation_documents 里
    if (!messageColumns.some((col) => col.name === "documents_json")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN documents_json TEXT");
    }
    // 上传的图借 tasks 占一个 task_id（assets.task_id 是 NOT NULL，而重建表会动到真实数据），
    // 靠 origin 把它和真正的生成记录区分开（需求.md 问题 4）
    const taskColumns = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!taskColumns.some((col) => col.name === "origin")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'generate'");
    }
    // 上游任务的附加元数据（Midjourney 的按钮等）；空串表示没有
    if (!taskColumns.some((col) => col.name === "remote_meta")) {
      this.db.exec("ALTER TABLE tasks ADD COLUMN remote_meta TEXT NOT NULL DEFAULT ''");
    }
    // 画布从一根指针改成一组图（有序列表）：加列 + 把老指针搬进来
    const conversationColumns = this.db.prepare("PRAGMA table_info(conversations)").all() as Array<{ name: string }>;
    if (!conversationColumns.some((col) => col.name === "canvas_asset_ids")) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN canvas_asset_ids TEXT");
    }
    // 「原话直发」：有时候用户就是要自己那句话原样发出去，不许大脑润色（需求.md 问题 1）
    if (!conversationColumns.some((col) => col.name === "verbatim_prompt")) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN verbatim_prompt INTEGER NOT NULL DEFAULT 0");
    }
    const shotColumns = this.db.prepare("PRAGMA table_info(conversation_shots)").all() as Array<{ name: string }>;
    if (!shotColumns.some((col) => col.name === "character_name")) {
      this.db.exec("ALTER TABLE conversation_shots ADD COLUMN character_name TEXT NOT NULL DEFAULT ''");
    }
    // 分镜角色参考：老会话默认走 auto（第一个已完成的图片镜头）
    if (!conversationColumns.some((col) => col.name === "storyboard_reference_asset_id")) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN storyboard_reference_asset_id TEXT");
    }
    if (!conversationColumns.some((col) => col.name === "storyboard_reference_mode")) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN storyboard_reference_mode TEXT NOT NULL DEFAULT 'auto'");
    }
    /**
     * 回填**键在 `IS NULL` 上，而不是键在「刚加完列」上**，两个原因：
     *
     * 1. 这个项目没有 git 兜底。万一 ALTER 成功、回填跑到一半进程被杀，下次启动还得能补上。
     * 2. 一旦写成 `[]` 就再也不会被回填——所以用户清空画布之后重启，老指针**不会**把画布复活。
     *
     * JSON 在 JS 这边拼，不用 SQLite 的 json_array()：省一个对 JSON1 扩展的依赖，
     * 也和文件里 parseJson 的读写方向对称。
     */
    const legacyCanvas = this.db
      .prepare("SELECT id, current_asset_id FROM conversations WHERE canvas_asset_ids IS NULL")
      .all() as Array<{ id: string; current_asset_id: string | null }>;
    const writeCanvas = this.db.prepare("UPDATE conversations SET canvas_asset_ids = ? WHERE id = ?");
    for (const row of legacyCanvas) {
      writeCanvas.run(JSON.stringify(row.current_asset_id ? [row.current_asset_id] : []), row.id);
    }

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
    const assetRows = this.listAssets(id);
    const assets: StoredFileRef[] = assetRows.map((asset) => ({ baseDir: asset.baseDir, relativePath: asset.relativePath }));
    // 缩略图跟着产物一起清理，否则删完历史 thumbs/ 会无声地一直涨
    assets.push(...assetRows
      .filter((asset) => asset.thumbPath)
      .map((asset) => ({ baseDir: this.thumbsDir, relativePath: asset.thumbPath })));
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

  /** 任务品类：和前后端共用同一份规则，避免「历史页和清空接口各判各的」 */
  taskKindRow(row: TaskRow, adapterByChannel: Map<string, string>): TaskKind {
    return taskKindFor(
      adapterByChannel.get(row.channelId),
      this.listAssets(row.id).map((asset) => asset.mimeType),
    );
  }

  /** 兼容旧调用点；新代码用 `taskKindRow` */
  isVideoTaskRow(row: TaskRow, adapterByChannel: Map<string, string>): boolean {
    return this.taskKindRow(row, adapterByChannel) === "video";
  }

  private collectInputImagePaths(id: string): string[] {
    const row = this.db.prepare("SELECT input_json FROM tasks WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) return [];
    const input = parseJson<{
      referenceImages?: Array<{ relativePath?: string }>;
      referenceImage?: { relativePath?: string };
      maskImage?: { relativePath?: string };
    }>(row.input_json, {});
    const stored = input.referenceImages?.length ? input.referenceImages : input.referenceImage ? [input.referenceImage] : [];
    // 局部重绘蒙版和参考图一样落在 inputs/，删任务时要一起收走
    if (input.maskImage) stored.push(input.maskImage);
    return [...new Set(stored.map((item) => item?.relativePath).filter((value): value is string => typeof value === "string"))];
  }

  createTask(input: {
    id: string; channelId: string; model: string; prompt: string; input: unknown;
    /** 默认就是一次正常生成；上传素材那条传 `"upload"` */
    origin?: TaskOrigin;
    /** 上传的图生下来就是完成的，没有排队这一步 */
    status?: TaskStatus;
  }): TaskRow {
    const createdAt = now();
    this.db.prepare(`
      INSERT INTO tasks (id, channel_id, model, prompt, status, input_json, created_at, origin)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.channelId, input.model, input.prompt,
      input.status ?? "queued", JSON.stringify(input.input), createdAt, input.origin ?? "generate",
    );
    return this.getTaskRow(input.id)!;
  }

  getTaskRow(id: string): TaskRow | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow | undefined;
    return row ? this.taskFromRow(row) : null;
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

  updateTask(id: string, patch: Partial<Pick<TaskRow, "status" | "progress" | "remoteTaskId" | "remoteMeta" | "effectiveJson" | "attemptCount" | "errorCode" | "errorMessage" | "startedAt" | "finishedAt">>) {
    const fields: string[] = [];
    const values: Array<string | number | bigint | null | Uint8Array> = [];
    const mapping: Record<string, string> = {
      status: "status",
      progress: "progress",
      remoteTaskId: "remote_task_id",
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

  insertAsset(asset: {
    id: string; taskId: string; fileName: string; mimeType: string; byteSize: number;
    relativePath: string; baseDir: string; sha256: string; duration?: number | null;
    /** 相对 thumbs/ 的文件名。缩略图生成失败时留空，Agent 那边会现缩现存 */
    thumbPath?: string | null;
    /** 音乐产物的歌名 / 歌词 / 曲风 / Suno custom_id；图片/视频留空 */
    title?: string | null;
    lyrics?: string | null;
    tags?: string | null;
    remoteClipId?: string | null;
  }) {
    this.db.prepare(`
      INSERT INTO assets (id, task_id, file_name, mime_type, byte_size, relative_path, base_dir, sha256, duration, thumb_path, title, lyrics, tags, remote_clip_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      asset.id, asset.taskId, asset.fileName, asset.mimeType, asset.byteSize, asset.relativePath,
      asset.baseDir, asset.sha256, asset.duration ?? null, asset.thumbPath ?? "", asset.title ?? "",
      asset.lyrics ?? "", asset.tags ?? "", asset.remoteClipId ?? "", now(),
    );
  }

  /** 懒生成缩略图后回填（§11.4 的「使用时懒生成」），老产物走这条 */
  setAssetThumbPath(assetId: string, thumbPath: string) {
    this.db.prepare("UPDATE assets SET thumb_path = ? WHERE id = ?").run(thumbPath, assetId);
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

  /**
   * 当前画布那一组图，**顺序就是 `canvasAssetIds` 的顺序（[0] 是主图）**。
   *
   * 这里要**过滤掉已经不存在的 id 和非图片**：历史页删掉一个任务会连带删掉它的 assets，
   * 而画布里可能还留着它的 id。老的单指针靠 `getAsset` 返回 null 自然兜住了，
   * 变成列表之后必须显式过滤——否则「画布 3 张」实际只剩 2 张，大脑还会拿到 undefined。
   *
   * 只过滤、**不回写库**：读的时候顺手改数据是 bug 的温床，剪枝等下一次显式写画布时自然收敛。
   */
  canvasImages(conversation: Conversation): AssetRow[] {
    const images: AssetRow[] = [];
    for (const id of conversation.canvasAssetIds) {
      const asset = this.getAsset(id);
      if (asset && asset.mimeType.startsWith("image/")) images.push(asset);
    }
    return images;
  }

  private assetFromRow(row: DbRow): AssetRow {
    return {
      id: String(row.id), taskId: String(row.task_id), fileName: String(row.file_name), mimeType: String(row.mime_type),
      byteSize: Number(row.byte_size), relativePath: String(row.relative_path),
      baseDir: row.base_dir == null || row.base_dir === "" ? this.defaultAssetsDir : String(row.base_dir),
      sha256: String(row.sha256),
      duration: row.duration == null ? null : Number(row.duration),
      thumbPath: row.thumb_path == null ? "" : String(row.thumb_path),
      title: row.title == null ? "" : String(row.title),
      lyrics: row.lyrics == null ? "" : String(row.lyrics),
      tags: row.tags == null ? "" : String(row.tags),
      remoteClipId: row.remote_clip_id == null ? "" : String(row.remote_clip_id),
      createdAt: String(row.created_at),
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

  // ── 对话式 Agent（AGENT_PLAN.md §5） ──────────────────────────────────────

  createConversation(input: {
    title: string; brainChannelId: string; brainModel: string;
    videoConfirmPolicy: VideoConfirmPolicy; visionEnabled: boolean; verbatimPrompt: boolean;
  }): Conversation {
    const id = crypto.randomUUID();
    const at = now();
    this.db.prepare(`
      INSERT INTO conversations
      (id, title, brain_channel_id, brain_model, current_asset_id, canvas_asset_ids, status,
       video_confirm_policy, vision_enabled, verbatim_prompt, auto_continue_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, '[]', 'idle', ?, ?, ?, 0, ?, ?)
    `).run(
      id, input.title, input.brainChannelId, input.brainModel,
      input.videoConfirmPolicy, input.visionEnabled ? 1 : 0, input.verbatimPrompt ? 1 : 0, at, at,
    );
    return this.getConversation(id)!;
  }

  getConversation(id: string): Conversation | null {
    const row = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as DbRow | undefined;
    return row ? this.conversationFromRow(row) : null;
  }

  listConversations(): Conversation[] {
    const rows = this.db.prepare("SELECT * FROM conversations ORDER BY updated_at DESC").all() as DbRow[];
    return rows.map((row) => this.conversationFromRow(row));
  }

  /**
   * 把卡在 `running` 的会话收回 `idle`，返回改动了几条。
   *
   * 一轮的处理只活在内存里（`AgentService.activeTurns`），进程一没它就没了，
   * 而 `status` 已经落库成 `running`——界面于是永远在转圈（用户看到的就是
   * 「任务失败了还在转圈」）。启动时收拾一次即可，进程内的异常路径由
   * `startTurn` 的 finally 兜着。
   */
  resetConversationsStuckInRunning(): number {
    const result = this.db.prepare("UPDATE conversations SET status = 'idle' WHERE status = 'running'").run();
    return Number(result.changes ?? 0);
  }

  /**
   * 一条消息都没有的会话 id。
   *
   * 新建会话时用它清掉上一条没动过的空壳——点几下「新对话」就堆几条，
   * 侧栏会被一串「新对话」刷屏。空会话没有消息，也就没有产物和上传图，删掉不丢东西。
   */
  emptyConversationIds(): string[] {
    const rows = this.db.prepare(
      `SELECT conversations.id AS id FROM conversations
       WHERE NOT EXISTS (SELECT 1 FROM messages WHERE messages.conversation_id = conversations.id)`,
    ).all() as DbRow[];
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

  // ── 脚本文档与分镜表 ──────────────────────────────────────────────────────

  addConversationDocument(conversationId: string, fileName: string, content: string): StoredDocument {
    const id = crypto.randomUUID();
    const at = now();
    this.db.prepare(`
      INSERT INTO conversation_documents (id, conversation_id, file_name, content, char_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, conversationId, fileName, content, content.length, at);
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, conversationId);
    return { id, conversationId, fileName, content, charCount: content.length, createdAt: at };
  }

  listConversationDocuments(conversationId: string): StoredDocument[] {
    const rows = this.db.prepare(
      "SELECT * FROM conversation_documents WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC",
    ).all(conversationId) as DbRow[];
    return rows.map((row) => ({
      id: String(row.id), conversationId: String(row.conversation_id), fileName: String(row.file_name),
      content: String(row.content), charCount: Number(row.char_count), createdAt: String(row.created_at),
    }));
  }

  getConversationDocument(id: string): StoredDocument | null {
    const row = this.db.prepare("SELECT * FROM conversation_documents WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) return null;
    return {
      id: String(row.id), conversationId: String(row.conversation_id), fileName: String(row.file_name),
      content: String(row.content), charCount: Number(row.char_count), createdAt: String(row.created_at),
    };
  }

  /**
   * 整表替换一个会话的分镜。
   *
   * 重新拆镜是「用户拿了一份新脚本」或「上一版拆得不对」——保留旧镜号只会让
   * 「第 7 镜」指到两张不同的画面上。已经生成的产物仍在生成历史里，不会丢。
   */
  replaceStoryboard(
    conversationId: string,
    shots: Array<{ sourceText: string; prompt: string; kind: StoryboardShotKind; aspectRatio: string; character?: string }>,
  ): StoryboardShot[] {
    const at = now();
    this.db.prepare("DELETE FROM conversation_shots WHERE conversation_id = ?").run(conversationId);
    const insert = this.db.prepare(`
      INSERT INTO conversation_shots
      (id, conversation_id, shot_index, source_text, prompt, character_name, kind, aspect_ratio, task_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `);
    for (const [position, shot] of shots.entries()) {
      insert.run(
        crypto.randomUUID(), conversationId, position + 1,
        shot.sourceText, shot.prompt, shot.character ?? "", shot.kind, shot.aspectRatio, at, at,
      );
    }
    this.upsertStoryboardCharacters(conversationId, shots.map((shot) => shot.character ?? ""));
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, conversationId);
    return this.listStoryboardShots(conversationId);
  }

  /** 把镜头里出现的角色名补进 characters 表；已有的名字不动（保留绑定好的参考图） */
  upsertStoryboardCharacters(conversationId: string, names: string[]) {
    const unique = [...new Set(names.map((name) => name.trim()).filter(Boolean))];
    if (!unique.length) return;
    const at = now();
    const insert = this.db.prepare(`
      INSERT INTO conversation_characters (id, conversation_id, name, asset_id, created_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?)
      ON CONFLICT(conversation_id, name) DO NOTHING
    `);
    for (const name of unique) insert.run(crypto.randomUUID(), conversationId, name, at, at);
  }

  listStoryboardCharacters(conversationId: string): Array<{
    id: string; name: string; assetId: string | null; createdAt: string; updatedAt: string;
  }> {
    const rows = this.db.prepare(
      "SELECT * FROM conversation_characters WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC",
    ).all(conversationId) as DbRow[];
    return rows.map((row) => ({
      id: String(row.id), name: String(row.name),
      assetId: row.asset_id == null ? null : String(row.asset_id),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }));
  }

  getStoryboardCharacter(id: string): { id: string; conversationId: string; name: string; assetId: string | null } | null {
    const row = this.db.prepare("SELECT * FROM conversation_characters WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) return null;
    return {
      id: String(row.id), conversationId: String(row.conversation_id), name: String(row.name),
      assetId: row.asset_id == null ? null : String(row.asset_id),
    };
  }

  setStoryboardCharacterAsset(characterId: string, assetId: string | null) {
    this.db.prepare("UPDATE conversation_characters SET asset_id = ?, updated_at = ? WHERE id = ?")
      .run(assetId, now(), characterId);
  }

  /**
   * 分镜表视图：任务状态是**现在**从 tasks 表读出来的，不在分镜行里再存一份。
   *
   * 存一份就得处理「任务重启恢复」「后台轮询完成」「删除历史」三条写路径，
   * 而那三条都已经在维护 tasks 了；分镜只需要记住「最近一次挂在哪个 task 上」。
   */
  listStoryboardShots(conversationId: string): StoryboardShot[] {
    const rows = this.db.prepare(`
      SELECT s.*, t.status AS task_status, t.error_message AS task_error,
             (SELECT a.id FROM assets a WHERE a.task_id = s.task_id ORDER BY a.created_at ASC, a.rowid ASC LIMIT 1) AS result_asset_id
      FROM conversation_shots s
      LEFT JOIN tasks t ON t.id = s.task_id
      WHERE s.conversation_id = ?
      ORDER BY s.shot_index ASC
    `).all(conversationId) as DbRow[];
    return rows.map((row) => {
      const taskId = row.task_id == null ? null : String(row.task_id);
      const taskStatus = row.task_status == null ? null : String(row.task_status) as TaskStatus;
      const status = taskId && taskStatus ? taskStatus as StoryboardShotStatus : "planned";
      const assetId = row.result_asset_id == null ? null : String(row.result_asset_id);
      const assetRow = assetId ? this.getAsset(assetId) : null;
      return {
        id: String(row.id), conversationId: String(row.conversation_id),
        index: Number(row.shot_index),
        sourceText: String(row.source_text ?? ""), prompt: String(row.prompt ?? ""),
        character: String(row.character_name ?? ""),
        kind: String(row.kind) === "video" ? "video" as const : "image" as const,
        aspectRatio: String(row.aspect_ratio ?? ""),
        taskId, status,
        assetId: assetRow ? String(assetRow.id) : null,
        asset: assetRow ? this.assetView(assetRow) : null,
        errorMessage: row.task_error == null ? null : String(row.task_error),
        createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      };
    });
  }

  getStoryboardShot(id: string): StoryboardShot | null {
    const row = this.db.prepare("SELECT conversation_id FROM conversation_shots WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) return null;
    return this.listStoryboardShots(String(row.conversation_id)).find((shot) => shot.id === id) ?? null;
  }

  updateStoryboardShot(
    id: string,
    patch: Partial<Pick<StoryboardShot, "prompt" | "sourceText" | "character" | "kind" | "aspectRatio" | "taskId">>,
  ): StoryboardShot | null {
    const fields: string[] = [];
    const values: Array<string | null> = [];
    const mapping: Record<string, string> = {
      prompt: "prompt", sourceText: "source_text", character: "character_name",
      kind: "kind", aspectRatio: "aspect_ratio", taskId: "task_id",
    };
    for (const [key, column] of Object.entries(mapping)) {
      if (!(key in patch)) continue;
      fields.push(`${column} = ?`);
      values.push(((patch as Record<string, unknown>)[key] ?? null) as string | null);
    }
    if (!fields.length) return this.getStoryboardShot(id);
    fields.push("updated_at = ?");
    values.push(now(), id);
    this.db.prepare(`UPDATE conversation_shots SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.getStoryboardShot(id);
  }

  hasStoryboard(conversationId: string): boolean {
    const row = this.db.prepare("SELECT 1 AS found FROM conversation_shots WHERE conversation_id = ? LIMIT 1")
      .get(conversationId) as DbRow | undefined;
    return Boolean(row);
  }

  countStoryboardShots(conversationId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM conversation_shots WHERE conversation_id = ?")
      .get(conversationId) as DbRow | undefined;
    return Number(row?.count ?? 0);
  }

  /** 分镜的角色参考设置。auto = 用第一个已完成的图片镜头，manual = 用指定产物，off = 不用 */
  getStoryboardReference(conversationId: string): { assetId: string | null; mode: "auto" | "manual" | "off" } {
    const row = this.db.prepare(
      "SELECT storyboard_reference_asset_id AS asset_id, storyboard_reference_mode AS mode FROM conversations WHERE id = ?",
    ).get(conversationId) as DbRow | undefined;
    const mode = row?.mode === "manual" || row?.mode === "off" ? row.mode : "auto";
    return { assetId: row?.asset_id == null ? null : String(row.asset_id), mode };
  }

  setStoryboardReference(conversationId: string, input: { assetId: string | null; mode: "auto" | "manual" | "off" }) {
    this.db.prepare(
      "UPDATE conversations SET storyboard_reference_asset_id = ?, storyboard_reference_mode = ?, updated_at = ? WHERE id = ?",
    ).run(input.mode === "manual" ? input.assetId : null, input.mode, now(), conversationId);
  }

  deleteStoryboard(conversationId: string): number {
    const result = this.db.prepare("DELETE FROM conversation_shots WHERE conversation_id = ?").run(conversationId);
    return Number(result.changes ?? 0);
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
    };
    for (const [key, column] of Object.entries(mapping)) {
      if (!(key in patch)) continue;
      fields.push(`${column} = ?`);
      values.push((patch as Record<string, unknown>)[key] as string | null);
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

  /**
   * 删除会话。
   *
   * 生成出来的产物**留着**——它们是「生成历史」里的记录，会话删了用户还能在那边找到。
   * 但自己上传的图不属于历史，会话一没就没人能引用它了，所以跟着一起清盘：
   * 否则素材目录里会静默地留下一堆永远看不见的文件。
   */
  deleteConversation(id: string): { assets: StoredFileRef[] } {
    const uploads = this.db.prepare(`
      SELECT DISTINCT tasks.id AS id FROM messages
      JOIN assets ON assets.id = messages.asset_id
      JOIN tasks ON tasks.id = assets.task_id
      WHERE messages.conversation_id = ? AND tasks.origin = 'upload'
    `).all(id) as DbRow[];

    const assets: StoredFileRef[] = [];
    for (const row of uploads) assets.push(...this.deleteTask(String(row.id)).assets);
    this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM conversation_documents WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM conversation_shots WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM conversation_characters WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM brain_calls WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    return { assets };
  }

  /**
   * 记一次大脑调用的 token 用量。
   *
   * 只记拿到 usage 的调用：中转站没回这个字段时（部分站点忽略 stream_options）
   * 不写 0，否则「记过 3 次」会变成一句假话。
   */
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

  listMessages(conversationId: string, limit = 400): ChatMessage[] {
    // 取最近 N 条再正序返回：对话长了以后不能整个表读进内存
    const rows = this.db.prepare(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?",
    ).all(conversationId, limit) as DbRow[];
    return rows.reverse().map((row) => this.messageFromRow(row));
  }

  getMessage(id: string): ChatMessage | null {
    const row = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as DbRow | undefined;
    return row ? this.messageFromRow(row) : null;
  }

  appendMessage(input: {
    conversationId: string; role: MessageRole; content?: string | null;
    plan?: AgentPlan | null; toolName?: string | null;
    toolArgs?: Record<string, unknown> | null; toolResult?: ToolResult | null;
    confirm?: ConfirmPreview | null; taskId?: string | null; assetId?: string | null;
    /** 这条消息引用的一组产物（用户从输入框拖进来的那些图） */
    assetRefs?: string[] | null;
    /** 这条消息附带的脚本文档（只存引用，全文在 conversation_documents） */
    documents?: ChatDocumentRef[] | null;
    status?: MessageStatus; errorMessage?: string | null;
  }): ChatMessage {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ?")
      .get(input.conversationId) as DbRow;
    const seq = Number(row.next);
    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO messages
      (id, conversation_id, seq, role, content, plan_json, tool_name, tool_args_json,
       tool_result_json, confirm_json, task_id, asset_id, asset_refs, documents_json, status, error_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.documents?.length ? JSON.stringify(input.documents) : null,
      input.status ?? "ok", input.errorMessage ?? null, now(),
    );
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now(), input.conversationId);
    return this.getMessage(id)!;
  }

  updateMessage(id: string, patch: Partial<Pick<ChatMessage, "content" | "status" | "errorMessage" | "taskId" | "assetId">> & {
    toolResult?: ToolResult | null; confirm?: ConfirmPreview | null; toolArgs?: Record<string, unknown> | null;
  }) {
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

  /** 待确认的消息。用户发新消息时要把它们标成「已被取代」并让出 pending 状态 */
  listPendingMessages(conversationId: string): ChatMessage[] {
    const rows = this.db.prepare(
      "SELECT * FROM messages WHERE conversation_id = ? AND status = 'pending' ORDER BY seq ASC",
    ).all(conversationId) as DbRow[];
    return rows.map((row) => this.messageFromRow(row));
  }

  /** 视频任务完成后靠它找回会话（§9.1）；一个任务只会属于一个会话 */
  findConversationByTask(taskId: string): Conversation | null {
    const row = this.db.prepare(
      "SELECT conversations.* FROM conversations JOIN messages ON messages.conversation_id = conversations.id WHERE messages.task_id = ? ORDER BY messages.seq DESC LIMIT 1",
    ).get(taskId) as DbRow | undefined;
    return row ? this.conversationFromRow(row) : null;
  }

  /**
   * 分镜生成出来的产物。
   *
   * 它们没有经过 Agent 的消息落库（分镜面板直接提交 runner），所以不在
   * `messages.asset_id` 那条线索上。但用户点「加画布」之后，画布要能找到它们——
   * 必须把这条来路补进 `buildView` 的素材集合。
   */
  listStoryboardAssets(conversationId: string): Array<{ asset: AssetRow; index: number; prompt: string }> {
    const rows = this.db.prepare(`
      SELECT assets.*, s.shot_index AS shot_index, s.prompt AS shot_prompt
      FROM conversation_shots s
      JOIN assets ON assets.task_id = s.task_id
      WHERE s.conversation_id = ?
      ORDER BY s.shot_index ASC, assets.created_at ASC
    `).all(conversationId) as DbRow[];
    return rows.map((row) => ({ asset: this.assetFromRow(row), index: Number(row.shot_index), prompt: String(row.shot_prompt ?? "") }));
  }

  /** 会话里产出过图片的产物，按顺序排列，供「设为当前」回溯（§10.1 规则 3） */
  listConversationAssets(conversationId: string): Array<{ asset: AssetRow; round: number; prompt: string; source: ConversationAssetSource }> {
    const rows = this.db.prepare(`
      SELECT assets.*, messages.seq AS message_seq, messages.content AS message_content,
             COALESCE(tasks.origin, 'generate') AS asset_origin
      FROM messages
      JOIN assets anchor ON anchor.id = messages.asset_id
      -- 一条消息只挂了主产物；音乐一次两首，必须把同一个 task 的其余产物也带进来
      JOIN assets ON assets.task_id = anchor.task_id
      LEFT JOIN tasks ON tasks.id = assets.task_id
      WHERE messages.conversation_id = ? AND messages.asset_id IS NOT NULL
      ORDER BY messages.seq ASC, assets.created_at ASC
    `).all(conversationId) as DbRow[];
    /*
     * 同一个产物可能被不止一条消息引用：产出它那条算一次，之后每次 set_canvas
     * 也会落一条带 assetId 的消息。不去重的话，「本会话的图」里会出现两张一模一样的
     * （用户看到的现象：在画布里来回切几次，同一张图就有了好几个副本）。
     * 去重保留**最早**那条——只有它带着真正的提示词、轮次和来源。
     *
     * 轮次在去重之后才数：把重复那条也算进去的话，被跳过的 seq 会让后面的轮次号跳号。
     */
    const seen = new Set<string>();
    let round = 0;
    let lastSeq: number | null = null;
    const entries: Array<{ asset: AssetRow; round: number; prompt: string; source: ConversationAssetSource }> = [];
    for (const row of rows) {
      const id = String(row.id);
      if (seen.has(id)) continue;
      seen.add(id);
      const seq = Number(row.message_seq);
      if (seq !== lastSeq) { round += 1; lastSeq = seq; }
      entries.push({
        asset: this.assetFromRow(row), round, prompt: String(row.message_content ?? ""),
        // 生成的和上传的可预期行为不一样（上传的没有提示词），前端据此加个来源标记
        source: (row.asset_origin == null ? "generate" : String(row.asset_origin)) as TaskOrigin,
      });
    }
    /*
     * 分镜产物没有消息行，但必须并进同一份「会话产物」：
     * resolveAssetRef / view_images / 拖进输入框都只认这一份，
     * 漏掉它们的话，用户就没法说「把第 7 镜那张做成视频」。
     */
    for (const entry of this.listStoryboardAssets(conversationId)) {
      if (seen.has(entry.asset.id)) continue;
      seen.add(entry.asset.id);
      entries.push({ asset: entry.asset, round: entry.index, prompt: entry.prompt, source: "storyboard" });
    }
    return entries;
  }

  private conversationFromRow(row: DbRow): Conversation {
    return {
      id: String(row.id), title: String(row.title),
      brainChannelId: String(row.brain_channel_id), brainModel: String(row.brain_model),
      // JSON 坏了或者还是 NULL（没迁移到的老行）都当成空画布，别让一行坏数据炸掉整个会话列表
      canvasAssetIds: canvasIdsFromRow(row.canvas_asset_ids),
      status: String(row.status) as ConversationStatus,
      videoConfirmPolicy: String(row.video_confirm_policy) as VideoConfirmPolicy,
      visionEnabled: Boolean(row.vision_enabled),
      verbatimPrompt: Boolean(row.verbatim_prompt),
      autoContinueCount: Number(row.auto_continue_count),
      taskCount: this.countConversationTasks(String(row.id)),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
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
      documents: parseJson<ChatDocumentRef[]>(row.documents_json, []),
      status: String(row.status) as MessageStatus,
      errorMessage: row.error_message == null ? null : String(row.error_message),
      createdAt: String(row.created_at),
    };
  }

  private countConversationTasks(conversationId: string): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS total FROM messages WHERE conversation_id = ? AND task_id IS NOT NULL",
    ).get(conversationId) as DbRow;
    return Number(row.total);
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

  private taskView(task: TaskRow): Task {
    // 工作台也要「看得见」（需求.md 问题 1 D）：核对用的是任务自己落库的两份原料——
    // input_json 是请求时写的，effective_json 是**发送前**就存下的脱敏请求体。
    // 适配器认不出来（渠道已删除、上传素材的空 channel_id）就不硬猜，如实不给这一项。
    const parameterNotes = task.channelAdapterType
      ? auditParameters(task.channelAdapterType, parseJson<Record<string, unknown>>(task.inputJson, {}), parseJson<Record<string, unknown> | null>(task.effectiveJson, null))
      : [];
    return {
      id: task.id, channelId: task.channelId, channelName: task.channelName ?? "已删除渠道", model: task.model, prompt: task.prompt,
      status: task.status, progress: task.progress, effectiveParameters: parseJson(task.effectiveJson, null),
      ...(parameterNotes.length ? { parameterNotes } : {}),
      attemptCount: task.attemptCount, errorCode: task.errorCode, errorMessage: task.errorMessage,
      ...(task.remoteMeta ? { remoteMeta: parseJson<NonNullable<Task["remoteMeta"]>>(task.remoteMeta, {}) } : {}),
      assets: this.listAssets(task.id).map((asset) => this.assetView(asset)),
      createdAt: task.createdAt, startedAt: task.startedAt, finishedAt: task.finishedAt,
    };
  }

  /** AssetRow → 前端用的 Asset。Agent 的画布徽章、附件条也走这一份，别各写一遍 */
  assetView(asset: AssetRow): Asset {
    return {
      id: asset.id, taskId: asset.taskId, fileName: asset.fileName, mimeType: asset.mimeType, byteSize: asset.byteSize,
      url: `/api/assets/${asset.id}/file`,
      thumbUrl: isImageAsset(asset) || (isAudioAsset(asset) && Boolean(asset.thumbPath))
        ? `/api/assets/${asset.id}/thumb`
        : null,
      duration: asset.duration,
      title: asset.title || null,
      lyrics: asset.lyrics || null,
      tags: asset.tags || null,
      remoteClipId: asset.remoteClipId || null,
      createdAt: asset.createdAt,
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
      channelAdapterType: row.channel_adapter_type == null ? null : String(row.channel_adapter_type) as AdapterType,
      model: String(row.model), prompt: String(row.prompt), status: String(row.status) as TaskStatus,
      progress: row.progress == null ? null : Number(row.progress),
      remoteTaskId: row.remote_task_id == null ? null : String(row.remote_task_id),
      remoteMeta: row.remote_meta == null ? null : String(row.remote_meta),
      inputJson: String(row.input_json), effectiveJson: row.effective_json == null ? null : String(row.effective_json), attemptCount: Number(row.attempt_count),
      errorCode: row.error_code == null ? null : String(row.error_code), errorMessage: row.error_message == null ? null : String(row.error_message),
      createdAt: String(row.created_at), startedAt: row.started_at == null ? null : String(row.started_at), finishedAt: row.finished_at == null ? null : String(row.finished_at),
      origin: (row.origin == null ? "generate" : String(row.origin)) as TaskOrigin,
    };
  }
}

/**
 * `generate` = 走 runner 的真实生成；`upload` = 用户在对话框里自己传的图（需求.md 问题 4）。
 * 后者只是为了给 `assets.task_id` 找个可指的主键，**不是**一次生成，
 * 所以历史列表、清空历史、诊断入口都按 `generate` 过滤。
 */
export type TaskOrigin = "generate" | "upload";

export interface TaskRow {
  id: string; channelId: string; channelName: string | null;
  /** 渠道适配器，参数核对要用它选映射表；`SELECT *` 那种查询拿不到，所以可空 */
  channelAdapterType: AdapterType | null;
  model: string; prompt: string; status: TaskStatus; progress: number | null;
  /** 上游异步任务 id：重启后用它接着轮询，不用从头发起 */
  remoteTaskId: string | null;
  /** 上游附加元数据 JSON（Midjourney 按钮等） */
  remoteMeta: string | null;
  inputJson: string; effectiveJson: string | null; attemptCount: number; errorCode: string | null;
  errorMessage: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
  origin: TaskOrigin;
}

export interface AssetRow {
  id: string; taskId: string; fileName: string; mimeType: string; byteSize: number; relativePath: string;
  /** 该产物所在目录：用户换过素材目录后，老记录仍指向写入时的目录 */
  baseDir: string;
  sha256: string; duration: number | null;
  /** 相对 thumbs/ 的缩略图文件名，空串表示还没生成 */
  thumbPath: string;
  /** 音乐产物的歌名 / 歌词 / 曲风 / Suno custom_id；图片/视频为空串 */
  title: string;
  lyrics: string;
  tags: string;
  remoteClipId: string;
  createdAt: string;
}

/** 待清理的落盘文件：目录随记录走，不能用当前素材目录去猜 */
export interface StoredFileRef {
  baseDir: string;
  relativePath: string;
}
