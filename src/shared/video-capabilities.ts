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

export type VideoAdapter = "grok-video" | "wan-video" | "seedance-video";

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

/** 每个适配器真正支持的模式。Grok 只有文生/图生（参考图） */
export const VIDEO_MODES_BY_ADAPTER: Record<VideoAdapter, ConversationVideoMode[]> = {
  "grok-video": ["text-to-video", "reference"],
  "wan-video": ["text-to-video", "first-frame", "first-last-frame", "reference"],
  "seedance-video": ["text-to-video", "first-frame", "first-last-frame", "reference"],
};

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
