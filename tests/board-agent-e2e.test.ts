import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import type { BoardDoc, BoardNode } from "../src/shared/board";

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
