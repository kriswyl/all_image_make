import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { AdapterType, AuthType, Channel, ChannelInput, Diagnostic, Task, TaskStatus, Asset, TaskKind } from "../shared/types.js";
import { isAudioAsset, isImageAsset } from "../shared/types.js";
import { taskKindFor } from "../shared/kinds.js";
// 参数核对（需求.md 问题 1）：纯函数、无 IO、不碰 db，所以放在这里不构成环
import { auditParameters } from "./diagnose.js";
import type {
  AgentPlan, ChatDocumentRef, ConfirmPreview, ChatMessage, Conversation, ConversationKind, ConversationPatch,
  ConversationStatus, ConversationUsage, MessageRole, MessageStatus, ToolResult, VideoConfirmPolicy,
} from "../shared/agent-types.js";
import {
  joinCharacterNames, parseCharacterNames,
  type StoryboardShot, type StoryboardShotKind, type StoryboardShotStatus, type StoryboardVideoMode,
} from "../shared/storyboard.js";
import {
  BOARD_LIMITS, boardGroups, createEmptyBoardDoc, parseBoardDoc, parseBoardSelection, parseBoardUiState, parseBoardViewport,
  type BoardDoc, type BoardSummary, type BoardUiState, type BoardViewport,
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
        -- chat = 对话创作；board = 无限画布的 Agent 线程，不出现在侧栏
        kind                 TEXT NOT NULL DEFAULT 'chat',
        -- 无限画布线程指向的板 id；普通对话为 NULL
        board_id             TEXT,
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
        -- 场景名；空串 = 没有场景设定
        scene_name       TEXT NOT NULL DEFAULT '',
        kind             TEXT NOT NULL DEFAULT 'image',
        aspect_ratio     TEXT NOT NULL DEFAULT '',
        dialogue         TEXT NOT NULL DEFAULT '',
        speaker          TEXT NOT NULL DEFAULT '',
        shot_size        TEXT NOT NULL DEFAULT '',
        camera_move      TEXT NOT NULL DEFAULT '',
        sound_effect     TEXT NOT NULL DEFAULT '',
        duration_seconds INTEGER NOT NULL DEFAULT 5,
        video_prompt     TEXT NOT NULL DEFAULT '',
        voice            TEXT NOT NULL DEFAULT 'Kore',
        -- 视频输入：首帧默认用本镜分镜图；这里存用户主动覆盖的首帧 / 尾帧 / 参考图
        video_mode           TEXT NOT NULL DEFAULT 'first-frame',
        first_frame_asset_id TEXT,
        last_frame_asset_id  TEXT,
        reference_asset_ids  TEXT NOT NULL DEFAULT '[]',
        -- 尾帧续写出来的镜头指向来源镜头；普通镜头为 NULL
        parent_shot_id       TEXT,
        task_id          TEXT,
        video_task_id    TEXT,
        voice_task_id    TEXT,
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
        -- 设定图提示词（外貌 / 服装 / 年龄…）
        prompt           TEXT NOT NULL DEFAULT '',
        -- 角色固定音色；空串 = 用镜头 / 默认音色
        voice            TEXT NOT NULL DEFAULT '',
        asset_id         TEXT,
        task_id          TEXT,
        confirmed        INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        UNIQUE(conversation_id, name)
      );
      CREATE INDEX IF NOT EXISTS conversation_characters_conv_idx
        ON conversation_characters(conversation_id, name);
      -- 场景设定图：同一套「先生成、确认、再进分镜」的流程
      CREATE TABLE IF NOT EXISTS conversation_scenes (
        id               TEXT PRIMARY KEY,
        conversation_id  TEXT NOT NULL,
        name             TEXT NOT NULL,
        prompt           TEXT NOT NULL DEFAULT '',
        asset_id         TEXT,
        task_id          TEXT,
        confirmed        INTEGER NOT NULL DEFAULT 0,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        UNIQUE(conversation_id, name)
      );
      CREATE INDEX IF NOT EXISTS conversation_scenes_conv_idx
        ON conversation_scenes(conversation_id, name);
      -- 镜头图的手动布局。节点本身仍由分镜现算，这里只记用户拖过的坐标；
      -- 镜头的增删不会让这一行变成新数据源，找不到对应节点的行直接忽略。
      CREATE TABLE IF NOT EXISTS conversation_graph_positions (
        conversation_id TEXT NOT NULL,
        node_id         TEXT NOT NULL,
        x               REAL NOT NULL,
        y               REAL NOT NULL,
        updated_at      TEXT NOT NULL,
        PRIMARY KEY (conversation_id, node_id)
      );
      -- 无限画布：独立于会话的自由节点画布（FREE_CANVAS_PLAN.md）
      CREATE TABLE IF NOT EXISTS boards (
        id                     TEXT PRIMARY KEY,
        title                  TEXT NOT NULL,
        doc_json               TEXT NOT NULL,
        viewport_json          TEXT NOT NULL DEFAULT '',
        selection_json         TEXT NOT NULL DEFAULT '[]',
        ui_state_json          TEXT NOT NULL DEFAULT '',
        version                INTEGER NOT NULL DEFAULT 1,
        thread_conversation_id TEXT NOT NULL,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS boards_updated_idx ON boards(updated_at DESC);
      -- 每次保存前的快照；撤销 / 重做只移动当前版本指针，不删未来快照
      CREATE TABLE IF NOT EXISTS board_history (
        id         TEXT PRIMARY KEY,
        board_id   TEXT NOT NULL,
        version    INTEGER NOT NULL,
        doc_json   TEXT NOT NULL,
        reason     TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(board_id, version)
      );
      CREATE INDEX IF NOT EXISTS board_history_board_idx
        ON board_history(board_id, version DESC);
      -- 派生索引：文档里引用了哪些素材；保存时重建，删素材时按它找节点
      CREATE TABLE IF NOT EXISTS board_assets (
        board_id  TEXT NOT NULL,
        asset_id  TEXT NOT NULL,
        node_id   TEXT NOT NULL,
        PRIMARY KEY (board_id, node_id)
      );
      CREATE INDEX IF NOT EXISTS board_assets_asset_idx
        ON board_assets(board_id, asset_id);
      -- 任务 → 结果节点映射；完成事件和重启恢复都靠它回写
      CREATE TABLE IF NOT EXISTS board_tasks (
        task_id        TEXT NOT NULL,
        board_id       TEXT NOT NULL,
        config_node_id TEXT NOT NULL,
        result_node_id TEXT NOT NULL,
        kind           TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        -- 一个任务可能产出多张图（count > 1），所以主键必须是「任务 + 结果节点」
        PRIMARY KEY (task_id, result_node_id)
      );
      CREATE INDEX IF NOT EXISTS board_tasks_board_idx
        ON board_tasks(board_id, created_at DESC);
      -- 对话里生成、可反复导入无限画布的模板（分镜 / 提示词链 / 自由布局）
      CREATE TABLE IF NOT EXISTS canvas_templates (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        source          TEXT NOT NULL DEFAULT 'agent',
        conversation_id TEXT,
        doc_json        TEXT NOT NULL,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS canvas_templates_created_idx
        ON canvas_templates(created_at DESC);
      -- 旧分镜迁移记录：每个会话只迁移一次，避免重复生成画布
      CREATE TABLE IF NOT EXISTS storyboard_migrations (
        conversation_id TEXT PRIMARY KEY,
        board_id        TEXT NOT NULL,
        template_id     TEXT NOT NULL,
        version         INTEGER NOT NULL DEFAULT 1,
        created_at      TEXT NOT NULL
      );
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
    if (!shotColumns.some((col) => col.name === "scene_name")) {
      this.db.exec("ALTER TABLE conversation_shots ADD COLUMN scene_name TEXT NOT NULL DEFAULT ''");
    }
    // 分镜从「只有画面描述」升级成「台词 + 景别 / 运镜 + 视频提示词」；
    // 老数据库按列幂等补，历史镜头读到空串 / 默认时长，不会损坏原数据。
    for (const [column, ddl] of [
      ["dialogue", "ALTER TABLE conversation_shots ADD COLUMN dialogue TEXT NOT NULL DEFAULT ''"],
      ["speaker", "ALTER TABLE conversation_shots ADD COLUMN speaker TEXT NOT NULL DEFAULT ''"],
      ["shot_size", "ALTER TABLE conversation_shots ADD COLUMN shot_size TEXT NOT NULL DEFAULT ''"],
      ["camera_move", "ALTER TABLE conversation_shots ADD COLUMN camera_move TEXT NOT NULL DEFAULT ''"],
      ["sound_effect", "ALTER TABLE conversation_shots ADD COLUMN sound_effect TEXT NOT NULL DEFAULT ''"],
      ["duration_seconds", "ALTER TABLE conversation_shots ADD COLUMN duration_seconds INTEGER NOT NULL DEFAULT 5"],
      ["video_prompt", "ALTER TABLE conversation_shots ADD COLUMN video_prompt TEXT NOT NULL DEFAULT ''"],
      ["voice", "ALTER TABLE conversation_shots ADD COLUMN voice TEXT NOT NULL DEFAULT 'Kore'"],
      ["video_mode", "ALTER TABLE conversation_shots ADD COLUMN video_mode TEXT NOT NULL DEFAULT 'first-frame'"],
      ["first_frame_asset_id", "ALTER TABLE conversation_shots ADD COLUMN first_frame_asset_id TEXT"],
      ["last_frame_asset_id", "ALTER TABLE conversation_shots ADD COLUMN last_frame_asset_id TEXT"],
      ["reference_asset_ids", "ALTER TABLE conversation_shots ADD COLUMN reference_asset_ids TEXT NOT NULL DEFAULT '[]'"],
      ["parent_shot_id", "ALTER TABLE conversation_shots ADD COLUMN parent_shot_id TEXT"],
      ["video_task_id", "ALTER TABLE conversation_shots ADD COLUMN video_task_id TEXT"],
      ["voice_task_id", "ALTER TABLE conversation_shots ADD COLUMN voice_task_id TEXT"],
    ] as const) {
      if (!shotColumns.some((col) => col.name === column)) this.db.exec(ddl);
    }
    const characterColumns = this.db.prepare("PRAGMA table_info(conversation_characters)").all() as Array<{ name: string }>;
    for (const [column, ddl] of [
      ["prompt", "ALTER TABLE conversation_characters ADD COLUMN prompt TEXT NOT NULL DEFAULT ''"],
      ["voice", "ALTER TABLE conversation_characters ADD COLUMN voice TEXT NOT NULL DEFAULT ''"],
      ["task_id", "ALTER TABLE conversation_characters ADD COLUMN task_id TEXT"],
      ["confirmed", "ALTER TABLE conversation_characters ADD COLUMN confirmed INTEGER NOT NULL DEFAULT 0"],
    ] as const) {
      if (!characterColumns.some((item) => item.name === column)) this.db.exec(ddl);
    }
    // 分镜角色参考：老会话默认走 auto（第一个已完成的图片镜头）
    if (!conversationColumns.some((col) => col.name === "storyboard_reference_asset_id")) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN storyboard_reference_asset_id TEXT");
    }
    if (!conversationColumns.some((col) => col.name === "storyboard_reference_mode")) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN storyboard_reference_mode TEXT NOT NULL DEFAULT 'auto'");
    }
    // 无限画布线程：普通对话默认 chat；board 线程不出现在侧栏
    if (!conversationColumns.some((col) => col.name === "kind")) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'");
    }
    if (!conversationColumns.some((col) => col.name === "board_id")) {
      this.db.exec("ALTER TABLE conversations ADD COLUMN board_id TEXT");
    }
    // 一块板只能有一条 Agent 线程；必须在 kind / board_id 都加完之后再建
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS conversations_board_thread_idx
        ON conversations(board_id) WHERE kind = 'board' AND board_id IS NOT NULL
    `);
    // P0 的 board_tasks 是 task_id 单主键，装不下 count>1 的多个结果节点。
    // P1 接入前这张表还没有任何行，所以旧表直接重建；有数据就保留旧表不动。
    const boardTaskColumns = this.db.prepare("PRAGMA table_info(board_tasks)").all() as Array<{ name: string; pk: number }>;
    const hasCompositeTaskPk = boardTaskColumns.some((column) => column.name === "result_node_id" && column.pk > 0);
    if (boardTaskColumns.length && !hasCompositeTaskPk) {
      const rows = this.db.prepare("SELECT COUNT(*) AS total FROM board_tasks").get() as DbRow;
      if (Number(rows.total) === 0) {
        this.db.exec(`
          DROP TABLE board_tasks;
          CREATE TABLE board_tasks (
            task_id        TEXT NOT NULL,
            board_id       TEXT NOT NULL,
            config_node_id TEXT NOT NULL,
            result_node_id TEXT NOT NULL,
            kind           TEXT NOT NULL,
            created_at     TEXT NOT NULL,
            PRIMARY KEY (task_id, result_node_id)
          );
          CREATE INDEX IF NOT EXISTS board_tasks_board_idx
            ON board_tasks(board_id, created_at DESC);
        `);
      }
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

    // 分镜迁移从 v1（只有镜头节点）升级到 v2（含角色 / 场景设定参考）
    const storyboardMigrationColumns = this.db.prepare("PRAGMA table_info(storyboard_migrations)").all() as Array<{ name: string }>;
    if (!storyboardMigrationColumns.some((column) => column.name === "version")) {
      this.db.exec("ALTER TABLE storyboard_migrations ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
    }

    // 产品名从「创作板」改成「无限画布」：只改默认标题和 Agent 线程前缀，
    // 用户自己改过的板名不动。
    this.db.prepare("UPDATE boards SET title = '未命名无限画布' WHERE title = '未命名创作板'").run();
    this.db.prepare(`
      UPDATE conversations SET title = replace(title, '创作板', '无限画布')
      WHERE kind = 'board' AND board_id IS NOT NULL AND title LIKE '创作板%'
    `).run();

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
    for (const row of uploads) assets.push(...this.deleteTask(String(row.id)).assets);
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

  private boardFromRow(row: DbRow): BoardRecord {
    let doc: BoardDoc;
    try {
      // 坏文档退回空板，不让一块坏数据把整个工作区打不开
      doc = parseBoardDoc(parseJson(row.doc_json, createEmptyBoardDoc()));
    } catch {
      doc = createEmptyBoardDoc();
    }
    return {
      id: String(row.id),
      title: String(row.title),
      doc,
      viewport: parseBoardViewport(parseJson(row.viewport_json, {})),
      selection: parseBoardSelection(parseJson(row.selection_json, [])),
      uiState: parseBoardUiState(parseJson(row.ui_state_json, {})),
      version: Number(row.version),
      threadId: String(row.thread_conversation_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

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

  createBoardRecord(input: {
    id: string;
    title: string;
    threadConversationId: string;
    doc?: BoardDoc;
  }): BoardRecord {
    const at = now();
    const doc = input.doc ?? createEmptyBoardDoc();
    const docJson = JSON.stringify(doc);
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        INSERT INTO boards
        (id, title, doc_json, viewport_json, selection_json, ui_state_json, version,
         thread_conversation_id, created_at, updated_at)
        VALUES (?, ?, ?, '', '[]', '', 1, ?, ?, ?)
      `).run(input.id, input.title, docJson, input.threadConversationId, at, at);
      // 初始版本也进历史：第一次编辑后可以撤销回空板
      this.db.prepare(`
        INSERT OR IGNORE INTO board_history (id, board_id, version, doc_json, reason, created_at)
        VALUES (?, ?, 1, ?, 'create', ?)
      `).run(crypto.randomUUID(), input.id, docJson, at);
      this.replaceBoardAssetsUnsafe(input.id, doc);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getBoardRecord(input.id)!;
  }

  getBoardRecord(id: string): BoardRecord | null {
    const row = this.db.prepare("SELECT * FROM boards WHERE id = ?").get(id) as DbRow | undefined;
    return row ? this.boardFromRow(row) : null;
  }

  listBoardRecords(): BoardRecord[] {
    const rows = this.db.prepare("SELECT * FROM boards ORDER BY updated_at DESC").all() as DbRow[];
    return rows.map((row) => this.boardFromRow(row));
  }

  listBoardSummaries(): BoardSummary[] {
    return this.listBoardRecords().map((board) => ({
      id: board.id,
      title: board.title,
      nodeCount: board.doc.nodes.length,
      edgeCount: board.doc.edges.length,
      updatedAt: board.updatedAt,
      threadId: board.threadId,
    }));
  }

  getBoardByThread(threadId: string): BoardRecord | null {
    const row = this.db.prepare("SELECT * FROM boards WHERE thread_conversation_id = ?").get(threadId) as DbRow | undefined;
    return row ? this.boardFromRow(row) : null;
  }

  updateBoardTitle(id: string, title: string): BoardRecord | null {
    const at = now();
    const board = this.getBoardRecord(id);
    if (!board) return null;
    this.db.prepare("UPDATE boards SET title = ?, updated_at = ? WHERE id = ?").run(title, at, id);
    // 线程标题跟着板走，但线程本身不会出现在对话侧栏
    this.db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(`无限画布 · ${title}`, at, board.threadId);
    return this.getBoardRecord(id);
  }

  /** 保存一次新版本：旧版本进历史，新文档落库，素材索引重建 */
  saveBoardSnapshot(input: {
    boardId: string;
    previousDoc: BoardDoc;
    doc: BoardDoc;
    viewport?: BoardViewport;
    version: number;
    reason: string;
  }): void {
    const at = now();
    const docJson = JSON.stringify(input.doc);
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO board_history (id, board_id, version, doc_json, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(), input.boardId, input.version - 1,
        JSON.stringify(input.previousDoc), input.reason, at,
      );
      if (input.viewport) {
        this.db.prepare(`
          UPDATE boards SET doc_json = ?, viewport_json = ?, version = ?, updated_at = ? WHERE id = ?
        `).run(docJson, JSON.stringify(input.viewport), input.version, at, input.boardId);
      } else {
        this.db.prepare(`
          UPDATE boards SET doc_json = ?, version = ?, updated_at = ? WHERE id = ?
        `).run(docJson, input.version, at, input.boardId);
      }
      // 撤销后重新编辑：未来快照作废，避免重做跳回一条已经不存在的分支
      this.db.prepare("DELETE FROM board_history WHERE board_id = ? AND version > ?")
        .run(input.boardId, input.version);
      // 新版本自身也要有快照，否则撤销到上一版之后没有东西可以重做。
      // 用 REPLACE：撤销后重新编辑时，同一版本号可能已经有一条旧分支的快照。
      this.db.prepare(`
        INSERT OR REPLACE INTO board_history (id, board_id, version, doc_json, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), input.boardId, input.version, docJson, input.reason, at);
      this.replaceBoardAssetsUnsafe(input.boardId, input.doc);
      this.trimBoardHistoryUnsafe(input.boardId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 撤销 / 重做：只移动版本指针，不动历史（未来版本要留给重做） */
  moveBoardVersion(input: {
    boardId: string;
    version: number;
    doc: BoardDoc;
    viewport?: BoardViewport;
  }): void {
    const at = now();
    this.db.exec("BEGIN");
    try {
      if (input.viewport) {
        this.db.prepare("UPDATE boards SET doc_json = ?, viewport_json = ?, version = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(input.doc), JSON.stringify(input.viewport), input.version, at, input.boardId);
      } else {
        this.db.prepare("UPDATE boards SET doc_json = ?, version = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(input.doc), input.version, at, input.boardId);
      }
      this.replaceBoardAssetsUnsafe(input.boardId, input.doc);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listBoardHistoryVersions(boardId: string): number[] {
    const rows = this.db.prepare(
      "SELECT version FROM board_history WHERE board_id = ? ORDER BY version ASC",
    ).all(boardId) as DbRow[];
    return rows.map((row) => Number(row.version));
  }

  listBoardHistoryEntries(boardId: string): Array<{ version: number; reason: string; createdAt: string }> {
    const rows = this.db.prepare(
      "SELECT version, reason, created_at FROM board_history WHERE board_id = ? ORDER BY version DESC",
    ).all(boardId) as DbRow[];
    return rows.map((row) => ({
      version: Number(row.version),
      reason: String(row.reason ?? ""),
      createdAt: String(row.created_at),
    }));
  }

  getBoardHistoryDoc(boardId: string, version: number): BoardDoc | null {
    const row = this.db.prepare(
      "SELECT doc_json FROM board_history WHERE board_id = ? AND version = ?",
    ).get(boardId, version) as DbRow | undefined;
    if (!row) return null;
    try {
      return parseBoardDoc(parseJson(row.doc_json, createEmptyBoardDoc()));
    } catch {
      return null;
    }
  }

  saveBoardViewport(boardId: string, viewport: BoardViewport): void {
    this.db.prepare("UPDATE boards SET viewport_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(viewport), now(), boardId);
  }

  /** 选中状态不碰 updated_at：点一下节点不该把无限画布顶到列表最前面 */
  saveBoardSelection(boardId: string, selection: string[]): void {
    this.db.prepare("UPDATE boards SET selection_json = ? WHERE id = ?")
      .run(JSON.stringify(selection), boardId);
  }

  saveBoardUiState(boardId: string, uiState: BoardUiState): void {
    this.db.prepare("UPDATE boards SET ui_state_json = ? WHERE id = ?")
      .run(JSON.stringify(uiState), boardId);
  }

  listBoardAssets(boardId: string): Asset[] {
    const rows = this.db.prepare(`
      SELECT assets.* FROM board_assets
      JOIN assets ON assets.id = board_assets.asset_id
      WHERE board_assets.board_id = ?
      ORDER BY assets.created_at ASC
    `).all(boardId) as DbRow[];
    const seen = new Set<string>();
    const result: Asset[] = [];
    for (const row of rows) {
      const id = String(row.id);
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(this.assetView(this.assetFromRow(row)));
    }
    return result;
  }

  /** 上传后、文档保存前的临时链接；下一次保存会按文档重建并覆盖掉它 */
  insertBoardAssetLink(boardId: string, assetId: string, nodeId: string): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO board_assets (board_id, asset_id, node_id) VALUES (?, ?, ?)",
    ).run(boardId, assetId, nodeId);
  }

  findBoardAssetRefs(assetId: string): Array<{ boardId: string; nodeId: string }> {
    const rows = this.db.prepare(
      "SELECT board_id, node_id FROM board_assets WHERE asset_id = ?",
    ).all(assetId) as DbRow[];
    return rows.map((row) => ({ boardId: String(row.board_id), nodeId: String(row.node_id) }));
  }

  deleteBoardCascade(boardId: string): { threadId: string } | null {
    const board = this.getBoardRecord(boardId);
    if (!board) return null;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM board_history WHERE board_id = ?").run(boardId);
      this.db.prepare("DELETE FROM board_assets WHERE board_id = ?").run(boardId);
      this.db.prepare("DELETE FROM board_tasks WHERE board_id = ?").run(boardId);
      this.db.prepare("DELETE FROM boards WHERE id = ?").run(boardId);
      this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(board.threadId);
      this.db.prepare("DELETE FROM conversation_documents WHERE conversation_id = ?").run(board.threadId);
      this.db.prepare("DELETE FROM conversation_shots WHERE conversation_id = ?").run(board.threadId);
      this.db.prepare("DELETE FROM conversation_characters WHERE conversation_id = ?").run(board.threadId);
      this.db.prepare("DELETE FROM conversation_scenes WHERE conversation_id = ?").run(board.threadId);
      this.db.prepare("DELETE FROM conversation_graph_positions WHERE conversation_id = ?").run(board.threadId);
      this.db.prepare("DELETE FROM brain_calls WHERE conversation_id = ?").run(board.threadId);
      this.db.prepare("DELETE FROM conversations WHERE id = ?").run(board.threadId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { threadId: board.threadId };
  }

  addBoardTaskRows(input: {
    taskId: string;
    boardId: string;
    configNodeId: string;
    resultNodeIds: string[];
    kind: string;
  }): void {
    if (!input.resultNodeIds.length) return;
    const at = now();
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO board_tasks
      (task_id, board_id, config_node_id, result_node_id, kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.db.exec("BEGIN");
    try {
      for (const resultNodeId of input.resultNodeIds) {
        insert.run(input.taskId, input.boardId, input.configNodeId, resultNodeId, input.kind, at);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listBoardTasksByTask(taskId: string): Array<{
    taskId: string; boardId: string; configNodeId: string; resultNodeId: string; kind: string; createdAt: string;
  }> {
    const rows = this.db.prepare(
      "SELECT * FROM board_tasks WHERE task_id = ? ORDER BY rowid ASC",
    ).all(taskId) as DbRow[];
    return rows.map((row) => ({
      taskId: String(row.task_id),
      boardId: String(row.board_id),
      configNodeId: String(row.config_node_id),
      resultNodeId: String(row.result_node_id),
      kind: String(row.kind),
      createdAt: String(row.created_at),
    }));
  }

  listBoardTasksByBoard(boardId: string): Array<{
    taskId: string; boardId: string; configNodeId: string; resultNodeId: string; kind: string; createdAt: string;
  }> {
    const rows = this.db.prepare(
      "SELECT * FROM board_tasks WHERE board_id = ? ORDER BY created_at ASC, rowid ASC",
    ).all(boardId) as DbRow[];
    return rows.map((row) => ({
      taskId: String(row.task_id),
      boardId: String(row.board_id),
      configNodeId: String(row.config_node_id),
      resultNodeId: String(row.result_node_id),
      kind: String(row.kind),
      createdAt: String(row.created_at),
    }));
  }

  deleteBoardTaskRows(taskId: string): void {
    this.db.prepare("DELETE FROM board_tasks WHERE task_id = ?").run(taskId);
  }

  private replaceBoardAssetsUnsafe(boardId: string, doc: BoardDoc): void {
    this.db.prepare("DELETE FROM board_assets WHERE board_id = ?").run(boardId);
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO board_assets (board_id, asset_id, node_id) VALUES (?, ?, ?)",
    );
    for (const node of doc.nodes) {
      if ((node.type === "image" || node.type === "video" || node.type === "audio") && node.assetId) {
        insert.run(boardId, node.assetId, node.id);
      }
    }
  }

  private trimBoardHistoryUnsafe(boardId: string): void {
    // 保留最新 50 个版本。offset 50 的那一行就是「第 51 新」，它及更老的都删
    const cutoff = this.db.prepare(
      "SELECT version FROM board_history WHERE board_id = ? ORDER BY version DESC LIMIT 1 OFFSET ?",
    ).get(boardId, BOARD_LIMITS.maxHistory) as DbRow | undefined;
    if (!cutoff) return;
    this.db.prepare("DELETE FROM board_history WHERE board_id = ? AND version <= ?")
      .run(boardId, Number(cutoff.version));
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
