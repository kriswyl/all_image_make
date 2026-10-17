import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

// 打开素材目录会真的弹文件管理器窗口，测试里换成假的 spawn
const spawnMock = vi.hoisted(() => vi.fn(() => ({ on: () => undefined, unref: () => undefined })));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { createApp, type AppContext } from "../src/server/app";
import type { Task } from "../src/shared/types";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("generation API", () => {
  it("only ever reveals the app's own media folders", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-reveal-test-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const assetsDir = path.join(dataDir, "assets");
    const response = await request(app).post("/api/system/reveal-media").send({ kind: "assets" }).expect(200);
    expect(response.body.data.opened).toBe(assetsDir);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [command, args] = spawnMock.mock.calls[0] as unknown as [string, string[]];
    expect(command).toMatch(/explorer|open|xdg-open/);
    expect(args).toEqual([assetsDir]);

    // kind 只认三个固定值，传路径进来也只会落到素材目录
    const injected = await request(app).post("/api/system/reveal-media").send({ kind: "../../Windows" }).expect(200);
    expect(injected.body.data.opened).toBe(assetsDir);
    const inputs = await request(app).post("/api/system/reveal-media").send({ kind: "inputs" }).expect(200);
    expect(inputs.body.data.opened).toBe(path.join(dataDir, "inputs"));
  });

  it("starts a fresh data directory with no channels", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-defaults-test-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const bootstrap = (await request(app).get("/api/bootstrap").expect(200)).body.data;
    expect(bootstrap.channels).toEqual([]);
  });

  it("keeps channel API keys after a restart and forgets deleted channels", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-keys-test-"));
    const channelInput = {
      name: "Relay", baseUrl: "http://127.0.0.1:8123", adapterType: "openai-images",
      authType: "bearer", authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations",
      models: ["image-model"], allowPrivateNetwork: true, enabled: true, apiKey: "sk-persisted",
    };

    const first = createApp({ dataDir });
    const created = (await request(first.app).post("/api/channels").send(channelInput).expect(201)).body.data;
    expect(created.hasKey).toBe(true);
    first.context.db.close();

    // 重开服务：密钥应当从数据目录载入，不需要二次配置
    const second = createApp({ dataDir });
    cleanups.push(() => { second.context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });
    const reloaded = (await request(second.app).get("/api/bootstrap").expect(200)).body.data;
    expect(reloaded.channels).toHaveLength(1);
    expect(reloaded.channels[0].hasKey).toBe(true);
    expect(second.context.sessionKeys.get(created.id)).toBe("sk-persisted");
    // 密钥文件不会把明文暴露给渠道接口响应
    expect(JSON.stringify(reloaded.channels)).not.toContain("sk-persisted");

    await request(second.app).delete(`/api/channels/${created.id}`).expect(200);
    expect(second.context.sessionKeys.get(created.id)).toBeUndefined();
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, "channel-keys.json"), "utf8"));
    expect(stored).toEqual({});
  });

  it("persists a channel, generates an image and records diagnostics", async () => {
    const mockServer = http.createServer((req, res) => {
      if (req.url === "/v1/images/generations" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: pngBase64 }] }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
    await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => mockServer.close(() => resolve())));
    const address = mockServer.address();
    if (!address || typeof address === "string") throw new Error("Mock server did not start");

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-test-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const channelResponse = await request(app).post("/api/channels").send({
      name: "Local Mock", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-images", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations", models: ["mock-image"],
      allowPrivateNetwork: true, enabled: true,
    }).expect(201);
    const channelId = channelResponse.body.data.id as string;

    const createResponse = await request(app).post("/api/generations").send({ channelId, model: "mock-image", prompt: "test image", size: "1024x1024", count: 1 }).expect(202);
    const taskId = createResponse.body.data.id as string;
    let task = createResponse.body.data;
    for (let index = 0; index < 30 && task.status !== "succeeded"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      task = (await request(app).get(`/api/generations/${taskId}`).expect(200)).body.data;
    }
    expect(task.status).toBe("succeeded");
    expect(task.assets).toHaveLength(1);
    expect(task.channelName).toBe("Local Mock");
    const imageResponse = await request(app).get(task.assets[0].url).expect(200);
    expect(imageResponse.headers["content-type"]).toContain("image/png");
    expect(imageResponse.headers["content-disposition"]).toBeUndefined();
    const downloadResponse = await request(app).get(`${task.assets[0].url}?download=1`).expect(200);
    expect(downloadResponse.headers["content-disposition"]).toContain("attachment");
    expect(downloadResponse.headers["content-disposition"]).toContain(task.assets[0].fileName);
    const diagnostics = (await request(app).get(`/api/generations/${taskId}/diagnostics`).expect(200)).body.data;
    expect(diagnostics).toHaveLength(1);
    expect(JSON.stringify(diagnostics)).not.toContain("Authorization");
  });

  it("accepts base64 data URIs in wanVideoMedia without hitting body size limits", async () => {
    // 万相的异步接口：提交返回 task_id，轮询立刻报完成但不给视频，任务会失败收尾——
    // 这里只关心大体积 body 能否通过 express 与 zod 的校验
    let receivedMedia: Array<{ type: string; url: string }> = [];
    const mockServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        if (req.method === "POST") {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          receivedMedia = parsed.input?.media ?? [];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ output: { task_id: "task-1", task_status: "PENDING" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ output: { task_status: "FAILED", message: "stop here" } }));
      });
    });
    await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => mockServer.close(() => resolve())));
    const address = mockServer.address();
    if (!address || typeof address === "string") throw new Error("Mock server did not start");

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-wan-video-test-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const channelResponse = await request(app).post("/api/channels").send({
      name: "Wan Video", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "wan-video",
      authType: "bearer", authHeaderName: "", secretEnv: "",
      endpoint: "/api/v1/services/aigc/video-generation/video-synthesis", models: ["wan3.0-video"],
      allowPrivateNetwork: true, enabled: true, apiKey: "sk-test",
    }).expect(201);
    const channelId = channelResponse.body.data.id as string;

    // 两张 600KB 的图合计约 1.2M 字符，压在 1.4M 的中转站预算内，
    // 用来确认 express / zod 这一层不会拦下正常的 base64 素材
    const pngBase64 = "A".repeat(600_000);
    const createResponse = await request(app).post("/api/generations").send({
      channelId,
      model: "wan3.0-video",
      prompt: "test video",
      wanVideoMode: "first-last-frame",
      wanVideoMedia: [
        { type: "first_frame", url: `data:image/png;base64,${pngBase64}` },
        { type: "last_frame", url: `data:image/png;base64,${pngBase64}` },
      ],
    }).expect(202);
    const taskId = createResponse.body.data.id as string;

    // 等到请求真的发出去，确认两张图带着各自的 type 到达上游
    for (let index = 0; index < 40 && receivedMedia.length === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(receivedMedia.map((item) => item.type)).toEqual(["first_frame", "last_frame"]);
    expect(receivedMedia[0].url.startsWith("data:image/png;base64,")).toBe(true);

    // 等任务自己进入终态再收尾：mock 的 GET 会返回 FAILED，轮询随即结束，
    // 否则后台轮询会在 DB 关闭后继续访问
    await request(app).post(`/api/generations/${taskId}/cancel`);
    let settled = createResponse.body.data;
    for (let index = 0; index < 60; index += 1) {
      settled = (await request(app).get(`/api/generations/${taskId}`).expect(200)).body.data;
      if (["failed", "expired", "cancelled", "succeeded"].includes(settled.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    expect(["failed", "expired", "cancelled", "succeeded"]).toContain(settled.status);
  });

  it("rejects inline media beyond the relay request budget with an actionable message", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-oversize-test-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const channelResponse = await request(app).post("/api/channels").send({
      name: "Seedance Video", baseUrl: "https://api.tiantoken.com", adapterType: "seedance-video",
      authType: "bearer", authHeaderName: "", secretEnv: "",
      endpoint: "/api/v3/contents/generations/tasks", models: ["sd-2.5"],
      allowPrivateNetwork: false, enabled: true, apiKey: "sk-test",
    }).expect(201);

    // 单张约 3.7M 字符，远超实测约 2MB 就被网关掐断的上限
    const response = await request(app).post("/api/generations").send({
      channelId: channelResponse.body.data.id,
      model: "sd-2.5",
      prompt: "test video",
      seedanceVideoMode: "first-frame",
      seedanceVideoMedia: [
        { type: "image_url", url: `data:image/png;base64,${"A".repeat(3_700_000)}`, role: "first_frame" },
      ],
    }).expect(400);

    expect(response.body.error.code).toBe("INVALID_INPUT");
    expect(String(response.body.error.message)).toContain("请求体上限");
  });

  it("runs a Seedance task end to end: submit, poll content.video_url, download", async () => {
    let submittedBody: Record<string, unknown> = {};
    let pollCount = 0;
    let mockOrigin = "";
    const mockServer = http.createServer((req, res) => {
      if (req.url === "/api/v3/contents/generations/tasks" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
          submittedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "cgt-abc" }));
        });
        return;
      }
      if (req.url === "/api/v3/contents/generations/tasks/cgt-abc" && req.method === "GET") {
        pollCount += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        // 先 running 一次，再 succeeded，验证轮询会继续而不是首次就收工
        res.end(JSON.stringify(pollCount < 2
          ? { id: "cgt-abc", status: "running" }
          : { id: "cgt-abc", status: "succeeded", content: { video_url: `${mockOrigin}/out.mp4` }, duration: 5 }));
        return;
      }
      if (req.url === "/out.mp4" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "video/mp4" });
        res.end(Buffer.from("fake-mp4-bytes"));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
    await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => mockServer.close(() => resolve())));
    const address = mockServer.address();
    if (!address || typeof address === "string") throw new Error("Mock server did not start");
    mockOrigin = `http://127.0.0.1:${address.port}`;

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-seedance-test-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const channelResponse = await request(app).post("/api/channels").send({
      name: "Seedance", baseUrl: mockOrigin, adapterType: "seedance-video", authType: "bearer",
      authHeaderName: "", secretEnv: "", endpoint: "/api/v3/contents/generations/tasks",
      models: ["sd-2.5"], allowPrivateNetwork: true, enabled: true, apiKey: "sk-test",
    }).expect(201);

    const createResponse = await request(app).post("/api/generations").send({
      channelId: channelResponse.body.data.id, model: "sd-2.5", prompt: "a cat running",
      duration: 5, resolution: "720p", ratio: "16:9", audio: false,
    }).expect(202);
    const taskId = createResponse.body.data.id as string;

    let task = createResponse.body.data;
    for (let index = 0; index < 40 && task.status !== "succeeded"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      task = (await request(app).get(`/api/generations/${taskId}`).expect(200)).body.data;
      if (["failed", "expired", "cancelled"].includes(task.status)) break;
    }
    if (task.status !== "succeeded") throw new Error(`Task ended as ${task.status}: ${task.errorMessage}`);

    // 提交体按官方格式构造
    expect(submittedBody).toMatchObject({
      model: "sd-2.5",
      content: [{ type: "text", text: "a cat running" }],
      resolution: "720p",
      ratio: "16:9",
      duration: 5,
      generate_audio: false,
    });
    expect(pollCount).toBeGreaterThanOrEqual(2);

    // 视频落盘，时长从响应里带过来
    expect(task.assets).toHaveLength(1);
    expect(task.assets[0].mimeType).toBe("video/mp4");
    expect(task.assets[0].duration).toBe(5);
    const video = await request(app).get(task.assets[0].url).expect(200);
    expect(video.headers["content-type"]).toContain("video/mp4");
  });

  // 中转在任务刚提交时回的就是这个形状：status: "unknown"、video 还是空串。
  // 以前 unknown 被当成终态，第一次轮询就把还在生成的视频判成 REMOTE_TASK_FAILED。
  it("keeps polling while the relay reports an unknown status instead of failing", async () => {
    let mockOrigin = "";
    let pollCount = 0;
    const mockServer = http.createServer((req, res) => {
      if (req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ output: { task_id: "task-1", task_status: "PENDING" } }));
        return;
      }
      if (req.url === "/api/v1/tasks/task-1") {
        pollCount += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(pollCount < 2
          ? { id: "task-1", task_id: "task-1", video: "", status: "unknown", progress: 0, created_at: 1791800509, completed_at: 1791800509 }
          : { id: "task-1", task_id: "task-1", video: `${mockOrigin}/out.mp4`, status: "succeeded", progress: 100 }));
        return;
      }
      if (req.url === "/out.mp4") {
        res.writeHead(200, { "Content-Type": "video/mp4" });
        res.end(Buffer.from("fake-mp4-bytes"));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
    await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => mockServer.close(() => resolve())));
    const address = mockServer.address();
    if (!address || typeof address === "string") throw new Error("Mock server did not start");
    mockOrigin = `http://127.0.0.1:${address.port}`;

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-unknown-status-test-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const channelResponse = await request(app).post("/api/channels").send({
      name: "Wan Video", baseUrl: mockOrigin, adapterType: "wan-video", authType: "bearer",
      authHeaderName: "", secretEnv: "", endpoint: "/api/v1/services/aigc/video-generation/video-synthesis",
      models: ["wan3.0-video"], allowPrivateNetwork: true, enabled: true, apiKey: "sk-test",
    }).expect(201);

    const createResponse = await request(app).post("/api/generations").send({
      channelId: channelResponse.body.data.id, model: "wan3.0-video", prompt: "a cat running",
    }).expect(202);
    const taskId = createResponse.body.data.id as string;

    let task = createResponse.body.data;
    for (let index = 0; index < 40 && task.status !== "succeeded"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      task = (await request(app).get(`/api/generations/${taskId}`).expect(200)).body.data;
      if (["failed", "expired", "cancelled"].includes(task.status)) break;
    }
    if (task.status !== "succeeded") throw new Error(`Task ended as ${task.status}: ${task.errorMessage}`);

    expect(pollCount).toBeGreaterThanOrEqual(2);
    expect(task.errorCode).toBeNull();
    expect(task.assets).toHaveLength(1);
    expect(task.assets[0].mimeType).toBe("video/mp4");
  });

  // 另一类中转：生成完也不改 status，只把 video 字段填上，靠地址本身认定完成
  it("accepts a finished video when the relay fills video but never leaves the unknown status", async () => {
    let mockOrigin = "";
    let pollCount = 0;
    const mockServer = http.createServer((req, res) => {
      if (req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "task-2" }));
        return;
      }
      if (req.url === "/api/v1/tasks/task-2") {
        pollCount += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: "task-2", status: "unknown", progress: 40, video: `${mockOrigin}/out.mp4` }));
        return;
      }
      if (req.url === "/out.mp4") {
        res.writeHead(200, { "Content-Type": "video/mp4" });
        res.end(Buffer.from("fake-mp4-bytes"));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
    await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => mockServer.close(() => resolve())));
    const address = mockServer.address();
    if (!address || typeof address === "string") throw new Error("Mock server did not start");
    mockOrigin = `http://127.0.0.1:${address.port}`;

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-stuck-unknown-test-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const channelResponse = await request(app).post("/api/channels").send({
      name: "Wan Video", baseUrl: mockOrigin, adapterType: "wan-video", authType: "bearer",
      authHeaderName: "", secretEnv: "", endpoint: "/api/v1/services/aigc/video-generation/video-synthesis",
      models: ["wan3.0-video"], allowPrivateNetwork: true, enabled: true, apiKey: "sk-test",
    }).expect(201);

    const createResponse = await request(app).post("/api/generations").send({
      channelId: channelResponse.body.data.id, model: "wan3.0-video", prompt: "a cat running",
    }).expect(202);
    const taskId = createResponse.body.data.id as string;

    let task = createResponse.body.data;
    for (let index = 0; index < 40 && task.status !== "succeeded"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      task = (await request(app).get(`/api/generations/${taskId}`).expect(200)).body.data;
      if (["failed", "expired", "cancelled"].includes(task.status)) break;
    }
    if (task.status !== "succeeded") throw new Error(`Task ended as ${task.status}: ${task.errorMessage}`);

    expect(pollCount).toBe(1);
    expect(task.assets).toHaveLength(1);
    expect(task.assets[0].mimeType).toBe("video/mp4");
  });

  it("deletes a generation and cleans up its asset and input files", async () => {
    let mockOrigin = "";
    const mockServer = http.createServer((req, res) => {
      if (req.url === "/image.png" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(Buffer.from(pngBase64, "base64"));
        return;
      }
      // 带参考图会走 edits 端点：同一张图同时以 base64 与可下载 URL 出现，验证按字节内容去重只落盘一张
      if ((req.url === "/v1/images/generations" || req.url === "/v1/images/edits") && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: pngBase64 }, { url: `${mockOrigin}/image.png` }] }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
    await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => mockServer.close(() => resolve())));
    const address = mockServer.address();
    if (!address || typeof address === "string") throw new Error("Mock server did not start");
    mockOrigin = `http://127.0.0.1:${address.port}`;

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-delete-test-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const channelResponse = await request(app).post("/api/channels").send({
      name: "Delete Mock", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-images", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations", models: ["mock-image"],
      allowPrivateNetwork: true, enabled: true,
    }).expect(201);
    const pngBytes = Buffer.from(pngBase64, "base64");
    const createResponse = await request(app).post("/api/generations")
      .field("payload", JSON.stringify({ channelId: channelResponse.body.data.id, model: "mock-image", prompt: "delete me" }))
      .attach("referenceImages", pngBytes, "source.png")
      .expect(202);
    const taskId = createResponse.body.data.id as string;
    let task = createResponse.body.data;
    for (let index = 0; index < 30 && task.status !== "succeeded"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      task = (await request(app).get(`/api/generations/${taskId}`).expect(200)).body.data;
    }
    expect(task.status).toBe("succeeded");
    // 中转把同一张图放在两个位置，去重后只应保存一张
    expect(task.assets).toHaveLength(1);
    expect(await fs.readdir(path.join(dataDir, "assets"))).toHaveLength(1);
    expect(await fs.readdir(path.join(dataDir, "inputs"))).toHaveLength(1);

    await request(app).delete(`/api/generations/${taskId}`).expect(200);
    expect(context.db.getTaskRow(taskId)).toBeNull();
    expect(await fs.readdir(path.join(dataDir, "assets"))).toHaveLength(0);
    expect(await fs.readdir(path.join(dataDir, "inputs"))).toHaveLength(0);
    await request(app).delete(`/api/generations/${taskId}`).expect(404);
  });

  it("persists a reference image outside SQLite and submits an OpenAI edit request", async () => {
    let receivedContentType = "";
    let receivedBody = "";
    const mockServer = http.createServer((req, res) => {
      if (req.url === "/v1/images/edits" && req.method === "POST") {
        receivedContentType = String(req.headers["content-type"] ?? "");
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
          receivedBody = Buffer.concat(chunks).toString("latin1");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: [{ b64_json: pngBase64 }] }));
        });
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
    await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => mockServer.close(() => resolve())));
    const address = mockServer.address();
    if (!address || typeof address === "string") throw new Error("Mock server did not start");

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-edit-test-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const channelResponse = await request(app).post("/api/channels").send({
      name: "Edit Mock", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-images", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations", models: ["mock-image"],
      allowPrivateNetwork: true, enabled: true,
    }).expect(201);
    const pngBytes = Buffer.from(pngBase64, "base64");
    const createResponse = await request(app).post("/api/generations")
      .field("payload", JSON.stringify({ channelId: channelResponse.body.data.id, model: "mock-image", prompt: "edit image" }))
      .attach("referenceImages", pngBytes, "source.png")
      .attach("referenceImages", pngBytes, "source-2.png")
      .expect(202);
    const taskId = createResponse.body.data.id as string;
    let task = createResponse.body.data;
    for (let index = 0; index < 30 && task.status !== "succeeded"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      task = (await request(app).get(`/api/generations/${taskId}`).expect(200)).body.data;
    }

    expect(task.status).toBe("succeeded");
    expect(receivedContentType).toContain("multipart/form-data; boundary=");
    expect(receivedBody).toContain('name="image[]"; filename="source.png"');
    expect(receivedBody).toContain('name="image[]"; filename="source-2.png"');
    expect(receivedBody).toContain('name="prompt"');
    expect(receivedBody).toContain("edit image");
    const storedInput = context.db.getTaskRow(taskId)?.inputJson ?? "";
    expect(storedInput).not.toContain(pngBase64);
    expect(JSON.parse(storedInput).referenceImages).toHaveLength(2);
    expect(JSON.parse(storedInput).referenceImages[0]).toMatchObject({ mimeType: "image/png", byteSize: 68 });
    expect(await fs.readdir(path.join(dataDir, "inputs"))).toHaveLength(2);
    const diagnostics = (await request(app).get(`/api/generations/${taskId}/diagnostics`).expect(200)).body.data;
    expect(JSON.stringify(diagnostics[0].request)).not.toContain(pngBase64);
    expect(diagnostics[0].request.body["image[]"]).toMatchObject([{ fileName: "source.png" }, { fileName: "source-2.png" }]);

    const retryResponse = await request(app).post(`/api/generations/${taskId}/retry`).expect(202);
    const retryTaskId = retryResponse.body.data.id as string;
    let retryTask = retryResponse.body.data;
    for (let index = 0; index < 30 && retryTask.status !== "succeeded"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      retryTask = (await request(app).get(`/api/generations/${retryTaskId}`).expect(200)).body.data;
    }
    expect(retryTask.status).toBe("succeeded");
    expect(context.db.getTaskRow(retryTaskId)?.inputJson).not.toContain(pngBase64);
    expect(await fs.readdir(path.join(dataDir, "inputs"))).toHaveLength(4);
  });
});

describe("history cleanup, custom asset directory and restart recovery", () => {
  async function startMock(handler: http.RequestListener) {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Mock server did not start");
    return `http://127.0.0.1:${address.port}`;
  }

  async function waitFor<T>(probe: () => T | null, label: string): Promise<T> {
    for (let index = 0; index < 100; index += 1) {
      const value = probe();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`等待超时：${label}`);
  }

  /** 生成一张图的完整 mock：提交即返回 base64 */
  function imageHandler(req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.url === "/v1/images/generations" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: pngBase64 }] }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  }

  it("keeps the submit request and the last poll full while compacting the middle polls", async () => {
    let origin = "";
    let pollCount = 0;
    const totalPolls = 4;
    origin = await startMock((req, res) => {
      if (req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ output: { task_id: "task-compact", task_status: "PENDING" } }));
        return;
      }
      if (req.url === "/api/v1/tasks/task-compact") {
        pollCount += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(pollCount < totalPolls
          ? { output: { task_id: "task-compact", task_status: "RUNNING", progress: pollCount * 10 } }
          : { output: { task_id: "task-compact", task_status: "SUCCEEDED" }, video: `${origin}/out.mp4` }));
        return;
      }
      if (req.url === "/out.mp4") {
        res.writeHead(200, { "Content-Type": "video/mp4" });
        res.end(Buffer.from("fake-mp4-bytes"));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-diagnostic-compact-test-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const channel = await request(app).post("/api/channels").send({
      name: "Wan Video", baseUrl: origin, adapterType: "wan-video", authType: "bearer",
      authHeaderName: "", secretEnv: "", endpoint: "/api/v1/services/aigc/video-generation/video-synthesis",
      models: ["wan3.0-video"], allowPrivateNetwork: true, enabled: true, apiKey: "sk-test",
    }).expect(201);
    const created = await request(app).post("/api/generations")
      .send({ channelId: channel.body.data.id, model: "wan3.0-video", prompt: "a cat running" }).expect(202);
    const taskId = created.body.data.id as string;

    const finished = await waitFor(() => {
      const task = context.db.getTaskRow(taskId);
      return task && ["succeeded", "failed"].includes(task.status) ? task : null;
    }, "视频任务结束");
    expect(finished.status).toBe("succeeded");
    expect(pollCount).toBe(totalPolls);

    // 提交 1 行 + 每次轮询各 1 行，顺序为时间倒序
    const diagnostics = (await request(app).get(`/api/generations/${taskId}/diagnostics`).expect(200)).body.data;
    expect(diagnostics).toHaveLength(totalPolls + 1);

    // 最新一行是最后一次轮询：请求与响应都完整
    expect(diagnostics[0].request).toMatchObject({ method: "GET", polls: totalPolls });
    expect(diagnostics[0].response).toMatchObject({ output: { task_status: "SUCCEEDED" }, video: `${origin}/out.mp4` });

    // 最早一行是提交请求：完整保留，排查时看的就是它
    expect(diagnostics[totalPolls].request).toBeTruthy();
    expect(diagnostics[totalPolls].request.body).toBeTruthy();

    // 中间几行降级成状态摘要：没有请求体，只记第几次、状态和进度
    const middle = diagnostics.slice(1, totalPolls);
    expect(middle).toHaveLength(totalPolls - 1);
    for (const [index, row] of middle.entries()) {
      expect(row.request).toBeNull();
      expect(row.response).toMatchObject({ poll: totalPolls - 1 - index, status: "running" });
      expect(row.response.progress).toBeGreaterThan(0);
      // 精简行必须真的小，否则轮询 100 次照样能把库撑爆
      expect(JSON.stringify(row.response).length).toBeLessThan(200);
    }
  });

  it("clears history in bulk, skipping the scope the user did not pick and optionally keeping files", async () => {
    const origin = await startMock(imageHandler);
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-clear-test-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    async function generate(prompt: string) {
      const channel = await request(app).post("/api/channels").send({
        name: "Clear Mock", baseUrl: origin, adapterType: "openai-images", authType: "none",
        authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations", models: ["mock-image"],
        allowPrivateNetwork: true, enabled: true,
      }).expect(201);
      const created = await request(app).post("/api/generations")
        .send({ channelId: channel.body.data.id, model: "mock-image", prompt }).expect(202);
      const taskId = created.body.data.id as string;
      await waitFor(() => {
        const task = context.db.getTaskRow(taskId);
        return task?.status === "succeeded" ? task : null;
      }, `图片任务 ${prompt}`);
      return taskId;
    }

    const assetsDir = path.join(dataDir, "assets");
    const firstId = await generate("keep me on disk");
    expect(await fs.readdir(assetsDir)).toHaveLength(1);

    // 只清视频：图片记录不在范围内，文件和记录都不该动
    const skipped = await request(app).delete("/api/generations?scope=video&keepFiles=0").expect(200);
    expect(skipped.body.data).toMatchObject({ deleted: 0, keepFiles: false });
    expect(context.db.getTaskRow(firstId)).not.toBeNull();
    expect(await fs.readdir(assetsDir)).toHaveLength(1);

    // 只删记录：行没了，文件留在磁盘上
    await request(app).delete(`/api/generations/${firstId}?keepFiles=1`).expect(200);
    expect(context.db.getTaskRow(firstId)).toBeNull();
    expect(await fs.readdir(assetsDir)).toHaveLength(1);

    // 连文件一起删：新任务的文件被清掉，上一步留下的孤儿文件仍在
    const secondId = await generate("delete me entirely");
    expect(await fs.readdir(assetsDir)).toHaveLength(2);
    const cleared = await request(app).delete("/api/generations?scope=image&keepFiles=0").expect(200);
    expect(cleared.body.data).toMatchObject({ deleted: 1 });
    expect(context.db.getTaskRow(secondId)).toBeNull();
    expect(await fs.readdir(assetsDir)).toHaveLength(1);
    expect(context.db.listTaskRows()).toHaveLength(0);
  });

  it("deletes only the checked tasks when ids are given, and lets ids win over scope", async () => {
    const origin = await startMock(imageHandler);
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-ids-test-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const channel = await request(app).post("/api/channels").send({
      name: "Ids Mock", baseUrl: origin, adapterType: "openai-images", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations", models: ["mock-image"],
      allowPrivateNetwork: true, enabled: true,
    }).expect(201);

    async function generate(prompt: string) {
      const created = await request(app).post("/api/generations")
        .send({ channelId: channel.body.data.id, model: "mock-image", prompt }).expect(202);
      const taskId = created.body.data.id as string;
      await waitFor(() => {
        const task = context.db.getTaskRow(taskId);
        return task?.status === "succeeded" ? task : null;
      }, `图片任务 ${prompt}`);
      return taskId;
    }

    const assetsDir = path.join(dataDir, "assets");
    const keepId = await generate("keep me");
    const dropAId = await generate("drop a");
    const dropBId = await generate("drop b");
    expect(await fs.readdir(assetsDir)).toHaveLength(3);

    // 勾中两条：只删这两条，磁盘上的文件跟着走，没勾的那条连文件一起留着
    const removed = await request(app).delete(`/api/generations?ids=${dropAId},${dropBId}&keepFiles=0`).expect(200);
    expect(removed.body.data).toMatchObject({ deleted: 2, keepFiles: false });
    expect(context.db.getTaskRow(dropAId)).toBeNull();
    expect(context.db.getTaskRow(dropBId)).toBeNull();
    expect(context.db.getTaskRow(keepId)).not.toBeNull();
    expect(context.db.listTaskRows()).toHaveLength(1);
    expect(await fs.readdir(assetsDir)).toHaveLength(1);

    // ids 优先于 scope：带上 scope=video 也只删点名的那条，且保留文件
    const single = await request(app).delete(`/api/generations?ids=${keepId}&scope=video&keepFiles=1`).expect(200);
    expect(single.body.data).toMatchObject({ deleted: 1 });
    expect(context.db.getTaskRow(keepId)).toBeNull();
    expect(await fs.readdir(assetsDir)).toHaveLength(1);

    // 列表里混进不存在的 id（比如别的窗口已经删过）：忽略它，不让整批请求失败
    const stale = await request(app).delete(`/api/generations?ids=missing-id,${dropAId}&keepFiles=0`).expect(200);
    expect(stale.body.data).toMatchObject({ deleted: 0 });
  });

  it("writes new assets into a custom directory and keeps old history readable", async () => {
    const origin = await startMock(imageHandler);
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-assets-dir-test-"));
    const customDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-custom-assets-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => {
      context.db.close();
      return Promise.all([
        fs.rm(dataDir, { recursive: true, force: true }),
        fs.rm(customDir, { recursive: true, force: true }),
      ]).then(() => undefined);
    });

    const defaults = (await request(app).get("/api/settings").expect(200)).body.data;
    expect(defaults.assetsDir).toBe(path.join(dataDir, "assets"));
    expect(defaults.defaultAssetsDir).toBe(defaults.assetsDir);

    const channel = await request(app).post("/api/channels").send({
      name: "Dir Mock", baseUrl: origin, adapterType: "openai-images", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations", models: ["mock-image"],
      allowPrivateNetwork: true, enabled: true,
    }).expect(201);

    async function generate(prompt: string) {
      const created = await request(app).post("/api/generations")
        .send({ channelId: channel.body.data.id, model: "mock-image", prompt }).expect(202);
      const taskId = created.body.data.id as string;
      const task = await waitFor(() => {
        const row = context.db.getTaskRow(taskId);
        return row?.status === "succeeded" ? row : null;
      }, `图片任务 ${prompt}`);
      return { taskId, assets: context.db.listAssets(taskId) };
    }

    const before = await generate("before switching");
    expect(await fs.readdir(path.join(dataDir, "assets"))).toHaveLength(1);

    // 相对路径、以及数据目录内部的路径都不接受
    const relative = await request(app).patch("/api/settings").send({ assetsDir: "some/relative/dir" }).expect(400);
    expect(relative.body.error.code).toBe("INVALID_ASSETS_DIR");
    const inside = await request(app).patch("/api/settings").send({ assetsDir: path.join(dataDir, "inside") }).expect(400);
    expect(inside.body.error.code).toBe("INVALID_ASSETS_DIR");

    const switched = await request(app).patch("/api/settings").send({ assetsDir: customDir }).expect(200);
    expect(switched.body.data.assetsDir).toBe(path.resolve(customDir));
    expect(switched.body.data.defaultAssetsDir).toBe(path.join(dataDir, "assets"));

    const after = await generate("after switching");
    expect(await fs.readdir(customDir)).toHaveLength(1);
    expect(await fs.readdir(path.join(dataDir, "assets"))).toHaveLength(1);
    expect(after.assets[0].baseDir).toBe(path.resolve(customDir));
    // 新产物能读，旧产物靠各自记录的目录也还能读（前端历史缩略图不会全裂）
    await request(app).get(`/api/assets/${after.assets[0].id}/file`).expect(200);
    await request(app).get(`/api/assets/${before.assets[0].id}/file`).expect(200);

    const bootstrap = (await request(app).get("/api/bootstrap").expect(200)).body.data.service;
    expect(bootstrap.assetsPath).toBe(path.resolve(customDir));

    // 空串表示恢复默认目录，旧文件仍留在自定义目录里
    const reset = await request(app).patch("/api/settings").send({ assetsDir: "" }).expect(200);
    expect(reset.body.data.assetsDir).toBe(path.join(dataDir, "assets"));
    expect(await fs.readdir(customDir)).toHaveLength(1);
    await request(app).get(`/api/assets/${after.assets[0].id}/file`).expect(200);
  });

  it("resumes polling a video task after a restart instead of failing it, even with a trailing-slash Base URL", async () => {
    let origin = "";
    let pollCount = 0;
    origin = await startMock((req, res) => {
      // Base URL 带尾斜杠时，只有走 joinEndpoint 才会请求到这里；拼字符串会变成 //api/... 而 404
      if (req.url === "/api/v1/tasks/remote-9") {
        pollCount += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(pollCount < 2
          ? { output: { task_id: "remote-9", task_status: "RUNNING", progress: 30 } }
          : { output: { task_id: "remote-9", task_status: "SUCCEEDED" }, video: `${origin}/out.mp4` }));
        return;
      }
      if (req.url === "/out.mp4") {
        res.writeHead(200, { "Content-Type": "video/mp4" });
        res.end(Buffer.from("fake-mp4-bytes"));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-resume-test-"));
    const first = createApp({ dataDir });
    const channel = await request(first.app).post("/api/channels").send({
      name: "Wan Video", baseUrl: `${origin}/`, adapterType: "wan-video", authType: "bearer",
      authHeaderName: "", secretEnv: "", endpoint: "/api/v1/services/aigc/video-generation/video-synthesis",
      models: ["wan3.0-video"], allowPrivateNetwork: true, enabled: true, apiKey: "sk-test",
    }).expect(201);
    const channelId = channel.body.data.id as string;

    // 模拟「提交完、拿到上游 id 之后就崩了」：直接落库一条进行中的任务
    const input = { channelId, model: "wan3.0-video", prompt: "resume me" };
    first.context.db.createTask({ id: "task-resume", channelId, model: "wan3.0-video", prompt: "resume me", input });
    first.context.db.updateTask("task-resume", { remoteTaskId: "remote-9" });
    // 还没拿到上游 id 的任务没法跨重启恢复
    first.context.db.createTask({ id: "task-no-remote", channelId, model: "wan3.0-video", prompt: "no id", input });
    first.context.db.close();

    const second = createApp({ dataDir });
    cleanups.push(() => { second.context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });
    await second.context.runner.resume();

    const resumed = await waitFor(() => {
      const row = second.context.db.getTaskRow("task-resume");
      return row && ["succeeded", "failed"].includes(row.status) ? row : null;
    }, "重启后继续轮询");
    expect(resumed.status).toBe("succeeded");
    expect(pollCount).toBeGreaterThanOrEqual(2);
    expect(second.context.db.getTaskRow("task-no-remote")).toMatchObject({ status: "failed", errorCode: "SERVICE_RESTARTED" });

    // 视频落盘在默认产物目录里
    const assets = second.context.db.listAssets("task-resume");
    expect(assets).toHaveLength(1);
    expect(assets[0].mimeType).toBe("video/mp4");
    await fs.access(path.join(assets[0].baseDir, assets[0].relativePath));
  });
});

/**
 * gemini 渠道的输出尺寸（需求.md 问题 1）。
 *
 * 现场：大脑写了 `size: "2K"`，gemini 只认 `imageConfig.imageSize`，参数被静默丢掉，
 * 上游回 400 `Unsupported resolution`。这几条测试盯的就是**假中转站收到的请求体**——
 * 说得再好听，请求体里没有那个字段就是没修好。
 */
describe("gemini 渠道的输出尺寸", () => {
  /** 假中转站：把收到的每个请求体记下来，响应形状由调用方给 */
  async function startRelay(respond: (body: Record<string, unknown>, hit: number) => { status: number; payload: unknown }) {
    const hits: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
        hits.push(body);
        const reply = respond(body, hits.length);
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply.payload));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Mock server did not start");
    return { hits, baseUrl: `http://127.0.0.1:${address.port}` };
  }

  async function bootGemini(baseUrl: string) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-gemini-size-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });
    const created = await request(app).post("/api/channels").send({
      name: "Gemini Mock", baseUrl, adapterType: "gemini-content", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "/v1beta/models/{model}:generateContent",
      models: ["gemini-image"], allowPrivateNetwork: true, enabled: true,
    }).expect(201);
    return { app, channelId: created.body.data.id as string };
  }

  /** extractImageCandidates 不挑适配器，OpenAI 那套 b64_json 形状在 gemini 渠道一样认 */
  const imageOk = { data: [{ b64_json: pngBase64 }] };
  const resolutionError = {
    status: 400,
    payload: { error: { message: "Unsupported resolution: check the imageSize parameter (case-sensitive, e.g. 1K, 2K, 4K)" } },
  };

  async function settle(app: ReturnType<typeof createApp>["app"], taskId: string) {
    let task: Task = (await request(app).get(`/api/generations/${taskId}`).expect(200)).body.data;
    for (let index = 0; index < 40 && !["succeeded", "failed", "cancelled", "expired"].includes(task.status); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      task = (await request(app).get(`/api/generations/${taskId}`).expect(200)).body.data;
    }
    return task;
  }

  it("没指定尺寸时请求体里带上默认的 2K，并且这份 body 会被记进 effectiveParameters", async () => {
    const relay = await startRelay(() => ({ status: 200, payload: imageOk }));
    const { app, channelId } = await bootGemini(relay.baseUrl);

    const created = await request(app).post("/api/generations")
      .send({ channelId, model: "gemini-image", prompt: "一只戴草帽的橘猫", aspectRatio: "2:3" })
      .expect(202);
    const task = await settle(app, created.body.data.id as string);

    expect(task.status).toBe("succeeded");
    const body = relay.hits[0] as { generationConfig: { imageConfig: Record<string, unknown> } };
    expect(body.generationConfig.imageConfig).toMatchObject({ imageSize: "2K", aspectRatio: "2:3" });

    // 参数核对面板读的就是 task.effectiveParameters，所以这份也得带上——
    // 否则卡片上会显示「尺寸：未发出」，把已经修好的事说成坏的
    const effective = task.effectiveParameters as { generationConfig: { imageConfig: Record<string, unknown> } };
    expect(effective.generationConfig.imageConfig.imageSize).toBe("2K");
  });

  it("设置里改成 1K 之后补的就是 1K", async () => {
    const relay = await startRelay(() => ({ status: 200, payload: imageOk }));
    const { app, channelId } = await bootGemini(relay.baseUrl);

    const settings = await request(app).patch("/api/settings").send({ geminiImageSize: "1K" }).expect(200);
    expect(settings.body.data.geminiImageSize).toBe("1K");

    const created = await request(app).post("/api/generations")
      .send({ channelId, model: "gemini-image", prompt: "test" }).expect(202);
    await settle(app, created.body.data.id as string);
    expect((relay.hits[0] as { generationConfig: { imageConfig: Record<string, unknown> } }).generationConfig.imageConfig.imageSize).toBe("1K");
  });

  it("请求方明确指定了尺寸就原样发出，不被默认值盖掉", async () => {
    const relay = await startRelay(() => ({ status: 200, payload: imageOk }));
    const { app, channelId } = await bootGemini(relay.baseUrl);

    const created = await request(app).post("/api/generations")
      .send({ channelId, model: "gemini-image", prompt: "test", imageSize: "4K" }).expect(202);
    await settle(app, created.body.data.id as string);
    expect((relay.hits[0] as { generationConfig: { imageConfig: Record<string, unknown> } }).generationConfig.imageConfig.imageSize).toBe("4K");
  });

  it("上游拿参数拒了也照实说出来，不再退化成一句「中转接口返回错误」", async () => {
    const relay = await startRelay(() => resolutionError);
    const { app, channelId } = await bootGemini(relay.baseUrl);

    const created = await request(app).post("/api/generations")
      .send({ channelId, model: "gemini-image", prompt: "test" }).expect(202);
    const task = await settle(app, created.body.data.id as string);

    expect(task.status).toBe("failed");
    // 这句原文是 isParameterRejection 的判据，也是用户在卡片上看到的那行
    expect(task.errorMessage).toContain("Unsupported resolution");
  });

  it("别家渠道不会被硬塞一个 imageConfig：它们不认这个参数", async () => {
    const relay = await startRelay(() => ({ status: 200, payload: imageOk }));
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-openai-size-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });
    const created = await request(app).post("/api/channels").send({
      name: "OpenAI Mock", baseUrl: relay.baseUrl, adapterType: "openai-images", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations",
      models: ["mock-image"], allowPrivateNetwork: true, enabled: true,
    }).expect(201);

    const task = await request(app).post("/api/generations")
      .send({ channelId: created.body.data.id, model: "mock-image", prompt: "test", size: "1024x1024" })
      .expect(202);
    await settle(app, task.body.data.id as string);

    expect(relay.hits[0]).toMatchObject({ size: "1024x1024" });
    expect(relay.hits[0]).not.toHaveProperty("generationConfig");
    expect(relay.hits[0]).not.toHaveProperty("imageSize");
  });
});

/**
 * 工作台结果面板的「请求参数」（需求.md 问题 1 D）。
 *
 * 上一组盯的是「请求体里到底有没有」；这一组盯的是**用户能不能在界面上看见**，
 * 而且要看得住：面板上写「已发出」，`effectiveParameters` 里就得真有那个值；
 * 写「未发出」，请求体里就得真的没有。核对结果是纯展示数据，但**编出来的展示数据
 * 比没有更糟**——用户会照着它去改提示词。
 */
describe("工作台结果面板的请求参数", () => {
  const imageOk = { status: 200, payload: { data: [{ b64_json: pngBase64 }] } };

  async function startRelay(reply: { status: number; payload: unknown }) {
    const hits: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        hits.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>);
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply.payload));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Mock server did not start");
    return { hits, baseUrl: `http://127.0.0.1:${address.port}` };
  }

  async function boot(baseUrl: string, adapterType: "gemini-content" | "openai-images") {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-params-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });
    const created = await request(app).post("/api/channels").send({
      name: "Mock", baseUrl, adapterType, authType: "none", authHeaderName: "", secretEnv: "",
      endpoint: adapterType === "gemini-content" ? "/v1beta/models/{model}:generateContent" : "/v1/images/generations",
      models: ["mock-image"], allowPrivateNetwork: true, enabled: true,
    }).expect(201);
    return { app, channelId: created.body.data.id as string };
  }

  async function settle(app: ReturnType<typeof createApp>["app"], taskId: string) {
    let task: Task = (await request(app).get(`/api/generations/${taskId}`).expect(200)).body.data;
    for (let index = 0; index < 40 && !["succeeded", "failed", "cancelled", "expired"].includes(task.status); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      task = (await request(app).get(`/api/generations/${taskId}`).expect(200)).body.data;
    }
    return task;
  }

  it("gemini 补上的 2K 在工作台看得见，而且和真正出网的值一致", async () => {
    const relay = await startRelay(imageOk);
    const { app, channelId } = await boot(relay.baseUrl, "gemini-content");

    const created = await request(app).post("/api/generations")
      .send({ channelId, model: "mock-image", prompt: "一只戴草帽的橘猫", aspectRatio: "2:3" })
      .expect(202);
    const task = await settle(app, created.body.data.id as string);

    expect(task.status).toBe("succeeded");
    expect(task.parameterNotes).toEqual([
      { label: "宽高比", value: "2:3", status: "applied" },
      { label: "尺寸", value: "2K", status: "applied" },
    ]);
    // 「已发出」不是嘴上说说：同一个值必须能在 effectiveParameters 的嵌套路径里读到
    const effective = task.effectiveParameters as { generationConfig: { imageConfig: Record<string, unknown> } };
    expect(effective.generationConfig.imageConfig).toMatchObject({ imageSize: "2K", aspectRatio: "2:3" });

    // 列表接口（历史、右侧「最近」）走的是另一条查询，忘了 join 适配器就会整列消失
    const listed = (await request(app).get("/api/generations").expect(200)).body.data as Task[];
    expect(listed.find((item) => item.id === task.id)?.parameterNotes).toEqual(task.parameterNotes);
  });

  it("失败的任务也带着参数：被吞掉的那个标成「未发出」，这就是用户要盯的那一行", async () => {
    const relay = await startRelay({
      status: 400,
      payload: { error: { message: "Unsupported resolution: check the imageSize parameter" } },
    });
    const { app, channelId } = await boot(relay.baseUrl, "gemini-content");

    const created = await request(app).post("/api/generations")
      .send({ channelId, model: "mock-image", prompt: "test", size: "1024x1024" })
      .expect(202);
    const task = await settle(app, created.body.data.id as string);

    expect(task.status).toBe("failed");
    // gemini 不认 size，写多少都发不出去 —— 得让用户看见，而不是只留一句上游报错
    expect(task.parameterNotes?.find((note) => note.status === "dropped")).toMatchObject({
      label: "尺寸(size)", value: "1024x1024",
    });
    expect(relay.hits[0]).not.toHaveProperty("size");
  });

  it("OpenAI 系只列真的对得上的那几项，不凭空多给一行", async () => {
    const relay = await startRelay(imageOk);
    const { app, channelId } = await boot(relay.baseUrl, "openai-images");

    const created = await request(app).post("/api/generations")
      .send({ channelId, model: "mock-image", prompt: "test", size: "1024x1024" })
      .expect(202);
    const task = await settle(app, created.body.data.id as string);

    expect(task.parameterNotes).toEqual([{ label: "尺寸", value: "1024x1024", status: "applied" }]);
  });

  it("渠道被删掉之后不再对账：认不出适配器就不给结论，好过猜一个", async () => {
    const relay = await startRelay(imageOk);
    const { app, channelId } = await boot(relay.baseUrl, "gemini-content");

    const created = await request(app).post("/api/generations")
      .send({ channelId, model: "mock-image", prompt: "test" }).expect(202);
    const task = await settle(app, created.body.data.id as string);
    expect(task.parameterNotes?.length).toBeGreaterThan(0);

    await request(app).delete(`/api/channels/${channelId}`).expect(200);
    const after = (await request(app).get(`/api/generations/${task.id}`).expect(200)).body.data as Task;
    expect(after.channelName).toBe("已删除渠道");
    expect(after.parameterNotes).toBeUndefined();
  });
});

describe("产物下载的鉴权", () => {
  /**
   * 用户的实际现象：响应体里明明有 url，图却一直拿不到。
   *
   * 因为中转站自带的资产地址（`/v1/images/assets/<uuid>` 这种）要带 key 才肯给图，
   * 而下载那一路上原来**一个鉴权头都没带**。这里同时钉住另一半：
   * key 只能发给渠道自己那台主机——产物地址也可能是公开 CDN，
   * 往别处带 Authorization 等于把密钥送出去。
   */
  it("渠道自己主机上的产物带 key 去取，别的主机绝不带", async () => {
    const png = Buffer.from(pngBase64, "base64");
    const assetAuth: Array<string | undefined> = [];
    let port = 0;

    const mockServer = http.createServer((req, res) => {
      if (req.url === "/v1/images/generations" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        // 资产地址就用这台机器（模拟网关自己托管产物）
        res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${port}/v1/images/assets/abc` }] }));
        return;
      }
      if (req.url === "/v1/images/assets/abc") {
        assetAuth.push(req.headers.authorization);
        // 不带 key 就 403，和真实网关一个脾气
        if (req.headers.authorization !== "Bearer sk-relay-key") {
          res.writeHead(403).end();
          return;
        }
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(png);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { mockServer.close(() => resolve()); }));
    const address = mockServer.address();
    if (!address || typeof address === "string") throw new Error("Mock server did not start");
    port = address.port;

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-asset-auth-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const channel = (await request(app).post("/api/channels").send({
      name: "Gateway", baseUrl: `http://127.0.0.1:${port}`, adapterType: "openai-images", authType: "bearer",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations", models: ["mock-image"],
      allowPrivateNetwork: true, enabled: true,
    }).expect(201)).body.data;
    context.sessionKeys.set(channel.id, "sk-relay-key");

    const created = (await request(app).post("/api/generations").send({
      channelId: channel.id, model: "mock-image", prompt: "test", size: "1024x1024", count: 1,
    }).expect(202)).body.data as Task;
    let task = created;
    for (let index = 0; index < 30 && task.status !== "succeeded" && task.status !== "failed"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      task = (await request(app).get(`/api/generations/${task.id}`).expect(200)).body.data as Task;
    }
    expect(task.errorMessage ?? "").toBe("");
    expect(task.status).toBe("succeeded");
    expect(task.assets).toHaveLength(1);
    // 关键：取图那一下确实把 key 带上了
    expect(assetAuth).toEqual(["Bearer sk-relay-key"]);
  });

  it("产物地址在别的主机上时不带 key", async () => {
    const png = Buffer.from(pngBase64, "base64");
    const assetAuth: Array<string | undefined> = [];
    let port = 0;

    const mockServer = http.createServer((req, res) => {
      if (req.url === "/v1/images/generations" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        // 换一个主机名指向同一台服务：主机串不同就不该带 key
        res.end(JSON.stringify({ data: [{ url: `http://localhost:${port}/cdn/abc.png` }] }));
        return;
      }
      if (req.url === "/cdn/abc.png") {
        assetAuth.push(req.headers.authorization);
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(png);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { mockServer.close(() => resolve()); }));
    const address = mockServer.address();
    if (!address || typeof address === "string") throw new Error("Mock server did not start");
    port = address.port;

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-asset-cdn-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const channel = (await request(app).post("/api/channels").send({
      name: "Gateway", baseUrl: `http://127.0.0.1:${port}`, adapterType: "openai-images", authType: "bearer",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations", models: ["mock-image"],
      allowPrivateNetwork: true, enabled: true,
    }).expect(201)).body.data;
    context.sessionKeys.set(channel.id, "sk-relay-key");

    const created = (await request(app).post("/api/generations").send({
      channelId: channel.id, model: "mock-image", prompt: "test", size: "1024x1024", count: 1,
    }).expect(202)).body.data as Task;
    let task = created;
    for (let index = 0; index < 30 && task.status !== "succeeded" && task.status !== "failed"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      task = (await request(app).get(`/api/generations/${task.id}`).expect(200)).body.data as Task;
    }
    expect(task.status).toBe("succeeded");
    // 图拿到了，但一个字节的密钥都没发给这台「别的主机」
    expect(assetAuth).toEqual([undefined]);
  });
});
