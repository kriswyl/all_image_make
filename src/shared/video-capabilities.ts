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
