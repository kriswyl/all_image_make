import { AppError } from "./app-error.js";
import type { GenerationInput } from "../shared/types.js";
import { VIDEO_CAPABILITIES, type VideoAdapter } from "../shared/video-capabilities.js";
import {
  isVideoAdapterType, resolutionOptionsFor, videoModeSpec, videoModesFor, videoModeLabel,
} from "../shared/video-modes.js";

/**
 * 生成方式的服务端守卫。
 *
 * 界面只会按渠道能力渲染模式，但接口不能假设请求一定来自界面：Agent、
 * 画布、脚本都能直接 POST。这里用与前端同一张模式表复核三件事——
 * 模式在这个模型上成立、素材够（不缺、不超）、参数在档位内。
 * 不成立就当场报错，而不是把请求发给上游换一个含混的 400。
 */

interface ChannelLike {
  adapterType: string;
  name?: string | null;
}

interface UploadFlags {
  referenceVideoUpload?: boolean;
  referenceAudioUpload?: boolean;
}

const IMAGE_TYPES = new Set(["first_frame", "last_frame", "reference_image", "image", "image_url"]);
const VIDEO_TYPES = new Set(["reference_video", "video_url", "video"]);

function mediaOf(input: GenerationInput) {
  return [
    ...(input.wanVideoMedia ?? []),
    ...(input.seedanceVideoMedia ?? []),
    ...(input.klingVideoMedia ?? []),
  ];
}

function countImages(input: GenerationInput): number {
  const fromMedia = mediaOf(input).filter((item) => IMAGE_TYPES.has(item.type)).length;
  const fromUploads = input.referenceImages?.length ?? (input.referenceImage ? 1 : 0);
  return Math.max(fromMedia, fromUploads);
}

function hasMediaType(input: GenerationInput, types: Set<string>): boolean {
  return mediaOf(input).some((item) => types.has(item.type));
}

export function assertVideoModeRequest(channel: ChannelLike, input: GenerationInput, uploads: UploadFlags = {}): void {
  const adapter = channel.adapterType;
  if (!isVideoAdapterType(adapter)) return;
  const modes = videoModesFor(adapter, input.model);
  // Grok 没有模式概念，只按参考图上限兜底
  if (!modes.length) {
    const caps = VIDEO_CAPABILITIES[adapter as VideoAdapter];
    const count = countImages(input);
    if (count > caps.maxReferenceImages) {
      throw new AppError("MODE_MEDIA_LIMIT", `${caps.label} 参考图最多 ${caps.maxReferenceImages} 张`, 400);
    }
    return;
  }

  const field = adapter === "wan-video" ? "wanVideoMode" : adapter === "seedance-video" ? "seedanceVideoMode" : "klingVideoMode";
  const requested = input[field];
  if (!requested) return;
  const spec = videoModeSpec(adapter, input.model, requested);
  if (!spec) {
    throw new AppError(
      "MODE_UNSUPPORTED",
      `当前模型不支持「${videoModeLabel(requested) ?? requested}」模式，可选：${modes.map((item) => item.label).join(" / ")}`,
      400,
    );
  }

  // 素材数量：固定槽位必须齐，可重复槽位不能超上限
  const images = countImages(input);
  if (!spec.imageRepeatable) {
    if (images < spec.imageSlots.length) {
      throw new AppError("MODE_MEDIA_REQUIRED", `${spec.label}需要 ${spec.imageSlots.length} 张图片`, 400);
    }
    if (images > spec.imageSlots.length) {
      throw new AppError("MODE_MEDIA_LIMIT", `${spec.label}最多 ${spec.imageSlots.length} 张图片`, 400);
    }
  } else {
    const caps = VIDEO_CAPABILITIES[adapter as VideoAdapter];
    if (images > caps.maxReferenceImages) {
      throw new AppError("MODE_MEDIA_LIMIT", `${spec.label}参考图最多 ${caps.maxReferenceImages} 张`, 400);
    }
  }

  // 参考视频只能由本地文件上传换回地址（页面不再提供粘贴公网地址的入口），
  // API 直连仍可能自带 media，所以两种情况都算素材齐。
  if (spec.needsReferenceVideo && !uploads.referenceVideoUpload && !hasMediaType(input, VIDEO_TYPES)) {
    throw new AppError("MODE_MEDIA_REQUIRED", `${spec.label}需要上传一段参考视频`, 400);
  }

  // 万相：文档地址与网页链接互斥，参考文件模式必须二选一
  if (adapter === "wan-video") {
    const hasFile = hasMediaType(input, new Set(["file"]));
    const hasLink = hasMediaType(input, new Set(["link"]));
    if (hasFile && hasLink) throw new AppError("MODE_MEDIA_CONFLICT", "文档地址与网页链接只能填写一个", 400);
    if (spec.id === "file-to-video" && !hasFile && !hasLink) {
      throw new AppError("MODE_MEDIA_REQUIRED", "请填写文档地址或网页链接", 400);
    }
  }

  // 参数档位：分辨率跟模式走（运动控制只到 1080P），时长在区间内
  const caps = VIDEO_CAPABILITIES[adapter as VideoAdapter];
  if (input.resolution && !resolutionOptionsFor(adapter, spec.id).includes(input.resolution)) {
    throw new AppError(
      "MODE_PARAM_UNSUPPORTED",
      `${spec.label}的分辨率只支持 ${resolutionOptionsFor(adapter, spec.id).join(" / ")}`,
      400,
    );
  }
  // 不支持时长的模式（视频编辑、运动控制）不报错：内部调用方（画布、Agent）会统一带默认值，
  // 适配器按模式直接不发送这个字段，这里只校验「真的会出网」的那些模式。
  if (input.duration != null && input.duration !== -1 && caps.durations.fixed == null && spec.durationEditable
    && (input.duration < caps.durations.min || input.duration > caps.durations.max)) {
    throw new AppError("MODE_PARAM_UNSUPPORTED", `时长需在 ${caps.durations.min}–${caps.durations.max} 秒之间`, 400);
  }
}
