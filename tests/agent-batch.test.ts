/**
 * 一次画多张：并行提交（需求.md 问题 2）。
 *
 * 三件事必须钉住，因为它们的错法都是「静默烧钱」：
 * 1. 协议层：`{"calls":[…]}` 解析得出来，老的单调用形状**一个字都没变**；
 * 2. 闸门层：卡片上问 N 个、实际提交 M 个是最不能出的错，所以
 *    `resolveBatch` 是确认闸门和执行器共用的同一份；
 * 3. 真跑一遍：4 张图**同时**在飞（不是排队），画布落回计划顺序里最后一个成功的
 *    （不是谁先跑完算谁），超额度时一张卡问清楚、点头之前一个请求都不发。
 */
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { BATCHABLE_TOOLS, parsePlan, resolveBatch } from "../src/server/agent";
import { MAX_BATCH_CALLS, planCalls, type PlannedCall } from "../src/shared/agent-types";
import { createApp } from "../src/server/app";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const image = (prompt: string, extra: Record<string, unknown> = {}): PlannedCall => ({
  tool: "generate_image", args: { prompt, ...extra },
});

describe("parsePlan / calls 形状", () => {
  it("老的单调用形状一个字都没变（落库的 plan_json 要能接着读）", () => {
    const plan = parsePlan('{"tool":"generate_image","args":{"prompt":"猫"},"say":"好"}')!;
    expect(plan.tool).toBe("generate_image");
    expect(plan.args).toEqual({ prompt: "猫" });
    // 关键：单调用时**不能**多出 calls 字段，否则落库形状、卡片渲染全都要跟着改
    expect(plan).not.toHaveProperty("calls");
    expect(planCalls(plan)).toEqual([{ tool: "generate_image", args: { prompt: "猫" } }]);
  });

  it("解析一次多个调用，第一个同时写在 tool/args 上", () => {
    const plan = parsePlan(JSON.stringify({ calls: [image("猫A"), image("猫B")], say: "画两张。" }))!;
    expect(plan.calls).toHaveLength(2);
    expect(plan.say).toBe("画两张。");
    // 老代码（折叠规则、单卡片渲染、确认卡）只看 tool/args，所以它必须是**第一个**
    expect(plan.tool).toBe("generate_image");
    expect(plan.args).toEqual({ prompt: "猫A" });
  });

  it("calls 里只有一条时归一成单调用，不留第二种形状", () => {
    const plan = parsePlan(JSON.stringify({ calls: [image("猫A")], say: "一张。" }))!;
    expect(plan.tool).toBe("generate_image");
    expect(plan).not.toHaveProperty("calls");
  });

  it("calls 里坏的那几条丢掉，不整份作废", () => {
    // 大脑写了 4 条、其中两条不合法，用户要的仍然是画得出来的那两张
    const plan = parsePlan(JSON.stringify({
      calls: [image("猫A"), { args: { prompt: "没写工具名" } }, { tool: "delete_everything", args: {} }, image("猫C")],
    }))!;
    expect(planCalls(plan).map((call) => call.args.prompt)).toEqual(["猫A", "猫C"]);
  });

  it("calls 全坏、又没写 tool 时才算解析失败", () => {
    expect(parsePlan('{"calls":[{"args":{"prompt":"没有工具名"}}],"say":"嗯"}')).toBeNull();
    expect(parsePlan('{"calls":[],"say":"嗯"}')).toBeNull();
    // 多包一层的老毛病对 calls 一样要治好
    expect(parsePlan(JSON.stringify({ plan: { calls: [image("猫A"), image("猫B")] } }))?.calls).toHaveLength(2);
  });

  it("planCalls 对 null / 空计划返回空数组", () => {
    expect(planCalls(null)).toEqual([]);
    expect(planCalls(undefined)).toEqual([]);
  });
});

describe("resolveBatch：卡片上问几个，就只提交几个", () => {
  it("单调用原样放行，不加任何备注", () => {
    const single = [image("猫")];
    expect(resolveBatch(single)).toEqual({ calls: single, note: "" });
  });

  it("产图工具之间可以随便混", () => {
    const mixed: PlannedCall[] = [image("猫"), { tool: "edit_image", args: { prompt: "换成夜景" } }];
    const result = resolveBatch(mixed);
    expect(result.calls).toHaveLength(2);
    expect(result.note).toBe("");
    expect(BATCHABLE_TOOLS).toEqual(["generate_image", "edit_image"]);
  });

  it("混进不能并行的工具时只跑第一个，并说明原因", () => {
    // 生视频一次一个，不能塞进一批里悄悄提交：那样用户根本没机会看确认卡片
    const mixedWithVideo: PlannedCall[] = [image("猫"), { tool: "generate_video", args: { prompt: "动起来" } }];
    const result = resolveBatch(mixedWithVideo);
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0]!.tool).toBe("generate_image");
    expect(result.note).toContain("只执行了第一个");
    // 反过来也一样：视频排第一时，只跑那个视频
    expect(resolveBatch([{ tool: "generate_video", args: {} }, image("猫")]).calls[0]!.tool).toBe("generate_video");
  });

  it("超过硬上限就截断，多出来的如实说没提交", () => {
    const many = Array.from({ length: MAX_BATCH_CALLS + 3 }, (_, index) => image(`第${index + 1}张`));
    const result = resolveBatch(many);
    expect(result.calls).toHaveLength(MAX_BATCH_CALLS);
    expect(result.note).toContain("3");
    // 正好 8 个时不截断、也不加备注
    const exact = many.slice(0, MAX_BATCH_CALLS);
    expect(resolveBatch(exact)).toEqual({ calls: exact, note: "" });
  });
});

/** 假中转站：同时演大脑和生图。返回的是「怎么把这次 e2e 搭起来」用得到的把手 */
async function startMock(plansByCall: unknown[]) {
  const imagePrompts: string[] = [];
  let inflight = 0;
  let maxInflight = 0;
  let chatCalls = 0;

  const mock = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url?.includes("/chat/completions")) {
        const plan = plansByCall[Math.min(chatCalls, plansByCall.length - 1)];
        chatCalls += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(plan) } }] }));
        return;
      }
      const prompt = (JSON.parse(body) as { prompt: string }).prompt;
      imagePrompts.push(prompt);
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      // 故意让「第 1 张」最慢：完成顺序和计划顺序**不一样**，才能验出画布是
      // 按计划顺序落回来的，而不是「谁先跑完算谁」
      const delay = prompt === "第1张" ? 180 : 10;
      setTimeout(() => {
        inflight -= 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: pngBase64 }] }));
      }, delay);
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { mock.close(() => resolve()); }));
  const address = mock.address();
  if (!address || typeof address === "string") throw new Error("mock server did not start");
  const base = `http://127.0.0.1:${address.port}`;

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-batch-"));
  const { app, context } = createApp({ dataDir });
  cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

  const brain = (await request(app).post("/api/channels").send({
    name: "Brain", baseUrl: base, adapterType: "openai-chat", authType: "none",
    authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
    models: ["mock-brain"], allowPrivateNetwork: true, enabled: true,
  }).expect(201)).body.data;
  await request(app).post("/api/channels").send({
    name: "Images", baseUrl: base, adapterType: "openai-images", authType: "none",
    authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations",
    models: ["mock-image"], allowPrivateNetwork: true, enabled: true,
  }).expect(201);

  const conversationId = (await request(app).post("/api/conversations").send({ brainChannelId: brain.id, brainModel: "mock-brain" }).expect(201)).body.data.id as string;

  return {
    app, context, conversationId,
    imagePrompts,
    getMaxInflight: () => maxInflight,
    getChatCalls: () => chatCalls,
  };
}

type ToolRow = {
  id: string;
  role: string; content: string | null; toolName: string | null; toolArgs: Record<string, unknown> | null;
  toolResult: { ok: boolean; assetId?: string } | null; assetId: string | null;
  confirm: { reason: string; count?: number; model: string; message: string } | null;
};
type View = {
  status: string;
  taskCount: number;
  canvasAssetIds: string[];
  messages: ToolRow[];
  sessionImages: Array<{ asset: { id: string }; prompt: string }>;
};

async function settle(app: ReturnType<typeof createApp>["app"], conversationId: string, until: (view: View) => boolean, tries = 120): Promise<View> {
  let view: View = { status: "", taskCount: 0, canvasAssetIds: [], messages: [], sessionImages: [] };
  for (let attempt = 0; attempt < tries; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    view = (await request(app).get(`/api/conversations/${conversationId}`).expect(200)).body.data;
    if (until(view)) break;
  }
  return view;
}

describe("批量并行，端到端", () => {
  it("一次 4 张：真的同时在飞，画布落在计划顺序里最后一个成功的", async () => {
    const mock = await startMock([
      { calls: [image("第1张"), image("第2张"), image("第3张"), image("第4张")], say: "画四张。" },
      { tool: "reply", args: { text: "四张都好了。" }, say: "四张都好了。" },
    ]);

    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "给我四个版本" }).expect(202);
    const view = await settle(mock.app, mock.conversationId, (item) => item.status === "idle" && item.messages.filter((row) => row.role === "tool").length >= 4);

    // 一条表头气泡 + 4 张卡（工具行各自一张），最后是收尾回答
    expect(view.messages.map((row) => row.role)).toEqual(["user", "assistant", "tool", "tool", "tool", "tool", "assistant"]);
    const header = view.messages[1]!;
    // 表头**不能**带 toolName：带了就会被折叠成「第一张卡」，另外三张就没有气泡可挂
    expect(header.toolName).toBeNull();
    expect(header.content).toBe("画四张。");
    expect(view.messages[6]!.content).toBe("四张都好了。");

    // 4 张卡都在，顺序就是计划顺序；每一张都是自己那条提示词
    const cards = view.messages.slice(2, 6);
    expect(cards.map((row) => row.toolArgs?.prompt)).toEqual(["第1张", "第2张", "第3张", "第4张"]);
    expect(cards.every((row) => row.toolResult?.ok === true)).toBe(true);
    expect(new Set(cards.map((row) => row.assetId)).size).toBe(4);

    // 用户要的那件事：4 个请求**同时**在飞，而不是一个一个排队
    expect(mock.getMaxInflight()).toBeGreaterThanOrEqual(2);
    expect(mock.imagePrompts).toHaveLength(4);

    // 下区的顺序 = 计划顺序，画布整组落在**最后一个成功的**那张
    // （第 1 张最慢、最后才回来，所以这条断言真的有区分度：按完成顺序算就会指到第 4 张之外）
    expect(view.sessionImages.map((item) => item.asset.id)).toEqual(cards.map((row) => row.assetId));
    expect(view.canvasAssetIds).toEqual([cards[3]!.assetId]);

    // 4 个任务就是 4 笔额度，自动记上（数的是 messages.task_id）
    expect(view.taskCount).toBe(4);
    // 批量没有确认这一环：一批图片不该被拦，拦了就白等一次
    expect(view.messages.some((row) => row.confirm)).toBe(false);
  });

  it("一批里混进生视频：只跑第一个，并明说原因", async () => {
    const mock = await startMock([
      { calls: [image("第1张"), { tool: "generate_video", args: { prompt: "动起来" } }], say: "先画。" },
      { tool: "reply", args: { text: "画好了。" }, say: "画好了。" },
    ]);

    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "画一张再让它动起来" }).expect(202);
    const view = await settle(mock.app, mock.conversationId, (item) => item.status === "idle" && item.messages.some((row) => row.role === "tool"));

    expect(mock.imagePrompts).toEqual(["第1张"]);
    expect(view.messages.filter((row) => row.role === "tool")).toHaveLength(1);
    // 缩到只剩一个调用时也得把话说出来，否则用户以为视频也在做
    const note = view.messages.find((row) => row.role === "system");
    expect(note?.content).toContain("只执行了第一个");
  });

  it("超过会话软上限：**一张**合并的确认卡，点头之前一个请求都不发", async () => {
    const mock = await startMock([
      { calls: [image("第1张"), image("第2张"), image("第3张"), image("第4张")], say: "画四张。" },
      { tool: "reply", args: { text: "好了。" }, say: "好了。" },
    ]);

    // 把额度耗到只剩 0（软上限 20）：数的是 messages.task_id，所以直接补 20 条
    for (let index = 0; index < 20; index += 1) {
      mock.context.db.appendMessage({ conversationId: mock.conversationId, role: "tool", content: `旧产物 ${index}`, taskId: `old-task-${index}` });
    }
    expect((await request(mock.app).get(`/api/conversations/${mock.conversationId}`).expect(200)).body.data.taskCount).toBe(20);

    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "再给我四个版本" }).expect(202);
    const view = await settle(mock.app, mock.conversationId, (item) => item.status === "awaiting_confirmation");

    // 一张卡替 4 个调用问清楚——不是 4 张卡，也不是「先跑了再说」
    const cards = view.messages.filter((row) => row.confirm);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.confirm!.reason).toBe("session_limit");
    expect(cards[0]!.confirm!.count).toBe(4);
    expect(cards[0]!.confirm!.message).toContain("4");
    // 超额度那张卡问的是图片，模型行就得是**生图**渠道——按视频解析会显示成
    // 「还没有配置视频渠道」，用户在生图，看到这句只会以为功能坏了
    expect(cards[0]!.confirm!.model).toBe("mock-image");
    expect(cards[0]!.toolName).toBeNull();
    // 关键：还没提交任何生成任务
    expect(mock.imagePrompts).toEqual([]);

    // 用户点头：4 个真提交，额度如实 +4，卡片就地变成这轮的表头（不重影）
    await request(mock.app).post(`/api/conversations/${mock.conversationId}/confirm`)
      .send({ messageId: cards[0]!.id, decision: "approve" }).expect(200);
    const after = await settle(mock.app, mock.conversationId, (item) => item.status === "idle" && item.messages.filter((row) => row.role === "tool").length >= 4);

    expect(mock.imagePrompts).toHaveLength(4);
    expect(after.taskCount).toBe(24);
    expect(after.messages.some((row) => row.confirm)).toBe(false);
    // 「画四张。」这句话只出现一次：卡片那行就地当表头，没有再冒一个一模一样的气泡
    expect(after.messages.filter((row) => row.content === "画四张。")).toHaveLength(1);
    expect(mock.getChatCalls()).toBeGreaterThanOrEqual(1);
  });

  it("用户在合并卡上点「先不生成」：一个请求都不发", async () => {
    const mock = await startMock([
      { calls: [image("第1张"), image("第2张")], say: "画两张。" },
      { tool: "reply", args: { text: "好。" }, say: "好。" },
    ]);
    for (let index = 0; index < 20; index += 1) {
      mock.context.db.appendMessage({ conversationId: mock.conversationId, role: "tool", content: `旧产物 ${index}`, taskId: `old-task-${index}` });
    }

    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "再给我两张" }).expect(202);
    const view = await settle(mock.app, mock.conversationId, (item) => item.status === "awaiting_confirmation");
    const card = view.messages.find((row) => row.confirm)!;

    await request(mock.app).post(`/api/conversations/${mock.conversationId}/confirm`)
      .send({ messageId: card.id, decision: "reject" }).expect(200);
    const after = await settle(mock.app, mock.conversationId, (item) => item.status === "idle");

    expect(mock.imagePrompts).toEqual([]);
    expect(after.taskCount).toBe(20);
    expect(after.messages.some((row) => row.content === "已取消本次生成")).toBe(true);
  });
});
