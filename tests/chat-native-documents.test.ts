import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/server/app";
import { executeChatDocumentTool, readWorkspaceFile } from "../src/server/chat-tools/documents";
import { parseXmind } from "../src/server/mind-document";

it("普通聊天原生调用工具并在聊天中保存可下载文件", async () => {
  let calls = 0; const received: any[] = []; let savedCheckpoint: string | null = null; let conversationId = "";
  const mock = http.createServer((req, res) => { const chunks: Buffer[] = []; req.on("data", (chunk) => chunks.push(Buffer.from(chunk))); req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); received.push(body); calls++;
    if (calls === 2) savedCheckpoint = context.db.getNativeTurnCheckpoint(conversationId);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: calls === 1 ? { content: "我来整理。", tool_calls: [{ id: "call_1", type: "function", function: { name: "doc_create", arguments: JSON.stringify({ kind: "md", name: "大纲", content: "# 标题\n内容" }) } }] } : { content: "已生成文件。" }, finish_reason: calls === 1 ? "tool_calls" : "stop" }] }));
  }); });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address(); if (!address || typeof address === "string") throw new Error("mock");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-doc-")); const { app, context } = createApp({ dataDir: dir });
  try {
    await request(app).post("/api/channels").send({ name: "Brain", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat", authType: "none", authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions", models: ["mock"], allowPrivateNetwork: true, enabled: true }).expect(201);
    const id = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id;
    conversationId = id;
    await request(app).patch(`/api/conversations/${id}`).send({ chatMode: "chat" }).expect(200);
    await request(app).post(`/api/conversations/${id}/messages`).send({ text: "写一篇 Markdown 大纲" }).expect(202);
    let view: any;
    for (let n = 0; n < 100; n++) { await new Promise((resolve) => setTimeout(resolve, 30)); view = (await request(app).get(`/api/conversations/${id}`)).body.data; if (view.status === "idle" && calls >= 2) break; }
    expect(calls).toBe(2); expect(received[0].tools.map((tool: any) => tool.function.name)).toContain("doc_create");
    expect(savedCheckpoint).not.toBeNull();
    expect(JSON.parse(savedCheckpoint!).previousCalls).toHaveLength(1);
    expect(context.db.getNativeTurnCheckpoint(id)).toBeNull();
    const native = received[1].messages.slice(-2); expect(native[0].role).toBe("assistant"); expect(native[0].tool_calls[0].id).toBe("call_1"); expect(native[1].role).toBe("tool"); expect(native[1].tool_call_id).toBe("call_1");
    const row = view.messages.find((message: any) => message.role === "tool" && message.toolName === "doc_create"); expect(row.toolResult.ok).toBe(true);
    expect(context.db.listNativeToolCalls(id)).toMatchObject([{ call_id: "call_1", tool_name: "doc_create", status: "ok" }]);
    const fileId = row.toolResult.data.workspaceFileId; expect(readWorkspaceFile(context.db, id, fileId).bytes.toString("utf8")).toBe("# 标题\n内容");
    const other = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id;
    await request(app).get(`/api/conversations/${other}/documents/files/${fileId}`).expect(404);
    await request(app).get(`/api/conversations/${id}/documents/files/${fileId}`).expect(200);
    const tree = await executeChatDocumentTool(context.db, id, "doc_create", JSON.stringify({ kind: "xmind", name: "导图", nodes: { title: "主题", children: [{ title: "章节", children: [{ title: "内容" }] }] } }));
    expect(tree.ok).toBe(true); expect((await parseXmind(readWorkspaceFile(context.db, id, tree.data!.fileId).bytes)).sheets[0].title).toBe("主题");
    const ppt = await executeChatDocumentTool(context.db, id, "doc_convert", JSON.stringify({ fileId: tree.data!.fileId, to: "pptx" }), async () => ({ title: "主题", theme: "ink", slides: [{ layout: "cover", title: "主题", subtitle: "", lines: [], notes: "" }, { layout: "content", title: "章节", subtitle: "", lines: ["内容"], notes: "" }] })); expect(ppt.ok).toBe(true);
    const deletion = await executeChatDocumentTool(context.db, id, "doc_delete", JSON.stringify({ fileId: tree.data!.fileId }));
    expect(deletion.data?.pendingDelete).toBe(true);
    expect(readWorkspaceFile(context.db, id, tree.data!.fileId).bytes.length).toBeGreaterThan(0);
    await request(app).delete(`/api/conversations/${other}/documents/files/${tree.data!.fileId}`).expect(404);
    await request(app).delete(`/api/conversations/${id}/documents/files/${tree.data!.fileId}`).expect(200);
    expect(context.db.getWorkspaceDocument(id, tree.data!.fileId)).toBeNull();
    await request(app).delete(`/api/conversations/${id}`).expect(200);
    await expect(fs.stat(path.join(dir, "documents", id))).rejects.toThrow();
  } finally { context.db.close(); await fs.rm(dir, { recursive: true, force: true }); await new Promise<void>((resolve) => mock.close(() => resolve())); }
}, 20000);

it("普通聊天可更新任务计划，后续消息能恢复最近的计划", async () => {
  let calls = 0; const received: any[] = [];
  const mock = http.createServer((req, res) => { const chunks: Buffer[] = []; req.on("data", (chunk) => chunks.push(Buffer.from(chunk))); req.on("end", () => {
    received.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); calls++;
    const message = calls === 1 ? { content: "", tool_calls: [{ id: "plan_1", type: "function", function: { name: "plan_update", arguments: JSON.stringify({ steps: [{ task: "核对输入资料", status: "in_progress" }, { task: "检查结果", status: "pending" }] }) } }] } : { content: "收到。" };
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message, finish_reason: calls === 1 ? "tool_calls" : "stop" }] }));
  }); });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address(); if (!address || typeof address === "string") throw new Error("mock");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-plan-")); const { app, context } = createApp({ dataDir: dir });
  try {
    await request(app).post("/api/channels").send({ name: "Brain", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat", authType: "none", authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions", models: ["mock"], allowPrivateNetwork: true, enabled: true }).expect(201);
    const id = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id;
    await request(app).patch(`/api/conversations/${id}`).send({ chatMode: "chat" }).expect(200);
    await request(app).post(`/api/conversations/${id}/messages`).send({ text: "先检查资料再检查结果" }).expect(202);
    for (let n = 0; n < 100; n++) { await new Promise((resolve) => setTimeout(resolve, 30)); if ((await request(app).get(`/api/conversations/${id}`)).body.data.status === "idle" && calls >= 2) break; }
    const view = (await request(app).get(`/api/conversations/${id}`)).body.data;
    expect(view.messages.find((row: any) => row.role === "tool" && row.toolName === "plan_update")?.content).toContain("核对输入资料");
    await request(app).post(`/api/conversations/${id}/messages`).send({ text: "继续" }).expect(202);
    for (let n = 0; n < 100; n++) { await new Promise((resolve) => setTimeout(resolve, 30)); if (calls >= 3 && (await request(app).get(`/api/conversations/${id}`)).body.data.status === "idle") break; }
    expect(JSON.stringify(received[2].messages)).toContain("本会话最近的任务计划");
    expect(JSON.stringify(received[2].messages)).toContain("检查结果");
  } finally { context.db.close(); await fs.rm(dir, { recursive: true, force: true }); await new Promise<void>((resolve) => mock.close(() => resolve())); }
}, 20000);

it("普通聊天按用户要求先读取文件再精确修改，并返回新版本", async () => {
  let calls = 0; let fileId = "";
  const mock = http.createServer((req, res) => { const chunks: Buffer[] = []; req.on("data", (chunk) => chunks.push(Buffer.from(chunk))); req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); calls++;
    let message: any;
    if (calls === 1) message = { content: "", tool_calls: [{ id: "read-1", type: "function", function: { name: "doc_read", arguments: JSON.stringify({ fileId, charOffset: 0 }) } }] };
    else if (calls === 2) {
      const result = body.messages.findLast((item: any) => item.role === "tool" && item.tool_call_id === "read-1").content;
      const read = JSON.parse(result.slice(result.indexOf("{")));
      message = { content: "", tool_calls: [{ id: "edit-1", type: "function", function: { name: "doc_edit", arguments: JSON.stringify({ fileId, expectedSha256: read.sha256, edits: [{ find: "原有标题", replace: "新标题" }] }) } }] };
    } else message = { content: "已修改并保留原文件。" };
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message, finish_reason: calls < 3 ? "tool_calls" : "stop" }] }));
  }); });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address(); if (!address || typeof address === "string") throw new Error("mock");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-doc-edit-")); const { app, context } = createApp({ dataDir: dir });
  try {
    await request(app).post("/api/channels").send({ name: "Brain", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat", authType: "none", authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions", models: ["mock"], allowPrivateNetwork: true, enabled: true }).expect(201);
    const id = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id;
    await request(app).patch(`/api/conversations/${id}`).send({ chatMode: "chat" }).expect(200);
    fileId = (await executeChatDocumentTool(context.db, id, "doc_create", JSON.stringify({ kind: "md", name: "稿件", content: "# 原有标题\n原始内容" }))).data!.fileId;
    await request(app).post(`/api/conversations/${id}/messages`).send({ text: "把标题改成新标题" }).expect(202);
    let view: any;
    for (let n = 0; n < 100; n++) { await new Promise((resolve) => setTimeout(resolve, 30)); view = (await request(app).get(`/api/conversations/${id}`)).body.data; if (calls >= 3 && view.status === "idle") break; }
    const edited = view.messages.find((item: any) => item.role === "tool" && item.toolName === "doc_edit");
    expect(edited?.toolResult.ok).toBe(true);
    expect(readWorkspaceFile(context.db, id, edited.toolResult.data.workspaceFileId).bytes.toString()).toBe("# 新标题\n原始内容");
    expect(readWorkspaceFile(context.db, id, fileId).bytes.toString()).toBe("# 原有标题\n原始内容");
  } finally { context.agent.dispose(); context.db.close(); await fs.rm(dir, { recursive: true, force: true }); await new Promise<void>((resolve) => mock.close(() => resolve())); }
}, 20000);
