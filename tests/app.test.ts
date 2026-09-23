import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("generation API", () => {
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
