import fs from "node:fs/promises";
import path from "node:path";
import { VIDEO_MEDIA_FIELDS, type GenerationInput } from "../shared/types.js";
import { AppError } from "./app-error.js";

interface StoredInlineMedia {
  relativePath: string;
  mimeType: string;
  byteSize: number;
  /** 有此前缀时文件保存的是图片二进制，否则保存原 Data URL。 */
  prefix?: string;
  scheme?: string;
}

type VideoMediaField = typeof VIDEO_MEDIA_FIELDS[number];
type VideoMediaFields = Pick<GenerationInput, VideoMediaField>;
type MediaEntry = { url: string };
type StoredEntry<T extends MediaEntry> = T & { inlineImage?: StoredInlineMedia; inlineAudio?: StoredInlineMedia };
export type StoredVideoMediaFields = {
  [K in VideoMediaField]?: Array<StoredEntry<NonNullable<VideoMediaFields[K]>[number]>>;
};

const imageMime = /^data:(image\/[a-z0-9.+-]+)[;,]/i;
const audioMime = /^data:(audio\/[a-z0-9.+-]+)[;,]/i;
const storedFileName = /^[a-f0-9-]{36}-video-(image|audio)-\d+\.bin$/i;

export async function storeInlineVideoImages(input: VideoMediaFields, write: (name: string, bytes: Buffer) => Promise<void>, taskId: string) {
  let slot = 0;
  async function store<T extends MediaEntry>(items?: T[], includeAudio = false): Promise<Array<StoredEntry<T>> | undefined> {
    if (!items) return undefined;
    const stored: Array<StoredEntry<T>> = [];
    for (const item of items) {
      const audio = includeAudio ? audioMime.exec(item.url) : null;
      const match = audio ?? imageMime.exec(item.url);
      if (!match) { stored.push(item); continue; }
      const comma = item.url.indexOf(",");
      const prefix = comma < 0 ? "" : item.url.slice(0, comma + 1);
      const body = item.url.slice(comma + 1);
      const decoded = /;base64,$/i.test(prefix) ? Buffer.from(body, "base64") : undefined;
      const binary = decoded?.toString("base64") === body ? decoded : undefined;
      // 常规图片用二进制节省空间，兼容参数化、未补齐或使用转义的 Data URL 原样往返。
      const bytes = binary ?? Buffer.from(item.url, "utf8");
      const relativePath = `${taskId}-video-${audio ? "audio" : "image"}-${++slot}.bin`;
      await write(relativePath, bytes);
      const inline: StoredInlineMedia = { relativePath, mimeType: match[1]!, byteSize: bytes.length };
      if (binary) {
        inline.prefix = prefix.slice(5);
        if (!prefix.startsWith("data:")) inline.scheme = prefix.slice(0, 5);
      }
      stored.push({ ...item, url: "", ...(audio ? { inlineAudio: inline } : { inlineImage: inline }) });
    }
    return stored;
  }
  return {
    wanVideoMedia: await store(input.wanVideoMedia),
    seedanceVideoMedia: await store(input.seedanceVideoMedia),
    klingVideoMedia: await store(input.klingVideoMedia),
    minimaxVideoMedia: await store(input.minimaxVideoMedia, true),
  };
}

export async function restoreInlineVideoEntry<T extends MediaEntry>({ inlineImage, inlineAudio, ...item }: StoredEntry<T>, inputsDir: string): Promise<T> {
  const inline = inlineAudio ?? inlineImage;
  if (!inline) return item as T;
  const { relativePath, byteSize, prefix, scheme } = inline;
  const label = inlineAudio ? "参考音频" : "视频参考图";
  const code = inlineAudio ? "REFERENCE_AUDIO" : "REFERENCE_IMAGE";
  if (!storedFileName.test(relativePath)) throw new AppError(`${code}_INVALID`, `${label}路径无效`, 400);
  const target = path.join(inputsDir, relativePath);
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat?.isFile()) throw new AppError(`${code}_MISSING`, `找不到${label}，请重新选择素材`, 400);
  if (stat.size !== byteSize) throw new AppError(`${code}_INVALID`, `${label}文件不完整，请重新选择素材`, 400);
  const bytes = await fs.readFile(target).catch(() => null);
  if (!bytes) throw new AppError(`${code}_MISSING`, `无法读取${label}，请重新选择素材`, 400);
  return { ...item, url: prefix ? (scheme ?? "data:") + prefix + bytes.toString("base64") : bytes.toString("utf8") } as T;
}

export async function restoreInlineVideoImages(input: StoredVideoMediaFields, inputsDir: string): Promise<VideoMediaFields> {
  async function restore<T extends MediaEntry>(items?: Array<StoredEntry<T>>) {
    if (!items) return undefined;
    const restored: T[] = [];
    for (const item of items) restored.push(await restoreInlineVideoEntry(item, inputsDir));
    return restored;
  }
  return {
    wanVideoMedia: await restore(input.wanVideoMedia),
    seedanceVideoMedia: await restore(input.seedanceVideoMedia),
    klingVideoMedia: await restore(input.klingVideoMedia),
    minimaxVideoMedia: await restore(input.minimaxVideoMedia),
  };
}

export function collectInlineVideoImagePaths(input: StoredVideoMediaFields) {
  return VIDEO_MEDIA_FIELDS.flatMap((field) => {
    const items = input[field];
    if (!Array.isArray(items)) return [];
    return items.flatMap((item) => {
      const file = (item?.inlineAudio ?? item?.inlineImage)?.relativePath;
      return typeof file === "string" && storedFileName.test(file) ? [file] : [];
    });
  });
}
