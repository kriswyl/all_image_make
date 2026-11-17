import { validateReferenceMedia } from "./reference-video.js";
import { wavDurationSeconds } from "./task-media.js";
import { AppError } from "./app-error.js";
import type { GenerationInput } from "../shared/types.js";
import { MINIMAX_REFERENCE_LIMITS, VIDEO_CAPABILITIES, type VideoAdapter } from "../shared/video-capabilities.js";
import { seedanceLimits } from "../shared/seedance-capabilities.js";
import {
  allVideoModes, isVideoAdapterType, maxImagesForMode, referenceMediaLimits, resolutionOptionsFor, videoModeSpec, videoModeLabel, referenceMediaCombinationError, resolveMinimaxMode, videoInputFields,
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
  /** 本地参考视频的段数（Seedance 最多十段，万相/可灵一段） */
  referenceVideoUploads?: number;
  referenceAudioUploads?: number;
  referenceImageCount?: number;
}

const IMAGE_TYPES = new Set(["first_frame", "last_frame", "reference_image", "image", "image_url"]);
const VIDEO_TYPES = new Set(["reference_video", "video_url", "video"]);
const AUDIO_TYPES = new Set(["reference_audio", "audio_url", "audio"]);

export function assertVideoModeRequest(channel: ChannelLike, input: GenerationInput, uploads: UploadFlags = {}): void {
  const adapter = channel.adapterType;
  if (!isVideoAdapterType(adapter)) return;
  const genericImages = uploads.referenceImageCount ?? (input.referenceImages?.length || (input.referenceImage ? 1 : 0));
  const modes = allVideoModes(adapter, input.model);
  // Grok 没有模式概念，只按参考图上限兜底
  if (!modes.length) {
    const caps = VIDEO_CAPABILITIES[adapter as VideoAdapter];
    const rawImages = input.rawParameters?.reference_images;
    const count = Array.isArray(rawImages) ? rawImages.length : genericImages;
    if (count > caps.maxReferenceImages) {
      throw new AppError("MODE_MEDIA_LIMIT", `${caps.label} 参考图最多 ${caps.maxReferenceImages} 张`, 400);
    }
    return;
  }

  const fields = videoInputFields(adapter);
  if (!fields) return;
  const media = input[fields.media] ?? [];
  const requested = input[fields.mode] ?? (adapter === "minimax-video" ? resolveMinimaxMode(media, uploads.referenceVideoUploads) : undefined);
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
  const images = adapter === "wan-video" && !media.length
    ? genericImages
    : media.filter((item) => IMAGE_TYPES.has(item.type)).length;
  if (!spec.imageRepeatable) {
    if (images < spec.imageSlots.length) {
      throw new AppError("MODE_MEDIA_REQUIRED", `${spec.label}需要 ${spec.imageSlots.length} 张图片`, 400);
    }
    if (images > spec.imageSlots.length) {
      throw new AppError("MODE_MEDIA_LIMIT", `${spec.label}最多 ${spec.imageSlots.length} 张图片`, 400);
    }
  } else {
    const maxImages = maxImagesForMode(adapter, input.model, spec.id);
    if (images > maxImages) {
      throw new AppError("MODE_MEDIA_LIMIT", `${spec.label}参考图最多 ${maxImages} 张`, 400);
    }
  }

  if (adapter === "minimax-video") {
    if (genericImages) throw new AppError("MODE_MEDIA_CONFLICT", "MiniMax H3 请用 minimaxVideoMedia 标记图片用途", 400);
    const slots = spec.imageSlots;
    const imageItems = media.filter(({ type }) => IMAGE_TYPES.has(type));
    const wrongRole = spec.imageRepeatable
      ? imageItems.some(({ type }) => type !== slots[0])
      : slots.some((slot) => imageItems.filter(({ type }) => type === slot).length !== 1);
    if (wrongRole) throw new AppError("MODE_MEDIA_CONFLICT", `${spec.label}的图片角色不匹配，请分别指定首帧、尾帧或参考图`, 400);
    if (media.some(({ type, url }) => type === "video" && !/^https?:\/\//i.test(url))) {
      throw new AppError("MODE_MEDIA_CONFLICT", "MiniMax H3 参考视频需使用公网链接或本地视频上传", 400);
    }
  }

  if (adapter === "minimax-video") {
    let audioDuration = 0;
    for (const item of input.minimaxVideoMedia ?? []) {
      if (item.type !== "audio" || /^https?:\/\//i.test(item.url)) continue;
      const inline = /^data:audio\/(mpeg|mp3|wav|x-wav|wave);base64,/i.exec(item.url);
      if (!inline) throw new AppError("REFERENCE_AUDIO_INVALID", "MiniMax H3 参考音频仅支持内联 MP3、WAV 或公网链接", 400);
      const buffer = Buffer.from(item.url.slice(inline[0].length), "base64");
      const wav = /wav/i.test(inline[1]!);
      validateReferenceMedia({ buffer, mimetype: wav ? "audio/wav" : "audio/mpeg", originalname: wav ? "audio.wav" : "audio.mp3" }, "audio");
      const duration = wav ? wavDurationSeconds(buffer) : undefined;
      if (duration != null && (duration < MINIMAX_REFERENCE_LIMITS.minClipSeconds || duration > MINIMAX_REFERENCE_LIMITS.maxClipSeconds)) {
        throw new AppError("REFERENCE_AUDIO_INVALID", "参考音频时长需为 2–15 秒", 400);
      }
      audioDuration += duration ?? 0;
      if (audioDuration > MINIMAX_REFERENCE_LIMITS.maxSecondsPerKind) throw new AppError("REFERENCE_AUDIO_INVALID", "参考音频总时长不能超过 15 秒", 400);
    }
  }

  // 参考视频只能由本地文件上传换回地址（页面不再提供粘贴公网地址的入口），
  // API 直连仍可能自带 media，所以两种情况都算素材齐。
  if (spec.needsReferenceVideo && !(uploads.referenceVideoUploads ?? 0) && !media.some((item) => VIDEO_TYPES.has(item.type))) {
    throw new AppError("MODE_MEDIA_REQUIRED", `${spec.label}需要上传一段参考视频`, 400);
  }

  // 参考视频 / 音频的段数按渠道 + 模型的上限复核：Seedance 2.0 各 3 段、
  // 2.5 各 10 段，万相/可灵各 1 段。接口不能只信界面给的段数。
  const limits = referenceMediaLimits(adapter, input.model, spec);
  const videoCount = (uploads.referenceVideoUploads ?? 0) + media.filter((item) => VIDEO_TYPES.has(item.type)).length;
  const audioCount = (uploads.referenceAudioUploads ?? 0) + media.filter((item) => AUDIO_TYPES.has(item.type)).length;
  if (videoCount > limits.videos) {
    throw new AppError("MODE_MEDIA_LIMIT", `${spec.label}最多 ${limits.videos} 段参考视频（当前 ${videoCount} 段）`, 400);
  }
  if (audioCount > limits.audios) {
    throw new AppError("MODE_MEDIA_LIMIT", `${spec.label}最多 ${limits.audios} 段参考音频（当前 ${audioCount} 段）`, 400);
  }
  const combinationError = referenceMediaCombinationError(limits, { images, videos: videoCount, audios: audioCount });
  if (combinationError) throw new AppError(videoCount + audioCount + images > (limits.total ?? Infinity) ? "MODE_MEDIA_LIMIT" : "MODE_MEDIA_REQUIRED", combinationError, 400);
  if (adapter === "minimax-video" && spec.id === "reference" && !images && !videoCount && !audioCount) {
    throw new AppError("MODE_MEDIA_REQUIRED", "参考生视频至少需要一份参考素材", 400);
  }
  if (adapter === "seedance-video") {
    const { maxTotal } = seedanceLimits(input.model);
    if (images + videoCount + audioCount > maxTotal) {
      throw new AppError("MODE_MEDIA_LIMIT", `素材合计最多 ${maxTotal} 份`, 400);
    }
  }

  // 万相：文档地址与网页链接互斥，参考文件模式必须二选一
  if (adapter === "wan-video") {
    const hasFile = media.some((item) => item.type === "file");
    const hasLink = media.some((item) => item.type === "link");
    if (hasFile && hasLink) throw new AppError("MODE_MEDIA_CONFLICT", "文档地址与网页链接只能填写一个", 400);
    if (spec.id === "file-to-video" && !hasFile && !hasLink) {
      throw new AppError("MODE_MEDIA_REQUIRED", "请填写文档地址或网页链接", 400);
    }
  }

  // 参数档位：分辨率跟模式走（运动控制只到 1080P），时长在区间内
  const caps = VIDEO_CAPABILITIES[adapter as VideoAdapter];
  if (caps.maxPromptLength && Array.from(input.prompt).length > caps.maxPromptLength) {
    throw new AppError("MODE_PARAM_UNSUPPORTED", `提示词最多 ${caps.maxPromptLength} 字`, 400);
  }
  if (adapter === "minimax-video" && input.ratio && !caps.aspectRatios.includes(input.ratio)) {
    throw new AppError("MODE_PARAM_UNSUPPORTED", `宽高比只支持 ${caps.aspectRatios.join(" / ")}`, 400);
  }
  if (input.resolution && !resolutionOptionsFor(adapter, spec.id).includes(input.resolution)) {
    throw new AppError(
      "MODE_PARAM_UNSUPPORTED",
      `${spec.label}的分辨率只支持 ${resolutionOptionsFor(adapter, spec.id).join(" / ")}`,
      400,
    );
  }
  // 不支持时长的模式（视频编辑、运动控制）不报错：内部调用方（画布、Agent）会统一带默认值，
  // 适配器按模式直接不发送这个字段，这里只校验「真的会出网」的那些模式。
  if (input.duration != null && (input.duration !== -1 || adapter === "minimax-video") && caps.durations.fixed == null && spec.durationEditable
    && (input.duration < caps.durations.min || input.duration > caps.durations.max || (adapter === "minimax-video" && !Number.isInteger(input.duration)))) {
    throw new AppError("MODE_PARAM_UNSUPPORTED", `时长需在 ${caps.durations.min}–${caps.durations.max} 秒之间`, 400);
  }
}
