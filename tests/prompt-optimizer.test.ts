import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function startBrainMock(content: string) {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server did not start");
  return { origin: `http://127.0.0.1:${address.port}`, bodies };
}

async function setup(content: string) {
  const mock = await startBrainMock(content);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-polish-test-"));
  const { app, context } = createApp({ dataDir });
  cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });
  return { mock, app, context };
}

async function addChatChannel(app: ReturnType<typeof createApp>["app"], origin: string) {
  return (await request(app).post("/api/channels").send({
    name: "Brain", baseUrl: origin, adapterType: "openai-chat", authType: "none",
    authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
    models: ["deepseek-v4-1-flash"], allowPrivateNetwork: true, enabled: true,
  }).expect(201)).body.data;
}

describe("prompt polish", () => {
  it("rewrites an image prompt with the first available chat model", async () => {
    const rewritten = "一只橘猫坐在洒满阳光的窗台上，柔和自然光，中景构图，写实摄影风格";
    const { mock, app } = await setup(rewritten);
    await addChatChannel(app, mock.origin);

    const response = await request(app).post("/api/prompt/optimize")
      .send({ prompt: "一只猫坐在窗台上", target: "image" })
      .expect(200);

    expect(response.body.data).toMatchObject({
      prompt: rewritten, channelName: "Brain", model: "deepseek-v4-1-flash",
    });
    const sent = JSON.parse(mock.bodies[0]);
    expect(sent.model).toBe("deepseek-v4-1-flash");
    expect(sent.messages[0].content).toContain("图片提示词工程师");
    expect(sent.messages[1]).toEqual({ role: "user", content: "一只猫坐在窗台上" });
  });

  it("uses the video prompt instructions for video targets", async () => {
    const { mock, app } = await setup("镜头缓慢推近，猫的尾巴轻轻摆动");
    await addChatChannel(app, mock.origin);

    const response = await request(app).post("/api/prompt/optimize")
      .send({ prompt: "猫在窗台上", target: "video" })
      .expect(200);
    expect(response.body.data.prompt).toContain("镜头");

    const sent = JSON.parse(mock.bodies[0]);
    expect(sent.messages[0].content).toContain("视频提示词工程师");
    expect(sent.messages[0].content).toContain("镜头运动");
  });

  it("fails with an actionable message when no chat channel exists", async () => {
    const { app } = await setup("不会用到");
    const response = await request(app).post("/api/prompt/optimize")
      .send({ prompt: "一只猫", target: "image" })
      .expect(400);
    expect(response.body.error.code).toBe("NO_CHAT_CHANNEL");
    expect(response.body.error.message).toContain("对话模型");
  });
});
