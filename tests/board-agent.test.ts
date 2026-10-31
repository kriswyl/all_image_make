import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { createBoard } from "../src/server/board";
import { claimBoardFrame, completeBoardFrame } from "../src/server/board-frame-broker";
import { storyboardProjectDataSchema } from "../src/shared/storyboard-project";
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
  it("检查生成条件并仅搜索公共素材，替换节点需确认且不能绑定对话私有素材", async () => {
    const { context } = await tempApp();
    addChannel(context.db, { name: "brain", baseUrl: "http://127.0.0.1:9", adapterType: "openai-chat", models: ["test-chat"] });
    const board = createBoard(context.db, { title: "预检与素材" }); const ctx = toolContext(context, board.threadId);
    await runAgentTool("board_apply", { ops: [{ op: "add_node", tempId: "image", type: "image", x: 0, y: 0, text: "雨夜" }] }, ctx);
    const check = await runAgentTool("board_check", { nodeRefs: ["n1"] }, ctx);
    expect(check.result.summary).toContain("没有可用的对应模型");
    context.db.createTask({ id: "public-task", channelId: "", model: "", prompt: "公共猫", input: {}, libraryScope: "public", status: "succeeded" });
    context.db.createTask({ id: "private-task", channelId: "", model: "", prompt: "私人猫", input: {}, libraryScope: "conversation", status: "succeeded" });
    for (const [id, taskId] of [["public-image", "public-task"], ["private-image", "private-task"]]) context.db.insertAsset({ id, taskId, fileName: `${id}.png`, mimeType: "image/png", byteSize: 1, relativePath: `${id}.png`, baseDir: context.db.assetsDir, sha256: "x", thumbPath: "" });
    const assets = await runAgentTool("board_assets", { query: "猫", kind: "image" }, ctx);
    expect(assets.result.summary).toContain("public-image"); expect(assets.result.summary).not.toContain("private-image");
    const denied = await runAgentTool("board_apply", { ops: [{ op: "set_asset", nodeRef: "n1", assetId: "private-image" }] }, ctx);
    expect(denied.result.ok).toBe(false);
    const applied = await runAgentTool("board_apply", { ops: [{ op: "set_asset", nodeRef: "n1", assetId: "public-image" }] }, ctx);
    expect(applied.result.ok).toBe(true);
    expect(context.db.getBoardRecord(board.id)!.doc.nodes[0]).toMatchObject({ assetId: "public-image", status: "succeeded" });
    expect(previewBoardOps(context.db, board.id, [{ op: "set_asset", nodeRef: "n1", assetId: "another" }]).needsConfirm).toBe(true);
    const stale = await runAgentTool("board_apply", { expectedBoardVersion: 1, ops: [{ op: "set_asset", nodeRef: "n1", assetId: "public-image" }] }, ctx);
    expect(stale.result.error).toBe("BOARD_VERSION_CONFLICT");
  });

  it("画布助手读取和更新关联分镜，不覆盖画布快照并拒绝过期版本", async () => {
    const { context } = await tempApp();
    addChannel(context.db, { name: "brain", baseUrl: "http://127.0.0.1:9", adapterType: "openai-chat", models: ["test-chat"] });
    const board = createBoard(context.db, { title: "关联分镜" });
    const data = storyboardProjectDataSchema.parse({ name: "剧本", characters: [], scenes: [], shots: [{ id: "shot-1", prompt: "原画面" }] });
    context.db.createStoryboardProject("project-1", board.threadId, data);
    const record = context.db.getBoardRecord(board.id)!; const at = new Date().toISOString();
    const doc = { ...record.doc, nextRef: 2, nodes: [{ id: "node-1", ref: "n1", type: "image" as const, x: 0, y: 0, width: 280, height: 210, title: "第 1 镜", storyboard: { projectId: "project-1", shotId: "shot-1", role: "image" as const }, createdAt: at, updatedAt: at, assetId: null, source: "upload" as const, status: "empty" as const }] };
    context.db.saveBoardSnapshot({ boardId: board.id, previousDoc: record.doc, doc, version: record.version + 1, reason: "test" });
    const ctx = toolContext(context, board.threadId);
    const read = await runAgentTool("board_storyboard", { nodeRefs: ["n1"] }, ctx);
    expect(read.result.summary).toContain("原画面"); expect(read.result.summary).toContain("独立");
    const updated = await runAgentTool("board_storyboard_update", { nodeRef: "n1", revision: 1, patch: { prompt: "新画面" } }, ctx);
    expect(updated.result.ok).toBe(true); expect(context.db.getStoryboardProject("project-1")!.data.shots[0]!.prompt).toBe("新画面");
    expect(context.db.getBoardRecord(board.id)!.doc.nodes[0]).not.toHaveProperty("prompt", "新画面");
    const stale = await runAgentTool("board_storyboard_update", { nodeRef: "n1", revision: 1, patch: { prompt: "覆盖" } }, ctx);
    expect(stale.result.error).toBe("STORYBOARD_CONFLICT");
  });

  it("尾帧工具通过桌面请求创建图片并连接首帧", async () => {
    const { context } = await tempApp();
    addChannel(context.db, { name: "brain", baseUrl: "http://127.0.0.1:9", adapterType: "openai-chat", models: ["test-chat"] });
    const board = createBoard(context.db, { title: "尾帧" }); const ctx = toolContext(context, board.threadId);
    context.db.createTask({ id: "video-task", channelId: "", model: "", prompt: "视频", input: {}, libraryScope: "public", status: "succeeded" });
    context.db.insertAsset({ id: "video-asset", taskId: "video-task", fileName: "clip.mp4", mimeType: "video/mp4", byteSize: 1, relativePath: "clip.mp4", baseDir: context.db.assetsDir, sha256: "x", thumbPath: "" });
    context.db.insertBoardAssetLink(board.id, "video-asset", "pending:video");
    await runAgentTool("board_apply", { ops: [{ op: "add_node", tempId: "v", type: "video", x: 0, y: 0, assetRef: "video-asset" }, { op: "add_node", tempId: "next", type: "video", x: 800, y: 0 }] }, ctx);
    const frameCtx = { ...ctx, emit: (event: AgentStreamEvent) => { if (event.type !== "board_frame_request") return;
      context.db.createTask({ id: "frame-task", channelId: "", model: "", prompt: "尾帧", input: {}, libraryScope: "public", status: "succeeded" });
      context.db.insertAsset({ id: "frame-asset", taskId: "frame-task", fileName: "frame.png", mimeType: "image/png", byteSize: 1, relativePath: "frame.png", baseDir: context.db.assetsDir, sha256: "x", thumbPath: "" });
      context.db.insertBoardAssetLink(board.id, "frame-asset", "pending:frame");
      expect(claimBoardFrame(board.id, event.requestId)).toBe(true);
      expect(claimBoardFrame(board.id, event.requestId)).toBe(false);
      expect(completeBoardFrame(board.id, event.requestId, { assetId: "frame-asset" })).toBe(true);
    } };
    const result = await runAgentTool("board_extract_frame", { nodeRef: "n1", targetRef: "n2" }, frameCtx);
    expect(result.result.ok, result.result.summary).toBe(true);
    const doc = context.db.getBoardRecord(board.id)!.doc;
    const frame = doc.nodes.find((node) => node.type === "image" && node.assetId === "frame-asset")!;
    const target = doc.nodes.find((node) => node.ref === "n2")!;
    expect(doc.edges).toContainEqual(expect.objectContaining({ source: frame.id, target: target.id, role: "first-frame" }));
    const again = await runAgentTool("board_extract_frame", { nodeRef: "n1", targetRef: "n2" }, frameCtx);
    expect(again.result.error).toBe("BOARD_FIRST_FRAME_EXISTS");
  });

  it("批量预检通过后逐项提交并汇总完成结果，版本变化时不提交", async () => {
    const { context } = await tempApp(); const base = await mockImageServer();
    addChannel(context.db, { name: "brain", baseUrl: "http://127.0.0.1:9", adapterType: "openai-chat", models: ["test-chat"] });
    addChannel(context.db, { name: "image", baseUrl: base, adapterType: "openai-images", models: ["mock-image"] });
    const board = createBoard(context.db, { title: "批量" }); const events: AgentStreamEvent[] = [];
    const ctx = { ...toolContext(context, board.threadId), emit: (event: AgentStreamEvent) => events.push(event) };
    await runAgentTool("board_apply", { ops: [{ op: "add_node", tempId: "a", type: "image", x: 0, y: 0, text: "猫" }, { op: "add_node", tempId: "b", type: "image", x: 400, y: 0, text: "狗" }] }, ctx);
    const stale = await runAgentTool("board_generate_batch", { nodeRefs: ["n1", "n2"], expectedBoardVersion: 1 }, ctx);
    expect(stale.result.error).toBe("BOARD_VERSION_CONFLICT");
    const version = context.db.getBoardRecord(board.id)!.version;
    const result = await runAgentTool("board_generate_batch", { nodeRefs: ["n1", "n2"], expectedBoardVersion: version }, ctx);
    expect(result.result.ok, result.result.summary).toBe(true);
    expect(result.result.summary).toContain("批量提交 2/2");
    expect(result.result.summary).toContain("n1：已完成"); expect(result.result.summary).toContain("n2：已完成");
    expect(events.some((event) => event.type === "board_batch_progress")).toBe(true);
  });

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

  it("set_style 套用、切换、清除风格，不影响别的节点", async () => {
    const { context } = await tempApp();
    const board = createBoard(context.db, { title: "风格" });
    const ctx = toolContext(context, board.threadId);
    await runAgentTool("board_apply", {
      ops: [
        { op: "add_node", tempId: "a", type: "image", x: 0, y: 0, text: "雨夜街道" },
        { op: "add_node", tempId: "b", type: "image", x: 400, y: 0, text: "清晨早餐铺" },
      ],
    }, ctx);

    const promptOf = (node: (typeof doc.nodes)[number]) => ("prompt" in node ? node.prompt ?? "" : "");
    await runAgentTool("board_apply", { ops: [{ op: "set_style", style: "写实电影感" }] }, ctx);
    let doc = context.db.getBoardRecord(board.id)!.doc;
    expect(promptOf(doc.nodes[0]!)).toContain("35mm");
    expect(promptOf(doc.nodes[1]!)).toContain("35mm");

    // 换风格：上一段要剥掉，不能越拼越长
    await runAgentTool("board_apply", { ops: [{ op: "set_style", style: "黑白纪实" }] }, ctx);
    doc = context.db.getBoardRecord(board.id)!.doc;
    expect(promptOf(doc.nodes[0]!)).not.toContain("35mm");
    expect(promptOf(doc.nodes[0]!)).toContain("黑白摄影");

    // 只清一个节点：另一个保持不动
    await runAgentTool("board_apply", { ops: [{ op: "set_style", style: "黑白纪实", nodeRefs: ["n1"], clear: true }] }, ctx);
    doc = context.db.getBoardRecord(board.id)!.doc;
    expect(promptOf(doc.nodes[0]!)).toBe("雨夜街道");
    expect("styleSuffix" in doc.nodes[0]! ? doc.nodes[0]!.styleSuffix : undefined).toBeUndefined();
    expect(promptOf(doc.nodes[1]!)).toContain("黑白摄影");
  });

  it("arrange 把节点排成一列并归入同名分组", async () => {
    const { context } = await tempApp();
    const board = createBoard(context.db, { title: "排版" });
    const ctx = toolContext(context, board.threadId);
    await runAgentTool("board_apply", {
      ops: [
        { op: "add_node", tempId: "a", type: "image", x: 0, y: 0, width: 280, height: 210 },
        { op: "add_node", tempId: "b", type: "image", x: 900, y: 400, width: 280, height: 200 },
        { op: "arrange", nodeRefs: ["a", "b"], axis: "y", gap: 20, origin: { x: 100, y: 100 }, group: "分镜图" },
      ],
    }, ctx);

    const record = context.db.getBoardRecord(board.id)!;
    expect(record.doc.nodes.map((node) => [node.x, node.y])).toEqual([[100, 100], [100, 330]]);
    expect(record.doc.groups).toHaveLength(1);
    expect(record.doc.groups![0]!.title).toBe("分镜图");
    expect(record.doc.groups![0]!.nodeIds).toHaveLength(2);

    // 同一个节点再并进另一个分组时，必须从旧组里摘掉，否则文档校验会拒绝
    await runAgentTool("board_apply", {
      ops: [{ op: "arrange", nodeRefs: ["n2"], axis: "y", group: "分镜图 B" }],
    }, ctx);
    const merged = context.db.getBoardRecord(board.id)!;
    expect(merged.doc.groups).toHaveLength(2);
    expect(merged.doc.groups!.find((group) => group.title === "分镜图")!.nodeIds).toHaveLength(1);
  });
});
