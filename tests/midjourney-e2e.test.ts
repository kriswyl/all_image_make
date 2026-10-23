import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/server/app";
import type { Task } from "../src/shared/types";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function startMock() {
  const submits: Array<{ path: string; body: Record<string, unknown> }> = [];
  let origin = "";
  const task = (id: string, status: string, image = false) => ({
    id,
    action: id === "mj-1" ? "IMAGINE" : "UPSCALE",
    status,
    progress: status === "SUCCESS" ? "100%" : "50%",
    imageUrl: image ? `${origin}/mj/image/${id}` : "",
    failReason: "",
    promptEn: "a cat",
    buttons: image ? [
      { customId: "MJ::JOB::upsample::1::abc", label: "U1", type: 2, style: 2 },
      { customId: "MJ::JOB::variation::1::abc", label: "V1", type: 2, style: 2 },
      { customId: "MJ::JOB::reroll::0::abc::SOLO", emoji: "🔄", label: "", type: 2, style: 2 },
    ] : [],
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", origin || "http://127.0.0.1");
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      if (req.method === "POST" && (url.pathname === "/mj/submit/imagine" || url.pathname === "/mj/submit/action")) {
        submits.push({ path: url.pathname, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 1, description: "Submit Success", result: url.pathname.endsWith("imagine") ? "mj-1" : "mj-2" }));
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/mj/task/")) {
        const id = url.pathname.split("/")[3]!;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(task(id, "SUCCESS", true)));
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/mj/image/")) {
        res.writeHead(200, { "Content-Type": "image/png" });
        res.end(Buffer.from(pngBase64, "base64"));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server did not start");
  origin = `http://127.0.0.1:${address.port}`;
  return { origin, submits };
}

async function waitForTask(app: ReturnType<typeof createApp>["app"], id: string): Promise<Task> {
  let task: Task | null = null;
  for (let index = 0; index < 60; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 30));
    task = (await request(app).get(`/api/generations/${id}`).expect(200)).body.data as Task;
    if (["succeeded", "failed", "cancelled"].includes(task.status)) break;
  }
  if (!task) throw new Error("task never loaded");
  return task;
}

describe("Midjourney 端到端", () => {
  it("提交 → 轮询 → 图片落盘 → 按钮触发放大", async () => {
    const mock = await startMock();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-mj-test-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const channel = await request(app).post("/api/channels").send({
      name: "MJ Mock", baseUrl: mock.origin, adapterType: "midjourney", authType: "bearer",
      authHeaderName: "", secretEnv: "", endpoint: "/mj/submit/imagine",
      models: ["mj_imagine", "mj_edits", "mj_upscale", "mj_variation", "mj_reroll"],
      allowPrivateNetwork: true, enabled: true, apiKey: "sk-test",
    }).expect(201);

    const created = await request(app).post("/api/generations").send({
      channelId: channel.body.data.id,
      model: "mj_imagine",
      prompt: "a cat",
      aspectRatio: "1:1",
    }).expect(202);
    const first = await waitForTask(app, created.body.data.id as string);
    expect(first.status).toBe("succeeded");
    expect(first.assets).toHaveLength(1);
    expect(first.assets[0]!.mimeType).toBe("image/png");
    expect(first.remoteMeta?.midjourney?.buttons).toHaveLength(3);
    expect(mock.submits[0]).toMatchObject({
      path: "/mj/submit/imagine",
      body: { prompt: "a cat --ar 1:1" },
    });

    const action = await request(app)
      .post(`/api/generations/${first.id}/action`)
      .send({ customId: "MJ::JOB::upsample::1::abc", label: "U1" })
      .expect(202);
    expect(action.body.data.model).toBe("mj_upscale");
    const second = await waitForTask(app, action.body.data.id as string);
    expect(second.status).toBe("succeeded");
    expect(second.assets).toHaveLength(1);
    expect(mock.submits[1]).toMatchObject({
      path: "/mj/submit/action",
      body: { taskId: "mj-1", customId: "MJ::JOB::upsample::1::abc" },
    });
  }, 20_000);
});
