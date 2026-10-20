/**
 * 缩略图与参考图预处理（AGENT_PLAN.md §11）。
 *
 * 三件事，共同点是都要在服务端解码图片：
 *
 * 1. **大脑看图**：当前画布缩到 512px JPEG，塞进 `image_url` content part（§11.2）
 * 2. **当参考图**：把画布产物喂给生图渠道做图生图，必要时重新编码避开体积上限
 * 3. **当首帧**：视频生成的内联素材上限只有约 1.4MB 字符（`tasks.ts:40`），
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
import type { AppDatabase, AssetRow } from "./db.js";

/** 长边像素。512 实测 2000x1200 的 PNG 压到 36KB，base64 后约 48KB（§11.6） */
export const THUMB_MAX_EDGE = 512;
export const THUMB_QUALITY = 80;

/** 参考图入参上限，和 `tasks.ts` 的 MAX_REFERENCE_IMAGE_BYTES / app.ts 的 multer 限制对齐 */
export const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;

/**
 * 视频内联素材上限，取 `tasks.ts` 的 MAX_INLINE_MEDIA_CHARS 的约 2/3。
 * base64 后体积约是二进制的 1.34 倍，留出余量后仍在 1.4M 字符以内。
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

/** 图生图的参考图：画质优先，只在超过 10MB 时才动它 */
export const REFERENCE_PROFILE: EncodeProfile = { maxEdge: 2048, maxBytes: MAX_REFERENCE_BYTES, quality: 92 };
/** 视频首帧：必须挤进内容长度限制，1280 对绝大多数视频模型已经够用 */
export const VIDEO_FRAME_PROFILE: EncodeProfile = { maxEdge: 1280, maxBytes: MAX_INLINE_FRAME_BYTES, quality: 90 };

/**
 * 多张图一起进视频请求体时的预算。
 *
 * `MAX_INLINE_MEDIA_CHARS` 是**所有** data URI 合计的上限（tasks.ts，约 1.4M 字符），
 * 而每张图 base64 后还会膨胀约 4/3。首尾帧 / 参考生视频一次要发 2~8 张，
 * 沿用单帧的 900KB 预算会在第二张就撞线，上游只回一个含糊的 502。
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

/**
 * 把产物转成可以当参考图 / 视频首帧用的字节流。
 *
 * 体积够小就原样返回——重编码会掉画质，能不动就不动。
 * 超了就按 profile 重新编码，逐级降质量直到塞得进去。
 */
export async function prepareImageBytes(db: AppDatabase, asset: AssetRow, profile: EncodeProfile): Promise<EncodedImage | null> {
  const original = await readFileOrNull(assetAbsolutePath(db, asset));
  if (!original) return null;
  const passThrough = asset.mimeType === "image/png" || asset.mimeType === "image/jpeg" || asset.mimeType === "image/webp";
  if (passThrough && original.length <= profile.maxBytes) {
    return { bytes: original, mimeType: asset.mimeType as EncodedImage["mimeType"], fileName: asset.fileName };
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
