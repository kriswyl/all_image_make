import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import { createWebTools } from "../src/server/chat-tools/web";
import { chatWebToolResultSchema } from "../src/shared/chat-web";

afterEach(() => vi.unstubAllGlobals());

const sourceUrl = "https://docs.example.com/video";
const key = "tvly-local-test-stub";
const firecrawlSearch = "https://api.firecrawl.dev/v2/search";
const firecrawlScrape = "https://api.firecrawl.dev/v2/scrape";
const tavilySearch = "https://api.tavily.com/search";

it("对话通过联网开关调用两种工具，并保留实际来源", async () => {
  type MockBrainMessage = { role: string; content: string | null; tool_call_id?: string };
  const seenTools: string[][] = [];
  const upstream = vi.fn(async (url: string, init: RequestInit) => {
    if (url === firecrawlSearch) {
      expect(new Headers(init.headers).has("Authorization")).toBe(false);
      return Response.json({ success: true, data: { web: [{ url: sourceUrl, title: "模型文档", description: "参考图参数条目" }] } });
    }
    if (url === firecrawlScrape) {
      expect(JSON.parse(String(init.body)).url).toBe(sourceUrl);
      return Response.json({ success: true, data: { markdown: "模型支持五张参考图。", metadata: { title: "模型文档", url: sourceUrl, statusCode: 200 } } });
    }
    if (url !== "http://127.0.0.1:1/v1/chat/completions") throw new Error("测试不允许访问未知地址");
    const { tools, messages } = JSON.parse(String(init.body)) as {
      tools?: { function: { name: string } }[];
      messages: MockBrainMessage[];
    };
    const available = tools?.map(tool => tool.function.name) ?? [];
    seenTools.push(available);
    const last = messages.at(-1);
    const userMessage = messages.filter(item => item.role === "user").at(-1);
    const call = (id: string, name: string, args: object) => ({
      content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
    });
    const message = !available.includes("web_search") ? { content: "未开启联网" }
      : last?.tool_call_id === "read" ? { content: `支持五张。[模型文档](${sourceUrl})` }
      : last?.tool_call_id === "search" ? call("read", "read_web_page", { url: sourceUrl })
      : JSON.stringify(userMessage?.content ?? "").includes(sourceUrl) ? call("read", "read_web_page", { url: sourceUrl })
      : call("search", "web_search", { query: "模型 参考图 官方文档" });
    if (last?.tool_call_id === "read") expect(last.content).toContain("模型支持五张参考图");
    return Response.json({ choices: [{ message, finish_reason: "tool_calls" in message ? "tool_calls" : "stop" }], usage: { prompt_tokens: 12, completion_tokens: 9 } });
  });
  vi.stubGlobal("fetch", upstream);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-web-turn-"));
  const { app, context: { db, agent } } = createApp({ dataDir: dir });
  try {
    const channel = (await request(app).post("/api/channels").send({
      name: "模拟对话", baseUrl: "http://127.0.0.1:1", adapterType: "openai-chat", authType: "none",
      models: ["mock"], allowPrivateNetwork: true, enabled: true,
    }).expect(201)).body.data;
    const setup = {
      title: "查询模型", brainChannelId: channel.id, brainModel: "mock", videoConfirmPolicy: "auto_only" as const,
      visionEnabled: true, verbatimPrompt: false, toolScope: "all" as const,
    };
    const conversation = db.createConversation(setup);
    const other = db.createConversation(setup);
    const endpoint = `/api/conversations/${conversation.id}`;
    const send = async (text: string, finalText: string, previousMessages: number) => {
      await request(app).post(`${endpoint}/messages`).send({ text }).expect(202);
      await vi.waitFor(() => {
        const messages = db.listMessages(conversation.id);
        expect(messages.length).toBeGreaterThan(previousMessages);
        expect(messages.at(-1)?.content).toContain(finalText);
        expect(agent.isRunning(conversation.id)).toBe(false);
      });
    };
    await send("查一下模型参考图数量", "未开启联网", 0);
    expect(seenTools.flat()).not.toContain("web_search");
    expect(upstream.mock.calls.every(([url]) => !url.includes("firecrawl"))).toBe(true);
    expect((await request(app).patch(endpoint).send({ webEnabled: true }).expect(200)).body.data.webEnabled).toBe(true);
    expect(db.getConversation(other.id)?.webEnabled).toBe(false);
    const before = db.listMessages(conversation.id).length;
    await send("联网核实模型参考图数量", sourceUrl, before);
    const rows = db.listMessages(conversation.id);
    const webRows = rows.filter(row => row.role === "tool" && ["web_search", "read_web_page"].includes(row.toolName ?? ""));
    expect(webRows.map(row => row.toolName)).toEqual(["web_search", "read_web_page"]);
    expect(webRows[0]?.toolResult?.summary).toContain("尚未读取原文");
    expect(chatWebToolResultSchema.parse(webRows[1]?.toolResult?.data?.web)).toMatchObject({
      provider: "firecrawl", sources: [{ url: sourceUrl, title: "模型文档" }],
    });
    const count = upstream.mock.calls.filter(([url]) => url === firecrawlSearch).length;
    await send(`阅读 ${sourceUrl}`, sourceUrl, rows.length);
    expect(upstream.mock.calls.filter(([url]) => url === firecrawlSearch)).toHaveLength(count);
  } finally {
    agent.dispose();
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it("联网服务配置只回传 Key 状态且重启后保留", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-web-settings-"));
  let runtime = createApp({ dataDir: dir });
  try {
    const url = "/api/settings/web";
    const saved = await request(runtime.app).patch(url).send({ preferred: "tavily", fallback: true, tavilyKey: key }).expect(200);
    expect(saved.body.data).toEqual({ preferred: "tavily", fallback: true, hasTavilyKey: true });
    expect(saved.text).not.toContain(key);
    runtime.context.agent.dispose();
    runtime.context.db.close();
    runtime = createApp({ dataDir: dir });
    expect((await request(runtime.app).get(url)).body.data).toEqual(saved.body.data);
    await request(runtime.app).patch(url).send({ preferred: "tavily", fallback: false, tavilyKey: "a b" }).expect(400);
    const removed = await request(runtime.app).patch(url).send({ preferred: "tavily", fallback: true, tavilyKey: "" }).expect(200);
    expect(removed.body.data).toEqual({ preferred: "firecrawl", fallback: false, hasTavilyKey: false });
  } finally {
    runtime.context.agent.dispose();
    runtime.context.db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it("备用服务只在用户启用时调用，失败原因和实际来源保留", async () => {
  const upstream = vi.fn(async (url: string, init: RequestInit) => {
    if (url === firecrawlSearch) return new Response(null, { status: 429 });
    if (url === tavilySearch) {
      expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${key}`);
      return Response.json({ results: [{ url: sourceUrl, title: "来源", content: "摘要" }] });
    }
    throw new Error("测试不允许访问未知地址");
  });
  vi.stubGlobal("fetch", upstream);
  const preferences = { preferred: "firecrawl" as const, hasTavilyKey: true };
  const signal = new AbortController().signal;
  const args = JSON.stringify({ query: "查文档" });
  const first = await createWebTools({ ...preferences, fallback: false }, key, signal)[0]!.run(args);
  expect(first).toMatchObject({ ok: false, summary: expect.stringContaining("429") });
  expect(upstream.mock.calls.map(([url]) => url)).toEqual([firecrawlSearch]);
  upstream.mockClear();
  const tools = createWebTools({ ...preferences, fallback: true }, key, signal);
  const result = await tools[0]!.run(args);
  expect(chatWebToolResultSchema.parse(result.uiData?.web)).toMatchObject({
    provider: "tavily", attempts: [{ provider: "firecrawl", error: expect.stringContaining("429") }],
    sources: [{ url: sourceUrl, snippet: "摘要" }],
  });
  await tools[0]!.run(args);
  expect(upstream.mock.calls.map(([url]) => url)).toEqual([firecrawlSearch, tavilySearch]);
});

it("Tavily 首选走 Extract，打不开原文时如实报错，私有和带凭据的地址不会出站", async () => {
  const upstream = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("https://api.tavily.com/extract");
    return Response.json({ results: [], failed_results: [{ url: JSON.parse(String(init.body)).urls[0], error: "blocked" }] });
  });
  vi.stubGlobal("fetch", upstream);
  const [search, read] = createWebTools({ preferred: "tavily", fallback: false, hasTavilyKey: true }, key, new AbortController().signal);
  for (const url of ["http://127.0.0.1/", "http://[::1]/", "http://server.internal/", "https://user:password@docs.example.com/", "https://docs.example.com/?access_token=secret"]) {
    expect(await read!.run(JSON.stringify({ url }))).toMatchObject({ ok: false });
  }
  expect(upstream).not.toHaveBeenCalled();
  const result = await read!.run(JSON.stringify({ url: sourceUrl }));
  expect(result).toMatchObject({ ok: false, summary: expect.stringContaining("未读取原文") });
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(search?.displayName).toBe("web_search");
});
