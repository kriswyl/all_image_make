import type { AdapterType, Channel, Task } from "./types.js";

/**
 * 渠道 / 任务的品类唯一真相。
 *
 * 以前这里是隐式的二元判断：`isImageAdapter` 的定义是「不是视频、不是对话」，
 * 于是每加一种产物都要在十几处补特判。音乐接入后这个漏洞会立刻变成真实 bug
 * （音乐渠道出现在生图下拉里、音乐任务被历史页当成图片）。
 *
 * 现在所有分类都从这里走；新增适配器只改这一个文件。
 */
export type ChannelKind = "image" | "video" | "audio" | "chat";
export type TaskKind = "image" | "video" | "audio";

/** 视频适配器集合：渠道筛选、历史分类都以此为准 */
export const VIDEO_ADAPTER_TYPES = ["wan-video", "grok-video", "seedance-video", "kling-video"] as const;
export type VideoAdapterType = (typeof VIDEO_ADAPTER_TYPES)[number];

/** 音频适配器集合。技术类型叫 audio，界面文案叫「音乐」 */
export const AUDIO_ADAPTER_TYPES = ["suno-music"] as const;
export type AudioAdapterType = (typeof AUDIO_ADAPTER_TYPES)[number];

/**
 * 对话适配器集合：只用于 Agent 的大脑调用，本身不出图也不出视频。
 * 它不经过 TaskRunner，因此不会产生任务记录，也不该出现在生图 / 视频工作台的渠道下拉里。
 */
export const CHAT_ADAPTER_TYPES = ["openai-chat"] as const;
export type ChatAdapterType = (typeof CHAT_ADAPTER_TYPES)[number];

export function channelKindOf(adapterType: AdapterType | string): ChannelKind {
  if ((CHAT_ADAPTER_TYPES as readonly string[]).includes(adapterType)) return "chat";
  if ((VIDEO_ADAPTER_TYPES as readonly string[]).includes(adapterType)) return "video";
  if ((AUDIO_ADAPTER_TYPES as readonly string[]).includes(adapterType)) return "audio";
  return "image";
}

export function isChannelKind(adapterType: AdapterType | string, kind: ChannelKind): boolean {
  return channelKindOf(adapterType) === kind;
}

export function isVideoAdapter(adapterType: AdapterType | string): adapterType is VideoAdapterType {
  return (VIDEO_ADAPTER_TYPES as readonly string[]).includes(adapterType);
}

export function isAudioAdapter(adapterType: AdapterType | string): adapterType is AudioAdapterType {
  return (AUDIO_ADAPTER_TYPES as readonly string[]).includes(adapterType);
}

export function isChatAdapter(adapterType: AdapterType | string): adapterType is ChatAdapterType {
  return (CHAT_ADAPTER_TYPES as readonly string[]).includes(adapterType);
}

/** 图片适配器：显式按品类判断，不再用「排除法」 */
export function isImageAdapter(adapterType: AdapterType | string) {
  return channelKindOf(adapterType) === "image";
}

/**
 * 任务品类。
 *
 * 优先看渠道适配器——失败任务没有产物时也能判断；渠道被删了才退回 MIME。
 * 音频先于视频判断，因为音乐任务的封面是一张图，不能被误判成图片任务。
 */
export function taskKindFor(adapterType: string | undefined, mimeTypes: readonly string[]): TaskKind {
  if (adapterType) {
    const kind = channelKindOf(adapterType);
    if (kind === "video" || kind === "audio" || kind === "image") return kind;
  }
  if (mimeTypes.some((mimeType) => mimeType.startsWith("audio/"))) return "audio";
  if (mimeTypes.some((mimeType) => mimeType.startsWith("video/"))) return "video";
  return "image";
}

export function taskKindOf(task: Task, channels: readonly Channel[]): TaskKind {
  const channel = channels.find((item) => item.id === task.channelId);
  return taskKindFor(channel?.adapterType, task.assets.map((asset) => asset.mimeType));
}

/** 产物是不是图片。缩略图、参考图、视频首帧三处都要先过这一关 */
export function isImageAsset(asset: { mimeType: string }) {
  return asset.mimeType.startsWith("image/");
}

export function isVideoAsset(asset: { mimeType: string }) {
  return asset.mimeType.startsWith("video/");
}

export function isAudioAsset(asset: { mimeType: string }) {
  return asset.mimeType.startsWith("audio/");
}
