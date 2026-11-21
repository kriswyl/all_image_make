import { imageSize } from "image-size";
import { JimpMime } from "jimp";
import type { GenerationInput, VideoReferenceImageTrace } from "../shared/types.js";
import { supportsVideoReferenceImageUpload, videoReferenceImagePolicy } from "../shared/video-reference-image-policy.js";
import { buildGenerationRequest, buildWanMedia, imageDataUrl, referenceImages, RemoteApiError } from "./adapters.js";
import { AppError } from "./app-error.js";
import type { DbChannel } from "./db.js";
import type { KeyStore } from "./key-store.js";
import { uploadVideoReferenceImage } from "./reference-video.js";
import { decodeRasterImage, detectImageMime } from "./vision.js";

type ImagePolicy = NonNullable<ReturnType<typeof videoReferenceImagePolicy>>;
type SendImage = { bytes: Buffer; mime: string; width: number; height: number };
type Slot = { url: string; role: string };
type Ref = { slot: Slot; details: VideoReferenceImageTrace; image?: SendImage };
const MAX_RASTER_PIXELS = 36_000_000;
const INLINE_IMAGE = /^data:image\/[a-z0-9.+-]+;base64,/i;
const FRAME_OR_REFERENCE = new Set(["first_frame", "last_frame", "reference_image"]);

function imageSlot(media: { url: string }, role: string): Slot {
  return {
    role,
    get url() { return media.url; },
    set url(url) { media.url = url; },
  };
}

function rawImageSlots(value: unknown, roleOf: (type: unknown) => string | undefined): Slot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || !("url" in item) || typeof item.url !== "string") return [];
    const role = roleOf("type" in item ? item.type : undefined);
    return role ? [imageSlot(item as { url: string }, role)] : [];
  });
}

function klingImageRole(type: unknown) {
  if (type === "refer_image") return "reference_image";
  if (typeof type === "string" && (type === "image" || FRAME_OR_REFERENCE.has(type))) return type;
}

function videoImageSlots(adapter: DbChannel["adapterType"], input: GenerationInput): Slot[] {
  switch (adapter) {
    case "wan-video": {
      const media = buildWanMedia(input);
      // 旧调用的通用参考图也要在本地参考视频追加之前进入同一份素材数组。
      if (media.length) input.wanVideoMedia = media;
      return media.filter(({ type }) => FRAME_OR_REFERENCE.has(type)).map((item) => imageSlot(item, item.type));
    }
    case "kling-video": {
      if (Object.hasOwn(input.rawParameters ?? {}, "contents")) return rawImageSlots(input.rawParameters?.contents, klingImageRole);
      return (input.klingVideoMedia ?? []).filter(({ type }) => klingImageRole(type)).map((item) => imageSlot(item, item.type));
    }
    case "grok-video": {
      if (Object.hasOwn(input.rawParameters ?? {}, "reference_images")) return rawImageSlots(input.rawParameters?.reference_images, () => "reference_image");
      return referenceImages(input).map((image) => ({
        role: "reference_image",
        get url() { return imageDataUrl(image); },
        set url(url) {
          const comma = url.indexOf(",");
          // 普通上传的 Grok 参考图仍沿用 task input 的 PNG/JPEG/WebP 表示。
          image.mimeType = url.slice(5, url.indexOf(";")) as typeof image.mimeType;
          image.base64 = url.slice(comma + 1);
        },
      }));
    }
    case "minimax-video":
      return (input.minimaxVideoMedia ?? []).filter(({ type }) => FRAME_OR_REFERENCE.has(type)).map((item) => imageSlot(item, item.type));
    case "seedance-video":
      return (input.seedanceVideoMedia ?? []).filter(({ type }) => type === "image_url").map((item) => imageSlot(item, item.role ?? "first_frame"));
    default:
      return [];
  }
}

function readInlineImage(url: string) {
  const prefix = INLINE_IMAGE.exec(url);
  if (!prefix) return;
  const base64 = url.slice(prefix[0].length);
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length && bytes.toString("base64").replace(/=+$/, "") === base64.replace(/=+$/, "")) return bytes;
}

function imageLabel(role: string, index: number) {
  if (role === "image") return "角色图片";
  return role === "first_frame" ? "首帧图片" : role === "last_frame" ? "尾帧图片" : `参考图 ${index}`;
}

function imageError(label: string, reason: string) {
  return new AppError("REFERENCE_IMAGE_INVALID", `${label}${reason}`, 400);
}

function dataUrl(image: SendImage) {
  return `data:${image.mime};base64,${image.bytes.toString("base64")}`;
}

async function normalizeImage(bytes: Buffer, policy: ImagePolicy, label: string): Promise<SendImage> {
  const mime = detectImageMime(bytes);
  const info = (() => { try { return imageSize(bytes); } catch { return undefined; } })();
  if (!info?.width || !info.height || mime === "image/svg+xml") throw imageError(label, "无法读取，请换一张有效图片");
  const { width, height } = info;
  if (width * height > MAX_RASTER_PIXELS) throw imageError(label, `是 ${width}×${height}，像素数过大，请先等比缩小`);
  if (Math.max(width, height) / Math.min(width, height) > policy.maxAspectRatio) {
    throw imageError(label, `是 ${width}×${height}，长边不能超过短边的 ${policy.maxAspectRatio} 倍，请裁切或补边后重选`);
  }
  if (Math.min(width, height) < policy.minEdge) {
    throw imageError(label, `是 ${width}×${height}，宽和高都需至少 ${policy.minEdge} 像素`);
  }
  const raster = await decodeRasterImage(bytes);
  if (!raster) throw imageError(label, "无法解码，请转为 PNG、JPEG 或 WebP 后重选");
  const flatten = policy.opaquePng && mime === JimpMime.png && raster.hasAlpha();
  if (mime && !flatten && (mime !== "image/gif" || policy.preserveGif) && Math.max(width, height) <= policy.maxEdge && bytes.length <= policy.maxFileBytes) {
    return { bytes, mime, width: raster.width, height: raster.height };
  }
  if (Math.max(raster.width, raster.height) > policy.maxEdge) raster.scaleToFit({ w: policy.maxEdge, h: policy.maxEdge });
  if (policy.opaquePng) raster.background = 0xffffffff;
  const outputMime = !policy.opaquePng && raster.hasAlpha() ? JimpMime.png : JimpMime.jpeg;
  const output = outputMime === JimpMime.jpeg ? await raster.getBuffer(outputMime, { quality: 91 }) : await raster.getBuffer(outputMime);
  if (output.length > policy.maxFileBytes) throw imageError(label, `转码后仍超过单图 ${policy.maxFileBytes / 1_000_000} MB，请先缩小图片`);
  return { bytes: output, mime: outputMime, width: raster.width, height: raster.height };
}

async function compressImage(image: SendImage, policy: ImagePolicy, targetBytes: number) {
  if (image.mime === "image/gif") return image;
  const raster = await decodeRasterImage(image.bytes);
  if (!raster) return image;
  if (policy.opaquePng) raster.background = 0xffffffff;
  const mime = !policy.opaquePng && raster.hasAlpha() ? JimpMime.png : JimpMime.jpeg;
  const long = Math.max(raster.width, raster.height);
  const shortestLegalLong = Math.ceil(long * policy.minEdge / Math.min(raster.width, raster.height));
  let smallest = image;
  for (const [limit, quality] of [[1280, 85], [1024, 78], [768, 72], [512, 65]] as const) {
    const edge = Math.min(long, Math.max(limit, shortestLegalLong));
    if (Math.max(raster.width, raster.height) > edge) raster.scaleToFit({ w: edge, h: edge });
    const short = Math.min(raster.width, raster.height);
    if (short < policy.minEdge || Math.max(raster.width, raster.height) / short > policy.maxAspectRatio) continue;
    const bytes = mime === JimpMime.jpeg ? await raster.getBuffer(mime, { quality }) : await raster.getBuffer(mime);
    if (bytes.length < smallest.bytes.length) smallest = { bytes, mime, width: raster.width, height: raster.height };
    if (smallest.bytes.length <= targetBytes) break;
  }
  return smallest;
}

export async function prepareVideoReferenceImages(channel: DbChannel, input: GenerationInput, active: () => boolean) {
  const policy = videoReferenceImagePolicy(channel.adapterType, input.model);
  if (!policy) return;
  const slots = videoImageSlots(channel.adapterType, input);
  if (!slots.length) return;
  if (channel.adapterType === "seedance-video") {
    if (Object.hasOwn(input.rawParameters ?? {}, "content")) {
      throw new AppError("MODE_MEDIA_CONFLICT", "Seedance 同时收到了参考素材和高级参数 content，请移除高级参数中的 content", 400);
    }
    const frames = slots.map(({ role }) => role).filter((role) => role !== "reference_image");
    const hasReferences = (input.seedanceVideoMedia ?? []).some((slot) => slot.type !== "image_url" || slot.role === "reference_image");
    if (new Set(frames).size !== frames.length || (frames.length && (hasReferences || input.seedanceVideoMode === "reference"))) {
      throw new AppError("MODE_MEDIA_CONFLICT", "Seedance 首帧、尾帧与多模态参考的角色冲突，请检查素材用途", 400);
    }
  }
  const refs: Ref[] = [];
  for (const slot of slots) {
    if (!active()) return;
    const index = refs.length + 1;
    const { role } = slot;
    const details: VideoReferenceImageTrace = { index, role, transport: "url" };
    if (/^(?:https?:\/\/|asset:\/\/)/i.test(slot.url) || (channel.adapterType === "wan-video" && /^oss:\/\//i.test(slot.url))) {
      refs.push({ slot, details });
      continue;
    }
    const label = imageLabel(role, index);
    const original = readInlineImage(slot.url);
    if (!original) throw imageError(label, "不是可读取的图片或素材地址");
    const image = await normalizeImage(original, policy, label);
    if (image.bytes !== original || !slot.url.startsWith(`data:${image.mime};base64,`)) slot.url = dataUrl(image);
    Object.assign(details, {
      transport: "inline", originalBytes: original.length, fileBytes: image.bytes.length, width: image.width, height: image.height,
    });
    refs.push({ slot, image, details });
  }
  const supportsUpload = supportsVideoReferenceImageUpload(channel, input.model);
  let uploadUnavailable = false;
  const build = (key: string) => buildGenerationRequest(channel, input, key);
  return {
    async fit(key: string, sessionKeys: KeyStore, active: () => boolean, retry = false) {
      const initial = build(key);
      const before = Buffer.byteLength(JSON.stringify(initial.body));
      const images = refs.filter((ref) => ref.image && ref.details.transport === "inline")
        .sort((a, b) => b.slot.url.length - a.slot.url.length);
      const fixed = before - images.reduce((total, ref) => total + ref.slot.url.length, 0);
      // 音轨等不能改的内容单独留足。这里是主动减重的目标，渠道实际限制仍以上游为准。
      const target = Math.max(fixed + 128 * 1024, retry
        ? Math.min(policy.preferredBodyBytes, Math.floor(before / 2))
        : policy.preferredBodyBytes);
      let estimate = before;
      let changed = false;
      for (const ref of images) {
        if (!active()) return;
        if (!retry && estimate <= target) break;
        const image = ref.image!;
        const previousLength = ref.slot.url.length;
        const canUpload = supportsUpload && !uploadUnavailable && (channel.adapterType !== "minimax-video" || ref.details.role === "reference_image");
        if (canUpload) {
          try {
            const extension = image.mime === "image/jpeg" ? "jpg" : image.mime.split("/")[1];
            const url = await uploadVideoReferenceImage(channel, sessionKeys, {
              buffer: image.bytes, mimetype: image.mime, originalname: `reference-${ref.details.index}.${extension}`,
            });
            if (!active()) return;
            if (url.length >= previousLength) throw new Error("素材地址没有减小请求体");
            ref.slot.url = url;
            ref.details.transport = "uploaded";
          } catch {
            if (!active()) return;
            uploadUnavailable = true;
            ref.details.uploadFallback = true;
          }
        }
        if (ref.details.transport === "inline") {
          const bytes = Math.max(32 * 1024, Math.floor((target - estimate + previousLength) * 0.75));
          const packed = await compressImage(image, policy, retry ? Math.min(bytes, Math.floor(image.bytes.length / 2)) : bytes);
          if (packed !== image) {
            ref.image = packed;
            ref.slot.url = dataUrl(packed);
            Object.assign(ref.details, { fileBytes: packed.bytes.length, width: packed.width, height: packed.height });
          }
        }
        estimate += ref.slot.url.length - previousLength;
        changed ||= ref.slot.url.length < previousLength;
      }
      if (!active()) return;
      if (retry && !changed) return;
      const request = changed ? build(key) : initial;
      const after = Buffer.byteLength(JSON.stringify(request.body));
      if (retry && after >= before) return;
      return {
        request,
        trace: { beforeBytes: before, requestBytes: after, images: refs.map(({ details }) => ({ ...details })) },
      };
    },
  };
}

/** 只认明确发生在读取请求体阶段的体积拒绝。其他错误可能已经建单。 */
export function isVideoBodySizeRejection(error: unknown) {
  if (!(error instanceof RemoteApiError) || (error.status !== 413 && error.status !== 400)) return false;
  function inspect(value: unknown, depth = 0): { task: boolean; tooLarge: boolean } {
    if (depth > 5) return { task: false, tooLarge: false };
    if (typeof value === "string") {
      const text = value.trim();
      if (text.startsWith("{")) {
        try { return inspect(JSON.parse(text), depth + 1); } catch { /* 普通文本 */ }
      }
      return { task: false, tooLarge: /^read request body failed:\s*http:\s*request body too large\.?$/i.test(text) };
    }
    if (!value || typeof value !== "object") return { task: false, tooLarge: false };
    const record = value as Record<string, unknown>;
    const parts = ["data", "output", "result", "error", "message"].map((key) => inspect(record[key], depth + 1));
    return {
      task: ["id", "task_id", "taskId"].some((key) => Boolean(record[key])) ||
        /^(queued|submitted|pending|running|succeeded|completed)$/i.test(String(record.status ?? record.task_status ?? "")) ||
        parts.some((part) => part.task),
      tooLarge: parts.some((part) => part.tooLarge),
    };
  }
  const result = inspect(error.payload);
  return !result.task && (error.status === 413 || result.tooLarge);
}
