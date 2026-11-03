import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import request from "supertest";
import { expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { runAgentTool, type ToolContext } from "../src/server/agent-tools";
import { buildSystemPrompt } from "../src/server/agent-prompt";
import type { Conversation } from "../src/shared/agent-types";

it("创作助手拦截旧 PPT 调用，同一对话切换普通聊天后可读取原附件并使用新工具", async () => {
  let calls = 0; let documentId = ""; const received: any[] = [];
  const mock = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); calls++;
      const plans = [
        { tool: "document_read", args: { start: -1 }, say: "先看看导图。" },
        { tool: "document_make_pptx", args: { edits: [{ page: 2, title: "新标题" }] }, say: "正在修改。" },
        { tool: "reply", args: { text: "请在当前对话切换到「普通聊天」，再发送 PPT 制作或修改要求；无需重新上传。" } },
      ];
      const message = calls <= 3 ? { role: "assistant", content: JSON.stringify(plans[calls - 1]) }
        : calls === 4 ? { content: "", tool_calls: [{ id: "read-source", type: "function", function: { name: "doc_read", arguments: JSON.stringify({ fileId: documentId, offset: 0 }) } }] }
        : { content: "已读取原附件，可继续制作 PPT。" };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message, finish_reason: calls === 4 ? "tool_calls" : "stop" }] }));
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address(); if (!address || typeof address === "string") throw new Error("mock");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mind-agent-"));
  const { app, context } = createApp({ dataDir: dir });
  try {
    await request(app).post("/api/channels").send({ name: "Brain", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat", authType: "none", authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions", models: ["mock"], allowPrivateNetwork: true, enabled: true }).expect(201);
    const id = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id;
    await request(app).patch(`/api/conversations/${id}`).send({ chatMode: "creative" }).expect(200);
    const zip = new JSZip(); zip.file("content.json", JSON.stringify([{ rootTopic: { title: "主题", children: { attached: [{ title: "章节", children: { attached: [{ title: "原内容" }] } }] } } }]));
    const original = await zip.generateAsync({ type: "nodebuffer" });
    const upload = await request(app).post(`/api/conversations/${id}/mind-documents`).attach("file", original, "test.xmind").expect(201);
    documentId = upload.body.data.messages.flatMap((message: any) => message.documents).at(-1).id;
    // 旧版本下载不依赖已停用工具；保留下载和会话隔离能力。
    const oldOutputId = context.db.addDocumentOutput(documentId, "历史.pptx", Buffer.from("historical-output"));
    async function send(text: string, target: number) {
      await request(app).post(`/api/conversations/${id}/messages`).send({ text }).expect(202);
      for (let n = 0; n < 100; n++) { await new Promise((resolve) => setTimeout(resolve, 50)); const view = (await request(app).get(`/api/conversations/${id}`)).body.data; if (view.status === "idle" && calls >= target) return view; }
      throw new Error(`助手未完成：${calls}`);
    }
    const creative = await send("把这个导图转成 PPT，并把第二页标题改成新标题", 3);
    const prompt = received[0].messages.find((message: any) => message.role === "system").content;
    expect(prompt).toContain("普通聊天"); expect(prompt).not.toContain("document_make_pptx"); expect(prompt).not.toContain("document_read");
    const blocked = creative.messages.filter((message: any) => message.role === "tool");
    expect(blocked).toHaveLength(2);
    for (const message of blocked) {
      expect(message.toolResult).toMatchObject({ ok: false, error: "PPT_CHAT_MODE_REQUIRED" });
      expect(message.toolResult.summary).toContain("普通聊天");
      expect(message.toolResult.data?.documentOutputId).toBeUndefined();
    }
    expect(context.db.getConversationDocumentPlan(documentId)).toBeNull();
    expect(context.db.getConversationDocumentFile(documentId)?.equals(original)).toBe(true);
    const other = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id;
    await request(app).get(`/api/conversations/${other}/document-outputs/${oldOutputId}`).expect(404);
    await request(app).get(`/api/conversations/${id}/document-outputs/${oldOutputId}`).expect(200);
    await request(app).patch(`/api/conversations/${id}`).send({ chatMode: "chat" }).expect(200);
    const chat = await send("读取刚才的导图，继续制作 PPT", 5);
    expect(received[3].tools.map((tool: any) => tool.function.name)).toEqual(expect.arrayContaining(["doc_read", "doc_convert", "doc_edit"]));
    expect(received[3].tools.map((tool: any) => tool.function.name)).not.toContain("document_make_pptx");
    const nativeRead = chat.messages.find((message: any) => message.role === "tool" && message.toolName === "doc_read");
    expect(nativeRead?.toolResult?.ok, JSON.stringify(nativeRead?.toolResult)).toBe(true);
    expect(JSON.stringify(received[4].messages)).toContain("原内容");
    expect(context.db.getConversationDocumentFile(documentId)?.equals(original)).toBe(true);
  } finally { context.agent.dispose(); context.db.close(); await fs.rm(dir, { recursive: true, force: true }); await new Promise<void>((resolve) => mock.close(() => resolve())); }
}, 20000);

it.each([{ documents: [] }, { documents: [{ fileName: "test.xmind", charCount: 10 }] }])("创作提示不再随附件开放旧 PPT 工具：%j", ({ documents }) => {
  const prompt = buildSystemPrompt("", { brainModel: "mock" } as Conversation, [], false, [], documents);
  expect(prompt).toContain("PPT 制作、转换和修改统一在「普通聊天」中完成");
  expect(prompt).not.toContain("document_make_pptx"); expect(prompt).not.toContain("document_read");
});

it.each(["document_read", "document_make_pptx"] as const)("旧工具 %s 在访问会话或校验参数前即被拦截", async (name) => {
  const outcome = await runAgentTool(name, { slides: [{ arbitrary: "历史或无效参数" }] }, {} as ToolContext);
  expect(outcome.result).toMatchObject({ ok: false, error: "PPT_CHAT_MODE_REQUIRED" });
  expect(outcome.terminal).toBe(false);
});
