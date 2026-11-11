import type { KlingCharacterOrientation } from "./types.js";
import { seedanceVersion } from "./seedance-capabilities.js";
import { VIDEO_CAPABILITIES, type VideoAdapter } from "./video-capabilities.js";
import { resolutionOptionsFor, studioModeSpec, type VideoModeSpec } from "./video-modes.js";
import type { TaskInputSnapshot } from "./video-snapshot.js";

/**
 * 视频生成页的草稿。
 *
 * 一份草稿 = 一个「渠道:模式」组合，键是 `${adapter}:${mode}`：
 * 切模式、切模型、切渠道都不会丢掉别处的输入。素材文件本身不能进
 * localStorage，所以只持久化提示词与参数；图片/视频/音频文件
 * 由 `useMediaBuckets` 按同一个键在内存里分桶保存。
 */
export interface VideoDraft {
  prompt: string;
  negativePrompt: string;
  duration: number;
  resolution: string;
  aspectRatio: string;
  ratio: string;
  audio: boolean;
  promptExtend: boolean;
  watermark: boolean;
  seed: string;
  timeoutSeconds: number;
  raw: string;
  orientation: KlingCharacterOrientation;
  multiShot: boolean;
  /** Seedance 参考音频是否走内联 base64；渠道没配上传地址时强制为真 */
  inlineAudio: boolean;
}

export function draftKey(adapter: string | undefined, mode: string | undefined): string {
  return `${adapter ?? "none"}:${mode ?? "none"}`;
}

export function defaultVideoDraft(adapter: string | undefined, mode: string | undefined): VideoDraft {
  const caps = adapter && adapter in VIDEO_CAPABILITIES ? VIDEO_CAPABILITIES[adapter as VideoAdapter] : null;
  const resolutions = resolutionOptionsFor(adapter, mode);
  return {
    prompt: "",
    negativePrompt: "",
    duration: caps?.durations.fixed ?? caps?.durations.default ?? 5,
    resolution: resolutions[Math.min(1, resolutions.length - 1)] ?? "",
    aspectRatio: caps?.ratioField === "aspectRatio" ? caps.aspectRatios[0] ?? "16:9" : "16:9",
    ratio: caps?.ratioField === "ratio" ? caps.aspectRatios[0] ?? "adaptive" : "adaptive",
    audio: true,
    promptExtend: true,
    watermark: false,
    seed: "",
    timeoutSeconds: 600,
    raw: "{}",
    orientation: "video",
    multiShot: true,
    inlineAudio: false,
  };
}

export interface ReconcileNotice {
  key: "mode" | "duration" | "resolution" | "ratio" | "audio";
  message: string;
}

export interface ReconcileResult {
  draft: VideoDraft;
  notices: ReconcileNotice[];
}

/** 把数值收敛到闭区间；上游给的是字符串档位时原样保留 */
function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/**
 * 换渠道 / 换模型 / 换模式后重新校验参数。
 *
 * 只动「这一组参数在这个渠道+模式下不成立」的项，并且把改动原因带回去让界面提示，
 * 不做静默篡改：用户看得见 4K 被降成 1080P 是因为运动控制不支持 4K。
 */
export function reconcileVideoDraft(
  draft: VideoDraft,
  options: { adapter: string | undefined; model: string; mode: string | undefined },
): ReconcileResult {
  const { adapter, model, mode } = options;
  const spec = studioModeSpec(adapter, model, mode);
  const caps = adapter && adapter in VIDEO_CAPABILITIES ? VIDEO_CAPABILITIES[adapter as VideoAdapter] : null;
  const notices: ReconcileNotice[] = [];
  if (!caps) return { draft, notices };
  const next: VideoDraft = { ...draft };

  // 时长：固定档位、不可编辑、上下限三件事都按渠道与模式算
  if (caps.durations.fixed != null) {
    if (next.duration !== caps.durations.fixed) {
      next.duration = caps.durations.fixed;
      notices.push({ key: "duration", message: `${caps.label} 的时长固定为 ${caps.durations.fixed} 秒` });
    }
  } else if (spec && !spec.durationEditable) {
    // 保持原值，只是界面不展示；提交时也不会带出去
  } else if (next.duration !== -1) {
    const clamped = clampNumber(next.duration, caps.durations.min, caps.durations.max);
    if (clamped !== next.duration) {
      next.duration = clamped;
      notices.push({ key: "duration", message: `时长已调整为 ${clamped} 秒（${caps.durations.min}–${caps.durations.max} 秒）` });
    }
  }

  // 分辨率：跟着模式走（运动控制只到 1080P）
  const resolutions = resolutionOptionsFor(adapter, mode);
  if (resolutions.length && !resolutions.includes(next.resolution)) {
    next.resolution = resolutions[Math.min(1, resolutions.length - 1)];
    notices.push({ key: "resolution", message: `分辨率已调整为 ${next.resolution}` });
  }

  // 宽高比：字段名与档位都跟渠道走
  if (caps.ratioField === "ratio") {
    const locked = adapter === "seedance-video" && seedanceVersion(model) === "2.5"
      && (mode === "frames" || mode === "first-frame" || mode === "first-last-frame");
    if (locked && next.ratio !== "adaptive") {
      next.ratio = "adaptive";
      notices.push({ key: "ratio", message: "2.5 的首帧 / 首尾帧只接受自适应比例" });
    } else if (!locked && !caps.aspectRatios.includes(next.ratio)) {
      next.ratio = caps.aspectRatios[0];
      notices.push({ key: "ratio", message: `宽高比已调整为 ${next.ratio}` });
    }
  } else if (!caps.aspectRatios.includes(next.aspectRatio)) {
    next.aspectRatio = caps.aspectRatios[0];
    notices.push({ key: "ratio", message: `宽高比已调整为 ${next.aspectRatio}` });
  }

  if (!caps.supportsAudio && next.audio) next.audio = false;
  if (!caps.supportsPromptExtend && next.promptExtend) next.promptExtend = false;
  if (!caps.supportsWatermark && next.watermark) next.watermark = false;
  return { draft: next, notices };
}

/** 模式切换后：把参数按新模式再收敛一次，素材槽由调用方按桶保留 */
export function videoModeOfDraft(adapter: string | undefined, model: string, mode: string | undefined): VideoModeSpec | null {
  return studioModeSpec(adapter, model, mode);
}

/**
 * 从任务快照里回收可复用的部分。
 *
 * 素材只存在于历史任务的文件里，页面上又没有「粘贴公网地址」的入口，
 * 所以一律回收不了：这里如实返回丢弃了多少个，由界面提示「需重新选择」，
 * 不把上游返回的临时地址塞进看不见的草稿字段里再偷偷提交。
 */
export function applySnapshotToDraft(
  draft: VideoDraft,
  snapshot: TaskInputSnapshot,
): { draft: VideoDraft; droppedMedia: number } {
  const droppedMedia = snapshot.media.length + snapshot.imageCount;
  const next: VideoDraft = {
    ...draft,
    prompt: snapshot.prompt || draft.prompt,
    negativePrompt: snapshot.negativePrompt ?? draft.negativePrompt,
    duration: snapshot.duration ?? draft.duration,
    resolution: snapshot.resolution ?? draft.resolution,
    aspectRatio: snapshot.aspectRatio ?? draft.aspectRatio,
    ratio: snapshot.ratio ?? draft.ratio,
    audio: snapshot.audio ?? draft.audio,
    promptExtend: snapshot.promptExtend ?? draft.promptExtend,
    watermark: snapshot.watermark ?? draft.watermark,
    seed: snapshot.seed == null ? draft.seed : String(snapshot.seed),
  };
  return { draft: next, droppedMedia };
}
