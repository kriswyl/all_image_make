import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Jimp } from "jimp";
import { expect, it } from "vitest";
import { viewNativeImages } from "../src/server/chat-tools/native-image";
import { AppDatabase } from "../src/server/db";
import { prepareImageBytes } from "../src/server/vision";

it("对话助手能查看未缓存缩略图的历史 WebP 产物，并保留原文件", async () => {
  // 16 × 12 的红色无损 WebP，和模型输出一样使用 VP8L。
  const original = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvD8ACAAdQl5rXov+BiOh/AAA=", "base64");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-webp-vision-"));
  const db = new AppDatabase(dataDir);
  try {
    const conversation = db.createConversation({
      title: "打开生成图", brainChannelId: "local-brain", brainModel: "mock",
      videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
    });
    const task = { id: "webp-task", channelId: "", model: "gpt-image-2.6-flare-c", prompt: "红色", input: {} };
    db.createTask({ ...task, status: "succeeded" });
    const assetId = "6a26-test-asset";
    const fileName = "generated.webp";
    const originalPath = path.join(db.assetsDir, fileName);
    await fs.writeFile(originalPath, original);
    db.insertAsset({
      id: assetId, taskId: task.id, fileName, mimeType: "image/webp", byteSize: original.length,
      relativePath: fileName, baseDir: db.assetsDir, sha256: "test", thumbPath: "",
    });
    db.appendMessage({ conversationId: conversation.id, role: "assistant", content: "图片生成完成", assetId });

    const result = await viewNativeImages(db, conversation, JSON.stringify({ assetRefs: ["#6a26"] }));

    expect(result).toMatchObject({ ok: true, summary: "已加载 #6a26" });
    const part = result.imageContext?.find(part => part.type === "image_url");
    const prefix = "data:image/jpeg;base64,";
    expect(part?.image_url.url.startsWith(prefix)).toBe(true);
    const image = await Jimp.read(Buffer.from(part!.image_url.url.slice(prefix.length), "base64"));
    expect([image.width, image.height]).toEqual([512, 384]);
    expect(image.bitmap.data[0]).toBeGreaterThan(200);
    expect(image.bitmap.data[1]).toBeLessThan(80);
    const asset = db.getAsset(assetId)!;
    expect(asset.thumbPath).toBe(`${assetId}.jpg`);
    expect(await fs.readFile(originalPath)).toEqual(original);
    // 强制走重编码路径，覆盖超出参考图体积预算的分支。
    const frame = await prepareImageBytes(db, asset, { maxEdge: 8, maxBytes: 20, quality: 80 });
    expect(frame?.mimeType).toBe("image/jpeg");
    expect((await Jimp.read(frame!.bytes)).width).toBe(4);
  } finally {
    db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
