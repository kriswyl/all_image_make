import type { ReferenceImageInput } from "../shared/types.js";
import { detectImageMime } from "./vision.js";

export function extensionForMime(mimeType: string) {
  if (mimeType.includes("jpeg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  if (mimeType.includes("svg")) return "svg";
  return "png";
}

export function videoExtensionForMime(mimeType: string) {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("quicktime")) return "mov";
  if (mimeType.includes("x-matroska")) return "mkv";
  return "mp4";
}

/** 参考音频落盘用的扩展名；只覆盖校验放行的四种容器。 */
export function audioExtension(mimeType: string) {
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("aac")) return "aac";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "m4a";
  return "mp3";
}

/**
 * 从 PCM WAV 头里算时长。
 * Gemini TTS 固定 24kHz / 16bit / mono，但它不返回值；历史列表需要时长。
 */
export function wavDurationSeconds(bytes: Buffer): number | undefined {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return undefined;
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (id === "fmt " && size >= 16 && dataStart + 16 <= bytes.length) {
      byteRate = bytes.readUInt32LE(dataStart + 8);
    }
    if (id === "data" && byteRate > 0) {
      const available = Math.min(size, bytes.length - dataStart);
      return Math.round((available / byteRate) * 100) / 100;
    }
    offset = dataStart + size + (size % 2);
  }
  return undefined;
}

export function audioExtensionForMime(mimeType: string) {
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("flac")) return "flac";
  if (mimeType.includes("aac")) return "aac";
  // audio/mp4、audio/x-m4a、audio/m4a 都落到这里
  return "m4a";
}

export function matchesImageSignature(bytes: Buffer, mimeType: ReferenceImageInput["mimeType"]) {
  return detectImageMime(bytes) === mimeType;
}
