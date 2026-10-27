import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { resolveBoardVideoSelection } from "../src/server/board";
import type { BoardDoc, BoardNode, ConfigBoardNode } from "../src/shared/board";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function tempApp() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-board-video-"));
  const created = createApp({ dataDir });
  cleanups.push(async () => {
    created.context.db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return created;
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

function videoDoc(input: {
  mode?: "text-to-video" | "first-frame" | "first-last-frame" | "reference";
  images: Array<{ ref: string; role?: "first-frame" | "last-frame" | "reference" }>;
}): { doc: BoardDoc; config: ConfigBoardNode } {
  const text = nodeBase("n1", "text", { text: "一只猫在雨里跑" });
  const config = nodeBase("n2", "config", {
    mode: "video",
    prompt: "电影感",
    useUpstreamText: true,
    count: 1,
    status: "idle",
    ...(input.mode ? { videoMode: input.mode } : {}),
  }) as ConfigBoardNode;
  const images = input.images.map((item, index) => nodeBase(`n${index + 3}`, "image", {
    assetId: `asset-${index + 1}`,
    source: "upload",
    status: "succeeded",
  }));
  const edges = [
    { id: "edge-text", source: text.id, target: config.id, kind: "input" as const, role: "text" as const },
    ...images.map((image, index) => ({
      id: `edge-img-${index}`,
      source: image.id,
      target: config.id,
      kind: "input" as const,
      ...(input.images[index]!.role ? { role: input.images[index]!.role! } : {}),
    })),
  ];
  return {
    doc: {
      version: 1,
      nextRef: images.length + 3,
      nodes: [text, config, ...images],
      edges,
    },
    config,
  };
}

describe("无限画布视频输入解析", () => {
  it("单张自动角色图按首帧处理", () => {
    const { doc, config } = videoDoc({ images: [{ ref: "n3" }] });
    const resolved = resolveBoardVideoSelection({ doc, config, adapterType: "wan-video", model: "wan-test" });
    expect(resolved.selection?.mode).toBe("first-frame");
    expect(resolved.selection?.inputs.map((item) => item.role)).toEqual(["first_frame"]);
  });

  it("首帧 + 尾帧按首尾帧处理，并保留两张图", () => {
    const { doc, config } = videoDoc({
      images: [{ ref: "n3", role: "first-frame" }, { ref: "n4", role: "last-frame" }],
    });
    const resolved = resolveBoardVideoSelection({ doc, config, adapterType: "wan-video", model: "wan-test" });
    expect(resolved.selection?.mode).toBe("first-last-frame");
    expect(resolved.selection?.inputs.map((item) => item.role)).toEqual(["first_frame", "last_frame"]);
  });

  it("显式参考图模式保留所有图片，并按参考图发送", () => {
    const { doc, config } = videoDoc({
      mode: "reference",
      images: [{ ref: "n3", role: "reference" }, { ref: "n4", role: "reference" }],
    });
    const resolved = resolveBoardVideoSelection({ doc, config, adapterType: "wan-video", model: "wan-test" });
    expect(resolved.selection?.mode).toBe("reference");
    expect(resolved.selection?.inputs).toHaveLength(2);
    expect(resolved.selection?.inputs.every((item) => item.role === "reference_image")).toBe(true);
  });

  it("文生视频连着图时明确报错，不悄悄丢掉图片", () => {
    const { doc, config } = videoDoc({ mode: "text-to-video", images: [{ ref: "n3" }] });
    const resolved = resolveBoardVideoSelection({ doc, config, adapterType: "wan-video", model: "wan-test" });
    expect(resolved.selection).toBeUndefined();
    expect(resolved.error).toContain("文生视频");
  });

  it("模型不支持的模式会被拒绝", () => {
    const { doc, config } = videoDoc({
      mode: "reference",
      images: [{ ref: "n3", role: "reference" }],
    });
    const resolved = resolveBoardVideoSelection({
      doc, config, adapterType: "kling-video", model: "kling-3.0-turbo",
    });
    expect(resolved.selection).toBeUndefined();
    expect(resolved.error).toContain("参考生视频");
  });
});

async function mockWanVideo(): Promise<{ baseUrl: string; requests: Array<{ url?: string; body: string }> }> {
  const requests: Array<{ url?: string; body: string }> = [];
  let polls = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ url: req.url, body });
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      if (req.url === "/api/v1/services/aigc/video-generation/video-synthesis" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ output: { task_id: "video-task-1", task_status: "PENDING" } }));
        return;
      }
      if (req.url === "/api/v1/tasks/video-task-1") {
        polls += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(polls < 2
          ? { output: { task_id: "video-task-1", task_status: "RUNNING", progress: 50 } }
          : { output: { task_id: "video-task-1", task_status: "SUCCEEDED" }, video: `${origin}/out.mp4` }));
        return;
      }
      if (req.url === "/out.mp4") {
        res.writeHead(200, { "content-type": "video/mp4" });
        res.end(Buffer.from("fake-mp4-bytes"));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
}

function addVideoChannel(db: AppContext["db"], baseUrl: string) {
  return db.saveChannel({
    name: "Mock video",
    baseUrl,
    adapterType: "wan-video",
    authType: "none",
    authHeaderName: "",
    secretEnv: "",
    endpoint: "/api/v1/services/aigc/video-generation/video-synthesis",
    models: ["wan-test"],
    allowPrivateNetwork: true,
    enabled: true,
  });
}

async function waitForTask(app: ReturnType<typeof createApp>["app"], taskId: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await request(app).get(`/api/generations/${taskId}`).expect(200);
    const task = response.body.data;
    if (["succeeded", "failed", "cancelled", "expired"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("task did not finish");
}

describe("无限画布视频生成", () => {
  it("按首帧提交视频任务、创建视频结果节点，并允许把视频写回文档", async () => {
    const { app, context } = await tempApp();
    const mock = await mockWanVideo();
    addVideoChannel(context.db, mock.baseUrl);

    const created = await request(app).post("/api/boards").send({ title: "视频测试" }).expect(201);
    const boardId = created.body.data.id as string;
    const uploaded = await request(app)
      .post(`/api/boards/${boardId}/assets`)
      .attach("file", Buffer.from(pngBase64, "base64"), { filename: "frame.png", contentType: "image/png" })
      .expect(201);
    const assetId = uploaded.body.data.id as string;

    const text = nodeBase("n1", "text", { text: "一只猫在雨里跑" });
    const config = nodeBase("n2", "config", {
      mode: "video", prompt: "电影感，慢镜头", useUpstreamText: true, count: 1,
      model: "wan-test", durationSeconds: 5, resolution: "720P", audio: true, status: "idle",
    });
    const frame = nodeBase("n3", "image", { assetId, source: "upload", status: "succeeded" });
    const doc: BoardDoc = {
      version: 1,
      nextRef: 4,
      nodes: [text, config, frame],
      edges: [
        { id: "edge-text", source: text.id, target: config.id, kind: "input", role: "text" },
        { id: "edge-frame", source: frame.id, target: config.id, kind: "input", role: "first-frame" },
      ],
    };
    const saved = await request(app)
      .put(`/api/boards/${boardId}`)
      .send({ doc, baseVersion: 1 })
      .expect(200);
    const board = saved.body.data;

    const generated = await request(app)
      .post(`/api/boards/${boardId}/generate`)
      .send({ nodeId: config.id })
      .expect(202);
    const payload = generated.body.data;
    expect(payload.referenceCount).toBe(1);
    expect(payload.modelAlias).toBe("wan");
    expect(payload.resultNodeIds).toHaveLength(1);
    const resultNode = payload.board.doc.nodes.find((node: BoardNode) => node.id === payload.resultNodeIds[0]);
    expect(resultNode).toMatchObject({ type: "video", status: "loading" });
    expect(context.db.listBoardTasksByTask(payload.task.id)[0]).toMatchObject({ kind: "video" });

    // 提交给万相的请求确实进了首帧媒体和视频参数
    for (let attempt = 0; attempt < 60 && !mock.requests.some((item) => item.url?.includes("video-synthesis")); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const submit = mock.requests.find((item) => item.url?.includes("video-synthesis"));
    expect(submit?.body).toContain("first_frame");
    expect(submit?.body).toContain("慢镜头");
    expect(submit?.body).toContain("720P");

    const task = await waitForTask(app, payload.task.id);
    expect(task.status).toBe("succeeded");
    const videoAsset = task.assets.find((asset: { mimeType: string }) => asset.mimeType.startsWith("video/"));
    expect(videoAsset).toBeTruthy();

    const patched: BoardDoc = {
      ...payload.board.doc,
      nodes: payload.board.doc.nodes.map((node: BoardNode) => {
        if (node.id === resultNode.id && node.type === "video") {
          return { ...node, assetId: videoAsset.id, status: "succeeded" };
        }
        if (node.id === config.id && node.type === "config") {
          return { ...node, status: "succeeded" };
        }
        return node;
      }),
    };
    const after = await request(app)
      .put(`/api/boards/${boardId}`)
      .send({ doc: patched, baseVersion: payload.board.version })
      .expect(200);
    expect(after.body.data.doc.nodes.find((node: BoardNode) => node.id === resultNode.id))
      .toMatchObject({ assetId: videoAsset.id, status: "succeeded" });
    expect(board.version).toBe(2);
  });
});
