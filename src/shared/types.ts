// 参数核对结果（需求.md 问题 1）的类型住在 agent-types 里，因为 Agent 卡片先用到它。
// 这里只要类型、不要运行时的东西，所以用 `import type`——编译后整行消失，不会绕成一个环。
import type { ParamNote } from "./agent-types.js";
import type { MidjourneyMeta } from "./midjourney.js";
import { taskKindOf as taskKindOfFromKinds } from "./kinds.js";

export {
  AUDIO_ADAPTER_TYPES,
  CHAT_ADAPTER_TYPES,
  VIDEO_ADAPTER_TYPES,
  channelKindOf,
  isAudioAdapter,
  isAudioAsset,
  isChannelKind,
  isChatAdapter,
  isImageAdapter,
  isImageAsset,
  isVideoAdapter,
  isVideoAsset,
  taskKindFor,
  taskKindOf,
  type AudioAdapterType,
  type ChannelKind,
  type ChatAdapterType,
  type TaskKind,
  type VideoAdapterType,
} from "./kinds.js";

export type AdapterType =
  | "openai-images"
  | "openai-chat-image"
  | "gemini-content"
  | "generic-json"
  | "wan-video"
  | "grok-video"
  | "seedance-video"
  | "kling-video"
  | "suno-music"
  | "gemini-tts"
  | "midjourney"
  | "openai-chat";

export type AuthType = "bearer" | "x-api-key" | "query" | "custom-header" | "none";


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
 * 可灵的生成方式。
 *
 * 文档按模型拆能力：kling-3.0 有运动控制，turbo 只有文生/首帧，
 * omni 才有首尾帧和参考图（`refer_image`）。普通图生视频目前只开放首帧。
 */
export type KlingVideoMode =
  | "text-to-video"
  | "first-frame"
  | "first-last-frame"
  | "reference"
  | "motion-control";

/** 运动控制里角色朝向：跟图片一致（参考视频 ≤10 秒）或跟视频一致（≤30 秒） */
export type KlingCharacterOrientation = "image" | "video";

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

/**
 * 可灵视频素材。
 *
 * `image` / `video` 只用于运动控制（角色图和参考动作视频），其余是生成素材。
 * 参考视频只接受公网地址：中转的请求体内联上限约 1.4MB，本地视频转 base64 必定超限。
 */
export type KlingMediaType = "first_frame" | "last_frame" | "reference_image" | "image" | "video";

export interface KlingMediaInput {
  type: KlingMediaType;
  /** 公网 URL 或 data:{mime};base64,{data}（video 仅支持公网 URL） */
  url: string;
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

/** Suno 的音乐生成方式；歌词生成不在本轮范围 */
export type MusicMode =
  | "inspiration"
  | "custom"
  | "cover"
  | "mashup"
  | "sound"
  | "playlist"
  | "sample";

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
 * 局部重绘蒙版。只接受 PNG：透明像素 = 需要重新生成的区域，不透明像素 = 保留原图。
 *
 * 不复用 `ReferenceImageInput`：那个类型允许 JPEG / WebP，会把「蒙版必须是 PNG」
 * 这条上游硬约束悄悄放宽，等到中转站报错时用户已经花了一次请求。
 */
export interface MaskImageInput {
  base64: string;
  mimeType: "image/png";
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
 * 局部重绘蒙版的上限，来自 OpenAI Images edit 的官方约束：
 * 必须是 PNG、小于 4 MB、并且和底图同尺寸。
 */
export const MAX_MASK_IMAGE_BYTES = 4 * 1024 * 1024;

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

/** Gemini TTS 双人对话的一个说话人 */
export interface TtsSpeakerVoice {
  /** 正文里的说话人标记，例如 A / B */
  speaker: string;
  /** 预置音色名，例如 Kore / Puck */
  voice: string;
}

export interface GenerationInput {
  channelId: string;
  model: string;
  prompt: string;
  referenceImages?: ReferenceImageInput[];
  /** @deprecated Kept for retrying tasks created before multi-image support. */
  referenceImage?: ReferenceImageInput;
  /** 局部重绘蒙版；必须搭配恰好 1 张参考图，且仅 openai-images 适配器支持 */
  maskImage?: MaskImageInput;
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
  /** 可灵视频媒体素材（仅 Kling 需要，替代 referenceImages） */
  klingVideoMedia?: KlingMediaInput[];
  /** 可灵生成方式（仅 Kling 需要） */
  klingVideoMode?: KlingVideoMode;
  /** 运动控制：角色朝向跟随图片还是参考视频 */
  klingCharacterOrientation?: KlingCharacterOrientation;
  /** 可灵多镜头；不填按文档默认 true */
  klingMultiShot?: boolean;
  /** 音乐生成方式：灵感 / 自定义歌词 / 翻唱 / 混音 / 音效 / 歌单风格 / 取样 */
  musicMode?: MusicMode;
  /** 歌名，最多 80 字 */
  musicTitle?: string;
  /** 曲风标签，最多 1000 字 */
  musicTags?: string;
  /** 要排除的曲风 */
  musicNegativeTags?: string;
  /** 纯音乐（无人声） */
  musicInstrumental?: boolean;
  /** Suno 模型版本，例如 chirp-v3-5；不填由适配器补默认值 */
  musicVersion?: string;
  /** 翻唱源曲的 Suno custom_id */
  musicCoverClipId?: string;
  /** 混音源曲的两个 Suno custom_id */
  musicMashupClipIds?: string[];
  /** 音效模式的 BPM / 调性 / 是否循环 */
  musicSoundConfigs?: { tempo?: number; key?: string; loop?: boolean };
  /** Midjourney 版本参数，例如 7 / 6.1；不填由上游使用默认版本 */
  midjourneyVersion?: string;
  /** Midjourney 后续动作：对已有远端任务执行放大/变体/重绘 */
  midjourneyAction?: {
    /** 上游 MJ 任务 id（不是本地 task id） */
    taskId: string;
    customId: string;
    label?: string;
  };
  /** TTS 音色名；大小写不敏感，不填由适配器补 Kore */
  ttsVoice?: string;
  /** TTS 风格标注（annotations.style），例如「轻声耳语，放慢语速」 */
  ttsStyle?: string;
  /** TTS 语种 BCP-47，例如 zh-CN / en-US；不填按文本自动判断 */
  ttsLanguage?: string;
  /** 双人对话音色；给了就必须正好 2 个，正文里用 A：/ B： 标注说话人 */
  ttsSpeakers?: TtsSpeakerVoice[];
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
  /** Video/audio duration in seconds (null for images) */
  duration?: number | null;
  /** 音乐产物的歌名 / 歌词 / 曲风 / Suno custom_id（图片/视频为 null） */
  title?: string | null;
  lyrics?: string | null;
  tags?: string | null;
  remoteClipId?: string | null;
  createdAt: string;
}

export interface Task {
  id: string;
  origin?: "generate" | "upload";
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
  /** 上游任务的附加元数据；Midjourney 用它带回按钮（U1-U4 / V1-V4 / 重绘） */
  remoteMeta?: { midjourney?: MidjourneyMeta } | null;
  assets: Asset[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** 任务是否属于视频：优先看渠道适配器，失败任务没有产物时也能判断 */
export function isVideoTask(task: Task, channels: Channel[]): boolean {
  return taskKindOfFromKinds(task, channels) === "video";
}

/** 任务品类：图片 / 视频 / 音频。所有分类都走这一份真相 */
export function taskKind(task: Task, channels: Channel[]) {
  return taskKindOfFromKinds(task, channels);
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

/**
 * 可以在模型面板里设默认的四类。
 *
 * 音乐和语音在任务表里同属 `audio`（都要落一个音频产物），但它们是两种完全
 * 不同的模型：Suno 写歌、Gemini TTS 朗读。默认值必须分开存，否则设了音乐
 * 默认之后，语音的「默认」会指向一个不能朗读的模型。
 */
export type DefaultModelGroup = "image" | "video" | "music" | "speech";

export interface Settings {
  assetsDir: string;
  defaultAssetsDir: string;
  /** gemini 渠道缺省补的尺寸（需求.md 问题 1）；1K / 2K / 4K */
  geminiImageSize: ImageSizeValue;
  /** 默认生图 / 生视频 / 音乐 / 语音模型，存 alias，空串表示没设 */
  defaultImageAlias: string;
  defaultVideoAlias: string;
  defaultMusicAlias: string;
  defaultSpeechAlias: string;
  /**
   * @deprecated 旧版只有一个音频默认值，音乐和语音共用。新代码请用
   * `defaultMusicAlias` / `defaultSpeechAlias`；这里只为兼容老配置保留。
   */
  defaultAudioAlias: string;
}

/** 清空历史的作用范围 */
export type ClearScope = "image" | "video" | "audio" | "all";

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
