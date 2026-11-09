import type { VideoDraft } from "../../shared/video-draft";
import type { KlingMediaInput, SeedanceMediaInput, SeedanceMediaRole, VideoMediaInput } from "../../shared/types";
import { validateSeedanceMedia } from "../../shared/seedance-capabilities";
import type { VideoModeSpec } from "../../shared/video-modes";
import type { MediaBucket } from "../hooks/useMediaBuckets";

/**
 * 把「创作框里的草稿」拼成各家接口的素材数组。
 *
 * 这里的规则与 `src/shared/video-modes.ts` 的模式表一一对应：图片按槽位顺序
 * 分配角色；参考视频一律走提交时的 multipart 上传（服务端换成公网地址后补进
 * 请求体，不把 100MB 视频塞进 JSON）；参考音频在 Seedance 下可内联 base64。
 *
 * 页面不再接受手填的公网地址，所以这里没有任何「读 URL 输入框」的分支。
 */

export interface MediaBuildContext {
  spec: VideoModeSpec;
  bucket: MediaBucket;
  draft: VideoDraft;
  model: string;
  /** 参考音频是否内联 base64（Seedance 在渠道无上传地址时强制） */
  inlineAudio: boolean;
}

export async function buildWanMedia({ spec, bucket }: MediaBuildContext): Promise<VideoMediaInput[] | string> {
  const media: VideoMediaInput[] = [];
  for (const [index, item] of bucket.images.entries()) {
    const type = spec.imageRepeatable ? spec.imageSlots[0] : spec.imageSlots[index];
    if (!type) return `${spec.label}最多接受 ${spec.imageSlots.length} 张图片`;
    media.push({ type: type as VideoMediaInput["type"], url: await fileToVideoDataUrl(item.file) });
  }
  if (spec.imageSlots.length && !spec.imageRepeatable && bucket.images.length < spec.imageSlots.length) {
    return `${spec.label}需要 ${spec.imageSlots.length} 张图片`;
  }

  if (spec.needsReferenceVideo && !bucket.video) {
    return `${spec.label}需要上传一段参考视频`;
  }
  // 本地视频由服务端在 multipart 上传后补 reference_video，这里先空着
  if (spec.acceptsReferenceAudio && bucket.audio) {
    media.push({ type: "reference_audio", url: await fileToDataUrl(bucket.audio.file) });
  }
  return media;
}

export async function buildSeedanceMedia({ spec, bucket, model, inlineAudio }: MediaBuildContext): Promise<SeedanceMediaInput[] | string> {
  const slots = spec.imageSlots;
  if (!slots.length && !bucket.video && !bucket.audio) return [];
  if (!spec.imageRepeatable && slots.length && bucket.images.length < slots.length) {
    return `${spec.label}需要 ${slots.length} 张图片`;
  }
  if (!spec.imageRepeatable && bucket.images.length > slots.length) {
    return `${spec.label}最多 ${slots.length} 张图片`;
  }

  const media: SeedanceMediaInput[] = [];
  for (const [index, item] of bucket.images.entries()) {
    const role = spec.imageRepeatable ? slots[0] : slots[index];
    if (!role) return `${spec.label}最多 ${slots.length} 张图片`;
    media.push({ type: "image_url", url: await fileToVideoDataUrl(item.file), role: role as SeedanceMediaRole });
  }
  if (bucket.audio && inlineAudio) {
    media.push({ type: "audio_url", url: await fileToDataUrl(bucket.audio.file), role: "reference_audio" });
  }
  // 参考视频/音频也可由提交时上传后补进 content，这里先不发空壳
  const problem = validateSeedanceMedia(media, model, { allowInlineAudio: inlineAudio });
  if (problem) return problem;
  return media;
}

export async function buildKlingMedia({ spec, bucket, draft }: MediaBuildContext): Promise<KlingMediaInput[] | string> {
  const slots = spec.imageSlots;
  if (!slots.length && !spec.needsReferenceVideo) return [];
  if (!spec.imageRepeatable && slots.length && bucket.images.length < slots.length) {
    return `${spec.label}需要 ${slots.length} 张图片`;
  }
  if (!spec.imageRepeatable && bucket.images.length > slots.length) {
    return `${spec.label}最多 ${slots.length} 张图片`;
  }
  const media: KlingMediaInput[] = [];
  for (const [index, item] of bucket.images.entries()) {
    const type = spec.imageRepeatable ? slots[0] : slots[index];
    if (!type) return `${spec.label}最多 ${slots.length} 张图片`;
    media.push({ type: type as KlingMediaInput["type"], url: await fileToVideoDataUrl(item.file) });
  }
  if (spec.needsReferenceVideo) {
    if (!bucket.video) return `${spec.label}需要上传一段参考视频`;
    if (draft.orientation === "image" && bucket.video.duration > 10) return "角色朝向选「图片」时视频需 ≤10 秒";
  }
  return media;
}

export function mediaDuration(file: File, kind: "audio" | "video"): Promise<number> {
  return new Promise((resolve, reject) => {
    const media = document.createElement(kind);
    const url = URL.createObjectURL(file);
    const timeout = window.setTimeout(() => finish(new Error("读取素材时长超时")), 15000);
    function finish(error?: Error) {
      const duration = media.duration;
      window.clearTimeout(timeout);
      URL.revokeObjectURL(url);
      media.removeAttribute("src");
      if (error) reject(error); else resolve(duration);
    }
    media.preload = "metadata";
    media.onloadedmetadata = () => Number.isFinite(media.duration) ? finish() : finish(new Error("无法读取素材时长"));
    media.onerror = () => finish(new Error("无法读取素材，请检查文件格式"));
    media.src = url;
  });
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/** 视频图片沿用长边 1280 的 JPEG 预处理，为其他素材留出空间。 */
const VIDEO_IMAGE_MAX_EDGE = 1280;
const VIDEO_IMAGE_QUALITY = 0.85;
/** 小于这个体积的图原样发送，省掉一次无谓的有损重编码 */
const VIDEO_IMAGE_PASSTHROUGH_BYTES = 320 * 1024;

export async function fileToVideoDataUrl(file: File): Promise<string> {
  if (file.size <= VIDEO_IMAGE_PASSTHROUGH_BYTES) return fileToDataUrl(file);
  try {
    return await downscaleToJpeg(file);
  } catch {
    // 解码不了就退回原图，交给服务端的体积校验给出明确报错
    return fileToDataUrl(file);
  }
}

async function downscaleToJpeg(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, VIDEO_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建画布");
    // JPEG 没有透明通道，先铺白底，免得带透明度的图渲染成黑块
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", VIDEO_IMAGE_QUALITY);
  } finally {
    bitmap.close();
  }
}
