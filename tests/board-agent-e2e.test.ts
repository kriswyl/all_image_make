import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import type { BoardDoc, BoardNode } from "../src/shared/board";
import { storyboardProjectDataSchema } from "../src/shared/storyboard-project";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("无限画布 Agent 端到端", () => {
  it("大脑 → board_apply → 工具结果 → 收尾回答，画布真的多出节点和连线", async () => {
    const chatBodies: string[] = [];
    const mock = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (!req.url?.includes("/chat/completions")) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end("{}");
          return;
        }
        chatBodies.push(body);
        const plan = chatBodies.length === 1
          ? {
            tool: "board_apply",
            args: {
              ops: [
                { op: "add_node", tempId: "t", type: "text", x: 120, y: 120, text: "雨夜巷口，霓虹灯反射在积水里" },
                { op: "add_node", tempId: "c", type: "config", x: 520, y: 120, config: { mode: "image", count: 1 } },
                { op: "connect", from: "t", to: "c", kind: "input", role: "text" },
              ],
            },
            say: "我先搭两个节点。",
          }
          : { tool: "reply", args: { text: "搭好了，接上文本节点和配置节点了。" }, say: "好了。" };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(plan) } }] }));
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => mock.close(() => resolve())));
    const base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-board-agent-e2e-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(async () => {
      context.db.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    await request(app).post("/api/channels").send({
      name: "Board brain", baseUrl: base, adapterType: "openai-chat", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
      models: ["board-brain"], allowPrivateNetwork: true, enabled: true,
    }).expect(201);

    const board = (await request(app).post("/api/boards").send({ title: "Agent 端到端" }).expect(201)).body.data;
    await request(app).post(`/api/conversations/${board.threadId}/messages`).send({
      text: "帮我搭一个文本节点和一个配置节点，然后把它们连起来",
    }).expect(202);

    let current: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      current = (await request(app).get(`/api/boards/${board.id}`).expect(200)).body.data;
      const doc = current.doc as { nodes: unknown[]; edges: unknown[] };
      if (doc.nodes.length === 2 && doc.edges.length === 1) break;
    }

    const doc = current.doc as { nodes: Array<{ ref: string; type: string; text?: string }>; edges: Array<{ kind: string; role?: string }> };
    expect(doc.nodes.map((node) => node.type).sort()).toEqual(["config", "text"]);
    expect(doc.nodes.find((node) => node.type === "text")?.text).toContain("雨夜巷口");
    expect(doc.edges[0]).toMatchObject({ kind: "input", role: "text" });

    const view = (await request(app).get(`/api/conversations/${board.threadId}`).expect(200)).body.data;
    type Row = { role: string; content: string | null; toolName: string | null; toolResult: { ok: boolean; summary: string } | null };
    const messages = view.messages as Row[];
    expect(messages.map((item) => item.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(messages[1]!.toolName).toBe("board_apply");
    expect(messages[2]!.toolResult?.ok).toBe(true);
    expect(messages[2]!.toolResult?.summary).toContain("n1");
    expect(messages[3]!.content).toContain("搭好了");

    // 系统提示词用的是无限画布那一套，不是对话 / 分镜那一套
    expect(chatBodies).toHaveLength(2);
    expect(chatBodies[0]).toContain("无限画布助手");
    expect(chatBodies[0]).toContain("当前无限画布");
    expect(chatBodies[0]).not.toContain("当前分镜");
    expect(chatBodies[0]).not.toContain("参考图组");
  });

  it("画布生成先确认，任务完成后更新工具卡并回报结果", async () => {
    let chatCount = 0;
    const mock = http.createServer((req, res) => {
      const chunks: Buffer[] = []; req.on("data", (chunk) => chunks.push(Buffer.from(chunk))); req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url?.includes("/images/")) { res.end(JSON.stringify({ data: [{ b64_json: pngBase64 }] })); return; }
        chatCount++; const plan = chatCount === 1 ? { tool: "board_generate", args: { nodeRef: "n1" }, say: "准备生成。" } : { tool: "reply", args: { text: "图片任务已完成。" } };
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(plan) } }] }));
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => mock.close(() => resolve())));
    const base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-generation-confirm-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(async () => { context.db.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
    for (const [name, adapterType, model, endpoint] of [["brain", "openai-chat", "brain-model", "/v1/chat/completions"], ["image", "openai-images", "image-model", "/v1/images/generations"]]) {
      await request(app).post("/api/channels").send({ name, baseUrl: base, adapterType, authType: "none", authHeaderName: "", secretEnv: "", endpoint, models: [model], allowPrivateNetwork: true, enabled: true }).expect(201);
    }
    const board = (await request(app).post("/api/boards").send({ title: "确认生成" }).expect(201)).body.data;
    const at = new Date().toISOString();
    const node: BoardNode = { id: "node-image", ref: "n1", type: "image", x: 0, y: 0, width: 280, height: 210, title: "图片", createdAt: at, updatedAt: at, assetId: null, source: "upload", status: "empty", prompt: "一只猫" };
    await request(app).put(`/api/boards/${board.id}`).send({ doc: { version: 1, nextRef: 2, nodes: [node], edges: [] }, baseVersion: 1 }).expect(200);
    await request(app).post(`/api/conversations/${board.threadId}/messages`).send({ text: "生成选中的图片" }).expect(202);
    let view: any;
    for (let i = 0; i < 80; i++) { await new Promise((resolve) => setTimeout(resolve, 50)); view = (await request(app).get(`/api/conversations/${board.threadId}`).expect(200)).body.data; if (view.status === "awaiting_confirmation") break; }
    const confirmation = view.messages.find((item: any) => item.confirm?.reason === "board_generation");
    expect(confirmation?.confirm.message).toContain("1 个图片生成任务");
    expect(context.db.getBoardRecord(board.id)!.doc.nodes[0]).toMatchObject({ status: "empty" });
    await request(app).post(`/api/conversations/${board.threadId}/confirm`).send({ messageId: confirmation.id, decision: "approve" }).expect(200);
    for (let i = 0; i < 100; i++) { await new Promise((resolve) => setTimeout(resolve, 50)); view = (await request(app).get(`/api/conversations/${board.threadId}`).expect(200)).body.data; if (view.messages.some((item: any) => item.toolName === "board_generate" && item.toolResult?.summary?.includes("任务已完成"))) break; }
    expect(view.messages.some((item: any) => item.toolName === "board_generate" && item.toolResult?.summary?.includes("任务已完成"))).toBe(true);
  });

  it("助手主动读取指定节点的图片，明确标注未能读取的节点", async () => {
    const bodies: string[] = [];
    const mock = http.createServer((req, res) => { const chunks: Buffer[] = []; req.on("data", (chunk) => chunks.push(Buffer.from(chunk))); req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      const plan = bodies.length === 1 ? { tool: "board_view_images", args: { nodeRefs: ["n1", "n99"], assetIds: ["private-image"] }, say: "我检查图片。" } : { tool: "reply", args: { text: "已看 n1，n99 无法读取。" } };
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(plan) } }] }));
    }); });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => mock.close(() => resolve())));
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-explicit-vision-")); const { app, context } = createApp({ dataDir });
    cleanups.push(async () => { context.db.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
    await request(app).post("/api/channels").send({ name: "vision", baseUrl: `http://127.0.0.1:${(mock.address() as AddressInfo).port}`, adapterType: "openai-chat", authType: "none", authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions", models: ["vision-brain"], allowPrivateNetwork: true, enabled: true }).expect(201);
    const board = (await request(app).post("/api/boards").send({ title: "主动看图" }).expect(201)).body.data;
    const asset = (await request(app).post(`/api/boards/${board.id}/assets`).attach("file", Buffer.from(pngBase64, "base64"), { filename: "cat.png", contentType: "image/png" }).expect(201)).body.data;
    context.db.createTask({ id: "private-task", channelId: "", model: "", prompt: "private", input: {}, libraryScope: "conversation", status: "succeeded" });
    context.db.insertAsset({ id: "private-image", taskId: "private-task", fileName: "private.png", mimeType: "image/png", byteSize: 1, relativePath: "private.png", baseDir: context.db.assetsDir, sha256: "x", thumbPath: "" });
    const at = new Date().toISOString(); const image: BoardNode = { id: "image", ref: "n1", type: "image", x: 0, y: 0, width: 280, height: 210, title: "猫", createdAt: at, updatedAt: at, assetId: asset.id, source: "upload", status: "succeeded" };
    await request(app).put(`/api/boards/${board.id}`).send({ doc: { version: 1, nextRef: 2, nodes: [image], edges: [] }, baseVersion: 1 }).expect(200);
    await request(app).post(`/api/conversations/${board.threadId}/messages`).send({ text: "检查 n1 和 n99 的一致性" }).expect(202);
    for (let i = 0; i < 80 && bodies.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("data:image/");
    expect(bodies[1]).toContain("实际附图：n1");
    expect(bodies[1]).toContain("未能读取：n99、素材 private-image");
  });

  it("修改分镜项目需要明确确认，确认期间画布发生变化不会误写", async () => {
    let count = 0;
    const mock = http.createServer((req, res) => { req.resume(); req.on("end", () => { count++; const plan = count === 1 ? { tool: "board_storyboard_update", args: { nodeRef: "n1", revision: 1, patch: { prompt: "新画面" } }, say: "准备修改。" } : { tool: "reply", args: { text: "操作结束" } }; res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(plan) } }] })); }); });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve)); cleanups.push(() => new Promise<void>((resolve) => mock.close(() => resolve())));
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-project-confirm-")); const { app, context } = createApp({ dataDir }); cleanups.push(async () => { context.db.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
    await request(app).post("/api/channels").send({ name: "brain", baseUrl: `http://127.0.0.1:${(mock.address() as AddressInfo).port}`, adapterType: "openai-chat", authType: "none", authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions", models: ["brain-model"], allowPrivateNetwork: true, enabled: true }).expect(201);
    const board = (await request(app).post("/api/boards").send({ title: "分镜确认" }).expect(201)).body.data;
    const project = storyboardProjectDataSchema.parse({ name: "剧本", characters: [], scenes: [], shots: [{ id: "s1", prompt: "旧画面" }] });
    context.db.createStoryboardProject("p1", board.threadId, project);
    const at = new Date().toISOString(); const node: BoardNode = { id: "node-image", ref: "n1", type: "image", x: 0, y: 0, width: 280, height: 210, title: "图片", createdAt: at, updatedAt: at, assetId: null, source: "upload", status: "empty", storyboard: { projectId: "p1", shotId: "s1", role: "image" } };
    const saved = (await request(app).put(`/api/boards/${board.id}`).send({ doc: { version: 1, nextRef: 2, nodes: [node], edges: [] }, baseVersion: 1 }).expect(200)).body.data;
    await request(app).post(`/api/conversations/${board.threadId}/messages`).send({ text: "修改第 1 镜的分镜项目" }).expect(202);
    let view: any; for (let i = 0; i < 80; i++) { await new Promise((resolve) => setTimeout(resolve, 50)); view = (await request(app).get(`/api/conversations/${board.threadId}`).expect(200)).body.data; if (view.status === "awaiting_confirmation") break; }
    const confirmation = view.messages.find((item: any) => item.confirm?.reason === "board_project_update");
    expect(confirmation.confirm.message).toContain("当前画布不会自动改变");
    expect(context.db.getStoryboardProject("p1")!.data.shots[0]!.prompt).toBe("旧画面");
    node.title = "画布已变化";
    await request(app).put(`/api/boards/${board.id}`).send({ doc: { ...saved.doc, nodes: [node] }, baseVersion: saved.version }).expect(200);
    await request(app).post(`/api/conversations/${board.threadId}/confirm`).send({ messageId: confirmation.id, decision: "approve" }).expect(200);
    for (let i = 0; i < 80; i++) { await new Promise((resolve) => setTimeout(resolve, 50)); view = (await request(app).get(`/api/conversations/${board.threadId}`).expect(200)).body.data; if (view.messages.some((item: any) => item.toolResult?.error === "BOARD_VERSION_CONFLICT")) break; }
    expect(view.messages.some((item: any) => item.toolResult?.error === "BOARD_VERSION_CONFLICT")).toBe(true);
    expect(context.db.getStoryboardProject("p1")!.data.shots[0]!.prompt).toBe("旧画面");
  });

  it("批量生成先显示全部任务并确认，再逐项汇报结果", async () => {
    let chatCount = 0; let imageCount = 0;
    const mock = http.createServer((req, res) => { req.resume(); req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.includes("/images/")) { imageCount++; res.end(JSON.stringify({ data: [{ b64_json: pngBase64 }] })); return; }
      chatCount++; const plan = chatCount === 1 ? { tool: "board_generate_batch", args: { nodeRefs: ["n1", "n2"] }, say: "准备批量生成。" } : { tool: "reply", args: { text: "已处理。" } };
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(plan) } }] }));
    }); });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve)); cleanups.push(() => new Promise<void>((resolve) => mock.close(() => resolve())));
    const base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "board-batch-confirm-")); const { app, context } = createApp({ dataDir }); cleanups.push(async () => { context.db.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
    for (const [name, adapterType, model, endpoint] of [["brain", "openai-chat", "brain-model", "/v1/chat/completions"], ["image", "openai-images", "image-model", "/v1/images/generations"]]) await request(app).post("/api/channels").send({ name, baseUrl: base, adapterType, authType: "none", authHeaderName: "", secretEnv: "", endpoint, models: [model], allowPrivateNetwork: true, enabled: true }).expect(201);
    const board = (await request(app).post("/api/boards").send({ title: "批量" }).expect(201)).body.data; const at = new Date().toISOString();
    const nodes: BoardNode[] = [1, 2].map((number) => ({ id: `node-${number}`, ref: `n${number}`, type: "image", x: number * 300, y: 0, width: 280, height: 210, title: `图片${number}`, createdAt: at, updatedAt: at, assetId: null, source: "upload", status: "empty", prompt: `图片${number}` }));
    await request(app).put(`/api/boards/${board.id}`).send({ doc: { version: 1, nextRef: 3, nodes, edges: [] }, baseVersion: 1 }).expect(200);
    await request(app).post(`/api/conversations/${board.threadId}/messages`).send({ text: "批量生成两个节点" }).expect(202);
    let view: any; for (let i = 0; i < 80; i++) { await new Promise((resolve) => setTimeout(resolve, 50)); view = (await request(app).get(`/api/conversations/${board.threadId}`).expect(200)).body.data; if (view.status === "awaiting_confirmation") break; }
    const confirmation = view.messages.find((item: any) => item.confirm?.reason === "board_generation");
    expect(confirmation.confirm.message).toContain("2 个生成任务"); expect(imageCount).toBe(0);
    await request(app).post(`/api/conversations/${board.threadId}/confirm`).send({ messageId: confirmation.id, decision: "approve" }).expect(200);
    for (let i = 0; i < 100; i++) { await new Promise((resolve) => setTimeout(resolve, 50)); view = (await request(app).get(`/api/conversations/${board.threadId}`).expect(200)).body.data; if (view.messages.some((item: any) => item.toolName === "board_generate_batch" && item.toolResult?.summary?.includes("n2：已完成"))) break; }
    expect(imageCount).toBe(2);
    expect(view.messages.some((item: any) => item.toolName === "board_generate_batch" && item.toolResult?.summary?.includes("n1：已完成") && item.toolResult?.summary?.includes("n2：已完成"))).toBe(true);
  });

  it("用户选中的图片节点会作为缩略图附给无限画布大脑", async () => {
    const chatBodies: string[] = [];
    const mock = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        chatBodies.push(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: JSON.stringify({ tool: "reply", args: { text: "看到了" }, say: "看到了。" }) } }],
        }));
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => mock.close(() => resolve())));
    const base = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-board-vision-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(async () => {
      context.db.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    await request(app).post("/api/channels").send({
      name: "Vision brain", baseUrl: base, adapterType: "openai-chat", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
      models: ["vision-brain"], allowPrivateNetwork: true, enabled: true,
    }).expect(201);

    const board = (await request(app).post("/api/boards").send({ title: "看图测试" }).expect(201)).body.data;
    const uploaded = await request(app)
      .post(`/api/boards/${board.id}/assets`)
      .attach("file", Buffer.from(pngBase64, "base64"), { filename: "cat.png", contentType: "image/png" })
      .expect(201);
    const assetId = uploaded.body.data.id as string;
    const at = new Date().toISOString();
    const image: BoardNode = {
      id: "node-image", ref: "n1", type: "image", x: 100, y: 100, width: 280, height: 210,
      title: "猫", createdAt: at, updatedAt: at, assetId, source: "upload", status: "succeeded",
    };
    const doc: BoardDoc = { version: 1, nextRef: 2, nodes: [image], edges: [] };
    await request(app).put(`/api/boards/${board.id}`).send({ doc, baseVersion: 1 }).expect(200);
    await request(app).put(`/api/boards/${board.id}/selection`).send({ selection: [image.id] }).expect(200);

    await request(app).post(`/api/conversations/${board.threadId}/messages`)
      .send({ text: "看看这张图里是什么" }).expect(202);
    for (let attempt = 0; attempt < 80 && !chatBodies.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).toContain("image_url");
    expect(chatBodies[0]).toContain("data:image/");
    expect(chatBodies[0]).toContain("n1「猫」");
  });
});
