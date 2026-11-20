import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { MINIMAX_REFERENCE_LIMITS } from "../../shared/video-capabilities.js";
import { isImageAdapter, taskKindFor } from "../../shared/kinds.js";
import { imageOutputFormatSchema, MAX_FRAME_COUNT, MAX_FRAME_DURATION_MS, MIN_FRAME_COUNT, MIN_FRAME_DURATION_MS } from "../../shared/image-formats.js";
import type { GenerationInput } from "../../shared/types.js";
import { MAX_MEDIA_URL_CHARS, MAX_REFERENCE_IMAGE_BYTES } from "../../shared/types.js";
import { MAX_IMAGE_GENERATION_REFERENCES } from "../../shared/image-reference-limits.js";
import type { AppDatabase } from "../db.js";
import type { KeyStore } from "../key-store.js";
import { referenceMediaKindOf } from "../reference-video.js";
import { AppError, type TaskRunner, type MaskImageUpload, type ReferenceImageUpload } from "../tasks.js";
import { midjourneyModelForCustomId } from "../../shared/midjourney.js";
import { detachAssetFromBoards } from "../board.js";
import { referenceImageMimeTypes, referenceVideoUpload } from "./uploads.js";
import { removeStoredFiles } from "./files.js";
import { ok, fail, asyncHandler, routeParam } from "./http.js";
import { submitImageTasks } from "../image-batch.js";
import type { Express } from "express";

const MAX_REFERENCE_BASE64_CHARS = Math.ceil(MAX_REFERENCE_IMAGE_BYTES / 3) * 4;

const referenceUpload = multer({
  storage: multer.memoryStorage(),
  // 解析阶段尚未选定模型，给所有已知图片模型留出容量及一个蒙版槽位。
  limits: { fileSize: MAX_REFERENCE_IMAGE_BYTES + 1, files: MAX_IMAGE_GENERATION_REFERENCES + 1, fields: 1 },
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
  // 混合任务的 payload 仍可含内联图片。表单解析上限和任务的内联素材预算分别检查。
  limits: { fileSize: 100 * 1024 * 1024 + 1, fieldSize: 64 * 1024 * 1024, files: 20, fields: 1 },
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
  })).max(MAX_IMAGE_GENERATION_REFERENCES).optional(),
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
  minimaxVideoMode: z.enum(["text-to-video", "first-frame", "first-last-frame", "reference"]).optional(),
  minimaxVideoMedia: z.array(z.object({
    type: z.enum(["first_frame", "last_frame", "reference_image", "video", "audio"]),
    url: z.string().min(1).max(MAX_MEDIA_URL_CHARS),
  })).max(MINIMAX_REFERENCE_LIMITS.images + MINIMAX_REFERENCE_LIMITS.videos + MINIMAX_REFERENCE_LIMITS.audios).optional(),
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

/**
 * 逐条判断一条记录能不能删，而不是一遇到引用就整批回滚。
 *
 * - 被分镜设定（storyboard project）当参考图的：跳过，得先去分镜里解绑
 * - 被对话引用的（聊天生成的记录基本都是）：`detachConversation` 为真时先把
 *   消息 / 画布 / 分镜里的引用摘干净再删，否则跳过
 *
 * 以前的实现是「有一条被引用就 409」，用户点清空会看到列表纹丝不动，
 * 也说不清是哪一条挡住了。
 */
function runDeletion(db: AppDatabase, ids: string[], options: { keepFiles: boolean; detachConversation: boolean }) {
  const removable: string[] = [];
  const skippedConversation: string[] = [];
  const skippedShared: string[] = [];
  for (const id of ids) {
    if (!db.hasTask(id)) continue;
    if (db.taskHasStoryboardProjectReferences(id)) { skippedShared.push(id); continue; }
    if (db.taskHasConversationReferences(id)) {
      if (!options.detachConversation) { skippedConversation.push(id); continue; }
      // 聊天记录在素材管理里被删时，对话那边也要跟着断开，否则留下裂图
      db.detachTaskFromConversations(id);
    }
    for (const asset of db.listAssets(id)) detachAssetFromBoards(db, asset.id);
    removable.push(id);
  }
  const removed = db.deleteTasks(removable, { keepFiles: options.keepFiles });
  return { ...removed, skippedConversation, skippedShared };
}

/**
 * 失效记录：渠道早被删掉，产物文件也已经不在磁盘上，界面只剩一张裂图。
 *
 * 严格限定「渠道已删 + 产物全丢（或压根没产物）」，不碰任何还能显示的记录；
 * 被分镜设定引用的也跳过，交给人去解绑。
 */
function staleTaskIds(db: AppDatabase): string[] {
  const channelIds = new Set(db.listChannels().map((channel) => channel.id));
  return db.listGenerationTaskKeys()
    .filter((row) => !channelIds.has(row.channelId))
    .filter((row) => !db.taskHasStoryboardProjectReferences(row.id))
    .filter((row) => {
      const assets = db.listAssets(row.id);
      return assets.length === 0 || assets.every((asset) => !fs.existsSync(path.resolve(asset.baseDir, asset.relativePath)));
    })
    .map((row) => row.id);
}

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
    // 兼容早期工作台把纯图任务也发到此处，图片在 payload 内。
    const rawPayload = typeof req.body?.payload === "string" ? req.body.payload.trim() : "";
    if (!rawPayload) {
      if (!videos.length && !audios.length) throw new AppError("UPLOAD_EMPTY", "没有收到参考素材", 400);
      throw new AppError("INVALID_INPUT", "生成参数不是有效的 JSON", 400);
    }
    let body: unknown;
    try { body = JSON.parse(rawPayload); }
    catch { throw new AppError("INVALID_INPUT", "生成参数不是有效的 JSON", 400); }
    const input = generationSchema.parse(body);
    const inlineMedia = (input.seedanceVideoMedia?.length ?? 0) + (input.minimaxVideoMedia?.length ?? 0);
    if (!videos.length && !audios.length && !inlineMedia) throw new AppError("UPLOAD_EMPTY", "没有收到参考素材", 400);
    const task = await runner.create({
      ...input,
      referenceVideoUploads: videos,
      referenceAudioUploads: audios,
    });
    res.status(202).json(ok(task));
  }));

  app.post(["/api/generations", "/api/generations/image-batch"], referenceUpload.fields([
    { name: "referenceImages", maxCount: MAX_IMAGE_GENERATION_REFERENCES },
    { name: "mask", maxCount: 1 },
  ]), asyncHandler(async (req, res) => {
      const files = Array.isArray(req.files) || !req.files ? {} : req.files as Record<string, Express.Multer.File[]>;
      const uploadedFiles = files.referenceImages ?? [];
      const maskFiles = files.mask ?? [];
      let body = req.body;
      if (typeof req.body?.payload === "string") {
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
      if (req.path.toLowerCase().replace(/\/$/, "") === "/api/generations/image-batch") {
        const channel = db.getChannel(input.channelId);
        if (!channel || !isImageAdapter(channel.adapterType)) throw new AppError("INVALID_CHANNEL", "请选择可用的图片生成渠道", 400);
        if (maskUpload || input.maskImage) throw new AppError("INVALID_INPUT", "蒙版重绘请使用单张提交", 400);
        const results = await submitImageTasks(runner, input, uploadedImages, input.count ?? 1);
        res.status(202).json(ok({
          tasks: results.flatMap(result => result.status === "fulfilled" ? [result.value] : []),
          failures: results.flatMap((result, index) => result.status === "rejected"
            ? [{ index: index + 1, message: result.reason instanceof AppError ? result.reason.message : "任务提交失败" }]
            : []),
        }));
        return;
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
    const input = z.object({
      ids: z.array(z.string().min(1).max(80)).max(50000),
      keepFiles: z.boolean().default(false),
      /** 素材管理里删聊天记录：连对话里的引用一起摘掉再删 */
      detachConversation: z.boolean().default(false),
    }).parse(req.body);
    const ids = [...new Set(input.ids)].filter((id) => db.getTaskRow(id));
    const removed = runDeletion(db, ids, { keepFiles: input.keepFiles, detachConversation: input.detachConversation });
    await removeStoredFiles(removed.assets, removed.inputs, db.inputsDir);
    res.json(ok({
      deleted: removed.deleted.length,
      skipped: removed.skippedConversation.length + removed.skippedShared.length,
      skippedConversation: removed.skippedConversation.length,
      skippedShared: removed.skippedShared.length,
      keepFiles: input.keepFiles,
    }));
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

  /**
   * 「清理失效记录」：渠道已删 + 产物文件已丢失的孤儿记录。
   * 先让前端拿到条数做二次确认，再真正删。
   */
  app.get("/api/generations/stale", (_req, res) => {
    res.json(ok({ count: staleTaskIds(db).length }));
  });

  app.delete("/api/generations/stale", asyncHandler(async (req, res) => {
    const ids = staleTaskIds(db);
    // 这些记录的图早就没了，对话里的引用只是悬空指针，摘掉不会丢任何东西
    const removed = runDeletion(db, ids, { keepFiles: false, detachConversation: true });
    await removeStoredFiles(removed.assets, removed.inputs, db.inputsDir);
    res.json(ok({ deleted: removed.deleted.length, kept: ids.length - removed.deleted.length }));
  }));

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
    // detach=1：素材管理里删聊天生成记录，连对话引用一起摘
    const detach = req.query.detach === "1";
    if (db.taskHasStoryboardProjectReferences(id)) throw new AppError("ASSET_SHARED", "该记录包含分镜设定正在使用的参考图，请先解除绑定。", 409);
    if (db.taskHasConversationReferences(id)) {
      if (!detach) throw new AppError("ASSET_SHARED", "该记录仍被对话引用，请先解除引用，避免影响对话素材。", 409);
      db.detachTaskFromConversations(id);
    }
    // 无限画布节点也引用这份素材；先摘掉引用，再删任务和文件
    for (const asset of db.listAssets(id)) detachAssetFromBoards(db, asset.id);
    const removed = db.deleteTask(id, { keepFiles });
    await removeStoredFiles(removed.assets, removed.inputs, db.inputsDir);
    res.json(ok({ deleted: true, keepFiles, detached: detach }));
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
    const detachConversation = req.query.detach === "1";
    const ids = String(req.query.ids ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    let targets: string[];
    if (ids.length) {
      targets = ids.filter((id) => db.hasTask(id));
    } else {
      const adapterByChannel = new Map(db.listChannels().map((channel) => [channel.id, String(channel.adapterType)]));
      targets = db.listGenerationTaskKeys()
        .filter((row) => scope === "all" || db.taskKindRow(row, adapterByChannel) === scope)
        .map((row) => row.id);
    }
    const removed = runDeletion(db, targets, { keepFiles, detachConversation });
    await removeStoredFiles(removed.assets, removed.inputs, db.inputsDir);
    res.json(ok({
      deleted: removed.deleted.length,
      skipped: removed.skippedConversation.length + removed.skippedShared.length,
      skippedConversation: removed.skippedConversation.length,
      skippedShared: removed.skippedShared.length,
      keepFiles,
    }));
  }));
}
