import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/server/app";

it("生图确认策略在设置里统一修改，并同步现有会话", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "image-policy-settings-"));
  const { app, context } = createApp({ dataDir: dir });
  try {
    const chat = context.db.createConversation({ title: "图片", brainChannelId: "brain", brainModel: "mock", videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false });
    expect(context.db.getConversation(chat.id)?.imageConfirmPolicy).toBe("batch_only");
    expect((await request(app).get("/api/settings").expect(200)).body.data.imageConfirmPolicy).toBe("batch_only");
    const updated = await request(app).patch("/api/settings").send({ agentImageConfirmPolicy: "always" }).expect(200);
    expect(updated.body.data.imageConfirmPolicy).toBe("always");
    expect(context.db.getConversation(chat.id)?.imageConfirmPolicy).toBe("always");
  } finally {
    context.agent.dispose();
    context.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
