import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import type { BoardDoc, BoardNode } from "../src/shared/board";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function tempApp() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-board-text-"));
  const created = createApp({ dataDir });
  cleanups.push(async () => {
    created.context.db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return created;
}

async function mockBrain() {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "雨夜巷口，霓虹把积水染成青色。\n一只猫从纸箱后探出头。" } }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}

function addBrainChannel(db: AppContext["db"], baseUrl: string) {
  return db.saveChannel({
    name: "Mock brain",
    baseUrl,
    adapterType: "openai-chat",
    authType: "none",
    authHeaderName: "",
    secretEnv: "",
    endpoint: "/v1/chat/completions",
    models: ["mock-chat"],
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

describe("无限画布文本生成", () => {
  it("用无限画布助手的对话模型生成文本，结果直接写成文本节点", async () => {
    const { app, context } = await tempApp();
    const brain = await mockBrain();
    addBrainChannel(context.db, brain.baseUrl);

    const board = (await request(app).post("/api/boards").send({ title: "文本生成" }).expect(201)).body.data;
    const source = nodeBase("n1", "text", { text: "写一个雨夜巷口的开场，两三句话" });
    const config = nodeBase("n2", "config", {
      mode: "text", prompt: "", useUpstreamText: true, count: 1, status: "idle",
    });
    const doc: BoardDoc = {
      version: 1,
      nextRef: 3,
      nodes: [source, config],
      edges: [{ id: "edge-1", source: source.id, target: config.id, kind: "input", role: "text" }],
    };
    const saved = await request(app)
      .put(`/api/boards/${board.id}`)
      .send({ doc, baseVersion: 1 })
      .expect(200);

    const generated = await request(app)
      .post(`/api/boards/${board.id}/generate`)
      .send({ nodeId: config.id })
      .expect(202);
    const payload = generated.body.data;
    expect(payload.kind).toBe("text");
    expect(payload.task).toBeNull();
    expect(payload.resultNodeIds).toHaveLength(1);
    expect(brain.bodies).toHaveLength(1);
    expect(brain.bodies[0]).toContain("雨夜巷口");

    const resultNode = payload.board.doc.nodes.find((node: BoardNode) => node.id === payload.resultNodeIds[0]);
    expect(resultNode).toMatchObject({ type: "text", title: "生成文本" });
    expect(resultNode.text).toContain("霓虹把积水染成青色");
    const edge = payload.board.doc.edges.find((item: { source: string; target: string }) =>
      item.source === config.id && item.target === resultNode.id);
    expect(edge).toMatchObject({ kind: "result" });
    expect(payload.board.doc.nodes.find((node: BoardNode) => node.id === config.id))
      .toMatchObject({ status: "succeeded", model: "mock-chat" });
    expect(payload.board.version).toBe(saved.body.data.version + 1);
  });

  it("生文本连着图片上游时明确拒绝，不调用大脑", async () => {
    const { app, context } = await tempApp();
    const brain = await mockBrain();
    addBrainChannel(context.db, brain.baseUrl);
    const board = (await request(app).post("/api/boards").send({ title: "文本 + 图片" }).expect(201)).body.data;

    const boardId = board.id as string;
    const uploaded = await request(app)
      .post(`/api/boards/${boardId}/assets`)
      .attach("file", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"), {
        filename: "frame.png",
        contentType: "image/png",
      })
      .expect(201);
    const config = nodeBase("n1", "config", { mode: "text", prompt: "写点什么", status: "idle" });
    const image = nodeBase("n2", "image", {
      assetId: uploaded.body.data.id, source: "upload", status: "succeeded",
    });
    const doc: BoardDoc = {
      version: 1,
      nextRef: 3,
      nodes: [config, image],
      edges: [{ id: "edge-1", source: image.id, target: config.id, kind: "input" }],
    };
    await request(app).put(`/api/boards/${boardId}`).send({ doc, baseVersion: 1 }).expect(200);

    const rejected = await request(app)
      .post(`/api/boards/${boardId}/generate`)
      .send({ nodeId: config.id })
      .expect(400);
    expect(rejected.body.error.code).toBe("BOARD_TEXT_IMAGE_UNSUPPORTED");
    expect(brain.bodies).toHaveLength(0);
  });
});
