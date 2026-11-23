import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { expect, it } from "vitest";
import { createApp } from "../src/server/app";

it("普通聊天几轮之后仍在系统提示词里保留文件 ID", async () => {
  const received: any[] = [];
  const mock = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "收到。" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address();
  if (!address || typeof address === "string") throw new Error("mock server");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-doc-id-prompt-"));
  const { app, context } = createApp({ dataDir: dir });
  try {
    await request(app).post("/api/channels").send({
      name: "Brain", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat",
      authType: "none", authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
      models: ["mock"], allowPrivateNetwork: true, enabled: true,
    }).expect(201);
    const id = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id;
    await request(app).patch(`/api/conversations/${id}`).send({ chatMode: "chat" }).expect(200);
    const document = context.db.addConversationDocument(id, "1-洗稿提示词.txt", "按指南改写。");

    for (const text of ["按附件改写", "再改一次", "继续改"]) {
      await request(app).post(`/api/conversations/${id}/messages`).send({ text }).expect(202);
      for (let n = 0; n < 100; n++) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        if ((await request(app).get(`/api/conversations/${id}`)).body.data.status === "idle") break;
      }
    }

    expect(received.length).toBe(3);
    const systemText = received[2]!.messages
      .filter((message: any) => message.role === "system")
      .map((message: any) => message.content).join("\n");
    expect(systemText).toContain("本会话文件索引");
    expect(systemText).toContain("《1-洗稿提示词.txt》");
    expect(systemText).toContain(`文件 ID：${document.id}`);
  } finally {
    context.db.close();
    await fs.rm(dir, { recursive: true, force: true });
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  }
}, 30000);

it("会话文档原文件接口只允许本会话读取", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-doc-file-"));
  const { app, context } = createApp({ dataDir: dir });
  try {
    const makeConversation = (title: string) => context.db.createConversation({
      title, brainChannelId: "brain", brainModel: "mock-chat",
      videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
    });
    const id = makeConversation("文档接口").id;
    const other = makeConversation("另一个会话").id;
    const document = context.db.addConversationDocument(id, "剧情.md", "第一场：公园。");
    const response = await request(app).get(`/api/conversations/${id}/documents/items/${document.id}/file`).expect(200);
    expect(response.body.toString("utf8")).toBe("第一场：公园。");
    await request(app).get(`/api/conversations/${other}/documents/items/${document.id}/file`).expect(404);
  } finally {
    context.db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
