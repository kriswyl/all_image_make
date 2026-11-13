import path from "node:path";
import fs from "node:fs";
import type { AppDatabase } from "../db.js";
import { AppError } from "../tasks.js";
import { assetAbsolutePath, readThumbBytes } from "../vision.js";
import { revealFolder, removeStoredFiles } from "./files.js";
import { ok, fail, asyncHandler, routeParam } from "./http.js";
import type { Express } from "express";

/**
 * 下载时用的文件名。
 *
 * 磁盘上的 `file_name` 可能是旧版本写错的扩展名（Gemini 图片曾被当成音频存成 .m4a），
 * 扩展名和 mimeType 对不上时以 mimeType 为准，否则用户下载到一张打不开的图。
 */
function assetDownloadName(asset: { fileName: string; mimeType: string }): string {
  const current = asset.fileName.split(".").pop()?.toLowerCase() ?? "";
  const compatible = asset.mimeType.startsWith("image/")
    ? ["png", "jpg", "jpeg", "webp", "gif", "svg"]
    : asset.mimeType.startsWith("video/")
      ? ["mp4", "webm", "mov", "m4v", "mkv"]
      : asset.mimeType.startsWith("audio/")
        ? ["wav", "mp3", "m4a", "aac", "ogg", "flac", "webm"]
        : [];
  const byMime: Record<string, string> = {
    "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg",
  };
  const extension = compatible.includes(current)
    ? current
    : byMime[asset.mimeType]
      ?? (asset.mimeType.includes("mpeg") ? "mp3"
        : asset.mimeType.includes("wav") ? "wav"
          : asset.mimeType.startsWith("video/") ? "mp4"
            : asset.mimeType.startsWith("audio/") ? "m4a" : "png");
  const stem = asset.fileName.replace(/\.[^.]+$/, "") || "asset";
  return `${stem}.${extension}`;
}

export function registerAssetRoutes(app: Express, db: AppDatabase) {
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
    // SVG 不是位图，Jimp 缩不了；直接返回原文件让 <img> 渲染，别在缩略图接口上 404。
    if (asset.mimeType === "image/svg+xml") {
      const absolute = assetAbsolutePath(db, asset);
      const original = absolute ? await fs.promises.readFile(absolute).catch(() => null) : null;
      if (!original) throw new AppError("THUMB_UNAVAILABLE", "缩略图不可用", 404);
      res.setHeader("Content-Type", "image/svg+xml");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.send(original);
      return;
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
    if (!asset) return res.status(404).json(fail("ASSET_NOT_FOUND", "素材不存在"));
    // 目录跟着记录走：用户换过素材目录后，老产物的绝对路径不能拿当前目录拼
    const baseDir = path.resolve(asset.baseDir);
    const absolutePath = path.resolve(baseDir, asset.relativePath);
    if (!absolutePath.startsWith(baseDir + path.sep)) return res.status(400).json(fail("ASSET_INVALID", "素材路径无效"));
    if (req.query.download === "1") return res.download(absolutePath, assetDownloadName(asset));
    res.type(asset.mimeType).sendFile(absolutePath);
  });
}
