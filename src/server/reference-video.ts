import fs from "node:fs/promises";
import path from "node:path";
import { assertSafeUrl, safeFileName } from "./security.js";
import { AppError } from "./app-error.js";
import { referenceMediaType } from "../shared/reference-media.js";
import { referenceVideoDurationRange } from "../shared/video-modes.js";
import type { AssetRow, DbChannel } from "./db.js";
import type { KeyStore } from "./key-store.js";

/** 参考素材：本地选中的视频或音频，上传后换成公网 URL 再进请求体。 */
export type ReferenceMediaKind = "video" | "audio";

export interface ReferenceMediaUpload {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}

/** 兼容旧名字：可灵/万相/Seedance 的视频上传走的还是同一份实现。 */
export type ReferenceVideoUpload = ReferenceMediaUpload;

/** 音频按「15 秒以内」定上限：和视频页的音轨限制保持一致。 */
export const MAX_REFERENCE_AUDIO_BYTES = 15 * 1024 * 1024;
export const MAX_REFERENCE_VIDEO_BYTES = 100 * 1024 * 1024;

/**
 * 上传的是哪类素材。
 *
 * 不能只看 `mimetype`：`.m4a` 在 Windows 上常常拿不到类型，前端补不上时
 * multer 收到的是 `application/octet-stream`，按 MIME 白名单会把它当成非法
 * 文件。判定规则和前端同一份（扩展名优先），两边不会各说一套。
 */
export function referenceMediaKindOf(file: { originalname: string; mimetype: string }): ReferenceMediaKind | null {
  return referenceMediaType({ name: file.originalname, type: file.mimetype })?.kind ?? null;
}

function looksLikeAudio(buffer: Buffer) {
  if (buffer.length < 12) return false;
  const ascii = (start: number, end: number) => buffer.subarray(start, end).toString("ascii");
  // MP3：ID3 标签或 MPEG 帧同步
  if (ascii(0, 3) === "ID3") return true;
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return true;
  // WAV：RIFF....WAVE
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return true;
  // M4A / MP4 音轨：ftyp box
  if (ascii(4, 8) === "ftyp") return true;
  return false;
}

export function validateReferenceMedia(file: ReferenceMediaUpload, kind: ReferenceMediaKind = "video") {
  const detected = referenceMediaKindOf(file);
  if (kind === "audio") {
    if (detected !== "audio" || !looksLikeAudio(file.buffer)) {
      throw new AppError("REFERENCE_AUDIO_INVALID", "仅支持有效的 MP3 / M4A / AAC / WAV 音频", 400);
    }
    if (file.buffer.length > MAX_REFERENCE_AUDIO_BYTES) {
      throw new AppError("REFERENCE_AUDIO_INVALID", "音频不能超过 15 MB", 400);
    }
    return;
  }
  if (detected !== "video" || file.buffer.length < 12 || file.buffer.subarray(4, 8).toString("ascii") !== "ftyp") {
    throw new AppError("REFERENCE_VIDEO_INVALID", "仅支持有效的 MP4 / MOV 视频", 400);
  }
  if (file.buffer.length > MAX_REFERENCE_VIDEO_BYTES) {
    throw new AppError("REFERENCE_VIDEO_INVALID", "视频不能超过 100 MB", 400);
  }
}

export function validateReferenceVideo(file: ReferenceMediaUpload) {
  validateReferenceMedia(file, "video");
}

/** MP4 / MOV 的 mvhd 记录整段时长；跳过 mdat 等大块数据。 */
export function referenceVideoDuration(buffer: Buffer): number | null {
  function box(type: string, start: number, end: number): { start: number; end: number } | undefined {
    let offset = start;
    while (offset + 8 <= end) {
      const size32 = buffer.readUInt32BE(offset);
      const header = size32 === 1 ? 16 : 8;
      if (offset + header > end) return;
      const size = size32 === 1 ? Number(buffer.readBigUInt64BE(offset + 8)) : size32 || end - offset;
      if (!Number.isSafeInteger(size) || size < header || size > end - offset) return;
      if (buffer.toString("ascii", offset + 4, offset + 8) === type) return { start: offset + header, end: offset + size };
      offset += size;
    }
  }
  const movie = box("moov", 0, buffer.length);
  if (!movie) return null;
  const header = box("mvhd", movie.start, movie.end);
  if (!header || header.start >= header.end) return null;
  const version = buffer[header.start];
  if (version !== 0 && version !== 1) return null;
  const scaleOffset = header.start + (version === 1 ? 20 : 12);
  if (scaleOffset + (version === 1 ? 12 : 8) > header.end) return null;
  const scale = buffer.readUInt32BE(scaleOffset);
  const duration = version === 1 ? Number(buffer.readBigUInt64BE(scaleOffset + 4)) : buffer.readUInt32BE(scaleOffset + 4);
  if (!scale || !duration || duration === 0xffffffff || !Number.isSafeInteger(duration)) return null;
  return duration / scale;
}

export function referenceVideoAssetError(asset: AssetRow, mode: string): string | undefined {
  if (!asset.mimeType.startsWith("video/") || referenceMediaKindOf({ originalname: asset.fileName, mimetype: asset.mimeType }) !== "video") {
    return "请选择 MP4 或 MOV 视频";
  }
  if (asset.byteSize > MAX_REFERENCE_VIDEO_BYTES) return "视频不能超过 100 MB";
  const { min, max } = referenceVideoDurationRange(mode);
  if (asset.duration != null && (asset.duration < min || asset.duration > max)) return `视频时长需为 ${min}–${max} 秒`;
}

export async function readReferenceVideoAsset(asset: AssetRow, mode: string): Promise<ReferenceVideoUpload> {
  const issue = referenceVideoAssetError(asset, mode);
  if (issue) throw new AppError("REFERENCE_VIDEO_INVALID", issue, 400);
  const base = path.resolve(asset.baseDir);
  const file = path.resolve(base, asset.relativePath);
  const relative = path.relative(base, file);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new AppError("REFERENCE_VIDEO_INVALID", "素材路径无效", 400);
  }
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile()) throw new AppError("REFERENCE_VIDEO_INVALID", "参考视频文件不存在", 400);
  if (stat.size > MAX_REFERENCE_VIDEO_BYTES) throw new AppError("REFERENCE_VIDEO_INVALID", "视频不能超过 100 MB", 400);
  const mimetype = referenceMediaType({ name: asset.fileName, type: asset.mimeType })!.mime;
  const originalname = asset.title && referenceMediaType({ name: asset.title, type: "" })?.mime === mimetype ? asset.title : asset.fileName;
  const upload = { buffer: await fs.readFile(file), mimetype, originalname };
  validateReferenceVideo(upload);
  const duration = asset.duration ?? referenceVideoDuration(upload.buffer);
  const { min, max } = referenceVideoDurationRange(mode);
  if (duration != null && (duration < min || duration > max)) {
    throw new AppError("REFERENCE_VIDEO_INVALID", `视频时长需为 ${min}–${max} 秒`, 400);
  }
  return upload;
}

/**
 * 把本地素材传到渠道配置的上传服务，换回公网地址。
 *
 * 这里是「图床上传」的唯一实现：万相、可灵、Seedance 都走它，
 * 所以错误信息按素材类型区分，不要写成某一家的说法。
 */
export async function uploadReferenceMedia(
  channel: DbChannel,
  keys: KeyStore,
  file: ReferenceMediaUpload,
  kind: ReferenceMediaKind = "video",
): Promise<string> {
  const label = kind === "audio" ? "音频" : "视频";
  if (!channel.uploadEndpoint) throw new AppError("UPLOAD_UNSUPPORTED", "该渠道未配置视频上传服务", 400);
  validateReferenceMedia(file, kind);
  await assertSafeUrl(channel.uploadEndpoint, channel.allowPrivateNetwork);
  const headers = new Headers();
  for (const [name, value] of Object.entries(channel.uploadHeaders ?? {})) {
    if (/^(authorization|cookie|host|content-length|content-type)$/i.test(name)) throw new AppError("UPLOAD_INVALID_HEADERS", "上传附加请求头不能覆盖鉴权或文件类型", 400);
    headers.set(name, value);
  }
  const key = channel.authType === "none" ? "" : keys.get(channel.id) || (channel.secretEnv ? process.env[channel.secretEnv] : "");
  if (channel.authType !== "none" && !key) throw new AppError("CHANNEL_AUTH_FAILED", "该渠道没有可用的 API Key", 400);
  if (key) headers.set("Authorization", `Bearer ${key}`);
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from(file.buffer)], { type: file.mimetype }), safeFileName(file.originalname));
  let response: Response;
  try { response = await fetch(channel.uploadEndpoint, { method: "POST", headers, body: form, redirect: "manual", signal: AbortSignal.timeout(180_000) }); }
  catch { throw new AppError("UPLOAD_FAILED", `上传${label}失败，请检查上传服务和网络`, 502); }
  if (!response.ok) throw new AppError("UPLOAD_FAILED", `上传${label}失败：HTTP ${response.status}`, 502);
  const payload: unknown = await response.json().catch(() => null);
  const url = payload && typeof payload === "object" && "url" in payload ? (payload as { url: unknown }).url : "";
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new AppError("UPLOAD_FAILED", "上传服务没有返回有效的公网地址", 502);
  return url;
}

export async function uploadReferenceVideo(channel: DbChannel, keys: KeyStore, file: ReferenceMediaUpload): Promise<string> {
  return uploadReferenceMedia(channel, keys, file, "video");
}
