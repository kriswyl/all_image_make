import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import type { BoardDoc, BoardNode } from "../src/shared/board";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function tempApp() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-board-gen-"));
  const created = createApp({ dataDir });
  cleanups.push(async () => {
    created.context.db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return created;
}

async function mockImageServer(delayMs = 0) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (!req.url?.includes("/images/")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: pngBase64 }] }));
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${port}`;
}

function addMockChannel(db: AppContext["db"], baseUrl: string) {
  return db.saveChannel({
    name: "Mock image",
    baseUrl,
    adapterType: "openai-images",
    authType: "none",
    authHeaderName: "",
    secretEnv: "",
    endpoint: "",
    models: ["mock-image"],
    allowPrivateNetwork: true,
    enabled: true,
  });
}

function nodeBase(ref: string, type: BoardNode["type"], extra: Record<string, unknown> = {}): BoardNode {
  const at = new Date().toISOString();
  return {
    id: `node-${ref}`,
    ref,
    type,
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    title: ref,
    createdAt: at,
    updatedAt: at,
    ...extra,
  } as BoardNode;
}

async function createBoardWithText(app: ReturnType<typeof createApp>["app"], configExtra: Record<string, unknown> = {}) {
  const created = await request(app).post("/api/boards").send({ title: "生成测试" }).expect(201);
  const board = created.body.data;
  const text = nodeBase("n1", "text", { text: "雨夜巷口，霓虹灯反射在积水里" });
  const config = nodeBase("n2", "config", {
    mode: "image", prompt: "电影感，35mm", useUpstreamText: true, count: 1, status: "idle",
    model: "mock-image", ...configExtra,
  });
  const doc: BoardDoc = {
    version: 1,
    nextRef: 3,
    nodes: [text, config],
    edges: [{ id: "edge-1", source: text.id, target: config.id, kind: "input", role: "text" }],
  };
  const saved = await request(app).put(`/api/boards/${board.id}`).send({ doc, baseVersion: 1 }).expect(200);
  return { board: saved.body.data, text, config, doc };
}

async function waitForTask(app: ReturnType<typeof createApp>["app"], taskId: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await request(app).get(`/api/generations/${taskId}`).expect(200);
    const task = response.body.data;
    if (["succeeded", "failed", "cancelled", "expired"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("task did not finish");
}

describe("无限画布配置节点生成", () => {
  it("节点版本对比只返回对应节点的生成结果", async () => {
    const { app, context } = await tempApp();
    const { board, doc } = await createBoardWithText(app);
    const at = new Date().toISOString();
    const imageA = nodeBase("n3", "image", { assetId: null, status: "empty", source: "generated", createdAt: at, updatedAt: at });
    const imageB = nodeBase("n4", "image", { assetId: null, status: "empty", source: "generated", createdAt: at, updatedAt: at });
    const saved = (await request(app).put(`/api/boards/${board.id}`).send({ doc: { ...doc, nextRef: 5, nodes: [...doc.nodes, imageA, imageB] }, baseVersion: board.version }).expect(200)).body.data;
    context.db.createTask({ id: "version-task", channelId: "", model: "mock", prompt: "版本", input: {}, libraryScope: "public", status: "succeeded" });
    for (const id of ["version-a", "version-b"]) context.db.insertAsset({ id, taskId: "version-task", fileName: `${id}.png`, mimeType: "image/png", byteSize: 1, relativePath: `${id}.png`, baseDir: context.db.assetsDir, sha256: "x", thumbPath: "" });
    context.db.addBoardTaskRows({ taskId: "version-task", boardId: board.id, configNodeId: "node-n2", resultNodeIds: [imageA.id, imageB.id], kind: "image" });
    const versions = (await request(app).get(`/api/boards/${board.id}/nodes/${imageB.id}/versions`).expect(200)).body.data;
    expect(versions).toHaveLength(1);
    expect(versions[0].assets.map((asset: { id: string }) => asset.id)).toEqual(["version-b"]);
    await request(app).get(`/api/boards/${board.id}/nodes/not-found/versions`).expect(404);
    expect(saved.id).toBe(board.id);
  });

  it("聚合上游文本、提交任务、返回结果占位节点，并允许把生成素材写回文档", async () => {
    const { app, context } = await tempApp();
    const baseUrl = await mockImageServer();
    addMockChannel(context.db, baseUrl);
    const { board, text, config } = await createBoardWithText(app);

    const generated = await request(app)
      .post(`/api/boards/${board.id}/generate`)
      .send({ nodeId: config.id, overrides: { count: 1 } })
      .expect(202);

    const payload = generated.body.data;
    expect(payload.prompt).toContain("电影感，35mm");
    expect(payload.prompt).toContain("雨夜巷口，霓虹灯反射在积水里");
    expect(payload.modelAlias).toBe("mock-image");
    expect(payload.resultNodeIds).toHaveLength(1);
    expect(payload.board.doc.nodes.filter((node: BoardNode) => node.type === "image")).toHaveLength(1);

    const task = await waitForTask(app, payload.task.id);
    expect(task.status).toBe("succeeded");
    expect(task.assets).toHaveLength(1);
    const assetId = task.assets[0].id;

    // 模拟客户端回填：把 task 产物写进结果节点。素材还没进 board_assets，
    // 必须靠 board_tasks 证明它属于这块板。
    const doc = payload.board.doc as BoardDoc;
    const resultNode = doc.nodes.find((node) => node.id === payload.resultNodeIds[0])!;
    const patched: BoardDoc = {
      ...doc,
      nodes: doc.nodes.map((node) => {
        if (node.id === resultNode.id && node.type === "image") {
          return { ...node, assetId, status: "succeeded" };
        }
        if (node.id === config.id && node.type === "config") {
          return { ...node, status: "succeeded" };
        }
        return node;
      }),
    };
    const saved = await request(app)
      .put(`/api/boards/${board.id}`)
      .send({ doc: patched, baseVersion: payload.board.version })
      .expect(200);
    expect(saved.body.data.doc.nodes.find((node: BoardNode) => node.id === resultNode.id)).toMatchObject({ assetId, status: "succeeded" });

    const assets = await request(app).get(`/api/boards/${board.id}/assets`).expect(200);
    expect(assets.body.data.map((asset: { id: string }) => asset.id)).toContain(assetId);
    // 上游文本节点没被混进结果节点
    expect(assets.body.data).toHaveLength(1);
    expect(text.id).not.toBe(resultNode.id);
  });

  it("没有提示词 / 没有上游文本时拒绝生成，不提交任务", async () => {
    const { app, context } = await tempApp();
    const baseUrl = await mockImageServer();
    addMockChannel(context.db, baseUrl);
    const created = await request(app).post("/api/boards").send({ title: "空提示词" }).expect(201);
    const config = nodeBase("n1", "config", {
      mode: "image", prompt: "", useUpstreamText: true, count: 1, status: "idle", model: "mock-image",
    });
    await request(app).put(`/api/boards/${created.body.data.id}`).send({
      doc: { version: 1, nextRef: 2, nodes: [config], edges: [] },
      baseVersion: 1,
    }).expect(200);

    const rejected = await request(app)
      .post(`/api/boards/${created.body.data.id}/generate`)
      .send({ nodeId: config.id })
      .expect(400);
    expect(rejected.body.error.code).toBe("BOARD_PROMPT_EMPTY");
  });

  it("拒绝引用不存在或不属于当前无限画布的素材", async () => {
    const { app, context } = await tempApp();
    const baseUrl = await mockImageServer();
    addMockChannel(context.db, baseUrl);
    const { board, doc } = await createBoardWithText(app);
    const patched: BoardDoc = {
      ...doc,
      nodes: doc.nodes.map((node) => node.type === "config"
        ? { ...node, status: "succeeded" as const }
        : node),
    };
    // 给配置节点加一个假的图片结果节点，assetId 指向不存在的素材
    patched.nodes.push(nodeBase("n3", "image", {
      assetId: "00000000-0000-4000-8000-000000000000", source: "generated", status: "succeeded",
    }) as BoardNode);
    patched.nextRef = 4;
    patched.edges.push({ id: "edge-2", source: (patched.nodes[1] as { id: string }).id, target: patched.nodes[2]!.id, kind: "result" });

    const rejected = await request(app)
      .put(`/api/boards/${board.id}`)
      .send({ doc: patched, baseVersion: board.version })
      .expect(400);
    expect(rejected.body.error.code).toBe("BOARD_ASSET_INVALID");
  });

  it("重试会创建新任务并保留同一组结果节点", async () => {
    const { app, context } = await tempApp();
    const baseUrl = await mockImageServer();
    addMockChannel(context.db, baseUrl);
    const { board, config } = await createBoardWithText(app);
    const generated = await request(app)
      .post(`/api/boards/${board.id}/generate`)
      .send({ nodeId: config.id })
      .expect(202);
    const first = await waitForTask(app, generated.body.data.task.id);

    const retried = await request(app)
      .post(`/api/boards/${board.id}/tasks/${first.id}/retry`)
      .expect(200);
    const second = retried.body.data;
    expect(second.task.id).not.toBe(first.id);
    expect(second.resultNodeIds).toEqual(generated.body.data.resultNodeIds);
    expect(context.db.listBoardTasksByTask(second.task.id)).toHaveLength(1);
    const task = await waitForTask(app, second.task.id);
    expect(task.status).toBe("succeeded");
  });

  it("停止进行中的任务后，返回的请求不会把它改回成功", async () => {
    const { app, context } = await tempApp();
    const baseUrl = await mockImageServer(600);
    addMockChannel(context.db, baseUrl);
    const { board, config } = await createBoardWithText(app);
    const generated = await request(app)
      .post(`/api/boards/${board.id}/generate`)
      .send({ nodeId: config.id })
      .expect(202);
    const taskId = generated.body.data.task.id;

    await request(app)
      .post(`/api/boards/${board.id}/tasks/${taskId}/cancel`)
      .expect(200);
    await new Promise((resolve) => setTimeout(resolve, 900));
    const task = await request(app).get(`/api/generations/${taskId}`).expect(200);
    expect(task.body.data.status).toBe("cancelled");
  });

  it("图片节点可以就地生成：不新增结果卡片，结果回填同一个节点", async () => {
    const { app, context } = await tempApp();
    const baseUrl = await mockImageServer();
    addMockChannel(context.db, baseUrl);
    const created = await request(app).post("/api/boards").send({ title: "就地生成" }).expect(201);
    const image = nodeBase("n1", "image", {
      assetId: null, source: "upload", status: "empty",
      prompt: "雨夜巷口，霓虹倒映在积水里", model: "mock-image", useUpstreamText: true,
    });
    await request(app).put(`/api/boards/${created.body.data.id}`).send({
      doc: { version: 1, nextRef: 2, nodes: [image], edges: [] },
      baseVersion: 1,
    }).expect(200);

    const generated = await request(app)
      .post(`/api/boards/${created.body.data.id}/generate`)
      .send({ nodeId: image.id })
      .expect(202);
    const payload = generated.body.data;
    expect(payload.kind).toBe("image");
    expect(payload.resultNodeIds).toEqual([image.id]);
    expect(payload.board.doc.nodes).toHaveLength(1);
    expect(payload.board.doc.nodes[0]).toMatchObject({
      id: image.id, type: "image", status: "loading", taskId: payload.task.id,
    });
    expect(context.db.listBoardTasksByTask(payload.task.id)[0]).toMatchObject({
      configNodeId: image.id, resultNodeId: image.id, kind: "image",
    });

    const task = await waitForTask(app, payload.task.id);
    expect(task.status).toBe("succeeded");
    expect(task.assets).toHaveLength(1);
  });

  it("生成结果不会盖住落点上已有的节点", async () => {
    const { app, context } = await tempApp();
    const baseUrl = await mockImageServer();
    addMockChannel(context.db, baseUrl);
    const created = await request(app).post("/api/boards").send({ title: "避让测试" }).expect(201);
    const config = nodeBase("n1", "config", {
      mode: "image", prompt: "电影感", useUpstreamText: false, count: 1, status: "idle",
      model: "mock-image", x: 0, y: 300,
    });
    // 旧算法会把结果放在 (450, 300)，正好压住这张文本卡
    const blocker = nodeBase("n2", "text", { text: "不许被盖住", x: 450, y: 300, width: 320, height: 200 });
    await request(app).put(`/api/boards/${created.body.data.id}`).send({
      doc: { version: 1, nextRef: 3, nodes: [config, blocker], edges: [] },
      baseVersion: 1,
    }).expect(200);

    const generated = await request(app)
      .post(`/api/boards/${created.body.data.id}/generate`)
      .send({ nodeId: config.id })
      .expect(202);
    const result = generated.body.data.board.doc.nodes.find(
      (node: BoardNode) => node.id === generated.body.data.resultNodeIds[0],
    )!;
    const intersects = result.x < blocker.x + blocker.width
      && result.x + result.width > blocker.x
      && result.y < blocker.y + blocker.height
      && result.y + result.height > blocker.y;
    expect(intersects).toBe(false);
  });
});
