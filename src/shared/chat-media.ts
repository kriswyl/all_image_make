import { fileExtension } from "./reference-media.js";

const MIME_BY_EXTENSION: Record<string, string> = {
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};

export const CHAT_MEDIA_ACCEPT = ".mp3,.wav,.m4a,.mp4,.mov,.webm,audio/mpeg,audio/wav,audio/mp4,audio/webm,video/mp4,video/quicktime,video/webm";
export const MAX_CHAT_MEDIA_FILES = 3;
export const MAX_CHAT_MEDIA_MB = 50;
export const MAX_CHAT_MEDIA_BYTES = MAX_CHAT_MEDIA_MB * 1024 * 1024;

export function chatMediaMime(file: { name: string; type: string }): string | undefined {
  const type = file.type.toLowerCase();
  const extension = fileExtension(file.name);
  if (type === "audio/webm") return type;
  if (type === "audio/mp4" && extension === "mp4") return type;
  if (Object.hasOwn(MIME_BY_EXTENSION, extension)) return MIME_BY_EXTENSION[extension];
  if (type === "audio/x-m4a") return "audio/mp4";
  if (type === "audio/x-wav") return "audio/wav";
  return Object.values(MIME_BY_EXTENSION).includes(type) ? type : undefined;
}
