import type { SeedanceMediaInput } from "./types.js";

/**
 * Seedance 参考多模态的版本上限。代码里以前只按「图片 10 张」写死，
 * 2.0 / 2.5 的参考视频与参考音频能力完全没有进入能力矩阵。
 */
export type SeedanceVersion = "2.0" | "2.5";

export type SeedanceLimits = {
  maxImages: number;
  maxVideos: number;
  maxAudios: number;
  /** 合计素材上限（图片 + 视频 + 音频） */
  maxTotal: number;
};

export const SEEDANCE_LIMITS: Record<SeedanceVersion, SeedanceLimits> = {
  "2.0": { maxImages: 9, maxVideos: 3, maxAudios: 3, maxTotal: 15 },
  "2.5": { maxImages: 30, maxVideos: 10, maxAudios: 10, maxTotal: 50 },
};

/** 模型 ID 形如 sd-2.5 / sd-2.0-fast / seedance-2.5；认不出按 2.0 的保守上限。 */
export function seedanceVersion(model: string): SeedanceVersion {
  return /(?:^|[-_/])2\.5(?:$|[-_])|sd-2\.5|seedance-2\.5/i.test(model) ? "2.5" : "2.0";
}

export function seedanceLimits(model: string): SeedanceLimits {
  return SEEDANCE_LIMITS[seedanceVersion(model)];
}

/** 提交前统一校验，前端与服务端共用同一套说法。 */
export function validateSeedanceMedia(
  media: SeedanceMediaInput[],
  model: string,
  options: { allowInlineAudio?: boolean } = {},
): string | undefined {
  const limits = seedanceLimits(model);
  const count = (type: SeedanceMediaInput["type"]) => media.filter(item => item.type === type).length;
  const images = count("image_url"), videos = count("video_url"), audios = count("audio_url");
  if (images > limits.maxImages) return `参考图最多 ${limits.maxImages} 张（当前 ${images} 张）`;
  if (videos > limits.maxVideos) return `参考视频最多 ${limits.maxVideos} 段（当前 ${videos} 段）`;
  if (audios > limits.maxAudios) return `参考音频最多 ${limits.maxAudios} 段（当前 ${audios} 段）`;
  if (media.length > limits.maxTotal) return `素材合计最多 ${limits.maxTotal} 份（当前 ${media.length} 份）`;
  // 视频内联一定超预算；音频是否接受 base64 上游未确认，只在显式开启时放行并自行承担被拒风险。
  if (media.some(item => item.type === "video_url" && /^data:/i.test(item.url))) {
    return "参考视频请使用公网 URL，内联 base64 会超过请求预算";
  }
  if (!options.allowInlineAudio && media.some(item => item.type === "audio_url" && /^data:/i.test(item.url))) {
    return "参考音频请使用公网 URL；如需试验内联 base64，请在页面上勾选对应开关";
  }
  if (media.some(item => (item.type === "video_url" || item.type === "audio_url") && !/^(https?:\/\/|data:audio\/)/i.test(item.url))) {
    return "参考视频 / 音频地址必须是 http(s):// 开头的公网 URL";
  }
  return undefined;
}
