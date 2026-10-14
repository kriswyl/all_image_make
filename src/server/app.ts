import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import multer from "multer";
import { z } from "zod";
import { APP_VERSION } from "../shared/app-config.js";
import type { Channel, ChannelInput, GenerationInput, ImageSizeValue } from "../shared/types.js";
import { DEFAULT_IMAGE_SIZE, IMAGE_SIZE_VALUES, MAX_CANVAS_IMAGES, MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES, normalizeImageSize } from "../shared/types.js";
import { AppDatabase, type DbChannel, type StoredFileRef } from "./db.js";
import { KeyStore } from "./key-store.js";
import { AppError, TaskRunner, extensionForMime, matchesImageSignature, normalizeError, type ReferenceImageUpload } from "./tasks.js";
import { assertEndpoint, assertSafeUrl, displayFileName, redact, safeFileName } from "./security.js";
import { buildConnectionTestRequest, requestForDiagnostic, sendPreparedRequest } from "./adapters.js";
import { AgentService } from "./agent.js";
import { buildCapabilityAliases, buildCapabilityManifest } from "./capabilities.js";
import { readThumbBytes, writeThumbnail } from "./vision.js";
import {
  VIDEO_CONFIRM_POLICIES, assetRef,
  type AgentStreamEvent, type ConversationInput, type ConversationPatch, type VideoConfirmPolicy,
} from "../shared/agent-types.js";
import { isChatAdapter } from "../shared/types.js";

const adapterTypes = ["openai-images", "openai-chat-image", "gemini-content", "generic-json", "wan-video", "grok-video", "seedance-video", "openai-chat"] as const;
const authTypes = ["bearer", "x-api-key", "query", "custom-header", "none"] as const;
const referenceImageMimeTypes = ["image/png", "image/jpeg", "image/webp"] as const;
const MAX_REFERENCE_BASE64_CHARS = 14_000_000;
/** 单个 media URL 的上限：图片 data URI 按 20MB 原始体积 base64 后约 27M 字符 */
const MAX_MEDIA_URL_CHARS = 28_000_000;
const referenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_REFERENCE_IMAGE_BYTES, files: MAX_REFERENCE_IMAGES, fields: 1 },
  fileFilter: (_req, file, callback) => referenceImageMimeTypes.includes(file.mimetype as typeof referenceImageMimeTypes[number])
    ? callback(null, true)
    : callback(new AppError("REFERENCE_IMAGE_INVALID", "仅支持 PNG、JPEG 或 WebP 参考图", 400)),
});
/**
 * 对话框里自己上传的图（需求.md 问题 4）。
 *
 * 和生图工作台那个 `referenceUpload` 是两个入口，但**限额和校验是同一套**：
 * 单张 10MB、最多 8 张、PNG/JPEG/WebP。同一件事在两处给两种规矩，用户只会觉得坏了。
 */
const conversationUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_REFERENCE_IMAGE_BYTES, files: MAX_REFERENCE_IMAGES, fields: 0 },
  fileFilter: (_req, file, callback) => referenceImageMimeTypes.includes(file.mimetype as typeof referenceImageMimeTypes[number])
    ? callback(null, true)
    : callback(new AppError("REFERENCE_IMAGE_INVALID", "仅支持 PNG、JPEG 或 WebP 图片", 400)),
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
  /** 新建会话时的视频确认策略默认值（§13.2） */
  agentVideoConfirmPolicy: z.enum(VIDEO_CONFIRM_POLICIES).optional(),
  /** 新建会话时默认是否开「看图改」（§11.7） */
  agentVisionEnabled: z.boolean().optional(),
  /** gemini 渠道缺省补的尺寸（需求.md 问题 1）。大小写敏感，所以在这里就把非法值拦掉 */
  geminiImageSize: z.enum(IMAGE_SIZE_VALUES).optional(),
  /**
   * 默认生图 / 生视频模型（需求.md 问题 5），存 alias。
   * 只能**长度**校验——alias 是按启用中的渠道现算的，服务端此刻没法判断它对不对；
   * 传一个不存在的 alias 也算合法输入，只是解析时会退回类目第一个并如实标出来。
   */
  agentDefaultImageAlias: z.string().trim().max(80).optional(),
  agentDefaultVideoAlias: z.string().trim().max(80).optional(),
});

const conversationCreateSchema = z.object({
  title: z.string().trim().max(120).optional(),
  brainChannelId: z.string().uuid().optional(),
  brainModel: z.string().trim().min(1).max(200).optional(),
  videoConfirmPolicy: z.enum(VIDEO_CONFIRM_POLICIES).optional(),
  visionEnabled: z.boolean().optional(),
});

const conversationPatchSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  brainChannelId: z.string().uuid().optional(),
  brainModel: z.string().trim().min(1).max(200).optional(),
  videoConfirmPolicy: z.enum(VIDEO_CONFIRM_POLICIES).optional(),
  visionEnabled: z.boolean().optional(),
  /** 画布整组替换，`[0]` 是主图；`[]` 是清空画布 */
  canvasAssetIds: z.array(z.string().uuid()).max(MAX_CANVAS_IMAGES).optional(),
  /**
   * @deprecated 老版本的单图画布指针。**留着不只是为了旧前端**：zod 默认把不认识的键
   * **剥掉而不是报错**，所以剥掉它 = 旧前端点一下「设为画布」**静默没反应**——
   * 静默 no-op 比 400 难查得多。归一成 `canvasAssetIds` 只要三行（见下面那条路由）。
   */
  currentAssetId: z.string().uuid().nullable().optional(),
});

const messageCreateSchema = z.object({
  /** 文本消息；图片附件在 M1 之后补，届时放宽成可选 */
  text: z.string().trim().min(1).max(20000),
});

const confirmSchema = z.object({
  messageId: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
  /** 卡片上改过的视频参数；服务端只认白名单里的几个旋钮（见 mergeConfirmArgs） */
  args: z.record(z.string(), z.unknown()).optional(),
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
  agent: AgentService;
}

export function createApp(options: { dataDir?: string } = {}) {
  const app = express();
  const db = new AppDatabase(options.dataDir);
  const sessionKeys = new KeyStore(db.dataDir);
  sessionKeys.retainOnly(db.listChannels().map((channel) => channel.id));
  const runner = new TaskRunner(db, sessionKeys);
  const agent = new AgentService(db, runner, sessionKeys);
  const context: AppContext = { db, sessionKeys, runner, agent };

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
    res.json(ok({
      assetsDir: db.assetsDir,
      defaultAssetsDir: db.defaultAssetsDir,
      geminiImageSize: readGeminiImageSize(db),
      ...readAgentDefaults(db),
    }));
  });

  /** 素材目录改完只影响之后生成的产物，旧文件留在原目录；Agent 那两项只影响新建的会话 */
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
    if (input.agentVideoConfirmPolicy !== undefined) db.setSetting("agentVideoConfirmPolicy", input.agentVideoConfirmPolicy);
    if (input.agentVisionEnabled !== undefined) db.setSetting("agentVisionEnabled", input.agentVisionEnabled ? "1" : "0");
    if (input.geminiImageSize !== undefined) db.setSetting("geminiImageSize", input.geminiImageSize);
    if (input.agentDefaultImageAlias !== undefined) db.setSetting("agentDefaultImageAlias", input.agentDefaultImageAlias);
    if (input.agentDefaultVideoAlias !== undefined) db.setSetting("agentDefaultVideoAlias", input.agentDefaultVideoAlias);
    res.json(ok({
      assetsDir,
      defaultAssetsDir: db.defaultAssetsDir,
      geminiImageSize: readGeminiImageSize(db),
      ...readAgentDefaults(db),
    }));
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

  /**
   * 清空历史 / 批量删除：一次请求处理完，避免前端逐条 DELETE 在几百条记录上排队。
   *
   * `ids=a,b,c` 是「只删这些」（历史页勾选后批量删），`scope` 是「按类型全清」。
   * ids 优先：勾选删除只该动用户勾中的那些，范围清空是另一个入口。
   */
  app.delete("/api/generations", asyncHandler(async (req, res) => {
    const scope = req.query.scope === "image" || req.query.scope === "video" ? req.query.scope : "all";
    const keepFiles = req.query.keepFiles === "1";
    const ids = String(req.query.ids ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    let targets: string[];
    if (ids.length) {
      targets = ids.filter((id) => db.getTaskRow(id));
    } else {
      const adapterByChannel = new Map(db.listChannels().map((channel) => [channel.id, String(channel.adapterType)]));
      targets = db.listAllTaskRows()
        .filter((row) => {
          if (scope === "all") return true;
          const isVideo = db.isVideoTaskRow(row, adapterByChannel);
          return scope === "video" ? isVideo : !isVideo;
        })
        .map((row) => row.id);
    }
    const removed = db.deleteTasks(targets, { keepFiles });
    await removeStoredFiles(removed.assets, removed.inputs, db.inputsDir);
    res.json(ok({ deleted: removed.deleted.length, keepFiles }));
  }));

  // ── 对话式 Agent（AGENT_PLAN.md §14） ─────────────────────────────────────

  /** 能当大脑的渠道：只有对话适配器。前端用它渲染「新建会话」的下拉 */
  app.get("/api/agent/brains", (_req, res) => {
    res.json(ok(db.listChannels()
      .filter((channel) => channel.enabled && isChatAdapter(channel.adapterType))
      .map((channel) => ({ id: channel.id, name: channel.name, models: channel.models }))));
  });

  /** §6 能力清单的原文。前端「这个会话能做什么」面板直接展示它，和大脑看到的是同一份 */
  app.get("/api/agent/capabilities", (_req, res) => {
    res.json(ok({
      manifest: buildCapabilityManifest(buildCapabilityAliases(db.listChannels())),
      aliases: buildCapabilityAliases(db.listChannels()).map((alias) => ({
        alias: alias.alias, kind: alias.kind, model: alias.model, channelName: alias.channelName,
      })),
    }));
  });

  app.get("/api/conversations", (_req, res) => {
    res.json(ok(db.listConversations().map((conversation) => {
      const messages = db.listMessages(conversation.id, 2);
      const last = messages[messages.length - 1];
      return {
        ...conversation, running: agent.isRunning(conversation.id),
        lastMessage: (last?.content ?? "").slice(0, 120),
        messageCount: messages.length,
      };
    })));
  });

  app.post("/api/conversations", (req, res) => {
    const input = conversationCreateSchema.parse(req.body ?? {}) as ConversationInput;
    const brain = pickBrainChannel(db, input.brainChannelId, input.brainModel);
    const conversation = db.createConversation({
      title: input.title?.trim() || "新对话",
      brainChannelId: brain.channelId,
      brainModel: brain.model,
      videoConfirmPolicy: input.videoConfirmPolicy ?? readAgentDefaults(db).videoConfirmPolicy,
      visionEnabled: input.visionEnabled ?? readAgentDefaults(db).visionEnabled,
    });
    res.status(201).json(ok(agent.buildView(conversation.id)));
  });

  app.get("/api/conversations/:id", (req, res) => {
    const view = agent.buildView(routeParam(req.params.id));
    if (!view) return res.status(404).json(fail("CONVERSATION_NOT_FOUND", "会话不存在"));
    res.json(ok({ ...view, running: agent.isRunning(view.id) }));
  });

  app.patch("/api/conversations/:id", (req, res) => {
    const id = routeParam(req.params.id);
    if (!db.getConversation(id)) return res.status(404).json(fail("CONVERSATION_NOT_FOUND", "会话不存在"));
    const patch = conversationPatchSchema.parse(req.body ?? {}) as ConversationPatch;
    // 老前端（`currentAssetId`）归一成新字段。只在**没同时给新字段**时生效：
    // 两个都给的话以新的为准，别让一个废弃字段去覆盖用户刚点的操作
    if (patch.currentAssetId !== undefined && patch.canvasAssetIds === undefined) {
      patch.canvasAssetIds = patch.currentAssetId ? [patch.currentAssetId] : [];
    }
    delete patch.currentAssetId;
    if (patch.canvasAssetIds) {
      // 去重保序：重复只说明前端点了两下，不该变成 400，也不该在画布上出现两张一样的
      const ids = [...new Set(patch.canvasAssetIds)];
      for (const assetId of ids) {
        const asset = db.getAsset(assetId);
        if (!asset) return res.status(400).json(fail("ASSET_NOT_FOUND", `产物 ${assetId} 不存在`));
        if (!asset.mimeType.startsWith("image/")) return res.status(400).json(fail("ASSET_NOT_IMAGE", "视频不能作为画布"));
      }
      patch.canvasAssetIds = ids;
    }
    const updated = db.updateConversation(id, patch);
    res.json(ok(agent.buildView(updated!.id)));
  });

  app.delete("/api/conversations/:id", asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    if (!db.getConversation(id)) return res.status(404).json(fail("CONVERSATION_NOT_FOUND", "会话不存在"));
    // 正在跑的一轮先掐掉，否则它会把消息写回一张已经删掉的会话
    agent.interrupt(id);
    // 上传的图不属于生成历史，没人引用了就得连文件一起清掉（生成的产物不动）
    const removed = db.deleteConversation(id);
    await removeStoredFiles(removed.assets, [], db.inputsDir);
    res.json(ok({ deleted: true }));
  }));

  /**
   * 发一条消息并开始这一轮。
   *
   * 立即返回 202，产出全部走 `/events` 那条 SSE（§14）。
   * 这里不 await 生成过程：一趟生图可能几十秒，卡着 HTTP 连接只会让前端超时。
   */
  app.post("/api/conversations/:id/messages", (req, res) => {
    const id = routeParam(req.params.id);
    if (!db.getConversation(id)) return res.status(404).json(fail("CONVERSATION_NOT_FOUND", "会话不存在"));
    const input = messageCreateSchema.parse(req.body ?? {});
    agent.startTurn(id, input.text, "user");
    res.status(202).json(ok({ accepted: true }));
  });

  /** 中断当前这一轮：已经提交出去的任务照常跑完，只是大脑不再往下规划 */
  app.post("/api/conversations/:id/interrupt", (req, res) => {
    const id = routeParam(req.params.id);
    if (!db.getConversation(id)) return res.status(404).json(fail("CONVERSATION_NOT_FOUND", "会话不存在"));
    res.json(ok({ interrupted: agent.interrupt(id) }));
  });

  /** §13.5 确认卡片的出口 */
  app.post("/api/conversations/:id/confirm", asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const input = confirmSchema.parse(req.body ?? {});
    await agent.resolveConfirmation(id, input.messageId, input.decision, input.args);
    res.json(ok({ decision: input.decision }));
  }));

  /**
   * 往对话里传图（需求.md 问题 4）。
   *
   * 上传的图**不是**附件，而是一等会话素材：字节落进素材目录、写进 `assets` 表、
   * 再配一条带 `asset_id` 的 `user` 消息。于是「设为当前画布」「当 edit_image 的参考图」
   * 「大脑用 #xxxx 引用」这三件事**全部自动生效**——它们在库里找的都是
   * `messages.asset_id` 这条线索（`listConversationAssets` / `resolveAssetRef`），
   * 不需要为上传单开一条路径。
   *
   * 它借 `tasks` 占一个 task_id（`assets.task_id` 是 NOT NULL，而重建表会动到真实数据），
   * 靠 `origin='upload'` 和真正的生成记录区分开：不进历史列表、不计入会话任务额度。
   *
   * 消息的 `content` 就是**大脑看到的那句话**（`toBrainMessage` 对 user 只取 content），
   * 所以这里只写文件名和「上传」这件事，不塞路径、更不塞任何密钥。
   * 文件名走 `displayFileName`：路径分隔符和控制字符洗掉（否则换个行的文件名
   * 就等于往大脑的上下文里多塞一句「用户说的话」），但**中文原样留着**——
   * 这个 app 的用户多半传的是「猫.png」，洗成下划线等于给用户看一句废话。
   */
  app.post("/api/conversations/:id/uploads", conversationUpload.array("images", MAX_REFERENCE_IMAGES), asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    if (!db.getConversation(id)) throw new AppError("CONVERSATION_NOT_FOUND", "会话不存在", 404);
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) throw new AppError("UPLOAD_EMPTY", "没有收到图片", 400);

    const uploaded: string[] = [];
    for (const file of files) {
      // 只看 Content-Type 是不够的：改个后缀就能绕过去，字节头才是证据
      if (!matchesImageSignature(file.buffer, file.mimetype as ReferenceImageUpload["mimeType"])) {
        throw new AppError("REFERENCE_IMAGE_INVALID", "图片格式与文件内容不匹配", 400);
      }
      const assetId = crypto.randomUUID();
      const taskId = crypto.randomUUID();
      const baseDir = db.assetsDir;
      const fileName = safeFileName(`${taskId}-1.${extensionForMime(file.mimetype)}`);
      await fs.promises.writeFile(path.join(baseDir, fileName), file.buffer);
      const sha256 = crypto.createHash("sha256").update(file.buffer).digest("hex");
      // 和生成产物走同一个缩略图出口：画布徽章、「本会话的图」都要用它
      const thumbPath = await writeThumbnail(db, assetId, file.buffer);
      db.createTask({
        id: taskId, channelId: "", model: "", prompt: "上传图片",
        input: {}, origin: "upload", status: "succeeded",
      });
      db.insertAsset({
        id: assetId, taskId, fileName, mimeType: file.mimetype, byteSize: file.buffer.length,
        relativePath: fileName, baseDir, sha256, thumbPath,
      });
      db.appendMessage({
        conversationId: id, role: "user",
        content: `上传了图片 ${displayFileName(file.originalname)}`,
        assetId,
      });
      uploaded.push(assetId);
    }
    // 刚传进来的图直接就是当前画布：用户下一步十有八九是「把这张图的手改成握着咖啡杯」。
    // 主图从「最后一张」改成「第一张」——一次传多张时，用户心里排第一的显然是他先选的那张。
    if (uploaded.length) db.updateConversation(id, { canvasAssetIds: uploaded });
    res.status(201).json(ok(agent.buildView(id)));
  }));

  /**
   * SSE 事件流（§14）。
   *
   * 用 `GET + 重连` 而不是 `POST + 流式响应`：派发消息和接收事件分成两个请求后，
   * 「连上事件流」和「发消息」的先后顺序就不重要了——前端可以先连、再发，
   * 断线重连也只要重连这一个地址。为此服务端的 AgentService 不持有 HTTP 请求，
   * 而是按会话广播。
   */
  app.get("/api/conversations/:id/events", (req, res) => {
    const id = routeParam(req.params.id);
    if (!db.getConversation(id)) return res.status(404).json(fail("CONVERSATION_NOT_FOUND", "会话不存在"));
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(":ok\n\n");
    const send = (event: AgentStreamEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = agent.subscribe(id, send);
    // 心跳：视频任务两轮轮询之间可能十几秒没有事件，中间隔着代理时连接会被掐断
    const heartbeat = setInterval(() => res.write(":ping\n\n"), 15000);
    const close = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on("close", close);
    req.on("error", close);
  });

  /** 缩略图（§11.4）。没有就现缩现存；缩不出来就 404，前端回落到原图 */
  app.get("/api/assets/:id/thumb", asyncHandler(async (req, res) => {
    const asset = db.getAsset(routeParam(req.params.id));
    if (!asset) throw new AppError("ASSET_NOT_FOUND", "图片不存在", 404);
    if (!asset.mimeType.startsWith("image/")) throw new AppError("ASSET_NOT_IMAGE", "视频没有缩略图", 404);
    const bytes = await readThumbBytes(db, asset);
    if (!bytes) throw new AppError("THUMB_UNAVAILABLE", "缩略图不可用", 404);
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(bytes);
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

/**
 * gemini 渠道缺省补的尺寸（需求.md 问题 1）。
 *
 * 设置表是纯 key/value 的字符串，谁都能写脏，所以读的时候必须再校验一次——
 * 把一个非法值补进请求体只会把「参数缺失」换成「参数非法」，还是照样失败。
 */
function readGeminiImageSize(db: AppDatabase): ImageSizeValue {
  return normalizeImageSize(db.getSetting("geminiImageSize")) ?? DEFAULT_IMAGE_SIZE;
}

/** 新建会话时的 Agent 默认值，存在 settings 表里，用户可在设置页改 */
function readAgentDefaults(db: AppDatabase): {
  videoConfirmPolicy: VideoConfirmPolicy;
  visionEnabled: boolean;
  defaultImageAlias: string;
  defaultVideoAlias: string;
} {
  const policy = db.getSetting("agentVideoConfirmPolicy");
  return {
    // 默认「自动续跑时才问」：用户明确开口要视频时不拦，链条自己往前跑时才拦一下（§13.2）
    videoConfirmPolicy: (VIDEO_CONFIRM_POLICIES as readonly string[]).includes(policy ?? "")
      ? (policy as VideoConfirmPolicy) : "auto_only",
    visionEnabled: db.getSetting("agentVisionEnabled") !== "0",
    // 空串 = 没设，大脑不点名时退回类目第一个（问题 5）。alias 是否还有效不在这里判断
    defaultImageAlias: db.getSetting("agentDefaultImageAlias") ?? "",
    defaultVideoAlias: db.getSetting("agentDefaultVideoAlias") ?? "",
  };
}

/**
 * 挑一个对话渠道当大脑。
 *
 * 用户没指定时取第一个启用的对话渠道——通常只配了一个，
 * 加个下拉反而多一步。一个都没有时直接报错，而不是等到第一次说话才失败。
 */
function pickBrainChannel(db: AppDatabase, channelId?: string, model?: string): { channelId: string; model: string } {
  const brains = db.listChannels().filter((channel) => channel.enabled && isChatAdapter(channel.adapterType));
  if (!brains.length) {
    throw new AppError("BRAIN_UNAVAILABLE", "还没有配置对话模型渠道，请先到「渠道配置」添加一个对话模型（大脑）", 400);
  }
  const channel = channelId ? brains.find((item) => item.id === channelId) : brains[0];
  if (!channel) throw new AppError("BRAIN_UNAVAILABLE", "指定的对话渠道不存在或未启用", 400);
  const resolved = model && channel.models.includes(model) ? model : channel.models[0];
  if (!resolved) throw new AppError("BRAIN_UNAVAILABLE", `渠道「${channel.name}」还没有配置任何模型`, 400);
  return { channelId: channel.id, model: resolved };
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
