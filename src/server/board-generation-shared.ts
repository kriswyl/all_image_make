import { MINIMAX_REFERENCE_LIMITS } from "../shared/video-capabilities.js";
import { minimaxAudioDataUrl } from "./minimax-reference-audio.js";
import fs from "node:fs/promises";
import path from "node:path";
import type { AppDatabase, BoardRecord, DbChannel } from "./db.js";
import { directInputLinks, directUpstreamImages, type BoardDoc, type BoardNode, type BoardView, type BoardVideoMode, type BoardAudioKind } from "../shared/board.js";
import { imageReferenceCountError } from "../shared/image-reference-limits.js";
import { AppError } from "./app-error.js";
import type { ReferenceImageUpload, TaskRunner } from "./tasks.js";
import type { GenerationInput, Task } from "../shared/types.js";
import { MAX_INLINE_MEDIA_CHARS } from "../shared/types.js";
import { readReferenceVideoAsset, type ReferenceVideoUpload } from "./reference-video.js";
import { prepareImageBytes, REFERENCE_PROFILE } from "./vision.js";

export async function loadBoardImageReferences(db: AppDatabase, doc: BoardDoc, nodeId: string, adapter: string, model: string) {
  const referenceNodes = directUpstreamImages(doc, nodeId);
  const error = imageReferenceCountError(adapter, model, referenceNodes.length);
  if (error) throw new AppError("REFERENCE_IMAGE_LIMIT", error, 400);
  const references: ReferenceImageUpload[] = [];
  for (const node of referenceNodes) {
    const asset = node.assetId ? db.getAsset(node.assetId) : undefined;
    const prepared = asset && await prepareImageBytes(db, asset, REFERENCE_PROFILE);
    if (!prepared) throw new AppError("REFERENCE_IMAGE_MISSING", `无法读取参考图「${node.title || node.ref}」，请重新选择素材`, 400);
    references.push(prepared);
  }
  return { references, referenceNodes };
}

export interface BoardGenerateResult {
  board: BoardView;
  /** 文本生成是同步的，没有任务；图片 / 视频才有 */
  task: Task | null;
  taskIds?: string[];
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
  outputFormat?: import("../shared/image-formats.js").ImageOutputFormat;
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
  /** 单次上游请求的等待上限（秒）；不填按节点类型的默认值 */
  timeoutSeconds?: number;
}

export function now() {
  return new Date().toISOString();
}

export { placeImageResultGrid, placeResultNode } from "../shared/board-image-results.js";

export async function submitBoardImages(
  runner: Pick<TaskRunner, "create">,
  generation: GenerationInput,
  references: ReferenceImageUpload[],
  count: number,
) {
  // 渠道可能忽略 n 或 candidateCount。每个槽位提交一次，单次只请求一张。
  const requests = await Promise.allSettled(Array.from({ length: count }, () =>
    runner.create({ ...generation, count: 1 }, references)));
  const first = requests.find((request) => request.status === "fulfilled");
  if (!first) {
    const failure = requests[0];
    throw failure?.status === "rejected" ? failure.reason : new Error("没有提交图片生成任务");
  }
  return {
    firstTask: first.value,
    slots: requests.map((request) => request.status === "fulfilled"
      ? { taskId: request.value.id, status: "loading" as const, resultIndex: 0 }
      : { taskId: null, status: "failed" as const, resultIndex: 0, error: (request.reason instanceof Error ? request.reason.message : "请求提交失败").slice(0, 2000) }),
  };
}

/** 视频节点经渠道图床上传，音频节点作为内联素材；生成确认中会提示公网上传。 */
export async function appendBoardMediaInputs(db: AppDatabase, channel: DbChannel, doc: BoardDoc, nodeId: string, generation: GenerationInput): Promise<ReferenceVideoUpload[]> {
  const links = directInputLinks(doc, nodeId);
  const audioNode = links.find((link) => link.node.type === "audio")?.node;
  const readAudioAsset = async (assetId: string) => {
    const asset = db.getAsset(assetId);
    if (!asset?.mimeType.startsWith("audio/")) throw new AppError("BOARD_ASSET_INVALID", "音频素材不存在或类型不匹配", 400);
    const base = path.resolve(asset.baseDir);
    const file = path.resolve(base, asset.relativePath);
    if (!file.startsWith(base + path.sep)) throw new AppError("BOARD_ASSET_INVALID", "素材路径无效", 400);
    const limit = 15 * 1024 * 1024;
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || !stat.isFile()) throw new AppError("BOARD_ASSET_INVALID", "素材文件不存在", 400);
    if (stat.size > limit) throw new AppError("BOARD_ASSET_INVALID", "音频不能超过 15 MB", 400);
    if (asset.duration && asset.duration > 15) throw new AppError("BOARD_ASSET_INVALID", "音频时长不能超过 15 秒", 400);
    return { asset, bytes: await fs.readFile(file) };
  };
  if (channel.adapterType === "minimax-video") {
    const media = generation.minimaxVideoMedia ?? [];
    let audioDuration = 0;
    for (const { node } of links) {
      if (node.type !== "audio" || !node.assetId) continue;
      const asset = db.getAsset(node.assetId);
      if (!asset) throw new AppError("BOARD_ASSET_INVALID", "参考音频素材不存在", 400);
      audioDuration += asset.duration ?? 0;
      if (audioDuration > MINIMAX_REFERENCE_LIMITS.maxSecondsPerKind) throw new AppError("BOARD_ASSET_INVALID", "参考音频总时长不能超过 15 秒", 400);
      media.push({ type: "audio", url: await minimaxAudioDataUrl(asset) });
    }
    generation.minimaxVideoMedia = media;
  } else if (audioNode?.type === "audio" && audioNode.assetId) {
    const { asset, bytes } = await readAudioAsset(audioNode.assetId);
    if (!["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav", "audio/x-wav"].includes(asset.mimeType)) throw new AppError("BOARD_ASSET_INVALID", "参考音频仅支持 MP3、M4A、AAC 或 WAV", 400);
    const media = { type: "reference_audio" as const, url: `data:${asset.mimeType};base64,${bytes.toString("base64")}` };
    if (media.url.length + (generation.wanVideoMedia ?? []).reduce((sum, item) => sum + (item.url.startsWith("data:") ? item.url.length : 0), 0) > MAX_INLINE_MEDIA_CHARS) throw new AppError("BOARD_ASSET_INVALID", `音频和图片合计超过 ${MAX_INLINE_MEDIA_CHARS / 1024 / 1024} MB 内联预算，请使用较小的素材`, 400);
    generation.wanVideoMedia = [...(generation.wanVideoMedia ?? []), media];
    generation.wanVideoMode = "reference";
  }
  const uploads: ReferenceVideoUpload[] = [];
  for (const { node } of links) {
    if (node.type !== "video" || !node.assetId) continue;
    const asset = db.getAsset(node.assetId);
    if (!asset) throw new AppError("BOARD_ASSET_INVALID", "参考视频素材不存在", 400);
    if (channel.adapterType === "kling-video") {
      generation.klingVideoMode = "motion-control";
      generation.klingCharacterOrientation = "video";
    } else if (channel.adapterType === "minimax-video") {
      generation.minimaxVideoMode = "reference";
    } else if (channel.adapterType === "seedance-video") {
      generation.seedanceVideoMode = "reference";
    } else {
      generation.wanVideoMode = "reference";
    }
    uploads.push(await readReferenceVideoAsset(asset, generation.klingVideoMode ?? "reference", channel.adapterType));
  }
  return uploads;
}

/** 提交任务后保存占位文档，并登记任务与节点的关联。 */
export function saveGeneratedBoard(
  db: Pick<AppDatabase, "getBoardRecord" | "saveBoardSnapshot" | "addBoardTaskRows">,
  runner: Pick<TaskRunner, "cancel">,
  input: {
    board: BoardRecord;
    doc: BoardDoc;
    source: Pick<BoardNode, "id" | "ref">;
    taskId: string;
    resultNodeIds: string[];
    /** 多次独立请求时，每张结果卡只登记到自己的任务。 */
    assignments?: { taskId: string; resultNodeIds: string[] }[];
    kind: "image" | "video" | "audio";
  },
) {
  const { board, doc, source, taskId, resultNodeIds, kind } = input;
  const assignments = input.assignments ?? [{ taskId, resultNodeIds }];
  try {
    if (db.getBoardRecord(board.id)?.version !== board.version) {
      throw new AppError("BOARD_VERSION_CONFLICT", "提交期间画布内容已变化，请重新加载后再生成", 409);
    }
    db.saveBoardSnapshot({
      boardId: board.id,
      previousDoc: board.doc,
      doc,
      version: board.version + 1,
      reason: `generate:${source.ref}`,
    });
  } catch (error) {
    // 占位文档保存失败时，尽力取消刚创建的任务。
    for (const assignment of assignments) {
      try { runner.cancel(assignment.taskId); } catch { /* 任务可能已经结束 */ }
    }
    throw error;
  }
  for (const assignment of assignments) {
    db.addBoardTaskRows({ ...assignment, boardId: board.id, configNodeId: source.id, kind });
  }
}
