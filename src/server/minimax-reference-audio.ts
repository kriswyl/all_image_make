import fs from "node:fs/promises";
import path from "node:path";
import { MINIMAX_REFERENCE_LIMITS } from "../shared/video-capabilities.js";
import { AppError } from "./app-error.js";
import type { AssetRow } from "./db.js";
import { validateReferenceMedia } from "./reference-video.js";

export function minimaxAudioAssetError(asset: AssetRow): string | undefined {
  if (!/^(audio\/(mpeg|mp3|wav|x-wav|wave))$/i.test(asset.mimeType)) return "MiniMax H3 参考音频仅支持 MP3 或 WAV";
  if (asset.byteSize > MINIMAX_REFERENCE_LIMITS.audioBytes) return "参考音频不能超过 15 MB";
  if (asset.duration != null && (asset.duration < MINIMAX_REFERENCE_LIMITS.minClipSeconds || asset.duration > MINIMAX_REFERENCE_LIMITS.maxClipSeconds)) {
    return "参考音频时长需为 2–15 秒";
  }
}

export async function minimaxAudioDataUrl(asset: AssetRow): Promise<string> {
  const issue = minimaxAudioAssetError(asset);
  if (issue) throw new AppError("REFERENCE_AUDIO_INVALID", issue, 400);
  const base = path.resolve(asset.baseDir);
  const file = path.resolve(base, asset.relativePath);
  if (!file.startsWith(base + path.sep)) throw new AppError("REFERENCE_AUDIO_INVALID", "音频素材路径无效", 400);
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile()) throw new AppError("REFERENCE_AUDIO_INVALID", "找不到参考音频文件，请重新选择素材", 400);
  if (stat.size > MINIMAX_REFERENCE_LIMITS.audioBytes) throw new AppError("REFERENCE_AUDIO_INVALID", "参考音频不能超过 15 MB", 400);
  const mimetype = /wav/i.test(asset.mimeType) ? "audio/wav" : "audio/mpeg";
  const buffer = await fs.readFile(file);
  validateReferenceMedia({ buffer, mimetype, originalname: mimetype === "audio/wav" ? "audio.wav" : "audio.mp3" }, "audio");
  return `data:${mimetype};base64,${buffer.toString("base64")}`;
}
