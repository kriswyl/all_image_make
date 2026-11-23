import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import { CONVERSATION_TRASH_DAYS } from "../src/shared/agent-types";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

it("会话移到最近删除后，可在重启后按原 ID 恢复消息和附件，并清理到期会话", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chatcanvas-conversation-trash-"));
  let instance = createApp({ dataDir: directory });
  const close = () => { instance.context.agent.dispose(); instance.context.db.close(); };
  try {
    const { app, context } = instance;
    const { id } = context.db.createConversation({ title: "带附件的对话", brainChannelId: "", brainModel: "",
      videoConfirmPolicy: "always", visionEnabled: true, verbatimPrompt: false });
    const url = `/api/conversations/${id}`;
    const trashItem = `/api/conversations/trash/${id}`;
    const message = context.db.appendMessage({ conversationId: id, role: "user", content: "保留这段文字" });
    const upload = await request(app).post(`${url}/uploads`).attach("images", png, "附件.png").expect(201);
    const assetId = upload.body.data.uploadedAssetIds[0];
    const stored = context.db.getAsset(assetId)!;
    const file = path.join(stored.baseDir, stored.relativePath);
    await request(app).delete(trashItem).expect(404);
    const moved = (await request(app).delete(url).expect(200)).body.data;
    expect((await request(app).delete(url).expect(200)).body.data.deletedAt).toBe(moved.deletedAt);
    expect((await request(app).get("/api/conversations").expect(200)).body.data).toEqual([]);
    await request(app).get(url).expect(404);
    await request(app).post(`${url}/messages`).send({ text: "隐藏会话不可继续" }).expect(404);
    await request(app).post(`${url}/uploads`).attach("images", png, "另一张.png").expect(404);
    await access(file);

    close();
    instance = createApp({ dataDir: directory });
    const saved = (await request(instance.app).get("/api/conversations/trash").expect(200)).body.data;
    expect(saved).toMatchObject([{ id, title: "带附件的对话", deletedAt: moved.deletedAt, expiresAt: moved.expiresAt }]);
    await request(instance.app).post(`${trashItem}/restore`).expect(200);
    await request(instance.app).post(`${trashItem}/restore`).expect(200);
    const restored = (await request(instance.app).get(url).expect(200)).body.data;
    expect(restored).toMatchObject({ id, messages: [{ id: message.id, content: message.content }, { assetId }], canvasAssetIds: [assetId] });
    await request(instance.app).get(`/api/assets/${assetId}/file`).expect(200);

    const movedAgain = (await request(instance.app).delete(url).expect(200)).body.data;
    const time = vi.spyOn(Date, "now").mockReturnValue(Date.parse(movedAgain.deletedAt) + CONVERSATION_TRASH_DAYS * 86_400_000 + 1000);
    try {
      await request(instance.app).post(`${trashItem}/restore`).expect(404);
      expect((await request(instance.app).get("/api/conversations/trash").expect(200)).body.data).toEqual([]);
      expect(instance.context.db.getAsset(assetId)).toBeNull();
      await expect(access(file)).rejects.toThrow();
    } finally { time.mockRestore(); }
  } finally {
    close();
    await rm(directory, { recursive: true, force: true });
  }
});
