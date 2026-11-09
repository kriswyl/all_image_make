import type {
  KlingVideoMode, SeedanceVideoMode, WanVideoMode,
} from "./types.js";
import { KLING_MODE_CAPABILITIES, klingModesForModel, VIDEO_CAPABILITIES, type VideoAdapter } from "./video-capabilities.js";
import { seedanceLimits } from "./seedance-capabilities.js";

/**
 * 视频工作台的「生成方式」真相。
 *
 * 放在 shared 是因为三处必须按同一份表说话：
 * 1. 前端只渲染这张表里列出的模式（按渠道 + 模型算），不再画点不动的按钮；
 * 2. 服务端在 `tasks.create` 用同一张表校验模式与素材，防止绕过界面直接提交；
 * 3. 适配器按表里的素材槽组装请求，界面和请求体不会再各写一套。
 *
 * 这里只描述「这家渠道真的能做什么」。上游没有编辑/延长时间线语义的渠道
 * （Seedance）就不列这些模式，而不是画一个灰按钮假装支持。
 *
 * 素材一律走本地上传：界面不再提供「粘贴公网地址」的输入框，模式表里也就
 * 没有 urlSlots。仍然接受 URL 的只剩服务端接口（Agent / 画布 / 脚本直连），
 * 那是接口能力，不是页面上的输入方式。
 */

export type VideoStudioMode = WanVideoMode | SeedanceVideoMode | KlingVideoMode;

/** 视频模式在 GenerationInput 上的字段名，按渠道二选一 */
export type VideoModeField = "wanVideoMode" | "seedanceVideoMode" | "klingVideoMode";

export interface VideoModeSpec {
  id: VideoStudioMode;
  label: string;
  hint: string;
  /** 按顺序分配给上传图片的素材类型；长度即该模式的图片槽数 */
  imageSlots: readonly string[];
  /** 图片槽是否可重复（参考图模式可传多张） */
  imageRepeatable: boolean;
  /** 接受一段参考视频（本地文件，提交时上传换公网地址） */
  acceptsReferenceVideo: boolean;
  /** 必须有参考视频才能提交（视频编辑 / 视频延长 / 运动控制） */
  needsReferenceVideo: boolean;
  /** 接受一段参考音频（本地文件；Seedance 可内联 base64） */
  acceptsReferenceAudio: boolean;
  /** 该模式下 duration 是否可调 */
  durationEditable: boolean;
}

export const WAN_MODE_SPECS: Record<WanVideoMode, VideoModeSpec> = {
  "text-to-video": {
    id: "text-to-video",
    label: "文生视频",
    hint: "仅凭提示词生成，不需要任何素材",
    imageSlots: [],
    imageRepeatable: false,
    acceptsReferenceVideo: false,
    needsReferenceVideo: false,
    acceptsReferenceAudio: false,
    durationEditable: true,
  },
  "first-frame": {
    id: "first-frame",
    label: "首帧生视频",
    hint: "上传 1 张图作为视频第一帧",
    imageSlots: ["first_frame"],
    imageRepeatable: false,
    acceptsReferenceVideo: false,
    needsReferenceVideo: false,
    acceptsReferenceAudio: false,
    durationEditable: true,
  },
  "first-last-frame": {
    id: "first-last-frame",
    label: "首尾帧生视频",
    hint: "第 1 张为首帧，第 2 张为尾帧",
    imageSlots: ["first_frame", "last_frame"],
    imageRepeatable: false,
    acceptsReferenceVideo: false,
    needsReferenceVideo: false,
    acceptsReferenceAudio: false,
    durationEditable: true,
  },
  reference: {
    id: "reference",
    label: "参考生视频",
    hint: "最多 10 张参考图，可搭配参考视频/音频；提示词里用 @ 引用素材",
    imageSlots: ["reference_image"],
    imageRepeatable: true,
    acceptsReferenceVideo: true,
    needsReferenceVideo: false,
    acceptsReferenceAudio: true,
    durationEditable: true,
  },
  "video-edit": {
    id: "video-edit",
    label: "视频编辑",
    hint: "对一段视频做风格或内容改写，不支持设置时长",
    imageSlots: [],
    imageRepeatable: false,
    acceptsReferenceVideo: true,
    needsReferenceVideo: true,
    acceptsReferenceAudio: false,
    durationEditable: false,
  },
  "video-extend": {
    id: "video-extend",
    label: "视频延长",
    hint: "在原视频之后续接新内容，输入与输出总时长不超过 30 秒",
    imageSlots: [],
    imageRepeatable: false,
    acceptsReferenceVideo: true,
    needsReferenceVideo: true,
    acceptsReferenceAudio: false,
    durationEditable: true,
  },
  "file-to-video": {
    id: "file-to-video",
    label: "参考文件生视频",
    hint: "依据文档或网页内容生成，提示词改写会强制开启",
    imageSlots: [],
    imageRepeatable: false,
    acceptsReferenceVideo: false,
    needsReferenceVideo: false,
    acceptsReferenceAudio: false,
    durationEditable: true,
  },
};

/** Seedance 的 content 只认图片/视频/音频 + role，没有编辑、延长、参考文件语义 */
export const SEEDANCE_MODE_SPECS: Record<SeedanceVideoMode, VideoModeSpec> = {
  "text-to-video": {
    id: "text-to-video",
    label: "文生视频",
    hint: "仅凭提示词生成，不需要任何素材",
    imageSlots: [],
    imageRepeatable: false,
    acceptsReferenceVideo: false,
    needsReferenceVideo: false,
    acceptsReferenceAudio: false,
    durationEditable: true,
  },
  "first-frame": {
    id: "first-frame",
    label: "首帧生视频",
    hint: "上传 1 张图作为视频第一帧",
    imageSlots: ["first_frame"],
    imageRepeatable: false,
    acceptsReferenceVideo: false,
    needsReferenceVideo: false,
    acceptsReferenceAudio: false,
    durationEditable: true,
  },
  "first-last-frame": {
    id: "first-last-frame",
    label: "首尾帧生视频",
    hint: "第 1 张为首帧，第 2 张为尾帧；2.5 下宽高比固定为自适应",
    imageSlots: ["first_frame", "last_frame"],
    imageRepeatable: false,
    acceptsReferenceVideo: false,
    needsReferenceVideo: false,
    acceptsReferenceAudio: false,
    durationEditable: true,
  },
  reference: {
    id: "reference",
    label: "参考生视频",
    hint: "参考图最多 9/30 张，可加参考视频与参考音频；提示词里用 @ 引用素材",
    imageSlots: ["reference_image"],
    imageRepeatable: true,
    acceptsReferenceVideo: true,
    needsReferenceVideo: false,
    acceptsReferenceAudio: true,
    durationEditable: true,
  },
};

export function klingModeSpec(mode: KlingVideoMode): VideoModeSpec {
  const cap = KLING_MODE_CAPABILITIES[mode];
  return {
    id: mode,
    label: cap.label,
    hint: cap.hint,
    imageSlots: cap.imageSlots,
    imageRepeatable: cap.imageRepeatable,
    acceptsReferenceVideo: cap.needsReferenceVideo,
    needsReferenceVideo: cap.needsReferenceVideo,
    acceptsReferenceAudio: false,
    durationEditable: cap.durationEditable,
  };
}

/** 界面上真正列出来的顺序 */
const WAN_MODE_ORDER: WanVideoMode[] = [
  "text-to-video", "first-frame", "first-last-frame", "reference",
  "video-edit", "video-extend",
];

/**
 * 「参考文件生视频」只能靠文档地址 / 网页链接，页面上已经没有链接输入，
 * 所以不再出现在界面上；接口与适配器仍保留，供 Agent、画布与脚本直连。
 */
const WAN_API_ONLY_MODES: WanVideoMode[] = ["file-to-video"];

const SEEDANCE_MODE_ORDER: SeedanceVideoMode[] = [
  "text-to-video", "first-frame", "first-last-frame", "reference",
];

export function isVideoAdapterType(adapter: string | undefined): adapter is VideoAdapter {
  return adapter === "grok-video" || adapter === "wan-video" || adapter === "seedance-video" || adapter === "kling-video";
}

/** 该渠道 + 模型能做的全部模式，含不提供界面入口的（接口仍可用） */
export function allVideoModes(adapter: string | undefined, model: string): VideoModeSpec[] {
  if (adapter === "wan-video") return [...WAN_MODE_ORDER, ...WAN_API_ONLY_MODES].map((mode) => WAN_MODE_SPECS[mode]);
  if (adapter === "seedance-video") return SEEDANCE_MODE_ORDER.map((mode) => SEEDANCE_MODE_SPECS[mode]);
  if (adapter === "kling-video") return klingModesForModel(model).map(klingModeSpec);
  return [];
}

/** 该渠道 + 模型在界面上提供的模式；Grok 没有模式概念，返回空 */
export function videoModesFor(adapter: string | undefined, model: string): VideoModeSpec[] {
  if (adapter === "wan-video") return WAN_MODE_ORDER.map((mode) => WAN_MODE_SPECS[mode]);
  return allVideoModes(adapter, model);
}

export function videoModeSpec(adapter: string | undefined, model: string, mode: string | undefined): VideoModeSpec | null {
  return allVideoModes(adapter, model).find((spec) => spec.id === mode) ?? null;
}

/** 模式 id → 中文名。历史任务只带 id，界面要能翻译成人话 */
export const VIDEO_MODE_LABELS: Record<VideoStudioMode, string> = {
  "text-to-video": "文生视频",
  "first-frame": "首帧生视频",
  "first-last-frame": "首尾帧生视频",
  reference: "参考生视频",
  "video-edit": "视频编辑",
  "video-extend": "视频延长",
  "file-to-video": "参考文件生视频",
  "motion-control": "运动控制",
};

export function videoModeLabel(mode: string | undefined): string | undefined {
  if (!mode) return undefined;
  return (VIDEO_MODE_LABELS as Record<string, string>)[mode];
}

export function videoModeField(adapter: string | undefined): VideoModeField | null {
  if (adapter === "wan-video") return "wanVideoMode";
  if (adapter === "seedance-video") return "seedanceVideoMode";
  if (adapter === "kling-video") return "klingVideoMode";
  return null;
}

/** 该模式下最多能放几张图：可重复的参考图按渠道上限，其余按槽位数 */
export function maxImagesForMode(adapter: string | undefined, model: string, mode: string | undefined): number {
  const spec = videoModeSpec(adapter, model, mode);
  if (!spec) return 0;
  if (!spec.imageRepeatable) return spec.imageSlots.length;
  if (adapter === "seedance-video") return seedanceLimits(model).maxImages;
  if (adapter === "wan-video") return VIDEO_CAPABILITIES["wan-video"].maxReferenceImages;
  if (adapter === "kling-video") return VIDEO_CAPABILITIES["kling-video"].maxReferenceImages;
  return 0;
}

/**
 * 参数面板里「格式」与「数量」的真相。
 *
 * 上游请求体没有 format 字段、也没有 n：万相/Seedance/可灵都是「一次一条 mp4」。
 * 所以这两组在面板里可见但锁定，理由写在 hint 里——不做能点却无效的控件。
 */
export const VIDEO_FORMAT_CHOICES = [
  { value: "mp4", label: "MP4", supported: true },
  { value: "mov", label: "MOV", supported: false, reason: "上游接口固定输出 MP4" },
] as const;

export const VIDEO_VARIANT_CHOICES = [
  { value: 1, label: "1", supported: true },
  { value: 2, label: "2", supported: false, reason: "一次提交只出一条视频，多条需重复提交（多次计费）" },
  { value: 3, label: "3", supported: false, reason: "一次提交只出一条视频，多条需重复提交（多次计费）" },
  { value: 4, label: "4", supported: false, reason: "一次提交只出一条视频，多条需重复提交（多次计费）" },
] as const;

/** 分辨率档位跟着模式走：运动控制只到 1080P */
export function resolutionOptionsFor(adapter: string | undefined, mode: string | undefined): string[] {
  if (adapter === "kling-video" && mode) {
    const spec = klingModeSpec(mode as KlingVideoMode);
    if (spec.id === "motion-control") return KLING_MODE_CAPABILITIES["motion-control"].resolutions;
  }
  if (adapter && isVideoAdapterType(adapter)) return VIDEO_CAPABILITIES[adapter].resolutions;
  return [];
}

export function supportsAudioFor(adapter: string | undefined, mode: string | undefined): boolean {
  if (!adapter || !isVideoAdapterType(adapter)) return false;
  if (adapter === "kling-video" && mode === "motion-control") return true;
  return VIDEO_CAPABILITIES[adapter].supportsAudio;
}
