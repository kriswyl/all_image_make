import { z } from "zod";
import type { ChannelInput } from "../../shared/types.js";
import { IMAGE_SIZE_VALUES } from "../../shared/types.js";
import type { AppDatabase } from "../db.js";
import type { KeyStore } from "../key-store.js";
import { uploadReferenceVideo } from "../reference-video.js";
import { AppError, normalizeError } from "../tasks.js";
import { assertEndpoint, assertSafeUrl, redact } from "../security.js";
import { buildConnectionTestRequest, requestForDiagnostic, sendPreparedRequest } from "../adapters.js";
import { readAgentDefaults } from "../agent-settings.js";
import { callBrain } from "../brain.js";
import { probeToolProtocol, readToolProtocol, recordToolProtocol } from "../tool-protocol.js";
import { VIDEO_CONFIRM_POLICIES, IMAGE_CONFIRM_POLICIES } from "../../shared/agent-types.js";
import { referenceVideoUpload } from "./uploads.js";
import { publicChannel, readGeminiImageSize, resolveChannelKey } from "./channel-config.js";
import { ok, fail, asyncHandler, routeParam } from "./http.js";
import type { Express } from "express";

const adapterTypes = ["openai-images", "openai-chat-image", "gemini-content", "generic-json", "wan-video", "grok-video", "seedance-video", "kling-video", "suno-music", "gemini-tts", "midjourney", "openai-chat"] as const;

const authTypes = ["bearer", "x-api-key", "query", "custom-header", "none"] as const;

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
  documentsDir: z.string().trim().max(1000).optional(),
  /** 新建会话时的视频确认策略默认值（§13.2） */
  agentVideoConfirmPolicy: z.enum(VIDEO_CONFIRM_POLICIES).optional(),
  /** 单张生图/改图是否直接提交；批量始终确认 */
  agentImageConfirmPolicy: z.enum(IMAGE_CONFIRM_POLICIES).optional(),
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

export function registerChannelRoutes(app: Express, db: AppDatabase, sessionKeys: KeyStore) {
  app.get("/api/settings", (_req, res) => {
    res.json(ok({
      assetsDir: db.assetsDir,
      defaultAssetsDir: db.defaultAssetsDir,
      documentsDir: db.documentsDir,
      defaultDocumentsDir: db.defaultDocumentsDir,
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
    let documentsDir = db.documentsDir;
    if (input.documentsDir !== undefined) {
      try {
        documentsDir = input.documentsDir === "" ? db.resetDocumentsDir() : db.setDocumentsDir(input.documentsDir);
      } catch (error) {
        throw new AppError("INVALID_DOCUMENTS_DIR", error instanceof Error ? error.message : "文档目录无效", 400);
      }
    }
    if (input.agentVideoConfirmPolicy !== undefined) db.setSetting("agentVideoConfirmPolicy", input.agentVideoConfirmPolicy);
    if (input.agentImageConfirmPolicy !== undefined) {
      db.setSetting("agentImageConfirmPolicy", input.agentImageConfirmPolicy);
      // The composer no longer exposes a per-conversation switch; keep existing
      // conversations in sync so changing the global setting takes effect now.
      db.setAllImageConfirmPolicy(input.agentImageConfirmPolicy);
    }
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
      documentsDir,
      defaultDocumentsDir: db.defaultDocumentsDir,
      geminiImageSize: readGeminiImageSize(db),
      ...readAgentDefaults(db),
    }));
  }));

  app.post("/api/settings/cleanup-documents", (_req, res) => {
    res.json(ok({ deleted: db.cleanupWorkspaceVersions(3) }));
  });

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

  app.patch("/api/channels/:id/unified-agent", (req, res) => {
    const id = routeParam(req.params.id);
    if (!db.getChannel(id)) return res.status(404).json(fail("CHANNEL_NOT_FOUND", "渠道不存在"));
    const input = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
    const saved = db.setChannelUnifiedAgentDefault(id, input.enabled);
    res.json(ok(publicChannel(saved!, sessionKeys)));
  });

  app.delete("/api/channels/:id", (req, res) => {
    const id = routeParam(req.params.id);
    if (!db.getChannel(id)) return res.status(404).json(fail("CHANNEL_NOT_FOUND", "渠道不存在"));
    db.deleteChannel(id);
    sessionKeys.delete(id);
    res.json(ok({ deleted: true }));
  });

  const protocolProbes = new Set<string>();
  app.get("/api/channels/:id/tool-protocol", (req, res) => {
    const channel = db.getChannel(routeParam(req.params.id));
    const model = z.string().min(1).parse(req.query.model);
    if (!channel || channel.adapterType !== "openai-chat" || !channel.models.includes(model)) throw new AppError("CHANNEL_NOT_FOUND", "找不到该对话渠道或模型", 404);
    res.json(ok(readToolProtocol(db, channel, model)));
  });
  app.post("/api/channels/:id/tool-protocol", asyncHandler(async (req, res) => {
    const channel = db.getChannel(routeParam(req.params.id));
    const { model } = z.object({ model: z.string().min(1) }).parse(req.body);
    if (!channel || !channel.enabled || channel.adapterType !== "openai-chat" || !channel.models.includes(model)) throw new AppError("CHANNEL_NOT_FOUND", "对话渠道或模型不可用", 404);
    if (protocolProbes.has(channel.id)) throw new AppError("PROBE_IN_PROGRESS", "此渠道正在检测工具协议", 409);
    const key = sessionKeys.get(channel.id) || (channel.secretEnv ? process.env[channel.secretEnv] ?? "" : "");
    if (!key && channel.authType !== "none") throw new AppError("CHANNEL_AUTH_FAILED", "渠道尚未配置密钥", 400);
    protocolProbes.add(channel.id);
    try {
      const result = await probeToolProtocol(options => callBrain({ ...options, channel, key, model, timeoutMs:90_000 }));
      // A concurrent configuration edit must not certify the new channel with old evidence.
      if (db.getChannel(channel.id)?.updatedAt !== channel.updatedAt) throw new AppError("CHANNEL_CHANGED", "检测期间渠道配置已变化，请重新检测", 409);
      const protocol = recordToolProtocol(db, channel, model, result.features, "probe");
      if (result.features.tools) for (const conversation of db.listConversations()) {
        if (conversation.brainChannelId === channel.id && conversation.brainModel === model && conversation.toolsUnsupported) db.updateConversation(conversation.id, { toolsUnsupported:false });
      }
      res.json(ok({ protocol, results: result.results }));
    } finally { protocolProbes.delete(channel.id); }
  }));

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
}
