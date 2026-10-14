/**
 * 默认生图 / 生视频模型（需求.md 问题 5）的**行为**验证。
 *
 * 这一组测的不是设置项的往返——那只是把它存进了库。真正要证明的是：
 * 大脑没点名用哪个模型时，出网的请求到底落在**用户挑的那个渠道**上。
 *
 * 以前这里靠的是 `resolveAlias` 的兜底 `candidates[0]`，而那个顺序来自渠道列表，
 * 用户没有任何办法控制。所以两个渠道故意用不同前缀（flux / qwen）拿到确定的 alias，
 * 再用端点路径区分请求究竟打到谁身上。
 */
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/server/app";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** 一个假中转站同时演大脑和生图：按路径分流，并把每条路径记下来当证据 */
async function startRelay() {
  const paths: string[] = [];
  let chatCalls = 0;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      paths.push(req.url ?? "");
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url?.includes("/chat/completions")) {
        chatCalls += 1;
        // 第一次让它画图，**故意不给 modelHint**——这正是问题 5 的场景；
        // 第二次收尾，让这一轮正常走完
        const plan = chatCalls === 1
          ? { tool: "generate_image", args: { prompt: "一只戴草帽的橘猫" }, say: "这就画。" }
          : { tool: "reply", args: { text: "画好了。" }, say: "画好了。" };
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(plan) } }] }));
        return;
      }
      res.end(JSON.stringify({ data: [{ b64_json: pngBase64 }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock server did not start");
  return {
    paths,
    baseUrl: `http://127.0.0.1:${address.port}`,
    /** 只求出网的生图请求，聊天那条不算 */
    imagePaths: () => paths.filter((url) => url.startsWith("/v1/images")),
  };
}

interface Booted {
  app: ReturnType<typeof createApp>["app"];
  addChannel: (input: Record<string, unknown>) => Promise<{ id: string }>;
  setBrainKey: (id: string, key: string) => void;
}

async function boot(baseUrl: string, prefix: string): Promise<Booted> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const { app, context } = createApp({ dataDir });
  cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });
  return {
    app,
    addChannel: async (input) =>
      (await request(app).post("/api/channels").send(input).expect(201)).body.data as { id: string },
    setBrainKey: (id, key) => { context.sessionKeys.set(id, key); },
  };
}

/** 一轮对话跑完：等大脑收尾、等生图落库 */
async function runOneTurn(app: Booted["app"], conversationId: string) {
  await request(app).post(`/api/conversations/${conversationId}/messages`)
    .send({ text: "画一只戴草帽的橘猫" }).expect(202);

  let view: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    view = (await request(app).get(`/api/conversations/${conversationId}`).expect(200)).body.data;
    const messages = (view as { messages: Array<{ role: string }> }).messages;
    if ((view as { status: string }).status === "idle" && messages.some((item) => item.role === "tool")) break;
  }
  return view;
}

/** 生图那张卡的 data —— 模型来源那句话就写在里面 */
function imageToolData(view: Record<string, unknown>) {
  const row = (view as { messages: Array<{ role: string; toolResult: { data?: Record<string, unknown> } | null }> })
    .messages.find((item) => item.role === "tool");
  return row?.toolResult?.data ?? {};
}

async function chatAndImageChannels(booted: Booted, baseUrl: string) {
  const brain = await booted.addChannel({
    name: "Brain", baseUrl, adapterType: "openai-chat", authType: "bearer",
    authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
    models: ["deepseek-v4-1-flash"], allowPrivateNetwork: true, enabled: true,
  });
  booted.setBrainKey(brain.id, "sk-brain-secret-value");

  const makeImage = (name: string, model: string, endpoint: string) => booted.addChannel({
    name, baseUrl, adapterType: "openai-images", authType: "none",
    authHeaderName: "", secretEnv: "", endpoint, models: [model],
    allowPrivateNetwork: true, enabled: true,
  });
  await makeImage("Flux", "flux-pro", "/v1/images/flux");
  await makeImage("Qwen", "qwen-image", "/v1/images/qwen");
}

describe("默认生图模型（需求.md 问题 5）", () => {
  it("大脑不点名时，请求真的落在用户挑的那个渠道上", async () => {
    const relay = await startRelay();
    const booted = await boot(relay.baseUrl, "image-relay-default-model-");
    await chatAndImageChannels(booted, relay.baseUrl);

    // 两个渠道各出一个 alias（前缀不同，不会加序号后缀）
    const aliases = (await request(booted.app).get("/api/agent/capabilities").expect(200)).body.data.aliases
      .filter((item: { kind: string }) => item.kind === "image");
    expect(aliases.map((item: { alias: string }) => item.alias).sort()).toEqual(["flux", "qwen"]);

    // 用户把默认值挑成 qwen
    const patched = (await request(booted.app).patch("/api/settings")
      .send({ agentDefaultImageAlias: "qwen" }).expect(200)).body.data;
    expect(patched.defaultImageAlias).toBe("qwen");
    // 真的落库了，不是只回显
    expect((await request(booted.app).get("/api/settings").expect(200)).body.data.defaultImageAlias).toBe("qwen");

    const conversationId = (await request(booted.app).post("/api/conversations").send({}).expect(201)).body.data.id as string;
    const view = await runOneTurn(booted.app, conversationId);

    expect(relay.imagePaths()).toEqual(["/v1/images/qwen"]);

    // 卡片上也要说清楚这是按默认值选的，而不是大脑点名的——
    // 「说的和做的一致」是这一项的验收标准
    const data = imageToolData(view);
    expect(data.usedFallback).toBe(true);
    expect(String(data.aliasNote)).toContain("qwen");
    expect(String(data.aliasNote)).toContain("默认");
  });

  it("默认值没设时退回类目第一个（老行为不变）", async () => {
    const relay = await startRelay();
    const booted = await boot(relay.baseUrl, "image-relay-no-default-");
    await chatAndImageChannels(booted, relay.baseUrl);

    const conversationId = (await request(booted.app).post("/api/conversations").send({}).expect(201)).body.data.id as string;
    const view = await runOneTurn(booted.app, conversationId);

    const first = (await request(booted.app).get("/api/agent/capabilities").expect(200)).body.data.aliases
      .filter((item: { kind: string }) => item.kind === "image")[0] as { alias: string };
    expect(relay.imagePaths()).toEqual([`/v1/images/${first.alias}`]);
    // 没设默认值时不该冒出「按你设的默认模型」这种话
    expect(String(imageToolData(view).aliasNote ?? "")).not.toContain("按你设的默认模型");
  });

  it("设了一个已经失效的 alias 时退回第一个，并且如实说它失效了", async () => {
    const relay = await startRelay();
    const booted = await boot(relay.baseUrl, "image-relay-stale-default-");
    await chatAndImageChannels(booted, relay.baseUrl);

    // 渠道被停用或删掉后就是这个状态——**正常**情况，
    // 但必须说出来，否则用户会以为自己的默认值还在生效
    await request(booted.app).patch("/api/settings")
      .send({ agentDefaultImageAlias: "已经删掉的渠道" }).expect(200);

    const conversationId = (await request(booted.app).post("/api/conversations").send({}).expect(201)).body.data.id as string;
    const view = await runOneTurn(booted.app, conversationId);

    const first = (await request(booted.app).get("/api/agent/capabilities").expect(200)).body.data.aliases
      .filter((item: { kind: string }) => item.kind === "image")[0] as { alias: string };
    expect(relay.imagePaths()).toEqual([`/v1/images/${first.alias}`]);

    const note = String(imageToolData(view).aliasNote);
    expect(note).toContain("已经删掉的渠道");
    expect(note).toContain("已经不可用");
  });
});
