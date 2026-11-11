import fs from "node:fs/promises";
import path from "node:path";
import { MAX_MASK_IMAGE_BYTES, MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES, type GenerationInput, type MaskImageInput, type ReferenceImageInput } from "../shared/types.js";
import type { DbChannel } from "./db.js";
import { AppError } from "./app-error.js";
import { safeFileName } from "./security.js";
import { validateReferenceMedia, type ReferenceMediaUpload, type ReferenceVideoUpload } from "./reference-video.js";
import { audioExtension, extensionForMime, matchesImageSignature } from "./task-media.js";
import { assertVideoModeRequest } from "./video-mode-guard.js";

interface StoredReferenceImage extends Omit<ReferenceImageInput, "base64"> {
  relativePath: string;
  byteSize: number;
}

interface StoredMaskImage {
  fileName: string;
  mimeType: "image/png";
  relativePath: string;
  byteSize: number;
}

export interface StoredGenerationInput extends Omit<GenerationInput, "referenceImage" | "referenceImages" | "maskImage"> {
  referenceImage?: StoredReferenceImage;
  referenceImages?: StoredReferenceImage[];
  maskImage?: StoredMaskImage;
  /** 旧任务只有一段，读的时候和 referenceVideos 合并处理 */
  referenceVideo?: { relativePath: string; mimeType: string; fileName: string };
  /** Seedance 参考视频可以有多段（2.0 三段、2.5 十段） */
  referenceVideos?: Array<{ relativePath: string; mimeType: string; fileName: string }>;
  /** Seedance 参考音频：和图床视频一样先落盘，提交前再上传换公网地址。 */
  referenceAudio?: { relativePath: string; mimeType: string; fileName: string };
  referenceAudios?: Array<{ relativePath: string; mimeType: string; fileName: string }>;
}

export interface ReferenceImageUpload {
  bytes: Buffer;
  mimeType: ReferenceImageInput["mimeType"];
  fileName: string;
}

/** 局部重绘蒙版的上传形态：和参考图一样按字节进、按相对路径落盘 */
export interface MaskImageUpload {
  bytes: Buffer;
  mimeType: "image/png";
  fileName: string;
}

interface ReferenceUploads {
  images: ReferenceImageUpload[];
  mask?: MaskImageUpload;
  videos: ReferenceVideoUpload[];
  audios: ReferenceMediaUpload[];
}

export class TaskInputFiles {
  constructor(private readonly inputsDir: string) {}

  async persist(id: string, input: GenerationInput, channel: DbChannel, uploads: ReferenceUploads) {
    const { images, mask: maskUpload, videos: videoUploads, audios: audioUploads } = uploads;
    const sources = images.length ? images : referenceInputs(input).map((image) => ({
      bytes: Buffer.from(image.base64, "base64"), mimeType: image.mimeType, fileName: image.fileName,
    }));
    /**
     * 蒙版可以来自 multipart 上传，也可以来自重试时 hydrate 回 base64 的 `input.maskImage`。
     * 校验放在落盘之前：非法蒙版不该留下已经写好的参考图文件。
     */
    const maskSource: MaskImageUpload | undefined = maskUpload ?? (input.maskImage ? {
      bytes: Buffer.from(input.maskImage.base64, "base64"),
      mimeType: "image/png",
      fileName: input.maskImage.fileName,
    } : undefined);
    if (maskSource) {
      if (channel.adapterType !== "openai-images") {
        throw new AppError("MASK_UNSUPPORTED_ADAPTER", "局部重绘只支持 OpenAI Images 协议的渠道（gpt / gpt-c 生图）", 400);
      }
      if (!sources.length) {
        throw new AppError("MASK_REQUIRES_REFERENCE_IMAGE", "局部重绘需要先添加 1 张参考图作为底图", 400);
      }
      if (sources.length !== 1) {
        throw new AppError("MASK_REFERENCE_COUNT", `局部重绘只支持 1 张参考图（当前 ${sources.length} 张）`, 400);
      }
      if (!maskSource.bytes.length || maskSource.bytes.length > MAX_MASK_IMAGE_BYTES || !matchesImageSignature(maskSource.bytes, "image/png")) {
        throw new AppError("MASK_INVALID", "蒙版必须是有效的 PNG 图片，且不能超过 20 MB（透明区域表示要重绘的部分）", 400);
      }
    }
    if (videoUploads.length) {
      for (const upload of videoUploads) validateReferenceMedia(upload, "video");
      const wanMode = input.wanVideoMode;
      const wan = channel.adapterType === "wan-video" && (wanMode === "reference" || wanMode === "video-edit" || wanMode === "video-extend");
      const kling = channel.adapterType === "kling-video" && input.klingVideoMode === "motion-control";
      // Seedance 只有「参考生视频」模式接受参考视频；首帧/首尾帧是图片槽位，塞视频会被上游忽略。
      const seedance = channel.adapterType === "seedance-video" && input.seedanceVideoMode === "reference";
      if (!wan && !kling && !seedance) throw new AppError("REFERENCE_VIDEO_UNSUPPORTED", "当前渠道或模式不支持本地参考视频", 400);
      if (!channel.uploadEndpoint) throw new AppError("UPLOAD_UNSUPPORTED", "该渠道未配置视频上传服务", 400);
      if (input.wanVideoMedia?.some((item) => item.type === "reference_video")
        || input.klingVideoMedia?.some((item) => item.type === "video")
        || input.seedanceVideoMedia?.some((item) => item.type === "video_url")) {
        throw new AppError("REFERENCE_VIDEO_CONFLICT", "本地参考视频和视频链接只能选择一种", 400);
      }
    }
    if (audioUploads.length) {
      for (const upload of audioUploads) validateReferenceMedia(upload, "audio");
      if (channel.adapterType !== "seedance-video" || input.seedanceVideoMode !== "reference") {
        throw new AppError("REFERENCE_AUDIO_UNSUPPORTED", "只有 Seedance 的参考生视频支持本地参考音频", 400);
      }
      if (!channel.uploadEndpoint) throw new AppError("UPLOAD_UNSUPPORTED", "该渠道未配置素材上传服务，无法上传音频", 400);
      if (input.seedanceVideoMedia?.some((item) => item.type === "audio_url")) {
        throw new AppError("REFERENCE_AUDIO_CONFLICT", "本地参考音频和音频链接只能选择一种", 400);
      }
    }
    // 模式与素材的服务端复核：界面只渲染渠道支持的模式，但接口不能只信界面
    assertVideoModeRequest(channel, input, {
      referenceVideoUploads: videoUploads.length,
      referenceAudioUploads: audioUploads.length,
    });
    const storedInput = await this.persistInputImages(id, input, sources, maskSource);
    // 每段一个文件：`-reference-1.mp4`、`-reference-2.mp4`，重试时按序号还原顺序
    const videoPaths = videoUploads.map((upload, index) => path.join(
      this.inputsDir,
      `${id}-reference-${index + 1}.${upload.mimetype === "video/quicktime" ? "mov" : "mp4"}`,
    ));
    const audioPaths = audioUploads.map((upload, index) => path.join(
      this.inputsDir,
      `${id}-reference-audio-${index + 1}.${audioExtension(upload.mimetype)}`,
    ));
    const rollback = async () => {
      const paths = [...(storedInput.referenceImages ?? []), ...(storedInput.maskImage ? [storedInput.maskImage] : [])]
        .map((file) => path.join(this.inputsDir, file.relativePath));
      paths.push(...videoPaths, ...audioPaths);
      await Promise.allSettled(paths.map((file) => fs.rm(file, { force: true })));
    };
    try {
      storedInput.referenceVideos = [];
      storedInput.referenceAudios = [];
      for (const [index, upload] of videoUploads.entries()) {
        const target = videoPaths[index]!;
        await fs.writeFile(target, upload.buffer, { flag: "wx" });
        storedInput.referenceVideos.push({ relativePath: path.basename(target), mimeType: upload.mimetype, fileName: safeFileName(upload.originalname) });
      }
      for (const [index, upload] of audioUploads.entries()) {
        const target = audioPaths[index]!;
        await fs.writeFile(target, upload.buffer, { flag: "wx" });
        storedInput.referenceAudios.push({ relativePath: path.basename(target), mimeType: upload.mimetype, fileName: safeFileName(upload.originalname) });
      }
    } catch (error) {
      await rollback();
      throw error;
    }
    return { input: storedInput, rollback };
  }

  async restore(stored: StoredGenerationInput) {
    const { referenceVideo, referenceVideos, referenceAudio, referenceAudios, ...images } = stored;
    const input = await this.hydrateInputImages(images);
    // 旧任务只有 referenceVideo / referenceAudio 单段字段，读的时候折算成数组
    const storedVideos = referenceVideos?.length ? referenceVideos : referenceVideo ? [referenceVideo] : [];
    const storedAudios = referenceAudios?.length ? referenceAudios : referenceAudio ? [referenceAudio] : [];
    return { input, videos: storedVideos, audios: storedAudios };
  }

  async readReferenceVideo(file: NonNullable<StoredGenerationInput["referenceVideo"]>): Promise<ReferenceVideoUpload> {
    if (!/^[a-f0-9-]{36}-reference(-\d+)?\.(mp4|mov)$/i.test(file.relativePath)) throw new AppError("REFERENCE_VIDEO_INVALID", "参考视频路径无效", 400);
    const fullPath = path.join(this.inputsDir, file.relativePath);
    const stat = await fs.lstat(fullPath).catch(() => null);
    if (!stat?.isFile() || stat.size > 100 * 1024 * 1024) throw new AppError("REFERENCE_VIDEO_MISSING", "找不到本地参考视频，请重新选择原视频", 400);
    return { buffer: await fs.readFile(fullPath), mimetype: file.mimeType, originalname: file.fileName };
  }

  async readReferenceAudio(file: NonNullable<StoredGenerationInput["referenceAudio"]>): Promise<ReferenceMediaUpload> {
    if (!/^[a-f0-9-]{36}-reference-audio(-\d+)?\.(mp3|m4a|aac|wav)$/i.test(file.relativePath)) throw new AppError("REFERENCE_AUDIO_INVALID", "参考音频路径无效", 400);
    const fullPath = path.join(this.inputsDir, file.relativePath);
    const stat = await fs.lstat(fullPath).catch(() => null);
    if (!stat?.isFile() || stat.size > 15 * 1024 * 1024) throw new AppError("REFERENCE_AUDIO_MISSING", "找不到本地参考音频，请重新选择原文件", 400);
    return { buffer: await fs.readFile(fullPath), mimetype: file.mimeType, originalname: file.fileName };
  }

  private async persistInputImages(
    taskId: string,
    input: GenerationInput,
    sources: ReferenceImageUpload[],
    maskSource?: MaskImageUpload,
  ): Promise<StoredGenerationInput> {
    if (!sources.length && !maskSource) {
      return { ...input, referenceImage: undefined, referenceImages: undefined, maskImage: undefined };
    }
    // 上限取常量而不是写死 8：画布（最多 MAX_CANVAS_IMAGES 张）整组都会走到这里，
    // 两处写死两个 8 的话，改一处就会出现「前端让选 12 张、这里按 8 张拒收」
    if (sources.length > MAX_REFERENCE_IMAGES) {
      throw new AppError("REFERENCE_IMAGE_LIMIT", `参考图最多上传 ${MAX_REFERENCE_IMAGES} 张`, 400);
    }
    for (const source of sources) {
      if (!source.bytes.length || source.bytes.length > MAX_REFERENCE_IMAGE_BYTES) {
        throw new AppError("REFERENCE_IMAGE_TOO_LARGE", "单张参考图不能超过 20 MB", 400);
      }
      if (!matchesImageSignature(source.bytes, source.mimeType)) {
        throw new AppError("REFERENCE_IMAGE_INVALID", "参考图格式与文件内容不匹配", 400);
      }
    }
    // 蒙版也要在写第一张参考图之前验完，否则一张坏蒙版会留下孤儿参考图文件
    if (maskSource && (!maskSource.bytes.length || maskSource.bytes.length > MAX_MASK_IMAGE_BYTES || !matchesImageSignature(maskSource.bytes, "image/png"))) {
      throw new AppError("MASK_INVALID", "蒙版必须是有效的 PNG 图片，且不能超过 20 MB（透明区域表示要重绘的部分）", 400);
    }
    const storedImages: StoredReferenceImage[] = [];
    for (const [index, source] of sources.entries()) {
      const extension = extensionForMime(source.mimeType);
      const relativePath = safeFileName(`${taskId}-${index + 1}.${extension}`);
      const originalName = safeFileName(source.fileName);
      const stem = originalName.replace(/\.[^.]+$/, "").slice(0, 80) || `reference-${index + 1}`;
      await fs.writeFile(path.join(this.inputsDir, relativePath), source.bytes);
      storedImages.push({ fileName: `${stem}.${extension}`, mimeType: source.mimeType, relativePath, byteSize: source.bytes.length });
    }
    let storedMask: StoredMaskImage | undefined;
    if (maskSource) {
      // 固定用 taskId-mask.png，和参考图的 taskId-1.png 不会撞名
      const relativePath = safeFileName(`${taskId}-mask.png`);
      await fs.writeFile(path.join(this.inputsDir, relativePath), maskSource.bytes);
      const originalName = safeFileName(maskSource.fileName) || "mask.png";
      storedMask = {
        fileName: originalName.toLowerCase().endsWith(".png") ? originalName : `${originalName}.png`,
        mimeType: "image/png",
        relativePath,
        byteSize: maskSource.bytes.length,
      };
    }
    return {
      ...input,
      referenceImage: undefined,
      referenceImages: storedImages.length ? storedImages : undefined,
      maskImage: storedMask,
    };
  }

  private async hydrateInputImages(input: StoredGenerationInput): Promise<GenerationInput> {
    const storedImages = input.referenceImages?.length ? input.referenceImages : input.referenceImage ? [input.referenceImage] : [];
    const hydratedImages: ReferenceImageInput[] = [];
    for (const image of storedImages) {
      const absolutePath = path.resolve(this.inputsDir, image.relativePath);
      if (!absolutePath.startsWith(path.resolve(this.inputsDir) + path.sep)) {
        throw new AppError("REFERENCE_IMAGE_INVALID", "参考图路径无效", 400);
      }
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(absolutePath);
      } catch {
        throw new AppError("REFERENCE_IMAGE_MISSING", "参考图文件不存在，请重新上传", 400);
      }
      if (!bytes.length || bytes.length > MAX_REFERENCE_IMAGE_BYTES || !matchesImageSignature(bytes, image.mimeType)) {
        throw new AppError("REFERENCE_IMAGE_INVALID", "参考图文件无效", 400);
      }
      hydratedImages.push({ base64: bytes.toString("base64"), mimeType: image.mimeType, fileName: image.fileName });
    }
    let hydratedMask: MaskImageInput | undefined;
    if (input.maskImage) {
      const absolutePath = path.resolve(this.inputsDir, input.maskImage.relativePath);
      if (!absolutePath.startsWith(path.resolve(this.inputsDir) + path.sep)) {
        throw new AppError("MASK_INVALID", "蒙版路径无效", 400);
      }
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(absolutePath);
      } catch {
        throw new AppError("MASK_IMAGE_MISSING", "蒙版文件不存在，请重新绘制", 400);
      }
      if (!bytes.length || bytes.length > MAX_MASK_IMAGE_BYTES || !matchesImageSignature(bytes, "image/png")) {
        throw new AppError("MASK_INVALID", "蒙版文件无效或超过 20 MB，请重新绘制", 400);
      }
      hydratedMask = { base64: bytes.toString("base64"), mimeType: "image/png", fileName: input.maskImage.fileName };
    }
    return {
      ...input,
      referenceImage: undefined,
      referenceImages: hydratedImages.length ? hydratedImages : undefined,
      maskImage: hydratedMask,
    };
  }
}

function referenceInputs(input: GenerationInput) {
  return input.referenceImages?.length ? input.referenceImages : input.referenceImage ? [input.referenceImage] : [];
}
