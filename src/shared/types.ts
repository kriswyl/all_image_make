export type AdapterType =
  | "openai-images"
  | "openai-chat-image"
  | "gemini-content"
  | "generic-json"
  | "wan-video"
  | "grok-video"
  | "seedance-video";

export type AuthType = "bearer" | "x-api-key" | "query" | "custom-header" | "none";

/** 视频适配器集合：渠道筛选、历史分类都以此为准 */
export const VIDEO_ADAPTER_TYPES = ["wan-video", "grok-video", "seedance-video"] as const;
export type VideoAdapterType = (typeof VIDEO_ADAPTER_TYPES)[number];

export function isVideoAdapter(adapterType: AdapterType): adapterType is VideoAdapterType {
  return (VIDEO_ADAPTER_TYPES as readonly string[]).includes(adapterType);
}

/**
 * 万相的七种请求形态，对应官方文档的「请求示例」分类。
 * Grok 只有文生/图生两种，复用 text-to-video 与 reference。
 */
export type VideoMode =
  | "text-to-video"
  | "first-frame"
  | "first-last-frame"
  | "reference"
  | "video-edit"
  | "video-extend"
  | "file-reference";

/** 万相 input.media 支持的素材类型 */
export type VideoMediaType =
  | "first_frame"
  | "last_frame"
  | "reference_image"
  | "reference_video"
  | "reference_audio"
  | "file"
  | "link";

export interface VideoMediaInput {
  type: VideoMediaType;
  /** 公网 URL、OSS 临时 URL，或 data:{mime};base64,{data}（仅图像支持 base64） */
  url: string;
}

/**
 * Seedance 的生成方式。请求体里不带模式字段，火山方舟按 content 里的
 * 素材类型和 role 自行推断，所以这里只用于前端渲染对应的输入槽。
 */
export type SeedanceVideoMode =
  | "text-to-video"
  | "first-frame"
  | "first-last-frame"
  | "reference";

/** Seedance content 数组里的素材类型 */
export type SeedanceMediaType = "image_url" | "video_url" | "audio_url";

/** Seedance 的素材角色，首尾帧模式下必填 */
export type SeedanceMediaRole =
  | "first_frame"
  | "last_frame"
  | "reference_image"
  | "reference_video"
  | "reference_audio";

export interface SeedanceMediaInput {
  type: SeedanceMediaType;
  /** 公网 URL 或 data:{mime};base64,{data} */
  url: string;
  role?: SeedanceMediaRole;
}

/** 万相视频生成的 7 种模式 */
export type WanVideoMode =
  | "text-to-video"           // 文生视频：仅 prompt
  | "first-frame"             // 首帧生视频：1 张 first_frame
  | "first-last-frame"        // 首尾帧生视频：1 张 first_frame + 1 张 last_frame
  | "reference"               // 参考生视频：reference_image/video/audio 自由组合
  | "video-edit"              // 视频编辑：1 段 reference_video
  | "video-extend"            // 视频延长：1 段 reference_video + duration
  | "file-to-video";          // 参考文件生视频：1 个 file/link + 必须 prompt_extend=true

export type TaskStatus =
  | "queued"
  | "validating"
  | "submitting"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export interface Channel {
  id: string;
  name: string;
  baseUrl: string;
  adapterType: AdapterType;
  authType: AuthType;
  authHeaderName: string;
  secretEnv: string;
  endpoint: string;
  models: string[];
  allowPrivateNetwork: boolean;
  enabled: boolean;
  hasKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelInput extends Omit<Channel, "id" | "hasKey" | "createdAt" | "updatedAt"> {
  apiKey?: string;
}

export interface ReferenceImageInput {
  base64: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  fileName: string;
}

export interface GenerationInput {
  channelId: string;
  model: string;
  prompt: string;
  referenceImages?: ReferenceImageInput[];
  /** @deprecated Kept for retrying tasks created before multi-image support. */
  referenceImage?: ReferenceImageInput;
  negativePrompt?: string;
  size?: string;
  aspectRatio?: string;
  count?: number;
  quality?: string;
  outputFormat?: "png" | "jpeg" | "webp";
  background?: "auto" | "opaque" | "transparent";
  moderation?: "auto" | "low";
  style?: "auto" | "vivid" | "natural";
  responseFormat?: "auto" | "url" | "b64_json";
  stream?: boolean;
  imageSize?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  maxOutputTokens?: number;
  responseModalities?: Array<"TEXT" | "IMAGE">;
  seed?: number;
  /** Video generation parameters */
  duration?: number;
  resolution?: string;
  /** 万相：宽高比，可选 adaptive / 21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16 */
  ratio?: string;
  /** 万相：是否生成音频，默认 true */
  audio?: boolean;
  promptExtend?: boolean;
  watermark?: boolean;
  /** 万相视频生成模式（仅万相需要） */
  wanVideoMode?: WanVideoMode;
  /** 万相视频媒体素材（仅万相需要，替代 referenceImages） */
  wanVideoMedia?: VideoMediaInput[];
  /** Seedance 视频生成模式（仅 Seedance 需要） */
  seedanceVideoMode?: SeedanceVideoMode;
  /** Seedance 视频媒体素材（仅 Seedance 需要，替代 referenceImages） */
  seedanceVideoMedia?: SeedanceMediaInput[];
  /** 本次请求的超时等待时长（毫秒） */
  timeoutMs?: number;
  rawParameters?: Record<string, unknown>;
}

export interface Asset {
  id: string;
  taskId: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  url: string;
  /** Video duration in seconds (null for images) */
  duration?: number | null;
  createdAt: string;
}

export interface Task {
  id: string;
  channelId: string;
  channelName: string;
  model: string;
  prompt: string;
  status: TaskStatus;
  progress: number | null;
  effectiveParameters: Record<string, unknown> | null;
  attemptCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  assets: Asset[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** 任务是否属于视频：优先看渠道适配器，失败任务没有产物时也能判断 */
export function isVideoTask(task: Task, channels: Channel[]): boolean {
  const channel = channels.find((item) => item.id === task.channelId);
  if (channel) return isVideoAdapter(channel.adapterType);
  return task.assets.some((asset) => asset.mimeType.startsWith("video/"));
}

export interface Diagnostic {
  id: string;
  taskId: string;
  request: Record<string, unknown> | null;
  response: unknown;
  httpStatus: number | null;
  durationMs: number | null;
  createdAt: string;
}

export interface BootstrapData {
  channels: Channel[];
  tasks: Task[];
  service: {
    version: string;
    dataPath: string;
    /** 产物（图片/视频）当前落盘目录 */
    assetsPath: string;
    /** 未自定义时的默认产物目录，用于「恢复默认」 */
    defaultAssetsPath: string;
  };
}

export interface Settings {
  assetsDir: string;
  defaultAssetsDir: string;
}

/** 清空历史的作用范围 */
export type ClearScope = "image" | "video" | "all";

export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}
