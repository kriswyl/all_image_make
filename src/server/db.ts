import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { AdapterType, AuthType, Channel, ChannelInput, Diagnostic, Task, TaskStatus, Asset, TaskKind } from "../shared/types.js";
import { isAudioAsset, isImageAsset } from "../shared/types.js";
import { AUDIO_ADAPTER_TYPES, VIDEO_ADAPTER_TYPES, taskKindFor } from "../shared/kinds.js";
// 参数核对（需求.md 问题 1）：纯函数、无 IO、不碰 db，所以放在这里不构成环
import { auditParameters } from "./diagnose.js";
import { initializeSchema } from "./db-schema.js";
import { BoardRepository } from "./db-board.js";
import type {
  AgentPlan, ChatDocumentRef, ConfirmPreview, ChatMessage, Conversation, ConversationKind, ConversationPatch,
  ConversationStatus, ConversationUsage, MessageRole, MessageStatus, ToolResult, VideoConfirmPolicy,
} from "../shared/agent-types.js";
import {
  joinCharacterNames, parseCharacterNames,
  type StoryboardShot, type StoryboardShotKind, type StoryboardShotStatus, type StoryboardVideoMode,
} from "../shared/storyboard.js";
import {
  boardGroups, createEmptyBoardDoc, parseBoardDoc,
  type BoardDoc, type BoardUiState, type BoardViewport,
} from "../shared/board.js";
import type { CanvasTemplate, CanvasTemplateSummary } from "../shared/canvas-template.js";

export interface DbChannel {
  id: string;
  name: string;
  baseUrl: string;
  adapterType: AdapterType;
  authType: AuthType;
  authHeaderName: string;
  secretEnv: string;
  endpoint: string;
  uploadEndpoint?: string;
  uploadHeaders?: Record<string, string>;
  models: string[];
  allowPrivateNetwork: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 会话产物的来源：正常生成、用户上传、分镜面板提交，或角色/场景设定图 */
export type ConversationAssetSource = TaskOrigin | "storyboard" | "setting" | "bridge";

function stringArrayFromJson(value: unknown): string[] {
  if (value == null) return [];
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) ? [...new Set(parsed.filter((item): item is string => typeof item === "string" && Boolean(item)))] : [];
  } catch {
    return [];
  }
}

export interface StoredDocument {
  id: string;
  conversationId: string;
  fileName: string;
  content: string;
  charCount: number;
  createdAt: string;
}

/** 无限画布的一行 + 解析好的文档 / 视口 / 选中状态 */
export interface BoardRecord {
  id: string;
  title: string;
  doc: BoardDoc;
  viewport: BoardViewport;
  selection: string[];
  uiState: BoardUiState;
  version: number;
  threadId: string;
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
  private readonly boards: BoardRepository;

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
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    initializeSchema(this.db, this.defaultAssetsDir);
    this.boards = new BoardRepository(this.db, (row) => this.assetFromRow(row), (asset) => this.assetView(asset));

    // 老分镜可能把「林小满、老陈」当成一个角色存下来了。启动时拆成独立角色，
    // 否则面板里会出现一个「林小满、老陈」的卡片，谁都没法单独绑设定图。
    this.normalizeStoryboardCharacterNames();

    this.currentAssetsDir = this.resolveAssetsDir();
    fs.mkdirSync(this.currentAssetsDir, { recursive: true });
  }

  private normalizeStoryboardCharacterNames() {
    const rows = this.db.prepare(
      "SELECT conversation_id, character_name FROM conversation_shots WHERE character_name <> ''",
    ).all() as Array<{ conversation_id: string; character_name: string }>;
    const byConversation = new Map<string, string[]>();
    for (const row of rows) {
      const names = parseCharacterNames(row.character_name);
      if (names.length < 2) continue;
      byConversation.set(row.conversation_id, [
        ...(byConversation.get(row.conversation_id) ?? []), ...names,
      ]);
    }
    for (const [conversationId, names] of byConversation) {
      this.upsertStoryboardCharacters(conversationId, names);
    }
    // 拆开之后旧的「林小满、老陈」组合卡就没用了；现在设定栏会显示 0 镜的角色，
    // 不删掉会让用户看到两张永远没有镜头的重复卡。只清没绑图的，避免误删用户资产。
    this.db.prepare(`
      DELETE FROM conversation_characters
      WHERE asset_id IS NULL AND task_id IS NULL
        AND (instr(name, '、') > 0 OR instr(name, '，') > 0 OR instr(name, ',') > 0
          OR instr(name, '/') > 0 OR instr(name, '／') > 0
          OR instr(name, '+') > 0 OR instr(name, '&') > 0)
    `).run();
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
      input.uploadEndpoint ?? "",
      JSON.stringify(input.uploadHeaders ?? {}),
      "",
      JSON.stringify(input.models ?? []),
      input.allowPrivateNetwork ? 1 : 0,
      input.enabled === false ? 0 : 1,
      createdAt,
      updatedAt,
    ];
    this.db.prepare(`
      INSERT INTO channels
      (id, name, base_url, adapter_type, auth_type, auth_header_name, secret_env, endpoint, upload_endpoint, upload_headers_json, status_endpoint,
       models_json, allow_private_network, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, base_url=excluded.base_url, adapter_type=excluded.adapter_type,
        auth_type=excluded.auth_type, auth_header_name=excluded.auth_header_name, secret_env=excluded.secret_env,
        endpoint=excluded.endpoint, upload_endpoint=excluded.upload_endpoint, upload_headers_json=excluded.upload_headers_json, status_endpoint=excluded.status_endpoint, models_json=excluded.models_json,
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
    this.db.prepare("DELETE FROM board_tasks WHERE task_id = ?").run(id);
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    if (options.keepFiles) return { assets: [], inputs: [] };
    return { assets, inputs };
  }

  /**
   * 从会话素材库里永久删除一张图片。
   *
   * 和「删任务」的区别：这里以**图片**为单位。一个任务只出了这一张时连任务和
   * 参考图一起清掉；任务还有别的产物时只删这一张，历史记录保留。删除后把消息、
   * 画布、分镜和角色 / 场景里的引用一起摘掉，避免画出裂图或留下指向空任务的卡片。
   */
  deleteConversationAsset(conversationId: string, assetId: string): {
    files: StoredFileRef[];
    inputs: string[];
    taskRemoved: boolean;
  } | null {
    const asset = this.getAsset(assetId);
    if (!asset) return null;
    const taskId = asset.taskId;
    const siblingRow = this.db.prepare("SELECT COUNT(*) AS count FROM assets WHERE task_id = ?")
      .get(taskId) as DbRow | undefined;
    const taskRemoved = Number(siblingRow?.count ?? 0) <= 1;
    const files: StoredFileRef[] = [];
    const inputs: string[] = [];
    if (taskRemoved) {
      const removed = this.deleteTask(taskId);
      files.push(...removed.assets);
      inputs.push(...removed.inputs);
    } else {
      files.push({ baseDir: asset.baseDir, relativePath: asset.relativePath });
      if (asset.thumbPath) files.push({ baseDir: this.thumbsDir, relativePath: asset.thumbPath });
      this.db.prepare("DELETE FROM assets WHERE id = ?").run(assetId);
    }

    const at = now();
    // 一个任务出了多张图时，消息原来锚在删掉的那张上；改锚到同任务剩下的图，
    // 否则「会话素材」会把同一任务的其余产物一起藏掉
    const fallbackRow = taskRemoved ? undefined : this.db.prepare(
      "SELECT id FROM assets WHERE task_id = ? ORDER BY created_at ASC, rowid ASC LIMIT 1",
    ).get(taskId) as DbRow | undefined;
    const fallbackAssetId = fallbackRow?.id == null ? null : String(fallbackRow.id);
    // 消息：主图 / 附带图 / 工具结果里的 taskId 都要断干净，否则前端会去请求已删的缩略图
    const messages = this.db.prepare(
      "SELECT id, asset_id, asset_refs, task_id, tool_result_json FROM messages WHERE conversation_id = ?",
    ).all(conversationId) as DbRow[];
    const updateMessage = this.db.prepare(
      "UPDATE messages SET asset_id = ?, asset_refs = ?, task_id = ?, tool_result_json = ? WHERE id = ?",
    );
    for (const row of messages) {
      let changed = false;
      let messageAssetId = row.asset_id == null ? null : String(row.asset_id);
      if (messageAssetId === assetId) { messageAssetId = fallbackAssetId; changed = true; }

      let assetRefs: string[] | null = row.asset_refs == null ? null : (() => {
        try { return JSON.parse(String(row.asset_refs)) as string[]; } catch { return null; }
      })();
      if (Array.isArray(assetRefs) && assetRefs.includes(assetId)) {
        assetRefs = assetRefs.filter((id) => id !== assetId);
        changed = true;
      }

      let messageTaskId = row.task_id == null ? null : String(row.task_id);
      if (taskRemoved && messageTaskId === taskId) { messageTaskId = null; changed = true; }

      let toolResultJson = row.tool_result_json == null ? null : String(row.tool_result_json);
      if (toolResultJson) {
        try {
          const result = JSON.parse(toolResultJson) as Record<string, unknown>;
          const data = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : null;
          let resultChanged = false;
          if (result.assetId === assetId) { delete result.assetId; resultChanged = true; }
          if (data?.assetId === assetId) { delete data.assetId; resultChanged = true; }
          if (Array.isArray(data?.assetIds)) {
            const ids = (data.assetIds as string[]).filter((id) => id !== assetId);
            if (ids.length !== (data.assetIds as string[]).length) {
              if (ids.length) data.assetIds = ids; else delete data.assetIds;
              resultChanged = true;
            }
          }
          if (taskRemoved && result.taskId === taskId) { delete result.taskId; resultChanged = true; }
          if (taskRemoved && data?.midjourneyTaskId === taskId) { delete data.midjourneyTaskId; resultChanged = true; }
          if (resultChanged) { changed = true; toolResultJson = JSON.stringify(result); }
          else toolResultJson = row.tool_result_json == null ? null : String(row.tool_result_json);
        } catch {
          // 旧数据里偶有非 JSON，保持原样
        }
      }

      if (!changed) continue;
      updateMessage.run(
        messageAssetId,
        assetRefs?.length ? JSON.stringify(assetRefs) : null,
        messageTaskId,
        toolResultJson,
        String(row.id),
      );
    }

    // 画布：删掉的图不能继续占着首帧 / 尾帧的位置
    const conversationRow = this.db.prepare(
      "SELECT canvas_asset_ids, current_asset_id FROM conversations WHERE id = ?",
    ).get(conversationId) as DbRow | undefined;
    if (conversationRow) {
      const canvas = canvasIdsFromRow(conversationRow.canvas_asset_ids).filter((id) => id !== assetId);
      const current = conversationRow.current_asset_id == null ? null : String(conversationRow.current_asset_id);
      this.db.prepare(
        "UPDATE conversations SET canvas_asset_ids = ?, current_asset_id = ?, updated_at = ? WHERE id = ?",
      ).run(JSON.stringify(canvas), current === assetId ? null : current, at, conversationId);
    }

    // 分镜视频输入：被删的图不能继续挂在首帧 / 尾帧 / 参考图里
    this.db.prepare(
      "UPDATE conversation_shots SET first_frame_asset_id = NULL, updated_at = ? WHERE conversation_id = ? AND first_frame_asset_id = ?",
    ).run(at, conversationId, assetId);
    this.db.prepare(
      "UPDATE conversation_shots SET last_frame_asset_id = NULL, updated_at = ? WHERE conversation_id = ? AND last_frame_asset_id = ?",
    ).run(at, conversationId, assetId);
    const referenceRows = this.db.prepare(
      "SELECT id, reference_asset_ids FROM conversation_shots WHERE conversation_id = ? AND reference_asset_ids LIKE ?",
    ).all(conversationId, `%${assetId}%`) as DbRow[];
    const updateReferences = this.db.prepare(
      "UPDATE conversation_shots SET reference_asset_ids = ?, updated_at = ? WHERE id = ?",
    );
    for (const row of referenceRows) {
      const ids = stringArrayFromJson(row.reference_asset_ids);
      const next = ids.filter((id) => id !== assetId);
      if (next.length !== ids.length) updateReferences.run(JSON.stringify(next), at, String(row.id));
    }

    // 分镜 / 设定：任务没了就把指针清空，镜头回到「未生成」
    if (taskRemoved) {
      this.db.prepare(
        "UPDATE conversation_shots SET task_id = NULL, updated_at = ? WHERE conversation_id = ? AND task_id = ?",
      ).run(at, conversationId, taskId);
      this.db.prepare(
        "UPDATE conversation_shots SET video_task_id = NULL, updated_at = ? WHERE conversation_id = ? AND video_task_id = ?",
      ).run(at, conversationId, taskId);
      this.db.prepare(
        "UPDATE conversation_shots SET voice_task_id = NULL, updated_at = ? WHERE conversation_id = ? AND voice_task_id = ?",
      ).run(at, conversationId, taskId);
    }
    this.db.prepare(
      "UPDATE conversation_characters SET asset_id = NULL, confirmed = 0, updated_at = ? WHERE conversation_id = ? AND asset_id = ?",
    ).run(at, conversationId, assetId);
    this.db.prepare(
      "UPDATE conversation_scenes SET asset_id = NULL, confirmed = 0, updated_at = ? WHERE conversation_id = ? AND asset_id = ?",
    ).run(at, conversationId, assetId);
    if (taskRemoved) {
      this.db.prepare(
        "UPDATE conversation_characters SET task_id = NULL, confirmed = 0, updated_at = ? WHERE conversation_id = ? AND task_id = ?",
      ).run(at, conversationId, taskId);
      this.db.prepare(
        "UPDATE conversation_scenes SET task_id = NULL, confirmed = 0, updated_at = ? WHERE conversation_id = ? AND task_id = ?",
      ).run(at, conversationId, taskId);
    }
    this.db.prepare(
      "UPDATE conversations SET storyboard_reference_asset_id = NULL, storyboard_reference_mode = 'auto' WHERE id = ? AND storyboard_reference_asset_id = ?",
    ).run(conversationId, assetId);
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, conversationId);
    return { files, inputs, taskRemoved };
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
    libraryScope?: "public" | "conversation";
    ownerConversationId?: string;
    /** 上传的图生下来就是完成的，没有排队这一步 */
    status?: TaskStatus;
  }): TaskRow {
    const createdAt = now();
    this.db.prepare(`
      INSERT INTO tasks (id, channel_id, model, prompt, status, input_json, created_at, origin, library_scope, owner_conversation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.channelId, input.model, input.prompt,
      input.status ?? "queued", JSON.stringify(input.input), createdAt, input.origin ?? "generate", input.libraryScope ?? (input.origin === "upload" ? "legacy" : "public"), input.ownerConversationId ?? null,
    );
    return this.getTaskRow(input.id)!;
  }

  getTaskRow(id: string): TaskRow | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as DbRow | undefined;
    return row ? this.taskFromRow(row) : null;
  }

  taskHasConversationReferences(taskId: string): boolean {
    const assetIds = this.listAssets(taskId).map((asset) => asset.id);
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

  assetHasOtherConversationReferences(assetId: string, conversationId: string): boolean {
    if (this.db.prepare(`SELECT 1 FROM messages WHERE conversation_id <> ? AND (asset_id = ? OR asset_refs LIKE ?) LIMIT 1`).get(conversationId, assetId, `%${assetId}%`)) return true;
    if (this.db.prepare(`SELECT 1 FROM conversations WHERE id <> ? AND (current_asset_id = ? OR canvas_asset_ids LIKE ? OR storyboard_reference_asset_id = ?) LIMIT 1`).get(conversationId, assetId, `%${assetId}%`, assetId)) return true;
    if (this.db.prepare(`SELECT 1 FROM conversation_shots WHERE conversation_id <> ? AND (first_frame_asset_id = ? OR last_frame_asset_id = ? OR reference_asset_ids LIKE ?) LIMIT 1`).get(conversationId, assetId, assetId, `%${assetId}%`)) return true;
    return Boolean(this.db.prepare(`SELECT 1 FROM conversation_characters WHERE conversation_id <> ? AND asset_id = ? UNION ALL SELECT 1 FROM conversation_scenes WHERE conversation_id <> ? AND asset_id = ? LIMIT 1`).get(conversationId, assetId, conversationId, assetId));
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
    /** 缺省是普通对话；无限画布线程由 board 服务显式传 board */
    kind?: ConversationKind;
    boardId?: string | null;
  }): Conversation {
    const id = crypto.randomUUID();
    const at = now();
    this.db.prepare(`
      INSERT INTO conversations
      (id, title, kind, board_id, brain_channel_id, brain_model, current_asset_id, canvas_asset_ids, status,
       video_confirm_policy, vision_enabled, verbatim_prompt, auto_continue_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, '[]', 'idle', ?, ?, ?, 0, ?, ?)
    `).run(
      id, input.title, input.kind ?? "chat", input.boardId ?? null, input.brainChannelId, input.brainModel,
      input.videoConfirmPolicy, input.visionEnabled ? 1 : 0, input.verbatimPrompt ? 1 : 0, at, at,
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
    // 只清普通对话。无限画布线程刚建出来时也没有消息，但它不是空壳——
    // 放进这个清理里，用户新建一块板再点「新对话」就会把板的线程删掉。
    const rows = this.db.prepare(
      `SELECT conversations.id AS id FROM conversations
       WHERE conversations.kind = 'chat'
         AND NOT EXISTS (SELECT 1 FROM messages WHERE messages.conversation_id = conversations.id)`,
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
    shots: Array<{
      sourceText: string; prompt: string; kind: StoryboardShotKind; aspectRatio: string;
      character?: string; scene?: string;
      dialogue?: string; speaker?: string; shotSize?: string; cameraMove?: string;
      soundEffect?: string; durationSeconds?: number; videoPrompt?: string; voice?: string;
    }>,
    settings: {
      characters?: Array<{ name: string; prompt?: string }>;
      scenes?: Array<{ name: string; prompt?: string }>;
    } = {},
  ): StoryboardShot[] {
    const at = now();
    this.db.prepare("DELETE FROM conversation_shots WHERE conversation_id = ?").run(conversationId);
    // 重新拆镜会生成全新的 shot id；旧镜头的拖拽位置留着也没人再引用，顺手清掉
    this.db.prepare(
      "DELETE FROM conversation_graph_positions WHERE conversation_id = ? AND (node_id LIKE 'shot:%' OR node_id LIKE 'video:%' OR node_id LIKE 'voice:%')",
    ).run(conversationId);
    const insert = this.db.prepare(`
      INSERT INTO conversation_shots
      (id, conversation_id, shot_index, source_text, prompt, character_name, scene_name, kind, aspect_ratio,
       dialogue, speaker, shot_size, camera_move, sound_effect, duration_seconds, video_prompt, voice,
       task_id, video_task_id, voice_task_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
    `);
    for (const [position, shot] of shots.entries()) {
      insert.run(
        crypto.randomUUID(), conversationId, position + 1,
        shot.sourceText, shot.prompt, shot.character ?? "", shot.scene ?? "", shot.kind, shot.aspectRatio,
        shot.dialogue ?? "", shot.speaker ?? "", shot.shotSize ?? "", shot.cameraMove ?? "",
        shot.soundEffect ?? "", shot.durationSeconds ?? 5, shot.videoPrompt ?? "", shot.voice ?? "Kore",
        at, at,
      );
    }
    // 设定表里的名字和镜头里实际用到的名字取并集：模型偶尔会漏写一个设定，
    // 不能让那一镜变成「没有设定卡」的孤儿。
    this.upsertStoryboardCharacters(conversationId, [
      ...(settings.characters ?? []),
      ...shots.flatMap((shot) => parseCharacterNames(shot.character ?? "")).map((name) => ({ name })),
    ]);
    this.upsertStoryboardScenes(conversationId, [
      ...(settings.scenes ?? []),
      ...shots.map((shot) => shot.scene ?? "").filter(Boolean).map((name) => ({ name })),
    ]);
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, conversationId);
    return this.listStoryboardShots(conversationId);
  }

  /**
   * 把角色名补进 characters 表。`林小满、老陈` 会被拆成两个独立角色；
   * 同名角色已存在时只更新提示词（如果这次给了），不会清掉已绑定的设定图。
   */
  upsertStoryboardCharacters(conversationId: string, items: Array<string | { name: string; prompt?: string }>) {
    const seen = new Set<string>();
    const at = now();
    const insert = this.db.prepare(`
      INSERT INTO conversation_characters (id, conversation_id, name, prompt, asset_id, task_id, confirmed, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, NULL, 0, ?, ?)
      ON CONFLICT(conversation_id, name) DO UPDATE SET
        prompt = CASE WHEN excluded.prompt <> '' THEN excluded.prompt ELSE conversation_characters.prompt END,
        updated_at = excluded.updated_at
    `);
    for (const item of items) {
      const name = typeof item === "string" ? item : item.name;
      const prompt = typeof item === "string" ? "" : item.prompt?.trim() ?? "";
      for (const part of parseCharacterNames(name)) {
        if (seen.has(part)) continue;
        seen.add(part);
        insert.run(crypto.randomUUID(), conversationId, part, prompt, at, at);
      }
    }
  }

  upsertStoryboardScenes(conversationId: string, items: Array<string | { name: string; prompt?: string }>) {
    const seen = new Set<string>();
    const at = now();
    const insert = this.db.prepare(`
      INSERT INTO conversation_scenes (id, conversation_id, name, prompt, asset_id, task_id, confirmed, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, NULL, 0, ?, ?)
      ON CONFLICT(conversation_id, name) DO UPDATE SET
        prompt = CASE WHEN excluded.prompt <> '' THEN excluded.prompt ELSE conversation_scenes.prompt END,
        updated_at = excluded.updated_at
    `);
    for (const item of items) {
      const name = (typeof item === "string" ? item : item.name).trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const prompt = typeof item === "string" ? "" : item.prompt?.trim() ?? "";
      insert.run(crypto.randomUUID(), conversationId, name, prompt, at, at);
    }
  }

  listStoryboardCharacters(conversationId: string): Array<{
    id: string; name: string; prompt: string; voice: string; assetId: string | null; taskId: string | null;
    confirmed: boolean; createdAt: string; updatedAt: string;
  }> {
    const rows = this.db.prepare(
      "SELECT * FROM conversation_characters WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC",
    ).all(conversationId) as DbRow[];
    return rows.map((row) => ({
      id: String(row.id), name: String(row.name), prompt: String(row.prompt ?? ""),
      voice: String(row.voice ?? ""),
      assetId: row.asset_id == null ? null : String(row.asset_id),
      taskId: row.task_id == null ? null : String(row.task_id),
      confirmed: Boolean(row.confirmed),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }));
  }

  listStoryboardScenes(conversationId: string): Array<{
    id: string; name: string; prompt: string; assetId: string | null; taskId: string | null;
    confirmed: boolean; createdAt: string; updatedAt: string;
  }> {
    const rows = this.db.prepare(
      "SELECT * FROM conversation_scenes WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC",
    ).all(conversationId) as DbRow[];
    return rows.map((row) => ({
      id: String(row.id), name: String(row.name), prompt: String(row.prompt ?? ""),
      assetId: row.asset_id == null ? null : String(row.asset_id),
      taskId: row.task_id == null ? null : String(row.task_id),
      confirmed: Boolean(row.confirmed),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }));
  }

  getStoryboardCharacter(id: string): {
    id: string; conversationId: string; name: string; prompt: string; voice: string; assetId: string | null;
    taskId: string | null; confirmed: boolean;
  } | null {
    const row = this.db.prepare("SELECT * FROM conversation_characters WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) return null;
    return {
      id: String(row.id), conversationId: String(row.conversation_id), name: String(row.name),
      prompt: String(row.prompt ?? ""), voice: String(row.voice ?? ""),
      assetId: row.asset_id == null ? null : String(row.asset_id),
      taskId: row.task_id == null ? null : String(row.task_id), confirmed: Boolean(row.confirmed),
    };
  }

  getStoryboardScene(id: string): {
    id: string; conversationId: string; name: string; prompt: string; assetId: string | null;
    taskId: string | null; confirmed: boolean;
  } | null {
    const row = this.db.prepare("SELECT * FROM conversation_scenes WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) return null;
    return {
      id: String(row.id), conversationId: String(row.conversation_id), name: String(row.name),
      prompt: String(row.prompt ?? ""), assetId: row.asset_id == null ? null : String(row.asset_id),
      taskId: row.task_id == null ? null : String(row.task_id), confirmed: Boolean(row.confirmed),
    };
  }

  setStoryboardCharacterAsset(characterId: string, assetId: string | null) {
    // 换图后必须重新确认：旧图的确认不能顺延到新图
    this.db.prepare("UPDATE conversation_characters SET asset_id = ?, confirmed = 0, updated_at = ? WHERE id = ?")
      .run(assetId, now(), characterId);
  }

  setStoryboardSceneAsset(sceneId: string, assetId: string | null) {
    this.db.prepare("UPDATE conversation_scenes SET asset_id = ?, confirmed = 0, updated_at = ? WHERE id = ?")
      .run(assetId, now(), sceneId);
  }

  setStoryboardCharacterPrompt(characterId: string, prompt: string) {
    this.db.prepare("UPDATE conversation_characters SET prompt = ?, updated_at = ? WHERE id = ?")
      .run(prompt, now(), characterId);
  }

  setStoryboardCharacterVoice(characterId: string, voice: string) {
    this.db.prepare("UPDATE conversation_characters SET voice = ?, updated_at = ? WHERE id = ?")
      .run(voice, now(), characterId);
  }

  setStoryboardScenePrompt(sceneId: string, prompt: string) {
    this.db.prepare("UPDATE conversation_scenes SET prompt = ?, updated_at = ? WHERE id = ?")
      .run(prompt, now(), sceneId);
  }

  setStoryboardCharacterTask(characterId: string, taskId: string | null) {
    // 重生成时清掉手动绑定：否则「手动图优先」会让新生成的设定图永远显示不出来
    this.db.prepare("UPDATE conversation_characters SET task_id = ?, asset_id = NULL, confirmed = 0, updated_at = ? WHERE id = ?")
      .run(taskId, now(), characterId);
  }

  setStoryboardSceneTask(sceneId: string, taskId: string | null) {
    this.db.prepare("UPDATE conversation_scenes SET task_id = ?, asset_id = NULL, confirmed = 0, updated_at = ? WHERE id = ?")
      .run(taskId, now(), sceneId);
  }

  confirmStoryboardCharacter(characterId: string, confirmed: boolean) {
    this.db.prepare("UPDATE conversation_characters SET confirmed = ?, updated_at = ? WHERE id = ?")
      .run(confirmed ? 1 : 0, now(), characterId);
  }

  confirmStoryboardScene(sceneId: string, confirmed: boolean) {
    this.db.prepare("UPDATE conversation_scenes SET confirmed = ?, updated_at = ? WHERE id = ?")
      .run(confirmed ? 1 : 0, now(), sceneId);
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
             vt.status AS video_task_status, vt.error_message AS video_task_error,
             nt.status AS voice_task_status, nt.error_message AS voice_task_error,
             (SELECT a.id FROM assets a WHERE a.task_id = s.task_id ORDER BY a.created_at ASC, a.rowid ASC LIMIT 1) AS result_asset_id,
             (SELECT a.id FROM assets a WHERE a.task_id = s.video_task_id ORDER BY a.created_at ASC, a.rowid ASC LIMIT 1) AS video_result_asset_id,
             (SELECT a.id FROM assets a WHERE a.task_id = s.voice_task_id ORDER BY a.created_at ASC, a.rowid ASC LIMIT 1) AS voice_result_asset_id
      FROM conversation_shots s
      LEFT JOIN tasks t ON t.id = s.task_id
      LEFT JOIN tasks vt ON vt.id = s.video_task_id
      LEFT JOIN tasks nt ON nt.id = s.voice_task_id
      WHERE s.conversation_id = ?
      ORDER BY s.shot_index ASC
    `).all(conversationId) as DbRow[];
    const resolve = (taskIdValue: unknown, statusValue: unknown, errorValue: unknown, assetIdValue: unknown) => {
      const id = taskIdValue == null ? null : String(taskIdValue);
      const taskStatus = statusValue == null ? null : String(statusValue) as TaskStatus;
      const assetId = assetIdValue == null ? null : String(assetIdValue);
      const assetRow = assetId ? this.getAsset(assetId) : null;
      return {
        taskId: id,
        status: (id && taskStatus ? taskStatus : "planned") as StoryboardShotStatus,
        assetId: assetRow ? String(assetRow.id) : null,
        asset: assetRow ? this.assetView(assetRow) : null,
        errorMessage: errorValue == null ? null : String(errorValue),
      };
    };
    const resolveImage = (value: unknown): { id: string | null; asset: Asset | null } => {
      const id = value == null ? null : String(value);
      if (!id) return { id: null, asset: null };
      const asset = this.getAsset(id);
      return asset && isImageAsset(asset)
        ? { id: String(asset.id), asset: this.assetView(asset) }
        : { id: null, asset: null };
    };
    return rows.map((row) => {
      const image = resolve(row.task_id, row.task_status, row.task_error, row.result_asset_id);
      const video = resolve(row.video_task_id, row.video_task_status, row.video_task_error, row.video_result_asset_id);
      const voice = resolve(row.voice_task_id, row.voice_task_status, row.voice_task_error, row.voice_result_asset_id);
      const firstFrame = resolveImage(row.first_frame_asset_id);
      const lastFrame = resolveImage(row.last_frame_asset_id);
      const referenceAssetIds: string[] = [];
      const referenceAssets: Asset[] = [];
      for (const id of stringArrayFromJson(row.reference_asset_ids)) {
        const resolved = resolveImage(id);
        if (!resolved.id || !resolved.asset) continue;
        referenceAssetIds.push(resolved.id);
        referenceAssets.push(resolved.asset);
      }
      return {
        id: String(row.id), conversationId: String(row.conversation_id),
        index: Number(row.shot_index),
        sourceText: String(row.source_text ?? ""), prompt: String(row.prompt ?? ""),
        character: String(row.character_name ?? ""),
        characters: parseCharacterNames(String(row.character_name ?? "")),
        scene: String(row.scene_name ?? ""),
        kind: String(row.kind) === "video" ? "video" as const : "image" as const,
        aspectRatio: String(row.aspect_ratio ?? ""),
        dialogue: String(row.dialogue ?? ""),
        speaker: String(row.speaker ?? ""),
        shotSize: String(row.shot_size ?? ""),
        cameraMove: String(row.camera_move ?? ""),
        soundEffect: String(row.sound_effect ?? ""),
        durationSeconds: Number(row.duration_seconds ?? 5),
        videoPrompt: String(row.video_prompt ?? ""),
        voice: String(row.voice ?? "Kore"),
        videoMode: (row.video_mode === "first-last-frame" || row.video_mode === "reference"
          ? row.video_mode : "first-frame") as StoryboardVideoMode,
        firstFrameAssetId: firstFrame.id, firstFrameAsset: firstFrame.asset,
        lastFrameAssetId: lastFrame.id, lastFrameAsset: lastFrame.asset,
        referenceAssetIds, referenceAssets,
        parentShotId: row.parent_shot_id == null ? null : String(row.parent_shot_id),
        taskId: image.taskId, status: image.status,
        assetId: image.assetId, asset: image.asset, errorMessage: image.errorMessage,
        videoTaskId: video.taskId, videoStatus: video.status,
        videoAssetId: video.assetId, videoAsset: video.asset, videoErrorMessage: video.errorMessage,
        voiceTaskId: voice.taskId, voiceStatus: voice.status,
        voiceAssetId: voice.assetId, voiceAsset: voice.asset, voiceErrorMessage: voice.errorMessage,
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
    patch: Partial<Pick<StoryboardShot,
      | "prompt" | "sourceText" | "character" | "scene" | "kind" | "aspectRatio"
      | "dialogue" | "speaker" | "shotSize" | "cameraMove" | "soundEffect"
      | "durationSeconds" | "videoPrompt" | "voice" | "videoMode"
      | "firstFrameAssetId" | "lastFrameAssetId" | "referenceAssetIds" | "parentShotId"
      | "taskId" | "videoTaskId" | "voiceTaskId">>,
  ): StoryboardShot | null {
    const fields: string[] = [];
    const values: Array<string | number | null> = [];
    const mapping: Record<string, string> = {
      prompt: "prompt", sourceText: "source_text", character: "character_name", scene: "scene_name",
      kind: "kind", aspectRatio: "aspect_ratio", taskId: "task_id",
      dialogue: "dialogue", speaker: "speaker", shotSize: "shot_size", cameraMove: "camera_move",
      soundEffect: "sound_effect", durationSeconds: "duration_seconds", videoPrompt: "video_prompt",
      voice: "voice", videoMode: "video_mode",
      firstFrameAssetId: "first_frame_asset_id", lastFrameAssetId: "last_frame_asset_id",
      referenceAssetIds: "reference_asset_ids", parentShotId: "parent_shot_id",
      videoTaskId: "video_task_id", voiceTaskId: "voice_task_id",
    };
    for (const [key, column] of Object.entries(mapping)) {
      if (!(key in patch)) continue;
      fields.push(`${column} = ?`);
      const value = (patch as Record<string, unknown>)[key];
      if (Array.isArray(value)) values.push(JSON.stringify(value));
      else values.push(typeof value === "number" ? value : (value ?? null) as string | null);
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

  /** 镜头图里用户拖动过的节点坐标；没记录的节点继续走自动布局 */
  listStoryboardGraphPositions(conversationId: string): Record<string, { x: number; y: number }> {
    const rows = this.db.prepare(
      "SELECT node_id, x, y FROM conversation_graph_positions WHERE conversation_id = ?",
    ).all(conversationId) as DbRow[];
    const result: Record<string, { x: number; y: number }> = {};
    for (const row of rows) {
      result[String(row.node_id)] = { x: Number(row.x), y: Number(row.y) };
    }
    return result;
  }

  saveStoryboardGraphPositions(
    conversationId: string,
    positions: Array<{ id: string; x: number; y: number }>,
  ): void {
    if (!positions.length) return;
    const at = now();
    const upsert = this.db.prepare(`
      INSERT INTO conversation_graph_positions (conversation_id, node_id, x, y, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, node_id) DO UPDATE SET
        x = excluded.x, y = excluded.y, updated_at = excluded.updated_at
    `);
    this.db.exec("BEGIN");
    try {
      for (const position of positions) {
        upsert.run(conversationId, position.id, position.x, position.y, at);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, conversationId);
  }

  clearStoryboardGraphPositions(conversationId: string): number {
    const result = this.db.prepare(
      "DELETE FROM conversation_graph_positions WHERE conversation_id = ?",
    ).run(conversationId);
    return Number(result.changes ?? 0);
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
    this.db.prepare("DELETE FROM conversation_characters WHERE conversation_id = ?").run(conversationId);
    this.db.prepare("DELETE FROM conversation_scenes WHERE conversation_id = ?").run(conversationId);
    this.db.prepare("DELETE FROM conversation_graph_positions WHERE conversation_id = ?").run(conversationId);
    return Number(result.changes ?? 0);
  }

  /**
   * 在末尾追加一镜。
   *
   * 默认沿用最后一镜的画幅，避免新镜头和其他镜头一个横一个竖；描述留空，
   * 由用户在面板里填——这里不替用户编画面，也不提交任何任务。
   */
  addStoryboardShot(conversationId: string, input: {
    prompt?: string; character?: string; scene?: string; aspectRatio?: string;
    dialogue?: string; speaker?: string; shotSize?: string; cameraMove?: string;
    soundEffect?: string; durationSeconds?: number; videoPrompt?: string; voice?: string;
    videoMode?: StoryboardVideoMode; firstFrameAssetId?: string | null; lastFrameAssetId?: string | null;
    referenceAssetIds?: string[]; parentShotId?: string | null;
  } = {}): StoryboardShot {
    const last = this.db.prepare(
      "SELECT shot_index, aspect_ratio FROM conversation_shots WHERE conversation_id = ? ORDER BY shot_index DESC LIMIT 1",
    ).get(conversationId) as DbRow | undefined;
    const index = Number(last?.shot_index ?? 0) + 1;
    const aspectRatio = input.aspectRatio ?? (last?.aspect_ratio == null ? "" : String(last.aspect_ratio));
    const id = crypto.randomUUID();
    const at = now();
    this.db.prepare(`
      INSERT INTO conversation_shots
      (id, conversation_id, shot_index, source_text, prompt, character_name, scene_name, kind, aspect_ratio,
       dialogue, speaker, shot_size, camera_move, sound_effect, duration_seconds, video_prompt, voice,
       video_mode, first_frame_asset_id, last_frame_asset_id, reference_asset_ids, parent_shot_id,
       task_id, video_task_id, voice_task_id, created_at, updated_at)
      VALUES (?, ?, ?, '', ?, ?, ?, 'image', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
    `).run(
      id, conversationId, index, input.prompt ?? "", input.character ?? "", input.scene ?? "",
      aspectRatio, input.dialogue ?? "", input.speaker ?? "", input.shotSize ?? "", input.cameraMove ?? "",
      input.soundEffect ?? "", input.durationSeconds ?? 5, input.videoPrompt ?? "", input.voice ?? "Kore",
      input.videoMode ?? "first-frame", input.firstFrameAssetId ?? null, input.lastFrameAssetId ?? null,
      JSON.stringify(input.referenceAssetIds ?? []), input.parentShotId ?? null,
      at, at,
    );
    if (input.character) this.upsertStoryboardCharacters(conversationId, [input.character]);
    if (input.scene) this.upsertStoryboardScenes(conversationId, [input.scene]);
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, conversationId);
    return this.getStoryboardShot(id)!;
  }

  /**
   * 删除一镜，并把后面的镜号往前挪。
   *
   * 镜号是用户和大脑共同引用的坐标（「第 7 镜」），留着空洞会让「第 7 镜」
   * 指向一个已经不存在的位置；这里直接重排成连续的 1..N。
   */
  deleteStoryboardShot(shotId: string): { conversationId: string; index: number } | null {
    const row = this.db.prepare(
      "SELECT conversation_id, shot_index FROM conversation_shots WHERE id = ?",
    ).get(shotId) as DbRow | undefined;
    if (!row) return null;
    const conversationId = String(row.conversation_id);
    const index = Number(row.shot_index);
    const at = now();
    this.db.prepare("DELETE FROM conversation_shots WHERE id = ?").run(shotId);
    this.db.prepare(
      "DELETE FROM conversation_graph_positions WHERE conversation_id = ? AND node_id IN (?, ?, ?)",
    ).run(conversationId, `shot:${shotId}`, `video:${shotId}`, `voice:${shotId}`);
    this.db.prepare(
      "UPDATE conversation_shots SET parent_shot_id = NULL WHERE conversation_id = ? AND parent_shot_id = ?",
    ).run(conversationId, shotId);
    this.db.prepare(
      "UPDATE conversation_shots SET shot_index = shot_index - 1 WHERE conversation_id = ? AND shot_index > ?",
    ).run(conversationId, index);
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, conversationId);
    return { conversationId, index };
  }

  /**
   * 删除角色设定，并把它从所有镜头的角色标签里摘掉。
   *
   * 只删设定卡、不清理镜头的后果很具体：镜头仍然写着「小雨」，但左侧已经没有
   * 小雨的卡，生成时会被判成「角色还没有设定图」，整批卡住。
   */
  deleteStoryboardCharacter(characterId: string): { conversationId: string; name: string } | null {
    const row = this.db.prepare(
      "SELECT conversation_id, name FROM conversation_characters WHERE id = ?",
    ).get(characterId) as DbRow | undefined;
    if (!row) return null;
    const conversationId = String(row.conversation_id);
    const name = String(row.name);
    const at = now();
    this.db.prepare("DELETE FROM conversation_characters WHERE id = ?").run(characterId);
    this.db.prepare(
      "DELETE FROM conversation_graph_positions WHERE conversation_id = ? AND node_id = ?",
    ).run(conversationId, `character:${characterId}`);

    const shots = this.db.prepare(
      "SELECT id, character_name FROM conversation_shots WHERE conversation_id = ?",
    ).all(conversationId) as DbRow[];
    const update = this.db.prepare(
      "UPDATE conversation_shots SET character_name = ?, updated_at = ? WHERE id = ?",
    );
    for (const shot of shots) {
      const names = parseCharacterNames(String(shot.character_name ?? ""));
      if (!names.includes(name)) continue;
      update.run(joinCharacterNames(names.filter((item) => item !== name)), at, String(shot.id));
    }
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, conversationId);
    return { conversationId, name };
  }

  /** 删除场景设定；引用这个场景的镜头清空 scene_name（空镜仍然可以生成） */
  deleteStoryboardScene(sceneId: string): { conversationId: string; name: string } | null {
    const row = this.db.prepare(
      "SELECT conversation_id, name FROM conversation_scenes WHERE id = ?",
    ).get(sceneId) as DbRow | undefined;
    if (!row) return null;
    const conversationId = String(row.conversation_id);
    const name = String(row.name);
    const at = now();
    this.db.prepare("DELETE FROM conversation_scenes WHERE id = ?").run(sceneId);
    this.db.prepare(
      "DELETE FROM conversation_graph_positions WHERE conversation_id = ? AND node_id = ?",
    ).run(conversationId, `scene:${sceneId}`);
    this.db.prepare(
      "UPDATE conversation_shots SET scene_name = '', updated_at = ? WHERE conversation_id = ? AND scene_name = ?",
    ).run(at, conversationId, name);
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, conversationId);
    return { conversationId, name };
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
    // 无限画布线程的生命周期跟着板走，不能从对话删除入口直接删
    const kindRow = this.db.prepare("SELECT kind FROM conversations WHERE id = ?").get(id) as DbRow | undefined;
    if (kindRow && String(kindRow.kind) === "board") {
      throw new Error("无限画布线程不能按对话删除");
    }
    const uploads = this.db.prepare(`
      SELECT DISTINCT tasks.id AS id FROM messages
      JOIN assets ON assets.id = messages.asset_id
      JOIN tasks ON tasks.id = assets.task_id
      WHERE messages.conversation_id = ? AND tasks.origin = 'upload'
      UNION
      SELECT DISTINCT tasks.id AS id FROM conversation_characters c
      JOIN assets ON assets.id = c.asset_id
      JOIN tasks ON tasks.id = assets.task_id
      WHERE c.conversation_id = ? AND tasks.origin = 'upload'
      UNION
      SELECT DISTINCT tasks.id AS id FROM conversation_scenes s
      JOIN assets ON assets.id = s.asset_id
      JOIN tasks ON tasks.id = assets.task_id
      WHERE s.conversation_id = ? AND tasks.origin = 'upload'
      UNION
      SELECT DISTINCT tasks.id AS id FROM conversation_shots s
      JOIN assets ON assets.id IN (s.first_frame_asset_id, s.last_frame_asset_id)
      JOIN tasks ON tasks.id = assets.task_id
      WHERE s.conversation_id = ? AND tasks.origin = 'upload'
      UNION
      SELECT DISTINCT tasks.id AS id FROM conversation_shots s
      JOIN assets ON s.reference_asset_ids LIKE '%' || assets.id || '%'
      JOIN tasks ON tasks.id = assets.task_id
      WHERE s.conversation_id = ? AND tasks.origin = 'upload'
    `).all(id, id, id, id, id) as DbRow[];

    const assets: StoredFileRef[] = [];
    for (const row of uploads) {
      const taskId = String(row.id);
      const task = this.getTaskRow(taskId);
      if (task?.libraryScope === "public" || this.listAssets(taskId).some((asset) => this.findBoardAssetRefs(asset.id).length > 0 || this.assetHasOtherConversationReferences(asset.id, id))) continue;
      assets.push(...this.deleteTask(taskId).assets);
    }
    this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM conversation_documents WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM conversation_shots WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM conversation_characters WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM conversation_scenes WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM conversation_graph_positions WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM brain_calls WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    return { assets };
  }

  // ── 无限画布（FREE_CANVAS_PLAN.md） ─────────────────────────────────────────

  createCanvasTemplate(input: {
    id: string;
    name: string;
    description: string;
    source: CanvasTemplate["source"];
    conversationId?: string | null;
    doc: BoardDoc;
  }): CanvasTemplate {
    const at = now();
    this.db.prepare(`
      INSERT INTO canvas_templates (id, name, description, source, conversation_id, doc_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.name, input.description, input.source,
      input.conversationId ?? null, JSON.stringify(input.doc), at,
    );
    return {
      id: input.id,
      name: input.name,
      description: input.description,
      source: input.source,
      doc: input.doc,
      createdAt: at,
    };
  }

  getCanvasTemplate(id: string): CanvasTemplate | null {
    const row = this.db.prepare("SELECT * FROM canvas_templates WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description ?? ""),
      source: String(row.source ?? "agent") as CanvasTemplate["source"],
      doc: parseBoardDoc(parseJson(row.doc_json, createEmptyBoardDoc())),
      createdAt: String(row.created_at),
    };
  }

  findCanvasTemplateByConversation(conversationId: string, source?: CanvasTemplate["source"]): CanvasTemplate | null {
    const row = this.db.prepare(`
      SELECT id FROM canvas_templates
      WHERE conversation_id = ? ${source ? "AND source = ?" : ""}
      ORDER BY created_at DESC LIMIT 1
    `).get(...(source ? [conversationId, source] : [conversationId])) as DbRow | undefined;
    return row ? this.getCanvasTemplate(String(row.id)) : null;
  }

  updateCanvasTemplate(id: string, patch: { name?: string; description?: string }): CanvasTemplate | null {
    const current = this.getCanvasTemplate(id);
    if (!current) return null;
    const name = patch.name?.trim() ? patch.name.trim().slice(0, 80) : current.name;
    const description = patch.description === undefined ? current.description : patch.description.trim().slice(0, 500);
    this.db.prepare("UPDATE canvas_templates SET name = ?, description = ? WHERE id = ?")
      .run(name, description, id);
    return this.getCanvasTemplate(id);
  }

  deleteCanvasTemplate(id: string): boolean {
    const result = this.db.prepare("DELETE FROM canvas_templates WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  listCanvasTemplateSummaries(limit = 50): CanvasTemplateSummary[] {
    const rows = this.db.prepare(
      "SELECT * FROM canvas_templates ORDER BY created_at DESC LIMIT ?",
    ).all(Math.min(200, Math.max(1, limit))) as DbRow[];
    return rows.map((row) => {
      const doc = parseBoardDoc(parseJson(row.doc_json, createEmptyBoardDoc()));
      return {
        id: String(row.id),
        name: String(row.name),
        description: String(row.description ?? ""),
        source: String(row.source ?? "agent") as CanvasTemplate["source"],
        nodeCount: doc.nodes.length,
        groupCount: boardGroups(doc).length,
        createdAt: String(row.created_at),
      };
    });
  }

  listStoryboardConversationIds(): string[] {
    const rows = this.db.prepare(
      "SELECT DISTINCT conversation_id FROM conversation_shots ORDER BY conversation_id",
    ).all() as DbRow[];
    return rows.map((row) => String(row.conversation_id));
  }

  getStoryboardMigration(conversationId: string): {
    conversationId: string; boardId: string; templateId: string; version: number; createdAt: string;
  } | null {
    const row = this.db.prepare(
      "SELECT * FROM storyboard_migrations WHERE conversation_id = ?",
    ).get(conversationId) as DbRow | undefined;
    if (!row) return null;
    return {
      conversationId: String(row.conversation_id),
      boardId: String(row.board_id),
      templateId: String(row.template_id),
      version: Number(row.version ?? 1),
      createdAt: String(row.created_at),
    };
  }

  listStoryboardMigrations(): Array<{
    conversationId: string; boardId: string; templateId: string; version: number; createdAt: string;
  }> {
    const rows = this.db.prepare("SELECT * FROM storyboard_migrations ORDER BY created_at ASC").all() as DbRow[];
    return rows.map((row) => ({
      conversationId: String(row.conversation_id),
      boardId: String(row.board_id),
      templateId: String(row.template_id),
      version: Number(row.version ?? 1),
      createdAt: String(row.created_at),
    }));
  }

  saveStoryboardMigration(input: {
    conversationId: string; boardId: string; templateId: string; version: number;
  }): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO storyboard_migrations
      (conversation_id, board_id, template_id, version, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.conversationId, input.boardId, input.templateId, input.version, now());
  }

  createBoardRecord = (...args: Parameters<BoardRepository["createBoardRecord"]>): ReturnType<BoardRepository["createBoardRecord"]> => this.boards.createBoardRecord(...args);
  getBoardRecord = (...args: Parameters<BoardRepository["getBoardRecord"]>): ReturnType<BoardRepository["getBoardRecord"]> => this.boards.getBoardRecord(...args);
  listBoardRecords = (...args: Parameters<BoardRepository["listBoardRecords"]>): ReturnType<BoardRepository["listBoardRecords"]> => this.boards.listBoardRecords(...args);
  listBoardSummaries = (...args: Parameters<BoardRepository["listBoardSummaries"]>): ReturnType<BoardRepository["listBoardSummaries"]> => this.boards.listBoardSummaries(...args);
  getBoardByThread = (...args: Parameters<BoardRepository["getBoardByThread"]>): ReturnType<BoardRepository["getBoardByThread"]> => this.boards.getBoardByThread(...args);
  updateBoardTitle = (...args: Parameters<BoardRepository["updateBoardTitle"]>): ReturnType<BoardRepository["updateBoardTitle"]> => this.boards.updateBoardTitle(...args);
  saveBoardSnapshot = (...args: Parameters<BoardRepository["saveBoardSnapshot"]>): ReturnType<BoardRepository["saveBoardSnapshot"]> => this.boards.saveBoardSnapshot(...args);
  moveBoardVersion = (...args: Parameters<BoardRepository["moveBoardVersion"]>): ReturnType<BoardRepository["moveBoardVersion"]> => this.boards.moveBoardVersion(...args);
  listBoardHistoryVersions = (...args: Parameters<BoardRepository["listBoardHistoryVersions"]>): ReturnType<BoardRepository["listBoardHistoryVersions"]> => this.boards.listBoardHistoryVersions(...args);
  listBoardHistoryEntries = (...args: Parameters<BoardRepository["listBoardHistoryEntries"]>): ReturnType<BoardRepository["listBoardHistoryEntries"]> => this.boards.listBoardHistoryEntries(...args);
  getBoardHistoryDoc = (...args: Parameters<BoardRepository["getBoardHistoryDoc"]>): ReturnType<BoardRepository["getBoardHistoryDoc"]> => this.boards.getBoardHistoryDoc(...args);
  saveBoardViewport = (...args: Parameters<BoardRepository["saveBoardViewport"]>): ReturnType<BoardRepository["saveBoardViewport"]> => this.boards.saveBoardViewport(...args);
  saveBoardSelection = (...args: Parameters<BoardRepository["saveBoardSelection"]>): ReturnType<BoardRepository["saveBoardSelection"]> => this.boards.saveBoardSelection(...args);
  saveBoardUiState = (...args: Parameters<BoardRepository["saveBoardUiState"]>): ReturnType<BoardRepository["saveBoardUiState"]> => this.boards.saveBoardUiState(...args);
  listBoardAssets = (...args: Parameters<BoardRepository["listBoardAssets"]>): ReturnType<BoardRepository["listBoardAssets"]> => this.boards.listBoardAssets(...args);
  insertBoardAssetLink = (...args: Parameters<BoardRepository["insertBoardAssetLink"]>): ReturnType<BoardRepository["insertBoardAssetLink"]> => this.boards.insertBoardAssetLink(...args);
  findBoardAssetRefs = (...args: Parameters<BoardRepository["findBoardAssetRefs"]>): ReturnType<BoardRepository["findBoardAssetRefs"]> => this.boards.findBoardAssetRefs(...args);
  deleteBoardCascade = (...args: Parameters<BoardRepository["deleteBoardCascade"]>): ReturnType<BoardRepository["deleteBoardCascade"]> => this.boards.deleteBoardCascade(...args);
  addBoardTaskRows = (...args: Parameters<BoardRepository["addBoardTaskRows"]>): ReturnType<BoardRepository["addBoardTaskRows"]> => this.boards.addBoardTaskRows(...args);
  listBoardTasksByTask = (...args: Parameters<BoardRepository["listBoardTasksByTask"]>): ReturnType<BoardRepository["listBoardTasksByTask"]> => this.boards.listBoardTasksByTask(...args);
  listBoardTasksByBoard = (...args: Parameters<BoardRepository["listBoardTasksByBoard"]>): ReturnType<BoardRepository["listBoardTasksByBoard"]> => this.boards.listBoardTasksByBoard(...args);
  deleteBoardTaskRows = (...args: Parameters<BoardRepository["deleteBoardTaskRows"]>): ReturnType<BoardRepository["deleteBoardTaskRows"]> => this.boards.deleteBoardTaskRows(...args);

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
      UNION ALL
      SELECT assets.*, s.shot_index AS shot_index, s.video_prompt AS shot_prompt
      FROM conversation_shots s
      JOIN assets ON assets.task_id = s.video_task_id
      WHERE s.conversation_id = ?
      UNION ALL
      SELECT assets.*, s.shot_index AS shot_index, s.dialogue AS shot_prompt
      FROM conversation_shots s
      JOIN assets ON assets.task_id = s.voice_task_id
      WHERE s.conversation_id = ?
      ORDER BY shot_index ASC, assets.created_at ASC
    `).all(conversationId, conversationId, conversationId) as DbRow[];
    return rows.map((row) => ({ asset: this.assetFromRow(row), index: Number(row.shot_index), prompt: String(row.shot_prompt ?? "") }));
  }

  /** 角色 / 场景设定图（手动绑定的，或最近一次生成任务产出的） */
  listStoryboardSettingAssets(conversationId: string): Array<{ asset: AssetRow; label: string }> {
    const rows = this.db.prepare(`
      SELECT assets.*, '角色「' || c.name || '」' AS setting_label, 0 AS sort_group
      FROM conversation_characters c JOIN assets ON assets.id = c.asset_id
      WHERE c.conversation_id = ?
      UNION ALL
      SELECT assets.*, '角色「' || c.name || '」' AS setting_label, 0 AS sort_group
      FROM conversation_characters c JOIN assets ON assets.task_id = c.task_id
      WHERE c.conversation_id = ?
      UNION ALL
      SELECT assets.*, '场景「' || s.name || '」' AS setting_label, 1 AS sort_group
      FROM conversation_scenes s JOIN assets ON assets.id = s.asset_id
      WHERE s.conversation_id = ?
      UNION ALL
      SELECT assets.*, '场景「' || s.name || '」' AS setting_label, 1 AS sort_group
      FROM conversation_scenes s JOIN assets ON assets.task_id = s.task_id
      WHERE s.conversation_id = ?
      ORDER BY sort_group ASC, created_at ASC
    `).all(conversationId, conversationId, conversationId, conversationId) as DbRow[];
    const seen = new Set<string>();
    const result: Array<{ asset: AssetRow; label: string }> = [];
    for (const row of rows) {
      const id = String(row.id);
      if (seen.has(id)) continue;
      seen.add(id);
      result.push({ asset: this.assetFromRow(row), label: String(row.setting_label ?? "设定图") });
    }
    return result;
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
    // 视频输入图（首帧 / 尾帧 / 参考图）也要进会话素材：尾帧续写截出来的图、
    // 手动指定的参考图都应该能在素材库和输入选择器里找得到。
    const frameRows = this.db.prepare(`
      SELECT assets.*, s.shot_index AS shot_index, '首帧' AS frame_label
      FROM conversation_shots s JOIN assets ON assets.id = s.first_frame_asset_id
      WHERE s.conversation_id = ?
      UNION ALL
      SELECT assets.*, s.shot_index AS shot_index, '尾帧' AS frame_label
      FROM conversation_shots s JOIN assets ON assets.id = s.last_frame_asset_id
      WHERE s.conversation_id = ?
      ORDER BY shot_index ASC, created_at ASC
    `).all(conversationId, conversationId) as DbRow[];
    for (const row of frameRows) {
      const asset = this.assetFromRow(row);
      if (seen.has(asset.id)) continue;
      seen.add(asset.id);
      entries.push({
        asset, round: Number(row.shot_index),
        prompt: `第 ${Number(row.shot_index)} 镜${String(row.frame_label ?? "首帧")}`,
        source: "storyboard",
      });
    }
    const referenceRows = this.db.prepare(
      "SELECT shot_index, reference_asset_ids FROM conversation_shots WHERE conversation_id = ? AND reference_asset_ids <> '[]'",
    ).all(conversationId) as DbRow[];
    for (const row of referenceRows) {
      for (const assetId of stringArrayFromJson(row.reference_asset_ids)) {
        if (seen.has(assetId)) continue;
        const asset = this.getAsset(assetId);
        if (!asset || !isImageAsset(asset)) continue;
        seen.add(assetId);
        entries.push({
          asset, round: Number(row.shot_index),
          prompt: `第 ${Number(row.shot_index)} 镜参考图`,
          source: "storyboard",
        });
      }
    }
    // 角色 / 场景设定图也进「本会话的图」：上传或生成之后，其它设定卡的下拉里也能选到
    for (const entry of this.listStoryboardSettingAssets(conversationId)) {
      if (seen.has(entry.asset.id)) continue;
      seen.add(entry.asset.id);
      entries.push({ asset: entry.asset, round: 0, prompt: entry.label, source: "setting" });
    }
    // 从无限画布桥接过来的参考图：没有消息行，也不属于分镜 / 设定，但只要还在
    // canvasAssetIds 里就必须能被渲染、被 resolveAssetRef 认出来
    const conversation = this.getConversation(conversationId);
    for (const assetId of conversation?.canvasAssetIds ?? []) {
      if (seen.has(assetId)) continue;
      const asset = this.getAsset(assetId);
      if (!asset || !isImageAsset(asset)) continue;
      seen.add(assetId);
      entries.push({
        asset, round: 0,
        prompt: "从无限画布加入的参考图",
        source: "bridge",
      });
    }
    return entries;
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

  listLibraryTaskViews(options?: { limit: number; offset: number; query: string; kind: "all" | "image" | "video" | "audio"; mode: "all" | "assets" | "records" }): Task[] {
    const videoTypes = VIDEO_ADAPTER_TYPES.map((value) => `'${value}'`).join(",");
    const audioTypes = AUDIO_ADAPTER_TYPES.map((value) => `'${value}'`).join(",");
    const kindSql = `(CASE WHEN channels.adapter_type IN (${videoTypes}) THEN 'video' WHEN channels.adapter_type IN (${audioTypes}) THEN 'audio' WHEN channels.adapter_type IS NOT NULL THEN 'image' WHEN EXISTS (SELECT 1 FROM assets k WHERE k.task_id = tasks.id AND k.mime_type LIKE 'audio/%') THEN 'audio' WHEN EXISTS (SELECT 1 FROM assets k WHERE k.task_id = tasks.id AND k.mime_type LIKE 'video/%') THEN 'video' ELSE 'image' END)`;
    const query = options?.query.trim().toLowerCase() ?? "";
    const rows = this.db.prepare(`
      SELECT tasks.*, COALESCE(channels.name, '已删除渠道') AS channel_name,
             channels.adapter_type AS channel_adapter_type
      FROM tasks LEFT JOIN channels ON channels.id = tasks.channel_id
      WHERE (tasks.library_scope = 'public' OR (tasks.library_scope = 'legacy' AND (
        EXISTS (SELECT 1 FROM board_tasks bt WHERE bt.task_id = tasks.id)
        OR EXISTS (SELECT 1 FROM assets a JOIN board_assets ba ON ba.asset_id = a.id WHERE a.task_id = tasks.id)
        OR (tasks.origin = 'upload' AND tasks.prompt = '无限画布上传')
        OR (tasks.origin = 'generate'
          AND NOT EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id LEFT JOIN assets a ON a.id = m.asset_id WHERE c.kind = 'chat' AND (m.task_id = tasks.id OR a.task_id = tasks.id))
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
    return rows.map((row) => this.taskView(this.taskFromRow(row)));
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
      endpoint: String(row.endpoint ?? ""), uploadEndpoint: String(row.upload_endpoint ?? ""), uploadHeaders: parseJson(row.upload_headers_json, {}), models: parseJson(row.models_json, []),
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
      libraryScope: (row.library_scope == null ? "legacy" : String(row.library_scope)) as TaskLibraryScope,
      ownerConversationId: row.owner_conversation_id == null ? null : String(row.owner_conversation_id),
    };
  }
}

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
  /** 上游附加元数据 JSON（Midjourney 按钮等） */
  remoteMeta: string | null;
  inputJson: string; effectiveJson: string | null; attemptCount: number; errorCode: string | null;
  errorMessage: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null;
  origin: TaskOrigin;
  libraryScope: TaskLibraryScope;
  ownerConversationId: string | null;
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
