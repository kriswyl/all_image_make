/**
 * 无限画布服务层：建板、读写文档、历史、素材、上传。
 *
 * 这一层只做业务规则和校验；SQL 在 db.ts，HTTP 在 app.ts。
 * P0 不包含生成；配置节点的图片生成在 P1 接进来，仍然复用 TaskRunner。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppDatabase, AssetRow, BoardRecord } from "./db.js";
import {
  allocateNodeRef, boardGroups, BoardValidationError, BOARD_LIMITS, composeConfigPrompt, directInputLinks,
  directUpstreamImages,
  parseBoardDoc, parseBoardExport, parseBoardSelection, parseBoardUiState, parseBoardViewport,
  type BoardDelta, type BoardDoc, type BoardEdge, type BoardEdgeRole, type BoardGeneratorNode, type BoardGroup,
  type BoardNode, type BoardSummary, type BoardUiState, type BoardView, type BoardViewport,
  type BoardVideoMode, type BoardAudioKind,
  type AudioBoardNode, type ConfigBoardNode, type ImageBoardNode, type VideoBoardNode,
} from "../shared/board.js";
import { AppError } from "./tasks.js";
import {
  extensionForMime, matchesImageSignature, type ReferenceImageUpload, type TaskRunner,
} from "./tasks.js";
import { prepareImageBytes, REFERENCE_PROFILE, videoInlineProfile, writeThumbnail } from "./vision.js";
import { buildCapabilityAliases, resolveAlias } from "./capabilities.js";
import type {
  Asset, GenerationInput, KlingMediaType, SeedanceVideoMode, Task, VideoMediaType, WanVideoMode,
} from "../shared/types.js";
import { MAX_CANVAS_IMAGES } from "../shared/types.js";
import {
  supportedVideoModes, VIDEO_CAPABILITIES, VIDEO_DEFAULTS, videoModeLabel,
  type ConversationVideoMode, type VideoAdapter,
} from "../shared/video-capabilities.js";
import type { ConversationVideoRole } from "../shared/agent-types.js";
import { TTS_DEFAULT_VOICE, TTS_VOICES } from "../shared/tts.js";
import { pickBrainChannel, readAgentDefaults } from "./agent-settings.js";
import { BRAIN_RETRY_MAX_TOKENS, callBrain } from "./brain.js";
import type { KeyStore } from "./key-store.js";

const IMAGE_MIME = ["image/png", "image/jpeg", "image/webp"] as const;
const DEFAULT_BOARD_TITLE = "未命名无限画布";

function now() {
  return new Date().toISOString();
}

function normalizeTitle(value: unknown): string {
  const title = typeof value === "string" ? value.trim() : "";
  return (title || DEFAULT_BOARD_TITLE).slice(0, BOARD_LIMITS.maxTitleChars);
}

interface NodeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: NodeRect, b: NodeRect, gap = 24): boolean {
  return a.x < b.x + b.width + gap
    && a.x + a.width + gap > b.x
    && a.y < b.y + b.height + gap
    && a.y + a.height + gap > b.y;
}

/**
 * 给生成结果找一个不压住已有节点的位置。
 *
 * 以前的算法固定放在配置节点右侧 120px，模板里每行都这么放时，下一行的
 * 文本 / 配置节点正好在落点上，于是新图直接盖住旧卡片。这里从「当前内容最右侧」
 * 开始向右下扫描，直到整块矩形与所有节点都不相交。
 */
function placeResultNode(
  nodes: BoardNode[],
  size: { width: number; height: number },
  preferredX: number,
  preferredY: number,
): { x: number; y: number } {
  // 先试配置节点右侧；被占就往下找，一列排满再往右挪一列。
  // 这样结果通常还在原节点附近，又不会盖住下一行的文本 / 配置卡。
  for (let column = 0; column < 12; column += 1) {
    const x = Math.round(preferredX + column * (size.width + 120));
    for (let row = 0; row < 40; row += 1) {
      const y = Math.round(preferredY + row * (size.height + 48));
      const candidate = { x, y, ...size };
      if (!nodes.some((node) => overlaps(candidate, node))) return { x, y };
    }
  }
  const maxRight = nodes.length ? Math.max(...nodes.map((node) => node.x + node.width)) : 0;
  return { x: Math.round(maxRight + 160), y: Math.round(preferredY) };
}

function boardView(db: AppDatabase, board: BoardRecord): BoardView {
  const versions = db.listBoardHistoryVersions(board.id);
  const nodeIds = new Set(board.doc.nodes.map((node) => node.id));
  return {
    id: board.id,
    title: board.title,
    doc: board.doc,
    viewport: board.viewport,
    // 撤销 / 外部修改后，选中集合里可能还留着已经被删掉的节点
    selection: board.selection.filter((id) => nodeIds.has(id)),
    uiState: board.uiState,
    version: board.version,
    threadId: board.threadId,
    canUndo: versions.some((version) => version < board.version),
    canRedo: versions.some((version) => version > board.version),
  };
}

/**
 * 计算两份文档的增量。
 *
 * 节点 / 连线 / 分组都按 id 比较 JSON；顺序变化不算修改（排序由位置决定）。
 * 只给 Agent 修改用，所以不比较 viewport / selection / title。
 */
export function buildBoardDelta(
  boardId: string,
  before: BoardDoc,
  after: BoardDoc,
  baseVersion: number,
  version: number,
): BoardDelta {
  const diff = <T extends { id: string }>(oldItems: T[], newItems: T[]) => {
    const oldMap = new Map(oldItems.map((item) => [item.id, JSON.stringify(item)]));
    const newIds = new Set(newItems.map((item) => item.id));
    return {
      upserts: newItems.filter((item) => oldMap.get(item.id) !== JSON.stringify(item)),
      removed: oldItems.filter((item) => !newIds.has(item.id)).map((item) => item.id),
    };
  };
  const nodes = diff(before.nodes, after.nodes);
  const edges = diff(before.edges, after.edges);
  const groups = diff(boardGroups(before), boardGroups(after));
  return {
    boardId,
    baseVersion,
    version,
    nextRef: after.nextRef,
    nodes: nodes.upserts,
    edges: edges.upserts,
    groups: groups.upserts,
    removedNodeIds: nodes.removed,
    removedEdgeIds: edges.removed,
    removedGroupIds: groups.removed,
  };
}

function requireBoard(db: AppDatabase, id: string): BoardRecord {
  const board = db.getBoardRecord(id);
  if (!board) throw new AppError("BOARD_NOT_FOUND", "无限画布不存在", 404);
  return board;
}

function parseDocOrThrow(value: unknown): BoardDoc {
  try {
    return parseBoardDoc(value);
  } catch (error) {
    if (error instanceof BoardValidationError) {
      throw new AppError("BOARD_DOC_INVALID", error.message, 400);
    }
    throw error;
  }
}

/**
 * 只允许引用当前无限画布已经链接的素材。
 *
 * 这样既挡住跨板引用，也挡住用户手改 JSON 指向磁盘上的任意文件。
 * 上传后会先插一条临时 board_assets 链接，保存文档时再按节点重建。
 */
export function assertDocAssets(db: AppDatabase, boardId: string, doc: BoardDoc): void {
  const linkedAssetIds = new Set(db.listBoardAssets(boardId).map((asset) => asset.id));
  // 刚生成完、还没保存过文档的素材，靠 board_tasks 证明它属于这块板。
  // 下一次保存会把它写进 board_assets，之后就走上一条分支。
  const taskIds = new Set(db.listBoardTasksByBoard(boardId).map((task) => task.taskId));
  for (const node of doc.nodes) {
    if (node.type !== "image" && node.type !== "video" && node.type !== "audio") continue;
    if (!node.assetId) continue;
    const asset = db.getAsset(node.assetId);
    if (!asset) {
      throw new AppError("BOARD_ASSET_INVALID", `节点「${node.title || node.ref}」引用的素材不存在`, 400);
    }
    if (!linkedAssetIds.has(node.assetId) && !taskIds.has(asset.taskId)) {
      throw new AppError("BOARD_ASSET_INVALID", `节点「${node.title || node.ref}」引用的素材不属于当前无限画布`, 400);
    }
    if (node.type === "image" && !asset.mimeType.startsWith("image/")) {
      throw new AppError("BOARD_ASSET_INVALID", `节点「${node.title || node.ref}」需要图片素材`, 400);
    }
    if (node.type === "video" && !asset.mimeType.startsWith("video/")) {
      throw new AppError("BOARD_ASSET_INVALID", `节点「${node.title || node.ref}」需要视频素材`, 400);
    }
    if (node.type === "audio" && !asset.mimeType.startsWith("audio/")) {
      throw new AppError("BOARD_ASSET_INVALID", `节点「${node.title || node.ref}」需要音频素材`, 400);
    }
  }
}

/**
 * 新建无限画布 + 它自己的 Agent 线程。
 *
 * 没有对话渠道时也允许建板：画布本身不依赖大脑，只有浮动 Agent 会提示先配模型。
 * 这样用户可以在还没配置对话模型时先用画布。
 */
export function createBoard(db: AppDatabase, input: { title?: string } = {}): BoardView {
  const defaults = readAgentDefaults(db);
  let brain = { channelId: "", model: "" };
  try {
    brain = pickBrainChannel(db);
  } catch {
    // 画布可以先建；Agent 面板打开时会给出明确的模型配置提示
  }
  const id = crypto.randomUUID();
  const title = normalizeTitle(input.title);
  const thread = db.createConversation({
    title: `无限画布 · ${title}`,
    brainChannelId: brain.channelId,
    brainModel: brain.model,
    videoConfirmPolicy: defaults.videoConfirmPolicy,
    visionEnabled: defaults.visionEnabled,
    verbatimPrompt: false,
    kind: "board",
    boardId: id,
  });
  const board = db.createBoardRecord({
    id,
    title,
    threadConversationId: thread.id,
  });
  return boardView(db, board);
}

export function getBoard(db: AppDatabase, id: string): BoardView | null {
  const board = db.getBoardRecord(id);
  return board ? boardView(db, board) : null;
}

export function listBoards(db: AppDatabase): BoardSummary[] {
  return db.listBoardSummaries();
}

export function deleteBoard(db: AppDatabase, id: string): { threadId: string } {
  const deleted = db.deleteBoardCascade(id);
  if (!deleted) throw new AppError("BOARD_NOT_FOUND", "无限画布不存在", 404);
  return deleted;
}

export function renameBoard(db: AppDatabase, id: string, title: unknown): BoardView {
  const board = db.updateBoardTitle(id, normalizeTitle(title));
  if (!board) throw new AppError("BOARD_NOT_FOUND", "无限画布不存在", 404);
  return boardView(db, board);
}

/**
 * 导入一份无限画布导出文件。
 *
 * 节点里的 assetId 只有在当前安装里真的存在、且类型对得上时才复用；
 * 否则把节点清空并返回给用户，不让一份从别的机器导出的文档直接打不开。
 * 同一台机器上导入 = 跨板复用素材（同一张素材会被两块板同时引用）。
 */
export function importBoard(db: AppDatabase, input: { file: unknown }): {
  board: BoardView;
  missingAssets: string[];
} {
  let parsed: { title: string; doc: BoardDoc };
  try {
    parsed = parseBoardExport(input.file);
  } catch (error) {
    if (error instanceof BoardValidationError) throw new AppError("BOARD_IMPORT_INVALID", error.message, 400);
    throw error;
  }

  const created = createBoard(db, { title: parsed.title });
  const missingAssets: string[] = [];
  const nodes = parsed.doc.nodes.map((node): BoardNode => {
    if (node.type !== "image" && node.type !== "video" && node.type !== "audio") return node;
    if (!node.assetId) return node;
    const asset = db.getAsset(node.assetId);
    const prefix = node.type === "image" ? "image/" : node.type === "video" ? "video/" : "audio/";
    const valid = Boolean(asset) && asset!.mimeType.startsWith(prefix);
    if (!asset || !valid) {
      missingAssets.push(node.ref);
      return { ...node, assetId: null, status: "empty", error: undefined } as BoardNode;
    }
    db.insertBoardAssetLink(created.id, node.assetId, node.id);
    return node;
  });
  const doc = parseDocOrThrow({ ...parsed.doc, nodes });
  const record = requireBoard(db, created.id);
  db.saveBoardSnapshot({
    boardId: created.id,
    previousDoc: record.doc,
    doc,
    version: record.version + 1,
    reason: "import",
  });
  return { board: getBoard(db, created.id)!, missingAssets };
}

export interface SaveBoardInput {
  doc: unknown;
  viewport?: unknown;
  baseVersion: number;
  reason?: string;
}

/**
 * 保存整份文档。
 *
 * `baseVersion` 不匹配返回 409，并在 details 里带上当前版本——客户端据此重载，
 * 而不是把本地改动硬盖到别人的修改上（Agent 和另一个窗口都可能改同一块板）。
 */
export function saveBoard(db: AppDatabase, id: string, input: SaveBoardInput): BoardView {
  const board = requireBoard(db, id);
  if (!Number.isInteger(input.baseVersion) || input.baseVersion < 1) {
    throw new AppError("BOARD_VERSION_INVALID", "baseVersion 不合法", 400);
  }
  if (input.baseVersion !== board.version) {
    throw new AppError("BOARD_VERSION_CONFLICT", "无限画布已在别处更新，请重新加载", 409, { board: boardView(db, board) });
  }

  const doc = parseDocOrThrow(input.doc);
  const viewport = input.viewport === undefined ? undefined : parseBoardViewport(input.viewport);
  const docChanged = JSON.stringify(doc) !== JSON.stringify(board.doc);

  if (!docChanged) {
    if (viewport && JSON.stringify(viewport) !== JSON.stringify(board.viewport)) {
      db.saveBoardViewport(id, viewport);
    }
    return boardView(db, requireBoard(db, id));
  }

  assertDocAssets(db, id, doc);
  db.saveBoardSnapshot({
    boardId: id,
    previousDoc: board.doc,
    doc,
    ...(viewport ? { viewport } : {}),
    version: board.version + 1,
    reason: typeof input.reason === "string" && input.reason.trim()
      ? input.reason.trim().slice(0, 200)
      : "manual",
  });
  return boardView(db, requireBoard(db, id));
}

export function undoBoard(db: AppDatabase, id: string, baseVersion: number): BoardView {
  const board = requireBoard(db, id);
  if (baseVersion !== board.version) {
    throw new AppError("BOARD_VERSION_CONFLICT", "无限画布已在别处更新，请重新加载", 409, { board: boardView(db, board) });
  }
  const versions = db.listBoardHistoryVersions(id);
  const target = [...versions].reverse().find((version) => version < board.version);
  if (target === undefined) throw new AppError("BOARD_UNDO_EMPTY", "没有可撤销的版本", 400);
  const doc = db.getBoardHistoryDoc(id, target);
  if (!doc) throw new AppError("BOARD_HISTORY_MISSING", "撤销快照已丢失", 500);
  db.moveBoardVersion({ boardId: id, version: target, doc });
  return boardView(db, requireBoard(db, id));
}

export function redoBoard(db: AppDatabase, id: string, baseVersion: number): BoardView {
  const board = requireBoard(db, id);
  if (baseVersion !== board.version) {
    throw new AppError("BOARD_VERSION_CONFLICT", "无限画布已在别处更新，请重新加载", 409, { board: boardView(db, board) });
  }
  const versions = db.listBoardHistoryVersions(id);
  const target = versions.find((version) => version > board.version);
  if (target === undefined) throw new AppError("BOARD_REDO_EMPTY", "没有可重做的版本", 400);
  const doc = db.getBoardHistoryDoc(id, target);
  if (!doc) throw new AppError("BOARD_HISTORY_MISSING", "重做快照已丢失", 500);
  db.moveBoardVersion({ boardId: id, version: target, doc });
  return boardView(db, requireBoard(db, id));
}

export interface BoardHistoryEntry {
  version: number;
  reason: string;
  createdAt: string;
  current: boolean;
}

/** 创作历史：版本快照 + 当时的原因。当前版本即使没有快照行也要出现在列表里 */
export function listBoardHistory(db: AppDatabase, id: string): {
  currentVersion: number;
  entries: BoardHistoryEntry[];
} {
  const board = requireBoard(db, id);
  // 撤销后 board_history 里还留着「未来」的重做快照；创作历史只展示走到过的版本
  const entries = db.listBoardHistoryEntries(id)
    .filter((entry) => entry.version <= board.version)
    .map((entry) => ({
      ...entry,
      current: entry.version === board.version,
    }));
  if (!entries.some((entry) => entry.version === board.version)) {
    entries.push({
      version: board.version,
      reason: "当前版本",
      createdAt: board.updatedAt,
      current: true,
    });
  }
  entries.sort((left, right) => right.version - left.version);
  return { currentVersion: board.version, entries };
}

/** 恢复到某个历史版本：不是回退指针，而是把旧文档作为新版本保存，撤销仍然可用 */
export function restoreBoardVersion(db: AppDatabase, id: string, version: number, baseVersion: number): BoardView {
  const board = requireBoard(db, id);
  if (baseVersion !== board.version) {
    throw new AppError("BOARD_VERSION_CONFLICT", "无限画布已在别处更新，请重新加载", 409, { board: boardView(db, board) });
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new AppError("BOARD_HISTORY_INVALID", "历史版本号不合法", 400);
  }
  if (version === board.version) return boardView(db, board);
  const doc = db.getBoardHistoryDoc(id, version);
  if (!doc) throw new AppError("BOARD_HISTORY_MISSING", "这个历史版本已经不存在", 404);
  db.saveBoardSnapshot({
    boardId: id,
    previousDoc: board.doc,
    doc,
    version: board.version + 1,
    reason: `restore:${version}`.slice(0, 200),
  });
  return boardView(db, requireBoard(db, id));
}

export function saveBoardViewport(db: AppDatabase, id: string, viewport: unknown): BoardView {
  requireBoard(db, id);
  db.saveBoardViewport(id, parseBoardViewport(viewport));
  return boardView(db, requireBoard(db, id));
}

export function saveBoardSelection(db: AppDatabase, id: string, selection: unknown): void {
  const board = requireBoard(db, id);
  const nodeIds = new Set(board.doc.nodes.map((node) => node.id));
  const ids = parseBoardSelection(selection).filter((nodeId) => nodeIds.has(nodeId));
  db.saveBoardSelection(id, ids);
}

export function saveBoardUiState(db: AppDatabase, id: string, uiState: unknown): void {
  requireBoard(db, id);
  db.saveBoardUiState(id, parseBoardUiState(uiState));
}

export interface BoardGenerateResult {
  board: BoardView;
  /** 文本生成是同步的，没有任务；图片 / 视频才有 */
  task: Task | null;
  kind: "image" | "video" | "text" | "audio";
  resultNodeIds: string[];
  configNodeId: string;
  prompt: string;
  referenceCount: number;
  modelAlias: string;
}

export interface BoardGenerateOverrides {
  prompt?: string;
  model?: string;
  size?: string;
  imageSize?: string;
  quality?: string;
  negativePrompt?: string;
  aspectRatio?: string;
  seed?: number;
  style?: "auto" | "vivid" | "natural";
  background?: "auto" | "opaque" | "transparent";
  outputFormat?: "png" | "jpeg" | "webp";
  moderation?: "auto" | "low";
  count?: number;
  videoMode?: BoardVideoMode;
  durationSeconds?: number;
  resolution?: string;
  audio?: boolean;
  promptExtend?: boolean;
  watermark?: boolean;
  audioKind?: BoardAudioKind;
  voice?: string;
  ttsStyle?: string;
  instrumental?: boolean;
  musicTitle?: string;
  musicTags?: string;
  musicNegativeTags?: string;
}

/**
 * 在配置节点上生成图片（P1）。
 *
 * 只做图片：视频需要首帧 / 尾帧 / 参考图角色，放到 P3。
 * 生成结果先落成占位节点，任务完成后由客户端轮询回填；服务端不在任务回调里
 * 改文档，避免和用户正在编辑的文档抢版本。
 */
/** 确认任务确实是这块板发起的；不允许凭 taskId 操作别的板的任务 */
function requireBoardTask(db: AppDatabase, boardId: string, taskId: string) {
  const rows = db.listBoardTasksByTask(taskId).filter((row) => row.boardId === boardId);
  if (!rows.length) throw new AppError("BOARD_TASK_NOT_FOUND", "这个任务不属于当前无限画布", 404);
  return rows;
}

export function cancelBoardTask(db: AppDatabase, runner: TaskRunner, boardId: string, taskId: string): Task {
  requireBoardTask(db, boardId, taskId);
  return runner.cancel(taskId);
}

export async function retryBoardTask(input: {
  db: AppDatabase;
  runner: TaskRunner;
  boardId: string;
  taskId: string;
}): Promise<{ task: Task; resultNodeIds: string[]; configNodeId: string }> {
  const rows = requireBoardTask(input.db, input.boardId, input.taskId);
  const resultNodeIds = rows.map((row) => row.resultNodeId);
  const task = await input.runner.retry(input.taskId);
  input.db.addBoardTaskRows({
    taskId: task.id,
    boardId: input.boardId,
    configNodeId: rows[0]!.configNodeId,
    resultNodeIds,
    kind: rows[0]!.kind,
  });
  return { task, resultNodeIds, configNodeId: rows[0]!.configNodeId };
}

interface BoardVideoInput {
  node: ImageBoardNode;
  assetId: string;
  role: ConversationVideoRole;
}

interface BoardVideoSelection {
  mode: ConversationVideoMode;
  inputs: BoardVideoInput[];
}

type BoardEdgeVideoRole = ConversationVideoRole | "auto";

/** 没有 role 的连线是「自动」；显式选了参考图才按参考图算 */
function edgeVideoRole(role: BoardEdgeRole | undefined): BoardEdgeVideoRole {
  if (role === "first-frame") return "first_frame";
  if (role === "last-frame") return "last_frame";
  if (role === "reference") return "reference_image";
  return "auto";
}

/**
 * 把配置节点的上游连线解析成「哪种视频模式 + 每张图的角色」。
 *
 * 角色优先看连线（用户 / Agent 在检查器里设的 first-frame / last-frame），
 * 没有角色时才按模式与图片数量推断。任何模糊组合都直接报错，不悄悄丢图。
 */
export function resolveBoardVideoSelection(input: {
  doc: BoardDoc;
  config: Pick<ConfigBoardNode, "id" | "videoMode">;
  adapterType: string;
  model?: string;
  modeOverride?: BoardVideoMode;
}): { selection?: BoardVideoSelection; error?: string } {
  const links = directInputLinks(input.doc, input.config.id);
  const videoSources = links.filter((link) => link.node.type === "video");
  if (videoSources.length) {
    return { error: "无限画布视频生成暂时只接图片输入，不支持把视频节点当素材" };
  }
  const images = links.filter(
    (link): link is { edge: typeof link.edge; node: ImageBoardNode } =>
      link.node.type === "image" && Boolean(link.node.assetId),
  );
  const withRole = images.map((link) => ({
    node: link.node,
    assetId: link.node.assetId!,
    role: edgeVideoRole(link.edge.role),
  }));

  const adapter = input.adapterType as VideoAdapter;
  const capability = VIDEO_CAPABILITIES[adapter];
  if (!capability) return { error: "当前模型不是视频模型，请换一个视频渠道" };
  const supported = supportedVideoModes(input.adapterType, input.model);
  const cap = Math.min(BOARD_LIMITS.maxUpstreamImages, capability.maxReferenceImages);

  const firsts = withRole.filter((item) => item.role === "first_frame");
  const lasts = withRole.filter((item) => item.role === "last_frame");
  const explicitRefs = withRole.filter((item) => item.role === "reference_image");
  const autoRoles = withRole.filter((item) => item.role === "auto");
  const requested = input.modeOverride ?? input.config.videoMode;
  let mode: ConversationVideoMode | undefined = requested;

  if (!mode) {
    if (!withRole.length) {
      mode = "text-to-video";
    } else if (lasts.length && !firsts.length) {
      return { error: "有尾帧但没有首帧：把其中一张连线的角色改成首帧，或改用参考图模式" };
    } else if (firsts.length > 1 || lasts.length > 1) {
      return { error: "首帧和尾帧各只能有一张，请检查连线的角色" };
    } else if (firsts.length === 1 && lasts.length === 1) {
      if (withRole.length !== 2) return { error: "首尾帧模式正好需要两张图，其它连线请改成参考图或断开" };
      mode = "first-last-frame";
    } else if (firsts.length === 1) {
      if (withRole.length !== 1) return { error: "首帧模式只接受一张图；其它图片请断开，或把角色改成参考图并选择参考生视频" };
      mode = "first-frame";
    } else if (explicitRefs.length) {
      mode = "reference";
    } else if (autoRoles.length === 1) {
      // 单张图不指定方式时，按惯例当作首帧；多张交给参考生视频
      mode = "first-frame";
    } else {
      mode = "reference";
    }
  }

  if (!supported.includes(mode)) {
    return { error: `这个视频模型不支持${videoModeLabel(mode, input.adapterType)}。它支持：${supported.map((item) => videoModeLabel(item, input.adapterType)).join("、")}` };
  }

  if (mode === "text-to-video") {
    if (withRole.length) {
      return { error: "文生视频不会带图：请断开图片连线，或在检查器里换成首帧 / 首尾帧 / 参考图模式" };
    }
    return { selection: { mode, inputs: [] } };
  }
  if (mode === "first-frame") {
    if (withRole.length !== 1) return { error: `首帧生视频只接受 1 张图（现在连了 ${withRole.length} 张）` };
    return { selection: { mode, inputs: [{ ...withRole[0]!, role: "first_frame" }] } };
  }
  if (mode === "first-last-frame") {
    if (withRole.length !== 2) return { error: `首尾帧生视频必须正好 2 张图（现在连了 ${withRole.length} 张）` };
    const first = firsts[0] ?? withRole[0]!;
    const last = lasts[0] ?? withRole.find((item) => item.node.id !== first.node.id);
    if (!last || first.node.id === last.node.id) return { error: "首尾帧需要两张不同的图" };
    return {
      selection: {
        mode,
        inputs: [
          { ...first, role: "first_frame" },
          { ...last, role: "last_frame" },
        ],
      },
    };
  }

  if (!withRole.length) return { error: "参考生视频至少需要 1 张参考图" };
  if (withRole.length > cap) return { error: `这个视频模型最多用 ${cap} 张参考图（现在连了 ${withRole.length} 张）` };
  return {
    selection: {
      mode: "reference",
      inputs: withRole.map((item) => ({ ...item, role: "reference_image" })),
    },
  };
}

async function generateBoardVideo(input: {
  db: AppDatabase;
  runner: TaskRunner;
  boardId: string;
  board: BoardRecord;
  config: ConfigBoardNode;
  prompt: string;
  overrides?: {
    model?: string;
    videoMode?: BoardVideoMode;
    durationSeconds?: number;
    resolution?: string;
    audio?: boolean;
    seed?: number;
    aspectRatio?: string;
    promptExtend?: boolean;
    watermark?: boolean;
  };
}): Promise<BoardGenerateResult> {
  const { db, runner, board, config } = input;
  if (board.doc.nodes.length + 1 > BOARD_LIMITS.maxNodes) {
    throw new AppError("BOARD_NODE_LIMIT", `一块无限画布最多 ${BOARD_LIMITS.maxNodes} 个节点，请先删掉一些`, 400);
  }

  const aliases = buildCapabilityAliases(db.listChannels());
  const resolution = resolveAlias(
    aliases,
    input.overrides?.model ?? config.model,
    "video",
    db.getSetting("agentDefaultVideoAlias") ?? undefined,
  );
  if (!resolution) throw new AppError("BOARD_NO_VIDEO_CHANNEL", "还没有可用的视频渠道，请先到「模型配置」添加", 400);
  const channel = db.getChannel(resolution.channelId);
  if (!channel || !channel.enabled) {
    throw new AppError("BOARD_NO_VIDEO_CHANNEL", "解析到的视频渠道不存在或未启用", 400);
  }
  const capability = VIDEO_CAPABILITIES[channel.adapterType as VideoAdapter];
  if (!capability) {
    throw new AppError("BOARD_VIDEO_CHANNEL_MISMATCH", `渠道「${channel.name}」不是视频模型`, 400);
  }

  const resolved = resolveBoardVideoSelection({
    doc: board.doc,
    config,
    adapterType: channel.adapterType,
    model: resolution.model,
    modeOverride: input.overrides?.videoMode,
  });
  if (!resolved.selection) {
    throw new AppError("BOARD_VIDEO_INVALID", resolved.error ?? "这次视频用哪几张图没定下来", 400);
  }
  const selection = resolved.selection;

  const defaults = VIDEO_DEFAULTS[channel.adapterType] ?? { duration: 5, resolution: "720p", audio: false };
  const generation: GenerationInput = {
    channelId: channel.id,
    model: resolution.model,
    prompt: input.prompt,
    duration: input.overrides?.durationSeconds ?? config.durationSeconds ?? defaults.duration,
    resolution: input.overrides?.resolution ?? config.resolution ?? defaults.resolution,
    audio: input.overrides?.audio ?? config.audio ?? defaults.audio,
    promptExtend: input.overrides?.promptExtend ?? config.promptExtend ?? true,
    ...((input.overrides?.watermark ?? config.watermark) === undefined
      ? {}
      : { watermark: input.overrides?.watermark ?? config.watermark }),
    ...((input.overrides?.seed ?? config.seed) === undefined
      ? {}
      : { seed: input.overrides?.seed ?? config.seed }),
    ...((input.overrides?.aspectRatio ?? config.aspectRatio)
      ? { aspectRatio: input.overrides?.aspectRatio ?? config.aspectRatio }
      : {}),
    timeoutMs: 300_000,
  };
  const uploads: ReferenceImageUpload[] = [];

  if (selection.inputs.length) {
    const profile = videoInlineProfile(selection.inputs.length);
    const prepared: Array<{ bytes: Buffer; mimeType: "image/png" | "image/jpeg" | "image/webp"; fileName: string }> = [];
    for (const item of selection.inputs) {
      const asset = db.getAsset(item.assetId);
      if (!asset) {
        throw new AppError("BOARD_ASSET_INVALID", `节点「${item.node.title || item.node.ref}」的素材不存在`, 400);
      }
      const encoded = await prepareImageBytes(db, asset, profile);
      if (!encoded) {
        throw new AppError("BOARD_ASSET_INVALID", `节点「${item.node.title || item.node.ref}」的图片读取失败`, 400);
      }
      prepared.push(encoded);
    }

    if (channel.adapterType === "grok-video") {
      // Grok 只吃 reference_images，没有首帧 / 尾帧字段
      for (const item of prepared) uploads.push(item);
    } else {
      const media = prepared.map((item, index) => ({
        role: selection.inputs[index]!.role,
        url: `data:${item.mimeType};base64,${item.bytes.toString("base64")}`,
      }));
      if (channel.adapterType === "seedance-video") {
        generation.seedanceVideoMedia = media.map((item) => ({ type: "image_url", url: item.url, role: item.role }));
        generation.seedanceVideoMode = selection.mode as SeedanceVideoMode;
        if (selection.mode === "first-frame" || selection.mode === "first-last-frame") generation.ratio = "adaptive";
      } else if (channel.adapterType === "kling-video") {
        generation.klingVideoMedia = media.map((item) => ({ type: item.role as KlingMediaType, url: item.url }));
        generation.klingVideoMode = selection.mode;
        generation.aspectRatio = generation.aspectRatio ?? "16:9";
      } else {
        generation.wanVideoMedia = media.map((item) => ({ type: item.role as VideoMediaType, url: item.url }));
        generation.wanVideoMode = selection.mode as WanVideoMode;
      }
    }
  } else if (channel.adapterType === "wan-video") {
    generation.wanVideoMode = "text-to-video";
  } else if (channel.adapterType === "seedance-video") {
    generation.seedanceVideoMode = "text-to-video";
  } else if (channel.adapterType === "kling-video") {
    generation.klingVideoMode = "text-to-video";
    generation.aspectRatio = generation.aspectRatio ?? "16:9";
  }

  const task = await runner.create(generation, uploads);

  const at = now();
  const allocated = allocateNodeRef(board.doc);
  const position = placeResultNode(
    board.doc.nodes,
    { width: 320, height: 320 },
    config.x + config.width + 120,
    config.y,
  );
  const resultNode: VideoBoardNode = {
    id: `node-${crypto.randomUUID()}`,
    ref: allocated.ref,
    type: "video",
    x: position.x,
    y: position.y,
    width: 320,
    height: 320,
    title: "视频结果",
    createdAt: at,
    updatedAt: at,
    assetId: null,
    source: "generated",
    status: "loading",
    taskId: task.id,
    prompt: input.prompt,
    useUpstreamText: false,
  };

  const nodes: BoardNode[] = [
    ...board.doc.nodes.map((node) => node.id === config.id
      ? {
        ...node,
        status: "loading" as const,
        lastTaskId: task.id,
        model: resolution.alias,
        channelId: channel.id,
        updatedAt: at,
        error: undefined,
      } as BoardNode
      : node),
    resultNode,
  ];
  const edges = [
    ...board.doc.edges,
    {
      id: `edge-${crypto.randomUUID()}`,
      source: config.id,
      target: resultNode.id,
      kind: "result" as const,
    },
  ];
  const doc: BoardDoc = { ...board.doc, nextRef: allocated.nextRef, nodes, edges };

  try {
    db.saveBoardSnapshot({
      boardId: input.boardId,
      previousDoc: board.doc,
      doc,
      version: board.version + 1,
      reason: `generate:${config.ref}`,
    });
  } catch (error) {
    try { runner.cancel(task.id); } catch { /* 已经跑完 / 停不掉时保持原样 */ }
    throw error;
  }
  db.addBoardTaskRows({
    taskId: task.id,
    boardId: input.boardId,
    configNodeId: config.id,
    resultNodeIds: [resultNode.id],
    kind: "video",
  });

  return {
    board: boardView(db, requireBoard(db, input.boardId)),
    task,
    kind: "video",
    resultNodeIds: [resultNode.id],
    configNodeId: config.id,
    prompt: input.prompt,
    referenceCount: selection.inputs.length,
    modelAlias: resolution.alias,
  };
}

async function generateBoardAudio(input: {
  db: AppDatabase;
  runner: TaskRunner;
  boardId: string;
  board: BoardRecord;
  config: ConfigBoardNode;
  prompt: string;
  overrides?: {
    model?: string;
    audioKind?: BoardAudioKind;
    voice?: string;
    ttsStyle?: string;
    instrumental?: boolean;
    musicTitle?: string;
    musicTags?: string;
    musicNegativeTags?: string;
  };
}): Promise<BoardGenerateResult> {
  const { db, runner, board, config } = input;
  const links = directInputLinks(board.doc, config.id);
  if (links.some((link) => link.node.type !== "text")) {
    throw new AppError("BOARD_AUDIO_INPUT_UNSUPPORTED", "生音频只用文本上游；请断开图片 / 视频连线", 400);
  }
  const kind: BoardAudioKind = input.overrides?.audioKind ?? config.audioKind ?? "speech";
  const count = kind === "music" ? 2 : 1;
  if (board.doc.nodes.length + count > BOARD_LIMITS.maxNodes) {
    throw new AppError("BOARD_NODE_LIMIT", `一块无限画布最多 ${BOARD_LIMITS.maxNodes} 个节点，请先删掉一些`, 400);
  }

  const allAliases = buildCapabilityAliases(db.listChannels());
  const wantedAdapter = kind === "music" ? "suno-music" : "gemini-tts";
  const aliases = allAliases.filter((alias) => alias.kind === "audio" && alias.adapterType === wantedAdapter);
  if (!aliases.length) {
    throw new AppError("BOARD_NO_AUDIO_CHANNEL", kind === "music"
      ? "还没有可用的音乐渠道，请先到「模型配置」添加"
      : "还没有可用的语音渠道，请先到「模型配置」添加", 400);
  }
  const hint = input.overrides?.model ?? config.model;
  const hinted = hint ? allAliases.find((alias) => alias.alias === hint) : undefined;
  if (hinted && hinted.adapterType !== wantedAdapter) {
    throw new AppError("BOARD_AUDIO_KIND_MISMATCH", hinted.adapterType === "gemini-tts"
      ? "当前模型是配音模型，不能用来生成音乐"
      : "当前模型是音乐模型，不能用来做配音", 400);
  }
  const preferred = kind === "music"
    ? db.getSetting("agentDefaultMusicAlias") ?? db.getSetting("agentDefaultAudioAlias") ?? undefined
    : db.getSetting("agentDefaultSpeechAlias") ?? db.getSetting("agentDefaultAudioAlias") ?? undefined;
  const resolution = resolveAlias(aliases, hint, "audio", preferred);
  if (!resolution) throw new AppError("BOARD_NO_AUDIO_CHANNEL", "没有解析到可用的音频模型", 400);
  const channel = db.getChannel(resolution.channelId);
  if (!channel || !channel.enabled) {
    throw new AppError("BOARD_NO_AUDIO_CHANNEL", "解析到的音频渠道不存在或未启用", 400);
  }

  let voice = "";
  if (kind === "speech") {
    const requested = (input.overrides?.voice ?? config.voice ?? "").trim();
    if (requested) {
      const match = TTS_VOICES.find((item) => item.toLowerCase() === requested.toLowerCase());
      if (!match) throw new AppError("BOARD_TTS_VOICE_INVALID", `音色「${requested}」不存在。可用音色：${TTS_VOICES.join("、")}`, 400);
      voice = match;
    } else {
      voice = TTS_DEFAULT_VOICE;
    }
  }

  const generation: GenerationInput = kind === "music"
    ? {
      channelId: channel.id,
      model: resolution.model,
      prompt: input.prompt,
      musicMode: "inspiration",
      musicInstrumental: input.overrides?.instrumental ?? config.instrumental ?? false,
      ...((input.overrides?.musicTitle ?? config.musicTitle)
        ? { musicTitle: input.overrides?.musicTitle ?? config.musicTitle }
        : {}),
      ...((input.overrides?.musicTags ?? config.musicTags)
        ? { musicTags: input.overrides?.musicTags ?? config.musicTags }
        : {}),
      ...((input.overrides?.musicNegativeTags ?? config.musicNegativeTags)
        ? { musicNegativeTags: input.overrides?.musicNegativeTags ?? config.musicNegativeTags }
        : {}),
      timeoutMs: 900_000,
    }
    : {
      channelId: channel.id,
      model: resolution.model,
      prompt: input.prompt,
      ttsVoice: voice,
      ttsStyle: input.overrides?.ttsStyle ?? config.ttsStyle,
      timeoutMs: 300_000,
    };

  const task = await runner.create(generation);

  const at = now();
  const resultNodes: AudioBoardNode[] = [];
  let nextRef = board.doc.nextRef;
  for (let index = 0; index < count; index += 1) {
    const allocated = allocateNodeRef({ nodes: [...board.doc.nodes, ...resultNodes], nextRef });
    nextRef = allocated.nextRef;
    const position = placeResultNode(
      [...board.doc.nodes, ...resultNodes],
      { width: 320, height: 220 },
      config.x + config.width + 120,
      config.y,
    );
    resultNodes.push({
      id: `node-${crypto.randomUUID()}`,
      ref: allocated.ref,
      type: "audio",
      x: position.x,
      y: position.y,
      width: 320,
      height: 220,
      title: kind === "music" ? `音乐结果 ${index + 1}` : "配音结果",
      createdAt: at,
      updatedAt: at,
      assetId: null,
      source: "generated",
      status: "loading",
      taskId: task.id,
      prompt: input.prompt,
      audioKind: kind,
      useUpstreamText: false,
    });
  }
  const resultNodeIds = resultNodes.map((node) => node.id);
  const nodes: BoardNode[] = [
    ...board.doc.nodes.map((node) => node.id === config.id
      ? {
        ...node,
        status: "loading" as const,
        lastTaskId: task.id,
        model: resolution.alias,
        channelId: channel.id,
        audioKind: kind,
        updatedAt: at,
        error: undefined,
      } as BoardNode
      : node),
    ...resultNodes,
  ];
  const edges = [
    ...board.doc.edges,
    ...resultNodes.map((node) => ({
      id: `edge-${crypto.randomUUID()}`,
      source: config.id,
      target: node.id,
      kind: "result" as const,
    })),
  ];
  const doc: BoardDoc = { ...board.doc, nextRef, nodes, edges };

  try {
    db.saveBoardSnapshot({
      boardId: input.boardId,
      previousDoc: board.doc,
      doc,
      version: board.version + 1,
      reason: `generate:${config.ref}`,
    });
  } catch (error) {
    try { runner.cancel(task.id); } catch { /* 已经跑完 / 停不掉时保持原样 */ }
    throw error;
  }
  db.addBoardTaskRows({
    taskId: task.id,
    boardId: input.boardId,
    configNodeId: config.id,
    resultNodeIds,
    kind: "audio",
  });

  return {
    board: boardView(db, requireBoard(db, input.boardId)),
    task,
    kind: "audio",
    resultNodeIds,
    configNodeId: config.id,
    prompt: input.prompt,
    referenceCount: 0,
    modelAlias: resolution.alias,
  };
}

async function generateBoardText(input: {
  db: AppDatabase;
  keys: KeyStore;
  boardId: string;
  board: BoardRecord;
  config: ConfigBoardNode;
  prompt: string;
}): Promise<BoardGenerateResult> {
  const { db, board, config } = input;
  if (board.doc.nodes.length + 1 > BOARD_LIMITS.maxNodes) {
    throw new AppError("BOARD_NODE_LIMIT", `一块无限画布最多 ${BOARD_LIMITS.maxNodes} 个节点，请先删掉一些`, 400);
  }
  const links = directInputLinks(board.doc, config.id);
  if (links.some((link) => link.node.type === "image" || link.node.type === "video")) {
    throw new AppError("BOARD_TEXT_IMAGE_UNSUPPORTED", "生文本只使用文本上游；请断开图片 / 视频连线", 400);
  }
  const conversation = db.getConversation(board.threadId);
  if (!conversation) throw new AppError("BOARD_THREAD_MISSING", "无限画布线程不存在", 500);
  const channel = db.getChannel(conversation.brainChannelId);
  if (!channel || !channel.enabled || channel.adapterType !== "openai-chat") {
    throw new AppError("BOARD_NO_BRAIN", "还没有可用的对话模型，先到「模型配置」添加一个", 400);
  }
  const key = input.keys.get(channel.id) || (channel.secretEnv ? process.env[channel.secretEnv] ?? "" : "");
  if (!key && channel.authType !== "none") {
    throw new AppError("BOARD_BRAIN_AUTH", "无限画布助手的对话渠道没有可用密钥", 400);
  }

  let content = "";
  const messages = [
    {
      role: "system" as const,
      content: [
        "你是无限画布里的文本生成助手。根据用户给的提示词和上游文本，写出可以直接使用的内容。",
        "只输出正文，不要解释你的思路，不要包 markdown 代码块，也不要提到自己是模型。",
        "如果提示词要求格式（标题 / 列表 / 台词），严格按要求的格式输出。",
      ].join("\n"),
    },
    { role: "user" as const, content: input.prompt },
  ];
  try {
    let result = await callBrain({
      channel,
      key,
      model: conversation.brainModel,
      messages,
      timeoutMs: 240_000,
    });
    // 推理模型可能把 16K 输出额度全用在思考上；正文为空时再给一次更大额度
    if (!result.content.trim()) {
      result = await callBrain({
        channel,
        key,
        model: conversation.brainModel,
        messages,
        maxTokens: BRAIN_RETRY_MAX_TOKENS,
        timeoutMs: 300_000,
      });
    }
    content = result.content.trim();
  } catch (error) {
    const raw = error instanceof Error ? error.message : "未知错误";
    const timeout = /aborted due to timeout|TimeoutError|ETIMEDOUT|timed out/i.test(raw);
    throw new AppError(
      "BOARD_TEXT_FAILED",
      timeout ? "文本生成超时：可以缩短上游文本或换一个非推理模型" : `文本生成失败：${raw}`,
      502,
    );
  }
  if (!content) {
    throw new AppError("BOARD_TEXT_EMPTY", "模型只输出了思考过程，正文被长度上限截断；已自动加长额度重试过一次。可以再试，或换一个非推理模型", 502);
  }
  if (content.length > BOARD_LIMITS.maxTextChars) {
    throw new AppError("BOARD_TEXT_TOO_LONG", `生成结果超过 ${BOARD_LIMITS.maxTextChars} 字，请缩小提示词范围`, 400);
  }

  const at = now();
  const allocated = allocateNodeRef(board.doc);
  const position = placeResultNode(
    board.doc.nodes,
    { width: Math.max(300, config.width), height: 220 },
    config.x + config.width + 120,
    config.y,
  );
  const resultNode: BoardNode = {
    id: `node-${crypto.randomUUID()}`,
    ref: allocated.ref,
    type: "text",
    x: position.x,
    y: position.y,
    width: Math.max(300, config.width),
    height: 220,
    title: "生成文本",
    text: content,
    createdAt: at,
    updatedAt: at,
  };
  const nodes: BoardNode[] = [
    ...board.doc.nodes.map((node) => node.id === config.id
      ? {
        ...node,
        status: "succeeded" as const,
        model: conversation.brainModel,
        channelId: channel.id,
        updatedAt: at,
        error: undefined,
      } as BoardNode
      : node),
    resultNode,
  ];
  const edges = [
    ...board.doc.edges,
    {
      id: `edge-${crypto.randomUUID()}`,
      source: config.id,
      target: resultNode.id,
      kind: "result" as const,
    },
  ];
  const doc: BoardDoc = { ...board.doc, nextRef: allocated.nextRef, nodes, edges };
  db.saveBoardSnapshot({
    boardId: input.boardId,
    previousDoc: board.doc,
    doc,
    version: board.version + 1,
    reason: `generate:${config.ref}`,
  });

  return {
    board: boardView(db, requireBoard(db, input.boardId)),
    task: null,
    kind: "text",
    resultNodeIds: [resultNode.id],
    configNodeId: config.id,
    prompt: input.prompt,
    referenceCount: 0,
    modelAlias: conversation.brainModel,
  };
}

export async function generateBoardConfig(input: {
  db: AppDatabase;
  runner: TaskRunner;
  keys: KeyStore;
  boardId: string;
  nodeId: string;
  overrides?: BoardGenerateOverrides;
}): Promise<BoardGenerateResult> {
  const { db, runner } = input;
  const board = requireBoard(db, input.boardId);
  const media = board.doc.nodes.find(
    (node): node is ImageBoardNode | VideoBoardNode | AudioBoardNode =>
      node.id === input.nodeId && (node.type === "image" || node.type === "video" || node.type === "audio"),
  );
  if (media) {
    return generateBoardMediaNode({
      db,
      runner,
      boardId: input.boardId,
      board,
      node: media,
      ...(input.overrides ? { overrides: input.overrides } : {}),
    });
  }
  const config = board.doc.nodes.find(
    (node): node is ConfigBoardNode => node.id === input.nodeId && node.type === "config",
  );
  if (!config) throw new AppError("BOARD_CONFIG_NOT_FOUND", "配置节点不存在", 404);

  const prompt = composeConfigPrompt(board.doc, {
    id: config.id,
    prompt: input.overrides?.prompt ?? config.prompt,
    useUpstreamText: config.useUpstreamText,
  }).trim();
  if (!prompt) {
    throw new AppError("BOARD_PROMPT_EMPTY", "提示词是空的：在配置节点里写一句，或把文本节点连到左边", 400);
  }
  if (prompt.length > BOARD_LIMITS.maxTextChars) {
    throw new AppError("BOARD_PROMPT_TOO_LONG", `提示词超过 ${BOARD_LIMITS.maxTextChars} 字，请删减后再试`, 400);
  }

  if (config.mode === "video") {
    return generateBoardVideo({
      db, runner,
      boardId: input.boardId,
      board,
      config,
      prompt,
      ...(input.overrides ? {
        overrides: {
          ...(input.overrides.model ? { model: input.overrides.model } : {}),
          ...(input.overrides.videoMode ? { videoMode: input.overrides.videoMode } : {}),
          ...(input.overrides.durationSeconds ? { durationSeconds: input.overrides.durationSeconds } : {}),
          ...(input.overrides.resolution ? { resolution: input.overrides.resolution } : {}),
          ...(input.overrides.audio === undefined ? {} : { audio: input.overrides.audio }),
          ...(input.overrides.seed === undefined ? {} : { seed: input.overrides.seed }),
          ...(input.overrides.aspectRatio ? { aspectRatio: input.overrides.aspectRatio } : {}),
          ...(input.overrides.promptExtend === undefined ? {} : { promptExtend: input.overrides.promptExtend }),
          ...(input.overrides.watermark === undefined ? {} : { watermark: input.overrides.watermark }),
        },
      } : {}),
    });
  }

  if (config.mode === "text") {
    return generateBoardText({
      db,
      keys: input.keys,
      boardId: input.boardId,
      board,
      config,
      prompt,
    });
  }

  if (config.mode === "audio") {
    return generateBoardAudio({
      db,
      runner,
      boardId: input.boardId,
      board,
      config,
      prompt,
      ...(input.overrides ? {
        overrides: {
          ...(input.overrides.model ? { model: input.overrides.model } : {}),
          ...(input.overrides.audioKind ? { audioKind: input.overrides.audioKind } : {}),
          ...(input.overrides.voice ? { voice: input.overrides.voice } : {}),
          ...(input.overrides.ttsStyle ? { ttsStyle: input.overrides.ttsStyle } : {}),
          ...(input.overrides.instrumental === undefined ? {} : { instrumental: input.overrides.instrumental }),
          ...(input.overrides.musicTitle ? { musicTitle: input.overrides.musicTitle } : {}),
          ...(input.overrides.musicTags ? { musicTags: input.overrides.musicTags } : {}),
          ...(input.overrides.musicNegativeTags ? { musicNegativeTags: input.overrides.musicNegativeTags } : {}),
        },
      } : {}),
    });
  }

  const count = Math.min(
    BOARD_LIMITS.maxCount,
    Math.max(1, Math.floor(Number(input.overrides?.count ?? config.count) || 1)),
  );
  if (board.doc.nodes.length + count > BOARD_LIMITS.maxNodes) {
    throw new AppError("BOARD_NODE_LIMIT", `一块无限画布最多 ${BOARD_LIMITS.maxNodes} 个节点，请先删掉一些`, 400);
  }

  // 直接上游图片按画布位置排序，最多 8 张；读不到字节的跳过，不让一张坏图带走整次生成
  const references: ReferenceImageUpload[] = [];
  for (const node of directUpstreamImages(board.doc, config.id)) {
    if (!node.assetId) continue;
    const asset = db.getAsset(node.assetId);
    if (!asset) continue;
    const prepared = await prepareImageBytes(db, asset, REFERENCE_PROFILE);
    if (!prepared) continue;
    references.push({
      bytes: prepared.bytes,
      mimeType: prepared.mimeType,
      fileName: prepared.fileName,
    });
  }

  const aliases = buildCapabilityAliases(db.listChannels());
  const resolution = resolveAlias(
    aliases,
    input.overrides?.model ?? config.model,
    "image",
    db.getSetting("agentDefaultImageAlias") ?? undefined,
  );
  if (!resolution) throw new AppError("BOARD_NO_IMAGE_CHANNEL", "还没有可用的生图渠道，请先到「模型配置」添加", 400);
  const channel = db.getChannel(resolution.channelId);
  if (!channel || !channel.enabled) {
    throw new AppError("BOARD_NO_IMAGE_CHANNEL", "解析到的生图渠道不存在或未启用", 400);
  }

  const size = input.overrides?.size ?? config.size;
  const imageSize = input.overrides?.imageSize ?? config.imageSize;
  const quality = input.overrides?.quality ?? config.quality;
  const negativePrompt = input.overrides?.negativePrompt ?? config.negativePrompt;
  const aspectRatio = input.overrides?.aspectRatio ?? config.aspectRatio;
  const seed = input.overrides?.seed ?? config.seed;
  const style = input.overrides?.style ?? config.style;
  const background = input.overrides?.background ?? config.background;
  const outputFormat = input.overrides?.outputFormat ?? config.outputFormat;
  const moderation = input.overrides?.moderation ?? config.moderation;
  const generation: GenerationInput = {
    channelId: channel.id,
    model: resolution.model,
    prompt,
    count,
    ...(size ? { size } : {}),
    ...(imageSize ? { imageSize } : {}),
    ...(quality ? { quality } : {}),
    ...(negativePrompt ? { negativePrompt } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(seed === undefined ? {} : { seed }),
    ...(style ? { style } : {}),
    ...(background ? { background } : {}),
    ...(outputFormat ? { outputFormat } : {}),
    ...(moderation ? { moderation } : {}),
  };

  const task = await runner.create(generation, references);

  const at = now();
  const resultNodes: ImageBoardNode[] = [];
  let nextRef = board.doc.nextRef;
  for (let index = 0; index < count; index += 1) {
    const allocated = allocateNodeRef({ nodes: [...board.doc.nodes, ...resultNodes], nextRef });
    nextRef = allocated.nextRef;
    const position = placeResultNode(
      [...board.doc.nodes, ...resultNodes],
      { width: 300, height: 310 },
      config.x + config.width + 120,
      config.y,
    );
    resultNodes.push({
      id: `node-${crypto.randomUUID()}`,
      ref: allocated.ref,
      type: "image",
      x: position.x,
      y: position.y,
      width: 300,
      height: 310,
      title: `结果 ${index + 1}`,
      createdAt: at,
      updatedAt: at,
      assetId: null,
      source: "generated",
      status: "loading",
      taskId: task.id,
      prompt,
      useUpstreamText: false,
    });
  }

  const resultNodeIds = resultNodes.map((node) => node.id);
  const nodes: BoardNode[] = [
    ...board.doc.nodes.map((node) => node.id === config.id
      ? {
        ...node,
        status: "loading" as const,
        lastTaskId: task.id,
        model: resolution.alias,
        channelId: channel.id,
        updatedAt: at,
        error: undefined,
      } as BoardNode
      : node),
    ...resultNodes,
  ];
  const edges = [
    ...board.doc.edges,
    ...resultNodes.map((node) => ({
      id: `edge-${crypto.randomUUID()}`,
      source: config.id,
      target: node.id,
      kind: "result" as const,
    })),
  ];
  const doc: BoardDoc = { ...board.doc, nextRef, nodes, edges };

  try {
    db.saveBoardSnapshot({
      boardId: input.boardId,
      previousDoc: board.doc,
      doc,
      version: board.version + 1,
      reason: `generate:${config.ref}`,
    });
  } catch (error) {
    // 文档没落下来，占位节点不存在；把刚提交的任务停掉，别让用户为一次看不见的结果付钱
    try { runner.cancel(task.id); } catch { /* 已经跑完 / 停不掉时保持原样 */ }
    throw error;
  }
  db.addBoardTaskRows({
    taskId: task.id,
    boardId: input.boardId,
    configNodeId: config.id,
    resultNodeIds,
    kind: "image",
  });

  return {
    board: boardView(db, requireBoard(db, input.boardId)),
    task,
    kind: "image",
    resultNodeIds,
    configNodeId: config.id,
    prompt,
    referenceCount: references.length,
    modelAlias: resolution.alias,
  };
}

export interface BoardBridgeItem {
  assetId: string;
  title?: string;
  prompt?: string;
}

/** 把已有素材（分镜图等）放进无限画布：建图片节点、挂 board_assets，一次保存 */
export function addAssetsToBoard(
  db: AppDatabase,
  boardId: string,
  items: BoardBridgeItem[],
): {
  board: BoardView;
  added: Array<{ assetId: string; nodeRef: string }>;
  skipped: number;
} {
  const board = requireBoard(db, boardId);
  const existingAssetIds = new Set(
    board.doc.nodes
      .filter((node): node is ImageBoardNode => node.type === "image" && Boolean(node.assetId))
      .map((node) => node.assetId!),
  );
  const room = BOARD_LIMITS.maxNodes - board.doc.nodes.length;
  const accepted: Array<{ asset: AssetRow; title: string; prompt?: string }> = [];
  let skipped = 0;
  for (const item of items) {
    if (accepted.length >= room) { skipped += 1; continue; }
    if (existingAssetIds.has(item.assetId)) { skipped += 1; continue; }
    const asset = db.getAsset(item.assetId);
    if (!asset || !asset.mimeType.startsWith("image/")) { skipped += 1; continue; }
    existingAssetIds.add(item.assetId);
    accepted.push({
      asset,
      title: (item.title?.trim() || asset.fileName.replace(/\.[^.]+$/, "") || "图片").slice(0, 80),
      ...(item.prompt?.trim() ? { prompt: item.prompt.trim() } : {}),
    });
  }
  if (!accepted.length) {
    return { board: boardView(db, board), added: [], skipped };
  }

  const at = now();
  const existing = board.doc.nodes;
  const startX = existing.length
    ? Math.max(...existing.map((node) => node.x + node.width)) + 160
    : 160;
  const startY = existing.length
    ? Math.min(...existing.map((node) => node.y))
    : 160;
  const nodes: BoardNode[] = [];
  let nextRef = board.doc.nextRef;
  const added: Array<{ assetId: string; nodeRef: string }> = [];
  for (const [index, item] of accepted.entries()) {
    const allocated = allocateNodeRef({ nodes: [...existing, ...nodes], nextRef });
    nextRef = allocated.nextRef;
    const node: ImageBoardNode = {
      id: `node-${crypto.randomUUID()}`,
      ref: allocated.ref,
      type: "image",
      x: startX + (index % 2) * 320,
      y: startY + Math.floor(index / 2) * 240,
      width: 280,
      height: 210,
      title: item.title,
      createdAt: at,
      updatedAt: at,
      assetId: item.asset.id,
      source: "library",
      status: "succeeded",
      ...(item.prompt ? { prompt: item.prompt } : {}),
    };
    nodes.push(node);
    added.push({ assetId: item.asset.id, nodeRef: node.ref });
    db.insertBoardAssetLink(boardId, item.asset.id, node.id);
  }
  const doc: BoardDoc = {
    ...board.doc,
    nextRef,
    nodes: [...board.doc.nodes, ...nodes],
  };
  db.saveBoardSnapshot({
    boardId,
    previousDoc: board.doc,
    doc,
    version: board.version + 1,
    reason: "bridge:assets",
  });
  return { board: boardView(db, requireBoard(db, boardId)), added, skipped };
}

/** 把图片追加到某个对话的参考图组；去重，超过上限的部分跳过 */
export function appendConversationCanvasAssets(
  db: AppDatabase,
  conversationId: string,
  assetIds: string[],
): { conversationId: string; canvasAssetIds: string[]; added: string[]; skipped: number } {
  const conversation = db.getConversation(conversationId);
  if (!conversation) throw new AppError("CONVERSATION_NOT_FOUND", "会话不存在", 404);
  if (conversation.kind !== "chat") {
    throw new AppError("CONVERSATION_NOT_CHAT", "只能把图片加入普通对话的参考图组", 400);
  }
  const next = [...conversation.canvasAssetIds];
  const seen = new Set(next);
  const added: string[] = [];
  let skipped = 0;
  for (const assetId of assetIds) {
    if (seen.has(assetId)) { skipped += 1; continue; }
    if (next.length >= MAX_CANVAS_IMAGES) { skipped += 1; continue; }
    const asset = db.getAsset(assetId);
    if (!asset || !asset.mimeType.startsWith("image/")) { skipped += 1; continue; }
    seen.add(assetId);
    next.push(assetId);
    added.push(assetId);
  }
  if (added.length) db.updateConversation(conversationId, { canvasAssetIds: next });
  return { conversationId, canvasAssetIds: next, added, skipped };
}

/** 上传一张图到无限画布；不写聊天消息，返回素材给客户端插节点 */
export async function storeBoardUpload(
  db: AppDatabase,
  boardId: string,
  file: { buffer: Buffer; mimetype: string; originalname: string },
): Promise<Asset> {
  requireBoard(db, boardId);
  if (!IMAGE_MIME.includes(file.mimetype as typeof IMAGE_MIME[number])) {
    throw new AppError("BOARD_ASSET_INVALID", "无限画布只支持 PNG、JPEG、WebP 图片", 400);
  }
  if (!matchesImageSignature(file.buffer, file.mimetype as ReferenceImageUpload["mimeType"])) {
    throw new AppError("BOARD_ASSET_INVALID", "图片格式与文件内容不匹配", 400);
  }

  const assetId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const fileName = `${taskId}-1.${extensionForMime(file.mimetype)}`;
  const baseDir = db.assetsDir;
  await fs.promises.writeFile(path.join(baseDir, fileName), file.buffer);
  const sha256 = crypto.createHash("sha256").update(file.buffer).digest("hex");
  const thumbPath = await writeThumbnail(db, assetId, file.buffer);
  db.createTask({
    id: taskId, channelId: "", model: "", prompt: "无限画布上传",
    input: {}, origin: "upload", status: "succeeded",
  });
  db.insertAsset({
    id: assetId, taskId, fileName, mimeType: file.mimetype, byteSize: file.buffer.length,
    relativePath: fileName, baseDir, sha256, thumbPath,
  });
  // 文档保存前先挂一条临时链接，保存时会按节点重建
  db.insertBoardAssetLink(boardId, assetId, `pending:${assetId}`);
  return db.assetView(db.getAsset(assetId)!);
}

function clearAssetRefs(doc: BoardDoc, assetId: string): { doc: BoardDoc; changed: boolean } {
  let changed = false;
  const at = now();
  const nodes = doc.nodes.map((node): BoardNode => {
    if ((node.type !== "image" && node.type !== "video" && node.type !== "audio") || node.assetId !== assetId) return node;
    changed = true;
    return {
      ...node,
      assetId: null,
      status: "empty",
      updatedAt: at,
      error: undefined,
    } as BoardNode;
  });
  return { doc: changed ? { ...doc, nodes } : doc, changed };
}

/**
 * 从无限画布移除一张素材：节点清空并标成「素材已删除」，文件不删。
 *
 * 文件保留让撤销可以恢复引用；真正的全局删除在生成历史里做。
 */
export function removeBoardAsset(db: AppDatabase, boardId: string, assetId: string): BoardView {
  const board = requireBoard(db, boardId);
  const linked = db.findBoardAssetRefs(assetId).some((ref) => ref.boardId === boardId);
  if (!linked) throw new AppError("BOARD_ASSET_NOT_FOUND", "这张素材不在当前无限画布里", 404);
  const cleared = clearAssetRefs(board.doc, assetId);
  if (!cleared.changed) {
    // 只有临时链接、还没插节点：把文档原样存一次，重建索引即可移掉链接
    db.saveBoardSnapshot({
      boardId, previousDoc: board.doc, doc: board.doc,
      version: board.version + 1, reason: "asset:removed",
    });
  } else {
    db.saveBoardSnapshot({
      boardId, previousDoc: board.doc, doc: cleared.doc,
      version: board.version + 1, reason: "asset:removed",
    });
  }
  return boardView(db, requireBoard(db, boardId));
}

/**
 * 全局素材被删时调用：把所有无限画布里引用它的节点清空。
 *
 * P0 的无限画布素材删除走 removeBoardAsset；这个函数留给生成历史的全局删除，
 * 避免以后忘了无限画布也是素材的引用方。
 */
export function detachAssetFromBoards(db: AppDatabase, assetId: string): void {
  const refs = db.findBoardAssetRefs(assetId);
  const boardIds = [...new Set(refs.map((ref) => ref.boardId))];
  for (const boardId of boardIds) {
    try {
      removeBoardAsset(db, boardId, assetId);
    } catch {
      // 板已经被删 / 素材链接已经不在了：没有可清理的东西
    }
  }
}

export function listBoardAssets(db: AppDatabase, boardId: string): Asset[] {
  requireBoard(db, boardId);
  return db.listBoardAssets(boardId);
}

/**
 * 图片 / 视频 / 音频节点就地生成。
 *
 * 和配置节点不同：不新建结果卡片，任务完成后把素材回填到当前节点本身。
 * 这样「一张图 = 一个提示词 + 结果」，连线只保留真正有意义的上下游关系。
 */
async function generateBoardMediaNode(input: {
  db: AppDatabase;
  runner: TaskRunner;
  boardId: string;
  board: BoardRecord;
  node: ImageBoardNode | VideoBoardNode | AudioBoardNode;
  overrides?: BoardGenerateOverrides;
}): Promise<BoardGenerateResult> {
  const { db, runner, board, node } = input;
  const overrides = input.overrides ?? {};
  const prompt = composeConfigPrompt(board.doc, {
    id: node.id,
    prompt: overrides.prompt ?? node.prompt ?? "",
    useUpstreamText: node.useUpstreamText !== false,
  }).trim();
  if (!prompt) {
    throw new AppError("BOARD_PROMPT_EMPTY", "提示词是空的：在节点里写一句，或把文本节点连到左边", 400);
  }
  if (prompt.length > BOARD_LIMITS.maxTextChars) {
    throw new AppError("BOARD_PROMPT_TOO_LONG", `提示词超过 ${BOARD_LIMITS.maxTextChars} 字，请删减后再试`, 400);
  }

  let task: Task;
  let kind: "image" | "video" | "audio";
  let modelAlias: string;
  let referenceCount = 0;
  let patch: Record<string, unknown> = { prompt, source: "generated" };

  if (node.type === "image") {
    const references: ReferenceImageUpload[] = [];
    for (const upstream of directUpstreamImages(board.doc, node.id)) {
      if (!upstream.assetId) continue;
      const asset = db.getAsset(upstream.assetId);
      if (!asset) continue;
      const prepared = await prepareImageBytes(db, asset, REFERENCE_PROFILE);
      if (!prepared) continue;
      references.push({
        bytes: prepared.bytes,
        mimeType: prepared.mimeType,
        fileName: prepared.fileName,
      });
    }
    const aliases = buildCapabilityAliases(db.listChannels());
    const resolution = resolveAlias(
      aliases,
      overrides.model ?? node.model,
      "image",
      db.getSetting("agentDefaultImageAlias") ?? undefined,
    );
    if (!resolution) throw new AppError("BOARD_NO_IMAGE_CHANNEL", "还没有可用的生图渠道，请先到「模型配置」添加", 400);
    const channel = db.getChannel(resolution.channelId);
    if (!channel || !channel.enabled) throw new AppError("BOARD_NO_IMAGE_CHANNEL", "解析到的生图渠道不存在或未启用", 400);
    const size = overrides.size ?? node.size;
    const imageSize = overrides.imageSize ?? node.imageSize;
    const quality = overrides.quality ?? node.quality;
    const negativePrompt = overrides.negativePrompt ?? node.negativePrompt;
    const aspectRatio = overrides.aspectRatio ?? node.aspectRatio;
    const seed = overrides.seed ?? node.seed;
    const style = overrides.style ?? node.style;
    const background = overrides.background ?? node.background;
    const outputFormat = overrides.outputFormat ?? node.outputFormat;
    const moderation = overrides.moderation ?? node.moderation;
    task = await runner.create({
      channelId: channel.id,
      model: resolution.model,
      prompt,
      count: 1,
      ...(size ? { size } : {}),
      ...(imageSize ? { imageSize } : {}),
      ...(quality ? { quality } : {}),
      ...(negativePrompt ? { negativePrompt } : {}),
      ...(aspectRatio ? { aspectRatio } : {}),
      ...(seed === undefined ? {} : { seed }),
      ...(style ? { style } : {}),
      ...(background ? { background } : {}),
      ...(outputFormat ? { outputFormat } : {}),
      ...(moderation ? { moderation } : {}),
    }, references);
    kind = "image";
    modelAlias = resolution.alias;
    referenceCount = references.length;
    patch = {
      ...patch,
      model: resolution.alias,
      channelId: channel.id,
      ...(size ? { size } : {}),
      ...(imageSize ? { imageSize } : {}),
      ...(quality ? { quality } : {}),
      ...(negativePrompt ? { negativePrompt } : {}),
      ...(aspectRatio ? { aspectRatio } : {}),
      ...(seed === undefined ? {} : { seed }),
      ...(style ? { style } : {}),
      ...(background ? { background } : {}),
      ...(outputFormat ? { outputFormat } : {}),
      ...(moderation ? { moderation } : {}),
    };
  } else if (node.type === "video") {
    const aliases = buildCapabilityAliases(db.listChannels());
    const resolution = resolveAlias(
      aliases,
      overrides.model ?? node.model,
      "video",
      db.getSetting("agentDefaultVideoAlias") ?? undefined,
    );
    if (!resolution) throw new AppError("BOARD_NO_VIDEO_CHANNEL", "还没有可用的视频渠道，请先到「模型配置」添加", 400);
    const channel = db.getChannel(resolution.channelId);
    if (!channel || !channel.enabled) throw new AppError("BOARD_NO_VIDEO_CHANNEL", "解析到的视频渠道不存在或未启用", 400);
    const capability = VIDEO_CAPABILITIES[channel.adapterType as VideoAdapter];
    if (!capability) throw new AppError("BOARD_VIDEO_CHANNEL_MISMATCH", `渠道「${channel.name}」不是视频模型`, 400);
    const resolved = resolveBoardVideoSelection({
      doc: board.doc,
      config: node,
      adapterType: channel.adapterType,
      model: resolution.model,
      modeOverride: overrides.videoMode,
    });
    if (!resolved.selection) {
      throw new AppError("BOARD_VIDEO_INVALID", resolved.error ?? "这次视频用哪几张图没定下来", 400);
    }
    const selection = resolved.selection;
    const defaults = VIDEO_DEFAULTS[channel.adapterType] ?? { duration: 5, resolution: "720p", audio: false };
    const duration = overrides.durationSeconds ?? node.durationSeconds ?? defaults.duration;
    const resolutionValue = overrides.resolution ?? node.resolution ?? defaults.resolution;
    const audio = overrides.audio ?? node.audio ?? defaults.audio;
    const promptExtend = overrides.promptExtend ?? node.promptExtend ?? true;
    const watermark = overrides.watermark ?? node.watermark;
    const seed = overrides.seed ?? node.seed;
    const aspectRatio = overrides.aspectRatio ?? node.aspectRatio;
    const generation: GenerationInput = {
      channelId: channel.id,
      model: resolution.model,
      prompt,
      duration,
      resolution: resolutionValue,
      audio,
      promptExtend,
      ...(watermark === undefined ? {} : { watermark }),
      ...(seed === undefined ? {} : { seed }),
      ...(aspectRatio ? { aspectRatio } : {}),
      timeoutMs: 300_000,
    };
    const uploads: ReferenceImageUpload[] = [];
    if (selection.inputs.length) {
      const profile = videoInlineProfile(selection.inputs.length);
      const prepared: Array<{ bytes: Buffer; mimeType: "image/png" | "image/jpeg" | "image/webp"; fileName: string }> = [];
      for (const item of selection.inputs) {
        const asset = db.getAsset(item.assetId);
        if (!asset) throw new AppError("BOARD_ASSET_INVALID", `节点「${item.node.title || item.node.ref}」的素材不存在`, 400);
        const encoded = await prepareImageBytes(db, asset, profile);
        if (!encoded) throw new AppError("BOARD_ASSET_INVALID", `节点「${item.node.title || item.node.ref}」的图片读取失败`, 400);
        prepared.push(encoded);
      }
      if (channel.adapterType === "grok-video") {
        for (const item of prepared) uploads.push(item);
      } else {
        const media = prepared.map((item, index) => ({
          role: selection.inputs[index]!.role,
          url: `data:${item.mimeType};base64,${item.bytes.toString("base64")}`,
        }));
        if (channel.adapterType === "seedance-video") {
          generation.seedanceVideoMedia = media.map((item) => ({ type: "image_url", url: item.url, role: item.role }));
          generation.seedanceVideoMode = selection.mode as SeedanceVideoMode;
          if (selection.mode === "first-frame" || selection.mode === "first-last-frame") generation.ratio = "adaptive";
        } else if (channel.adapterType === "kling-video") {
          generation.klingVideoMedia = media.map((item) => ({ type: item.role as KlingMediaType, url: item.url }));
          generation.klingVideoMode = selection.mode;
          generation.aspectRatio = generation.aspectRatio ?? "16:9";
        } else {
          generation.wanVideoMedia = media.map((item) => ({ type: item.role as VideoMediaType, url: item.url }));
          generation.wanVideoMode = selection.mode as WanVideoMode;
        }
      }
    } else if (channel.adapterType === "wan-video") {
      generation.wanVideoMode = "text-to-video";
    } else if (channel.adapterType === "seedance-video") {
      generation.seedanceVideoMode = "text-to-video";
    } else if (channel.adapterType === "kling-video") {
      generation.klingVideoMode = "text-to-video";
      generation.aspectRatio = generation.aspectRatio ?? "16:9";
    }
    task = await runner.create(generation, uploads);
    kind = "video";
    modelAlias = resolution.alias;
    referenceCount = selection.inputs.length;
    patch = {
      ...patch,
      model: resolution.alias,
      channelId: channel.id,
      videoMode: selection.mode,
      durationSeconds: duration,
      resolution: resolutionValue,
      audio,
      promptExtend,
      ...(watermark === undefined ? {} : { watermark }),
      ...(seed === undefined ? {} : { seed }),
      ...(aspectRatio ? { aspectRatio } : {}),
    };
  } else {
    const links = directInputLinks(board.doc, node.id);
    if (links.some((link) => link.node.type !== "text")) {
      throw new AppError("BOARD_AUDIO_INPUT_UNSUPPORTED", "生音频只用文本上游；请断开图片 / 视频连线", 400);
    }
    const audioKind: BoardAudioKind = overrides.audioKind ?? node.audioKind ?? "speech";
    const allAliases = buildCapabilityAliases(db.listChannels());
    const wantedAdapter = audioKind === "music" ? "suno-music" : "gemini-tts";
    const aliases = allAliases.filter((alias) => alias.kind === "audio" && alias.adapterType === wantedAdapter);
    if (!aliases.length) {
      throw new AppError("BOARD_NO_AUDIO_CHANNEL", audioKind === "music"
        ? "还没有可用的音乐渠道，请先到「模型配置」添加"
        : "还没有可用的语音渠道，请先到「模型配置」添加", 400);
    }
    const hint = overrides.model ?? node.model;
    const hinted = hint ? allAliases.find((alias) => alias.alias === hint) : undefined;
    if (hinted && hinted.adapterType !== wantedAdapter) {
      throw new AppError("BOARD_AUDIO_KIND_MISMATCH", hinted.adapterType === "gemini-tts"
        ? "当前模型是配音模型，不能用来生成音乐"
        : "当前模型是音乐模型，不能用来做配音", 400);
    }
    const preferred = audioKind === "music"
      ? db.getSetting("agentDefaultMusicAlias") ?? db.getSetting("agentDefaultAudioAlias") ?? undefined
      : db.getSetting("agentDefaultSpeechAlias") ?? db.getSetting("agentDefaultAudioAlias") ?? undefined;
    const resolution = resolveAlias(aliases, hint, "audio", preferred);
    if (!resolution) throw new AppError("BOARD_NO_AUDIO_CHANNEL", "没有解析到可用的音频模型", 400);
    const channel = db.getChannel(resolution.channelId);
    if (!channel || !channel.enabled) throw new AppError("BOARD_NO_AUDIO_CHANNEL", "解析到的音频渠道不存在或未启用", 400);
    let voice = "";
    if (audioKind === "speech") {
      const requested = (overrides.voice ?? node.voice ?? "").trim();
      if (requested) {
        const match = TTS_VOICES.find((item) => item.toLowerCase() === requested.toLowerCase());
        if (!match) throw new AppError("BOARD_TTS_VOICE_INVALID", `音色「${requested}」不存在。可用音色：${TTS_VOICES.join("、")}`, 400);
        voice = match;
      } else {
        voice = TTS_DEFAULT_VOICE;
      }
    }
    const instrumental = overrides.instrumental ?? node.instrumental ?? false;
    const musicTitle = overrides.musicTitle ?? node.musicTitle;
    const musicTags = overrides.musicTags ?? node.musicTags;
    const musicNegativeTags = overrides.musicNegativeTags ?? node.musicNegativeTags;
    task = await runner.create(audioKind === "music"
      ? {
        channelId: channel.id,
        model: resolution.model,
        prompt,
        musicMode: "inspiration",
        musicInstrumental: instrumental,
        ...(musicTitle ? { musicTitle } : {}),
        ...(musicTags ? { musicTags } : {}),
        ...(musicNegativeTags ? { musicNegativeTags } : {}),
        timeoutMs: 900_000,
      }
      : {
        channelId: channel.id,
        model: resolution.model,
        prompt,
        ttsVoice: voice,
        ttsStyle: overrides.ttsStyle ?? node.ttsStyle,
        timeoutMs: 300_000,
      });
    kind = "audio";
    modelAlias = resolution.alias;
    patch = {
      ...patch,
      model: resolution.alias,
      channelId: channel.id,
      audioKind,
      ...(audioKind === "speech" ? { voice } : {}),
      ...(audioKind === "speech" && (overrides.ttsStyle ?? node.ttsStyle)
        ? { ttsStyle: overrides.ttsStyle ?? node.ttsStyle }
        : {}),
      ...(audioKind === "music" ? { instrumental } : {}),
      ...(audioKind === "music" && musicTitle ? { musicTitle } : {}),
      ...(audioKind === "music" && musicTags ? { musicTags } : {}),
      ...(audioKind === "music" && musicNegativeTags ? { musicNegativeTags } : {}),
    };
  }

  const at = now();
  const doc: BoardDoc = {
    ...board.doc,
    nodes: board.doc.nodes.map((item) => item.id === node.id
      ? {
        ...item,
        ...patch,
        status: "loading" as const,
        taskId: task.id,
        updatedAt: at,
        error: undefined,
      } as BoardNode
      : item),
  };
  try {
    db.saveBoardSnapshot({
      boardId: input.boardId,
      previousDoc: board.doc,
      doc,
      version: board.version + 1,
      reason: `generate:${node.ref}`,
    });
  } catch (error) {
    try { runner.cancel(task.id); } catch { /* 已经跑完 / 停不掉时保持原样 */ }
    throw error;
  }
  db.addBoardTaskRows({
    taskId: task.id,
    boardId: input.boardId,
    configNodeId: node.id,
    resultNodeIds: [node.id],
    kind,
  });

  return {
    board: boardView(db, requireBoard(db, input.boardId)),
    task,
    kind,
    resultNodeIds: [node.id],
    configNodeId: node.id,
    prompt,
    referenceCount,
    modelAlias,
  };
}

export type { BoardViewport, BoardUiState };
