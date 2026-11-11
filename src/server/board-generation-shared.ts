import fs from "node:fs/promises";
import path from "node:path";
import type { AppDatabase, BoardRecord, DbChannel } from "./db.js";
import { directInputLinks, type BoardDoc, type BoardNode, type BoardView, type BoardVideoMode, type BoardAudioKind } from "../shared/board.js";
import { AppError } from "./app-error.js";
import type { TaskRunner } from "./tasks.js";
import type { GenerationInput, Task } from "../shared/types.js";
import type { ReferenceVideoUpload } from "./reference-video.js";

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
}

export function now() {
  return new Date().toISOString();
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
export function placeResultNode(
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

/** 视频节点经渠道图床上传，音频节点作为内联素材；生成确认中会提示公网上传。 */
export async function appendBoardMediaInputs(db: AppDatabase, channel: DbChannel, doc: BoardDoc, nodeId: string, generation: GenerationInput): Promise<ReferenceVideoUpload | undefined> {
  const links = directInputLinks(doc, nodeId);
  const audioNode = links.find((link) => link.node.type === "audio")?.node;
  const videoNode = links.find((link) => link.node.type === "video")?.node;
  const readAsset = async (assetId: string, kind: "audio" | "video") => {
    const asset = db.getAsset(assetId);
    if (!asset || !asset.mimeType.startsWith(`${kind}/`)) throw new AppError("BOARD_ASSET_INVALID", `${kind === "audio" ? "音频" : "视频"}素材不存在或类型不匹配`, 400);
    const base = path.resolve(asset.baseDir);
    const file = path.resolve(base, asset.relativePath);
    if (!file.startsWith(base + path.sep)) throw new AppError("BOARD_ASSET_INVALID", "素材路径无效", 400);
    const limit = (kind === "audio" ? 15 : 100) * 1024 * 1024;
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || !stat.isFile()) throw new AppError("BOARD_ASSET_INVALID", "素材文件不存在", 400);
    if (stat.size > limit) throw new AppError("BOARD_ASSET_INVALID", `${kind === "audio" ? "音频不能超过 15 MB" : "视频不能超过 100 MB"}`, 400);
    if (asset.duration && (kind === "audio" ? asset.duration > 15 : asset.duration < (channel.adapterType === "kling-video" ? 3 : 1) || asset.duration > (channel.adapterType === "kling-video" ? 30 : 15))) throw new AppError("BOARD_ASSET_INVALID", `${kind === "audio" ? "音频时长不能超过 15 秒" : "视频时长不符合当前模型要求"}`, 400);
    return { asset, bytes: await fs.readFile(file) };
  };
  if (audioNode?.type === "audio" && audioNode.assetId) {
    const { asset, bytes } = await readAsset(audioNode.assetId, "audio");
    if (!["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/wav", "audio/x-wav"].includes(asset.mimeType)) throw new AppError("BOARD_ASSET_INVALID", "参考音频仅支持 MP3、M4A、AAC 或 WAV", 400);
    const media = { type: "reference_audio" as const, url: `data:${asset.mimeType};base64,${bytes.toString("base64")}` };
    if (media.url.length + (generation.wanVideoMedia ?? []).reduce((sum, item) => sum + (item.url.startsWith("data:") ? item.url.length : 0), 0) > 15 * 1024 * 1024) throw new AppError("BOARD_ASSET_INVALID", "音频和图片合计超过 15 MB 内联预算，请使用较小的素材", 400);
    generation.wanVideoMedia = [...(generation.wanVideoMedia ?? []), media];
    generation.wanVideoMode = "reference";
  }
  if (videoNode?.type === "video" && videoNode.assetId) {
    const { asset, bytes } = await readAsset(videoNode.assetId, "video");
    if (channel.adapterType === "kling-video") {
      generation.klingVideoMode = "motion-control";
      generation.klingCharacterOrientation = "video";
    } else {
      generation.wanVideoMode = "reference";
    }
    return { buffer: bytes, mimetype: asset.mimeType, originalname: asset.fileName };
  }
}

/** 提交任务后保存占位文档，并登记任务与节点的关联。 */
export function saveGeneratedBoard(
  db: Pick<AppDatabase, "saveBoardSnapshot" | "addBoardTaskRows">,
  runner: Pick<TaskRunner, "cancel">,
  input: {
    board: BoardRecord;
    doc: BoardDoc;
    source: Pick<BoardNode, "id" | "ref">;
    taskId: string;
    resultNodeIds: string[];
    kind: "image" | "video" | "audio";
  },
) {
  const { board, doc, source, taskId, resultNodeIds, kind } = input;
  try {
    db.saveBoardSnapshot({
      boardId: board.id,
      previousDoc: board.doc,
      doc,
      version: board.version + 1,
      reason: `generate:${source.ref}`,
    });
  } catch (error) {
    // 占位文档保存失败时，尽力取消刚创建的任务。
    try { runner.cancel(taskId); } catch { /* 任务可能已经结束 */ }
    throw error;
  }
  db.addBoardTaskRows({ taskId, boardId: board.id, configNodeId: source.id, resultNodeIds, kind });
}
