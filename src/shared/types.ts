// 参数核对结果（需求.md 问题 1）的类型住在 agent-types 里，因为 Agent 卡片先用到它。
// 这里只要类型、不要运行时的东西，所以用 `import type`——编译后整行消失，不会绕成一个环。
import type { ParamNote } from "./agent-types.js";

export type AdapterType =
  | "openai-images"
  | "openai-chat-image"
  | "gemini-content"
  | "generic-json"
  | "wan-video"
  | "grok-video"
  | "seedance-video"
  | "openai-chat";

export type AuthType = "bearer" | "x-api-key" | "query" | "custom-header" | "none";

/** 视频适配器集合：渠道筛选、历史分类都以此为准 */
export const VIDEO_ADAPTER_TYPES = ["wan-video", "grok-video", "seedance-video"] as const;
export type VideoAdapterType = (typeof VIDEO_ADAPTER_TYPES)[number];

export function isVideoAdapter(adapterType: AdapterType): adapterType is VideoAdapterType {
  return (VIDEO_ADAPTER_TYPES as readonly string[]).includes(adapterType);
}

/**
 * 对话适配器集合：只用于 Agent 的大脑调用，本身不出图也不出视频。
 * 它不经过 TaskRunner，因此不会产生任务记录，也不该出现在生图 / 视频工作台的渠道下拉里。
 */
export const CHAT_ADAPTER_TYPES = ["openai-chat"] as const;
export type ChatAdapterType = (typeof CHAT_ADAPTER_TYPES)[number];

export function isChatAdapter(adapterType: AdapterType): adapterType is ChatAdapterType {
  return (CHAT_ADAPTER_TYPES as readonly string[]).includes(adapterType);
}

/** 图片适配器：既不是视频也不是对话，生图工作台的渠道筛选以此为准 */
export function isImageAdapter(adapterType: AdapterType) {
  return !isVideoAdapter(adapterType) && !isChatAdapter(adapterType);
}

/**
 * 产物是不是图片。缩略图、参考图、视频首帧三处都要先过这一关：
 * 视频产物喂给 jimp 只会白花一次解码。
 */
export function isImageAsset(asset: { mimeType: string }) {
  return asset.mimeType.startsWith("image/");
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

/**
 * gemini-content 这类站点的 `imageConfig.imageSize` 取值（大小写敏感）。
 *
 * 放在 shared 里是因为三处要用同一份：设置页的校验、`TaskRunner.create()` 补默认值、
 * 以及参数核对面板的显示。少一处就会又出现「说的和做的对不上」。
 */
export const IMAGE_SIZE_VALUES = ["1K", "2K", "4K"] as const;
export type ImageSizeValue = (typeof IMAGE_SIZE_VALUES)[number];
/** 用户没指定、大脑也没指定时的兜底。2K 是这类站点最稳的一档（1K 偏糊，4K 又慢又贵） */
export const DEFAULT_IMAGE_SIZE: ImageSizeValue = "2K";

/**
 * 用户自带图片的限额：生图工作台的参考图、对话框里的上传、服务端收到的请求，
 * 走的都是这一套。
 *
 * 同一个限制散成三份的后果不是「多写了几行」，而是**三个入口慢慢给出不同的规矩**——
 * 前端放行、后端拒收，用户只会觉得这功能坏了。所以这里只留一份。
 */
export const MAX_REFERENCE_IMAGES = 8;
export const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * 画布最多放几张图。**和 `MAX_REFERENCE_IMAGES` 相等不是巧合，是同一笔账**：
 * 画布整组都会作为参考图发出去，8 张画布已经把单次请求的参考图预算吃光了。
 * 两个数写成一个是因为它们就该一起变；分头写死两个 8，早晚会有人只改一个。
 */
export const MAX_CANVAS_IMAGES = MAX_REFERENCE_IMAGES;

/**
 * 把字符串收成合法的 imageSize，认不出就返回 undefined。
 *
 * 专门用来把**我们自己要补进去的默认值**洗干净：设置表是纯字符串的 KV，被手工写脏
 * 或者从旧版本迁移过来都可能带上非法值，而把一个非法值补进请求体只是把
 * 「参数缺失」换成「参数非法」，照样失败、还白白多花一次钱。
 */
export function normalizeImageSize(value: string | null | undefined): ImageSizeValue | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return (IMAGE_SIZE_VALUES as readonly string[]).includes(trimmed) ? (trimmed as ImageSizeValue) : undefined;
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
  /**
   * 512px 缩略图地址，只有图片有。
   * 服务端按需生成，生成失败会 404，前端要 `onError` 回落到 `url`。
   */
  thumbUrl?: string | null;
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
  /**
   * 参数核对结果（需求.md 问题 1）：把「请求时写的」和「真正出网的」对账成人话。
   * 服务端用 Agent 卡片同一个 `auditParameters` 算好放进来，工作台的结果面板只负责显示——
   * 前端不该反过来 import 服务端模块。
   *
   * 渠道已删、或根本认不出适配器（上传素材的伪任务）时没有这一项。
   */
  parameterNotes?: ParamNote[];
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
  /** gemini 渠道缺省补的尺寸（需求.md 问题 1）；1K / 2K / 4K */
  geminiImageSize: ImageSizeValue;
  /** 默认生图 / 生视频模型（需求.md 问题 5），存 alias，空串表示没设 */
  defaultImageAlias: string;
  defaultVideoAlias: string;
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
