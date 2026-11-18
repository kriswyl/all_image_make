import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import { exportBoardPackage } from "../src/server/board-package";
import type { BoardView } from "../src/shared/board";
import { storyboardProjectDataSchema, type StoryboardProduction } from "../src/shared/storyboard-project";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const cleanups: Array<() => Promise<void>> = [];

async function localApp() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-production-test-"));
  const created = createApp({ dataDir: directory });
  cleanups.push(async () => { created.context.db.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { ...created, directory, http: request(created.app) };
}
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); vi.restoreAllMocks(); });

it("十镜项目只更新选中的参考图，定版进入剪映并随工程包迁移到新数据库", async () => {
  const source = await localApp();
  const generate = vi.spyOn(source.context.runner, "create");
  const entry = (await source.http.post("/api/boards").send({ title: "场景设定" }).expect(201)).body.data as BoardView;
  async function upload(filename: string) {
    return (await source.http.post(`/api/boards/${entry.id}/assets`).attach("file", png, { filename, contentType: "image/png" }).expect(201)).body.data.id as string;
  }
  const old = await upload("old.png");
  const newer = await upload("new.png");
  const data = storyboardProjectDataSchema.parse({ name: "十镜短片", characters: [{ name: "林舟", assetId: old }], scenes: [],
    shots: Array.from({ length: 10 }, (_, index) => ({ id: `shot-${index + 1}`, character: "林舟", prompt: `雨夜镜头 ${index + 1}`, dialogue: index === 0 ? "雨停了。" : "" })) });
  const project = source.context.db.createStoryboardProject("short-film", entry.threadId, data);
  const template = (await source.http.post(`/api/storyboard-projects/${project.id}/templates`).send({ revision: 1, shotIds: data.shots.map(({ id }) => id) }).expect(201)).body.data;
  const board = (await source.http.post("/api/boards/from-template").send({ templateId: template.id, title: "制作画布" }).expect(201)).body.data as BoardView;
  const sibling = (await source.http.post("/api/boards/from-template").send({ templateId: template.id, title: "备选画布" }).expect(201)).body.data as BoardView;
  const productionUrl = `/api/storyboard-projects/${project.id}/boards/${board.id}`;
  const changed = source.context.db.updateStoryboardProject(project.id, 1, { ...data, characters: [{ ...data.characters[0]!, assetId: newer }] })!;
  const before = (await source.http.get(`${productionUrl}/production`).expect(200)).body.data as StoryboardProduction;
  expect(before.shots.filter((shot) => shot.references.some((reference) => reference.outdated))).toHaveLength(10);
  const sync = await source.http.post(`${productionUrl}/references`).send({ revision: changed.revision, boardVersion: board.version,
    shotIds: [data.shots[0]!.id, data.shots[1]!.id] }).expect(200);
  expect(sync.body.data.updated).toBe(2);
  const after = (await source.http.get(`${productionUrl}/production`).expect(200)).body.data as StoryboardProduction;
  expect(after.shots.filter((shot) => shot.references.some((reference) => reference.outdated))).toHaveLength(8);
  expect((await source.http.get(`/api/storyboard-projects/${project.id}/boards/${sibling.id}/production`).expect(200)).body.data.shots.filter((shot: StoryboardProduction["shots"][number]) =>
    shot.references.some((reference) => reference.outdated))).toHaveLength(10);

  const saved = sync.body.data.board as BoardView;
  const nodeId = after.shots[0]!.nodes.find((node) => node.role === "image")!.id;
  const withFrame = (await source.http.put(`/api/boards/${board.id}`).send({ baseVersion: saved.version, doc: { ...saved.doc,
    nodes: saved.doc.nodes.map((node) => node.id === nodeId ? { ...node, assetId: old, status: "succeeded" } : node) } }).expect(200)).body.data as BoardView;
  await source.http.put(`${productionUrl}/delivery`).send({ revision: 2, shotId: data.shots[1]!.id, role: "image", nodeId }).expect(400);
  const pinned = await source.http.put(`${productionUrl}/delivery`).send({ revision: 2, shotId: data.shots[0]!.id, role: "image", nodeId }).expect(200);
  expect(pinned.body.data.shots[0].delivery.image.assetId).toBe(old);
  expect(source.context.db.assetHasStoryboardProjectReferences(old)).toBe(true);
  await source.http.put(`/api/boards/${board.id}`).send({ baseVersion: withFrame.version, doc: { ...withFrame.doc,
    nodes: withFrame.doc.nodes.map((node) => node.id === nodeId ? { ...node, assetId: newer, status: "succeeded" } : node) } }).expect(200);
  const preview = await source.http.get(`/api/storyboard-projects/${project.id}/preview`).expect(200);
  expect(preview.body.data.find((item: { id: string }) => item.id === board.id).shots[0].image.id).toBe(old);
  const draft = await source.http.post(`/api/storyboard-projects/${project.id}/draft`).send({ boardId: board.id, targetDir: source.directory }).expect(200);
  expect(draft.body.data).toMatchObject({ clips: 1, skipped: 9, durationSeconds: 5 });
  expect(await fs.readFile(draft.body.data.subtitlesPath, "utf8")).toContain("00:00:00,000 --> 00:00:05,000\n雨停了。");

  const archive = await exportBoardPackage(source.context.db, board.id);
  const destination = await localApp();
  const imported = await destination.http.post("/api/boards/import-package").attach("file", archive, { filename: "board.zip", contentType: "application/zip" }).expect(201);
  expect(imported.body.data).toMatchObject({ boards: 2, media: 2 });
  const newBoard = imported.body.data.board as BoardView;
  const newProject = newBoard.doc.nodes.find((node) => node.storyboard)?.storyboard?.projectId;
  expect(newProject).toBeTruthy();
  expect(newProject).not.toBe(project.id);
  const importedProject = (await destination.http.get(`/api/storyboard-projects/${newProject}/boards/${newBoard.id}/production`).expect(200)).body.data as StoryboardProduction;
  expect(importedProject.shots).toHaveLength(10);
  expect(importedProject.shots[0]?.delivery?.image?.assetId).not.toBe(old);
  const includedAsset = destination.context.db.getAsset(importedProject.shots[0]!.delivery!.image!.assetId);
  expect(await fs.readFile(path.join(includedAsset!.baseDir, includedAsset!.relativePath))).toEqual(png);
  expect(generate).not.toHaveBeenCalled();
});

it("选区模板保留输入输出语义，放入另一画布时替换输入并重编号引用", async () => {
  const { http, context } = await localApp();
  const generate = vi.spyOn(context.runner, "create");
  const board = (await http.post("/api/boards").send({ title: "广告" }).expect(201)).body.data as BoardView;
  const assetId = (await http.post(`/api/boards/${board.id}/assets`).attach("file", png, { filename: "product.png", contentType: "image/png" }).expect(201)).body.data.id as string;
  const common = { x: 0, y: 0, width: 250, height: 180, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const input = { ...common, type: "image", title: "商品图", id: "asset", ref: "n1", assetId, status: "succeeded" };
  const text = { ...common, type: "text", title: "卖点", id: "text", ref: "n2", text: "旧输入" };
  const output = { ...common, x: 300, type: "image", title: "结果", id: "output", ref: "n3", prompt: "保留@图片1的细节", assetId: null, status: "empty" };
  const doc = { ...board.doc, nextRef: 4, nodes: [input, text, output], edges: [
    { id: "e1", source: "asset", target: "output", kind: "input", role: "reference" },
    { id: "e2", source: "text", target: "output", kind: "input", role: "text" },
  ] };
  await http.put(`/api/boards/${board.id}`).send({ doc, baseVersion: 1 }).expect(200);
  const template = (await http.post(`/api/boards/${board.id}/save-template`).send({ name: "商品图换景", nodeIds: ["asset", "text", "output"], inputIds: ["asset", "text"], outputIds: ["output"] }).expect(201)).body.data;
  expect(template.doc.nodes[0]).toMatchObject({ workflowSlot: "input", assetId: null });
  const imported = (await http.post(`/api/boards/${board.id}/templates`).send({ templateId: template.id, values: { asset: { assetId }, text: { text: "新卖点" } } }).expect(200)).body.data.board as BoardView;
  const instance = imported.doc.nodes.slice(3);
  expect(instance[0]).toMatchObject({ ref: "n4", assetId, workflowSlot: "input" });
  expect(instance[1]).toMatchObject({ ref: "n5", text: "新卖点", workflowSlot: "input" });
  expect(instance[2]).toMatchObject({ ref: "n6", prompt: "保留@图片4的细节", workflowSlot: "output" });
  expect(generate).not.toHaveBeenCalled();
});
