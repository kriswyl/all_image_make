import fs from "node:fs/promises";
import path from "node:path";
import { isVideoAdapter } from "../shared/kinds.js";
import { videoInputFields } from "../shared/video-modes.js";
import { summarizeTaskInput } from "../shared/video-snapshot.js";
import type { VideoReuseKind, VideoReuseSlot, VideoTaskReuse } from "../shared/video-reuse.js";
import { AppError } from "./app-error.js";
import type { AppDatabase } from "./db.js";
import type { StoredGenerationInput } from "./task-input-files.js";
import { restoreInlineVideoEntry, type StoredVideoMediaFields } from "./task-video-images.js";
import { audioExtension, extensionForMime } from "./task-media.js";

type Entry = NonNullable<StoredVideoMediaFields[keyof StoredVideoMediaFields]>[number];
type SavedFile = { relativePath: string; mimeType: string; fileName: string };
type Source = Omit<VideoReuseSlot, "index" | "available"> & { path?: string; entry?: Entry };
const dataUrl = /^data:((?:image|audio)\/[a-z0-9.+-]+)(?:;[^,]*)?;base64,([a-z0-9+/=]+)$/i;
const mediaOverride: Record<string, string> = { "seedance-video": "content", "kling-video": "contents", "grok-video": "reference_images" };
const limits: Record<VideoReuseKind, number> = { image: 30_000_000, video: 100 * 1024 * 1024, audio: 15 * 1024 * 1024 };

function kindOf(type: string): VideoReuseKind | null {
  if (["reference_image", "first_frame", "last_frame", "image", "image_url"].includes(type)) return "image";
  if (["reference_video", "video", "video_url"].includes(type)) return "video";
  if (["reference_audio", "audio", "audio_url"].includes(type)) return "audio";
  return null;
}

function fileSource(file: SavedFile, kind: VideoReuseKind, role: string): Source {
  return { kind, role, name: file.fileName, mimeType: file.mimeType, path: file.relativePath };
}

function sourcesOf(input: StoredGenerationInput, adapter: string): Source[] {
  const fields = videoInputFields(adapter);
  const entries = fields ? input[fields.media] ?? [] : [];
  const sources: Source[] = [];
  if (adapter === "grok-video" || (adapter === "wan-video" && !entries.length)) {
    const images = input.referenceImages?.length ? input.referenceImages : input.referenceImage ? [input.referenceImage] : [];
    sources.push(...images.map((image) => fileSource(image, "image", "reference_image")));
  }
  for (const item of entries) {
    const kind = kindOf(item.type);
    if (!kind) continue;
    const role = ("role" in item ? item.role : undefined) ?? (item.type === "image_url" ? "first_frame" : item.type);
    const inline = item.inlineImage ?? item.inlineAudio;
    const mime = inline?.mimeType ?? dataUrl.exec(item.url)?.[1];
    const extension = mime ? kind === "audio" ? audioExtension(mime) : extensionForMime(mime) : "";
    const name = `${kind === "image" ? "参考图" : kind === "video" ? "参考视频" : "参考音频"} ${sources.length + 1}${extension ? `.${extension}` : ""}`;
    sources.push({ kind, role, name, mimeType: mime,
      ...(mime ? { entry: item, path: inline?.relativePath } : { reason: "历史记录只保存了素材地址，请选择原文件" }) });
  }
  for (const file of input.referenceVideos?.length ? input.referenceVideos : input.referenceVideo ? [input.referenceVideo] : []) {
    sources.push(fileSource(file, "video", "reference_video"));
  }
  for (const file of input.referenceAudios?.length ? input.referenceAudios : input.referenceAudio ? [input.referenceAudio] : []) {
    sources.push(fileSource(file, "audio", "reference_audio"));
  }
  return sources;
}

function readTask(db: AppDatabase, id: string) {
  const task = db.getTaskRow(id);
  const adapter = task && db.getChannel(task.channelId)?.adapterType;
  if (!task || !adapter || !isVideoAdapter(adapter) || task.origin !== "generate") {
    throw new AppError("VIDEO_REUSE_UNAVAILABLE", "找不到可复用的视频任务或原渠道", 404);
  }
  const input = JSON.parse(task.inputJson) as StoredGenerationInput;
  return { adapter, input, sources: sourcesOf(input, adapter) };
}

async function available(db: AppDatabase, id: string, source: Source) {
  if (source.reason) return false;
  if (!source.path) return Boolean(source.entry);
  if (path.basename(source.path) !== source.path || !source.path.startsWith(`${id}-`)) return false;
  const stat = await fs.lstat(path.join(db.inputsDir, source.path)).catch(() => null);
  return Boolean(stat?.isFile() && stat.size > 0 && stat.size <= limits[source.kind] * (source.entry ? 1.4 : 1));
}

export async function describeVideoTaskReuse(db: AppDatabase, id: string): Promise<VideoTaskReuse> {
  const { adapter, input, sources } = readTask(db, id);
  const snapshot = summarizeTaskInput(input)!;
  const unsupportedReason = input.wanVideoMedia?.some((item) => item.type === "file" || item.type === "link")
    ? "原任务使用了文档或网页链接，视频工作台暂不支持这种输入。"
    : undefined;
  snapshot.media.forEach((item) => { delete item.url; });
  const raw = Object.entries(input.rawParameters ?? {});
  const slots = await Promise.all(sources.map(async (source, index): Promise<VideoReuseSlot> => {
    const { kind, role, name, mimeType } = source;
    const exists = await available(db, id, source);
    return { index, kind, role, name, mimeType, available: exists,
      ...(exists ? {} : { reason: source.reason ?? "本地原文件已丢失或无法读取" }) };
  }));
  return { snapshot, slots, unsupportedReason, timeoutMs: input.timeoutMs, orientation: input.klingCharacterOrientation, multiShot: input.klingMultiShot,
    inlineAudio: Boolean(input.seedanceVideoMedia?.some((item) => item.type === "audio_url")),
    rawParameters: Object.fromEntries(raw.filter(([key]) => key !== mediaOverride[adapter])),
    omittedRawFields: raw.filter(([key]) => key === mediaOverride[adapter]).map(([key]) => key),
  };
}

export async function readVideoTaskReuseFile(db: AppDatabase, id: string, index: number) {
  const source = readTask(db, id).sources[index];
  if (source && await available(db, id, source)) {
    if (source.entry) {
      const item = await restoreInlineVideoEntry(source.entry, db.inputsDir);
      const match = dataUrl.exec(item.url);
      if (match) {
        const bytes = Buffer.from(match[2]!, "base64");
        if (bytes.length && bytes.length <= limits[source.kind]) return { bytes, mimeType: match[1]! };
      }
    } else if (source.path && source.mimeType && source.mimeType.startsWith(`${source.kind}/`)) {
      return { bytes: await fs.readFile(path.join(db.inputsDir, source.path)), mimeType: source.mimeType };
    }
  }
  throw new AppError("VIDEO_REUSE_FILE_MISSING", "找不到任务的参考素材，请选择原文件", 404);
}
