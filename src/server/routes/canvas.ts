import multer from "multer";
import { z } from "zod";
import { imageOutputFormatSchema } from "../../shared/image-formats.js";
import { BOARD_AUDIO_KINDS, BOARD_VIDEO_MODES } from "../../shared/board.js";
import { IMAGE_SIZE_VALUES } from "../../shared/types.js";
import { StylePresetError, type AppDatabase } from "../db.js";
import type { KeyStore } from "../key-store.js";
import { AppError, type TaskRunner } from "../tasks.js";
import { claimBoardFrame, completeBoardFrame } from "../board-frame-broker.js";
import { addAssetsToBoard, createBoard, deleteBoard, getBoard, importBoard, listBoardAssets, listBoardHistory, listBoards, linkBoardAsset, redoBoard, removeBoardAsset, renameBoard, restoreBoardVersion, saveBoard, saveBoardSelection, saveBoardUiState, saveBoardViewport, storeBoardUpload, undoBoard } from "../board.js";
import { cancelBoardTask, generateBoardConfig, retryBoardTask } from "../board-generation.js";
import { cleanupMigratedStoryboards, createBoardFromTemplate, importTemplateIntoBoard, migrateAllStoryboards } from "../canvas-template.js";
import { ok, fail, asyncHandler, routeParam } from "./http.js";
import type { Express } from "express";
import { registerStoryboardRoutes } from "./storyboards.js";

/** 画布素材包括本地视频和音频；图片按 20 MB 限制。 */
const boardUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 0 },
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
    outputFormat: imageOutputFormatSchema.optional(),
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

export function registerCanvasRoutes(app: Express, db: AppDatabase, runner: TaskRunner, sessionKeys: KeyStore) {
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

  registerStoryboardRoutes(app, db, sessionKeys);

  const stylePresetInputSchema = z.object({
    name: z.string().trim().min(1).max(40),
    description: z.string().trim().max(120).default(""),
    prompt: z.string().trim().min(1).max(400),
    negative: z.string().trim().max(200).default(""),
  });
  const rethrowStyleError = (error: unknown): never => {
    if (error instanceof StylePresetError) throw new AppError(error.code, error.message, error.code === "STYLE_NOT_FOUND" ? 404 : 400);
    throw error;
  };

  app.get("/api/style-presets", (_req, res) => {
    res.json(ok(db.listStylePresets()));
  });
  app.post("/api/style-presets", (req, res) => {
    const input = stylePresetInputSchema.parse(req.body ?? {});
    try {
      res.status(201).json(ok(db.saveStylePreset(input)));
    } catch (error) {
      rethrowStyleError(error);
    }
  });
  app.put("/api/style-presets/:id", (req, res) => {
    const input = stylePresetInputSchema.parse(req.body ?? {});
    try {
      res.json(ok(db.saveStylePreset(input, routeParam(req.params.id))));
    } catch (error) {
      rethrowStyleError(error);
    }
  });
  app.delete("/api/style-presets/:id", (req, res) => {
    try {
      db.deleteStylePreset(routeParam(req.params.id));
      res.json(ok({ deleted: true }));
    } catch (error) {
      rethrowStyleError(error);
    }
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
}
