import type { KlingMediaType, KlingVideoMode } from "./types.js";

/**
 * 各家视频接口的能力差异。
 *
 * 放在 shared 里是因为**两个地方**要按同一份真相渲染：视频工作台的参数面板，
 * 以及对话里的确认卡片（卡片上的时长范围、分辨率档位、音频开关都得跟着渠道走——
 * 给 Grok 摆一个「带音频」，它根本不认这个参数，用户勾了也是白勾）。
 */
export interface VideoCapability {
  label: string;
  maxReferenceImages: number;
  durations: { min: number; max: number; fixed: number | null; default: number };
  resolutions: string[];
  aspectRatios: string[];
  /** 宽高比在请求体里的字段名：Grok 是 aspect_ratio，万相是 ratio */
  ratioField: "aspectRatio" | "ratio";
  supportsPromptExtend: boolean;
  supportsSeed: boolean;
  supportsWatermark: boolean;
  supportsAudio: boolean;
  /** 万相支持 duration = -1 的智能时长 */
  supportsSmartDuration: boolean;
}

export type VideoAdapter = "grok-video" | "wan-video" | "seedance-video" | "kling-video";

/**
 * 对话里能真正执行的视频模式。
 *
 * `video-edit` / `video-extend` / `file-to-video` 需要视频或文件素材，
 * 对话工具目前拿不到这些，所以不列进来——列了只会让大脑规划出跑不通的一轮。
 */
export type ConversationVideoMode = "text-to-video" | "first-frame" | "first-last-frame" | "reference";

export const VIDEO_MODE_LABELS: Record<ConversationVideoMode, string> = {
  "text-to-video": "文生视频",
  "first-frame": "首帧生视频",
  "first-last-frame": "首尾帧生视频",
  reference: "参考生视频",
};

/**
 * 可灵每种模式的输入槽和参数范围。
 *
 * 不只 UI 用：适配器也按这份表决定发哪些字段——图生视频没有 `aspect_ratio`，
 * 运动控制没有时长/宽高比，乱塞会被原生接口直接拒掉。
 */
export interface KlingModeCapability {
  label: string;
  hint: string;
  /** 按顺序分配给上传图片的 contents type，长度即图片上限 */
  imageSlots: KlingMediaType[];
  /** 图片槽是否可重复（参考图可传多张） */
  imageRepeatable: boolean;
  /** 是否支持 duration；运动控制由参考视频决定 */
  durationEditable: boolean;
  /** 是否发送 aspect_ratio（文生 / Omni 支持，图生和运动控制不支持） */
  aspectRatio: boolean;
  resolutions: string[];
  /** 音频档位；UI 开关打开取第一项，关闭取 off */
  audioModes: Array<"off" | "native" | "original">;
  /** 运动控制需要额外的参考视频公网地址 */
  needsReferenceVideo: boolean;
}

export const KLING_MODE_CAPABILITIES: Record<KlingVideoMode, KlingModeCapability> = {
  "text-to-video": {
    label: "文生视频",
    hint: "仅凭提示词生成，支持 4K、原生音频与多镜头",
    imageSlots: [],
    imageRepeatable: false,
    durationEditable: true,
    aspectRatio: true,
    resolutions: ["720p", "1080p", "4k"],
    audioModes: ["native", "off"],
    needsReferenceVideo: false,
  },
  "first-frame": {
    label: "首帧生视频",
    hint: "上传 1 张图作为视频第一帧；需要指定结尾就用「首尾帧生视频」",
    imageSlots: ["first_frame"],
    imageRepeatable: false,
    durationEditable: true,
    aspectRatio: false,
    resolutions: ["720p", "1080p", "4k"],
    audioModes: ["native", "off"],
    needsReferenceVideo: false,
  },
  "first-last-frame": {
    label: "首尾帧生视频",
    hint: "第 1 张为首帧，第 2 张为尾帧",
    imageSlots: ["first_frame", "last_frame"],
    imageRepeatable: false,
    durationEditable: true,
    aspectRatio: true,
    resolutions: ["720p", "1080p", "4k"],
    audioModes: ["native", "off"],
    needsReferenceVideo: false,
  },
  reference: {
    label: "参考生视频",
    hint: "最多 4 张参考图，提示词里可用「图1」「图2」指代；仅 Omni 支持",
    imageSlots: ["reference_image"],
    imageRepeatable: true,
    durationEditable: true,
    aspectRatio: true,
    resolutions: ["720p", "1080p", "4k"],
    audioModes: ["native", "off"],
    needsReferenceVideo: false,
  },
  "motion-control": {
    label: "运动控制",
    hint: "上传角色图并给出参考动作视频；角色朝向选「图片」时视频 ≤10 秒，选「视频」时 ≤30 秒",
    imageSlots: ["image"],
    imageRepeatable: false,
    durationEditable: false,
    aspectRatio: false,
    resolutions: ["720p", "1080p"],
    audioModes: ["original", "off"],
    needsReferenceVideo: true,
  },
};

/**
 * 可灵各模型真正开放的模式。
 *
 * 首尾帧在原生文档里写着「尾帧暂未开放」，但 2026-10-22 实测 3.0 与 Turbo
 * 都能提交并成功生成，最后一帧与输入尾帧一致，所以按实测放开。
 * 参考图（refer_image）实测被普通图生接口拒绝，仍是 Omni 专属。
 */
export function klingModesForModel(model: string | undefined): KlingVideoMode[] {
  if (/omni/i.test(model ?? "")) return ["text-to-video", "first-frame", "first-last-frame", "reference"];
  if (/turbo/i.test(model ?? "")) return ["text-to-video", "first-frame", "first-last-frame"];
  return ["text-to-video", "first-frame", "first-last-frame", "motion-control"];
}

/** 对话里能用的模式：运动控制需要参考视频，工作台之外拿不到 */
export function klingConversationModes(model: string | undefined): ConversationVideoMode[] {
  return klingModesForModel(model).filter((mode): mode is ConversationVideoMode => mode !== "motion-control");
}

/** 各视频适配器的默认参数。视频工作台、对话工具和无限画布共用一份，用户不必重新学 */
export const VIDEO_DEFAULTS: Record<string, { duration: number; resolution: string; audio: boolean }> = {
  "wan-video": { duration: 5, resolution: "720P", audio: true },
  "seedance-video": { duration: 5, resolution: "720p", audio: false },
  "grok-video": { duration: 8, resolution: "720p", audio: false },
  "kling-video": { duration: 5, resolution: "720p", audio: false },
};

/** 每个适配器真正支持的模式。Grok 只有文生/图生（参考图） */
export const VIDEO_MODES_BY_ADAPTER: Record<VideoAdapter, ConversationVideoMode[]> = {
  "grok-video": ["text-to-video", "reference"],
  "wan-video": ["text-to-video", "first-frame", "first-last-frame", "reference"],
  "seedance-video": ["text-to-video", "first-frame", "first-last-frame", "reference"],
  "kling-video": ["text-to-video", "first-frame", "first-last-frame", "reference"],
};

/**
 * 模式列表的唯一入口。
 *
 * 可灵的能力按模型分，适配器级别只知道「可灵」不够：给 turbo 规划一个参考图模式，
 * 提交时才会发现端点根本不认。模型未知时退回最保守的文生/首帧。
 */
export function supportedVideoModes(adapterType: string, model?: string): ConversationVideoMode[] {
  if (adapterType === "kling-video") return klingConversationModes(model);
  return VIDEO_MODES_BY_ADAPTER[adapterType as VideoAdapter] ?? ["text-to-video"];
}

/** Grok 那边的「图生视频」不叫参考生视频，卡片上说人话 */
export function videoModeLabel(mode: ConversationVideoMode, adapterType?: string) {
  if (adapterType === "grok-video" && mode === "reference") return "图生视频";
  return VIDEO_MODE_LABELS[mode];
}

/** 各家视频接口的能力差异集中在这里，UI 按此渲染 */
export const VIDEO_CAPABILITIES: Record<VideoAdapter, VideoCapability> = {
  "grok-video": {
    label: "Grok Imagine",
    maxReferenceImages: 7,
    durations: { min: 1, max: 15, fixed: null, default: 8 },
    resolutions: ["480p", "720p", "1080p"],
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    ratioField: "aspectRatio",
    supportsPromptExtend: false,
    supportsSeed: false,
    supportsWatermark: false,
    supportsAudio: false,
    supportsSmartDuration: false,
  },
  "wan-video": {
    label: "通义万相",
    maxReferenceImages: 10,
    durations: { min: 2, max: 30, fixed: null, default: 5 },
    resolutions: ["480P", "720P", "1080P"],
    aspectRatios: ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    ratioField: "ratio",
    supportsPromptExtend: true,
    supportsSeed: true,
    supportsWatermark: true,
    supportsAudio: true,
    supportsSmartDuration: true,
  },
  "kling-video": {
    label: "可灵 Kling",
    maxReferenceImages: 4,
    durations: { min: 3, max: 15, fixed: null, default: 5 },
    // 具体模式能选哪些档位看 KLING_MODE_CAPABILITIES（运动控制只到 1080p）
    resolutions: ["720p", "1080p", "4k"],
    aspectRatios: ["16:9", "9:16", "1:1"],
    ratioField: "aspectRatio",
    supportsPromptExtend: false,
    supportsSeed: false,
    supportsWatermark: true,
    supportsAudio: true,
    supportsSmartDuration: false,
  },
  "seedance-video": {
    label: "豆包 Seedance",
    maxReferenceImages: 10,
    durations: { min: 4, max: 30, fixed: null, default: 5 },
    resolutions: ["480p", "720p", "1080p"],
    aspectRatios: ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    ratioField: "ratio",
    supportsPromptExtend: false,
    supportsSeed: true,
    supportsWatermark: true,
    supportsAudio: true,
    supportsSmartDuration: true,
  },
};
