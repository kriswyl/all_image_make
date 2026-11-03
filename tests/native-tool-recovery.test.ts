import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { AppDatabase } from "../src/server/db";
import { createApp } from "../src/server/app";
import request from "supertest";
import http from "node:http";
import { executeChatDocumentTool } from "../src/server/chat-tools/documents";
import { CHAT_DOCUMENT_TOOLS } from "../src/server/chat-tools/documents";
import { createPlanTool } from "../src/server/chat-tools/planning";
import { createHash } from "node:crypto";

it("重启后标记未完成的工具调用，并提示副作用可能已发生", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-recover-"));
  const db = new AppDatabase(dir);
  try {
    const chat = db.createConversation({ title: "恢复", brainChannelId: "brain", brainModel: "mock", videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false });
    db.setConversationStatus(chat.id, "running", { touch: false });
    const pending = db.appendMessage({ conversationId: chat.id, role: "assistant", toolName: "doc_create", status: "pending", content: "正在创建" });
    db.beginNativeToolCall(chat.id, pending.id, "call-1", "doc_create", "hash");
    expect(db.resetConversationsStuckInRunning()).toBe(1);
    expect(db.getConversation(chat.id)?.status).toBe("idle");
    expect(db.getMessage(pending.id)).toMatchObject({ status: "error", content: "" });
    expect(db.getMessage(pending.id)?.errorMessage).toContain("重试前请先检查");
    expect(db.listNativeToolCalls(chat.id)).toMatchObject([{ call_id: "call-1", status: "interrupted" }]);
    expect(() => db.finishNativeToolCall(chat.id, pending.id, "doc_create", { ok: true, summary: "晚到结果" })).toThrow(/状态已改变/);
  } finally { db.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

it("文件已写入但结果未落库时恢复结果，并按操作 ID 防止重复创建", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-recover-file-"));
  const db = new AppDatabase(dir);
  try {
    const chat = db.createConversation({ title: "恢复文件", brainChannelId: "brain", brainModel: "mock", videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false });
    db.setConversationStatus(chat.id, "running", { touch: false });
    const pending = db.appendMessage({ conversationId: chat.id, role: "assistant", toolName: "doc_create", status: "pending", content: "" });
    db.beginNativeToolCall(chat.id, pending.id, "call-2", "doc_create", "hash");
    const args = JSON.stringify({ kind: "md", name: "草稿", content: "# 正文" });
    const first = await executeChatDocumentTool(db, chat.id, "doc_create", args, undefined, pending.id);
    const replay = await executeChatDocumentTool(db, chat.id, "doc_create", args, undefined, pending.id);
    expect(first.ok).toBe(true);
    expect(replay.data?.fileId).toBe(first.data?.fileId);
    expect(db.listWorkspaceDocuments(chat.id)).toHaveLength(1);
    db.resetConversationsStuckInRunning();
    expect(db.listNativeToolCalls(chat.id)).toMatchObject([{ call_id: "call-2", status: "ok" }]);
    const recovered = db.listMessages(chat.id).find((message) => message.role === "tool" && message.toolName === "doc_create");
    expect(recovered?.toolResult?.data?.workspaceFileId).toBe(first.data?.fileId);
    expect(recovered?.content).toContain("已恢复");
  } finally { db.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

it("模型调用达到会话上限后停止，已完成的工具结果仍可见", async () => {
  let calls = 0;
  const mock = http.createServer((req, res) => { req.resume(); req.on("end", () => {
    calls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "list-1", type: "function", function: { name: "doc_list", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }));
  }); });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address(); if (!address || typeof address === "string") throw new Error("mock");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-budget-")); const { app, context } = createApp({ dataDir: dir });
  try {
    await request(app).post("/api/channels").send({ name: "Brain", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat", authType: "none", authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions", models: ["mock"], allowPrivateNetwork: true, enabled: true }).expect(201);
    const id = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id;
    const patched = await request(app).patch(`/api/conversations/${id}`).send({ chatMode: "chat", chatModelCallLimit: 1, chatToolRoundLimit: 5, chatTurnMinutes: 2 }).expect(200);
    expect(patched.body.data.chatModelCallLimit).toBe(1);
    await request(app).post(`/api/conversations/${id}/messages`).send({ text: "列出文件" }).expect(202);
    let view: any;
    for (let n = 0; n < 100; n++) { await new Promise((resolve) => setTimeout(resolve, 30)); view = (await request(app).get(`/api/conversations/${id}`)).body.data; if (calls && view.status === "idle") break; }
    expect(calls).toBe(1);
    expect(view.messages.find((item: any) => item.role === "tool" && item.toolName === "doc_list")?.status).toBe("ok");
    expect(view.messages.some((item: any) => item.content?.includes("1 次上限"))).toBe(true);
  } finally { context.db.close(); await fs.rm(dir, { recursive: true, force: true }); await new Promise<void>((resolve) => mock.close(() => resolve())); }
}, 20000);

it.each([
  { usage: { prompt_tokens: 60, completion_tokens: 50 }, notice: "达到 100 的上限" },
  { usage: { prompt_tokens: 60 }, notice: "未提供完整 token 用量" },
])("token 预算：$notice 时保留工具结果并停止后续模型调用", async ({ usage, notice }) => {
  let calls = 0;
  const mock = http.createServer((req, res) => { req.resume(); req.on("end", () => {
    calls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ usage, choices: [{ message: { content: "", tool_calls: [{ id: "list-1", type: "function", function: { name: "doc_list", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }));
  }); });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address(); if (!address || typeof address === "string") throw new Error("mock");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-token-budget-")); const { app, context } = createApp({ dataDir: dir });
  try {
    await request(app).post("/api/channels").send({ name: "Brain", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat", authType: "none", authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions", models: ["mock"], allowPrivateNetwork: true, enabled: true }).expect(201);
    const id = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id;
    await request(app).patch(`/api/conversations/${id}`).send({ chatMode: "chat", chatTokenLimit: 100 }).expect(200);
    await request(app).post(`/api/conversations/${id}/messages`).send({ text: "列出文件" }).expect(202);
    let view: any;
    for (let n = 0; n < 100; n++) { await new Promise((resolve) => setTimeout(resolve, 30)); view = (await request(app).get(`/api/conversations/${id}`)).body.data; if (calls && view.status === "idle") break; }
    expect(calls).toBe(1);
    expect(view.messages.find((item: any) => item.role === "tool" && item.toolName === "doc_list")?.status).toBe("ok");
    expect(view.messages.some((item: any) => item.content?.includes(notice))).toBe(true);
  } finally { context.agent.dispose(); context.db.close(); await fs.rm(dir, { recursive: true, force: true }); await new Promise<void>((resolve) => mock.close(() => resolve())); }
}, 20000);

it("在工具批次全部完成后的安全断点重启时继续，不重复执行工具", async () => {
  const received: any[] = [];
  const mock = http.createServer((req, res) => { const chunks: Buffer[] = []; req.on("data", (chunk) => chunks.push(Buffer.from(chunk))); req.on("end", () => {
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "已根据文件结果继续完成。" }, finish_reason: "stop" }] }));
  }); });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address(); if (!address || typeof address === "string") throw new Error("mock");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-turn-resume-")); const { app, context } = createApp({ dataDir: dir });
  try {
    const channel = (await request(app).post("/api/channels").send({ name: "Brain", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat", authType: "none", authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions", models: ["mock"], allowPrivateNetwork: true, enabled: true }).expect(201)).body.data;
    const id = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id;
    await request(app).patch(`/api/conversations/${id}`).send({ chatMode: "chat" }).expect(200);
    const current = context.db.getConversation(id)!;
    expect(current.brainChannelId).toBe(channel.id);
    context.db.setConversationStatus(id, "running", { touch: false });
    const messages = [
      { role: "user", content: "请列出文件" },
      { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "doc_list", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call-1", content: "成功：没有文件" },
    ];
    const toolSpecs = [...CHAT_DOCUMENT_TOOLS, createPlanTool().spec].sort((a, b) => a.function.name.localeCompare(b.function.name));
    const toolSignature = createHash("sha256").update(JSON.stringify(toolSpecs)).digest("hex");
    context.db.saveNativeTurnCheckpoint(id, JSON.stringify({ version: 3, channelId: current.brainChannelId, channelVersion: context.db.getChannel(current.brainChannelId)!.updatedAt, model: current.brainModel, toolSignature, messages, toolRounds: 1, brainCalls: 1, elapsedMs: 100, usedTokens: 0, usageMissing: false, previousCalls: [] }));
    expect(context.agent.recoverStaleConversations()).toBe(1);
    let view: any;
    for (let n = 0; n < 100; n++) { await new Promise((resolve) => setTimeout(resolve, 30)); view = (await request(app).get(`/api/conversations/${id}`)).body.data; if (received.length && view.status === "idle") break; }
    expect(received).toHaveLength(1);
    expect(received[0].messages).toEqual(messages);
    expect(view.messages.some((message: any) => message.content?.includes("已从上次完成的工具步骤继续"))).toBe(true);
    expect(view.messages.some((message: any) => message.content?.includes("已根据文件结果继续完成"))).toBe(true);
    expect(context.db.getNativeTurnCheckpoint(id)).toBeNull();
    expect(context.db.listNativeToolCalls(id)).toHaveLength(0);
  } finally { context.agent.dispose(); context.db.close(); await fs.rm(dir, { recursive: true, force: true }); await new Promise<void>((resolve) => mock.close(() => resolve())); }
}, 20000);

it("工具仍在执行时不自动恢复旧断点", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-unsafe-resume-")); const { context } = createApp({ dataDir: dir });
  try {
    const chat = context.db.createConversation({ title: "不安全断点", brainChannelId: "brain", brainModel: "mock", videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false });
    context.db.updateConversation(chat.id, { chatMode: "chat" });
    context.db.setConversationStatus(chat.id, "running", { touch: false });
    const pending = context.db.startNativeToolCall(chat.id, "doc_create", {}, "call-x", "doc_create", "hash");
    context.db.saveNativeTurnCheckpoint(chat.id, "{}");
    context.agent.recoverStaleConversations();
    expect(context.db.getNativeTurnCheckpoint(chat.id)).toBeNull();
    expect(context.db.getMessage(pending.id)?.status).toBe("error");
    expect(context.agent.isRunning(chat.id)).toBe(false);
  } finally { context.agent.dispose(); context.db.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

it("渠道配置变化时不发送旧断点给模型", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-changed-channel-")); const { app, context } = createApp({ dataDir: dir });
  try {
    await request(app).post("/api/channels").send({ name: "Brain", baseUrl: "http://127.0.0.1:9", adapterType: "openai-chat", authType: "none", authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions", models: ["mock"], allowPrivateNetwork: true, enabled: true }).expect(201);
    const id = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id;
    await request(app).patch(`/api/conversations/${id}`).send({ chatMode: "chat" }).expect(200);
    const current = context.db.getConversation(id)!;
    const toolSpecs = [...CHAT_DOCUMENT_TOOLS, createPlanTool().spec].sort((a, b) => a.function.name.localeCompare(b.function.name));
    const toolSignature = createHash("sha256").update(JSON.stringify(toolSpecs)).digest("hex");
    context.db.saveNativeTurnCheckpoint(id, JSON.stringify({ version: 3, channelId: current.brainChannelId, channelVersion: "old-configuration", model: current.brainModel, toolSignature, messages: [{ role: "user", content: "继续工作" }], toolRounds: 1, brainCalls: 1, elapsedMs: 0, usedTokens: 0, usageMissing: false, previousCalls: [] }));
    context.db.setConversationStatus(id, "running", { touch: false });
    context.agent.recoverStaleConversations();
    let view: any;
    for (let n = 0; n < 100; n++) { await new Promise((resolve) => setTimeout(resolve, 30)); view = (await request(app).get(`/api/conversations/${id}`)).body.data; if (view.status === "idle") break; }
    expect(view.messages.some((message: any) => message.content?.includes("渠道配置或可用工具已改变"))).toBe(true);
    expect(context.db.getNativeTurnCheckpoint(id)).toBeNull();
    expect(view.usage.calls).toBe(0);
  } finally { context.agent.dispose(); context.db.close(); await fs.rm(dir, { recursive: true, force: true }); }
}, 20000);
