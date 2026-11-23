import { VIDEO_MEDIA_FIELDS } from "./types.js";

/**
 * 任务参数快照。
 *
 * 提交时服务端把整份请求写进 `tasks.input_json`，发送前再把真正出网的
 * 请求体写进 `effective_json`；重试也是重放 `input_json`，所以历史任务
 * 从来不会被之后的表单改动影响。缺的是给界面一份**能安全展示**的快照：
 * 原始 input 里有整段 base64 图片/音频，直接回传前端既拖慢列表也没必要。
 *
 * 这里只保留参数语义与素材清单：内联素材折成字节数，公网地址保留供展示。
 * 可复用的素材文件通过任务的素材入口单独读取。
 */

export interface TaskMediaSummary {
  /** 素材槽类型：first_frame / reference_image / reference_video / video_url … */
  type: string;
  role?: string;
  /** 只有 http(s) / oss 地址才保留；内联素材不保留正文 */
  url?: string;
  /** 内联素材的原始字节数（base64 解码后） */
  inlineBytes?: number;
  fileName?: string;
}

export interface TaskInputSnapshot {
  prompt: string;
  negativePrompt?: string;
  /** 生成方式：text-to-video / first-frame / video-edit … */
  mode?: string;
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
  ratio?: string;
  audio?: boolean;
  nativeAudio?: boolean;
  promptExtend?: boolean;
  watermark?: boolean;
  seed?: number;
  /** 参考图张数（文件不回收，只报数量） */
  imageCount: number;
  media: TaskMediaSummary[];
  /** 本地参考视频/音频只留文件名，供界面说明「提交时已上传」 */
  referenceVideo?: string;
  referenceAudio?: string;
}

const MAX_MEDIA_ITEMS = 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inlineBytesOf(url: string): number | null {
  const match = /^data:[^;]+;base64,(.+)$/i.exec(url);
  if (!match) return null;
  return Math.floor((match[1]!.length * 3) / 4);
}

function publicUrlOnly(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  return /^(https?:\/\/|oss:\/\/)/i.test(url) ? url : undefined;
}

function summarizeMediaList(value: unknown): TaskMediaSummary[] {
  if (!Array.isArray(value)) return [];
  const items: TaskMediaSummary[] = [];
  for (const entry of value.slice(0, MAX_MEDIA_ITEMS)) {
    if (!isRecord(entry)) continue;
    const type = typeof entry.type === "string" ? entry.type : undefined;
    if (!type) continue;
    const raw = entry.url;
    const url = publicUrlOnly(raw);
    const inline = entry.inlineAudio ?? entry.inlineImage;
    const inlineBytes = isRecord(inline) && typeof inline.byteSize === "number"
      ? inline.byteSize
      : typeof raw === "string" ? inlineBytesOf(raw) ?? undefined : undefined;
    const role = typeof entry.role === "string" ? entry.role : undefined;
    items.push({ type, ...(role ? { role } : {}), ...(url ? { url } : {}), ...(inlineBytes ? { inlineBytes } : {}) });
  }
  return items;
}

/**
 * `input_json` → 脱敏快照。认不出结构时返回 null，界面就不展示「本次参数」。
 */
export function summarizeTaskInput(input: unknown): TaskInputSnapshot | null {
  if (!isRecord(input)) return null;
  const mode = [input.wanVideoMode, input.seedanceVideoMode, input.klingVideoMode, input.minimaxVideoMode]
    .find((value): value is string => typeof value === "string" && Boolean(value));
  const media = VIDEO_MEDIA_FIELDS.flatMap((field) => summarizeMediaList(input[field]));
  for (const [source, type] of [[input.referenceVideos, "reference_video"], [input.referenceAudios, "reference_audio"]] as const) {
    if (!Array.isArray(source)) continue;
    for (const file of source.slice(0, MAX_MEDIA_ITEMS)) {
      if (isRecord(file) && typeof file.fileName === "string") media.push({ type, fileName: file.fileName });
    }
  }
  const referenceImages = Array.isArray(input.referenceImages)
    ? input.referenceImages
    : Array.isArray(input.referenceImage) ? [input.referenceImage] : [];
  const referenceVideo = isRecord(input.referenceVideo) && typeof input.referenceVideo.fileName === "string"
    ? input.referenceVideo.fileName
    : undefined;
  const referenceAudio = isRecord(input.referenceAudio) && typeof input.referenceAudio.fileName === "string"
    ? input.referenceAudio.fileName
    : undefined;
  const snapshot: TaskInputSnapshot = {
    prompt: typeof input.prompt === "string" ? input.prompt : "",
    imageCount: referenceImages.length,
    media,
  };
  if (typeof input.negativePrompt === "string" && input.negativePrompt) snapshot.negativePrompt = input.negativePrompt;
  if (mode) snapshot.mode = mode;
  if (typeof input.duration === "number") snapshot.duration = input.duration;
  if (typeof input.resolution === "string" && input.resolution) snapshot.resolution = input.resolution;
  if (typeof input.aspectRatio === "string" && input.aspectRatio) snapshot.aspectRatio = input.aspectRatio;
  if (typeof input.ratio === "string" && input.ratio) snapshot.ratio = input.ratio;
  if (typeof input.minimaxVideoMode === "string") snapshot.nativeAudio = true;
  else if (typeof input.audio === "boolean") snapshot.audio = input.audio;
  if (typeof input.promptExtend === "boolean") snapshot.promptExtend = input.promptExtend;
  if (typeof input.watermark === "boolean") snapshot.watermark = input.watermark;
  if (typeof input.seed === "number") snapshot.seed = input.seed;
  if (referenceVideo) snapshot.referenceVideo = referenceVideo;
  if (referenceAudio) snapshot.referenceAudio = referenceAudio;
  return snapshot;
}

/** 本次参数里真正值得摆在界面上的几行 */
export function snapshotSummaryLines(snapshot: TaskInputSnapshot | null | undefined, modeLabel?: string): string[] {
  if (!snapshot) return [];
  const lines: string[] = [];
  if (modeLabel) lines.push(`生成方式：${modeLabel}`);
  if (snapshot.resolution) lines.push(`分辨率：${snapshot.resolution}`);
  const ratio = snapshot.ratio ?? snapshot.aspectRatio;
  if (ratio) lines.push(`比例：${ratio === "adaptive" ? "自适应" : ratio}`);
  if (snapshot.duration != null) lines.push(`时长：${snapshot.duration === -1 ? "智能" : `${snapshot.duration} 秒`}`);
  if (snapshot.nativeAudio) lines.push("声音：模型原生生成");
  else if (snapshot.audio != null) lines.push(`声音：${snapshot.audio ? "开" : "关"}`);
  const videoCount = snapshot.media.filter((item) => /video/.test(item.type)).length;
  const imageCount = snapshot.imageCount + snapshot.media.filter((item) => /image|frame/.test(item.type)).length;
  const audioCount = snapshot.media.filter((item) => /audio/.test(item.type)).length;
  if (imageCount) lines.push(`参考图：${imageCount} 张`);
  if (videoCount) lines.push(`参考视频：${videoCount} 段`);
  if (audioCount) lines.push(`参考音频：${audioCount} 段`);
  return lines;
}
