import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import multer from "multer";
import { z } from "zod";
import { APP_VERSION } from "../shared/app-config.js";
import { BOARD_AUDIO_KINDS, BOARD_VIDEO_MODES } from "../shared/board.js";
import type { Channel, ChannelInput, GenerationInput, ImageSizeValue } from "../shared/types.js";
import { DEFAULT_IMAGE_SIZE, IMAGE_SIZE_VALUES, MAX_CANVAS_IMAGES, MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES, normalizeImageSize } from "../shared/types.js";
import { AppDatabase, type DbChannel, type StoredFileRef } from "./db.js";
import { KeyStore } from "./key-store.js";
import { uploadReferenceVideo } from "./reference-video.js";
import { AppError, TaskRunner, extensionForMime, matchesImageSignature, normalizeError, type MaskImageUpload, type ReferenceImageUpload } from "./tasks.js";
import { assertEndpoint, assertSafeUrl, displayFileName, redact, safeFileName } from "./security.js";
import { buildConnectionTestRequest, requestForDiagnostic, sendPreparedRequest } from "./adapters.js";
import { AgentService } from "./agent.js";
import { buildCapabilityAliases, buildCapabilityManifest } from "./capabilities.js";
import { pickBrainChannel, readAgentDefaults } from "./agent-settings.js";
import { optimizePromptForWorkbench } from "./prompt-optimizer.js";
import { callBrain } from "./brain.js";
import { readThumbBytes, writeThumbnail } from "./vision.js";
import {
  VIDEO_CONFIRM_POLICIES, assetRef, DEFAULT_CONVERSATION_TITLE,
  type AgentStreamEvent, type ConversationInput, type ConversationPatch, type VideoConfirmPolicy,
} from "../shared/agent-types.js";
import { isChatAdapter } from "../shared/types.js";
import { midjourneyModelForCustomId } from "../shared/midjourney.js";
import { MAX_SCRIPT_CHARS, MAX_SCRIPT_TOTAL_CHARS } from "../shared/storyboard.js";
import { storyboardProjectDataSchema } from "../shared/storyboard-project.js";
import { claimBoardFrame, completeBoardFrame } from "./board-frame-broker.js";
import { resolveStoryboardSelection } from "./storyboard-selection.js";
import {
  addAssetsToBoard, appendConversationCanvasAssets,
  cancelBoardTask, createBoard, deleteBoard, detachAssetFromBoards, generateBoardConfig, getBoard,
  importBoard, listBoardAssets, listBoardHistory, listBoards, linkBoardAsset, redoBoard, removeBoardAsset, renameBoard,
  restoreBoardVersion, retryBoardTask, saveBoard,
  saveBoardSelection, saveBoardUiState, saveBoardViewport, storeBoardUpload, undoBoard,
} from "./board.js";
import {
  buildStoryboardTemplateInput, cleanupMigratedStoryboards, createBoardFromTemplate, createCanvasTemplate, importTemplateIntoBoard, migrateAllStoryboards,
} from "./canvas-template.js";

const adapterTypes = ["openai-images", "openai-chat-image", "gemini-content", "generic-json", "wan-video", "grok-video", "seedance-video", "kling-video", "suno-music", "gemini-tts", "midjourney", "openai-chat"] as const;
const authTypes = ["bearer", "x-api-key", "query", "custom-header", "none"] as const;
const referenceImageMimeTypes = ["image/png", "image/jpeg", "image/webp"] as const;
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
 * 对话框里自己上传的图（需求.md 问题 4）。
 *
 * 和生图工作台那个 `referenceUpload` 是两个入口，但**限额和校验是同一套**：
 * 单张 20MB、最多 8 张、PNG/JPEG/WebP。同一件事在两处给两种规矩，用户只会觉得坏了。
 */
const conversationUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_REFERENCE_IMAGE_BYTES + 1, files: MAX_REFERENCE_IMAGES, fields: 0 },
  fileFilter: (_req, file, callback) => referenceImageMimeTypes.includes(file.mimetype as typeof referenceImageMimeTypes[number])
    ? callback(null, true)
    : callback(new AppError("REFERENCE_IMAGE_INVALID", "仅支持 PNG、JPEG 或 WebP 图片", 400)),
});
/** 画布素材包括本地视频和音频；图片按 20 MB 限制。 */
const boardUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 0 },
});
const referenceVideoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 + 1, files: 1, fields: 1 },
  fileFilter: (_req, file, callback) => ["video/mp4", "video/quicktime"].includes(file.mimetype)
    ? callback(null, true) : callback(new AppError("REFERENCE_VIDEO_INVALID", "仅支持 MP4 / MOV 视频", 400)),
});

const channelSchema = z.object({
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().trim().url(),
  adapterType: z.enum(adapterTypes),
  authType: z.enum(authTypes),
  authHeaderName: z.string().trim().max(80).default(""),
  secretEnv: z.string().trim().regex(/^[A-Za-z_][A-Za-z0-9_]*$|^$/).default(""),
  endpoint: z.string().trim().max(300).default(""),
  uploadEndpoint: z.string().trim().url().or(z.literal("")).default(""),
  uploadHeaders: z.record(z.string(), z.string()).refine((headers) => Object.keys(headers).every((name) => !/authorization|cookie|token|secret|api[-_]?key|password/i.test(name)), "上传附加请求头不能包含密钥或鉴权信息").default({}),
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
  /** 音乐和语音分开设默认；旧的合并值仍接受，用于兼容老前端 */
  agentDefaultMusicAlias: z.string().trim().max(80).optional(),
  agentDefaultSpeechAlias: z.string().trim().max(80).optional(),
  agentDefaultAudioAlias: z.string().trim().max(80).optional(),
});

const conversationCreateSchema = z.object({
  title: z.string().trim().max(120).optional(),
  brainChannelId: z.string().uuid().optional(),
  brainModel: z.string().trim().min(1).max(200).optional(),
  videoConfirmPolicy: z.enum(VIDEO_CONFIRM_POLICIES).optional(),
  visionEnabled: z.boolean().optional(),
  verbatimPrompt: z.boolean().optional(),
});

const conversationPatchSchema = z.object({
  contextBudget: z.number().int().min(4000).max(2000000).optional(),
  chatAutoContinueLimit: z.number().int().min(0).max(100).optional(),
  chatMode: z.enum(["creative", "chat"]).optional(),
  title: z.string().trim().min(1).max(120).optional(),
  brainChannelId: z.string().uuid().optional(),
  brainModel: z.string().trim().min(1).max(200).optional(),
  videoConfirmPolicy: z.enum(VIDEO_CONFIRM_POLICIES).optional(),
  visionEnabled: z.boolean().optional(),
  verbatimPrompt: z.boolean().optional(),
  /** 画布整组替换，`[0]` 是主图；`[]` 是清空画布 */
  canvasAssetIds: z.array(z.string().uuid()).max(MAX_CANVAS_IMAGES).optional(),
  /**
   * @deprecated 老版本的单图画布指针。**留着不只是为了旧前端**：zod 默认把不认识的键
   * **剥掉而不是报错**，所以剥掉它 = 旧前端点一下「设为画布」**静默没反应**——
   * 静默 no-op 比 400 难查得多。归一成 `canvasAssetIds` 只要三行（见下面那条路由）。
   */
  currentAssetId: z.string().uuid().nullable().optional(),
});

const boardCreateSchema = z.object({
  title: z.string().trim().max(80).optional(),
});

const boardRenameSchema = z.object({
  title: z.string().trim().min(1).max(80),
});

const boardSaveSchema = z.object({
  doc: z.unknown(),
  viewport: z.unknown().optional(),
  baseVersion: z.coerce.number().int().min(1),
  reason: z.string().trim().max(200).optional(),
});

const boardVersionSchema = z.object({
  baseVersion: z.coerce.number().int().min(1),
});

const boardImportSchema = z.object({
  file: z.unknown(),
});

const boardBridgeSchema = z.object({
  items: z.array(z.object({
    assetId: z.string().trim().min(1).max(80),
    title: z.string().trim().max(80).optional(),
    prompt: z.string().max(20000).optional(),
  })).min(1).max(50),
});

const canvasAppendSchema = z.object({
  assetIds: z.array(z.string().trim().min(1).max(80)).min(1).max(50),
});

const templateImportSchema = z.object({
  templateId: z.string().trim().min(1).max(80),
  title: z.string().trim().max(80).optional(),
});

const boardTemplateSchema = z.object({
  templateId: z.string().trim().min(1).max(80),
});

const templateUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
});

const storyboardMigrationSchema = z.object({
  replaceExisting: z.boolean().optional(),
});

const boardSelectionSchema = z.object({
  selection: z.array(z.string().trim().min(1).max(80)).max(50),
});

const boardUiStateSchema = z.object({
  uiState: z.unknown(),
});

const boardViewportSchema = z.object({
  viewport: z.unknown(),
});

const boardGenerateSchema = z.object({
  nodeId: z.string().trim().min(1).max(80),
  overrides: z.object({
    prompt: z.string().max(20000).optional(),
    model: z.string().trim().max(80).optional(),
    size: z.string().trim().max(60).optional(),
    imageSize: z.enum(IMAGE_SIZE_VALUES).optional(),
    quality: z.string().trim().max(40).optional(),
    negativePrompt: z.string().trim().max(2_000).optional(),
    aspectRatio: z.string().trim().max(20).optional(),
    seed: z.coerce.number().int().min(0).max(2_147_483_647).optional(),
    style: z.enum(["auto", "vivid", "natural"]).optional(),
    background: z.enum(["auto", "opaque", "transparent"]).optional(),
    outputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
    moderation: z.enum(["auto", "low"]).optional(),
    count: z.coerce.number().int().min(1).max(8).optional(),
    videoMode: z.enum(BOARD_VIDEO_MODES).optional(),
    durationSeconds: z.coerce.number().int().min(1).max(30).optional(),
    resolution: z.string().trim().max(20).optional(),
    audio: z.boolean().optional(),
    promptExtend: z.boolean().optional(),
    watermark: z.boolean().optional(),
    audioKind: z.enum(BOARD_AUDIO_KINDS).optional(),
    voice: z.string().trim().max(40).optional(),
    ttsStyle: z.string().trim().max(200).optional(),
    instrumental: z.boolean().optional(),
    musicTitle: z.string().trim().max(80).optional(),
    musicTags: z.string().trim().max(1_000).optional(),
    musicNegativeTags: z.string().trim().max(1_000).optional(),
  }).optional(),
});

const messageCreateSchema = z.object({
  /** 文本消息；图片附件在 M1 之后补，届时放宽成可选 */
  text: z.string().trim().min(1).max(20000),
  /**
   * 这句话引用的一组已有产物（用户从画布/消息里把图拖进输入框）。
   * 上限和画布同一个数：这些图发送前会被并进画布，多出来的本来就进不去。
   */
  assetRefs: z.array(z.string().trim().min(1).max(80)).max(MAX_CANVAS_IMAGES).optional(),
});

const promptOptimizeSchema = z.object({
  prompt: z.string().trim().min(1).max(20000),
  target: z.enum(["image", "video", "dialogue", "sound"]),
});

const confirmSchema = z.object({
  messageId: z.string().uuid(),
  decision: z.enum(["approve", "reject"]),
  /** 卡片上改过的视频参数；服务端只认白名单里的几个旋钮（见 mergeConfirmArgs） */
  args: z.record(z.string(), z.unknown()).optional(),
});

const midjourneyActionSchema = z.object({
  customId: z.string().trim().min(1).max(500),
  label: z.string().trim().max(40).optional(),
});

/** 脚本文档：全文走 JSON；字数上限在路由里按总量再核一次 */
const conversationDocumentSchema = z.object({
  documents: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    // 字数上限在路由里检查，好给出「超过 N 字，请拆分」这种能直接照做的错误
    content: z.string().min(1),
  })).min(1).max(3),
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
  })).max(MAX_REFERENCE_IMAGES).optional(),
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
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
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

  // 预览仅存在内存里，随机地址配合 iframe 沙箱与独立 CSP 隔离生成代码。
  const htmlPreviews = new Map<string, { html: string; expires: number }>();
  app.post("/api/html-previews", (req, res) => {
    const { html } = z.object({ html: z.string().min(1).max(2_000_000) }).parse(req.body);
    const now = Date.now();
    for (const [id, entry] of htmlPreviews) if (entry.expires < now) htmlPreviews.delete(id);
    while (htmlPreviews.size >= 20) htmlPreviews.delete(htmlPreviews.keys().next().value!);
    const id = crypto.randomUUID();
    htmlPreviews.set(id, { html, expires: now + 30 * 60_000 });
    res.json(ok({ id }));
  });
  app.get("/api/html-previews/:id", (req, res) => {
    const preview = htmlPreviews.get(routeParam(req.params.id));
    if (!preview || preview.expires < Date.now()) return res.status(404).send("预览已过期，请重新运行。");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; sandbox allow-scripts");
    res.type("html").send(preview.html);
  });

  app.get("/api/bootstrap", (_req, res) => {
    res.json(ok({
      channels: db.listChannels().map((channel) => publicChannel(channel, sessionKeys)),
      tasks: db.listTaskViews(40),
      service: { version: APP_VERSION, dataPath: db.filePath, assetsPath: db.assetsDir, defaultAssetsPath: db.defaultAssetsDir },
    }));
  });

  // ── 无限画布（FREE_CANVAS_PLAN.md） ───────────────────────────────────────

  app.get("/api/boards", (_req, res) => {
    res.json(ok(listBoards(db)));
  });

  app.post("/api/boards", (req, res) => {
    const input = boardCreateSchema.parse(req.body ?? {});
    res.status(201).json(ok(createBoard(db, input)));
  });

  app.post("/api/boards/import", (req, res) => {
    const input = boardImportSchema.parse(req.body ?? {});
    res.status(201).json(ok(importBoard(db, { file: input.file })));
  });

  app.get("/api/storyboard-projects/:id", (req, res) => {
    const project = db.getStoryboardProject(routeParam(req.params.id));
    if (!project) return res.status(404).json(fail("STORYBOARD_NOT_FOUND", "该分镜没有可编辑的审阅数据"));
    res.json(ok(project));
  });

  app.post("/api/storyboard-projects/:id/split", asyncHandler(async (req, res) => {
    const input = z.object({ revision: z.number().int().positive(), shotId: z.string().min(1).max(80) }).parse(req.body);
    const id = routeParam(req.params.id);
    const project = db.getStoryboardProject(id);
    if (!project) throw new AppError("STORYBOARD_NOT_FOUND", "分镜不存在", 404);
    if (project.revision !== input.revision) throw new AppError("STORYBOARD_CONFLICT", "分镜已更改，请重新加载", 409);
    const shot = project.data.shots.find((item) => item.id === input.shotId);
    if (!shot) throw new AppError("STORYBOARD_SHOT_NOT_FOUND", "镜头不存在", 404);
    const conversationId = db.getStoryboardProjectConversationId(id);
    const conversation = conversationId ? db.getConversation(conversationId) : null;
    const channel = conversation ? db.getChannel(conversation.brainChannelId) : null;
    if (!conversation || !channel?.enabled || channel.adapterType !== "openai-chat") throw new AppError("NO_CHAT_CHANNEL", "原对话模型不可用，请先配置对话渠道", 400);
    const key = sessionKeys.get(channel.id) || (channel.secretEnv ? process.env[channel.secretEnv] ?? "" : "");
    const response = await callBrain({ channel, key, model: conversation.brainModel, timeoutMs: 120000, messages: [
      { role: "system", content: "你是分镜师。把给定的一个镜头拆为 2 个连续镜头，只返回 JSON 对象 {shots:[{prompt,videoPrompt,dialogue,sourceText,shotSize,cameraMove}]}。prompt 写静态首帧，videoPrompt 写动作和运镜。保留剧情、人物、道具和时空，绝不虚构台词；原台词按顺序分配，不要重复。不得改变原文原意。只输出 JSON。" },
      { role: "user", content: JSON.stringify({ brief: project.data.brief, shot }) },
    ] });
    if (db.getStoryboardProject(id)?.revision !== input.revision) throw new AppError("STORYBOARD_CONFLICT", "分镜在生成建议时已更改，请重新加载", 409);
    const clean = response.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let parsed: unknown;
    try { parsed = JSON.parse(clean); } catch { throw new AppError("STORYBOARD_SPLIT_INVALID", "模型没有返回有效的分镜建议，请重试", 502); }
    const schema = z.object({ shots: z.array(z.object({ prompt: z.string().trim().min(1).max(2000), videoPrompt: z.string().max(2000).default(""), dialogue: z.string().max(1000).default(""), sourceText: z.string().max(3000).default(""), shotSize: z.string().max(40).default(""), cameraMove: z.string().max(80).default("") })).length(2) });
    const parsedResult = schema.safeParse(parsed);
    if (!parsedResult.success) throw new AppError("STORYBOARD_SPLIT_INVALID", "模型返回的拆分建议不完整，请重试", 502);
    res.json(ok({ shots: parsedResult.data.shots }));
  }));

  app.get("/api/storyboard-projects/:id/preview", (req, res) => {
    const project = db.getStoryboardProject(routeParam(req.params.id));
    if (!project) return res.status(404).json(fail("STORYBOARD_NOT_FOUND", "分镜不存在"));
    const boards = db.listBoardRecords().flatMap((board) => {
      const nodes = board.doc.nodes.filter((node) => node.storyboard?.projectId === project.id);
      if (!nodes.length) return [];
      const shots = project.data.shots.map((shot) => {
        const getAsset = (role: "image" | "video" | "audio") => {
          const node = [...nodes].reverse().find((item) => item.storyboard?.shotId === shot.id && item.storyboard.role === role && (item.type === "image" || item.type === "video" || item.type === "audio"));
          if (!node || (node.type !== "image" && node.type !== "video" && node.type !== "audio") || !node.assetId) return null;
          const asset = db.getAsset(node.assetId);
          return asset ? db.assetView(asset) : null;
        };
        return { shotId: shot.id, image: getAsset("image"), video: getAsset("video"), audio: getAsset("audio") };
      });
      return [{ id: board.id, title: board.title, shots }];
    });
    res.json(ok(boards));
  });

  app.put("/api/storyboard-projects/:id", (req, res) => {
    const input = z.object({ revision: z.number().int().positive(), data: storyboardProjectDataSchema }).parse(req.body);
    const id = routeParam(req.params.id);
    for (const item of [...input.data.characters, ...input.data.scenes, ...input.data.props].flatMap((entry) => [entry, ...entry.variants])) {
      if (!item.assetId) continue;
      const asset = db.getAsset(item.assetId);
      const task = asset && db.getTaskRow(asset.taskId);
      const publicAsset = task?.libraryScope === "public" || (task?.libraryScope === "legacy" && db.listLibraryTaskViews().some((entry) => entry.id === task.id));
      if (!asset || !asset.mimeType.startsWith("image/") || !publicAsset) throw new AppError("STORYBOARD_ASSET_INVALID", `「${item.name}」的参考图不存在或不属于公共素材库`, 400);
    }
    if (!db.getStoryboardProject(id)) return res.status(404).json(fail("STORYBOARD_NOT_FOUND", "分镜不存在"));
    const project = db.updateStoryboardProject(id, input.revision, input.data);
    if (!project) return res.status(409).json(fail("STORYBOARD_CONFLICT", "分镜已在其他窗口修改，请重新加载后再保存"));
    res.json(ok(project));
  });

  app.post("/api/storyboard-projects/:id/templates", (req, res) => {
    const input = z.object({ revision: z.number().int().positive(), shotIds: z.array(z.string().min(1).max(80)).min(1).max(30) }).parse(req.body);
    const project = db.getStoryboardProject(routeParam(req.params.id));
    if (!project) return res.status(404).json(fail("STORYBOARD_NOT_FOUND", "分镜不存在"));
    if (project.revision !== input.revision) return res.status(409).json(fail("STORYBOARD_CONFLICT", "分镜已更改，请重新加载"));
    const ids = new Set(input.shotIds);
    if (ids.size !== input.shotIds.length || input.shotIds.some((id) => !project.data.shots.some((shot) => shot.id === id))) {
      return res.status(400).json(fail("STORYBOARD_SHOTS_INVALID", "所选镜头不存在或重复"));
    }
    const { shots, characters, scenes, props } = resolveStoryboardSelection(project.data, ids);
    const template = createCanvasTemplate(db, buildStoryboardTemplateInput({
      name: project.data.name, projectId: project.id, description: `选择的 ${shots.length} 个镜头；导入后不会自动生成。`, shots, characters, scenes, props,
    }), { source: "storyboard" });
    const bindings = [...characters.map((item) => ({ title: `角色 · ${item.name}`.slice(0, 80), assetId: item.assetId })),
      ...scenes.map((item) => ({ title: `场景 · ${item.name}`.slice(0, 80), assetId: item.assetId })),
      ...props.map((item) => ({ title: `道具 · ${item.name}`.slice(0, 80), assetId: item.assetId }))];
    db.setStoryboardTemplateAssets(template.id, bindings.flatMap((binding) => {
      const node = template.doc.nodes.find((item) => item.type === "image" && item.title === binding.title);
      return node && binding.assetId ? [{ nodeId: node.id, assetId: binding.assetId }] : [];
    }));
    res.status(201).json(ok(template));
  });

  app.get("/api/templates", (_req, res) => {
    res.json(ok(db.listCanvasTemplateSummaries()));
  });

  app.post("/api/templates/migrate-storyboards", (req, res) => {
    const input = storyboardMigrationSchema.parse(req.body ?? {});
    res.json(ok(migrateAllStoryboards(db, { replaceExisting: input.replaceExisting })));
  });

  app.post("/api/templates/cleanup-storyboards", (_req, res) => {
    res.json(ok(cleanupMigratedStoryboards(db)));
  });

  app.get("/api/templates/:id", (req, res) => {
    const template = db.getCanvasTemplate(routeParam(req.params.id));
    if (!template) return res.status(404).json(fail("TEMPLATE_NOT_FOUND", "模板不存在"));
    res.json(ok(template));
  });

  app.patch("/api/templates/:id", (req, res) => {
    const input = templateUpdateSchema.parse(req.body ?? {});
    const template = db.updateCanvasTemplate(routeParam(req.params.id), input);
    if (!template) return res.status(404).json(fail("TEMPLATE_NOT_FOUND", "模板不存在"));
    res.json(ok(template));
  });

  app.delete("/api/templates/:id", (req, res) => {
    if (!db.deleteCanvasTemplate(routeParam(req.params.id))) {
      return res.status(404).json(fail("TEMPLATE_NOT_FOUND", "模板不存在"));
    }
    res.json(ok({ deleted: true }));
  });

  app.post("/api/boards/from-template", (req, res) => {
    const input = templateImportSchema.parse(req.body ?? {});
    res.status(201).json(ok(createBoardFromTemplate(db, input.templateId, input.title)));
  });

  app.post("/api/boards/:id/templates", (req, res) => {
    const input = boardTemplateSchema.parse(req.body ?? {});
    res.json(ok(importTemplateIntoBoard(db, routeParam(req.params.id), input.templateId)));
  });

  app.get("/api/boards/:id", (req, res) => {
    const board = getBoard(db, routeParam(req.params.id));
    if (!board) return res.status(404).json(fail("BOARD_NOT_FOUND", "无限画布不存在"));
    res.json(ok(board));
  });

  app.patch("/api/boards/:id", (req, res) => {
    const input = boardRenameSchema.parse(req.body ?? {});
    res.json(ok(renameBoard(db, routeParam(req.params.id), input.title)));
  });

  app.put("/api/boards/:id", (req, res) => {
    const input = boardSaveSchema.parse(req.body ?? {});
    res.json(ok(saveBoard(db, routeParam(req.params.id), {
      doc: input.doc,
      ...(input.viewport === undefined ? {} : { viewport: input.viewport }),
      baseVersion: input.baseVersion,
      ...(input.reason ? { reason: input.reason } : {}),
    })));
  });

  app.put("/api/boards/:id/selection", (req, res) => {
    const input = boardSelectionSchema.parse(req.body ?? {});
    saveBoardSelection(db, routeParam(req.params.id), input.selection);
    res.json(ok({ saved: true }));
  });

  app.put("/api/boards/:id/ui-state", (req, res) => {
    const input = boardUiStateSchema.parse(req.body ?? {});
    saveBoardUiState(db, routeParam(req.params.id), input.uiState);
    res.json(ok({ saved: true }));
  });

  app.put("/api/boards/:id/viewport", (req, res) => {
    const input = boardViewportSchema.parse(req.body ?? {});
    res.json(ok(saveBoardViewport(db, routeParam(req.params.id), input.viewport)));
  });

  app.post("/api/boards/:id/undo", (req, res) => {
    const input = boardVersionSchema.parse(req.body ?? {});
    res.json(ok(undoBoard(db, routeParam(req.params.id), input.baseVersion)));
  });

  app.post("/api/boards/:id/redo", (req, res) => {
    const input = boardVersionSchema.parse(req.body ?? {});
    res.json(ok(redoBoard(db, routeParam(req.params.id), input.baseVersion)));
  });

  app.post("/api/boards/:id/frame-requests/:requestId/claim", (req, res) => {
    const claimed = claimBoardFrame(routeParam(req.params.id), routeParam(req.params.requestId));
    res.json(ok({ claimed }));
  });

  app.post("/api/boards/:id/frame-requests/:requestId/complete", (req, res) => {
    const input = z.object({ assetId: z.string().max(80).optional(), error: z.string().max(500).optional() }).refine((value) => Boolean(value.assetId) !== Boolean(value.error)).parse(req.body);
    if (!completeBoardFrame(routeParam(req.params.id), routeParam(req.params.requestId), input)) return res.status(404).json(fail("FRAME_REQUEST_NOT_FOUND", "提取请求已结束或不存在"));
    res.json(ok({ accepted: true }));
  });

  app.get("/api/boards/:id/nodes/:nodeId/versions", (req, res) => {
    const boardId = routeParam(req.params.id);
    const nodeId = routeParam(req.params.nodeId);
    const board = db.getBoardRecord(boardId);
    if (!board) return res.status(404).json(fail("BOARD_NOT_FOUND", "画布不存在"));
    const node = board.doc.nodes.find((item) => item.id === nodeId);
    if (!node || (node.type !== "image" && node.type !== "video" && node.type !== "audio")) return res.status(404).json(fail("BOARD_NODE_NOT_FOUND", "素材节点不存在"));
    const rows = db.listBoardTasksByBoard(boardId).filter((item) => item.resultNodeId === nodeId).reverse();
    const seen = new Set<string>();
    const tasks = rows.flatMap((row) => {
      if (seen.has(row.taskId)) return [];
      seen.add(row.taskId);
      const task = db.getTaskView(row.taskId);
      if (!task || task.status !== "succeeded") return [];
      const resultRows = db.listBoardTasksByTask(row.taskId).filter((entry) => entry.boardId === boardId);
      const index = resultRows.findIndex((entry) => entry.resultNodeId === nodeId);
      const asset = task.assets.filter((entry) => entry.mimeType.startsWith(`${node.type}/`))[index];
      return asset ? [{ ...task, assets: [asset] }] : [];
    }).slice(0, 50);
    res.json(ok(tasks));
  });

  app.get("/api/boards/:id/history", (req, res) => {
    res.json(ok(listBoardHistory(db, routeParam(req.params.id))));
  });

  app.post("/api/boards/:id/history/:version/restore", (req, res) => {
    const input = boardVersionSchema.parse(req.body ?? {});
    const version = Number(routeParam(req.params.version));
    res.json(ok(restoreBoardVersion(db, routeParam(req.params.id), version, input.baseVersion)));
  });

  app.post("/api/boards/:id/generate", asyncHandler(async (req, res) => {
    const input = boardGenerateSchema.parse(req.body ?? {});
    res.status(202).json(ok(await generateBoardConfig({
      db,
      runner,
      keys: sessionKeys,
      boardId: routeParam(req.params.id),
      nodeId: input.nodeId,
      ...(input.overrides ? { overrides: input.overrides } : {}),
    })));
  }));

  app.post("/api/boards/:id/tasks/:taskId/cancel", (req, res) => {
    res.json(ok(cancelBoardTask(db, runner, routeParam(req.params.id), routeParam(req.params.taskId))));
  });

  app.post("/api/boards/:id/tasks/:taskId/retry", asyncHandler(async (req, res) => {
    res.json(ok(await retryBoardTask({
      db,
      runner,
      boardId: routeParam(req.params.id),
      taskId: routeParam(req.params.taskId),
    })));
  }));

  app.get("/api/boards/:id/assets", (req, res) => {
    res.json(ok(listBoardAssets(db, routeParam(req.params.id))));
  });

  app.post("/api/boards/:id/assets", boardUpload.single("file"), asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError("UPLOAD_EMPTY", "没有收到图片", 400);
    const asset = await storeBoardUpload(db, routeParam(req.params.id), {
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      originalname: req.file.originalname,
    });
    res.status(201).json(ok(asset));
  }));

  app.post("/api/boards/:id/assets/:assetId/link", (req, res) => {
    res.json(ok(linkBoardAsset(db, routeParam(req.params.id), routeParam(req.params.assetId))));
  });

  app.delete("/api/boards/:id/assets/:assetId", (req, res) => {
    res.json(ok(removeBoardAsset(db, routeParam(req.params.id), routeParam(req.params.assetId))));
  });

  // 跨模式桥：分镜 / 其他来源的已有素材 → 无限画布节点
  app.post("/api/boards/:id/bridge/assets", (req, res) => {
    const input = boardBridgeSchema.parse(req.body ?? {});
    res.json(ok(addAssetsToBoard(db, routeParam(req.params.id), input.items)));
  });

  app.delete("/api/boards/:id", (req, res) => {
    res.json(ok(deleteBoard(db, routeParam(req.params.id))));
  });

  /**
   * 无限画布线程也复用 conversations 表，但它没有分镜、脚本文档和参考图组。
   * 这些对话专属子路由要明确拒绝，避免从外部调接口把两类数据串在一起。
   */
  const chatThreadOnly = (req: Request, res: Response, next: NextFunction) => {
    const id = routeParam(req.params.id);
    const conversation = id ? db.getConversation(id) : null;
    if (!conversation) return res.status(404).json(fail("CONVERSATION_NOT_FOUND", "会话不存在"));
    if (conversation.kind !== "chat") {
      return res.status(400).json(fail("CONVERSATION_NOT_CHAT", "这个操作只支持普通对话", crypto.randomUUID()));
    }
    next();
  };
  app.use("/api/conversations/:id/documents", chatThreadOnly);
  app.use("/api/conversations/:id/uploads", chatThreadOnly);
  app.use("/api/conversations/:id/assets", chatThreadOnly);

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
    if (input.agentDefaultMusicAlias !== undefined) db.setSetting("agentDefaultMusicAlias", input.agentDefaultMusicAlias);
    if (input.agentDefaultSpeechAlias !== undefined) db.setSetting("agentDefaultSpeechAlias", input.agentDefaultSpeechAlias);
    if (input.agentDefaultAudioAlias !== undefined) db.setSetting("agentDefaultAudioAlias", input.agentDefaultAudioAlias);
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

  app.post("/api/uploads/reference-video", referenceVideoUpload.single("file"), asyncHandler(async (req, res) => {
    const channel = db.getChannel(String(req.body.channelId ?? ""));
    if (!channel) throw new AppError("CHANNEL_NOT_FOUND", "渠道不存在", 404);
    if (!req.file) throw new AppError("UPLOAD_EMPTY", "没有收到视频文件", 400);
    const url = await uploadReferenceVideo(channel, sessionKeys, req.file);
    res.status(201).json(ok({ url }));
  }));

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

  app.post("/api/generations", referenceUpload.fields([
    { name: "referenceImages", maxCount: MAX_REFERENCE_IMAGES },
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
    if (req.query.limit === undefined) return res.json(ok(db.listLibraryTaskViews()));
    const limit = Math.max(1, Math.min(100, Math.floor(Number(req.query.limit) || 60)));
    const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0));
    const kind = req.query.kind === "image" || req.query.kind === "video" || req.query.kind === "audio" ? req.query.kind : "all";
    const mode = req.query.mode === "assets" || req.query.mode === "records" ? req.query.mode : "all";
    const items = db.listLibraryTaskViews({ limit: limit + 1, offset, query: String(req.query.q ?? "").slice(0, 200), kind, mode });
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

  // 工作台任务状态流：仅广播公共任务，不把对话私有素材推到工作台。
  app.get("/api/generations/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(":ok\n\n");
    const unsubscribe = runner.onTaskEvent((event) => {
      if (db.getTaskRow(event.task.id)?.libraryScope === "public") {
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
        alias: alias.alias, kind: alias.kind, model: alias.model,
        channelName: alias.channelName, channelId: alias.channelId,
        // 音乐和语音同属 audio，前端要靠适配器把两类分开
        adapterType: alias.adapterType,
      })),
    }));
  });

  /** 生图 / 生视频工作台的「润色」：挑一个可用对话渠道改写提示词，不生成图片 */
  app.post("/api/prompt/optimize", asyncHandler(async (req, res) => {
    const input = promptOptimizeSchema.parse(req.body ?? {});
    res.json(ok(await optimizePromptForWorkbench(db, sessionKeys, input)));
  }));

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
    /*
     * 新建之前先把之前没动过的空会话删掉。
     *
     * 「点一下新对话就多一条新会话」是想要的行为，但空壳会越堆越多（用户的实际现象：
     * 侧栏一屏全是「新对话」）。空会话没有任何消息，也就没有产物、没有上传图，删了不丢东西。
     * 正在跑的那条跳过：一轮开始时会立刻落用户消息，正常情况下这里轮不到它。
     */
    for (const staleId of db.emptyConversationIds()) {
      if (agent.isRunning(staleId)) continue;
      db.deleteConversation(staleId);
    }
    const brain = pickBrainChannel(db, input.brainChannelId, input.brainModel);
    const conversation = db.createConversation({
      title: input.title?.trim() || DEFAULT_CONVERSATION_TITLE,
      brainChannelId: brain.channelId,
      brainModel: brain.model,
      videoConfirmPolicy: input.videoConfirmPolicy ?? readAgentDefaults(db).videoConfirmPolicy,
      visionEnabled: input.visionEnabled ?? readAgentDefaults(db).visionEnabled,
      verbatimPrompt: input.verbatimPrompt ?? false,
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
    const conversation = db.getConversation(id);
    if (!conversation) return res.status(404).json(fail("CONVERSATION_NOT_FOUND", "会话不存在"));
    const patch = conversationPatchSchema.parse(req.body ?? {}) as ConversationPatch;
    if (conversation.kind !== "chat" && Object.keys(patch).some((key) => key !== "contextBudget")) {
      return res.status(400).json(fail("CONVERSATION_NOT_CHAT", "画布助手只允许修改上下文预算", crypto.randomUUID()));
    }
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
    const conversation = db.getConversation(id);
    if (!conversation) return res.status(404).json(fail("CONVERSATION_NOT_FOUND", "会话不存在"));
    // 无限画布线程跟着板走，不能从对话删除入口删
    if (conversation.kind !== "chat") {
      return res.status(400).json(fail("CONVERSATION_NOT_CHAT", "无限画布请从无限画布入口删除", crypto.randomUUID()));
    }
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
  /**
   * 素材库里删除一张图。
   *
   * 只允许删本会话素材列表里出现的图；删除任务 / 文件后再把消息、画布、分镜、
   * 角色场景里的引用断掉，返回整份会话视图，前端不用自己猜哪里变了。
   */
  app.delete("/api/conversations/:id/assets/:assetId", asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const assetId = routeParam(req.params.assetId);
    if (!db.getConversation(id)) throw new AppError("CONVERSATION_NOT_FOUND", "会话不存在", 404);
    const belongs = db.listConversationAssets(id).some((entry) => entry.asset.id === assetId);
    if (!belongs) throw new AppError("ASSET_NOT_FOUND", "这张图不属于当前会话", 404);
    const asset = db.getAsset(assetId);
    if (asset && (db.getTaskRow(asset.taskId)?.libraryScope === "public" || db.findBoardAssetRefs(assetId).length > 0 || db.assetHasOtherConversationReferences(assetId, id))) {
      throw new AppError("ASSET_SHARED", "该素材也属于公共素材或被画布引用，请先在相应位置处理，避免影响其他作品。", 409);
    }
    const removed = db.deleteConversationAsset(id, assetId);
    if (!removed) throw new AppError("ASSET_NOT_FOUND", "图片不存在", 404);
    await removeStoredFiles(removed.files, removed.inputs, db.inputsDir);
    const view = agent.buildView(id);
    if (!view) throw new AppError("CONVERSATION_NOT_FOUND", "会话不存在", 404);
    res.json(ok(view));
  }));

  // 跨模式桥：无限画布 → 某个对话的参考图组
  app.post("/api/conversations/:id/canvas/append", chatThreadOnly, (req, res) => {
    const input = canvasAppendSchema.parse(req.body ?? {});
    res.json(ok(appendConversationCanvasAssets(db, routeParam(req.params.id), input.assetIds)));
  });

  app.post("/api/conversations/:id/messages", (req, res) => {
    const id = routeParam(req.params.id);
    if (!db.getConversation(id)) return res.status(404).json(fail("CONVERSATION_NOT_FOUND", "会话不存在"));
    const input = messageCreateSchema.parse(req.body ?? {});
    agent.startTurn(id, input.text, "user", input.assetRefs ?? []);
    res.status(202).json(ok({ accepted: true }));
  });

  app.post("/api/conversations/:id/compress", asyncHandler(async (req, res) => {
    const result = await agent.compressNow(routeParam(req.params.id));
    res.json(ok(result));
  }));

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
        input: {}, origin: "upload", libraryScope: "conversation", ownerConversationId: id, status: "succeeded",
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
   * 往会话里传脚本文档（.txt / .md）。
   *
   * 和上传图片同一套「先落库、再挂一条 user 消息」：那条消息只写文件名和字数，
   * 全文存进 conversation_documents——聊天记录里塞几万字，用户和大脑都会被淹。
   * 全文只在**紧接着的那一轮**作为素材喂给大脑，之后靠分镜表的 source_text 回溯。
   */
  app.post("/api/conversations/:id/documents", asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    if (!db.getConversation(id)) throw new AppError("CONVERSATION_NOT_FOUND", "会话不存在", 404);
    const input = conversationDocumentSchema.parse(req.body ?? {});
    const total = input.documents.reduce((sum, doc) => sum + doc.content.length, 0);
    if (total > MAX_SCRIPT_TOTAL_CHARS) {
      throw new AppError("SCRIPT_TOO_LONG", `脚本文档合计最多 ${MAX_SCRIPT_TOTAL_CHARS.toLocaleString()} 字，请拆分后再传`, 400);
    }

    const refs = input.documents.map((doc) => {
      // BOM 和 NUL 对文本没有意义，却会悄悄占字数、让模型看到乱码
      const content = doc.content.replace(/^﻿/, "").replace(/\0/g, "");
      if (!content.trim()) throw new AppError("SCRIPT_EMPTY", "脚本文档是空的", 400);
      if (content.length > MAX_SCRIPT_CHARS) {
        throw new AppError("SCRIPT_TOO_LONG", `《${displayFileName(doc.name)}》超过 ${MAX_SCRIPT_CHARS.toLocaleString()} 字，请拆分后再传`, 400);
      }
      const name = displayFileName(doc.name);
      const stored = db.addConversationDocument(id, name, content);
      return { id: stored.id, name: stored.fileName, charCount: stored.charCount };
    });

    const names = refs.map((ref) => `《${ref.name}》`).join("");
    db.appendMessage({
      conversationId: id, role: "user",
      content: `上传了脚本文档 ${names}（共 ${refs.reduce((sum, ref) => sum + ref.charCount, 0).toLocaleString()} 字）`,
      documents: refs,
    });
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
  app.delete("/api/assets/:id", asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const asset = db.getAsset(id);
    if (!asset) throw new AppError("ASSET_NOT_FOUND", "素材不存在", 404);
    if (db.assetHasStoryboardProjectReferences(id)) throw new AppError("ASSET_SHARED", "此素材正在用作分镜设定参考图，请先在分镜审阅中解除绑定。", 409);
    const task = db.getTaskRow(asset.taskId);
    if (!task || task.libraryScope === "conversation" || db.taskHasConversationReferences(asset.taskId)) {
      throw new AppError("ASSET_SHARED", "该素材属于或被对话引用，请先解除对话引用。", 409);
    }
    if (db.findBoardAssetRefs(id).length) {
      throw new AppError("ASSET_SHARED", "该素材正在画布中使用，请先从画布移除。", 409);
    }
    const files = db.deletePublicAsset(id);
    await removeStoredFiles(files, [], db.inputsDir);
    res.json(ok({ deleted: true }));
  }));

  app.get("/api/assets/:id/thumb", asyncHandler(async (req, res) => {
    const asset = db.getAsset(routeParam(req.params.id));
    if (!asset) throw new AppError("ASSET_NOT_FOUND", "产物不存在", 404);
    // 音频的缩略图是封面；视频没有缩略图
    if (!asset.mimeType.startsWith("image/") && !asset.mimeType.startsWith("audio/")) {
      throw new AppError("ASSET_NOT_IMAGE", "该产物没有缩略图", 404);
    }
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
    if (req.query.download === "1") return res.download(absolutePath, assetDownloadName(asset));
    res.type(asset.mimeType).sendFile(absolutePath);
  });

  const clientDir = path.resolve("dist/client");
  if (fs.existsSync(clientDir)) {
    app.use(express.static(clientDir, { index: false }));
    app.get("*path", (_req, res) => res.sendFile(path.join(clientDir, "index.html")));
  }

  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestId = crypto.randomUUID();
    if (error instanceof multer.MulterError) {
      // .fields() 之后 field 会告诉我们是哪一路文件超限，别把蒙版的错误说成「参考图最多 8 张」
      if (error.code === "LIMIT_FILE_SIZE") {
        const message = /^\/api\/boards\/[^/]+\/assets$/.test(req.path) || req.path === "/api/uploads/reference-video" ? "素材文件不能超过 100 MB" : error.field === "mask" ? "蒙版不能超过 20 MB" : "单张参考图不能超过 20 MB";
        return res.status(400).json(fail("INVALID_REFERENCE_IMAGES", message, requestId));
      }
      if (error.code === "LIMIT_UNEXPECTED_FILE" && error.field === "mask") {
        return res.status(400).json(fail("INVALID_MASK", "蒙版最多上传 1 张", requestId));
      }
      if (error.code === "LIMIT_FILE_COUNT") {
        return res.status(400).json(fail("INVALID_REFERENCE_IMAGES", "上传的图片数量超出限制", requestId));
      }
      return res.status(400).json(fail("INVALID_REFERENCE_IMAGES", `参考图最多上传 ${MAX_REFERENCE_IMAGES} 张`, requestId));
    }
    if (error instanceof z.ZodError) {
      return res.status(400).json(fail("INVALID_INPUT", "输入数据无效", requestId, error.issues));
    }
    const normalized = normalizeError(error);
    // 5xx 是服务端自己的问题：把堆栈留在终端里，前端只能看到一句重试提示
    if (normalized.status >= 500) {
      console.error(`[api ${requestId}] ${normalized.code}: ${normalized.message}`, error);
    }
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
    // mj_edits 不再作为可选模型展示：有参考图时 mj_imagine 会自动走图生图接口
    ...(channel.adapterType === "midjourney"
      ? { models: channel.models.filter((model) => model !== "mj_edits") }
      : {}),
    hasKey: channel.authType === "none" || Boolean(sessionKeys.get(channel.id) || (channel.secretEnv && process.env[channel.secretEnv])),
  };
}

/**
 * gemini 渠道缺省补的尺寸（需求.md 问题 1）。
 *
 * 设置表是纯 key/value 的字符串，谁都能写脏，所以读的时候必须再校验一次——
 * 把一个非法值补进请求体只会把「参数缺失」换成「参数非法」，还是照样失败。
 */
/**
 * 下载时用的文件名。
 *
 * 磁盘上的 `file_name` 可能是旧版本写错的扩展名（Gemini 图片曾被当成音频存成 .m4a），
 * 扩展名和 mimeType 对不上时以 mimeType 为准，否则用户下载到一张打不开的图。
 */
function assetDownloadName(asset: { fileName: string; mimeType: string }): string {
  const current = asset.fileName.split(".").pop()?.toLowerCase() ?? "";
  const compatible = asset.mimeType.startsWith("image/")
    ? ["png", "jpg", "jpeg", "webp", "gif"]
    : asset.mimeType.startsWith("video/")
      ? ["mp4", "webm", "mov", "m4v", "mkv"]
      : asset.mimeType.startsWith("audio/")
        ? ["wav", "mp3", "m4a", "aac", "ogg", "flac"]
        : [];
  const extension = compatible.includes(current)
    ? current
    : asset.mimeType === "image/jpeg" ? "jpg"
      : asset.mimeType === "image/webp" ? "webp"
        : asset.mimeType.includes("mpeg") ? "mp3"
          : asset.mimeType.includes("wav") ? "wav"
            : asset.mimeType.startsWith("video/") ? "mp4"
              : asset.mimeType.startsWith("audio/") ? "m4a" : "png";
  const stem = asset.fileName.replace(/\.[^.]+$/, "") || "asset";
  return `${stem}.${extension}`;
}

function readGeminiImageSize(db: AppDatabase): ImageSizeValue {
  return normalizeImageSize(db.getSetting("geminiImageSize")) ?? DEFAULT_IMAGE_SIZE;
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
