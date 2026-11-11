/** 画布文档、历史版本与素材操作。 */
import crypto from "node:crypto";
import type { AppDatabase } from "./db.js";
import { boardGroups, BoardValidationError, BOARD_LIMITS, parseBoardDoc, parseBoardExport, parseBoardSelection, parseBoardUiState, parseBoardViewport, type BoardDelta, type BoardDoc, type BoardNode, type BoardSummary, type BoardUiState, type BoardView, type BoardViewport } from "../shared/board.js";
import { AppError } from "./tasks.js";
import { pickBrainChannel, readAgentDefaults } from "./agent-settings.js";
import { boardView, requireBoard } from "./board-core.js";

export { resolveBoardVideoSelection } from "./board-video-selection.js";
export { addAssetsToBoard, appendConversationCanvasAssets, storeBoardUpload, removeBoardAsset, detachAssetFromBoards, listBoardAssets, linkBoardAsset } from "./board-assets.js";
export type { BoardBridgeItem } from "./board-assets.js";

const DEFAULT_BOARD_TITLE = "未命名无限画布";

function normalizeTitle(value: unknown): string {
  const title = typeof value === "string" ? value.trim() : "";
  return (title || DEFAULT_BOARD_TITLE).slice(0, BOARD_LIMITS.maxTitleChars);
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
export function assertDocAssets(db: AppDatabase, boardId: string, doc: BoardDoc, additionalAssetIds: string[] = []): void {
  const linkedAssetIds = new Set([...db.listBoardAssets(boardId).map((asset) => asset.id), ...additionalAssetIds]);
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

export type { BoardViewport, BoardUiState };

export { cancelBoardTask, generateBoardConfig, retryBoardTask } from "./board-generation.js";
export type { BoardGenerateOverrides, BoardGenerateResult } from "./board-generation-shared.js";
