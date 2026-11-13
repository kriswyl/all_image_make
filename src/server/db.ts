import { DatabaseSync } from "node:sqlite";
import { BUILTIN_STYLE_PRESETS, type StylePreset, type StylePresetInput } from "../shared/style-presets.js";
import fs from "node:fs";
import path from "node:path";
import type { ChannelInput, Diagnostic, Task, Asset, TaskKind } from "../shared/types.js";
import { isImageAsset } from "../shared/types.js";
import { initializeSchema } from "./db-schema.js";
import { WorkflowStore } from "./workflow-store.js";
import { ExecutionStore } from "./execution-store.js";
import { PresentationSpecStore } from "./presentation-spec-store.js";
import type { CandidateMeta, PendingPublish } from "../shared/document-publish.js";
import { BoardRepository } from "./db-board.js";
import { CanvasTemplateRepository, type CreateCanvasTemplateInput } from "./db-canvas-templates.js";
import {
  StoryboardRepository, type CreateStoryboardShotInput, type ReplaceStoryboardShots,
  type SaveStoryboardMigrationInput, type StoryboardSettings, type StoryboardShotPatch,
} from "./db-storyboards.js";
import { AssetRepository, type AssetRow, type InsertAssetInput, type StoredFileRef } from "./db-assets.js";
import { TaskRepository, type CreateTaskInput, type InsertDiagnosticInput, type LibraryTaskQuery, type TaskOrigin, type TaskPatch, type TaskRow } from "./db-tasks.js";
import { canvasIdsFromRow, now, parseJson, stringArrayFromJson, type DbRow } from "./db-row.js";
import { ConversationRepository, type CreateConversationInput } from "./db-conversations.js";
import { ConversationMessageRepository, type AppendMessageInput, type MessagePatch } from "./db-conversation-messages.js";
import { ConfigurationRepository, type DbChannel } from "./db-config.js";
import {
  DocumentRepository, initializeLegacyWorkspace,
  type CreateCandidateRecord, type PendingVisualPublishRecord, type PublishCandidateRecord, type StoredDocument,
} from "./db-documents.js";
import type {
  ChatMessage, Conversation, ConversationPatch, ConversationStatus, ConversationUsage, ToolResult,
} from "../shared/agent-types.js";
import type { StoryboardShot } from "../shared/storyboard.js";
import type { BoardDoc, BoardUiState, BoardViewport } from "../shared/board.js";
import type { CanvasTemplate, CanvasTemplateSummary } from "../shared/canvas-template.js";
import type { PresentationVersionReport, PresentationVisualCheck, TemplateReport } from "../shared/presentation-report.js";
import type { StoryboardProject, StoryboardProjectData } from "../shared/storyboard-project.js";

export type { DbChannel } from "./db-config.js";
export type { StoredDocument } from "./db-documents.js";
export type { AssetRow, StoredFileRef } from "./db-assets.js";
export type { TaskLibraryScope, TaskOrigin, TaskRow } from "./db-tasks.js";

/** 会话产物的来源：正常生成、用户上传、分镜面板提交，或角色/场景设定图 */
export type ConversationAssetSource = TaskOrigin | "storyboard" | "setting" | "bridge";

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

/** 风格模板的领域错误：db 层不依赖 AppError，路由层再翻成 HTTP 状态码 */
export class StylePresetError extends Error {
  constructor(public readonly code: "STYLE_NOT_FOUND" | "STYLE_BUILTIN", message: string) { super(message); }
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
  /** 文档产物目录；每份文档记录自己的 base_dir，切目录不会让旧文件失联 */
  readonly defaultDocumentsDir: string;
  private currentDocumentsDir: string;
  private readonly db: DatabaseSync;
  private readonly boards: BoardRepository;
  private readonly canvasTemplates: CanvasTemplateRepository;
  private readonly storyboards: StoryboardRepository;
  private readonly tasks: TaskRepository;
  private readonly assets: AssetRepository;
  private readonly config: ConfigurationRepository;
  private readonly documents: DocumentRepository;
  private readonly conversations: ConversationRepository;
  private readonly conversationMessages: ConversationMessageRepository;
  readonly workflows: WorkflowStore;
  readonly executions: ExecutionStore;
  readonly specs: PresentationSpecStore;

  /** 产物目录可以在运行时改，所以是 getter 而不是 readonly 字段 */
  get assetsDir(): string {
    return this.currentAssetsDir;
  }

  get documentsDir(): string {
    return this.currentDocumentsDir;
  }

  constructor(dataDir = path.resolve("data")) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.defaultAssetsDir = path.join(dataDir, "assets");
    this.defaultDocumentsDir = path.join(dataDir, "documents");
    this.inputsDir = path.join(dataDir, "inputs");
    this.thumbsDir = path.join(dataDir, "thumbs");
    fs.mkdirSync(this.defaultAssetsDir, { recursive: true });
    fs.mkdirSync(this.defaultDocumentsDir, { recursive: true });
    fs.mkdirSync(this.inputsDir, { recursive: true });
    fs.mkdirSync(this.thumbsDir, { recursive: true });
    this.filePath = path.join(dataDir, "app.db");
    this.db = new DatabaseSync(this.filePath);
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    initializeSchema(this.db, this.defaultAssetsDir);
    initializeLegacyWorkspace(this.db, this.defaultDocumentsDir);
    this.config = new ConfigurationRepository(this.db);
    this.workflows = new WorkflowStore(this.db);
    this.executions = new ExecutionStore(this.db);
    this.specs = new PresentationSpecStore(this.db);
    this.documents = new DocumentRepository(this.db, () => this.documentsDir, this.specs);
    this.conversations = new ConversationRepository(this.db);
    this.conversationMessages = new ConversationMessageRepository(this.db, this.conversations, this.documents, () => this.documentsDir);
    this.assets = new AssetRepository(this.db, this.defaultAssetsDir, this.thumbsDir);
    this.tasks = new TaskRepository(this.db, this.assets);
    this.storyboards = new StoryboardRepository(this.db, this.assets);
    this.canvasTemplates = new CanvasTemplateRepository(this.db);
    this.boards = new BoardRepository(this.db, (row) => this.assets.assetFromRow(row), (asset) => this.assets.assetView(asset));

    // 老分镜可能把「林小满、老陈」当成一个角色存下来了。启动时拆成独立角色，
    // 否则面板里会出现一个「林小满、老陈」的卡片，谁都没法单独绑设定图。
    this.storyboards.normalizeStoryboardCharacterNames();
    // 内置风格模板按 id 幂等补齐：升级后新加的内置项也能出现在老库里，
    // 用户改过的自定义项不受影响（它们的 id 是随机 uuid）
    this.ensureBuiltinStylePresets();

    this.currentAssetsDir = this.resolveAssetsDir();
    this.currentDocumentsDir = this.resolveDocumentsDir();
    fs.mkdirSync(this.currentAssetsDir, { recursive: true });
    fs.mkdirSync(this.currentDocumentsDir, { recursive: true });
  }

  private ensureBuiltinStylePresets() {
    const at = now();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO style_presets (id, name, description, prompt, negative, builtin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    for (const preset of BUILTIN_STYLE_PRESETS) {
      insert.run(preset.id, preset.name, preset.description, preset.prompt, preset.negative, at, at);
    }
  }

  /** 内置在前、自定义在后，同组按创建时间 */
  listStylePresets(): StylePreset[] {
    const rows = this.db.prepare(
      "SELECT * FROM style_presets ORDER BY builtin DESC, created_at ASC, rowid ASC",
    ).all() as DbRow[];
    return rows.map((row) => this.stylePresetFromRow(row));
  }

  getStylePreset(id: string): StylePreset | null {
    const row = this.db.prepare("SELECT * FROM style_presets WHERE id = ?").get(id) as DbRow | undefined;
    return row ? this.stylePresetFromRow(row) : null;
  }

  /** 按 id 或名字找：大脑和用户都可能只记得名字 */
  findStylePreset(nameOrId: string): StylePreset | null {
    const key = nameOrId.trim();
    if (!key) return null;
    return this.getStylePreset(key) ?? this.listStylePresets().find((item) => item.name === key) ?? null;
  }

  saveStylePreset(input: StylePresetInput, id?: string): StylePreset {
    const at = now();
    if (id) {
      const existing = this.getStylePreset(id);
      if (!existing) throw new StylePresetError("STYLE_NOT_FOUND", "风格模板不存在");
      if (existing.builtin) throw new StylePresetError("STYLE_BUILTIN", "内置风格不能修改，可以复制一份再改");
      this.db.prepare(
        "UPDATE style_presets SET name = ?, description = ?, prompt = ?, negative = ?, updated_at = ? WHERE id = ?",
      ).run(input.name, input.description, input.prompt, input.negative, at, id);
      return this.getStylePreset(id)!;
    }
    const newId = crypto.randomUUID();
    this.db.prepare(
      `INSERT INTO style_presets (id, name, description, prompt, negative, builtin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(newId, input.name, input.description, input.prompt, input.negative, at, at);
    return this.getStylePreset(newId)!;
  }

  deleteStylePreset(id: string): void {
    const existing = this.getStylePreset(id);
    if (!existing) throw new StylePresetError("STYLE_NOT_FOUND", "风格模板不存在");
    if (existing.builtin) throw new StylePresetError("STYLE_BUILTIN", "内置风格不能删除");
    this.db.prepare("DELETE FROM style_presets WHERE id = ?").run(id);
  }

  private stylePresetFromRow(row: DbRow): StylePreset {
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description ?? ""),
      prompt: String(row.prompt ?? ""),
      negative: String(row.negative ?? ""),
      builtin: Boolean(row.builtin),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
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

  /** 文档目录和素材目录同一套规则：只影响新产物，旧记录按各自 base_dir 读取 */
  private resolveDocumentsDir(): string {
    const stored = this.getSetting("documentsDir");
    if (!stored || !path.isAbsolute(stored)) return this.defaultDocumentsDir;
    try {
      const resolved = path.resolve(stored);
      fs.mkdirSync(resolved, { recursive: true });
      return resolved;
    } catch {
      return this.defaultDocumentsDir;
    }
  }

  setDocumentsDir(dir: string): string {
    if (!path.isAbsolute(dir)) throw new Error("文档目录必须是绝对路径");
    const resolved = path.resolve(dir);
    fs.mkdirSync(resolved, { recursive: true });
    if (resolved !== this.defaultDocumentsDir && resolved.startsWith(this.dataDir + path.sep)) {
      throw new Error("自定义文档目录不能放在应用数据目录内部");
    }
    this.setSetting("documentsDir", resolved);
    this.currentDocumentsDir = resolved;
    return resolved;
  }

  resetDocumentsDir(): string {
    this.setSetting("documentsDir", "");
    this.currentDocumentsDir = this.defaultDocumentsDir;
    fs.mkdirSync(this.currentDocumentsDir, { recursive: true });
    return this.currentDocumentsDir;
  }

  getSetting(key: string): string | null {
    return this.config.getSetting(key);
  }

  setSetting(key: string, value: string) {
    return this.config.setSetting(key, value);
  }

  /** Global image-confirm policy; the composer no longer exposes a per-conversation switch. */
  setAllImageConfirmPolicy(policy: "batch_only" | "always") {
    return this.conversations.setAllImageConfirmPolicy(policy);
  }

  close() {
    this.db.close();
  }

  listChannels(): DbChannel[] {
    return this.config.listChannels();
  }

  getChannel(id: string): DbChannel | null {
    return this.config.getChannel(id);
  }

  saveChannel(input: ChannelInput, existingId?: string): DbChannel {
    return this.config.saveChannel(input, existingId);
  }

  deleteChannel(id: string) {
    return this.config.deleteChannel(id);
  }

  /**
   * 只改「新对话默认统一入口」这一位，不动 updated_at。
   * 渠道指纹用它判断会话/断点是否仍匹配；一个 UI 偏好不该让所有进行中的任务失效。
   */
  setChannelUnifiedAgentDefault(id: string, enabled: boolean) {
    return this.config.setChannelUnifiedAgentDefault(id, enabled);
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
    const inputs = this.tasks.collectInputImagePaths(id);
    this.db.prepare("DELETE FROM diagnostics WHERE task_id = ?").run(id);
    this.db.prepare("DELETE FROM assets WHERE task_id = ?").run(id);
    this.db.prepare("DELETE FROM board_tasks WHERE task_id = ?").run(id);
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    if (options.keepFiles) return { assets: [], inputs: [] };
    return { assets, inputs };
  }

  /** 删除单个公共素材，保留生成记录和同任务的其他产物。 */
  deletePublicAsset(assetId: string): StoredFileRef[] {
    return this.assets.deletePublicAsset(assetId);
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
    return this.tasks.taskKindRow(row, adapterByChannel);
  }

  /** 兼容旧调用点；新代码用 `taskKindRow` */
  isVideoTaskRow(row: TaskRow, adapterByChannel: Map<string, string>): boolean {
    return this.taskKindRow(row, adapterByChannel) === "video";
  }

  createTask(input: CreateTaskInput): TaskRow {
    return this.tasks.createTask(input);
  }

  getTaskRow(id: string): TaskRow | null {
    return this.tasks.getTaskRow(id);
  }

  taskHasConversationReferences(taskId: string): boolean {
    return this.tasks.taskHasConversationReferences(taskId);
  }

  assetHasOtherConversationReferences(assetId: string, conversationId: string): boolean {
    return this.assets.assetHasOtherConversationReferences(assetId, conversationId);
  }

  listTaskRows(limit = 40): TaskRow[] {
    return this.tasks.listTaskRows(limit);
  }

  /** 清空历史要把整个表过一遍，不受列表分页限制。上传素材不算历史，跟着会话一起走 */
  listAllTaskRows(): TaskRow[] {
    return this.tasks.listAllTaskRows();
  }

  updateTask(id: string, patch: TaskPatch) {
    return this.tasks.updateTask(id, patch);
  }

  /** 进程重启后仍停留在进行中状态的任务，需要被标记为失败 */
  listPendingTasks(): TaskRow[] {
    return this.tasks.listPendingTasks();
  }

  insertAsset(asset: InsertAssetInput) {
    return this.assets.insertAsset(asset);
  }

  /** 懒生成缩略图后回填（§11.4 的「使用时懒生成」），老产物走这条 */
  setAssetThumbPath(assetId: string, thumbPath: string) {
    return this.assets.setAssetThumbPath(assetId, thumbPath);
  }

  listAssets(taskId: string): AssetRow[] {
    return this.assets.listAssets(taskId);
  }

  /** 按主键取单个产物：媒体请求（每个缩略图一次）用它，别走 listTaskRows */
  getAsset(id: string): AssetRow | null {
    return this.assets.getAsset(id);
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

  insertDiagnostic(input: InsertDiagnosticInput) {
    return this.tasks.insertDiagnostic(input);
  }

  listDiagnostics(taskId: string): Diagnostic[] {
    return this.tasks.listDiagnostics(taskId);
  }

  // ── 对话式 Agent（AGENT_PLAN.md §5） ──────────────────────────────────────

  createConversation(input: CreateConversationInput): Conversation {
    return this.conversations.createConversation(input);
  }

  getConversation(id: string): Conversation | null {
    return this.conversations.getConversation(id);
  }

  listConversations(): Conversation[] {
    return this.conversations.listConversations();
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
    return this.conversationMessages.resetConversationsStuckInRunning();
  }

  beginNativeToolCall(conversationId: string, messageId: string, callId: string, toolName: string, argumentHash: string) {
    return this.conversationMessages.beginNativeToolCall(conversationId, messageId, callId, toolName, argumentHash);
  }

  startNativeToolCall(conversationId: string, displayName: string, toolArgs: Record<string, unknown>, callId: string, toolName: string, argumentHash: string) {
    return this.conversationMessages.startNativeToolCall(conversationId, displayName, toolArgs, callId, toolName, argumentHash);
  }

  finishNativeToolCall(conversationId: string, messageId: string, toolName: string, result: ToolResult) {
    return this.conversationMessages.finishNativeToolCall(conversationId, messageId, toolName, result);
  }

  interruptNativeToolCalls(conversationId: string) {
    return this.conversationMessages.interruptNativeToolCalls(conversationId);
  }

  listNativeToolCalls(conversationId: string) {
    return this.conversationMessages.listNativeToolCalls(conversationId);
  }

  saveNativeTurnCheckpoint(conversationId: string, payload: string): boolean {
    return this.conversationMessages.saveNativeTurnCheckpoint(conversationId, payload);
  }
  getNativeTurnCheckpoint(conversationId: string): string | null {
    return this.conversationMessages.getNativeTurnCheckpoint(conversationId);
  }
  clearNativeTurnCheckpoint(conversationId: string): void {
    return this.conversationMessages.clearNativeTurnCheckpoint(conversationId);
  }
  recoverableNativeTurnIds(): string[] {
    return this.conversationMessages.recoverableNativeTurnIds();
  }

  getPresentationBatch(conversationId: string, key: string): string | null {
    return this.documents.getPresentationBatch(conversationId, key);
  }

  addPresentationVersion(fileId: string, sha256: string, report: TemplateReport) {
    return this.documents.addPresentationVersion(fileId, sha256, report);
  }

  getPresentationVersion(conversationId: string, fileId: string): PresentationVersionReport | null {
    return this.documents.getPresentationVersion(conversationId, fileId);
  }

  updatePresentationAudit(fileId: string, sha256: string, report: TemplateReport) {
    return this.documents.updatePresentationAudit(fileId, sha256, report);
  }

  queuePresentationCheck(fileId: string, from: "unavailable" | "running") {
    return this.documents.queuePresentationCheck(fileId, from);
  }

  claimPresentationCheck(lease: string) {
    return this.documents.claimPresentationCheck(lease);
  }

  finishPresentationCheck(fileId: string, lease: string, visual: PresentationVisualCheck) {
    return this.documents.finishPresentationCheck(fileId, lease, visual);
  }

  recoverPresentationChecks() {
    return this.documents.recoverPresentationChecks();
  }

  getPresentationResume(conversationId: string): import("./presentation-execution.js").PresentationResume | null {
    return this.documents.getPresentationResume(conversationId);
  }

  savePresentationResume(conversationId: string, resume: import("./presentation-execution.js").PresentationResume) {
    return this.documents.savePresentationResume(conversationId, resume);
  }

  clearPresentationResume(conversationId: string) {
    return this.documents.clearPresentationResume(conversationId);
  }

  savePresentationBatch(conversationId: string, key: string, content: string): void {
    return this.documents.savePresentationBatch(conversationId, key, content);
  }

  /**
   * 一条消息都没有的会话 id。
   *
   * 新建会话时用它清掉上一条没动过的空壳——点几下「新对话」就堆几条，
   * 侧栏会被一串「新对话」刷屏。空会话没有消息，也就没有产物和上传图，删掉不丢东西。
   */
  emptyConversationIds(): string[] {
    return this.conversations.emptyConversationIds();
  }

  /**
   * 这个会话里用户最后说的那句话。
   *
   * 「原话直发」用它当提示词——必须是**用户的原话**，不能是大脑改写过的版本。
   * 上传图片那类消息（role=user、内容是「上传了图片 x.png」）也在这里，但它们从来不是最后一条：
   * 发图时要求必须带一句话，那句话排在后头。
   */
  lastUserText(conversationId: string): string | null {
    return this.conversationMessages.lastUserText(conversationId);
  }

  // ── 脚本文档与分镜表 ──────────────────────────────────────────────────────

  addConversationDocument(conversationId: string, fileName: string, content: string): StoredDocument {
    return this.documents.addConversationDocument(conversationId, fileName, content);
  }

  addBinaryConversationDocument(conversationId: string, fileName: string, content: string, bytes: Buffer): StoredDocument {
    return this.documents.addBinaryConversationDocument(conversationId, fileName, content, bytes);
  }

  getConversationDocumentFile(documentId: string): Buffer | null {
    return this.documents.getConversationDocumentFile(documentId);
  }

  getConversationDocumentPlan(documentId: string): string | null {
    return this.documents.getConversationDocumentPlan(documentId);
  }

  setConversationDocumentPlan(documentId: string, plan: string): void {
    return this.documents.setConversationDocumentPlan(documentId, plan);
  }

  addDocumentOutput(documentId: string, fileName: string, data: Buffer): string {
    return this.documents.addDocumentOutput(documentId, fileName, data);
  }

  getDocumentOutput(id: string): { documentId: string; fileName: string; data: Buffer } | null {
    return this.documents.getDocumentOutput(id);
  }

  addWorkspaceDocument(conversationId: string, fileName: string, byteSize: number, operationId?: string, presentation?: { sha256: string; report: TemplateReport }, baseDir = this.currentDocumentsDir, lineage?: { familyId?: string; parentId?: string }): { id: string; name: string; byteSize: number; createdAt: string; baseDir: string; familyId: string; version: number } {
    return this.documents.addWorkspaceDocument(conversationId, fileName, byteSize, operationId, presentation, baseDir, lineage);
  }
  /** B：普通列表、下载、文件卡和 family 历史默认只暴露 published；候选需显式 include。 */
  listWorkspaceDocuments(conversationId: string, options: { includeCandidates?: boolean } = {}): Array<{ id: string; name: string; byteSize: number; createdAt: string; baseDir: string; familyId: string; version: number; state: "candidate" | "published" }> {
    return this.documents.listWorkspaceDocuments(conversationId, options);
  }
  getWorkspaceDocument(conversationId: string, fileId: string) {
    return this.documents.getWorkspaceDocument(conversationId, fileId);
  }
  /** 内部读取（发布前校验、重启对账）用；调用方必须自行验证运行归属。 */
  getAnyWorkspaceDocument(conversationId: string, fileId: string) {
    return this.documents.getAnyWorkspaceDocument(conversationId, fileId);
  }
  /** 旧的 operationId 幂等查询不得把 candidate 当作成功结果。 */
  getWorkspaceDocumentByOperation(conversationId: string, operationId: string) {
    return this.documents.getWorkspaceDocumentByOperation(conversationId, operationId);
  }

  // ── B：候选产物与统一发布 ────────────────────────────────────────────────
  addCandidateDocument(input: CreateCandidateRecord) {
    return this.documents.addCandidateDocument(input);
  }
  getCandidateByOperation(conversationId: string, operationId: string) {
    return this.documents.getCandidateByOperation(conversationId, operationId);
  }
  getCandidateById(conversationId: string, candidateId: string) {
    return this.documents.getCandidateById(conversationId, candidateId);
  }
  listCandidateDocuments(): Array<{ id: string; conversationId: string; name: string; baseDir: string; meta: CandidateMeta | null }> {
    return this.documents.listCandidateDocuments();
  }
  deleteCandidateDocument(candidateId: string) {
    return this.documents.deleteCandidateDocument(candidateId);
  }
  /** 只更新候选登记里的元数据，不改文件字节；用于记录「等待视觉检查」。 */
  saveCandidateMeta(conversationId: string, candidateId: string, meta: CandidateMeta) {
    return this.documents.saveCandidateMeta(conversationId, candidateId, meta);
  }

  /** 让候选进入已有的 WPS 检查队列；检查完成后由发布层发布同一候选。 */
  queueCandidateVisualCheck(fileId: string, sha256: string, report: TemplateReport) {
    return this.documents.queueCandidateVisualCheck(fileId, sha256, report);
  }

  savePendingVisualPublish(input: PendingVisualPublishRecord) {
    return this.documents.savePendingVisualPublish(input);
  }
  listPendingVisualPublishes(): Array<{ candidateId: string; conversationId: string; operationId: string; payload: PendingPublish }> {
    return this.documents.listPendingVisualPublishes();
  }
  deletePendingVisualPublish(candidateId: string) {
    return this.documents.deletePendingVisualPublish(candidateId);
  }
  getPublishLog(conversationId: string, operationId: string) {
    return this.documents.getPublishLog(conversationId, operationId);
  }
  /** publish 是唯一把 state 改为 published 的入口；正式版本号在此分配。 */
  publishCandidateDocument(input: PublishCandidateRecord) {
    return this.documents.publishCandidateDocument(input);
  }

  /**
   * Keep a bounded history for a document family. The newest `keep` versions (and
   * the root file) survive; older generated intermediates are removed from disk.
   * Returns the removed file paths so callers can report what was cleaned.
   */
  pruneWorkspaceFamily(conversationId: string, familyId: string, keep = 3): string[] {
    return this.documents.pruneWorkspaceFamily(conversationId, familyId, keep);
  }
  /** Manual cleanup for workspaces created before automatic pruning existed. */
  cleanupWorkspaceVersions(keep = 3): number {
    return this.documents.cleanupWorkspaceVersions(keep);
  }

  deleteWorkspaceDocument(conversationId: string, fileId: string): void {
    return this.documents.deleteWorkspaceDocument(conversationId, fileId);
  }

  listConversationDocuments(conversationId: string): StoredDocument[] {
    return this.documents.listConversationDocuments(conversationId);
  }

  getConversationDocument(id: string): StoredDocument | null {
    return this.documents.getConversationDocument(id);
  }

  /**
   * 整表替换一个会话的分镜。
   *
   * 重新拆镜是「用户拿了一份新脚本」或「上一版拆得不对」——保留旧镜号只会让
   * 「第 7 镜」指到两张不同的画面上。已经生成的产物仍在生成历史里，不会丢。
   */
  replaceStoryboard(
    conversationId: string,
    shots: ReplaceStoryboardShots,
    settings: StoryboardSettings = {},
  ): StoryboardShot[] {
    return this.storyboards.replaceStoryboard(conversationId, shots, settings);
  }

  /**
   * 把角色名补进 characters 表。`林小满、老陈` 会被拆成两个独立角色；
   * 同名角色已存在时只更新提示词（如果这次给了），不会清掉已绑定的设定图。
   */
  upsertStoryboardCharacters(conversationId: string, items: Array<string | { name: string; prompt?: string }>) {
    return this.storyboards.upsertStoryboardCharacters(conversationId, items);
  }

  upsertStoryboardScenes(conversationId: string, items: Array<string | { name: string; prompt?: string }>) {
    return this.storyboards.upsertStoryboardScenes(conversationId, items);
  }

  listStoryboardCharacters(conversationId: string): Array<{
    id: string; name: string; prompt: string; voice: string; assetId: string | null; taskId: string | null;
    confirmed: boolean; createdAt: string; updatedAt: string;
  }> {
    return this.storyboards.listStoryboardCharacters(conversationId);
  }

  listStoryboardScenes(conversationId: string): Array<{
    id: string; name: string; prompt: string; assetId: string | null; taskId: string | null;
    confirmed: boolean; createdAt: string; updatedAt: string;
  }> {
    return this.storyboards.listStoryboardScenes(conversationId);
  }

  getStoryboardCharacter(id: string): {
    id: string; conversationId: string; name: string; prompt: string; voice: string; assetId: string | null;
    taskId: string | null; confirmed: boolean;
  } | null {
    return this.storyboards.getStoryboardCharacter(id);
  }

  getStoryboardScene(id: string): {
    id: string; conversationId: string; name: string; prompt: string; assetId: string | null;
    taskId: string | null; confirmed: boolean;
  } | null {
    return this.storyboards.getStoryboardScene(id);
  }

  setStoryboardCharacterAsset(characterId: string, assetId: string | null) {
    return this.storyboards.setStoryboardCharacterAsset(characterId, assetId);
  }

  setStoryboardSceneAsset(sceneId: string, assetId: string | null) {
    return this.storyboards.setStoryboardSceneAsset(sceneId, assetId);
  }

  setStoryboardCharacterPrompt(characterId: string, prompt: string) {
    return this.storyboards.setStoryboardCharacterPrompt(characterId, prompt);
  }

  setStoryboardCharacterVoice(characterId: string, voice: string) {
    return this.storyboards.setStoryboardCharacterVoice(characterId, voice);
  }

  setStoryboardScenePrompt(sceneId: string, prompt: string) {
    return this.storyboards.setStoryboardScenePrompt(sceneId, prompt);
  }

  setStoryboardCharacterTask(characterId: string, taskId: string | null) {
    return this.storyboards.setStoryboardCharacterTask(characterId, taskId);
  }

  setStoryboardSceneTask(sceneId: string, taskId: string | null) {
    return this.storyboards.setStoryboardSceneTask(sceneId, taskId);
  }

  confirmStoryboardCharacter(characterId: string, confirmed: boolean) {
    return this.storyboards.confirmStoryboardCharacter(characterId, confirmed);
  }

  confirmStoryboardScene(sceneId: string, confirmed: boolean) {
    return this.storyboards.confirmStoryboardScene(sceneId, confirmed);
  }

  /**
   * 分镜表视图：任务状态是**现在**从 tasks 表读出来的，不在分镜行里再存一份。
   *
   * 存一份就得处理「任务重启恢复」「后台轮询完成」「删除历史」三条写路径，
   * 而那三条都已经在维护 tasks 了；分镜只需要记住「最近一次挂在哪个 task 上」。
   */
  listStoryboardShots(conversationId: string): StoryboardShot[] {
    return this.storyboards.listStoryboardShots(conversationId);
  }

  getStoryboardShot(id: string): StoryboardShot | null {
    return this.storyboards.getStoryboardShot(id);
  }

  updateStoryboardShot(
    id: string,
    patch: StoryboardShotPatch,
  ): StoryboardShot | null {
    return this.storyboards.updateStoryboardShot(id, patch);
  }

  hasStoryboard(conversationId: string): boolean {
    return this.storyboards.hasStoryboard(conversationId);
  }

  countStoryboardShots(conversationId: string): number {
    return this.storyboards.countStoryboardShots(conversationId);
  }

  /** 镜头图里用户拖动过的节点坐标；没记录的节点继续走自动布局 */
  listStoryboardGraphPositions(conversationId: string): Record<string, { x: number; y: number }> {
    return this.storyboards.listStoryboardGraphPositions(conversationId);
  }

  saveStoryboardGraphPositions(
    conversationId: string,
    positions: Array<{ id: string; x: number; y: number }>,
  ): void {
    return this.storyboards.saveStoryboardGraphPositions(conversationId, positions);
  }

  clearStoryboardGraphPositions(conversationId: string): number {
    return this.storyboards.clearStoryboardGraphPositions(conversationId);
  }

  /** 分镜的角色参考设置。auto = 用第一个已完成的图片镜头，manual = 用指定产物，off = 不用 */
  getStoryboardReference(conversationId: string): { assetId: string | null; mode: "auto" | "manual" | "off" } {
    return this.storyboards.getStoryboardReference(conversationId);
  }

  setStoryboardReference(conversationId: string, input: { assetId: string | null; mode: "auto" | "manual" | "off" }) {
    return this.storyboards.setStoryboardReference(conversationId, input);
  }

  deleteStoryboard(conversationId: string): number {
    return this.storyboards.deleteStoryboard(conversationId);
  }

  /**
   * 在末尾追加一镜。
   *
   * 默认沿用最后一镜的画幅，避免新镜头和其他镜头一个横一个竖；描述留空，
   * 由用户在面板里填——这里不替用户编画面，也不提交任何任务。
   */
  addStoryboardShot(conversationId: string, input: CreateStoryboardShotInput = {}): StoryboardShot {
    return this.storyboards.addStoryboardShot(conversationId, input);
  }

  /**
   * 删除一镜，并把后面的镜号往前挪。
   *
   * 镜号是用户和大脑共同引用的坐标（「第 7 镜」），留着空洞会让「第 7 镜」
   * 指向一个已经不存在的位置；这里直接重排成连续的 1..N。
   */
  deleteStoryboardShot(shotId: string): { conversationId: string; index: number } | null {
    return this.storyboards.deleteStoryboardShot(shotId);
  }

  /**
   * 删除角色设定，并把它从所有镜头的角色标签里摘掉。
   *
   * 只删设定卡、不清理镜头的后果很具体：镜头仍然写着「小雨」，但左侧已经没有
   * 小雨的卡，生成时会被判成「角色还没有设定图」，整批卡住。
   */
  deleteStoryboardCharacter(characterId: string): { conversationId: string; name: string } | null {
    return this.storyboards.deleteStoryboardCharacter(characterId);
  }

  /** 删除场景设定；引用这个场景的镜头清空 scene_name（空镜仍然可以生成） */
  deleteStoryboardScene(sceneId: string): { conversationId: string; name: string } | null {
    return this.storyboards.deleteStoryboardScene(sceneId);
  }

  /** 只改传进来的字段；`canvasAssetIds: []` 是「清空画布」，和「没传」是两回事 */
  updateConversation(id: string, patch: ConversationPatch): Conversation | null {
    return this.conversations.updateConversation(id, patch);
  }

  /** 会话状态机（§12.3）与自动续跑计数；不给 updated_at 让列表顺序被内部状态变化打乱 */
  setConversationStatus(id: string, status: ConversationStatus, options: { touch?: boolean } = {}) {
    return this.conversations.setConversationStatus(id, status, options);
  }

  bumpAutoContinue(id: string) {
    return this.conversations.bumpAutoContinue(id);
  }

  resetAutoContinue(id: string) {
    return this.conversations.resetAutoContinue(id);
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
    // 只移除本会话的文档工作区；旧版本可能分布在多个已切换过的 base_dir。
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("文档目录路径无效");
    const workspaceRoots = new Set<string>([this.currentDocumentsDir, this.defaultDocumentsDir]);
    for (const row of this.db.prepare("SELECT DISTINCT base_dir FROM workspace_documents WHERE conversation_id = ? AND base_dir IS NOT NULL AND base_dir != ''").all(id) as DbRow[]) workspaceRoots.add(String(row.base_dir));
    for (const rootRaw of workspaceRoots) {
      const workspaceRoot = path.resolve(rootRaw);
      const workspaceTarget = path.resolve(workspaceRoot, id);
      if (path.dirname(workspaceTarget).toLowerCase() !== workspaceRoot.toLowerCase()) continue;
      if (!fs.existsSync(workspaceRoot)) continue;
      if (fs.lstatSync(workspaceRoot).isSymbolicLink()) throw new Error("文档目录不安全");
      if (!fs.existsSync(workspaceTarget)) continue;
      if (fs.lstatSync(workspaceTarget).isSymbolicLink()) throw new Error("会话文档目录不安全");
      fs.rmSync(workspaceTarget, { recursive: true, force: true });
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
    // A：契约表没有会话外键，删除会话时按归属显式清理，避免留下孤立要求。
    const ownedSpecs = "SELECT spec_id FROM presentation_specs WHERE conversation_id = ?";
    this.db.prepare(`DELETE FROM presentation_validations WHERE spec_id IN (${ownedSpecs})`).run(id);
    this.db.prepare(`DELETE FROM presentation_spec_revisions WHERE spec_id IN (${ownedSpecs})`).run(id);
    this.db.prepare("DELETE FROM presentation_specs WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM presentation_family_refs WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM document_publish_log WHERE conversation_id = ?").run(id);
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
    return { assets };
  }

  // ── 无限画布（FREE_CANVAS_PLAN.md） ─────────────────────────────────────────

  createCanvasTemplate(input: CreateCanvasTemplateInput): CanvasTemplate {
    return this.canvasTemplates.createCanvasTemplate(input);
  }

  getCanvasTemplate(id: string): CanvasTemplate | null {
    return this.canvasTemplates.getCanvasTemplate(id);
  }

  findCanvasTemplateByConversation(conversationId: string, source?: CanvasTemplate["source"]): CanvasTemplate | null {
    return this.canvasTemplates.findCanvasTemplateByConversation(conversationId, source);
  }

  updateCanvasTemplate(id: string, patch: { name?: string; description?: string }): CanvasTemplate | null {
    return this.canvasTemplates.updateCanvasTemplate(id, patch);
  }

  deleteCanvasTemplate(id: string): boolean {
    return this.canvasTemplates.deleteCanvasTemplate(id);
  }

  listCanvasTemplateSummaries(limit = 50): CanvasTemplateSummary[] {
    return this.canvasTemplates.listCanvasTemplateSummaries(limit);
  }

  createStoryboardProject(id: string, conversationId: string, data: StoryboardProjectData): StoryboardProject {
    return this.storyboards.createStoryboardProject(id, conversationId, data);
  }

  getStoryboardProjectConversationId(id: string): string | null {
    return this.storyboards.getStoryboardProjectConversationId(id);
  }

  getStoryboardProject(id: string): StoryboardProject | null {
    return this.storyboards.getStoryboardProject(id);
  }

  updateStoryboardProject(id: string, revision: number, data: StoryboardProjectData): StoryboardProject | null {
    return this.storyboards.updateStoryboardProject(id, revision, data);
  }

  setStoryboardTemplateAssets(templateId: string, entries: Array<{ nodeId: string; assetId: string }>) {
    return this.canvasTemplates.setStoryboardTemplateAssets(templateId, entries);
  }

  getStoryboardTemplateAssets(templateId: string): Map<string, string> {
    return this.canvasTemplates.getStoryboardTemplateAssets(templateId);
  }

  assetHasStoryboardProjectReferences(assetId: string): boolean {
    return this.storyboards.assetHasStoryboardProjectReferences(assetId);
  }

  taskHasStoryboardProjectReferences(taskId: string): boolean {
    return this.storyboards.taskHasStoryboardProjectReferences(taskId);
  }

  listStoryboardConversationIds(): string[] {
    return this.storyboards.listStoryboardConversationIds();
  }

  getStoryboardMigration(conversationId: string): {
    conversationId: string; boardId: string; templateId: string; version: number; createdAt: string;
  } | null {
    return this.storyboards.getStoryboardMigration(conversationId);
  }

  listStoryboardMigrations(): Array<{
    conversationId: string; boardId: string; templateId: string; version: number; createdAt: string;
  }> {
    return this.storyboards.listStoryboardMigrations();
  }

  saveStoryboardMigration(input: SaveStoryboardMigrationInput): void {
    return this.storyboards.saveStoryboardMigration(input);
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
    return this.conversations.recordBrainCall(conversationId, usage);
  }

  /** 会话的 token 账本：累计输入/输出，以及**最近一次**请求的输入大小（≈ 当前上下文） */
  conversationUsage(conversationId: string): ConversationUsage {
    return this.conversations.conversationUsage(conversationId);
  }

  listMessages(conversationId: string, limit = 400): ChatMessage[] {
    return this.conversationMessages.listMessages(conversationId, limit);
  }

  listMessagesAfter(conversationId: string, seq: number): ChatMessage[] {
    return this.conversationMessages.listMessagesAfter(conversationId, seq);
  }

  getContextSummary(id: string): { text: string; throughSeq: number; anchorIds: string[] } | null {
    return this.conversations.getContextSummary(id);
  }

  saveContextSummary(id: string, text: string, throughSeq: number, anchorIds: string[]) {
    return this.conversations.saveContextSummary(id, text, throughSeq, anchorIds);
  }

  getMessage(id: string): ChatMessage | null {
    return this.conversationMessages.getMessage(id);
  }

  appendMessage(input: AppendMessageInput): ChatMessage {
    return this.conversationMessages.appendMessage(input);
  }

  recordConversationMediaUploads(conversationId: string, uploads: Array<{ asset: InsertAssetInput; content: string }>) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const { asset, content } of uploads) {
        this.createTask({
          id: asset.taskId, channelId: "", model: "", prompt: content,
          input: {}, origin: "upload", libraryScope: "conversation", ownerConversationId: conversationId, status: "succeeded",
        });
        this.insertAsset(asset);
        this.appendMessage({ conversationId, role: "user", content, assetId: asset.id });
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  updateMessage(id: string, patch: MessagePatch) {
    return this.conversationMessages.updateMessage(id, patch);
  }

  claimAgentConfirmation(message: ChatMessage, decision: "approve" | "reject", args?: Record<string, unknown>): boolean {
    return this.conversationMessages.claimAgentConfirmation(message, decision, args);
  }

  listUnlinkedAgentTasks(): TaskRow[] {
    return this.tasks.listUnlinkedAgentTasks();
  }

  getNativeMediaConfirmation(messageId: string): import("./chat-tools/native-image.js").NativeMediaConfirmation | null {
    return this.conversationMessages.getNativeMediaConfirmation(messageId);
  }

  clearNativeMediaConfirmation(messageId: string): void {
    return this.conversationMessages.clearNativeMediaConfirmation(messageId);
  }

  completeNativeMediaTask(conversationId: string, pendingId: string, operationId: string, result: ToolResult,
    canResume: boolean, checkpoint: string | null): boolean {
    return this.conversationMessages.completeNativeMediaTask(conversationId, pendingId, operationId, result, canResume, checkpoint);
  }

  hasUserMessageAfter(conversationId: string, seq: number): boolean {
    return this.conversationMessages.hasUserMessageAfter(conversationId, seq);
  }

  appendNativeMediaConfirmation(input: AppendMessageInput, state: import("./chat-tools/native-image.js").NativeMediaConfirmation) {
    return this.conversationMessages.appendNativeMediaConfirmation(input, state);
  }

  interruptUnstartedAgentConfirmations(): void {
    return this.conversationMessages.interruptUnstartedAgentConfirmations();
  }

  /** 待确认的消息。用户发新消息时要把它们标成「已被取代」并让出 pending 状态 */
  listPendingMessages(conversationId: string): ChatMessage[] {
    return this.conversationMessages.listPendingMessages(conversationId);
  }

  /** 视频任务完成后靠它找回会话（§9.1）；一个任务只会属于一个会话 */
  findConversationByTask(taskId: string): Conversation | null {
    return this.conversations.findConversationByTask(taskId);
  }

  findTaskTimeoutMessage(conversationId: string, taskId: string): ChatMessage | null {
    return this.conversationMessages.findTaskTimeoutMessage(conversationId, taskId);
  }

  /**
   * 分镜生成出来的产物。
   *
   * 它们没有经过 Agent 的消息落库（分镜面板直接提交 runner），所以不在
   * `messages.asset_id` 那条线索上。但用户点「加画布」之后，画布要能找到它们——
   * 必须把这条来路补进 `buildView` 的素材集合。
   */
  listStoryboardAssets(conversationId: string): Array<{ asset: AssetRow; index: number; prompt: string }> {
    return this.storyboards.listStoryboardAssets(conversationId);
  }

  /** 角色 / 场景设定图（手动绑定的，或最近一次生成任务产出的） */
  listStoryboardSettingAssets(conversationId: string): Array<{ asset: AssetRow; label: string }> {
    return this.storyboards.listStoryboardSettingAssets(conversationId);
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
        asset: this.assets.assetFromRow(row), round, prompt: String(row.message_content ?? ""),
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
      const asset = this.assets.assetFromRow(row);
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

  getTaskView(id: string): Task | null {
    return this.tasks.getTaskView(id);
  }

  listTaskViews(limit = 40): Task[] {
    return this.tasks.listTaskViews(limit);
  }

  listLibraryTaskViews(options?: LibraryTaskQuery): Task[] {
    return this.tasks.listLibraryTaskViews(options);
  }

  /** AssetRow → 前端用的 Asset。Agent 的画布徽章、附件条也走这一份，别各写一遍 */
  assetView(asset: AssetRow): Asset {
    return this.assets.assetView(asset);
  }
}
