import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import multer from "multer";
import { z } from "zod";
import { APP_VERSION } from "../shared/app-config.js";
import type { Channel, ChannelInput, GenerationInput } from "../shared/types.js";
import { AppDatabase, type DbChannel, type StoredFileRef } from "./db.js";
import { KeyStore } from "./key-store.js";
import { AppError, TaskRunner, normalizeError, type ReferenceImageUpload } from "./tasks.js";
import { assertEndpoint, assertSafeUrl, redact } from "./security.js";
import { buildConnectionTestRequest, requestForDiagnostic, sendPreparedRequest } from "./adapters.js";

const adapterTypes = ["openai-images", "openai-chat-image", "gemini-content", "generic-json", "wan-video", "grok-video", "seedance-video"] as const;
const authTypes = ["bearer", "x-api-key", "query", "custom-header", "none"] as const;
const referenceImageMimeTypes = ["image/png", "image/jpeg", "image/webp"] as const;
const MAX_REFERENCE_BASE64_CHARS = 14_000_000;
const MAX_REFERENCE_IMAGES = 8;
/** 单个 media URL 的上限：图片 data URI 按 20MB 原始体积 base64 后约 27M 字符 */
const MAX_MEDIA_URL_CHARS = 28_000_000;
const referenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: MAX_REFERENCE_IMAGES, fields: 1 },
  fileFilter: (_req, file, callback) => referenceImageMimeTypes.includes(file.mimetype as typeof referenceImageMimeTypes[number])
    ? callback(null, true)
    : callback(new AppError("REFERENCE_IMAGE_INVALID", "仅支持 PNG、JPEG 或 WebP 参考图", 400)),
});

const channelSchema = z.object({
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().trim().url(),
  adapterType: z.enum(adapterTypes),
  authType: z.enum(authTypes),
  authHeaderName: z.string().trim().max(80).default(""),
  secretEnv: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$|^$/).default(""),
  endpoint: z.string().trim().max(300).default(""),
  models: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
  allowPrivateNetwork: z.boolean().default(false),
  enabled: z.boolean().default(true),
  apiKey: z.string().max(10000).optional(),
});

/** assetsDir 传空串表示恢复默认目录 */
const settingsSchema = z.object({
  assetsDir: z.string().trim().max(1000).optional(),
});

const generationSchema = z.object({
  channelId: z.string().uuid(),
  model: z.string().trim().min(1).max(200),
  prompt: z.string().trim().min(1).max(20000),
  referenceImage: z.object({
    base64: z.string().min(4).max(MAX_REFERENCE_BASE64_CHARS).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    mimeType: z.enum(referenceImageMimeTypes),
    fileName: z.string().trim().min(1).max(200),
  }).optional(),
  referenceImages: z.array(z.object({
    base64: z.string().min(4).max(MAX_REFERENCE_BASE64_CHARS).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    mimeType: z.enum(referenceImageMimeTypes),
    fileName: z.string().trim().min(1).max(200),
  })).max(MAX_REFERENCE_IMAGES).optional(),
  negativePrompt: z.string().max(10000).optional(),
  size: z.string().max(60).optional(),
  aspectRatio: z.string().max(20).optional(),
  count: z.number().int().min(1).max(8).optional(),
  quality: z.string().max(60).optional(),
  outputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
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
    // 图片走 data URI（base64 后体积放大约 1/3），视频音频走公网或 oss 地址
    url: z.string().min(1).max(MAX_MEDIA_URL_CHARS),
  })).max(20).optional(),
  seedanceVideoMode: z.enum([
    "text-to-video",
    "first-frame",
    "first-last-frame",
    "reference",
  ]).optional(),
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
  })).max(20).optional(),
  timeoutMs: z.number().int().min(10_000).max(1_800_000).optional(),
  rawParameters: z.record(z.string(), z.unknown()).optional(),
});

export interface AppContext {
  db: AppDatabase;
  sessionKeys: KeyStore;
  runner: TaskRunner;
}

export function createApp(options: { dataDir?: string } = {}) {
  const app = express();
  const db = new AppDatabase(options.dataDir);
  const sessionKeys = new KeyStore(db.dataDir);
  sessionKeys.retainOnly(db.listChannels().map((channel) => channel.id));
  const runner = new TaskRunner(db, sessionKeys);
  const context: AppContext = { db, sessionKeys, runner };

  app.disable("x-powered-by");
  // 万相支持 10 张参考图，每张 20MB，base64 后 * 4/3 ≈ 266MB；留 300MB 余量
  app.use(express.json({ limit: "300mb" }));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin === "http://tauri.localhost" || origin === "tauri://localhost" || origin === "http://127.0.0.1:5173") {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  });
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    // 素材是按任务 id + 序号命名的不可变文件，允许缓存：同一段视频会被播放器、
    // 模糊底图、缩略图反复取用，no-store 会让它们各下一次
    if (req.path.startsWith("/api/") && !req.path.startsWith("/api/assets/")) res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/api/health", (_req, res) => res.json(ok({ status: "ok", version: APP_VERSION })));

  app.get("/api/bootstrap", (_req, res) => {
    res.json(ok({
      channels: db.listChannels().map((channel) => publicChannel(channel, sessionKeys)),
      tasks: db.listTaskViews(40),
      service: { version: APP_VERSION, dataPath: db.filePath, assetsPath: db.assetsDir, defaultAssetsPath: db.defaultAssetsDir },
    }));
  });

  app.get("/api/settings", (_req, res) => {
    res.json(ok({ assetsDir: db.assetsDir, defaultAssetsDir: db.defaultAssetsDir }));
  });

  /** 目前只有素材目录一项设置：改完只影响之后生成的产物，旧文件留在原目录 */
  app.patch("/api/settings", asyncHandler(async (req, res) => {
    const input = settingsSchema.parse(req.body);
    let assetsDir = db.assetsDir;
    if (input.assetsDir !== undefined) {
      try {
        assetsDir = input.assetsDir === "" ? db.resetAssetsDir() : db.setAssetsDir(input.assetsDir);
      } catch (error) {
        throw new AppError("INVALID_ASSETS_DIR", error instanceof Error ? error.message : "素材目录无效", 400);
      }
    }
    res.json(ok({ assetsDir, defaultAssetsDir: db.defaultAssetsDir }));
  }));

  app.get("/api/channels", (_req, res) => {
    res.json(ok(db.listChannels().map((channel) => publicChannel(channel, sessionKeys))));
  });

  app.post("/api/channels", asyncHandler(async (req, res) => {
    const input = channelSchema.parse(req.body);
    assertEndpoint(input.endpoint);
    await assertSafeUrl(input.baseUrl, input.allowPrivateNetwork);
    const saved = db.saveChannel(input as ChannelInput);
    if (input.apiKey) sessionKeys.set(saved.id, input.apiKey);
    res.status(201).json(ok(publicChannel(saved, sessionKeys)));
  }));

  app.patch("/api/channels/:id", asyncHandler(async (req, res) => {
    const existing = db.getChannel(routeParam(req.params.id));
    if (!existing) throw new AppError("CHANNEL_NOT_FOUND", "渠道不存在", 404);
    const input = channelSchema.parse(req.body);
    assertEndpoint(input.endpoint);
    await assertSafeUrl(input.baseUrl, input.allowPrivateNetwork);
    const saved = db.saveChannel(input as ChannelInput, existing.id);
    if (input.apiKey) sessionKeys.set(saved.id, input.apiKey);
    res.json(ok(publicChannel(saved, sessionKeys)));
  }));

  app.delete("/api/channels/:id", (req, res) => {
    const id = routeParam(req.params.id);
    if (!db.getChannel(id)) return res.status(404).json(fail("CHANNEL_NOT_FOUND", "渠道不存在"));
    db.deleteChannel(id);
    sessionKeys.delete(id);
    res.json(ok({ deleted: true }));
  });

  app.post("/api/channels/:id/test", asyncHandler(async (req, res) => {
    const channel = db.getChannel(routeParam(req.params.id));
    if (!channel) throw new AppError("CHANNEL_NOT_FOUND", "渠道不存在", 404);
    const key = resolveChannelKey(channel, sessionKeys);
    const prepared = buildConnectionTestRequest(channel, key);
    try {
      const result = await sendPreparedRequest(prepared);
      res.json(ok({ reachable: true, httpStatus: result.status, durationMs: result.durationMs, request: redact(requestForDiagnostic(prepared)) }));
    } catch (error) {
      const normalized = normalizeError(error);
      if (normalized.status === 404) return res.json(ok({ reachable: true, httpStatus: 404, message: "已连接到服务，但模型列表路径不存在" }));
      throw error;
    }
  }));

  app.post("/api/generations", referenceUpload.array("referenceImages", MAX_REFERENCE_IMAGES), asyncHandler(async (req, res) => {
      const uploadedFiles = Array.isArray(req.files) ? req.files : [];
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
      const input = generationSchema.parse({
        ...body,
        ...(uploadedImages.length ? { referenceImages: undefined, referenceImage: undefined } : {}),
      }) as GenerationInput;
      const task = await runner.create(input, uploadedImages);
      res.status(202).json(ok(task));
  }));

  app.get("/api/generations", (req, res) => {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 40)));
    res.json(ok(db.listTaskViews(limit)));
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
    const removed = db.deleteTask(id, { keepFiles });
    await removeStoredFiles(removed.assets, removed.inputs, db.inputsDir);
    res.json(ok({ deleted: true, keepFiles }));
  }));

  /** 清空历史：一次请求处理完，避免前端逐条 DELETE 在几百条记录上排队 */
  app.delete("/api/generations", asyncHandler(async (req, res) => {
    const scope = req.query.scope === "image" || req.query.scope === "video" ? req.query.scope : "all";
    const keepFiles = req.query.keepFiles === "1";
    const adapterByChannel = new Map(db.listChannels().map((channel) => [channel.id, String(channel.adapterType)]));
    const targets = db.listAllTaskRows().filter((row) => {
      if (scope === "all") return true;
      const isVideo = db.isVideoTaskRow(row, adapterByChannel);
      return scope === "video" ? isVideo : !isVideo;
    });
    const removed = db.deleteTasks(targets.map((row) => row.id), { keepFiles });
    await removeStoredFiles(removed.assets, removed.inputs, db.inputsDir);
    res.json(ok({ deleted: removed.deleted.length, keepFiles }));
  }));

  /** 在系统文件管理器里打开素材目录：图片视频都落在应用数据目录里，用户得能直接翻到 */
  app.post("/api/system/reveal-media", asyncHandler(async (req, res) => {
    const requested = String((req.body as { kind?: unknown } | undefined)?.kind ?? "assets");
    const target = requested === "inputs" ? db.inputsDir : requested === "data" ? db.dataDir : db.assetsDir;
    await revealFolder(target);
    res.json(ok({ opened: target }));
  }));

  app.get("/api/assets/:id/file", (req, res) => {
    const id = routeParam(req.params.id);
    // 按主键直查：以前这里先取 1000 个任务再逐个查产物，历史一多，每个缩略图都要跑上千次查询
    const asset = db.getAsset(id);
    if (!asset) return res.status(404).json(fail("ASSET_NOT_FOUND", "图片不存在"));
    // 目录跟着记录走：用户换过素材目录后，老产物的绝对路径不能拿当前目录拼
    const baseDir = path.resolve(asset.baseDir);
    const absolutePath = path.resolve(baseDir, asset.relativePath);
    if (!absolutePath.startsWith(baseDir + path.sep)) return res.status(400).json(fail("ASSET_INVALID", "图片路径无效"));
    if (req.query.download === "1") return res.download(absolutePath, asset.fileName);
    res.type(asset.mimeType).sendFile(absolutePath);
  });

  const clientDir = path.resolve("dist/client");
  if (fs.existsSync(clientDir)) {
    app.use(express.static(clientDir, { index: false }));
    app.get("*path", (_req, res) => res.sendFile(path.join(clientDir, "index.html")));
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const requestId = crypto.randomUUID();
    if (error instanceof multer.MulterError) {
      const message = error.code === "LIMIT_FILE_SIZE" ? "单张参考图不能超过 10 MB" : "参考图最多上传 8 张";
      return res.status(400).json(fail("INVALID_REFERENCE_IMAGES", message, requestId));
    }
    if (error instanceof z.ZodError) {
      return res.status(400).json(fail("INVALID_INPUT", "输入数据无效", requestId, error.issues));
    }
    const normalized = normalizeError(error);
    res.status(normalized.status).json(fail(normalized.code, normalized.message, requestId, normalized.details));
  });

  return { app, context };
}

/** 用系统文件管理器打开目录：Windows 是 explorer，macOS 是 open，Linux 是 xdg-open */
function revealFolder(dir: string) {
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  // 用 spawn + 参数数组而不是拼命令字符串：目录名里的引号、空格不会变成命令注入
  const child = spawn(command, [dir], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

/** 产物按记录自带的目录清理，参考图固定在 inputs/ */
async function removeStoredFiles(assets: StoredFileRef[], inputs: string[], inputsDir: string) {
  await Promise.all([
    ...assets.map((asset) => removeStoredFile(asset.baseDir, asset.relativePath)),
    ...inputs.map((relativePath) => removeStoredFile(inputsDir, relativePath)),
  ]);
}

async function removeStoredFile(baseDir: string, relativePath: string) {
  const absolutePath = path.resolve(baseDir, relativePath);
  if (!absolutePath.startsWith(path.resolve(baseDir) + path.sep)) return;
  await fs.promises.rm(absolutePath, { force: true }).catch(() => undefined);
}

function publicChannel(channel: DbChannel, sessionKeys: KeyStore): Channel {
  return {
    ...channel,
    hasKey: channel.authType === "none" || Boolean(sessionKeys.get(channel.id) || (channel.secretEnv && process.env[channel.secretEnv])),
  };
}

function resolveChannelKey(channel: DbChannel, sessionKeys: KeyStore) {
  if (channel.authType === "none") return "";
  const key = sessionKeys.get(channel.id) || (channel.secretEnv ? process.env[channel.secretEnv] : "");
  if (!key) throw new AppError("CHANNEL_AUTH_FAILED", "该渠道没有可用的 API Key", 400);
  return key;
}

function ok<T>(data: T) { return { ok: true, data }; }

function fail(code: string, message: string, requestId = crypto.randomUUID(), details?: unknown) {
  return { ok: false, error: { code, message, requestId, ...(details === undefined ? {} : { details }) } };
}

function asyncHandler(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) {
  return (req: Request, res: Response, next: NextFunction) => void handler(req, res, next).catch(next);
}

function routeParam(value: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}
