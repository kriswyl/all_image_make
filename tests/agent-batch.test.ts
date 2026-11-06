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
import { afterEach, describe, expect, it, vi } from "vitest";
import { BATCHABLE_TOOLS, extractPlanText, looksLikeIdentityDrift, parsePlan, resolveBatch } from "../src/server/agent";
import { MAX_BATCH_CALLS, planCalls, type PlannedCall } from "../src/shared/agent-types";
import { createApp } from "../src/server/app";
import { executeChatDocumentTool, readWorkspaceFile } from "../src/server/chat-tools/documents";
import { readPresentationProject } from "../src/server/presentation-project";
import { requestsDirectSingleImage } from "../src/server/chat-tools/native-image";

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
async function startMock(plansByCall: unknown[], options: { failPrompts?: string[]; disconnectPrompts?: string[]; native?: boolean; video?: boolean; rejectTools?: boolean } = {}) {
  const imagePrompts: string[] = [];
  const chatRequests: Array<{ tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; tool_call_id?: string; content?: string }> }> = [];
  /** 每次产图请求：提示词 + 带了几张参考图。一致性批量靠它验证「第 2 张起真的带了基准图」 */
  const imageRequests: Array<{ prompt: string; references: number }> = [];
  let inflight = 0;
  let maxInflight = 0;
  let chatCalls = 0;
  const videoRequests: unknown[] = [];
  let videoReady = false;

  const mock = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.url === "/api/v3/contents/generations/tasks") {
        videoRequests.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "video-1" }));
        return;
      }
      if (req.url === "/api/v3/contents/generations/tasks/video-1") {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(videoReady
          ? { id: "video-1", status: "succeeded", content: { video_url: `${base}/result.mp4` } }
          : { id: "video-1", status: "running" }));
        return;
      }
      if (req.url === "/result.mp4") {
        res.writeHead(200, { "Content-Type": "video/mp4" }).end("mock video");
        return;
      }
      if (req.url?.includes("/chat/completions")) {
        const payload = JSON.parse(body);
        chatRequests.push(payload);
        if (options.rejectTools && payload.model === "mock-brain" && payload.tools?.length) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "tools not supported" } }));
          return;
        }
        const plan = plansByCall[Math.min(chatCalls, plansByCall.length - 1)];
        chatCalls += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        // 带上 usage：状态行的账本全靠它，测试里也要能断言真的记上了
        res.end(JSON.stringify({
          choices: [{ message: options.native ? plan : { role: "assistant", content: JSON.stringify(plan) } }],
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
      if (options.disconnectPrompts?.includes(prompt)) {
        res.destroy();
        return;
      }
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
  let { app, context } = createApp({ dataDir });
  cleanups.push(() => { context.agent.dispose(); context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

  const brain = (await request(app).post("/api/channels").send({
    name: "Brain", baseUrl: base, adapterType: "openai-chat", authType: "none",
    authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
    models: options.rejectTools ? ["mock-brain", "mock-brain-alt"] : ["mock-brain"], allowPrivateNetwork: true, enabled: true,
  }).expect(201)).body.data;
  await request(app).post("/api/channels").send({
    name: "Images", baseUrl: base, adapterType: "openai-images", authType: "none",
    authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations",
    models: ["mock-image"], allowPrivateNetwork: true, enabled: true,
  }).expect(201);
  if (options.video) {
    await request(app).post("/api/channels").send({
      name: "Video", baseUrl: base, adapterType: "seedance-video", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "/api/v3/contents/generations/tasks",
      models: ["sd-2.5"], allowPrivateNetwork: true, enabled: true,
    }).expect(201);
  }

  const conversationId = (await request(app).post("/api/conversations").send({ brainChannelId: brain.id, brainModel: "mock-brain" }).expect(201)).body.data.id as string;

  return {
    get app() { return app; },
    get context() { return context; },
    conversationId, brainId: brain.id as string,
    restart() {
      context.agent.dispose();
      context.db.close();
      ({ app, context } = createApp({ dataDir }));
      context.agent.recoverStaleConversations();
    },
    imagePrompts, chatRequests,
    imageRequests, videoRequests,
    completeVideo: () => { videoReady = true; },
    getMaxInflight: () => maxInflight,
    getChatCalls: () => chatCalls,
  };
}

type ToolRow = {
  id: string;
  role: string; content: string | null; toolName: string | null; toolArgs: Record<string, unknown> | null;
  toolResult: { ok: boolean; assetId?: string; data?: Record<string, unknown> } | null; assetId: string | null;
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
    const decisions = await Promise.all(Array.from({ length: 2 }, () =>
      request(mock.app).post(`/api/conversations/${mock.conversationId}/confirm`)
        .send({ messageId: cards[0]!.id, decision: "approve" })));
    expect(decisions.map(response => response.status).sort()).toEqual([200, 409]);
    const after = await settle(mock.app, mock.conversationId, (item) => item.status === "idle" && item.messages.filter((row) => row.role === "tool").length >= 4);

    expect(mock.imagePrompts).toHaveLength(4);
    expect(after.taskCount).toBe(24);
    expect(after.messages.some((row) => row.confirm)).toBe(false);
    // 「画四张。」这句话只出现一次：卡片那行就地当表头，没有再冒一个一模一样的气泡
    expect(after.messages.filter((row) => row.content === "画四张。")).toHaveLength(1);
    expect(mock.getChatCalls()).toBeGreaterThanOrEqual(1);
  });

  it("基准图提交结果未知时停止续跑并保留其依赖", async () => {
    const mock = await startMock([
      { calls: [image("基准图"), image("变化图")], consistency: "style", say: "同画风生成。" },
      image("重复提交"),
    ], { disconnectPrompts: ["基准图"] });
    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "画一组同画风的图" }).expect(202);
    const view = await settle(mock.app, mock.conversationId, item => item.status === "idle" && item.messages.some(row => row.content?.includes("生成提交状态待核对")));
    expect(view.messages.some(row => row.content?.includes("依赖它的生成任务尚未提交"))).toBe(true);
    expect(mock.imagePrompts).toEqual(["基准图"]);
    expect(mock.getChatCalls()).toBe(1);
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

it("普通聊天原生生图保存本轮参考图，确认一次后回填原调用", async () => {
  const mock = await startMock([
    { content: "", tool_calls: [{ id: "native-image-1", type: "function", function: { name: "generate_image", arguments: JSON.stringify({ prompt: "参考上传图片生成海报", count: 1 }) } }] },
    { content: "海报已生成。" },
  ], { native: true });
  const base = `/api/conversations/${mock.conversationId}`;
  await request(mock.app).patch(base).send({ chatMode: "chat", nativeImagePilot: true, visionEnabled: false, imageConfirmPolicy: "always" }).expect(200);
  const upload = (await request(mock.app).post(`${base}/uploads`).attach("images", Buffer.from(pngBase64, "base64"), "reference.png").expect(201)).body.data;
  expect(upload.canvasAssetIds).toEqual([]);
  const refId = upload.sessionImages[0].asset.id;
  await request(mock.app).post(`${base}/messages`).send({ text: "参考这张图，生成一张海报", assetRefs: [refId] }).expect(202);
  const waiting = await settle(mock.app, mock.conversationId, item => item.status === "awaiting_confirmation");
  const card = waiting.messages.find(row => row.confirm)!;
  const snapshot = mock.context.db.getNativeMediaConfirmation(card.id);
  expect(snapshot?.callId).toBe("native-image-1");
  expect(mock.context.db.getMessage(card.id)?.toolArgs?.imageRefs).toEqual([refId]);
  expect(mock.chatRequests[0]?.tools?.some(tool => tool.function.name === "generate_image")).toBe(true);
  // 看图关闭时不挂 view_images，避免生成后多出一条「无法查看图片」的失败卡
  expect(mock.chatRequests[0]?.tools?.some(tool => tool.function.name === "view_images")).toBe(false);
  expect(mock.imagePrompts).toEqual([]);
  mock.restart();
  const decisions = await Promise.all(Array.from({ length: 2 }, () =>
    request(mock.app).post(`${base}/confirm`).send({ messageId: card.id, decision: "approve" })));
  expect(decisions.map(response => response.status).sort()).toEqual([200, 409]);
  await settle(mock.app, mock.conversationId, item => item.status === "idle" && item.messages.some(row => row.content === "海报已生成。"));
  expect(mock.imageRequests).toEqual([{ prompt: "参考上传图片生成海报", references: 1 }]);
  const response = mock.chatRequests.at(-1)?.messages.find(message => message.tool_call_id === "native-image-1");
  expect(JSON.parse(response?.content ?? "{}").assetIds).toHaveLength(1);
});

it("单张原生改图默认直接提交，不再弹付费确认卡", async () => {
  const editCall = { name: "edit_image", arguments: "" };
  const mock = await startMock([
    { content: "", tool_calls: [{ id: "edit-direct", type: "function", function: editCall }] },
    { content: "背景已经改成蓝色。" },
  ], { native: true });
  const base = `/api/conversations/${mock.conversationId}`;
  await request(mock.app).patch(base).send({ toolScope: "all", visionEnabled: false }).expect(200);
  const upload = (await request(mock.app).post(`${base}/uploads`)
    .attach("images", Buffer.from(pngBase64, "base64"), "base.png").expect(201)).body.data;
  editCall.arguments = JSON.stringify({ prompt: "把背景改成浅蓝色，保留主体", imageRefs: [upload.sessionImages[0].asset.id] });
  await request(mock.app).post(`${base}/messages`).send({ text: "把背景改成浅蓝色" }).expect(202);
  const finished = await settle(mock.app, mock.conversationId, item => item.status === "idle"
    && item.messages.some(row => row.content === "背景已经改成蓝色。"));
  expect(finished.messages.some(row => row.confirm)).toBe(false);
  expect(mock.imageRequests).toHaveLength(1);
  const result = mock.chatRequests.at(-1)?.messages.find(message => message.tool_call_id === "edit-direct");
  expect(JSON.parse(String(result?.content ?? "{}")).assetIds).toHaveLength(1);
});

it("原生改图查看历史图片，确认时固定底图和额外参考图", async () => {
  const viewCall = { name: "view_images", arguments: "" };
  const editCall = { name: "edit_image", arguments: "" };
  const mock = await startMock([
    { content: "", tool_calls: [{ id: "view-history", type: "function", function: viewCall }] },
    { content: "", tool_calls: [{ id: "edit-history", type: "function", function: editCall }] },
    { content: "改图已完成。" },
  ], { native: true });
  const base = `/api/conversations/${mock.conversationId}`;
  await request(mock.app).patch(base).send({ chatMode: "chat", nativeImagePilot: true, visionEnabled: true, imageConfirmPolicy: "always" }).expect(200);
  const upload = (await request(mock.app).post(`${base}/uploads`)
    .attach("images", Buffer.from(pngBase64, "base64"), "base.png")
    .attach("images", Buffer.from(pngBase64, "base64"), "style.png").expect(201)).body.data;
  const [bottom, extra] = upload.sessionImages.map((entry: { asset: { id: string } }) => entry.asset.id);
  viewCall.arguments = JSON.stringify({ assetRefs: [bottom] });
  editCall.arguments = JSON.stringify({ prompt: "只调整底图色调", imageRefs: [bottom], extraReferences: [extra] });
  await request(mock.app).post(`${base}/messages`).send({ text: "查看这张历史底图，参考另一张的风格来改图" }).expect(202);
  const awaiting = await settle(mock.app, mock.conversationId, item => item.status === "awaiting_confirmation");
  const card = awaiting.messages.find(row => row.confirm)!;
  expect(card.toolName).toBe("edit_image");
  expect(card.confirm!.message).toMatch(/底图.*额外参考图/);
  expect(mock.context.db.getMessage(card.id)?.toolArgs).toMatchObject({ imageRefs: [bottom], extraReferences: [extra] });
  const messages = mock.chatRequests[1]!.messages;
  expect(messages.at(-2)).toMatchObject({ role: "tool", tool_call_id: "view-history" });
  expect(messages.at(-1)).toMatchObject({ role: "user", content: expect.arrayContaining([expect.objectContaining({ type: "image_url" })]) });
  expect(mock.imagePrompts).toEqual([]);
  await request(mock.app).post(`${base}/confirm`).send({ messageId: card.id, decision: "approve" }).expect(200);
  await settle(mock.app, mock.conversationId, item => item.status === "idle" && item.messages.some(row => row.content === "改图已完成。"));
  expect(mock.imageRequests).toEqual([{ prompt: "只调整底图色调", references: 2 }]);
  const resumed = mock.chatRequests.at(-1)?.messages ?? [];
  expect(resumed.find(message => message.tool_call_id === "edit-history")).toMatchObject({ role: "tool" });
  expect(resumed.at(-1)).toMatchObject({ role: "user", content: expect.arrayContaining([expect.objectContaining({ type: "image_url" })]) });
});

it.each(["正常完成", "期间发送新消息", "收尾前重启", "切换仅对话后确认原卡"])("原生视频完成后回填原任务卡（%s）", async (scenario) => {
  const newMessage = scenario === "期间发送新消息";
  const changedScope = scenario === "切换仅对话后确认原卡";
  const mock = await startMock([
    { content: "", tool_calls: [{ id: "native-video-1", type: "function", function: {
      name: "generate_video", arguments: JSON.stringify({ prompt: "镜头缓慢推进", mode: changedScope ? "text-to-video" : "first-last-frame" }),
    } }] },
    { content: newMessage ? "这是另一项请求的回复。" : "视频已经完成。" },
  ], { native: true, video: true });
  const base = `/api/conversations/${mock.conversationId}`;
  await request(mock.app).patch(base).send(changedScope ? { toolScope: "all" } : { chatMode: "chat", nativeImagePilot: true, videoConfirmPolicy: "never" }).expect(200);
  const upload = (await request(mock.app).post(`${base}/uploads`)
    .attach("images", Buffer.from(pngBase64, "base64"), "first.png")
    .attach("images", Buffer.from(pngBase64, "base64"), "last.png").expect(201)).body.data;
  const assetRefs = upload.sessionImages.map((entry: { asset: { id: string } }) => entry.asset.id);
  const videoFrames = changedScope ? { firstAssetId: assetRefs[1], lastAssetId: assetRefs[0] } : undefined;
  if (changedScope) {
    expect(upload.canvasAssetIds).toEqual([]);
    await request(mock.app).post(`${base}/messages`).send({ text: "重复的帧", assetRefs, videoFrames: { firstAssetId: assetRefs[0], lastAssetId: assetRefs[0] } }).expect(400);
  }
  await request(mock.app).post(`${base}/messages`).send({ text: "用两张图做首尾帧视频", assetRefs, videoFrames }).expect(202);
  const awaiting = await settle(mock.app, mock.conversationId, item => item.status === "awaiting_confirmation");
  const card = awaiting.messages.find(row => row.confirm)!;
  expect(card.toolName).toBe("generate_video");
  expect(card.toolArgs).toMatchObject({ mode: "first-last-frame", imageRefs: changedScope ? [...assetRefs].reverse() : assetRefs });
  expect(mock.videoRequests).toEqual([]);
  if (changedScope) {
    expect(mock.context.db.listMessages(mock.conversationId).filter(row => row.role === "user").at(-1)?.videoFrames).toEqual(videoFrames);
    await request(mock.app).patch(base).send({ toolScope: "conversation" }).expect(200);
  }

  const decisions = await Promise.all(Array.from({ length: 2 }, () =>
    request(mock.app).post(`${base}/confirm`).send({ messageId: card.id, decision: "approve", args: { duration: 6 } })));
  expect(decisions.map(response => response.status).sort()).toEqual([200, 409]);
  const waiting = await settle(mock.app, mock.conversationId, item => item.status === "waiting_task");
  expect(waiting.status).toBe("waiting_task");
  expect(mock.context.db.getNativeMediaConfirmation(card.id)?.callId).toBe("native-video-1");
  if (newMessage) {
    await request(mock.app).post(`${base}/messages`).send({ text: "先回答另一项请求" }).expect(202);
    const next = await settle(mock.app, mock.conversationId, item => item.status === "idle");
    expect(next.messages.some(row => row.content === "这是另一项请求的回复。")).toBe(true);
  }

  if (scenario === "收尾前重启") {
    mock.context.agent.dispose();
    mock.context.db.setConversationStatus(mock.conversationId, "running");
  }
  mock.completeVideo();
  if (scenario === "收尾前重启") {
    const task = mock.context.db.listPendingMessages(mock.conversationId).find(row => row.taskId)!;
    await vi.waitFor(() => expect(mock.context.db.getTaskView(task.taskId!)?.status).toBe("succeeded"));
    mock.restart();
  }
  const finished = await settle(mock.app, mock.conversationId, item => item.status === "idle"
    && item.messages.some(row => row.toolName === "generate_video" && row.assetId));
  expect(finished.messages.find(row => row.toolName === "generate_video" && row.assetId)?.toolResult?.ok).toBe(true);
  expect(mock.context.db.getNativeMediaConfirmation(card.id)).toBeNull();
  expect(mock.videoRequests).toEqual([expect.objectContaining({ duration: 6, content: expect.arrayContaining([
    expect.objectContaining({ role: "first_frame" }), expect.objectContaining({ role: "last_frame" }),
  ]) })]);
  expect(mock.getChatCalls()).toBe(changedScope ? 1 : 2);
  const result = mock.chatRequests[1]?.messages.find(message => message.tool_call_id === "native-video-1");
  if (newMessage || changedScope) expect(result).toBeUndefined();
  else expect(JSON.parse(result?.content ?? "{}").assetIds).toHaveLength(1);
}, 15_000);

it("统一助手按渠道开启新会话，旧会话保留入口，仅对话不执行渠道返回的工具", async () => {
  const mock = await startMock([
    { content: "可以开始。" },
    { tool_calls: [{ id: "unexpected", type: "function", function: { name: "doc_create", arguments: JSON.stringify({ kind: "md", name: "不应创建", content: "文字" }) } }] },
  ], { native: true });
  const legacy = `/api/conversations/${mock.conversationId}`;
  mock.context.db.appendMessage({ conversationId: mock.conversationId, role: "user", content: "旧对话内容" });
  const config = `/api/channels/${mock.brainId}/unified-agent`;
  const version = mock.context.db.getChannel(mock.brainId)?.updatedAt;
  await request(mock.app).patch(config).send({ enabled: true }).expect(200);
  expect(mock.context.db.getChannel(mock.brainId)?.updatedAt).toBe(version);
  mock.restart();
  expect((await request(mock.app).get(legacy).expect(200)).body.data).toMatchObject({ toolScope: null, chatMode: "creative" });
  const created = (await request(mock.app).post("/api/conversations").send({ brainChannelId: mock.brainId, brainModel: "mock-brain" }).expect(201)).body.data;
  expect(created).toMatchObject({ toolScope: "all", chatMode: "creative" });
  const base = `/api/conversations/${created.id}`;
  await request(mock.app).post(`${base}/messages`).send({ text: "你好" }).expect(202);
  await settle(mock.app, created.id, item => item.status === "idle");
  // 统一入口不再一次挂满所有工具：闲聊只给核心，能力按意图/目录开放。
  expect(mock.chatRequests[0]?.tools?.map(tool => tool.function.name)).toEqual(["plan_update", "capability_search"]);
  await request(mock.app).patch(base).send({ toolScope: "conversation" }).expect(200);
  await request(mock.app).post(`${base}/messages`).send({ text: "生成一份文件" }).expect(202);
  const finished = await settle(mock.app, created.id, item => item.status === "idle");
  expect(mock.chatRequests[1]?.tools).toBeUndefined();
  expect(finished.messages.some(row => row.role === "tool")).toBe(false);
  expect(finished.messages.at(-1)?.content).toContain("工具已关闭");
  await request(mock.app).patch(config).send({ enabled: false }).expect(200);
  expect((await request(mock.app).get(base).expect(200)).body.data.toolScope).toBe("conversation");
  const rolledBack = await request(mock.app).patch(base).send({ toolScope: null }).expect(200);
  expect(rolledBack.body.data).toMatchObject({ toolScope: null, chatMode: "creative" });
});

it("新客户端可直接创建统一对话，旧会话有待确认任务时保持原入口", async () => {
  const mock = await startMock([], { native: true });
  const legacy = `/api/conversations/${mock.conversationId}`;
  mock.context.db.appendMessage({ conversationId: mock.conversationId, role: "user", content: "之前的对话" });
  mock.context.db.setConversationStatus(mock.conversationId, "awaiting_confirmation");
  await request(mock.app).patch(legacy).send({ toolScope: "all" }).expect(409);
  expect(mock.context.db.getConversation(mock.conversationId)?.toolScope).toBeNull();
  mock.context.db.setConversationStatus(mock.conversationId, "idle");
  const upgraded = (await request(mock.app).patch(legacy).send({ toolScope: "all" }).expect(200)).body.data;
  expect(upgraded.messages).toEqual(expect.arrayContaining([expect.objectContaining({ content: "之前的对话" })]));
  expect(upgraded.toolScope).toBe("all");
  expect(mock.context.db.getChannel(mock.brainId)?.unifiedAgentDefault).toBe(false);
  const created = (await request(mock.app).post("/api/conversations").send({ toolScope: "all" }).expect(201)).body.data;
  expect(created.toolScope).toBe("all");
});

it("渠道拒绝工具时仅文字回退，换模型后恢复全部能力", async () => {
  const mock = await startMock([{ content: "收到。" }], { native: true, rejectTools: true });
  const base = `/api/conversations/${mock.conversationId}`;
  await request(mock.app).patch(base).send({ toolScope: "all" }).expect(200);
  await request(mock.app).post(`${base}/messages`).send({ text: "先聊聊" }).expect(202);
  await settle(mock.app, mock.conversationId, item => item.status === "idle");
  expect(mock.chatRequests).toHaveLength(2);
  expect(mock.chatRequests[0]?.tools?.length).toBeGreaterThan(0);
  expect(mock.chatRequests[1]?.tools).toBeUndefined();
  expect(mock.context.db.getConversation(mock.conversationId)?.toolsUnsupported).toBe(true);
  await request(mock.app).patch(base).send({ brainModel: "mock-brain-alt" }).expect(200);
  await request(mock.app).post(`${base}/messages`).send({ text: "现在继续" }).expect(202);
  await settle(mock.app, mock.conversationId, item => item.status === "idle");
  expect(mock.chatRequests[2]?.tools?.length).toBeGreaterThan(0);
  expect(mock.context.db.getConversation(mock.conversationId)?.toolsUnsupported).toBe(false);
});

it("普通聊天生成画布模板和分镜审阅项目，由用户选择导入", async () => {
  const mock = await startMock([
    { content: "", tool_calls: [
      { id: "layout", type: "function", function: { name: "create_canvas_template", arguments: JSON.stringify({
        name: "分镜单列布局", nodes: [{ tempId: "note", type: "text", x: 0, y: 0, text: "分镜说明" }],
      }) } },
      { id: "shots", type: "function", function: { name: "create_storyboard_template", arguments: JSON.stringify({
        title: "湖边散步", brief: { aspectRatio: "16:9", duration: "10秒" }, shots: [{ prompt: "夕阳下两人沿着湖边散步" }],
      }) } },
    ] },
    { content: "两个模板已就绪。" },
  ], { native: true });
  const base = `/api/conversations/${mock.conversationId}`;
  await request(mock.app).patch(base).send({ chatMode: "chat", nativeImagePilot: true }).expect(200);
  await request(mock.app).post(`${base}/messages`).send({ text: "准备一个分镜单列布局和一个湖边散步的 16:9、10 秒分镜模板" }).expect(202);
  const finished = await settle(mock.app, mock.conversationId, view => view.status === "idle");
  const results = finished.messages.filter(message => message.role === "tool");
  const layout = results.find(message => message.toolName === "create_canvas_template")?.toolResult;
  const storyboard = results.find(message => message.toolName === "create_storyboard_template")?.toolResult;
  expect(layout).toMatchObject({ ok: true, data: { templateName: "分镜单列布局" } });
  expect(storyboard).toMatchObject({ ok: true, data: { storyboardCount: 1 } });
  const projectId = storyboard!.data!.storyboardProjectId;
  await request(mock.app).get(`/api/storyboard-projects/${projectId}`).expect(200);
  const boards = (await request(mock.app).get("/api/boards").expect(200)).body.data;
  expect(boards).toHaveLength(0);
  expect(finished.taskCount).toBe(0);
  await request(mock.app).post("/api/boards/from-template").send({ templateId: layout!.data!.templateId }).expect(201);
  expect(mock.chatRequests.at(-1)?.messages.filter(message => message.role === "tool").map(message => message.tool_call_id)).toEqual(["layout", "shots"]);
});

it("原生一次返回多张生图时合并成一张确认卡，并按一致性批量执行", async () => {
  const mock = await startMock([
    { content: "", tool_calls: [
      { id: "native-batch-a", type: "function", function: { name: "generate_image", arguments: JSON.stringify({
        prompt: "第1张", fromScratch: true, consistency: "character",
      }) } },
      { id: "native-batch-b", type: "function", function: { name: "generate_image", arguments: JSON.stringify({
        prompt: "第2张", fromScratch: true, consistency: "character",
      }) } },
    ] },
    { content: "两张同一角色的图已完成。" },
  ], { native: true });
  const base = `/api/conversations/${mock.conversationId}`;
  await request(mock.app).patch(base).send({ toolScope: "all" }).expect(200);
  await request(mock.app).post(`${base}/messages`).send({ text: "画两张同一角色的不同场景" }).expect(202);
  const awaiting = await settle(mock.app, mock.conversationId, item => item.status === "awaiting_confirmation");
  const card = awaiting.messages.find(row => row.confirm)! as typeof awaiting.messages[number] & { plan?: { calls?: unknown[] } };
  expect(card.plan?.calls).toHaveLength(2);
  expect(card.confirm).toMatchObject({ count: 2, consistency: "character" });
  expect(mock.imageRequests).toEqual([]);

  await request(mock.app).post(`${base}/confirm`).send({ messageId: card.id, decision: "approve" }).expect(200);
  const finished = await settle(mock.app, mock.conversationId, item => item.status === "idle"
    && item.messages.some(row => row.content === "两张同一角色的图已完成。"));
  expect(mock.imageRequests).toHaveLength(2);
  expect(mock.imageRequests[1]!.references).toBe(1);
  const results = finished.messages.filter(row => row.role === "tool" && row.toolName === "generate_image");
  expect(results).toHaveLength(2);
  const toolMessages = mock.chatRequests.at(-1)?.messages.filter(message => message.role === "tool") ?? [];
  expect(toolMessages.map(message => message.tool_call_id)).toEqual(["native-batch-a", "native-batch-b"]);
  expect(JSON.parse(toolMessages[0]!.content!).assetIds).toHaveLength(1);
  expect(JSON.parse(toolMessages[1]!.content!).assetIds).toHaveLength(1);
});

it.each(["画一只猫", "帮我生成一张重庆夜景图片"])("全部能力下单张生图「%s」默认直出，产物回填原生调用", async (text) => {
  const mock = await startMock([
    { tool_calls: [{ id: "single-direct", type: "function", function: { name: "generate_image", arguments: JSON.stringify({ prompt: "重庆夜景", count: 1 }) } }] },
    { content: "夜景已生成。" },
  ], { native: true });
  const base = `/api/conversations/${mock.conversationId}`;
  await request(mock.app).patch(base).send({ toolScope: "all" }).expect(200);
  await request(mock.app).post(`${base}/messages`).send({ text }).expect(202);
  const finished = await settle(mock.app, mock.conversationId, item => item.status === "idle" && item.messages.some(row => row.content === "夜景已生成。"));
  expect(finished.messages.some(row => row.confirm)).toBe(false);
  expect(mock.imageRequests).toHaveLength(1);
  const result = mock.chatRequests.at(-1)?.messages.find(message => message.tool_call_id === "single-direct");
  expect(JSON.parse(result!.content!).assetIds).toHaveLength(1);
  const [assetId] = JSON.parse(result!.content!).assetIds;
  const { app } = mock;
  const uploaded = (await request(app).post(`${base}/uploads`).attach("images", Buffer.from(pngBase64, "base64"), "私有参考.png").expect(201)).body.data;
  const inputId = uploaded.sessionImages.find((entry: { source: string }) => entry.source === "upload").asset.id;
  for (const mode of ["records", "assets"]) {
    const history = (await request(app).get("/api/library").query({ limit: 10, mode, kind: "image", includeChatImages: "1" }).expect(200)).body.data.items;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ historySource: "chat", assets: [expect.objectContaining({ id: assetId })] });
    expect(history.flatMap((task: { assets: { id: string }[] }) => task.assets).map((asset: { id: string }) => asset.id)).not.toContain(inputId);
  }
  expect((await request(app).get("/api/library").expect(200)).body.data).toEqual([]);
});

it("图像指令有询问、引用或多张要求时不会自动提交", () => {
  expect(requestsDirectSingleImage("帮我画一个机器人")).toBe(true);
  expect(requestsDirectSingleImage("画一张有两只猫的海报")).toBe(true);
  expect(requestsDirectSingleImage("画两张猫的图片")).toBe(false);
  expect(requestsDirectSingleImage("不要画一只猫")).toBe(false);
  expect(requestsDirectSingleImage("画一只猫，等我确认")).toBe(false);
  expect(requestsDirectSingleImage("解释「画一只猫」这句话")).toBe(false);
});

it("同轮计划加生图时只出一张确认卡，并把 count 的多张产物合到原调用", async () => {
  const native = (id: string, name: string, args: object) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const mock = await startMock([
    { tool_calls: [
      native("plan-image", "plan_update", { steps: [{ task: "生成重庆配图", status: "in_progress" }] }),
      native("two", "generate_image", { prompt: "江景", count: 2 }),
      native("one", "generate_image", { prompt: "山城步道" }),
    ] },
    { content: "三张图片已生成。" },
  ], { native: true });
  const base = `/api/conversations/${mock.conversationId}`;
  await request(mock.app).patch(base).send({ toolScope: "all" }).expect(200);
  await request(mock.app).post(`${base}/messages`).send({ text: "生成三张重庆旅游配图" }).expect(202);
  const waiting = await settle(mock.app, mock.conversationId, item => item.status === "awaiting_confirmation");
  const cards = waiting.messages.filter(row => row.confirm);
  expect(cards).toHaveLength(1);
  expect(cards[0]?.confirm?.count).toBe(3);
  expect(waiting.messages.some(row => row.role === "tool" && row.toolName === "plan_update" && row.toolResult?.ok)).toBe(true);
  expect(mock.imageRequests).toHaveLength(0);
  await request(mock.app).post(`${base}/confirm`).send({ messageId: cards[0]!.id, decision: "approve" }).expect(200);
  await settle(mock.app, mock.conversationId, item => item.status === "idle" && item.messages.some(row => row.content === "三张图片已生成。"));
  expect(mock.imageRequests).toHaveLength(3);
  const results = mock.chatRequests.at(-1)?.messages.filter(message => message.role === "tool") ?? [];
  expect(results.map(result => result.tool_call_id)).toEqual(["plan-image", "two", "one"]);
  expect(JSON.parse(results[1]!.content!).assetIds).toHaveLength(2);
  expect(JSON.parse(results[2]!.content!).assetIds).toHaveLength(1);
});

it("渠道把 PPT 修改放进 DSML 正文时，经版本校验执行并嵌入会话配图", async () => {
  const replies: unknown[] = [];
  const mock = await startMock(replies, { native: true });
  const id = mock.conversationId, db = mock.context.db, base = `/api/conversations/${id}`;
  await request(mock.app).patch(base).send({ toolScope: "all", visionEnabled: false }).expect(200);
  const source = await executeChatDocumentTool(db, id, "doc_create", JSON.stringify({ kind: "md", name: "素材", content: "# 重庆旅游" }));
  const draft = await executeChatDocumentTool(db, id, "doc_convert", JSON.stringify({ fileId: source.data!.fileId, to: "pptx" }),
    async () => ({ title: "重庆", theme: "blue", slides: [{ layout: "content", title: "重庆", subtitle: "", notes: "", lines: ["两江交汇"] }] }));
  const original = draft.data!.fileId;
  const { sha256 } = JSON.parse((await executeChatDocumentTool(db, id, "doc_read", JSON.stringify({ fileId: original }))).summary);
  const upload = (await request(mock.app).post(`${base}/uploads`).attach("images", Buffer.from(pngBase64, "base64"), "江景.png").expect(201)).body.data;
  const asset = upload.sessionImages[0].asset.id;
  const tag = (key: string, value: unknown) => `<｜DSML｜parameter name="${key}" string="${typeof value === "string"}">${typeof value === "string" ? value : JSON.stringify(value)}</｜DSML｜parameter>`;
  const pages = [{ page: 1, slide: { title: "重庆江景", elements: [
    { id: "title", type: "text", x: 0.8, y: 0.5, w: 10, h: 1, text: "重庆江景" },
    { id: "jiang", type: "image", x: 0.8, y: 2, w: 6, h: 4, imageIndex: 0 },
  ] } }];
  const body = `<｜DSML｜calls><｜DSML｜invoke name="doc_edit">${tag("fileId", original)}${tag("expectedSha256", sha256)}${tag("imageAssetIds", [asset])}${tag("pages", pages)}</｜DSML｜invoke></｜DSML｜calls>`;
  replies.push({ content: body.slice(0, -20) }, { content: `我来更新版式。${body}` }, { content: "配图已写入新版。" });
  await request(mock.app).post(`${base}/messages`).send({ text: "修改重庆旅游 PPT，放入刚上传的配图" }).expect(202);
  const view = await settle(mock.app, id, item => item.status === "idle" && item.messages.some(row => row.content === "配图已写入新版。"));
  expect(view.messages.some(row => row.content?.includes("DSML"))).toBe(false);
  const edits = view.messages.filter(row => row.role === "tool" && row.toolName === "doc_edit");
  expect(edits).toHaveLength(1);
  expect(edits[0]!.toolResult?.ok).toBe(true);
  const updated = String(edits[0]!.toolResult?.data?.workspaceFileId);
  expect(updated).not.toBe(original);
  const project = await readPresentationProject(readWorkspaceFile(db, id, updated).bytes);
  expect(project?.images).toHaveLength(1);
  expect(project?.plan.slides[0]?.elements).toContainEqual(expect.objectContaining({ id: "jiang", imageIndex: 0 }));
  expect(mock.chatRequests.at(-1)?.messages.find(message => message.role === "tool")?.content).toMatch(/此新文件版本的 SHA-256：[a-f0-9]{64}/);
});

it("当前工具组不足时，capability_search 在下一轮开放能力", async () => {
  const mock = await startMock([
    { content: "", tool_calls: [{ id: "find-docs", type: "function", function: {
      name: "capability_search", arguments: JSON.stringify({ query: "转换" }),
    } }] },
    { content: "文档能力已开启。" },
  ], { native: true });
  const base = `/api/conversations/${mock.conversationId}`;
  await request(mock.app).patch(base).send({ toolScope: "all" }).expect(200);
  await request(mock.app).post(`${base}/messages`).send({ text: "帮我转换一下" }).expect(202);
  const finished = await settle(mock.app, mock.conversationId, item => item.status === "idle"
    && item.messages.some(row => row.content === "文档能力已开启。"));
  const firstTools = mock.chatRequests[0]?.tools?.map(tool => tool.function.name) ?? [];
  const nextTools = mock.chatRequests[1]?.tools?.map(tool => tool.function.name) ?? [];
  expect(firstTools).toEqual(["plan_update", "capability_search"]);
  expect(nextTools).toContain("doc_convert");
  expect(nextTools).not.toContain("generate_image");
  expect(finished.messages.some(row => row.toolName === "capability_search" && row.toolResult?.ok)).toBe(true);
});

it("文件操作失败后，模型不能把“已完成”留在最终回复里", async () => {
  const mock = await startMock([
    { content: "", tool_calls: [{ id: "edit", type: "function", function: {
      name: "doc_edit", arguments: JSON.stringify({ fileId: "missing-file", expectedSha256: "0".repeat(64), design: { accent: "1F3A5F" } }),
    } }] },
    { content: "已完成全篇重构，视觉已全面升级。" },
    { content: "这次没有改成功：文件不存在，原文件保持原样。" },
  ], { native: true });
  const base = `/api/conversations/${mock.conversationId}`;
  await request(mock.app).patch(base).send({ toolScope: "all" }).expect(200);
  await request(mock.app).post(`${base}/messages`).send({ text: "修改这份文档的版式" }).expect(202);
  const finished = await settle(mock.app, mock.conversationId, item => item.status === "idle"
    && item.messages.some(row => row.content?.includes("没有改成功")));
  expect(finished.messages.some(row => row.role === "assistant" && row.content?.includes("已完成全篇重构"))).toBe(false);
  expect(finished.messages.some(row => row.role === "system" && row.content?.includes("文件操作没有成功"))).toBe(false);
  expect(mock.chatRequests.length).toBeGreaterThanOrEqual(3);
});

it("PPT 参数校验失败后允许模型修正一次，不会被“禁止换源”硬闸门误伤", async () => {
  const convert = (id: string, args: Record<string, unknown>) => ({ id, type: "function", function: {
    name: "doc_convert", arguments: JSON.stringify(args),
  } });
  const mock = await startMock([
    { content: "", tool_calls: [convert("convert-1", { fileId: "missing-file", to: "pptx", pageCount: 0 })] },
    { content: "", tool_calls: [convert("convert-2", { fileId: "missing-file", to: "pptx" })] },
    { content: "这次转换失败了，我先停在这里。" },
  ], { native: true });
  const base = `/api/conversations/${mock.conversationId}`;
  await request(mock.app).patch(base).send({ toolScope: "all" }).expect(200);
  await request(mock.app).post(`${base}/messages`).send({ text: "把这个文档转成 PPT" }).expect(202);
  const finished = await settle(mock.app, mock.conversationId, item => item.status === "idle"
    && item.messages.some(row => row.content === "这次转换失败了，我先停在这里。"));
  const results = finished.messages.filter(row => row.role === "tool" && row.toolName === "doc_convert");
  expect(results).toHaveLength(2);
  expect(results[0]!.toolResult?.ok).toBe(false);
  expect((results[1]!.toolResult as { summary?: string } | null)?.summary).toContain("文件不存在");
  expect((results[1]!.toolResult as { summary?: string } | null)?.summary).not.toContain("不能自行创建骨架");
});

it("PPT 转换失败后，同一轮不允许模型自行换源再转一次", async () => {
  const convert = (id: string) => ({ id, type: "function", function: {
    name: "doc_convert", arguments: JSON.stringify({ fileId: "missing-file", to: "pptx" }),
  } });
  const mock = await startMock([
    { content: "", tool_calls: [convert("convert-1")] },
    { content: "", tool_calls: [convert("convert-2")] },
    { content: "这次转换失败了，我先停在这里。" },
  ], { native: true });
  const base = `/api/conversations/${mock.conversationId}`;
  await request(mock.app).patch(base).send({ toolScope: "all" }).expect(200);
  await request(mock.app).post(`${base}/messages`).send({ text: "把这个文件转成 PPT" }).expect(202);
  const finished = await settle(mock.app, mock.conversationId, item => item.status === "idle"
    && item.messages.some(row => row.content === "这次转换失败了，我先停在这里。"));
  const results = finished.messages.filter(row => row.role === "tool" && row.toolName === "doc_convert");
  expect(results).toHaveLength(2);
  expect(results[0]!.toolResult?.ok).toBe(false);
  expect((results[1]!.toolResult as { summary?: string } | null)?.summary).toContain("不能自行创建骨架");
  expect(mock.chatRequests).toHaveLength(3);
});
