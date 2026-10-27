import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { createBoard } from "../src/server/board";
import { createBoardFromTemplate, importTemplateIntoBoard } from "../src/server/canvas-template";
import { runAgentTool, type ToolContext } from "../src/server/agent-tools";
import { buildCapabilityAliases } from "../src/server/capabilities";
import type { CanvasTemplateInput } from "../src/shared/canvas-template";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function tempApp() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-template-"));
  const created = createApp({ dataDir });
  cleanups.push(async () => {
    created.context.db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return created;
}

function addChatChannel(db: AppContext["db"]) {
  return db.saveChannel({
    name: "Mock brain",
    baseUrl: "http://127.0.0.1:9",
    adapterType: "openai-chat",
    authType: "none",
    authHeaderName: "",
    secretEnv: "",
    endpoint: "",
    models: ["mock-chat"],
    allowPrivateNetwork: true,
    enabled: true,
  });
}

function contextFor(context: AppContext, conversationId: string): ToolContext {
  const conversation = context.db.getConversation(conversationId);
  if (!conversation) throw new Error("conversation missing");
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

const genericTemplate: CanvasTemplateInput = {
  name: "提示词链",
  description: "一个文本 + 一个生图配置",
  nodes: [
    { tempId: "t", type: "text", x: 0, y: 0, text: "雨夜巷口" },
    {
      tempId: "c", type: "config", x: 380, y: 0,
      config: { mode: "image", prompt: "电影感", useUpstreamText: true, count: 1 },
    },
  ],
  edges: [{ from: "t", to: "c", kind: "input", role: "text" }],
  groups: [{ title: "一组", nodeIds: ["t", "c"] }],
};

describe("无限画布模板", () => {
  it("对话工具生成模板，导入已有画布时重排 id / ref 并保留分组", async () => {
    const { context } = await tempApp();
    addChatChannel(context.db);
    const conversation = context.db.createConversation({
      title: "模板测试", brainChannelId: "brain", brainModel: "mock-chat",
      videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
    });
    const ctx = contextFor(context, conversation.id);

    const created = await runAgentTool("create_canvas_template", genericTemplate as unknown as Record<string, unknown>, ctx);
    expect(created.result.ok).toBe(true);
    const templateId = created.result.data?.templateId as string;
    expect(templateId).toBeTruthy();
    const template = context.db.getCanvasTemplate(templateId)!;
    expect(template.doc.nodes).toHaveLength(2);
    expect(template.doc.groups).toHaveLength(1);

    const board = createBoard(context.db, { title: "目标板" });
    const imported = importTemplateIntoBoard(context.db, board.id, templateId);
    expect(imported.addedNodes).toBe(2);
    const doc = imported.board.doc;
    expect(doc.nodes.map((node) => node.ref).sort()).toEqual(["n1", "n2"]);
    expect(doc.edges).toHaveLength(1);
    expect(doc.groups).toHaveLength(1);
    expect(doc.nodes.find((node) => node.type === "config")).toMatchObject({
      mode: "image", prompt: "电影感", useUpstreamText: true, status: "idle",
    });

    // 同一份模板再导入一次，引用继续往后排，不覆盖已有节点
    const again = importTemplateIntoBoard(context.db, board.id, templateId);
    expect(again.board.doc.nodes).toHaveLength(4);
    expect(again.board.doc.nodes.map((node) => node.ref).sort()).toEqual(["n1", "n2", "n3", "n4"]);
    expect(again.board.doc.groups).toHaveLength(2);
  });

  it("可以从模板新建一块无限画布", async () => {
    const { context } = await tempApp();
    addChatChannel(context.db);
    const conversation = context.db.createConversation({
      title: "模板来源", brainChannelId: "brain", brainModel: "mock-chat",
      videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
    });
    const created = await runAgentTool("create_canvas_template", genericTemplate as unknown as Record<string, unknown>, contextFor(context, conversation.id));
    const templateId = created.result.data?.templateId as string;

    const board = createBoardFromTemplate(context.db, templateId, "模板新板");
    expect(board.title).toBe("模板新板");
    expect(board.doc.nodes).toHaveLength(2);
    expect(board.doc.edges).toHaveLength(1);
    expect(board.version).toBe(2);
  });

  it("模板可以带视频 / 音频空占位", async () => {
    const { context } = await tempApp();
    addChatChannel(context.db);
    const conversation = context.db.createConversation({
      title: "音视频占位", brainChannelId: "brain", brainModel: "mock-chat",
      videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
    });
    const input: CanvasTemplateInput = {
      name: "音视频模板",
      nodes: [
        { tempId: "t", type: "text", x: 0, y: 0, text: "一段雨夜" },
        { tempId: "v", type: "video", x: 380, y: 0, title: "视频占位" },
        { tempId: "a", type: "audio", x: 740, y: 0, title: "音频占位" },
      ],
    };
    const created = await runAgentTool("create_canvas_template", input as unknown as Record<string, unknown>, contextFor(context, conversation.id));
    const templateId = created.result.data?.templateId as string;
    const board = createBoard(context.db, { title: "占位板" });
    const imported = importTemplateIntoBoard(context.db, board.id, templateId);
    expect(imported.board.doc.nodes.map((node) => node.type).sort()).toEqual(["audio", "text", "video"]);
    expect(imported.board.doc.nodes.filter((node) => node.type === "video" || node.type === "audio"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "video", assetId: null, status: "empty" }),
        expect.objectContaining({ type: "audio", assetId: null, status: "empty" }),
      ]));
  });

  it("模板库支持重命名和删除", async () => {
    const { app, context } = await tempApp();
    addChatChannel(context.db);
    const conversation = context.db.createConversation({
      title: "模板管理", brainChannelId: "brain", brainModel: "mock-chat",
      videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
    });
    const created = await runAgentTool("create_canvas_template", genericTemplate as unknown as Record<string, unknown>, contextFor(context, conversation.id));
    const templateId = created.result.data?.templateId as string;

    const renamed = await request(app).patch(`/api/templates/${templateId}`).send({ name: "改名后的模板" }).expect(200);
    expect(renamed.body.data.name).toBe("改名后的模板");
    const list = await request(app).get("/api/templates").expect(200);
    expect(list.body.data[0].name).toBe("改名后的模板");

    await request(app).delete(`/api/templates/${templateId}`).expect(200);
    await request(app).get(`/api/templates/${templateId}`).expect(404);
    expect(context.db.listCanvasTemplateSummaries()).toHaveLength(0);
  });

  it("新的分镜模板工具直接生成角色 / 场景参考，不写旧分镜表", async () => {
    const { context } = await tempApp();
    addChatChannel(context.db);
    const conversation = context.db.createConversation({
      title: "新分镜模板", brainChannelId: "brain", brainModel: "mock-chat",
      videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
    });
    const result = await runAgentTool("create_storyboard_template", {
      title: "雨夜短剧",
      characters: [{ name: "林昭", prompt: "三十岁，黑色风衣" }],
      scenes: [{ name: "巷口", prompt: "雨夜，霓虹灯" }],
      shots: [
        { prompt: "林昭站在雨夜巷口，霓虹倒映在积水里", character: "林昭", scene: "巷口" },
        { prompt: "林昭推开面馆玻璃门，暖黄灯光", character: "林昭", scene: "巷口" },
      ],
    }, contextFor(context, conversation.id));
    expect(result.result.ok).toBe(true);
    const templateId = result.result.data?.templateId as string;
    const template = context.db.getCanvasTemplate(templateId)!;
    expect(template.source).toBe("storyboard");
    expect(template.doc.nodes).toHaveLength(6); // 角色 + 场景 + 2 镜 ×（文本 + 配置）
    expect(template.doc.nodes.some((node) => node.type === "image" && node.title === "角色 · 林昭")).toBe(true);
    expect(template.doc.nodes.some((node) => node.type === "image" && node.title === "场景 · 巷口")).toBe(true);
    expect(template.doc.edges.filter((edge) => edge.role === "reference")).toHaveLength(4);
    expect(template.doc.groups?.map((group) => group.title).sort()).toEqual(["场景 · 巷口", "场景设定", "角色设定"]);
    // 新流程不写 conversation_shots
    expect(context.db.listStoryboardShots(conversation.id)).toHaveLength(0);
  });

  it("迁移旧分镜：生成模板和画布，重复调用跳过", async () => {
    const { app, context } = await tempApp();
    addChatChannel(context.db);
    const conversation = context.db.createConversation({
      title: "旧分镜迁移", brainChannelId: "brain", brainModel: "mock-chat",
      videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
    });
    // 旧分镜 API 已删除；这里直接写库，模拟历史会话里还留着的分镜数据
    context.db.replaceStoryboard(conversation.id, [
      { sourceText: "", prompt: "雨夜巷口，霓虹倒映在积水里", kind: "image", aspectRatio: "16:9", scene: "巷口" },
      { sourceText: "", prompt: "面馆内景，暖黄灯光", kind: "image", aspectRatio: "16:9", scene: "面馆" },
    ]);

    const first = await request(app).post("/api/templates/migrate-storyboards").expect(200);
    expect(first.body.data.migrated).toHaveLength(1);
    const migration = first.body.data.migrated[0];
    // 2 个场景设定占位 + 2 镜 ×（文本 + 配置）
    expect(migration.nodeCount).toBe(6);
    const board = context.db.getBoardRecord(migration.boardId)!;
    expect(board.title).toBe("分镜 · 旧分镜迁移");
    expect(board.doc.nodes).toHaveLength(6);
    expect(context.db.getStoryboardMigration(conversation.id)?.boardId).toBe(migration.boardId);

    expect(board.doc.nodes.some((node) => node.type === "image" && node.title === "场景 · 巷口")).toBe(true);
    expect(board.doc.edges.filter((edge) => edge.role === "reference")).toHaveLength(2);

    const second = await request(app).post("/api/templates/migrate-storyboards").expect(200);
    expect(second.body.data.migrated).toHaveLength(0);
    expect(second.body.data.skipped).toBe(1);

    const cleaned = await request(app).post("/api/templates/cleanup-storyboards").expect(200);
    expect(cleaned.body.data.cleaned).toEqual([conversation.id]);
    expect(context.db.listStoryboardShots(conversation.id)).toHaveLength(0);
    expect(context.db.listStoryboardCharacters(conversation.id)).toHaveLength(0);
    // 模板和迁移画布不跟着旧分镜一起删
    expect(context.db.getBoardRecord(migration.boardId)).not.toBeNull();
    expect(context.db.getCanvasTemplate(migration.templateId)).not.toBeNull();
  });

  it("模板接口：新建板、导入已有板、列表与详情", async () => {
    const { app, context } = await tempApp();
    addChatChannel(context.db);
    const conversation = context.db.createConversation({
      title: "模板接口", brainChannelId: "brain", brainModel: "mock-chat",
      videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
    });
    const created = await runAgentTool("create_canvas_template", genericTemplate as unknown as Record<string, unknown>, contextFor(context, conversation.id));
    const templateId = created.result.data?.templateId as string;

    const list = await request(app).get("/api/templates").expect(200);
    expect(list.body.data[0]).toMatchObject({ id: templateId, nodeCount: 2, groupCount: 1 });
    const detail = await request(app).get(`/api/templates/${templateId}`).expect(200);
    expect(detail.body.data.doc.nodes).toHaveLength(2);

    const fromTemplate = await request(app)
      .post("/api/boards/from-template")
      .send({ templateId, title: "从模板新建" })
      .expect(201);
    expect(fromTemplate.body.data.title).toBe("从模板新建");
    expect(fromTemplate.body.data.doc.nodes).toHaveLength(2);

    const existing = (await request(app).post("/api/boards").send({ title: "已有板" }).expect(201)).body.data;
    const imported = await request(app)
      .post(`/api/boards/${existing.id}/templates`)
      .send({ templateId })
      .expect(200);
    expect(imported.body.data.addedNodes).toBe(2);
    expect(imported.body.data.board.doc.nodes).toHaveLength(2);
  });
});
