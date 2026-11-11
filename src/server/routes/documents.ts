import type { Express, Request } from "express";
import path from "node:path";
import fs from "node:fs";
import multer from "multer";
import { readWorkspaceFile } from "../chat-tools/document-workspace.js";
import { getWpsPreviewJobs, isWpsServiceRunning } from "../wps-preview.js";
import { parseXmind, planMindSlides, renderMindPptx, type MindDocument } from "../mind-document.js";
import { readPresentationStyle } from "../presentation-project.js";
import { z } from "zod";
import type { AppDatabase } from "../db.js";
import { AppError } from "../tasks.js";
import { displayFileName } from "../security.js";
import type { AgentService } from "../agent.js";
import { MAX_SCRIPT_CHARS, MAX_SCRIPT_TOTAL_CHARS } from "../../shared/storyboard.js";
import { MAX_BINARY_DOCUMENT_BYTES, OFFICE_ATTACHMENT } from "../../shared/document-formats.js";
import { readDocxText } from "../chat-tools/word-document.js";
import { inspectXlsx } from "../chat-tools/spreadsheet-document.js";
import { inspectPdf } from "../chat-tools/pdf-document.js";
import { revealFolder } from "./files.js";
import { ok, fail, asyncHandler, routeParam } from "./http.js";

const binaryDocumentUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BINARY_DOCUMENT_BYTES, files: 1, fields: 0 } });

/** 脚本文档：全文走 JSON；字数上限在路由里按总量再核一次 */
const conversationDocumentSchema = z.object({
  documents: z.array(z.object({
    name: z.string().trim().min(1).max(200),
    // 字数上限在路由里检查，好给出「超过 N 字，请拆分」这种能直接照做的错误
    content: z.string().min(1),
  })).min(1).max(3),
});

export function registerDocumentRoutes(app: Express, db: AppDatabase, agent: AgentService, wpsPreviews: ReturnType<typeof getWpsPreviewJobs>) {
  /**
   * 往会话里传脚本文档（.txt / .md）。
   *
   * 和上传图片同一套「先落库、再挂一条 user 消息」：那条消息只写文件名和字数，
   * 全文存进 conversation_documents——聊天记录里塞几万字，用户和大脑都会被淹。
   * 全文只在**紧接着的那一轮**作为素材喂给大脑，之后靠分镜表的 source_text 回溯。
   */
  // XMind 的结构保存在会话文档里，可从附件反复预览和导出。
  app.get("/api/conversations/:id/documents/files", (req, res) => {
    res.json(ok(db.listWorkspaceDocuments(routeParam(req.params.id))));
  });
  app.delete("/api/conversations/:id/documents/files/:fileId", (req, res) => {
    const conversationId = routeParam(req.params.id); const fileId = routeParam(req.params.fileId);
    let file: ReturnType<typeof readWorkspaceFile>;
    try { file = readWorkspaceFile(db, conversationId, fileId); }
    catch { throw new AppError("DOCUMENT_NOT_FOUND", "文件不存在或不可访问", 404); }
    fs.unlinkSync(file.full); db.deleteWorkspaceDocument(conversationId, fileId);
    res.json(ok({ deleted: true }));
  });
  app.post("/api/conversations/:id/documents/files/:fileId/reveal", (req, res) => {
    try { const file = readWorkspaceFile(db, routeParam(req.params.id), routeParam(req.params.fileId)); revealFolder(path.dirname(file.full)); res.json(ok({ opened: true })); }
    catch { throw new AppError("DOCUMENT_NOT_FOUND", "文件不存在或不可访问", 404); }
  });
  app.get("/api/conversations/:id/documents/files/:fileId", (req, res) => {
    try { const file = readWorkspaceFile(db, routeParam(req.params.id), routeParam(req.params.fileId)); res.type("application/octet-stream").send(file.bytes); }
    catch { throw new AppError("DOCUMENT_NOT_FOUND", "文件不存在或不可访问", 404); }
  });
  const versionSha = z.string().regex(/^[a-f0-9]{64}$/);
    app.get("/api/conversations/:id/executions", (req, res) => {
      const id=routeParam(req.params.id);
      if(!db.getConversation(id))throw new AppError("CONVERSATION_NOT_FOUND","会话不存在",404);
      res.json(ok(db.executions.list(id)));
    });
    app.get("/api/conversations/:id/workflows", (req, res) => {
      const conversationId = routeParam(req.params.id);
      if (!db.getConversation(conversationId)) throw new AppError("CONVERSATION_NOT_FOUND", "会话不存在", 404);
      res.json(ok(db.workflows.list(conversationId)));
    });
    app.get("/api/conversations/:id/workflows/:runId", (req, res) => {
      const conversationId = routeParam(req.params.id), runId = routeParam(req.params.runId);
      const run = db.workflows.get(conversationId, runId);
      if (!run) throw new AppError("WORKFLOW_NOT_FOUND", "找不到本会话的工作流", 404);
      res.json(ok({ ...run, steps: db.workflows.steps(conversationId, runId) }));
    });
    app.post("/api/conversations/:id/workflows/:runId", asyncHandler(async (req, res) => {
      const conversationId = routeParam(req.params.id), runId = routeParam(req.params.runId);
      const input = z.object({ action: z.enum(["resume", "cancel"]) }).parse(req.body);
      const run = db.workflows.get(conversationId, runId);
      if (!run) throw new AppError("WORKFLOW_NOT_FOUND", "找不到本会话的工作流", 404);
      const resume = db.getPresentationResume(conversationId);
      if (input.action === "cancel") {
        if (db.workflows.cancel(conversationId, runId) && resume?.operationId === runId) {
          agent.interrupt(conversationId);
          db.clearPresentationResume(conversationId);
        }
        res.json(ok(db.workflows.get(conversationId, runId)));
        return;
      }
      if (run.status === "running" || run.status === "completed") { res.json(ok(run)); return; }
      if (run.status === "cancelled" || run.capability !== "doc_convert" || resume?.operationId !== runId) throw new AppError("WORKFLOW_NOT_RESUMABLE", "此任务没有可直接续做的检查点，请发起新的制作要求", 409);
      if (db.getConversation(conversationId)?.toolScope === "conversation") throw new AppError("TOOLS_DISABLED", "请在对话设置中开启工具", 409);
      if (agent.isRunning(conversationId)) throw new AppError("TURN_IN_FLIGHT", "会话正在处理其他任务", 409);
      // Existing turn handling retains confirmation, channel binding and continuation budgets.
      agent.startTurn(conversationId, "继续 PPT", "user");
      res.status(202).json(ok(db.workflows.get(conversationId, runId)));
    }));
  app.get("/api/conversations/:id/documents/files/:fileId/presentation-status", (req, res) => {
    const result = db.getPresentationVersion(routeParam(req.params.id), routeParam(req.params.fileId));
    if (!result) return res.status(404).json(fail("DOCUMENT_NOT_FOUND", "没有对应的 PPT 文件版本报告"));
    res.json(ok(result));
  });
  app.post("/api/conversations/:id/documents/files/:fileId/presentation-status", asyncHandler(async (req, res) => {
    const conversationId = routeParam(req.params.id), fileId = routeParam(req.params.fileId);
    const input = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("page"), page: z.number().int().min(1).max(200), sha256: versionSha }),
      z.object({ kind: z.literal("audit"), sha256: versionSha }),
      z.object({ kind: z.literal("visual"), sha256: versionSha }),
        z.object({ kind: z.literal("review"), sha256: versionSha }),
    ]).parse(req.body);
    if (input.kind === "visual") {
      agent.retryPresentationCheck(conversationId, fileId, input.sha256);
      res.status(202).json(ok({ fileId }));
      return;
    }
    res.json(ok(await agent.applyPresentationAction(conversationId, fileId, input.sha256, input)));
  }));
  app.post("/api/conversations/:id/documents/files/:fileId/wps-preview", asyncHandler(async (req, res) => {
    const origin = req.headers.origin;
    const host = req.headers.host;
    const sameLoopback = origin && /^http:\/\/127\.0\.0\.1:\d+$/.test(origin) && origin === `http://${host}`;
    if (!req.is("application/json") || (origin && !sameLoopback && !["http://tauri.localhost", "tauri://localhost", "http://127.0.0.1:5173"].includes(origin))) throw new AppError("PREVIEW_FORBIDDEN", "不能从当前页面启动预览", 403);
    const input = z.object({ first: z.number().int().min(1).default(1) }).parse(req.body ?? {});
    const job = await wpsPreviews.create(routeParam(req.params.id), routeParam(req.params.fileId), input.first);
    res.status(201).json(ok(job));
  }));
  const previewSecret = (req: Request) => (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  app.get("/api/wps-preview/status", asyncHandler(async (_req, res) => { res.json(ok({ serviceAvailable: await isWpsServiceRunning() })); }));
  app.get("/api/wps-preview/:id/claim", (req, res) => {
    res.json(ok(wpsPreviews.claim(routeParam(req.params.id), previewSecret(req))));
  });
  app.get("/api/wps-preview/:id/pages/:page", (req, res) => {
    res.type("image/png").send(wpsPreviews.page(routeParam(req.params.id), previewSecret(req), Number(req.params.page)));
  });
  app.get("/api/wps-preview/:id/diagnostics", (req, res) => {
    res.json(ok(wpsPreviews.diagnostics(routeParam(req.params.id), previewSecret(req))));
  });
  app.delete("/api/wps-preview/:id", (req, res) => {
    wpsPreviews.close(routeParam(req.params.id), previewSecret(req)); res.json(ok({ closed: true }));
  });
  app.post("/api/conversations/:id/documents/upload", binaryDocumentUpload.single("file"), asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    const file = req.file;
    const format = file && OFFICE_ATTACHMENT.exec(file.originalname)?.[1]?.toLowerCase();
    if (!file || !format) throw new AppError("DOCUMENT_INVALID", "请选择 Word (.docx)、Excel (.xlsx) 或 PDF 文件", 400);
    let details: object;
    try {
      if (format === "xlsx") details = { sheets: await inspectXlsx(file.buffer) };
      else if (format === "pdf") details = { totalPages: await inspectPdf(file.buffer) };
      else details = { characters: (await readDocxText(file.buffer)).length };
    } catch (error) {
      throw new AppError("DOCUMENT_INVALID", error instanceof Error ? error.message : "无法读取文档", 400);
    }
    const originalName = Buffer.from(file.originalname, "latin1").toString("utf8");
    const name = displayFileName(originalName.includes("�") ? file.originalname : originalName);
    const stored = db.addBinaryConversationDocument(id, name, JSON.stringify({ format, ...details }), file.buffer);
    db.appendMessage({ conversationId: id, role: "user", content: `上传了文件附件 《${name}》`, documents: [{ id: stored.id, name: stored.fileName, charCount: stored.charCount }] });
    res.status(201).json(ok(agent.buildView(id)));
  }));
  app.post("/api/conversations/:id/mind-documents", binaryDocumentUpload.single("file"), asyncHandler(async (req, res) => {
    const id = routeParam(req.params.id);
    if (!db.getConversation(id)) throw new AppError("CONVERSATION_NOT_FOUND", "会话不存在", 404);
    if (!req.file || !/\.(xmind|pptx)$/i.test(req.file.originalname)) throw new AppError("DOCUMENT_INVALID", "请选择 XMind 或 PPTX 文件", 400);
    const reference = /\.pptx$/i.test(req.file.originalname);
    const parsed = reference ? await readPresentationStyle(req.file.buffer) : await parseXmind(req.file.buffer);
    const content = JSON.stringify(parsed);
    if (content.length > 400_000) throw new AppError("DOCUMENT_TOO_LARGE", "导图解析后的内容超过 400000 字，请分章节上传", 400);
    const originalName = Buffer.from(req.file.originalname, "latin1").toString("utf8");
    const stored = db.addBinaryConversationDocument(id, displayFileName(originalName.includes("�") ? req.file.originalname : originalName), content, req.file.buffer);
    db.appendMessage({ conversationId: id, role: "user", content: reference ? "上传了 PPT 风格参考，可参考主题颜色和字体，不复制原母版与动画。" : "上传了 XMind 思维导图，可在附件中预览拆页并导出 PPT。", documents: [{ id: stored.id, name: stored.fileName, charCount: stored.charCount }] });
    res.status(201).json(ok(agent.buildView(id)));
  }));
  const getMindDocument = (conversationId: string, documentId: string): MindDocument => {
    const document = db.getConversationDocument(documentId);
    if (!document || document.conversationId !== conversationId || !/\.xmind$/i.test(document.fileName)) throw new AppError("DOCUMENT_NOT_FOUND", "思维导图不存在", 404);
    const parsed = JSON.parse(document.content) as MindDocument;
    if (parsed.format !== "xmind" || !Array.isArray(parsed.sheets)) throw new AppError("DOCUMENT_INVALID", "思维导图内容不可用", 400);
    return parsed;
  };
  const slidePlanSchema = z.array(z.object({ title: z.string().trim().min(1).max(2000), lines: z.array(z.string().max(200)).max(7), notes: z.string().max(60000) })).min(1).max(200);
  app.get("/api/conversations/:id/document-outputs/:outputId", (req, res) => {
    const output = db.getDocumentOutput(routeParam(req.params.outputId));
    if (!output) throw new AppError("DOCUMENT_NOT_FOUND", "文件不存在", 404);
    const document = db.getConversationDocument(output.documentId);
    if (!document || document.conversationId !== routeParam(req.params.id)) throw new AppError("DOCUMENT_NOT_FOUND", "文件不存在", 404);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", 'attachment; filename="presentation.pptx"');
    res.send(output.data);
  });
  app.get("/api/conversations/:id/mind-documents/:documentId/source", (req, res) => {
    const documentId = routeParam(req.params.documentId);
    getMindDocument(routeParam(req.params.id), documentId);
    const bytes = db.getConversationDocumentFile(documentId);
    if (!bytes) throw new AppError("DOCUMENT_SOURCE_MISSING", "这个附件上传时尚未保存原文件，请重新上传", 404);
    res.type("application/octet-stream").send(bytes);
  });
  app.get("/api/conversations/:id/mind-documents/:documentId/plan", (req, res) => {
    const documentId = routeParam(req.params.documentId);
    const doc = getMindDocument(routeParam(req.params.id), documentId);
    const stored = db.getConversationDocumentPlan(documentId);
    const slides = stored ? slidePlanSchema.parse(JSON.parse(stored)) : planMindSlides(doc);
    res.json(ok({ slides, warnings: doc.warnings, sourceAvailable: Boolean(db.getConversationDocumentFile(documentId)) }));
  });
  app.put("/api/conversations/:id/mind-documents/:documentId/plan", (req, res) => {
    const documentId = routeParam(req.params.documentId);
    getMindDocument(routeParam(req.params.id), documentId);
    const slides = slidePlanSchema.parse(req.body?.slides);
    db.setConversationDocumentPlan(documentId, JSON.stringify(slides));
    res.json(ok({ slides }));
  });
  app.post("/api/conversations/:id/mind-documents/:documentId/pptx", asyncHandler(async (req, res) => {
    const documentId = routeParam(req.params.documentId);
    const doc = getMindDocument(routeParam(req.params.id), documentId);
    const stored = db.getConversationDocumentPlan(documentId);
    const slides = stored ? slidePlanSchema.parse(JSON.parse(stored)) : planMindSlides(doc);
    const buffer = await renderMindPptx(slides);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", 'attachment; filename="mind-map.pptx"');
    res.send(buffer);
  }));

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
}
