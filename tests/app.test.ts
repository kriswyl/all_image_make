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
      authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations", statusEndpoint: "", models: ["mock-image"],
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
    const diagnostics = (await request(app).get(`/api/generations/${taskId}/diagnostics`).expect(200)).body.data;
    expect(diagnostics).toHaveLength(1);
    expect(JSON.stringify(diagnostics)).not.toContain("Authorization");
  });
});
