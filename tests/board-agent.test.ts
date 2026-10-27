import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { createBoard } from "../src/server/board";
import { describeBoard, previewBoardOps } from "../src/server/board-agent";
import { runAgentTool, type ToolContext } from "../src/server/agent-tools";
import { buildBoardSystemPrompt } from "../src/server/agent-prompt";
import { buildCapabilityAliases } from "../src/server/capabilities";
import type { AppContext } from "../src/server/app";
import { applyBoardDeltaToDoc, type BoardDoc } from "../src/shared/board";
import type { AgentStreamEvent } from "../src/shared/agent-types";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function tempApp() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-board-agent-"));
  const created = createApp({ dataDir });
  cleanups.push(async () => {
    created.context.db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return created;
}

function addChannel(db: AppContext["db"], input: {
  name: string;
  baseUrl: string;
  adapterType: string;
  models: string[];
}) {
  return db.saveChannel({
    name: input.name,
    baseUrl: input.baseUrl,
    adapterType: input.adapterType as never,
    authType: "none",
    authHeaderName: "",
    secretEnv: "",
    endpoint: "",
    models: input.models,
    allowPrivateNetwork: true,
    enabled: true,
  });
}

async function mockImageServer() {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ b64_json: pngBase64 }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${port}`;
}

function toolContext(context: AppContext, threadId: string): ToolContext {
  const conversation = context.db.getConversation(threadId);
  if (!conversation) throw new Error("board thread missing");
  return {
    db: context.db,
    runner: context.runner,
    sessionKeys: context.sessionKeys,
    conversation,
    aliases: buildCapabilityAliases(context.db.listChannels()),
    defaultAliases: {},
    verbatimPrompt: null,
    turnAttachmentIds: [],
    emit: () => undefined,
  };
}

describe("无限画布 Agent 工具", () => {
  it("board_apply 一次建节点 + 连线，返回 tempId 到真实 ref 的映射", async () => {
    const { context } = await tempApp();
    addChannel(context.db, { name: "brain", baseUrl: "http://127.0.0.1:9", adapterType: "openai-chat", models: ["test-chat"] });
    const board = createBoard(context.db, { title: "Agent 测试" });
    const before = context.db.getBoardRecord(board.id)!.doc;
    const events: AgentStreamEvent[] = [];
    const ctx = { ...toolContext(context, board.threadId), emit: (event: AgentStreamEvent) => events.push(event) };

    const result = await runAgentTool("board_apply", {
      ops: [
        { op: "add_node", tempId: "t", type: "text", x: 100, y: 100, text: "雨夜巷口" },
        { op: "add_node", tempId: "c", type: "config", x: 500, y: 100, config: { mode: "image", count: 1 } },
        { op: "connect", from: "t", to: "c", kind: "input", role: "text" },
      ],
    }, ctx);

    expect(result.result.ok).toBe(true);
    expect(result.result.summary).toContain("n1");
    expect(result.result.summary).toContain("n2");
    const stored = context.db.getBoardRecord(board.id)!;
    expect(stored.doc.nodes).toHaveLength(2);
    expect(stored.doc.edges).toHaveLength(1);
    expect(stored.doc.edges[0]).toMatchObject({ kind: "input", role: "text" });

    // SSE 里带的是增量，客户端合并后必须和服务端文档完全一致
    const event = events.find((item) => item.type === "board");
    expect(event?.type).toBe("board");
    if (event?.type !== "board" || !event.delta) throw new Error("board delta missing");
    expect(event.delta).toMatchObject({ baseVersion: 1, version: 2, nextRef: 3 });
    const merged: BoardDoc = applyBoardDeltaToDoc(before, event.delta);
    expect(merged).toEqual(stored.doc);
  });

  it("非法 op 整批回滚，不留下节点", async () => {
    const { context } = await tempApp();
    addChannel(context.db, { name: "brain", baseUrl: "http://127.0.0.1:9", adapterType: "openai-chat", models: ["test-chat"] });
    const board = createBoard(context.db, { title: "回滚测试" });
    const ctx = toolContext(context, board.threadId);
    const before = context.db.getBoardRecord(board.id)!;

    const result = await runAgentTool("board_apply", {
      ops: [
        { op: "add_node", tempId: "t", type: "text", x: 10, y: 10, text: "a" },
        { op: "connect", from: "t", to: "n99", kind: "input" },
      ],
    }, ctx);

    expect(result.result.ok).toBe(false);
    expect(result.result.summary).toContain("第 2 条");
    const after = context.db.getBoardRecord(board.id)!;
    expect(after.version).toBe(before.version);
    expect(after.doc.nodes).toHaveLength(0);
  });

  it("board_read 能看到节点、上游数量和坐标", async () => {
    const { context } = await tempApp();
    addChannel(context.db, { name: "brain", baseUrl: "http://127.0.0.1:9", adapterType: "openai-chat", models: ["test-chat"] });
    const board = createBoard(context.db, { title: "读取测试" });
    const ctx = toolContext(context, board.threadId);
    await runAgentTool("board_apply", {
      ops: [
        { op: "add_node", tempId: "t", type: "text", x: 10, y: 10, text: "雨夜巷口" },
        { op: "add_node", tempId: "c", type: "config", x: 400, y: 10 },
        { op: "connect", from: "t", to: "c", kind: "input", role: "text" },
      ],
    }, ctx);

    const read = await runAgentTool("board_read", { scope: "all" }, ctx);
    expect(read.result.ok).toBe(true);
    expect(read.result.summary).toContain("n1 文本");
    expect(read.result.summary).toContain("n2 配置");
    expect(read.result.summary).toContain("上游 1 段文本");
    expect(read.result.summary).toContain("n1 -> n2（文本）");
  });

  it("board_generate 在配置节点上提交任务，返回结果节点 ref", async () => {
    const { context } = await tempApp();
    const baseUrl = await mockImageServer();
    addChannel(context.db, { name: "brain", baseUrl: "http://127.0.0.1:9", adapterType: "openai-chat", models: ["test-chat"] });
    addChannel(context.db, { name: "image", baseUrl, adapterType: "openai-images", models: ["mock-image"] });
    const board = createBoard(context.db, { title: "生成测试" });
    const ctx = toolContext(context, board.threadId);
    await runAgentTool("board_apply", {
      ops: [
        { op: "add_node", tempId: "t", type: "text", x: 10, y: 10, text: "雨夜巷口" },
        { op: "add_node", tempId: "c", type: "config", x: 400, y: 10, config: { mode: "image", count: 1, model: "mock-image" } },
        { op: "connect", from: "t", to: "c", kind: "input", role: "text" },
      ],
    }, ctx);

    const generated = await runAgentTool("board_generate", { nodeRef: "n2" }, ctx);
    expect(generated.result.ok).toBe(true);
    expect(generated.result.summary).toContain("已提交");
    expect(generated.result.summary).toContain("n3");
    expect(generated.result.taskId).toBeTruthy();
    const stored = context.db.getBoardRecord(board.id)!;
    expect(stored.doc.nodes.filter((node) => node.type === "image")).toHaveLength(1);
    expect(context.db.listBoardTasksByTask(generated.result.taskId!)).toHaveLength(1);
  });

  it("对话线程不能调用无限画布工具", async () => {
    const { context } = await tempApp();
    addChannel(context.db, { name: "brain", baseUrl: "http://127.0.0.1:9", adapterType: "openai-chat", models: ["test-chat"] });
    const chat = context.db.createConversation({
      title: "普通对话", brainChannelId: "brain", brainModel: "test-chat",
      videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
    });
    const ctx: ToolContext = {
      db: context.db, runner: context.runner, sessionKeys: context.sessionKeys,
      conversation: chat, aliases: buildCapabilityAliases(context.db.listChannels()),
      defaultAliases: {}, verbatimPrompt: null, turnAttachmentIds: [], emit: () => undefined,
    };
    const result = await runAgentTool("board_read", { scope: "all" }, ctx);
    expect(result.result.ok).toBe(false);
    expect(result.result.summary).toContain("无限画布线程");
  });

  it("删除有内容的节点或一次删三个以上时，确认卡判定为需要确认", async () => {
    const { context } = await tempApp();
    addChannel(context.db, { name: "brain", baseUrl: "http://127.0.0.1:9", adapterType: "openai-chat", models: ["test-chat"] });
    const board = createBoard(context.db, { title: "确认测试" });
    const ctx = toolContext(context, board.threadId);
    await runAgentTool("board_apply", {
      ops: [
        { op: "add_node", tempId: "a", type: "text", x: 10, y: 10, text: "a" },
        { op: "add_node", tempId: "b", type: "text", x: 320, y: 10, text: "b" },
        { op: "add_node", tempId: "c", type: "text", x: 640, y: 10, text: "c" },
      ],
    }, ctx);

    expect(previewBoardOps(context.db, board.id, [{ op: "delete_node", nodeRef: "n1" }]).needsConfirm).toBe(false);
    expect(previewBoardOps(context.db, board.id, [
      { op: "delete_node", nodeRef: "n1" },
      { op: "delete_node", nodeRef: "n2" },
      { op: "delete_node", nodeRef: "n3" },
    ]).needsConfirm).toBe(true);
  });

  it("系统提示词和 board_read 共用同一份无限画布描述", async () => {
    const { context } = await tempApp();
    addChannel(context.db, { name: "brain", baseUrl: "http://127.0.0.1:9", adapterType: "openai-chat", models: ["test-chat"] });
    const board = createBoard(context.db, { title: "上下文测试" });
    const ctx = toolContext(context, board.threadId);
    await runAgentTool("board_apply", {
      ops: [
        { op: "add_node", tempId: "t", type: "text", x: 10, y: 10, text: "雨夜巷口" },
        { op: "add_node", tempId: "c", type: "config", x: 400, y: 10 },
        { op: "connect", from: "t", to: "c", kind: "input", role: "text" },
      ],
    }, ctx);
    const record = context.db.getBoardRecord(board.id)!;
    const description = describeBoard(record, { scope: "all" });
    const prompt = buildBoardSystemPrompt("- mock-image", description);
    expect(prompt).toContain("无限画布助手");
    expect(prompt).toContain(description);
    expect(prompt).not.toContain("分镜表");
  });
});
