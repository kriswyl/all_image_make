import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import type { BoardDoc, BoardNode } from "../src/shared/board";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const png = Buffer.from(pngBase64, "base64");
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function tempApp() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-board-"));
  const created = createApp({ dataDir });
  cleanups.push(async () => {
    created.context.db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { ...created, dataDir };
}

function addChatChannel(db: AppContext["db"]) {
  return db.saveChannel({
    name: "Board brain",
    baseUrl: "http://127.0.0.1:9",
    adapterType: "openai-chat",
    authType: "none",
    authHeaderName: "",
    secretEnv: "",
    endpoint: "",
    models: ["test-chat"],
    allowPrivateNetwork: true,
    enabled: true,
  });
}

function at() {
  return new Date().toISOString();
}

function baseNode(ref: string, type: BoardNode["type"], extra: Record<string, unknown> = {}): BoardNode {
  return {
    id: `node-${ref}`,
    ref,
    type,
    x: 0,
    y: 0,
    width: 280,
    height: 180,
    title: ref,
    createdAt: at(),
    updatedAt: at(),
    ...extra,
  } as BoardNode;
}

async function createBoard(app: ReturnType<typeof createApp>["app"], title = "板") {
  const response = await request(app).post("/api/boards").send({ title }).expect(201);
  return response.body.data as { id: string; threadId: string; version: number; doc: BoardDoc };
}

describe("无限画布 API", () => {
  it("视频上传使用渠道密钥和请求头，并保留上游失败信息", async () => {
    const { app, context } = await tempApp();
    const received: Array<{ auth?: string; user?: string; body: Buffer }> = [];
    let status = 200;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.push({ auth: req.headers.authorization, user: req.headers["new-api-user"] as string, body: Buffer.concat(chunks) });
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(status === 200 ? { url: "https://files.example.com/video.mp4" } : { error: "no" }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("server unavailable");
    const channel = context.db.saveChannel({ name: "video", baseUrl: `http://127.0.0.1:${addr.port}`, adapterType: "wan-video", authType: "bearer", authHeaderName: "", secretEnv: "", endpoint: "", uploadEndpoint: `http://127.0.0.1:${addr.port}/upload`, uploadHeaders: { "New-Api-User": "1" }, models: ["model"], allowPrivateNetwork: true, enabled: true });
    context.sessionKeys.set(channel.id, "test-secret");
    const video = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const send = () => request(app).post("/api/uploads/reference-video").field("channelId", channel.id).attach("file", video, { filename: "test.mp4", contentType: "video/mp4" });
    const uploaded = await send().expect(201);
    expect(uploaded.body.data.url).toBe("https://files.example.com/video.mp4");
    expect(received[0]).toMatchObject({ auth: "Bearer test-secret", user: "1" });
    expect(received[0].body.includes(video)).toBe(true);
    status = 401;
    const failed = await send().expect(502);
    expect(failed.body.error.message).toContain("401");
    expect(JSON.stringify(failed.body)).not.toContain("test-secret");
    await request(app).post("/api/uploads/reference-video").field("channelId", channel.id)
      .attach("file", video, { filename: "bad.webm", contentType: "video/webm" }).expect(400);
  });
  it("素材库接受不超过 20 MB 的图片并拒绝更大的图片", async () => {
    const { app } = await tempApp();
    const board = await createBoard(app);
    const image = Buffer.alloc(20 * 1024 * 1024);
    png.copy(image);
    const upload = await request(app).post(`/api/boards/${board.id}/assets`)
      .attach("file", image, { filename: "large.png", contentType: "image/png" }).expect(201);
    expect(upload.body.data.byteSize).toBe(image.length);
    const oversized = Buffer.concat([image, Buffer.alloc(1)]);
    const rejected = await request(app).post(`/api/boards/${board.id}/assets`)
      .attach("file", oversized, { filename: "too-large.png", contentType: "image/png" }).expect(400);
    expect(rejected.body.error.message).toContain("20 MB");
  });
  it("允许桌面端预检画布保存请求", async () => {
    const { app } = await tempApp();
    for (const origin of ["http://tauri.localhost", "tauri://localhost"]) {
      const response = await request(app).options("/api/boards/test")
        .set("Origin", origin)
        .set("Access-Control-Request-Method", "PUT")
        .set("Access-Control-Request-Headers", "content-type")
        .expect(204);
      expect(response.headers["access-control-allow-origin"]).toBe(origin);
      expect(response.headers["access-control-allow-methods"].split(",")).toContain("PUT");
    }
  });
  it("新建无限画布会同时建一条不出现在对话列表里的 Agent 线程", async () => {
    const { app, context } = await tempApp();
    addChatChannel(context.db);
    const board = await createBoard(app, "第一块板");
    expect(board.version).toBe(1);
    expect(board.doc.nodes).toEqual([]);

    const list = await request(app).get("/api/boards").expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ id: board.id, title: "第一块板", nodeCount: 0 });

    // 普通对话列表不能出现无限画布线程
    await request(app).post("/api/conversations").send({ title: "普通对话" }).expect(201);
    const conversations = await request(app).get("/api/conversations").expect(200);
    expect(conversations.body.data).toHaveLength(1);
    expect(conversations.body.data[0].title).toBe("普通对话");
    expect(conversations.body.data.some((item: { id: string }) => item.id === board.threadId)).toBe(false);

    // 新建普通对话触发的空壳清理不能把无限画布线程当空壳删掉
    await request(app).get(`/api/boards/${board.id}`).expect(200);
    await request(app).get(`/api/conversations/${board.threadId}`).expect(200);
  });

  it("保存文档、重开恢复、版本冲突", async () => {
    const { app, context } = await tempApp();
    addChatChannel(context.db);
    const board = await createBoard(app);
    const doc: BoardDoc = {
      version: 1,
      nextRef: 3,
      nodes: [
        baseNode("n1", "text", { text: "雨夜巷口" }),
        baseNode("n2", "config", { mode: "image", prompt: "", useUpstreamText: true, count: 1, status: "idle" }),
      ],
      edges: [{ id: "e1", source: "node-n1", target: "node-n2", kind: "input", role: "text" }],
    };
    const saved = await request(app).put(`/api/boards/${board.id}`).send({ doc, baseVersion: 1 }).expect(200);
    expect(saved.body.data.version).toBe(2);
    expect(saved.body.data.doc.nodes).toHaveLength(2);

    const reloaded = await request(app).get(`/api/boards/${board.id}`).expect(200);
    expect(reloaded.body.data.doc).toEqual(saved.body.data.doc);

    const conflict = await request(app).put(`/api/boards/${board.id}`).send({ doc, baseVersion: 1 }).expect(409);
    expect(conflict.body.error.code).toBe("BOARD_VERSION_CONFLICT");
    expect(conflict.body.error.details.board.version).toBe(2);
  });

  it("撤销 / 重做在多版本之间来回", async () => {
    const { app, context } = await tempApp();
    addChatChannel(context.db);
    const board = await createBoard(app);
    const textDoc: BoardDoc = {
      version: 1,
      nextRef: 2,
      nodes: [baseNode("n1", "text", { text: "一" })],
      edges: [],
    };
    const second = await request(app).put(`/api/boards/${board.id}`).send({ doc: textDoc, baseVersion: 1 }).expect(200);
    expect(second.body.data.version).toBe(2);

    const undone = await request(app).post(`/api/boards/${board.id}/undo`).send({ baseVersion: 2 }).expect(200);
    expect(undone.body.data.version).toBe(1);
    expect(undone.body.data.doc.nodes).toEqual([]);
    expect(undone.body.data.canRedo).toBe(true);

    const redone = await request(app).post(`/api/boards/${board.id}/redo`).send({ baseVersion: 1 }).expect(200);
    expect(redone.body.data.version).toBe(2);
    expect(redone.body.data.doc.nodes).toHaveLength(1);

    // 撤销后重新编辑：未来快照要作废
    await request(app).post(`/api/boards/${board.id}/undo`).send({ baseVersion: 2 }).expect(200);
    const changed: BoardDoc = { ...textDoc, nodes: [baseNode("n1", "text", { text: "二" })] };
    const branched = await request(app).put(`/api/boards/${board.id}`).send({ doc: changed, baseVersion: 1 }).expect(200);
    expect(branched.body.data.version).toBe(2);
    const noRedo = await request(app).post(`/api/boards/${board.id}/redo`).send({ baseVersion: 2 }).expect(400);
    expect(noRedo.body.error.code).toBe("BOARD_REDO_EMPTY");
  });

  it("上传素材后可以插入图片节点；从无限画布移除素材会把节点标成空", async () => {
    const { app, context } = await tempApp();
    addChatChannel(context.db);
    const board = await createBoard(app);

    const upload = await request(app)
      .post(`/api/boards/${board.id}/assets`)
      .attach("file", png, { filename: "one.png", contentType: "image/png" })
      .expect(201);
    const asset = upload.body.data;
    expect(asset.mimeType).toBe("image/png");
    expect((await request(app).get("/api/library").expect(200)).body.data.flatMap((task: { assets: Array<{ id: string }> }) => task.assets).map((item: { id: string }) => item.id)).toContain(asset.id);

    const doc: BoardDoc = {
      version: 1,
      nextRef: 2,
      nodes: [baseNode("n1", "image", { assetId: asset.id, source: "upload", status: "succeeded" })],
      edges: [],
    };
    const saved = await request(app).put(`/api/boards/${board.id}`).send({ doc, baseVersion: 1 }).expect(200);
    expect(saved.body.data.doc.nodes[0].assetId).toBe(asset.id);

    const assets = await request(app).get(`/api/boards/${board.id}/assets`).expect(200);
    expect(assets.body.data.map((item: { id: string }) => item.id)).toContain(asset.id);

    const removed = await request(app).delete(`/api/boards/${board.id}/assets/${asset.id}`).expect(200);
    expect(removed.body.data.doc.nodes[0].assetId).toBeNull();
    expect(removed.body.data.doc.nodes[0].status).toBe("empty");
    expect((await request(app).get("/api/library").expect(200)).body.data.flatMap((task: { assets: Array<{ id: string }> }) => task.assets).map((item: { id: string }) => item.id)).toContain(asset.id);
    // 素材文件还在，撤销能恢复引用
    const undone = await request(app).post(`/api/boards/${board.id}/undo`).send({ baseVersion: removed.body.data.version }).expect(200);
    expect(undone.body.data.doc.nodes[0].assetId).toBe(asset.id);
  });

  it("素材库支持上传视频和音频并拒绝伪造文件类型", async () => {
    const { app } = await tempApp();
    const board = await createBoard(app);
    const video = await request(app).post(`/api/boards/${board.id}/assets`)
      .attach("file", Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]), { filename: "clip.mp4", contentType: "video/mp4" }).expect(201);
    const audio = await request(app).post(`/api/boards/${board.id}/assets`)
      .attach("file", Buffer.from("RIFFxxxxWAVEfmt "), { filename: "voice.wav", contentType: "audio/wav" }).expect(201);
    expect(video.body.data.mimeType).toBe("video/mp4");
    expect(audio.body.data.mimeType).toBe("audio/wav");
    await request(app).post(`/api/boards/${board.id}/assets`)
      .attach("file", Buffer.from("not media"), { filename: "bad.mp4", contentType: "video/mp4" }).expect(400);
    const library = await request(app).get("/api/library").query({ limit: 20, mode: "assets" }).expect(200);
    const ids = library.body.data.items.flatMap((task: { assets: Array<{ id: string }> }) => task.assets.map((asset) => asset.id));
    expect(ids).toEqual(expect.arrayContaining([video.body.data.id, audio.body.data.id]));
  });

  it("拒绝跨无限画布引用素材", async () => {
    const { app, context } = await tempApp();
    addChatChannel(context.db);
    const first = await createBoard(app, "A");
    const second = await createBoard(app, "B");
    const upload = await request(app)
      .post(`/api/boards/${first.id}/assets`)
      .attach("file", png, { filename: "one.png", contentType: "image/png" })
      .expect(201);
    const asset = upload.body.data;

    const doc: BoardDoc = {
      version: 1,
      nextRef: 2,
      nodes: [baseNode("n1", "image", { assetId: asset.id, source: "upload", status: "succeeded" })],
      edges: [],
    };
    const rejected = await request(app).put(`/api/boards/${second.id}`).send({ doc, baseVersion: 1 }).expect(400);
    expect(rejected.body.error.code).toBe("BOARD_ASSET_INVALID");
  });

  it("画布线程可以换对话模型，但其它会话设置仍然拒绝", async () => {
    const { app, context } = await tempApp();
    const channel = addChatChannel(context.db);
    const board = await createBoard(app);

    const switched = await request(app)
      .patch(`/api/conversations/${board.threadId}`)
      .send({ brainChannelId: channel.id, brainModel: "test-chat" })
      .expect(200);
    expect(switched.body.data.brainModel).toBe("test-chat");

    const rejected = await request(app)
      .patch(`/api/conversations/${board.threadId}`)
      .send({ title: "改个名" })
      .expect(400);
    expect(rejected.body.error.code).toBe("CONVERSATION_NOT_CHAT");
  });

  it("无限画布线程不能访问脚本文档 / 对话上传", async () => {
    const { app, context } = await tempApp();
    addChatChannel(context.db);
    const board = await createBoard(app);
    const documents = await request(app).get(`/api/conversations/${board.threadId}/documents`).expect(400);
    expect(documents.body.error.code).toBe("CONVERSATION_NOT_CHAT");
    const uploads = await request(app).post(`/api/conversations/${board.threadId}/uploads`).expect(400);
    expect(uploads.body.error.code).toBe("CONVERSATION_NOT_CHAT");
  });

  it("删除创作品只删板、线程和历史，不删普通对话", async () => {
    const { app, context } = await tempApp();
    addChatChannel(context.db);
    const board = await createBoard(app);
    const conversation = await request(app).post("/api/conversations").send({ title: "留下" }).expect(201);

    await request(app).delete(`/api/boards/${board.id}`).expect(200);
    await request(app).get(`/api/boards/${board.id}`).expect(404);
    await request(app).get(`/api/conversations/${board.threadId}`).expect(404);
    await request(app).get(`/api/conversations/${conversation.body.data.id}`).expect(200);
  });

  it("删除普通对话不影响无限画布", async () => {
    const { app, context } = await tempApp();
    addChatChannel(context.db);
    const board = await createBoard(app);
    const conversation = await request(app).post("/api/conversations").send({ title: "删我" }).expect(201);
    await request(app).delete(`/api/conversations/${conversation.body.data.id}`).expect(200);
    await request(app).get(`/api/boards/${board.id}`).expect(200);
  });
});
