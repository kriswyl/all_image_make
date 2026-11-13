import multer from "multer";
import { z } from "zod";
import { taskKindFor } from "../../shared/kinds.js";
import { imageOutputFormatSchema, MAX_FRAME_COUNT, MAX_FRAME_DURATION_MS, MIN_FRAME_COUNT, MIN_FRAME_DURATION_MS } from "../../shared/image-formats.js";
import type { GenerationInput } from "../../shared/types.js";
import { MAX_REFERENCE_IMAGES, MAX_VIDEO_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES } from "../../shared/types.js";
import type { AppDatabase } from "../db.js";
import type { KeyStore } from "../key-store.js";
import { referenceMediaKindOf } from "../reference-video.js";
import { AppError, type TaskRunner, type MaskImageUpload, type ReferenceImageUpload } from "../tasks.js";
import { midjourneyModelForCustomId } from "../../shared/midjourney.js";
import { detachAssetFromBoards } from "../board.js";
import { referenceImageMimeTypes, referenceVideoUpload } from "./uploads.js";
import { removeStoredFiles } from "./files.js";
import { ok, fail, asyncHandler, routeParam } from "./http.js";
import type { Express } from "express";

const MAX_REFERENCE_BASE64_CHARS = Math.ceil(MAX_REFERENCE_IMAGE_BYTES / 3) * 4;

/** 单个 media URL 的上限：图片 data URI 按 20MB 原始体积 base64 后约 27M 字符 */
const MAX_MEDIA_URL_CHARS = 28_000_000;

const referenceUpload = multer({
  storage: multer.memoryStorage(),
  // 8 张参考图 + 1 张局部重绘蒙版；payload 仍是唯一一个文本字段
  limits: { fileSize: MAX_REFERENCE_IMAGE_BYTES + 1, files: MAX_REFERENCE_IMAGES + 1, fields: 1 },
  fileFilter: (_req, file, callback) => {
    if (file.fieldname === "mask") {
      return file.mimetype === "image/png"
        ? callback(null, true)
        : callback(new AppError("MASK_INVALID", "蒙版必须是 PNG 图片（透明区域表示要重绘的部分）", 400));
    }
    return referenceImageMimeTypes.includes(file.mimetype as typeof referenceImageMimeTypes[number])
      ? callback(null, true)
      : callback(new AppError("REFERENCE_IMAGE_INVALID", "仅支持 PNG、JPEG 或 WebP 参考图", 400));
  },
});

/**
 * 参考素材（视频 + 音频）一次提交：Seedance 的参考生视频两个都可能要。
 * 音频上限在 `validateReferenceMedia` 里按 15 MB 卡，这里只放到视频的 100 MB。
 * 类型判定走 `referenceMediaKindOf`（扩展名优先），不然空 MIME 的 `.m4a` 会
 * 以 application/octet-stream 进来被误拒。
 */
const referenceMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 + 1, fieldSize: 16 * 1024 * 1024, files: 20, fields: 1 },
  fileFilter: (_req, file, callback) => referenceMediaKindOf(file)
    ? callback(null, true) : callback(new AppError("REFERENCE_MEDIA_INVALID", "仅支持 MP4 / MOV 视频与 MP3 / M4A / AAC / WAV 音频", 400)),
});

const midjourneyActionSchema = z.object({
  customId: z.string().trim().min(1).max(500),
  label: z.string().trim().max(40).optional(),
});

const generationSchema = z.object({
  channelId: z.string().uuid(),
  model: z.string().trim().min(1).max(200),
  // 音效 / 混音允许空 prompt；其余生成在路由里再补一次非空校验
  prompt: z.string().trim().max(20000),
  referenceImage: z.object({
    base64: z.string().min(4).max(MAX_REFERENCE_BASE64_CHARS).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    mimeType: z.enum(referenceImageMimeTypes),
    fileName: z.string().trim().min(1).max(200),
  }).optional(),
  referenceImages: z.array(z.object({
    base64: z.string().min(4).max(MAX_REFERENCE_BASE64_CHARS).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    mimeType: z.enum(referenceImageMimeTypes),
    fileName: z.string().trim().min(1).max(200),
  })).max(MAX_VIDEO_REFERENCE_IMAGES).optional(),
  /**
   * 局部重绘蒙版（JSON 入口）。文件上传走 multipart 的 `mask` 字段；
   * 这里留着是为了 zod 不把 JSON 调用方的蒙版静默剥掉。mimeType 只认 PNG。
   */
  maskImage: z.object({
    base64: z.string().min(4).max(MAX_REFERENCE_BASE64_CHARS).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    mimeType: z.literal("image/png"),
    fileName: z.string().trim().min(1).max(200),
  }).optional(),
  negativePrompt: z.string().max(10000).optional(),
  size: z.string().max(60).optional(),
  aspectRatio: z.string().max(20).optional(),
  count: z.number().int().min(1).max(8).optional(),
  quality: z.string().max(60).optional(),
  outputFormat: imageOutputFormatSchema.optional(),
  frameCount: z.number().int().min(MIN_FRAME_COUNT).max(MAX_FRAME_COUNT).optional(),
  frameDurationMs: z.number().int().min(MIN_FRAME_DURATION_MS).max(MAX_FRAME_DURATION_MS).optional(),
  background: z.enum(["auto", "opaque", "transparent"]).optional(),
  moderation: z.enum(["auto", "low"]).optional(),
  style: z.enum(["auto", "vivid", "natural"]).optional(),
  responseFormat: z.enum(["auto", "url", "b64_json"]).optional(),
  stream: z.boolean().optional(),
  imageSize: z.string().max(10).optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().min(1).max(100).optional(),
  maxOutputTokens: z.number().int().min(1).max(32768).optional(),
  responseModalities: z.array(z.enum(["TEXT", "IMAGE"])).max(2).optional(),
  seed: z.number().int().min(0).max(2147483647).optional(),
  // Video generation parameters
  duration: z.number().int().min(-1).max(30).optional(),
  resolution: z.string().max(10).optional(),
  ratio: z.string().max(10).optional(),
  audio: z.boolean().optional(),
  promptExtend: z.boolean().optional(),
  watermark: z.boolean().optional(),
  wanVideoMode: z.enum([
    "text-to-video",
    "first-frame",
    "first-last-frame",
    "reference",
    "video-edit",
    "video-extend",
    "file-to-video",
  ]).optional(),
  wanVideoMedia: z.array(z.object({
    type: z.enum([
      "first_frame",
      "last_frame",
      "reference_image",
      "reference_video",
      "reference_audio",
      "file",
      "link",
    ]),
    // 图片和音频支持 data URI，视频走公网或 oss 地址。
    url: z.string().min(1).max(MAX_MEDIA_URL_CHARS),
  })).max(20).optional(),
  seedanceVideoMode: z.enum([
    "text-to-video",
    "first-frame",
    "first-last-frame",
    "reference",
  ]).optional(),
  // Music generation parameters (Suno)
  musicMode: z.enum(["inspiration", "custom", "cover", "mashup", "sound", "playlist", "sample"]).optional(),
  musicTitle: z.string().trim().max(80).optional(),
  musicTags: z.string().trim().max(1000).optional(),
  musicNegativeTags: z.string().trim().max(1000).optional(),
  musicInstrumental: z.boolean().optional(),
  musicVersion: z.string().trim().max(40).optional(),
  musicTargetDuration: z.union([z.literal(45), z.literal(60)]).optional(),
  musicStyleWeight: z.number().min(0).max(1).optional(),
  musicWeirdness: z.number().min(0).max(1).optional(),
  musicCoverClipId: z.string().trim().max(100).optional(),
  musicMashupClipIds: z.array(z.string().trim().min(1).max(100)).max(2).optional(),
  musicSoundConfigs: z.object({
    tempo: z.number().int().min(20).max(300).optional(),
    key: z.string().trim().max(10).optional(),
    loop: z.boolean().optional(),
  }).optional(),
  midjourneyVersion: z.string().trim().max(20).optional(),
  ttsVoice: z.string().trim().max(40).optional(),
  ttsStyle: z.string().trim().max(200).optional(),
  ttsLanguage: z.string().trim().max(20).optional(),
  ttsSpeakers: z.array(z.object({
    speaker: z.string().trim().min(1).max(10),
    voice: z.string().trim().min(1).max(40),
  })).length(2).optional(),
  klingVideoMedia: z.array(z.object({
    type: z.enum(["first_frame", "last_frame", "reference_image", "image", "video"]),
    url: z.string().min(1).max(MAX_MEDIA_URL_CHARS),
  })).max(10).optional(),
  klingVideoMode: z.enum(["text-to-video", "first-frame", "first-last-frame", "reference", "motion-control"]).optional(),
  klingCharacterOrientation: z.enum(["image", "video"]).optional(),
  klingMultiShot: z.boolean().optional(),
  seedanceVideoMedia: z.array(z.object({
    type: z.enum(["image_url", "video_url", "audio_url"]),
    url: z.string().min(1).max(MAX_MEDIA_URL_CHARS),
    role: z.enum([
      "first_frame",
      "last_frame",
      "reference_image",
      "reference_video",
      "reference_audio",
    ]).optional(),
  })).max(50).optional(),
  timeoutMs: z.number().int().min(10_000).max(1_800_000).optional(),
  rawParameters: z.record(z.string(), z.unknown()).optional(),
});

export function registerGenerationRoutes(app: Express, db: AppDatabase, runner: TaskRunner, sessionKeys: KeyStore) {
  app.post("/api/generations/reference-video", referenceVideoUpload.single("file"), asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError("UPLOAD_EMPTY", "没有收到视频文件", 400);
    let body: unknown;
    try { body = JSON.parse(req.body.payload); }
    catch { throw new AppError("INVALID_INPUT", "生成参数不是有效的 JSON", 400); }
    const input = generationSchema.parse(body);
    const task = await runner.create({ ...input, referenceVideoUpload: req.file });
    res.status(202).json(ok(task));
  }));

  /**
   * 参考素材一次提交：Seedance 参考生视频可以同时带多段视频与音频
   * （2.0 各 3 段、2.5 各 10 段，真正的上限在 `assertVideoModeRequest` 里按模型卡）。
   * 上传（图床）在任务执行时做，和万相/可灵同一条链路——本地文件不直接进请求体。
   */
  app.post("/api/generations/reference-media", referenceMediaUpload.fields([
    { name: "video", maxCount: 10 },
    { name: "audio", maxCount: 10 },
  ]), asyncHandler(async (req, res) => {
    const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
    const videos = files.video ?? [];
    const audios = files.audio ?? [];
    if (!videos.length && !audios.length) throw new AppError("UPLOAD_EMPTY", "没有收到参考素材", 400);
    let body: unknown;
    try { body = JSON.parse(req.body.payload); }
    catch { throw new AppError("INVALID_INPUT", "生成参数不是有效的 JSON", 400); }
    const input = generationSchema.parse(body);
    const task = await runner.create({
      ...input,
      referenceVideoUploads: videos,
      referenceAudioUploads: audios,
    });
    res.status(202).json(ok(task));
  }));

  app.post("/api/generations", referenceUpload.fields([
    { name: "referenceImages", maxCount: MAX_VIDEO_REFERENCE_IMAGES },
    { name: "mask", maxCount: 1 },
  ]), asyncHandler(async (req, res) => {
      const files = Array.isArray(req.files) || !req.files ? {} : req.files as Record<string, Express.Multer.File[]>;
      const uploadedFiles = files.referenceImages ?? [];
      const maskFiles = files.mask ?? [];
      let body = req.body;
      if (typeof req.body.payload === "string") {
        try { body = JSON.parse(req.body.payload); }
        catch { throw new AppError("INVALID_INPUT", "生成参数不是有效的 JSON", 400); }
      }
      const uploadedImages: ReferenceImageUpload[] = uploadedFiles.map((file) => ({
        bytes: file.buffer,
        mimeType: file.mimetype as ReferenceImageUpload["mimeType"],
        fileName: file.originalname,
      }));
      const maskUpload: MaskImageUpload | undefined = maskFiles[0] ? {
        bytes: maskFiles[0].buffer,
        mimeType: "image/png",
        fileName: maskFiles[0].originalname,
      } : undefined;
      const input = generationSchema.parse({
        ...body,
        ...(uploadedImages.length ? { referenceImages: undefined, referenceImage: undefined } : {}),
        ...(maskUpload ? { maskImage: undefined } : {}),
      }) as GenerationInput;
      if (!input.prompt.trim() && input.musicMode !== "sound" && input.musicMode !== "mashup") {
        throw new AppError("INVALID_INPUT", "提示词不能为空", 400);
      }
      const task = await runner.create(input, uploadedImages, maskUpload);
      res.status(202).json(ok(task));
  }));

  app.get("/api/library", (req, res) => {
    const includeChat = req.query.includeChat === "1" ? "all" : req.query.includeChatImages === "1" ? "image" : undefined;
    if (req.query.limit === undefined) return res.json(ok(db.listLibraryTaskViews(includeChat
      ? { limit: -1, offset: 0, query: "", kind: "all", mode: "all", includeChat }
      : undefined)));
    const limit = Math.max(1, Math.min(100, Math.floor(Number(req.query.limit) || 60)));
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    const kind = req.query.kind === "image" || req.query.kind === "video" || req.query.kind === "audio" ? req.query.kind : "all";
    const mode = req.query.mode === "assets" || req.query.mode === "records" ? req.query.mode : "all";
    const items = db.listLibraryTaskViews({ limit: limit + 1, offset, query: String(req.query.q ?? "").slice(0, 200), kind, mode, includeChat });
    res.json(ok({ items: items.slice(0, limit), hasMore: items.length > limit }));
  });

  app.post("/api/generations/batch-delete", asyncHandler(async (req, res) => {
    const input = z.object({ ids: z.array(z.string().min(1).max(80)).max(50000), keepFiles: z.boolean().default(false) }).parse(req.body);
    const ids = [...new Set(input.ids)].filter((id) => db.getTaskRow(id));
    if (ids.some((id) => db.taskHasStoryboardProjectReferences(id))) throw new AppError("ASSET_SHARED", "所选记录包含分镜设定正在使用的参考图，请先解除绑定。", 409);
    if (ids.some((id) => db.taskHasConversationReferences(id))) throw new AppError("ASSET_SHARED", "所选记录中有素材仍被对话引用，请先解除引用后再删除。", 409);
    for (const id of ids) for (const asset of db.listAssets(id)) detachAssetFromBoards(db, asset.id);
    const removed = db.deleteTasks(ids, { keepFiles: input.keepFiles });
    await removeStoredFiles(removed.assets, removed.inputs, db.inputsDir);
    res.json(ok({ deleted: removed.deleted.length, keepFiles: input.keepFiles }));
  }));

  app.get("/api/generations", (req, res) => {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 40)));
    res.json(ok(db.listTaskViews(limit)));
  });

  // 素材管理订阅公共任务和普通对话生成，工作台订阅公共任务。
  app.get("/api/generations/events", (req, res) => {
    const chatImagesOnly = req.query.scope === "chat-images";
    const includeChat = req.query.scope === "library" || chatImagesOnly;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(":ok\n\n");
    const unsubscribe = runner.onTaskEvent((event) => {
      const task = db.getTaskRow(event.task.id);
      const chatTask = includeChat && task?.libraryScope === "conversation" && task.origin === "generate"
        && task.ownerConversationId && db.getConversation(task.ownerConversationId)?.kind === "chat";
      const showChat = chatTask && (!chatImagesOnly
        || taskKindFor(task.channelAdapterType ?? undefined, event.task.assets.map(asset => asset.mimeType)) === "image");
      if (showChat || (!chatImagesOnly && task?.libraryScope === "public")) {
        res.write(`data: ${JSON.stringify(event.task)}\n\n`);
      }
    });
    const heartbeat = setInterval(() => res.write(":ping\n\n"), 15000);
    const close = () => { clearInterval(heartbeat); unsubscribe(); };
    req.on("close", close);
    req.on("error", close);
  });

  app.get("/api/generations/:id", (req, res) => {
    const task = db.getTaskView(routeParam(req.params.id));
    if (!task) return res.status(404).json(fail("TASK_NOT_FOUND", "任务不存在"));
    res.json(ok(task));
  });

  app.post("/api/generations/:id/cancel", (req, res, next) => {
    try { res.json(ok(runner.cancel(routeParam(req.params.id)))); } catch (error) { next(error); }
  });

  app.post("/api/generations/:id/retry", asyncHandler(async (req, res) => {
    res.status(202).json(ok(await runner.retry(routeParam(req.params.id))));
  }));

  app.post("/api/generations/:id/continue-query", (req, res) => {
    res.status(202).json(ok(runner.continuePolling(routeParam(req.params.id))));
  });

  /**
   * Midjourney 的后续动作：把结果卡片上的 U1 / V2 / 重绘按钮变成一条新任务。
   * customId 是上游任务的按钮凭证，不能由前端自己拼；只接受父任务成功后的按钮。
   */
  app.post("/api/generations/:id/action", asyncHandler(async (req, res) => {
    const parent = db.getTaskRow(routeParam(req.params.id));
    if (!parent) return res.status(404).json(fail("TASK_NOT_FOUND", "任务不存在"));
    const channel = db.getChannel(parent.channelId);
    if (!channel || channel.adapterType !== "midjourney") {
      return res.status(400).json(fail("NOT_MIDJOURNEY_TASK", "这不是 Midjourney 任务"));
    }
    if (parent.status !== "succeeded") {
      return res.status(409).json(fail("TASK_NOT_READY", "任务还没有成功完成"));
    }
    if (!parent.remoteTaskId) {
      return res.status(409).json(fail("REMOTE_TASK_MISSING", "这个任务没有上游任务 id，不能继续操作"));
    }
    const input = midjourneyActionSchema.parse(req.body ?? {});
    const model = midjourneyModelForCustomId(input.customId, input.label);
    if (!model) return res.status(400).json(fail("MJ_ACTION_UNKNOWN", "这个 Midjourney 按钮需要额外输入，暂不支持"));
    // 只接受父任务里真实出现过的按钮，不让前端自己拼 customId
    let buttons: Array<{ customId?: unknown }> = [];
    try {
      const meta = parent.remoteMeta ? JSON.parse(parent.remoteMeta) as Record<string, unknown> : {};
      const midjourney = meta.midjourney as Record<string, unknown> | undefined;
      if (Array.isArray(midjourney?.buttons)) buttons = midjourney.buttons as Array<{ customId?: unknown }>;
    } catch {
      buttons = [];
    }
    if (!buttons.some((button) => button.customId === input.customId)) {
      return res.status(400).json(fail("MJ_ACTION_INVALID", "这个按钮不属于该 Midjourney 任务"));
    }
    const task = await runner.create({
      channelId: channel.id,
      model,
      prompt: input.label?.trim() || "Midjourney 后续操作",
      midjourneyAction: {
        taskId: parent.remoteTaskId,
        customId: input.customId,
        ...(input.label?.trim() ? { label: input.label.trim() } : {}),
      },
      timeoutMs: 180_000,
    }, [], undefined, parent.libraryScope === "conversation" || (parent.libraryScope === "legacy" && db.taskHasConversationReferences(parent.id)) ? "conversation" : "public", parent.ownerConversationId ?? undefined);
    res.status(202).json(ok(task));
  }));

  app.get("/api/generations/:id/diagnostics", (req, res) => {
    const id = routeParam(req.params.id);
    if (!db.getTaskRow(id)) return res.status(404).json(fail("TASK_NOT_FOUND", "任务不存在"));
    res.json(ok(db.listDiagnostics(id)));
  });

  /** keepFiles=1 只删记录、保留磁盘上的图片视频，用户可能只是想清列表 */
  app.delete("/api/generations/:id", asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    if (!db.getTaskRow(id)) return res.status(404).json(fail("TASK_NOT_FOUND", "任务不存在"));
    const keepFiles = req.query.keepFiles === "1";
    if (db.taskHasStoryboardProjectReferences(id)) throw new AppError("ASSET_SHARED", "该记录包含分镜设定正在使用的参考图，请先解除绑定。", 409);
    if (db.taskHasConversationReferences(id)) throw new AppError("ASSET_SHARED", "该记录仍被对话引用，请先解除引用，避免影响对话素材。", 409);
    // 无限画布节点也引用这份素材；先摘掉引用，再删任务和文件
    for (const asset of db.listAssets(id)) detachAssetFromBoards(db, asset.id);
    const removed = db.deleteTask(id, { keepFiles });
    await removeStoredFiles(removed.assets, removed.inputs, db.inputsDir);
    res.json(ok({ deleted: true, keepFiles }));
  }));

  /**
   * 清空历史 / 批量删除：一次请求处理完，避免前端逐条 DELETE 在几百条记录上排队。
   *
   * `ids=a,b,c` 是「只删这些」（历史页勾选后批量删），`scope` 是「按类型全清」。
   * ids 优先：勾选删除只该动用户勾中的那些，范围清空是另一个入口。
   */
  app.delete("/api/generations", asyncHandler(async (req, res) => {
    const scope = req.query.scope === "image" || req.query.scope === "video" || req.query.scope === "audio"
      ? req.query.scope
      : "all";
    const keepFiles = req.query.keepFiles === "1";
    const ids = String(req.query.ids ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    let targets: string[];
    if (ids.length) {
      targets = ids.filter((id) => db.getTaskRow(id));
    } else {
      const adapterByChannel = new Map(db.listChannels().map((channel) => [channel.id, String(channel.adapterType)]));
      targets = db.listAllTaskRows()
        .filter((row) => scope === "all" || db.taskKindRow(row, adapterByChannel) === scope)
        .map((row) => row.id);
    }
    if (targets.some((id) => db.taskHasStoryboardProjectReferences(id))) throw new AppError("ASSET_SHARED", "所选记录包含分镜设定正在使用的参考图，请先解除绑定。", 409);
    if (targets.some((id) => db.taskHasConversationReferences(id))) throw new AppError("ASSET_SHARED", "所选记录中有素材仍被对话引用，请先解除引用后再删除。", 409);
    for (const id of targets) {
      for (const asset of db.listAssets(id)) detachAssetFromBoards(db, asset.id);
    }
    const removed = db.deleteTasks(targets, { keepFiles });
    await removeStoredFiles(removed.assets, removed.inputs, db.inputsDir);
    res.json(ok({ deleted: removed.deleted.length, keepFiles }));
  }));
}
