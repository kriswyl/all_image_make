/**
 * 素材库右键删除：删的是「一张图」，不是整个会话。
 *
 * 除了磁盘文件，最容易漏的是引用：消息里的 assetId、画布首尾帧、分镜任务、
 * 角色 / 场景设定图。任何一处没清，界面就会去请求已经删掉的图，或者留下一个
 * 永远「生成中」的分镜。这个文件把这些出口一次钉住。
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
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "asset-delete-"));
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
  const assetId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  db.createTask({ id: taskId, channelId: "", model: "", prompt: "猫", input: {}, origin: "upload", status: "succeeded" });
  db.insertAsset({
    id: assetId, taskId, fileName: "cat.png", mimeType: "image/png", byteSize: 1,
    relativePath: "cat.png", baseDir: db.assetsDir, sha256: "x", thumbPath: "",
  });
  db.appendMessage({ conversationId, role: "user", content: "上传了图片 cat.png", assetId });
  return { app, db, conversationId, assetId, taskId };
}

describe("素材库删除图片", () => {
  it("被画布引用的对话上传素材不能被会话删除；删除会话也保留素材", async () => {
    const { app, db, conversationId, assetId } = await setup();
    const board = (await request(app).post("/api/boards").send({ title: "共享" }).expect(201)).body.data;
    await request(app).post(`/api/boards/${board.id}/bridge/assets`).send({ items: [{ assetId }] }).expect(200);
    await request(app).delete(`/api/conversations/${conversationId}/assets/${assetId}`).expect(409);
    await request(app).delete(`/api/conversations/${conversationId}`).expect(200);
    expect(db.getAsset(assetId)).not.toBeNull();
    expect(db.findBoardAssetRefs(assetId).some((ref) => ref.boardId === board.id)).toBe(true);
  });

  it("对话引用的素材不能从公共生成记录删除", async () => {
    const { app, db, assetId, taskId } = await setup();
    await request(app).delete(`/api/generations/${taskId}`).expect(409);
    expect(db.getAsset(assetId)).not.toBeNull();
  });

  it("公共素材按单个产物删除并保留生成记录，已被画布或对话引用时拒绝", async () => {
    const { app, db, assetId: privateAsset } = await setup();
    await request(app).delete(`/api/assets/${privateAsset}`).expect(409);
    const taskId = crypto.randomUUID();
    db.createTask({ id: taskId, channelId: "", model: "", prompt: "公共图片", input: {}, status: "succeeded", libraryScope: "public" });
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    for (const id of [first, second]) db.insertAsset({
      id, taskId, fileName: `${id}.png`, mimeType: "image/png", byteSize: 1,
      relativePath: `${id}.png`, baseDir: db.assetsDir, sha256: "x", thumbPath: "",
    });
    const board = (await request(app).post("/api/boards").send({ title: "引用" }).expect(201)).body.data;
    await request(app).post(`/api/boards/${board.id}/bridge/assets`).send({ items: [{ assetId: first }] }).expect(200);
    await request(app).delete(`/api/assets/${first}`).expect(409);
    await request(app).delete(`/api/assets/${second}`).expect(200);
    expect(db.getAsset(second)).toBeNull();
    expect(db.getAsset(first)).not.toBeNull();
    expect(db.getTaskView(taskId)).not.toBeNull();
  });

  it("显式标记的对话素材在删除会话后仍不会变成公共素材", async () => {
    const { app, db, conversationId } = await setup();
    const taskId = crypto.randomUUID();
    db.createTask({ id: taskId, channelId: "", model: "", prompt: "私有生成", input: {}, status: "succeeded", libraryScope: "conversation" });
    db.appendMessage({ conversationId, role: "assistant", content: "结果", taskId });
    expect((await request(app).get("/api/library").expect(200)).body.data.some((task: { id: string }) => task.id === taskId)).toBe(false);
    await request(app).delete(`/api/conversations/${conversationId}`).expect(200);
    expect((await request(app).get("/api/library").expect(200)).body.data.some((task: { id: string }) => task.id === taskId)).toBe(false);
  });
  it("删掉任务、消息引用、画布和分镜 / 设定图指针", async () => {
    const { app, db, conversationId, assetId, taskId } = await setup();
    const view = (await request(app).get(`/api/conversations/${conversationId}`).expect(200)).body.data as {
      sessionImages: Array<{ asset: { id: string } }>;
    };
    expect(view.sessionImages.some((entry) => entry.asset.id === assetId)).toBe(true);

    db.updateConversation(conversationId, { canvasAssetIds: [assetId] });
    const [shot] = db.replaceStoryboard(conversationId, [
      { sourceText: "镜头一", prompt: "一只猫坐在窗台上", kind: "image", aspectRatio: "16:9" },
    ]);
    db.updateStoryboardShot(shot!.id, {
      taskId,
      videoMode: "reference",
      firstFrameAssetId: assetId,
      lastFrameAssetId: assetId,
      referenceAssetIds: [assetId],
    });
    db.upsertStoryboardCharacters(conversationId, [{ name: "苏晚" }]);
    const character = db.listStoryboardCharacters(conversationId)[0]!;
    db.setStoryboardCharacterAsset(character.id, assetId);
    db.confirmStoryboardCharacter(character.id, true);

    await request(app).delete(`/api/conversations/${conversationId}/assets/${assetId}`).expect(200);

    expect(db.getAsset(assetId)).toBeNull();
    expect(db.getTaskView(taskId)).toBeNull();
    expect(db.getConversation(conversationId)!.canvasAssetIds).not.toContain(assetId);
    expect(db.getStoryboardShot(shot!.id)!.taskId).toBeNull();
    expect(db.getStoryboardShot(shot!.id)).toMatchObject({
      firstFrameAssetId: null,
      lastFrameAssetId: null,
      referenceAssetIds: [],
    });
    const afterCharacter = db.getStoryboardCharacter(character.id)!;
    expect(afterCharacter.assetId).toBeNull();
    expect(afterCharacter.confirmed).toBe(false);
    const message = db.listMessages(conversationId).find((entry) => (entry.content ?? "").includes("上传了图片"))!;
    expect(message.assetId).toBeNull();

    // 已经删掉的图不能再删一次
    await request(app).delete(`/api/conversations/${conversationId}/assets/${assetId}`).expect(404);
  });

  it("不属于这个会话的图拒绝删除", async () => {
    const { app, db, conversationId } = await setup();
    const otherTask = crypto.randomUUID();
    const otherAsset = crypto.randomUUID();
    db.createTask({ id: otherTask, channelId: "", model: "", prompt: "别家的图", input: {}, origin: "upload", status: "succeeded" });
    db.insertAsset({
      id: otherAsset, taskId: otherTask, fileName: "other.png", mimeType: "image/png", byteSize: 1,
      relativePath: "other.png", baseDir: db.assetsDir, sha256: "x", thumbPath: "",
    });
    await request(app).delete(`/api/conversations/${conversationId}/assets/${otherAsset}`).expect(404);
    expect(db.getAsset(otherAsset)).not.toBeNull();
  });
});
