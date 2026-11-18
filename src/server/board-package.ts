import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { z } from "zod";
import { parseBoardDoc, parseBoardViewport, type BoardNode } from "../shared/board.js";
import { storyboardProjectDataSchema, type StoryboardMediaRole, type StoryboardProjectData } from "../shared/storyboard-project.js";
import { AppError } from "./app-error.js";
import { boardUploadExtension, storeBoardUpload } from "./board-assets.js";
import { createBoard, deleteBoard, getBoard, saveBoard, saveBoardViewport } from "./board.js";
import { requireBoard } from "./board-core.js";
import { openBoundedArchive, readOfficePart } from "./chat-tools/office-archive.js";
import type { AppDatabase } from "./db.js";

export const MAX_BOARD_PACKAGE_BYTES = 160 * 1024 * 1024;
const manifestPart = "chatcanvas.json";
const assetPart = (index: number) => `media/${index}`;
const roles: StoryboardMediaRole[] = ["image", "video", "audio"];
const idSchema = z.string().min(1).max(80);
const manifestSchema = z.object({
  format: z.literal("chatcanvas-production"), version: z.literal(1), primaryBoard: idSchema,
  boards: z.array(z.object({ id: idSchema, title: z.string().max(80), doc: z.unknown(), viewport: z.unknown() })).min(1).max(30),
  projects: z.array(z.object({ id: idSchema, data: storyboardProjectDataSchema })).max(30),
  media: z.array(z.object({ id: idSchema, mime: z.string().max(80), name: z.string().max(240), digest: z.string().regex(/^[a-f0-9]{64}$/), duration: z.number().nonnegative().nullish() })).max(1000),
});

function projectAssets(data: StoryboardProjectData): string[] {
  return [...[...data.characters, ...data.scenes, ...data.props].flatMap((item) => [item.assetId, ...item.variants.map((entry) => entry.assetId)]),
    ...data.shots.flatMap((shot) => roles.map((role) => shot.delivery?.[role]?.assetId))].filter((id): id is string => Boolean(id));
}

function documentAssets(nodes: BoardNode[]) {
  return nodes.flatMap((node) => "assetId" in node && node.assetId ? [node.assetId] : []);
}

function digest(bytes: Buffer) { return crypto.createHash("sha256").update(bytes).digest("hex"); }

export async function exportBoardPackage(db: AppDatabase, boardId: string) {
  const primary = requireBoard(db, boardId);
  const boards = new Map([[primary.id, primary]]);
  const projectIds = new Set<string>();
  const allBoards = db.listBoardRecords();
  for (const board of boards.values()) {
    for (const node of board.doc.nodes) if (node.storyboard) projectIds.add(node.storyboard.projectId);
    for (const item of allBoards) if (item.doc.nodes.some((node) => node.storyboard && projectIds.has(node.storyboard.projectId))) boards.set(item.id, item);
  }
  const projects = [...projectIds].flatMap((id) => { const project = db.getStoryboardProject(id); return project ? [{ id, data: project.data }] : []; });
  if (boards.size > 30 || projects.length > 30) throw new AppError("BOARD_PACKAGE_LIMIT", "关联画布或分镜过多，请拆分后导出", 400);
  const ids = new Set([...boards.values()].flatMap((board) => documentAssets(board.doc.nodes)).concat(projects.flatMap(({ data }) => projectAssets(data))));
  const media: z.infer<typeof manifestSchema>["media"] = [];
  const archive = new JSZip();
  let total = 0;
  for (const id of ids) {
    const row = db.getAsset(id);
    if (!row) throw new AppError("BOARD_PACKAGE_MISSING_ASSET", "有素材记录已丢失，请处理后重新导出", 409);
    const root = path.resolve(row.baseDir);
    const file = path.resolve(root, row.relativePath);
    if (!file.startsWith(root + path.sep)) throw new AppError("BOARD_PACKAGE_INVALID", "素材路径无效", 400);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new AppError("BOARD_PACKAGE_MISSING_ASSET", `素材文件已丢失：${row.fileName}`, 409);
    total += stat.size;
    if (total > MAX_BOARD_PACKAGE_BYTES || media.length >= 1000) throw new AppError("BOARD_PACKAGE_LIMIT", "工程包最大 160 MB，请拆分后导出", 413);
    const bytes = await fs.readFile(file);
    if (!boardUploadExtension(bytes, row.mimeType)) throw new AppError("BOARD_PACKAGE_INVALID", `工程包暂不支持此格式或大小：${row.fileName}`, 400);
    archive.file(assetPart(media.length), bytes);
    media.push({ id, mime: row.mimeType, name: row.fileName.slice(0, 240), digest: digest(bytes), duration: row.duration });
  }
  const manifest = JSON.stringify({ format: "chatcanvas-production", version: 1, primaryBoard: boardId,
    boards: [...boards.values()].map(({ id, title, doc, viewport }) => ({ id, title, doc, viewport })), projects, media });
  if (total + Buffer.byteLength(manifest) + media.length * 200 + 512 > MAX_BOARD_PACKAGE_BYTES) throw new AppError("BOARD_PACKAGE_LIMIT", "工程包最大 160 MB，请拆分后导出", 413);
  archive.file(manifestPart, manifest);
  return archive.generateAsync({ type: "nodebuffer", compression: "STORE" });
}

export async function importBoardPackage(db: AppDatabase, bytes: Buffer) {
  let manifest: z.infer<typeof manifestSchema>;
  let docs: ReturnType<typeof parseBoardDoc>[];
  const uploads: Buffer[] = [];
  try {
    const archive = await openBoundedArchive(bytes, manifestPart, "画布工程包", { part: 100 * 1024 * 1024, total: MAX_BOARD_PACKAGE_BYTES, count: 1001 });
    const content = await readOfficePart(archive.file(manifestPart)!);
    manifest = manifestSchema.parse(JSON.parse(content.toString("utf8")));
    docs = manifest.boards.map((entry) => parseBoardDoc(entry.doc));
    const unique = (items: Array<{ id: string }>) => new Set(items.map(({ id }) => id)).size === items.length;
    if (!unique(manifest.boards) || !unique(manifest.projects) || !unique(manifest.media) || !manifest.boards.some(({ id }) => id === manifest.primaryBoard)) throw new Error("工程包标识不完整或重复");
    const available = new Set(manifest.media.map(({ id }) => id));
    const expected = docs.flatMap((doc) => documentAssets(doc.nodes)).concat(manifest.projects.flatMap(({ data }) => projectAssets(data)));
    if (expected.some((id) => !available.has(id))) throw new Error("工程包缺少引用的素材");
    for (const [index, media] of manifest.media.entries()) {
      const entry = archive.file(assetPart(index));
      if (!entry) throw new Error("工程包缺少媒体文件");
      const file = await readOfficePart(entry);
      if (digest(file) !== media.digest || !boardUploadExtension(file, media.mime)) throw new Error("工程包内有媒体损坏或类型不符");
      uploads.push(file);
    }
  } catch (error) { throw new AppError("BOARD_PACKAGE_INVALID", error instanceof z.ZodError ? "工程包清单不符合格式" : error instanceof Error ? error.message : "工程包无法读取", 400); }

  const boardIds = new Map<string, string>();
  const projectIds = new Map<string, string>();
  const importedTasks: string[] = [];
  try {
    for (const item of manifest.boards) boardIds.set(item.id, createBoard(db, { title: item.title }).id);
    const mainId = boardIds.get(manifest.primaryBoard)!;
    const assetIds = new Map<string, string>();
    for (const [index, media] of manifest.media.entries()) {
      const asset = await storeBoardUpload(db, mainId, { buffer: uploads[index]!, originalname: media.name, mimetype: media.mime, duration: media.duration });
      importedTasks.push(asset.taskId);
      assetIds.set(media.id, asset.id);
    }
    const mapAsset = (id: string | null) => id ? assetIds.get(id) ?? null : null;
    const settings = (items: StoryboardProjectData["characters"]) => items.map((item) => ({ ...item, assetId: mapAsset(item.assetId),
      variants: item.variants.map((variant) => ({ ...variant, assetId: mapAsset(variant.assetId) })) }));
    for (const project of manifest.projects) {
      const id = crypto.randomUUID();
      projectIds.set(project.id, id);
      db.createStoryboardProject(id, requireBoard(db, mainId).threadId, { ...project.data,
        characters: settings(project.data.characters), scenes: settings(project.data.scenes), props: settings(project.data.props),
        shots: project.data.shots.map((shot) => ({ ...shot, delivery: Object.fromEntries(roles.flatMap((role) => {
          const pin = shot.delivery?.[role];
          return pin ? [[role, { ...pin, assetId: assetIds.get(pin.assetId)!, boardId: boardIds.get(pin.boardId) ?? mainId }]] : [];
        })) })) });
    }
    for (const [index, entry] of manifest.boards.entries()) {
      const boardId = boardIds.get(entry.id)!;
      const doc = docs[index]!;
      doc.nodes = doc.nodes.map((node) => {
        const projectId = node.storyboard && projectIds.get(node.storyboard.projectId);
        const storyboard = node.storyboard && projectId ? { ...node.storyboard, projectId } : undefined;
        if (node.type === "text") return { ...node, storyboard };
        if (node.type === "config") return { ...node, storyboard, channelId: undefined, lastTaskId: undefined, status: "idle", error: undefined };
        const assetId = mapAsset(node.assetId);
        if (assetId) db.insertBoardAssetLink(boardId, assetId, node.id);
        return { ...node, storyboard, assetId, channelId: undefined, taskId: undefined, status: assetId ? "succeeded" : "empty", error: undefined };
      });
      saveBoard(db, boardId, { doc, baseVersion: 1, reason: "package:import" });
      saveBoardViewport(db, boardId, parseBoardViewport(entry.viewport));
    }
    return { board: getBoard(db, mainId)!, boards: boardIds.size, media: assetIds.size };
  } catch (error) {
    for (const id of projectIds.values()) db.deleteImportedStoryboardProject(id);
    for (const id of [...boardIds.values()].reverse()) deleteBoard(db, id);
    for (const id of importedTasks) {
      for (const file of db.deleteTask(id).assets) await fs.rm(path.join(file.baseDir, file.relativePath), { force: true }).catch(() => undefined);
    }
    throw error;
  }
}
