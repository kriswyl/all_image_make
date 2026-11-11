import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import multer from "multer";
import { getWpsPreviewJobs } from "./wps-preview.js";
import { z } from "zod";
import { APP_VERSION } from "../shared/app-config.js";
import { MAX_REFERENCE_IMAGES } from "../shared/types.js";
import { AppDatabase } from "./db.js";
import { KeyStore } from "./key-store.js";
import { TaskRunner, normalizeError } from "./tasks.js";
import { AgentService } from "./agent.js";
import { publicChannel } from "./routes/channel-config.js";
import { ok, fail, routeParam } from "./routes/http.js";
import { registerCanvasRoutes } from "./routes/canvas.js";
import { registerChannelRoutes } from "./routes/channels.js";
import { registerGenerationRoutes } from "./routes/generations.js";
import { registerConversationRoutes, registerConversationEvents } from "./routes/conversations.js";
import { registerDocumentRoutes } from "./routes/documents.js";
import { registerAssetRoutes } from "./routes/assets.js";

export interface AppContext {
  db: AppDatabase;
  sessionKeys: KeyStore;
  runner: TaskRunner;
  agent: AgentService;
}

export function createApp(options: { dataDir?: string } = {}) {
  const app = express();
  const db = new AppDatabase(options.dataDir);
  const wpsPreviews = getWpsPreviewJobs(db);
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
    const wpsCapabilityRead = /^\/api\/wps-preview\/[0-9a-f-]{36}\/(?:claim|diagnostics|pages\/\d+)$/.test(req.path)
      && origin && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin);
    if (origin === "http://tauri.localhost" || origin === "tauri://localhost" || origin === "http://127.0.0.1:5173" || wpsCapabilityRead) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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

  // WPS loads its add-in over loopback even in a packaged Tauri build, where the UI is embedded.
  const bundledWpsAddon = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../wps-addon");
  const wpsAddonDir = fs.existsSync(bundledWpsAddon) ? bundledWpsAddon : path.resolve("src/client/public/wps-addon");
  app.get("/wps-addon/wpsjsrpcsdk.js", (_req, res) => {
    const bundled = path.join(wpsAddonDir, "wpsjsrpcsdk.js");
    const sdk = fs.existsSync(bundled) ? bundled : createRequire(import.meta.url).resolve("wpsjs-rpc-sdk-new");
    res.type("application/javascript").sendFile(sdk);
  });
  app.use("/wps-addon", express.static(wpsAddonDir, { index: false, fallthrough: false }));

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

  registerCanvasRoutes(app, db, runner, sessionKeys);

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
  app.use("/api/conversations/:id/mind-documents", chatThreadOnly);
  app.use("/api/conversations/:id/uploads", chatThreadOnly);
  app.use("/api/conversations/:id/assets", chatThreadOnly);

  registerChannelRoutes(app, db, sessionKeys);

  registerGenerationRoutes(app, db, runner, sessionKeys);

  registerConversationRoutes(app, db, agent, sessionKeys, chatThreadOnly);

  registerDocumentRoutes(app, db, agent, wpsPreviews);

  registerConversationEvents(app, db, agent);

  registerAssetRoutes(app, db);

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
        if (/\/api\/conversations\/[^/]+\/(?:documents\/upload|mind-documents)$/.test(req.path)) {
          return res.status(400).json(fail("DOCUMENT_TOO_LARGE", "文档不能超过 10 MB", requestId));
        }
        const message = /^\/api\/boards\/[^/]+\/assets$/.test(req.path) || req.path === "/api/uploads/reference-video" || req.path === "/api/generations/reference-video" || req.path === "/api/generations/reference-media" ? "素材文件不能超过 100 MB" : error.field === "mask" ? "蒙版不能超过 20 MB" : "单张参考图不能超过 20 MB";
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
