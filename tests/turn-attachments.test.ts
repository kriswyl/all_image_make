/**
 * 「这一轮附带了哪几张图」的边界。
 *
 * 工具执行时最后一条消息已经是助手计划行，所以附件必须在本轮开始时锁住。
 * 这里钉住三条：紧挨着的上传算本轮、上一条文字消息之后的不算、非图片不算。
 */
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/server/app";
import { collectTurnAttachmentIds } from "../src/server/agent";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function setup(baseUrl = "http://127.0.0.1:1") {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-attach-"));
  const { app, context } = createApp({ dataDir });
  cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

  const brain = (await request(app).post("/api/channels").send({
    name: "Brain", baseUrl, adapterType: "openai-chat", authType: "none",
    authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
    models: ["mock-brain", "vision-brain"], allowPrivateNetwork: true, enabled: true,
  }).expect(201)).body.data;
  const conversationId = (await request(app).post("/api/conversations")
    .send({ brainChannelId: brain.id, brainModel: "mock-brain" }).expect(201)).body.data.id as string;

  const db = context.db;
  const addAsset = (mimeType: string) => {
    const assetId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    db.createTask({ id: taskId, channelId: "", model: "", prompt: "x", input: {}, origin: "upload", status: "succeeded" });
    db.insertAsset({
      id: assetId, taskId, fileName: "x", mimeType, byteSize: 1,
      relativePath: "x", baseDir: db.assetsDir, sha256: "x", thumbPath: "",
    });
    return assetId;
  };

  return { app, db, conversationId, addAsset };
}

describe("collectTurnAttachmentIds", () => {
  it("紧挨着的上传消息 + 本条文字消息的 assetRefs 都算，重复只留一次", async () => {
    const { db, conversationId, addAsset } = await setup();
    const first = addAsset("image/png");
    const second = addAsset("image/png");
    // second 得先是「会话里出现过的图」，resolveAssetRef 才认它；
    // 用一条 assistant 行登记，避免它被当成紧挨着的上传
    db.appendMessage({ conversationId, role: "assistant", content: "之前那张", assetId: second });
    db.appendMessage({ conversationId, role: "user", content: "上传了图片 a.png", assetId: first });
    const text = db.appendMessage({
      conversationId, role: "user", content: "把这张换成夜景",
      assetRefs: [first.slice(0, 4), second.slice(0, 4)],
    });
    expect(collectTurnAttachmentIds(db, conversationId, text.seq)).toEqual([first, second]);
  });

  it("只传图不说话时的上传消息，也在下一句文字里算本轮附件", async () => {
    const { db, conversationId, addAsset } = await setup();
    const uploaded = addAsset("image/png");
    db.appendMessage({ conversationId, role: "user", content: "上传了图片 a.png", assetId: uploaded });
    const text = db.appendMessage({ conversationId, role: "user", content: "改一下" });
    expect(collectTurnAttachmentIds(db, conversationId, text.seq)).toEqual([uploaded]);
  });

  it("上一条文字消息之前的图不算本轮；非图片产物直接过滤", async () => {
    const { db, conversationId, addAsset } = await setup();
    const old = addAsset("image/png");
    const video = addAsset("video/mp4");
    const image = addAsset("image/png");
    db.appendMessage({ conversationId, role: "user", content: "上传了图片 old.png", assetId: old });
    // 让 image 成为会话里出现过的图；assistant 行同时切断「本轮上传」的向前扫描
    db.appendMessage({ conversationId, role: "assistant", content: "收到", assetId: image });
    db.appendMessage({ conversationId, role: "user", content: "上传了视频 v.mp4", assetId: video });
    const text = db.appendMessage({
      conversationId, role: "user", content: "用这张",
      assetRefs: [image.slice(0, 4)],
    });

    // 视频那条紧挨着文字消息，但不是图片 → 过滤；更早的 old 不在本轮 → 不收
    expect(collectTurnAttachmentIds(db, conversationId, text.seq)).toEqual([image]);
  });
});

it("切换到支持图片的模型后恢复看图，用户手动关闭时继续只发文字", async () => {
  const received: Array<{ model: string; image: boolean }> = [];
  const mock = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const image = body.messages.some((message: { content: unknown }) => Array.isArray(message.content)
      && message.content.some((part: { type: string }) => part.type === "image_url"));
    received.push({ model: body.model, image });
    res.setHeader("Content-Type", "application/json");
    if (body.model === "mock-brain" && image) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: { message: "image input is not supported" } }));
      return;
    }
    res.end(JSON.stringify({ choices: [{ message: { content: "收到。" }, finish_reason: "stop" }] }));
  });
  await new Promise<void>(resolve => mock.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => mock.close(() => resolve())));
  const address = mock.address();
  if (!address || typeof address === "string") throw new Error("mock server unavailable");
  const { app, db, conversationId } = await setup(`http://127.0.0.1:${address.port}`);
  const base = `/api/conversations/${conversationId}`;
  await request(app).patch(base).send({ toolScope: "all" }).expect(200);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const upload = (await request(app).post(`${base}/uploads`).attach("images", png, "vision.png").expect(201)).body.data;
  const assetRefs = [upload.sessionImages[0].asset.id];
  async function send(expectedCalls: number) {
    await request(app).post(`${base}/messages`).send({ text: "请看看这张图", assetRefs }).expect(202);
    await vi.waitFor(() => {
      expect(received).toHaveLength(expectedCalls);
      expect(db.getConversation(conversationId)?.status).toBe("idle");
    });
  }
  await send(2);
  const unsupported = (await request(app).get(base).expect(200)).body.data;
  expect(unsupported).toMatchObject({ visionEnabled: true, visionBlocked: true });
  expect(unsupported.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "system", content: expect.stringContaining("不接受图片输入") })]));
  const switched = (await request(app).patch(base).send({ brainModel: "vision-brain" }).expect(200)).body.data;
  expect(switched).toMatchObject({ visionEnabled: true, visionBlocked: false });
  await send(3);
  await request(app).patch(base).send({ visionEnabled: false }).expect(200);
  await send(4);
  expect(received).toEqual([
    { model: "mock-brain", image: true }, { model: "mock-brain", image: false },
    { model: "vision-brain", image: true }, { model: "vision-brain", image: false },
  ]);
});
