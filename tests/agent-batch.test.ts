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
import { BATCHABLE_TOOLS, extractPlanText, looksLikeIdentityDrift, parsePlan, resolveBatch } from "../src/server/agent";
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

  it("一致性标记：认出常用写法，单调用时丢掉", () => {
    const batch = (consistency: unknown) => parsePlan(JSON.stringify({
      calls: [image("A"), image("B")], consistency,
    }));
    expect(batch("character")?.consistency).toBe("character");
    expect(batch("style")?.consistency).toBe("style");
    // 模型常见的变体也要认：true / same_style
    expect(batch(true)?.consistency).toBe("character");
    expect(batch("same_style")?.consistency).toBe("style");
    // 认不出的写法当成没写，别让整份计划作废
    expect(batch("nonsense")).not.toHaveProperty("consistency");
    // 单张没有一致性可言
    expect(parsePlan(JSON.stringify({ calls: [image("A")], consistency: "character" }))).not.toHaveProperty("consistency");
  });
});

describe("空 reply 的正文提取", () => {
  it("从 args 的常见字段里取，认得出模型换了字段名的情况", () => {
    expect(extractPlanText({ tool: "reply", args: { text: "你好" } }, "x")).toBe("你好");
    expect(extractPlanText({ tool: "reply", args: { message: "在的" } }, "x")).toBe("在的");
    expect(extractPlanText({ tool: "reply", args: { content: "画什么？" } }, "x")).toBe("画什么？");
    expect(extractPlanText({ tool: "ask", args: { question: "要几比几？" } }, "x")).toBe("要几比几？");
  });

  it("args 为空时，用 JSON 外面的自然语言兜底", () => {
    // 模型先把话说了，再补一个空工具计划
    expect(extractPlanText(
      { tool: "reply", args: {} },
      '你好呀！我在。\n{"tool":"reply","args":{}}',
    )).toBe("你好呀！我在。");
    // 只有空 JSON、没有正文 → 真的为空，交给纠正重试
    expect(extractPlanText({ tool: "reply", args: {} }, '{"tool":"reply","args":{}}')).toBe("");
  });
});

describe("身份跑偏检测（中转站注入 Claude Code 提示词）", () => {
  it("认出几种典型说法，不误伤正常回复", () => {
    expect(looksLikeIdentityDrift("我是 Claude Code，Anthropic 的命令行工具助手")).toBe(true);
    expect(looksLikeIdentityDrift("我不具备图像生成功能")).toBe(true);
    expect(looksLikeIdentityDrift("I cannot generate images.")).toBe(true);
    expect(looksLikeIdentityDrift("好嘞，这就给你画一位美女～")).toBe(false);
    expect(looksLikeIdentityDrift('{"tool":"generate_image","args":{"prompt":"猫"}}')).toBe(false);
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
async function startMock(plansByCall: unknown[], options: { failPrompts?: string[] } = {}) {
  const imagePrompts: string[] = [];
  /** 每次产图请求：提示词 + 带了几张参考图。一致性批量靠它验证「第 2 张起真的带了基准图」 */
  const imageRequests: Array<{ prompt: string; references: number }> = [];
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
        // 带上 usage：状态行的账本全靠它，测试里也要能断言真的记上了
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: JSON.stringify(plan) } }],
          usage: { prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 5 } },
        }));
        return;
      }
      const contentType = String(req.headers["content-type"] ?? "");
      let prompt: string;
      let references = 0;
      if (contentType.includes("multipart/form-data")) {
        // openai-images 带参考图时走 /v1/images/edits + multipart
        prompt = body.match(/name="prompt"\r\n\r\n([\s\S]*?)\r\n--/)?.[1] ?? "";
        references = (body.match(/name="image(?:\[\])?"/g) ?? []).length;
      } else {
        prompt = (JSON.parse(body) as { prompt: string }).prompt;
      }
      imagePrompts.push(prompt);
      imageRequests.push({ prompt, references });
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      const fail = options.failPrompts?.includes(prompt);
      // 故意让「第 1 张」最慢：完成顺序和计划顺序**不一样**，才能验出画布是
      // 按计划顺序落回来的，而不是「谁先跑完算谁」。
      // 带参考图的一致性请求给足时间，让「其余几张同时在飞」真的观测得到
      // （参考图要先解码/缩放，10ms 会短到第一张已经回来、第二张还没发出去）。
      const delay = prompt === "第1张" ? 180 : prompt.includes("以参考图") ? 160 : 10;
      setTimeout(() => {
        inflight -= 1;
        if (fail) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "mock failure" } }));
          return;
        }
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
    imageRequests,
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
  usage: { contextTokens: number; promptTokens: number; completionTokens: number; reasoningTokens: number; calls: number };
};

async function settle(app: ReturnType<typeof createApp>["app"], conversationId: string, until: (view: View) => boolean, tries = 120): Promise<View> {
  let view: View = {
    status: "", taskCount: 0, canvasAssetIds: [], messages: [], sessionImages: [],
    usage: { contextTokens: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, calls: 0 },
  };
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

    // 下区的顺序 = 计划顺序；新产物只进素材库，不自动占用画布
    expect(view.sessionImages.map((item) => item.asset.id)).toEqual(cards.map((row) => row.assetId));
    expect(view.canvasAssetIds).toEqual([]);

    // 4 个任务就是 4 笔额度，自动记上（数的是 messages.task_id）
    expect(view.taskCount).toBe(4);
    // token 账本：规划 + 收尾各一次大脑调用；上下文取最近一次的 prompt_tokens
    expect(view.usage.calls).toBe(2);
    expect(view.usage.promptTokens).toBe(200);
    expect(view.usage.completionTokens).toBe(40);
    expect(view.usage.reasoningTokens).toBe(10);
    expect(view.usage.contextTokens).toBe(100);
    // 批量没有确认这一环：一批图片不该被拦，拦了就白等一次
    expect(view.messages.some((row) => row.confirm)).toBe(false);
  });

  it("要同一人物时：先生成基准图，其余几张以它为参考并行生成", async () => {
    const mock = await startMock([
      { calls: [image("第1张"), image("第2张"), image("第3张")], consistency: "character", say: "画三张。" },
      { tool: "reply", args: { text: "三张都好了。" }, say: "三张都好了。" },
    ]);

    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "画三张同一个人" }).expect(202);
    const view = await settle(mock.app, mock.conversationId, (item) => item.status === "idle" && item.messages.filter((row) => row.role === "tool").length >= 3);

    const cards = view.messages.filter((row) => row.role === "tool");
    expect(cards).toHaveLength(3);
    expect(cards.every((row) => row.toolResult?.ok === true)).toBe(true);

    // 第 1 张是基准，不带参考图；第 2、3 张各带 1 张（就是基准图）
    expect(mock.imageRequests.map((item) => item.references)).toEqual([0, 1, 1]);
    expect(mock.imageRequests[0]!.prompt).toBe("第1张");
    // 各自的场景描述没有被丢掉，只是前面多了「保持同一人物」的约束。
    // 并行发出的顺序不保证，所以按集合看，不按下标。
    const restPrompts = mock.imageRequests.slice(1).map((item) => item.prompt);
    expect(restPrompts.every((prompt) => prompt.startsWith("以参考图中的同一位人物为准"))).toBe(true);
    expect(restPrompts.some((prompt) => prompt.endsWith("第2张"))).toBe(true);
    expect(restPrompts.some((prompt) => prompt.endsWith("第3张"))).toBe(true);
    // 基准图出来之后，其余两张是**并行**的
    expect(mock.getMaxInflight()).toBeGreaterThanOrEqual(2);
    // 3 张就是 3 笔，基准图本身也是结果之一，不多收一份钱
    expect(view.taskCount).toBe(3);
    expect(view.sessionImages).toHaveLength(3);
  });

  it("基准图失败时，其余几张退回普通并行，不会整批白跑", async () => {
    const mock = await startMock([
      { calls: [image("第1张"), image("第2张"), image("第3张")], consistency: "character", say: "画三张。" },
      { tool: "reply", args: { text: "第 1 张失败了，另外两张好了。" }, say: "第 1 张失败了，另外两张好了。" },
    ], { failPrompts: ["第1张"] });

    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "画三张同一个人" }).expect(202);
    const view = await settle(mock.app, mock.conversationId, (item) => item.status === "idle" && item.messages.filter((row) => row.role === "tool").length >= 3);

    const cards = view.messages.filter((row) => row.role === "tool");
    expect(cards).toHaveLength(3);
    expect(cards[0]!.toolResult?.ok).toBe(false);
    // 基准图没出来，剩下两张不能带着「一张不存在的参考图」发，也不能干脆不发
    expect(cards[1]!.toolResult?.ok).toBe(true);
    expect(cards[2]!.toolResult?.ok).toBe(true);
    expect(mock.imageRequests.slice(1).every((item) => item.references === 0)).toBe(true);
  });

  it("模型给了空 reply 时：纠正一次，不落空气泡", async () => {
    const mock = await startMock([
      { tool: "reply", args: {} },
      { tool: "reply", args: { text: "你好呀，我是语布。" } },
    ]);

    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "你好" }).expect(202);
    const view = await settle(mock.app, mock.conversationId, (item) => item.status === "idle" && item.messages.length >= 2);

    const assistant = view.messages.filter((row) => row.role === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0]!.content).toBe("你好呀，我是语布。");
    // 空 reply + 纠正后的一次 = 两次大脑调用；第一句正文没有丢
    expect(mock.getChatCalls()).toBe(2);
    expect(view.messages.some((row) => row.role === "assistant" && row.content === "")).toBe(false);
  });

  it("中转站注入 Claude Code 身份时：纠正一次，接着把图画出来", async () => {
    const mock = await startMock([
      "我是 Claude Code，Anthropic 的命令行工具助手。我不具备图像生成功能。",
      { tool: "generate_image", args: { prompt: "猫" }, say: "画猫。" },
      { tool: "reply", args: { text: "画好了。" }, say: "画好了。" },
    ]);

    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "画一只猫" }).expect(202);
    const view = await settle(mock.app, mock.conversationId, (item) => item.status === "idle" && item.messages.some((row) => row.role === "tool"));

    // 第一次跑偏 → 身份纠正一次 → 拿到正常计划；收尾再问一次大脑
    expect(mock.getChatCalls()).toBe(3);
    expect(mock.imagePrompts).toEqual(["猫"]);
    expect(view.messages.find((row) => row.role === "tool")?.toolResult?.ok).toBe(true);
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
