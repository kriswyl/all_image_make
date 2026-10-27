import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { pcmToWav } from "../src/server/adapters";
import type { BoardDoc, BoardNode } from "../src/shared/board";
import type { Task } from "../src/shared/types";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function tempApp() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-board-audio-"));
  const created = createApp({ dataDir });
  cleanups.push(async () => {
    created.context.db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return created;
}

async function mockTts() {
  const bodies: string[] = [];
  const wav = pcmToWav(Buffer.alloc(48_000), 24_000, 1);
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        candidates: [{
          content: {
            parts: [{ inlineData: { mimeType: "audio/wav", data: wav.toString("base64") } }],
          },
        }],
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies };
}

function addTtsChannel(db: AppContext["db"], baseUrl: string) {
  return db.saveChannel({
    name: "Mock TTS",
    baseUrl,
    adapterType: "gemini-tts",
    authType: "none",
    authHeaderName: "",
    secretEnv: "",
    endpoint: "/v1beta/models/{model}:generateContent",
    models: ["mock-tts"],
    allowPrivateNetwork: true,
    enabled: true,
  });
}

function nodeBase(ref: string, type: BoardNode["type"], extra: Record<string, unknown> = {}): BoardNode {
  const at = new Date().toISOString();
  return {
    id: `node-${ref}`, ref, type, x: 0, y: 0, width: 300, height: 200,
    title: ref, createdAt: at, updatedAt: at, ...extra,
  } as BoardNode;
}

async function waitForTask(app: ReturnType<typeof createApp>["app"], taskId: string): Promise<Task> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(app).get(`/api/generations/${taskId}`).expect(200);
    const task = response.body.data as Task;
    if (["succeeded", "failed", "cancelled", "expired"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("task did not finish");
}

describe("无限画布音频生成", () => {
  it("配音配置节点生成音频节点，并允许把音频写回文档", async () => {
    const { app, context } = await tempApp();
    const mock = await mockTts();
    addTtsChannel(context.db, mock.baseUrl);
    const board = (await request(app).post("/api/boards").send({ title: "配音测试" }).expect(201)).body.data;

    const source = nodeBase("n1", "text", { text: "雨夜巷口，霓虹把积水染成青色。" });
    const config = nodeBase("n2", "config", {
      mode: "audio", audioKind: "speech", prompt: "", useUpstreamText: true, count: 1,
      voice: "Kore", status: "idle", model: "mock-tts",
    });
    const doc: BoardDoc = {
      version: 1,
      nextRef: 3,
      nodes: [source, config],
      edges: [{ id: "edge-1", source: source.id, target: config.id, kind: "input", role: "text" }],
    };
    await request(app).put(`/api/boards/${board.id}`).send({ doc, baseVersion: 1 }).expect(200);

    const generated = await request(app)
      .post(`/api/boards/${board.id}/generate`)
      .send({ nodeId: config.id })
      .expect(202);
    const payload = generated.body.data;
    expect(payload.kind).toBe("audio");
    expect(payload.resultNodeIds).toHaveLength(1);
    const resultNode = payload.board.doc.nodes.find((node: BoardNode) => node.id === payload.resultNodeIds[0]);
    expect(resultNode).toMatchObject({ type: "audio", status: "loading" });
    expect(context.db.listBoardTasksByTask(payload.task.id)[0]).toMatchObject({ kind: "audio" });

    const task = await waitForTask(app, payload.task.id);
    expect(task.status).toBe("succeeded");
    const audio = task.assets.find((asset) => asset.mimeType.startsWith("audio/"));
    expect(audio).toBeTruthy();
    expect(mock.bodies[0]).toContain("雨夜巷口");

    const patched: BoardDoc = {
      ...payload.board.doc,
      nodes: payload.board.doc.nodes.map((node: BoardNode) => {
        if (node.id === resultNode.id && node.type === "audio") {
          return { ...node, assetId: audio!.id, status: "succeeded" };
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
    expect(saved.body.data.doc.nodes.find((node: BoardNode) => node.id === resultNode.id))
      .toMatchObject({ assetId: audio!.id, status: "succeeded" });
    const assets = await request(app).get(`/api/boards/${board.id}/assets`).expect(200);
    expect(assets.body.data).toHaveLength(1);
  });

  it("音频节点可以就地生成配音，不需要额外结果卡", async () => {
    const { app, context } = await tempApp();
    const mock = await mockTts();
    addTtsChannel(context.db, mock.baseUrl);
    const board = (await request(app).post("/api/boards").send({ title: "就地配音" }).expect(201)).body.data;
    const audio = nodeBase("n1", "audio", {
      assetId: null, source: "generated", status: "empty",
      prompt: "雨夜巷口，霓虹把积水染成青色。", useUpstreamText: false,
      audioKind: "speech", voice: "Kore", model: "mock-tts",
    });
    const doc: BoardDoc = { version: 1, nextRef: 2, nodes: [audio], edges: [] };
    await request(app).put(`/api/boards/${board.id}`).send({ doc, baseVersion: 1 }).expect(200);

    const generated = await request(app)
      .post(`/api/boards/${board.id}/generate`)
      .send({ nodeId: audio.id })
      .expect(202);
    const payload = generated.body.data;
    expect(payload.kind).toBe("audio");
    expect(payload.resultNodeIds).toEqual([audio.id]);
    expect(payload.board.doc.nodes).toHaveLength(1);
    expect(payload.board.doc.nodes[0]).toMatchObject({
      id: audio.id, type: "audio", status: "loading", taskId: payload.task.id,
    });
    const task = await waitForTask(app, payload.task.id);
    expect(task.status).toBe("succeeded");
    expect(task.assets.some((asset) => asset.mimeType.startsWith("audio/"))).toBe(true);
    expect(mock.bodies[0]).toContain("雨夜巷口");
  });

  it("音乐模式会创建两个结果占位节点", async () => {
    const { app, context } = await tempApp();
    const mock = await mockTts();
    addTtsChannel(context.db, mock.baseUrl);
    // 用一个假的 Suno 渠道：只验证配置解析和占位数量，不启动音乐轮询
    const suno = context.db.saveChannel({
      name: "Mock music",
      baseUrl: mock.baseUrl,
      adapterType: "suno-music",
      authType: "none",
      authHeaderName: "",
      secretEnv: "",
      endpoint: "/api/queue/makeAiMusic",
      models: ["mock-music"],
      allowPrivateNetwork: true,
      enabled: true,
    });
    const board = (await request(app).post("/api/boards").send({ title: "音乐测试" }).expect(201)).body.data;
    const config = nodeBase("n1", "config", {
      mode: "audio", audioKind: "music", prompt: "温暖的民谣，雨后城市", useUpstreamText: false,
      count: 1, status: "idle", model: "mock-music", channelId: suno.id,
    });
    const doc: BoardDoc = { version: 1, nextRef: 2, nodes: [config], edges: [] };
    await request(app).put(`/api/boards/${board.id}`).send({ doc, baseVersion: 1 }).expect(200);

    const generated = await request(app)
      .post(`/api/boards/${board.id}/generate`)
      .send({ nodeId: config.id })
      .expect(202);
    expect(generated.body.data.kind).toBe("audio");
    expect(generated.body.data.resultNodeIds).toHaveLength(2);
    expect(generated.body.data.board.doc.nodes.filter((node: BoardNode) => node.type === "audio")).toHaveLength(2);
    await request(app).post(`/api/boards/${board.id}/tasks/${generated.body.data.task.id}/cancel`).expect(200);
  });
});
