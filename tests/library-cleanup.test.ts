/**
 * 素材管理的删除语义：
 *
 * 1. 清空 / 批量删不能再「一条被引用就整批 409」——逐条判断，能删的删，删不了的跳过并报数
 * 2. 聊天生成的记录允许在素材管理里删，但要把消息、画布、分镜里的引用一起摘干净
 * 3. 「清理失效记录」只碰「渠道已删 + 产物文件已丢失」的孤儿行，还能显示的记录一条不动
 */
import crypto from "node:crypto";
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

async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "library-cleanup-"));
  const { app, context } = createApp({ dataDir });
  cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });
  const brain = (await request(app).post("/api/channels").send({
    name: "Brain", baseUrl: "http://127.0.0.1:1", adapterType: "openai-chat", authType: "none",
    authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
    models: ["mock-brain"], allowPrivateNetwork: true, enabled: true,
  }).expect(201)).body.data;
  const conversationId = (await request(app).post("/api/conversations")
    .send({ brainChannelId: brain.id, brainModel: "mock-brain" }).expect(201)).body.data.id as string;

  const db = context.db;
  /** 造一条聊天生成记录：消息锚在这张图上，画布也引用它 */
  function createChatTask(prompt = "聊天生成的一张图") {
    const taskId = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    db.createTask({
      id: taskId, channelId: "", model: "mock-image", prompt, input: {},
      status: "succeeded", libraryScope: "conversation", ownerConversationId: conversationId,
    });
    db.insertAsset({
      id: assetId, taskId, fileName: `${assetId}.png`, mimeType: "image/png", byteSize: 1,
      relativePath: `${assetId}.png`, baseDir: db.assetsDir, sha256: "x", thumbPath: "",
    });
    db.appendMessage({ conversationId, role: "assistant", content: "画好了", taskId, assetId });
    db.updateConversation(conversationId, { canvasAssetIds: [assetId] });
    return { taskId, assetId };
  }

  return { app, db, conversationId, createChatTask, dataDir };
}

describe("素材管理删除记录", () => {
  it("批量删除遇到被对话引用的记录只跳过它，不再整批失败", async () => {
    const { app, db, createChatTask } = await setup();
    const { taskId } = createChatTask();

    const result = await request(app).post("/api/generations/batch-delete")
      .send({ ids: [taskId], keepFiles: true }).expect(200);

    expect(result.body.data).toMatchObject({ deleted: 0, skipped: 1, skippedConversation: 1 });
    expect(db.getTaskRow(taskId)).not.toBeNull();
  });

  it("允许戴 detachConversation 删聊天记录，并把消息 / 画布引用摘干净", async () => {
    const { app, db, conversationId, createChatTask } = await setup();
    const { taskId, assetId } = createChatTask();

    const result = await request(app).post("/api/generations/batch-delete")
      .send({ ids: [taskId], keepFiles: false, detachConversation: true }).expect(200);

    expect(result.body.data).toMatchObject({ deleted: 1, skipped: 0 });
    expect(db.getTaskRow(taskId)).toBeNull();
    expect(db.getAsset(assetId)).toBeNull();
    const message = db.listMessages(conversationId).find((entry) => (entry.content ?? "").includes("画好了"))!;
    expect(message.assetId).toBeNull();
    expect(message.taskId).toBeNull();
    expect(db.getConversation(conversationId)!.canvasAssetIds).not.toContain(assetId);
  });

  it("单条删除默认仍拒绝，带 detach=1 才连带摘引用", async () => {
    const { app, db, createChatTask } = await setup();
    const first = createChatTask("第一条");
    await request(app).delete(`/api/generations/${first.taskId}`).expect(409);
    expect(db.getTaskRow(first.taskId)).not.toBeNull();

    await request(app).delete(`/api/generations/${first.taskId}?detach=1`).expect(200);
    expect(db.getTaskRow(first.taskId)).toBeNull();
  });

  it("清理失效记录只删「渠道已删 + 文件已丢」的行，磁盘上还有图的记录留下", async () => {
    const { app, db, dataDir } = await setup();
    const missingFile = crypto.randomUUID();
    const noAsset = crypto.randomUUID();
    const alive = crypto.randomUUID();
    const aliveAsset = crypto.randomUUID();
    for (const [id, prompt] of [[missingFile, "文件丢了"], [noAsset, "压根没产物"], [alive, "还在"]] as const) {
      db.createTask({ id, channelId: "", model: "mock-image", prompt, input: {}, status: "succeeded", origin: "generate" });
    }
    db.insertAsset({
      id: crypto.randomUUID(), taskId: missingFile, fileName: "gone.png", mimeType: "image/png", byteSize: 1,
      relativePath: "gone.png", baseDir: db.assetsDir, sha256: "x", thumbPath: "",
    });
    db.insertAsset({
      id: aliveAsset, taskId: alive, fileName: "here.png", mimeType: "image/png", byteSize: 1,
      relativePath: "here.png", baseDir: db.assetsDir, sha256: "x", thumbPath: "",
    });
    await fs.writeFile(path.join(dataDir, "assets", "here.png"), "png");

    const before = await request(app).get("/api/generations/stale").expect(200);
    expect(before.body.data.count).toBe(2);

    const cleaned = await request(app).delete("/api/generations/stale").expect(200);
    expect(cleaned.body.data.deleted).toBe(2);
    expect(db.getTaskRow(missingFile)).toBeNull();
    expect(db.getTaskRow(noAsset)).toBeNull();
    expect(db.getTaskRow(alive)).not.toBeNull();
    expect(db.getAsset(aliveAsset)).not.toBeNull();
  });
});
