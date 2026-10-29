import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AppDatabase, AssetRow } from "./db.js";
import { allocateNodeRef, BOARD_LIMITS, type BoardDoc, type BoardNode, type BoardView, type ImageBoardNode, type VideoBoardNode, type AudioBoardNode } from "../shared/board.js";
import { MAX_CANVAS_IMAGES, MAX_REFERENCE_IMAGE_BYTES, type Asset } from "../shared/types.js";
import { AppError, extensionForMime, matchesImageSignature, type ReferenceImageUpload } from "./tasks.js";
import { writeThumbnail } from "./vision.js";
import { boardView, requireBoard } from "./board-core.js";

const IMAGE_MIME = ["image/png", "image/jpeg", "image/webp"] as const;
const MAX_IMAGE_BYTES = MAX_REFERENCE_IMAGE_BYTES;
const now = () => new Date().toISOString();

function boardUploadExtension(bytes: Buffer, mime: string): string | null {
  if (IMAGE_MIME.includes(mime as typeof IMAGE_MIME[number])) {
    return bytes.length <= MAX_IMAGE_BYTES && matchesImageSignature(bytes, mime as ReferenceImageUpload["mimeType"]) ? extensionForMime(mime) : null;
  }
  if ((mime === "video/mp4" || mime === "audio/mp4" || mime === "audio/x-m4a") && bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp") return mime === "video/mp4" ? "mp4" : "m4a";
  if ((mime === "video/webm" || mime === "audio/webm") && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return "webm";
  if ((mime === "audio/wav" || mime === "audio/x-wav") && bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") return "wav";
  if (mime === "audio/mpeg" && (bytes.toString("ascii", 0, 3) === "ID3" || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0))) return "mp3";
  return null;
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
      .filter((node): node is ImageBoardNode | VideoBoardNode | AudioBoardNode => (node.type === "image" || node.type === "video" || node.type === "audio") && Boolean(node.assetId))
      .map((node) => node.assetId!),
  );
  const room = BOARD_LIMITS.maxNodes - board.doc.nodes.length;
  const accepted: Array<{ asset: AssetRow; title: string; prompt?: string }> = [];
  let skipped = 0;
  for (const item of items) {
    if (accepted.length >= room) { skipped += 1; continue; }
    if (existingAssetIds.has(item.assetId)) { skipped += 1; continue; }
    const asset = db.getAsset(item.assetId);
    if (!asset || !/^(image|video|audio)\//.test(asset.mimeType)) { skipped += 1; continue; }
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
    const kind = item.asset.mimeType.startsWith("video/") ? "video" : item.asset.mimeType.startsWith("audio/") ? "audio" : "image";
    const node: ImageBoardNode | VideoBoardNode | AudioBoardNode = {
      id: `node-${crypto.randomUUID()}`,
      ref: allocated.ref,
      type: kind,
      x: startX + (index % 2) * 320,
      y: startY + Math.floor(index / 2) * 240,
      width: 280,
      height: 210,
      title: item.title,
      createdAt: at,
      updatedAt: at,
      assetId: item.asset.id,
      source: kind === "image" ? "library" : "upload",
      status: "succeeded",
      ...(item.prompt ? { prompt: item.prompt } : {}),
    } as ImageBoardNode | VideoBoardNode | AudioBoardNode;
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

/** 上传媒体到无限画布素材库；不写聊天消息。 */
export async function storeBoardUpload(
  db: AppDatabase,
  boardId: string,
  file: { buffer: Buffer; mimetype: string; originalname: string },
): Promise<Asset> {
  requireBoard(db, boardId);
  const extension = boardUploadExtension(file.buffer, file.mimetype);
  if (!extension) throw new AppError("BOARD_ASSET_INVALID", "文件格式不匹配或不受支持：图片支持 PNG / JPEG / WebP（20 MB 内），视频支持 MP4 / WebM，音频支持 MP3 / WAV / M4A / WebM（100 MB 内）", 400);

  const assetId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const fileName = `${taskId}-1.${extension}`;
  const baseDir = db.assetsDir;
  await fs.promises.writeFile(path.join(baseDir, fileName), file.buffer);
  const sha256 = crypto.createHash("sha256").update(file.buffer).digest("hex");
  const thumbPath = file.mimetype.startsWith("image/") ? await writeThumbnail(db, assetId, file.buffer) : "";
  db.createTask({
    id: taskId, channelId: "", model: "", prompt: "无限画布上传",
    input: {}, origin: "upload", libraryScope: "public", status: "succeeded",
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

/** 允许把公共素材绑定到已有节点；临时链接在文档保存后由节点索引替换。 */
export function linkBoardAsset(db: AppDatabase, boardId: string, assetId: string): Asset {
  requireBoard(db, boardId);
  const asset = db.getAsset(assetId);
  if (!asset) throw new AppError("BOARD_ASSET_NOT_FOUND", "素材不存在", 404);
  const linked = db.findBoardAssetRefs(assetId).some((ref) => ref.boardId === boardId);
  const task = db.getTaskRow(asset.taskId);
  const publicAsset = task?.libraryScope === "public" || (task?.libraryScope === "legacy" && db.listLibraryTaskViews().some((item) => item.id === asset.taskId));
  if (!linked && !publicAsset) throw new AppError("BOARD_ASSET_INVALID", "只能选择公共素材或当前画布素材", 403);
  db.insertBoardAssetLink(boardId, assetId, `pending:${assetId}`);
  return db.assetView(asset);
}
