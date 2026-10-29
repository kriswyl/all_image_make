import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function tempApp() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-board-bridge-"));
  const created = createApp({ dataDir });
  cleanups.push(async () => {
    created.context.db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return created;
}

async function upload(app: ReturnType<typeof createApp>["app"], boardId: string) {
  const response = await request(app)
    .post(`/api/boards/${boardId}/assets`)
    .attach("file", Buffer.from(pngBase64, "base64"), { filename: "shot.png", contentType: "image/png" })
    .expect(201);
  return response.body.data.id as string;
}

describe("跨模式桥", () => {
  it("公共视频和音频可插入画布并保留素材引用", async () => {
    const { app, context } = await tempApp();
    const board = (await request(app).post("/api/boards").send({ title: "媒体" }).expect(201)).body.data;
    for (const kind of ["video", "audio"] as const) {
      const taskId = `task-${kind}`;
      context.db.createTask({ id: taskId, channelId: "", model: "", prompt: kind, input: {}, status: "succeeded" });
      context.db.insertAsset({ id: `asset-${kind}`, taskId, fileName: kind, mimeType: `${kind}/test`, byteSize: 1, relativePath: kind, baseDir: context.db.assetsDir, sha256: "x", thumbPath: "" });
    }
    const result = await request(app).post(`/api/boards/${board.id}/bridge/assets`).send({ items: [{ assetId: "asset-video" }, { assetId: "asset-audio" }] }).expect(200);
    expect(result.body.data.board.doc.nodes).toMatchObject([{ type: "video", assetId: "asset-video" }, { type: "audio", assetId: "asset-audio" }]);
    expect((await request(app).get(`/api/boards/${board.id}/assets`).expect(200)).body.data).toHaveLength(2);
    const page = await request(app).get("/api/library").query({ limit: 1, mode: "assets" }).expect(200);
    expect(page.body.data.items).toHaveLength(1);
    expect(page.body.data.hasMore).toBe(true);
    const next = await request(app).get("/api/library").query({ limit: 1, offset: 1, mode: "assets" }).expect(200);
    expect(next.body.data.items[0].id).not.toBe(page.body.data.items[0].id);
    const audio = await request(app).get("/api/library").query({ limit: 10, kind: "audio", q: "audio", mode: "assets" }).expect(200);
    expect(audio.body.data.items.map((task: { id: string }) => task.id)).toEqual(["task-audio"]);
  });
  it("把已有图片送进另一块无限画布，保留标题和提示词并复用素材", async () => {
    const { app, context } = await tempApp();
    const source = (await request(app).post("/api/boards").send({ title: "分镜来源" }).expect(201)).body.data;
    const target = (await request(app).post("/api/boards").send({ title: "目标画布" }).expect(201)).body.data;
    const assetId = await upload(app, source.id);

    const sent = await request(app)
      .post(`/api/boards/${target.id}/bridge/assets`)
      .send({ items: [{ assetId, title: "第 3 镜", prompt: "雨夜巷口" }] })
      .expect(200);
    expect(sent.body.data.added).toMatchObject([{ assetId, nodeRef: "n1" }]);
    const node = sent.body.data.board.doc.nodes[0];
    expect(node).toMatchObject({
      type: "image", assetId, title: "第 3 镜", prompt: "雨夜巷口", source: "library", status: "succeeded",
    });
    const refs = context.db.findBoardAssetRefs(assetId).map((ref) => ref.boardId);
    expect(new Set(refs)).toEqual(new Set([source.id, target.id]));

    // 重复发送会被跳过，不会生成重复节点
    const again = await request(app)
      .post(`/api/boards/${target.id}/bridge/assets`)
      .send({ items: [{ assetId }] })
      .expect(200);
    expect(again.body.data.added).toEqual([]);
    expect(again.body.data.skipped).toBe(1);
    const assets = await request(app).get(`/api/boards/${target.id}/assets`).expect(200);
    expect(assets.body.data.map((asset: { id: string }) => asset.id)).toEqual([assetId]);
  });

  it("公共素材可绑定已有节点，对话私有素材不能直接绑定", async () => {
    const { app, context } = await tempApp();
    const source = (await request(app).post("/api/boards").send({ title: "来源" }).expect(201)).body.data;
    const target = (await request(app).post("/api/boards").send({ title: "目标" }).expect(201)).body.data;
    const assetId = await upload(app, source.id);
    await request(app).post(`/api/boards/${target.id}/assets/${assetId}/link`).expect(200);
    expect(context.db.findBoardAssetRefs(assetId).some((ref) => ref.boardId === target.id)).toBe(true);
    const now = new Date().toISOString();
    const doc = { ...target.doc, nextRef: 2, nodes: [{ id: "image-node", ref: "n1", type: "image", x: 0, y: 0, width: 300, height: 310, title: "图片", createdAt: now, updatedAt: now, assetId, source: "library", status: "succeeded" }] };
    const saved = await request(app).put(`/api/boards/${target.id}`).send({ doc, baseVersion: target.version }).expect(200);
    expect(saved.body.data.doc.nodes[0].assetId).toBe(assetId);
    const privateTask = "private-task";
    context.db.createTask({ id: privateTask, channelId: "", model: "", prompt: "私有", input: {}, origin: "upload", libraryScope: "conversation", status: "succeeded" });
    context.db.insertAsset({ id: "private-asset", taskId: privateTask, fileName: "private.png", mimeType: "image/png", byteSize: 1, relativePath: "private.png", baseDir: context.db.assetsDir, sha256: "x", thumbPath: "" });
    await request(app).post(`/api/boards/${target.id}/assets/private-asset/link`).expect(403);
  });

  it("把无限画布图片追加到对话参考图组，去重并尊重 8 张上限", async () => {
    const { app, context } = await tempApp();
    context.db.saveChannel({
      name: "Mock brain",
      baseUrl: "http://127.0.0.1:9",
      adapterType: "openai-chat",
      authType: "none",
      authHeaderName: "",
      secretEnv: "",
      endpoint: "",
      models: ["mock-chat"],
      allowPrivateNetwork: true,
      enabled: true,
    });
    const board = (await request(app).post("/api/boards").send({ title: "参考来源" }).expect(201)).body.data;
    const conversation = (await request(app).post("/api/conversations").send({
      title: "参考图组测试",
    }).expect(201)).body.data;
    const ids: string[] = [];
    for (let index = 0; index < 9; index += 1) ids.push(await upload(app, board.id));

    const appended = await request(app)
      .post(`/api/conversations/${conversation.id}/canvas/append`)
      .send({ assetIds: ids })
      .expect(200);
    expect(appended.body.data.added).toHaveLength(8);
    expect(appended.body.data.skipped).toBe(1);
    expect(appended.body.data.canvasAssetIds).toHaveLength(8);

    const again = await request(app)
      .post(`/api/conversations/${conversation.id}/canvas/append`)
      .send({ assetIds: [ids[0]!] })
      .expect(200);
    expect(again.body.data.added).toEqual([]);
    expect(again.body.data.skipped).toBe(1);
  });

  it("不能往无限画布线程自己的参考图组里塞图", async () => {
    const { app } = await tempApp();
    const board = (await request(app).post("/api/boards").send({ title: "线程限制" }).expect(201)).body.data;
    const assetId = await upload(app, board.id);
    const rejected = await request(app)
      .post(`/api/conversations/${board.threadId}/canvas/append`)
      .send({ assetIds: [assetId] })
      .expect(400);
    expect(rejected.body.error.code).toBe("CONVERSATION_NOT_CHAT");
  });
});
