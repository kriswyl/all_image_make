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
