import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import multer from "multer";
import { z } from "zod";
import { MAX_CANVAS_IMAGES, MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES } from "../../shared/types.js";
import type { AppDatabase } from "../db.js";
import type { KeyStore } from "../key-store.js";
import { AppError, extensionForMime, matchesImageSignature, type ReferenceImageUpload } from "../tasks.js";
import { displayFileName, safeFileName } from "../security.js";
import type { AgentService } from "../agent.js";
import { buildCapabilityAliases, buildCapabilityManifest } from "../capabilities.js";
import { pickBrainChannel, readAgentDefaults } from "../agent-settings.js";
import { optimizePromptForWorkbench } from "../prompt-optimizer.js";
import { writeThumbnail } from "../vision.js";
import { VIDEO_CONFIRM_POLICIES, IMAGE_CONFIRM_POLICIES, DEFAULT_CONVERSATION_TITLE, type AgentStreamEvent, type ConversationInput, type ConversationPatch } from "../../shared/agent-types.js";
import { isChatAdapter } from "../../shared/types.js";
import { appendConversationCanvasAssets } from "../board.js";
import { referenceImageMimeTypes } from "./uploads.js";
import { removeStoredFiles } from "./files.js";
import { ok, fail, asyncHandler, routeParam } from "./http.js";
import type { Express, RequestHandler } from "express";

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

const conversationCreateSchema = z.object({
  title: z.string().trim().max(120).optional(),
  brainChannelId: z.string().uuid().optional(),
  brainModel: z.string().trim().min(1).max(200).optional(),
  videoConfirmPolicy: z.enum(VIDEO_CONFIRM_POLICIES).optional(),
  imageConfirmPolicy: z.enum(IMAGE_CONFIRM_POLICIES).optional(),
  visionEnabled: z.boolean().optional(),
  verbatimPrompt: z.boolean().optional(),
  toolScope: z.enum(["all", "conversation"]).optional(),
});

const conversationPatchSchema = z.object({
  contextBudget: z.number().int().min(4000).max(2000000).optional(),
  chatAutoContinueLimit: z.number().int().min(0).max(100).optional(),
  chatToolRoundLimit: z.number().int().min(1).max(100).optional(),
  chatModelCallLimit: z.number().int().min(1).max(1000).optional(),
  chatTurnMinutes: z.number().int().min(1).max(180).optional(),
  chatTokenLimit: z.number().int().min(0).max(10000000).optional(),
  boardMaxRounds: z.number().int().min(1).max(30).optional(),
  boardAutoContinueLimit: z.number().int().min(0).max(20).optional(),
  chatMode: z.enum(["creative", "chat"]).optional(),
  /** 统一入口的工具范围；null 表示回到旧模式，交给 chatMode 决定 */
  toolScope: z.enum(["all", "conversation"]).nullable().optional(),
  nativeImagePilot: z.boolean().optional(),
  imageConfirmPolicy: z.enum(IMAGE_CONFIRM_POLICIES).optional(),
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

const canvasAppendSchema = z.object({
  assetIds: z.array(z.string().trim().min(1).max(80)).min(1).max(50),
});

const messageCreateSchema = z.object({
  /** 文本消息；图片附件在 M1 之后补，届时放宽成可选 */
  text: z.string().trim().min(1).max(20000),
  /**
   * 这句话引用的一组已有产物（用户从画布/消息里把图拖进输入框）。
   * 上限和画布同一个数：这些图发送前会被并进画布，多出来的本来就进不去。
   */
  assetRefs: z.array(z.string().trim().min(1).max(80)).max(MAX_CANVAS_IMAGES).optional(),
  /** 统一入口里显式指定的视频首尾帧；同一张图不能同时当首帧和尾帧 */
  videoFrames: z.object({
    firstAssetId: z.string().trim().min(1).max(80),
    lastAssetId: z.string().trim().min(1).max(80).optional(),
  }).refine((value) => !value.lastAssetId || value.lastAssetId !== value.firstAssetId, {
    message: "首帧和尾帧不能是同一张图片",
  }).optional(),
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

export function registerConversationRoutes(app: Express, db: AppDatabase, agent: AgentService, sessionKeys: KeyStore, chatThreadOnly: RequestHandler) {
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
      imageConfirmPolicy: input.imageConfirmPolicy ?? readAgentDefaults(db).imageConfirmPolicy,
      visionEnabled: input.visionEnabled ?? readAgentDefaults(db).visionEnabled,
      verbatimPrompt: input.verbatimPrompt ?? false,
      // 新客户端显式创建统一会话。未发送范围的旧客户端仍按渠道配置创建。
      toolScope: input.toolScope ?? (db.getChannel(brain.channelId)?.unifiedAgentDefault ? "all" : undefined),
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
    if (conversation.kind === "chat" && conversation.toolScope == null && patch.toolScope != null) {
      const hasPendingTask = db.listPendingMessages(id).some((message) => {
        const task = message.taskId ? db.getTaskRow(message.taskId) : null;
        return task && ["queued", "validating", "submitting", "running"].includes(task.status);
      });
      if (agent.isRunning(id) || conversation.status === "awaiting_confirmation" || conversation.status === "waiting_task" || hasPendingTask) {
        throw new AppError("TURN_IN_FLIGHT", "请先处理待确认卡或等待任务完成，再启用统一助手", 409);
      }
    }
    // 画布线程只开放这两类设置：上下文预算，和「用哪个对话模型」。
    // 模型是成对切的，只给一半时用现有的另一半补齐，再整体校验一遍，
    // 免得把 channelId 和 model 拼成上游不认的组合。
    const boardMutableKeys = new Set(["contextBudget", "brainChannelId", "brainModel", "boardMaxRounds", "boardAutoContinueLimit"]);
    if (conversation.kind !== "chat" && Object.keys(patch).some((key) => !boardMutableKeys.has(key))) {
      return res.status(400).json(fail("CONVERSATION_NOT_CHAT", "画布助手只允许修改上下文预算和对话模型", crypto.randomUUID()));
    }
    if (conversation.kind !== "chat" && (patch.brainChannelId !== undefined || patch.brainModel !== undefined)) {
      const brain = pickBrainChannel(db, patch.brainChannelId ?? conversation.brainChannelId, patch.brainModel ?? conversation.brainModel);
      patch.brainChannelId = brain.channelId;
      patch.brainModel = brain.model;
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
    // 换模型/渠道后重新给工具一次机会：上一轮的「不支持 tools」只属于那个组合
    if ((patch.brainModel !== undefined && patch.brainModel !== conversation.brainModel)
      || (patch.brainChannelId !== undefined && patch.brainChannelId !== conversation.brainChannelId)) {
      patch.toolsUnsupported = false;
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
    agent.startTurn(id, input.text, "user", input.assetRefs ?? [], input.videoFrames);
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
    const conversation = db.getConversation(id);
    if (!conversation) throw new AppError("CONVERSATION_NOT_FOUND", "会话不存在", 404);
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
    // 统一入口和原生生图试用里，附件默认只属于本轮；旧创作模式仍按原行为放进画布
    const attachmentStaysInTurn = conversation.toolScope != null
      || (conversation.chatMode === "chat" && conversation.nativeImagePilot);
    if (uploaded.length && !attachmentStaysInTurn) db.updateConversation(id, { canvasAssetIds: uploaded });
    res.status(201).json(ok(agent.buildView(id)));
  }));
}

export function registerConversationEvents(app: Express, db: AppDatabase, agent: AgentService) {
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
}
