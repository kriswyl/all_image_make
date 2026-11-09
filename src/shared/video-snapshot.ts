/**
 * 任务参数快照。
 *
 * 提交时服务端把整份请求写进 `tasks.input_json`，发送前再把真正出网的
 * 请求体写进 `effective_json`；重试也是重放 `input_json`，所以历史任务
 * 从来不会被之后的表单改动影响。缺的是给界面一份**能安全展示**的快照：
 * 原始 input 里有整段 base64 图片/音频，直接回传前端既拖慢列表也没必要。
 *
 * 这里只保留参数语义与素材清单：内联素材折成字节数，公网地址原样保留，仅用于
 * 展示「这条任务用过哪些素材」。页面不再接受粘贴地址，所以「复用参数」只回填
 * 提示词与数值，素材一律提示重新上传。
 */

export interface TaskMediaSummary {
  /** 素材槽类型：first_frame / reference_image / reference_video / video_url … */
  type: string;
  role?: string;
  /** 只有 http(s) / oss 地址才保留；内联素材不保留正文 */
  url?: string;
  /** 内联素材的原始字节数（base64 解码后） */
  inlineBytes?: number;
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
    const inlineBytes = typeof raw === "string" ? inlineBytesOf(raw) ?? undefined : undefined;
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
  const mode = [input.wanVideoMode, input.seedanceVideoMode, input.klingVideoMode]
    .find((value): value is string => typeof value === "string" && Boolean(value));
  const media = [
    ...summarizeMediaList(input.wanVideoMedia),
    ...summarizeMediaList(input.seedanceVideoMedia),
    ...summarizeMediaList(input.klingVideoMedia),
  ];
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
  if (typeof input.audio === "boolean") snapshot.audio = input.audio;
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
  if (snapshot.audio != null) lines.push(`声音：${snapshot.audio ? "开" : "关"}`);
  const videoCount = snapshot.media.filter((item) => /video/.test(item.type)).length;
  if (snapshot.imageCount) lines.push(`参考图：${snapshot.imageCount} 张`);
  if (videoCount) lines.push(`参考视频：${videoCount} 段`);
  return lines;
}
