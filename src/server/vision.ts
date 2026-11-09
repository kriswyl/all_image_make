/**
 * 缩略图与参考图预处理（AGENT_PLAN.md §11）。
 *
 * 三件事，共同点是都要在服务端解码图片：
 *
 * 1. **大脑看图**：当前画布缩到 512px JPEG，塞进 `image_url` content part（§11.2）
 * 2. **当参考图**：把画布产物喂给生图渠道做图生图，必要时重新编码避开体积上限
 * 3. **当首帧**：视频生成的内联素材总预算为 15 MiB 字符（`tasks.ts`），
 *    原图直接 base64 多半会撞线，必须先压
 *
 * 用 jimp 而不是客户端 canvas 回传：agent 的续跑是服务端驱动的，
 * 服务端要图时前端未必已经上传完，回传要额外一套请求 + 等待 + 超时协调（§11.3）。
 * jimp 是纯 JS，没有原生二进制，不影响 Tauri 的打包流程。
 *
 * 所有函数**不抛异常**：缩略图是锦上添花，失败就该静默跳过让这一轮走盲改（§15）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Jimp, JimpMime } from "jimp";
import { MAX_REFERENCE_IMAGE_BYTES } from "../shared/types.js";
import type { BrainContentPart } from "./brain.js";
import type { AppDatabase, AssetRow } from "./db.js";
import { GIF_VISION_MAX_FRAMES, readGifAnimation } from "./media-frames.js";

/** 长边像素。512 实测 2000x1200 的 PNG 压到 36KB，base64 后约 48KB（§11.6） */
export const THUMB_MAX_EDGE = 512;
export const THUMB_QUALITY = 80;

/** 参考图入参上限，和 `tasks.ts` 的 MAX_REFERENCE_IMAGE_BYTES / app.ts 的 multer 限制对齐 */
export const MAX_REFERENCE_BYTES = MAX_REFERENCE_IMAGE_BYTES;

/**
 * 视频首帧保留原有压缩配置，为音频和其他素材留出空间。
 */
export const MAX_INLINE_FRAME_BYTES = 900 * 1024;

export interface EncodedImage {
  bytes: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  fileName: string;
}

/** 某种用途的体积/画幅约束 */
export interface EncodeProfile {
  maxEdge: number;
  maxBytes: number;
  quality: number;
}

/** 图生图的参考图：画质优先，只在超过 20MB 时才动它 */
export const REFERENCE_PROFILE: EncodeProfile = { maxEdge: 2048, maxBytes: MAX_REFERENCE_BYTES, quality: 92 };

/**
 * 按字节头判断真实图片类型。
 *
 * Gemini 的 inlineData 经常把 JPEG 标成 `image/png`（实测 base64 以 `/9j/` 开头），
 * 直接用声明的 mimeType 去发给上游，会在「参考图格式与文件内容不匹配」那道校验上炸掉。
 * 所以落盘和当参考图之前都以字节为准。
 */
export type DetectedImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/svg+xml";

/** SVG 是文本，没有二进制签名；只看开头几百字节，别把任意 XML 都当图片。 */
export function isSvgBytes(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 512).toString("utf8");
  return /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)?(?:<svg[\s>]|<!DOCTYPE\s+svg[\s>])/i.test(head);
}

export function detectImageMime(bytes: Buffer): DetectedImageMime | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (bytes.length >= 6 && (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
  if (isSvgBytes(bytes)) return "image/svg+xml";
  return null;
}
/** 视频首帧：必须挤进内容长度限制，1280 对绝大多数视频模型已经够用 */
export const VIDEO_FRAME_PROFILE: EncodeProfile = { maxEdge: 1280, maxBytes: MAX_INLINE_FRAME_BYTES, quality: 90 };

/**
 * 多张图一起进视频请求体时的预算。
 *
 * `MAX_INLINE_MEDIA_CHARS` 是**所有** data URI 合计的上限（tasks.ts，15 MiB 字符），
 * 而每张图 base64 后还会膨胀约 4/3。首尾帧 / 参考生视频一次要发 2~8 张，
 * 这里继续使用保守的图片预算，避免改变图片预处理质量与行为。
 *
 * 这里按张数把总预算均分，并在图多时主动缩画幅；宁可每张糊一点，
 * 也不能让整个任务在提交前就失败。
 */
export function videoInlineProfile(count: number): EncodeProfile {
  const n = Math.max(1, count);
  if (n === 1) return VIDEO_FRAME_PROFILE;
  // 留 20% 余量给 JSON 结构、prompt 和其它字段；1.34 是 base64 的膨胀系数
  const perImage = Math.floor((1_400_000 * 0.8) / n / 1.34);
  return {
    maxEdge: n >= 5 ? 768 : n >= 3 ? 960 : 1100,
    maxBytes: Math.max(48 * 1024, perImage),
    quality: 88,
  };
}

function extensionFor(mimeType: string) {
  if (mimeType.includes("jpeg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  return "png";
}

/** 与 `app.ts` 的 `/api/assets/:id/file` 同一套目录校验，别让相对路径跳出 base_dir */
export function assetAbsolutePath(db: AppDatabase, asset: Pick<AssetRow, "baseDir" | "relativePath">) {
  const baseDir = path.resolve(asset.baseDir);
  const absolutePath = path.resolve(baseDir, asset.relativePath);
  if (!absolutePath.startsWith(baseDir + path.sep)) return null;
  return absolutePath;
}

export function thumbAbsolutePath(db: AppDatabase, fileName: string) {
  const baseDir = path.resolve(db.thumbsDir);
  const absolutePath = path.resolve(baseDir, fileName);
  if (!absolutePath.startsWith(baseDir + path.sep)) return null;
  return absolutePath;
}

async function readFileOrNull(filePath: string | null): Promise<Buffer | null> {
  if (!filePath) return null;
  try {
    const bytes = await fs.readFile(filePath);
    return bytes.length ? bytes : null;
  } catch {
    return null;
  }
}

async function decode(bytes: Buffer) {
  try {
    return await Jimp.read(bytes);
  } catch {
    // 可能是视频、损坏的图，或 jimp 不认识的格式
    return null;
  }
}

/**
 * 缩略图落盘。
 *
 * 写进 `assets.thumb_path`（相对 thumbs/ 的文件名）而不是绝对路径：
 * 数据目录被整个搬走时缩略图要跟着走。
 */
export async function writeThumbnail(db: AppDatabase, assetId: string, source: Buffer): Promise<string | null> {
  // Jimp 不认 SVG；没有缩略图时前端直接显示原文件（<img> 能渲染 SVG），不做假占位图。
  if (isSvgBytes(source)) return null;
  const image = await decode(source);
  if (!image) return null;
  try {
    image.scaleToFit({ w: THUMB_MAX_EDGE, h: THUMB_MAX_EDGE });
    const jpeg = await image.getBuffer(JimpMime.jpeg, { quality: THUMB_QUALITY });
    const fileName = `${assetId}.jpg`;
    await fs.writeFile(path.join(db.thumbsDir, fileName), jpeg);
    return fileName;
  } catch {
    return null;
  }
}

/** 读缩略图，没有就现缩现存（§11.4 的「使用时懒生成」，老产物走这条） */
export async function ensureThumbnail(db: AppDatabase, asset: AssetRow): Promise<string | null> {
  if (asset.thumbPath) {
    const existing = await readFileOrNull(thumbAbsolutePath(db, asset.thumbPath));
    if (existing) return asset.thumbPath;
  }
  const original = await readFileOrNull(assetAbsolutePath(db, asset));
  if (!original) return null;
  const fileName = await writeThumbnail(db, asset.id, original);
  if (fileName) db.setAssetThumbPath(asset.id, fileName);
  return fileName;
}

/**
 * 当前画布的缩略图 data URI，喂给大脑（§11.2）。
 *
 * 用缩略图而不是原图：一张 4K 原图 base64 后有几 MB，既贵又慢，
 * 而「把背景换成雨夜」这个判断 512px 完全够用。
 */
export async function assetThumbDataUri(db: AppDatabase, asset: AssetRow): Promise<string | null> {
  const fileName = await ensureThumbnail(db, asset);
  if (!fileName) return null;
  const bytes = await readFileOrNull(thumbAbsolutePath(db, fileName));
  if (!bytes) return null;
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

/** 缩略图文件的字节流，`/api/assets/:id/thumb` 用它 */
export async function readThumbBytes(db: AppDatabase, asset: AssetRow): Promise<Buffer | null> {
  const fileName = await ensureThumbnail(db, asset);
  if (!fileName) return null;
  return readFileOrNull(thumbAbsolutePath(db, fileName));
}

export interface AssetVisionView {
  parts: BrainContentPart[];
  /** 至少附了一张实际画面 */
  loaded: boolean;
  /** 是多帧 GIF，已附抽样帧 */
  animated: boolean;
  frameCount?: number;
}

function formatSeconds(ms: number) {
  const seconds = ms / 1000;
  return Number.isInteger(seconds) ? `${seconds} 秒` : `${seconds.toFixed(1)} 秒`;
}

/**
 * 一张资产交给大脑“看”的内容块。
 *
 * 普通图片就是一张缩略图；多帧 GIF 会按时间抽几帧并明确写出总帧数和时长，
 * 这样大脑能判断“动作到底发没发生”，而不是把第一帧当成整段动画。
 * 单帧 GIF 会说明它是静态图，避免模型声称看到了动画。
 */
export async function assetVisionParts(
  db: AppDatabase,
  asset: AssetRow,
  label: string,
  maxFrames = GIF_VISION_MAX_FRAMES,
): Promise<AssetVisionView> {
  // 普通图片直接走缩略图，不为了探测格式去读整张原图
  const gifCandidate = asset.mimeType === "image/gif" || /\.gif$/i.test(asset.fileName);
  const original = gifCandidate ? await readFileOrNull(assetAbsolutePath(db, asset)) : null;
  if (original && detectImageMime(original) === "image/gif") {
    const gif = await readGifAnimation(original, maxFrames);
    if (gif) {
      if (gif.frameCount > 1) {
        const duration = gif.durationMs > 0 ? `，总时长约 ${formatSeconds(gif.durationMs)}` : "，帧延迟为 0，无法判断播放时长";
        const parts: BrainContentPart[] = [{
          type: "text",
          text: `${label}：动图 GIF，共 ${gif.frameCount} 帧${duration}。下面按时间顺序附 ${gif.frames.length} 个抽样帧；请以这些帧判断动作是否真的发生、画面是否在动，不要假设没附上的帧。`,
        }];
        for (const [position, frame] of gif.frames.entries()) {
          parts.push({
            type: "text",
            text: `第 ${position + 1}/${gif.frames.length} 个抽样帧（原第 ${frame.index + 1} 帧，约 ${(frame.timeMs / 1000).toFixed(1)} 秒）`,
          });
          parts.push({
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${frame.jpeg.toString("base64")}` },
          });
        }
        return { parts, loaded: true, animated: true, frameCount: gif.frameCount };
      }
      const uri = await assetThumbDataUri(db, asset);
      if (uri) {
        return {
          parts: [
            { type: "text", text: `${label}：GIF 文件，但只有 1 帧，是静态图，不会动。` },
            { type: "image_url", image_url: { url: uri } },
          ],
          loaded: true,
          animated: false,
          frameCount: 1,
        };
      }
    }
  }

  const uri = await assetThumbDataUri(db, asset);
  if (!uri) return { parts: [{ type: "text", text: `${label}：读取失败，没有看到画面。` }], loaded: false, animated: false };
  return {
    parts: [
      { type: "text", text: label },
      { type: "image_url", image_url: { url: uri } },
    ],
    loaded: true,
    animated: false,
  };
}

/**
 * 把产物转成可以当参考图 / 视频首帧用的字节流。
 *
 * 体积够小就原样返回——重编码会掉画质，能不动就不动。
 * 超了就按 profile 重新编码，逐级降质量直到塞得进去。
 */
export async function prepareImageBytes(db: AppDatabase, asset: AssetRow, profile: EncodeProfile): Promise<EncodedImage | null> {
  const original = await readFileOrNull(assetAbsolutePath(db, asset));
  if (!original) return null;
  // 以字节为准：老资产可能声明 image/png、实际是 JPEG
  const actualMime = detectImageMime(original);
  // SVG 不是位图，不能当参考图 / 视觉输入；让下面的 Jimp 解码明确失败返回 null。
  if (actualMime && actualMime !== "image/gif" && actualMime !== "image/svg+xml" && original.length <= profile.maxBytes) {
    return { bytes: original, mimeType: actualMime, fileName: asset.fileName };
  }

  const image = await decode(original);
  if (!image) return null;
  const stem = asset.fileName.replace(/\.[^.]+$/, "").slice(0, 80) || "reference";
  // 先按 profile 定下画幅，再逐步降质量；一轮不行就缩画幅，最多试四次
  for (const [edge, quality] of [
    [profile.maxEdge, profile.quality],
    [profile.maxEdge, Math.round(profile.quality * 0.8)],
    [Math.round(profile.maxEdge * 0.7), Math.round(profile.quality * 0.85)],
    [Math.round(profile.maxEdge * 0.5), profile.quality],
  ] as Array<[number, number]>) {
    try {
      const attempt = await Jimp.read(original);
      attempt.scaleToFit({ w: edge, h: edge });
      const bytes = await attempt.getBuffer(JimpMime.jpeg, { quality });
      if (bytes.length <= profile.maxBytes) {
        return { bytes, mimeType: "image/jpeg", fileName: `${stem}.${extensionFor("image/jpeg")}` };
      }
    } catch {
      // 换下一档参数再试
    }
  }
  // 全部档位都塞不下，返回最后一档——让 TaskRunner 的体积校验给出明确的错误，
  // 总比在这里返回 null、大脑看不出发生了什么要好
  try {
    const last = await Jimp.read(original);
    last.scaleToFit({ w: Math.round(profile.maxEdge * 0.5), h: Math.round(profile.maxEdge * 0.5) });
    const bytes = await last.getBuffer(JimpMime.jpeg, { quality: 60 });
    return { bytes, mimeType: "image/jpeg", fileName: `${stem}.jpg` };
  } catch {
    return null;
  }
}

/** 首帧内联素材：data URI 形式，万相和 Seedance 的请求体都吃这个 */
export async function assetFrameDataUri(db: AppDatabase, asset: AssetRow): Promise<string | null> {
  const prepared = await prepareImageBytes(db, asset, VIDEO_FRAME_PROFILE);
  if (!prepared) return null;
  return `data:${prepared.mimeType};base64,${prepared.bytes.toString("base64")}`;
}
