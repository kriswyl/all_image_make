import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Jimp, JimpMime } from "jimp";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { videoOverviewSampleTimes, videoOverviewSchema } from "../src/shared/media-review";
import { createApp } from "../src/server/app";
import { VideoOverviewRequests } from "../src/server/video-overview-requests";

interface MockBody {
  messages: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }>;
  tools?: Array<{ function: { name: string } }>;
}

it("对话按需请求客户端均匀抽帧，限本会话回传，只用一次视觉请求", async () => {
  const bodies: MockBody[] = [];
  const brain = http.createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk;
    const body = JSON.parse(data) as MockBody;
    bodies.push(body);
    const last = body.messages.at(-1);
    const evidence = Array.isArray(last?.content) && last.content.some(part => part.type === "image_url");
    const review = body.tools?.some(spec => spec.function.name === "media_review")
      && body.messages.some(item => item.role === "user" && /整体讲了什么/.test(JSON.stringify(item.content)));
    const message = evidence ? { content: "画面显示场景从红色切换为蓝色。" } : last?.role === "tool" ? { content: "按全片画面取样，这段视频先显示红色场景，随后变为蓝色。" } : review ? {
      content: "",
      tool_calls: [{ id: "overview", type: "function", function: { name: "media_review", arguments: "{}" } }],
    } : { content: "你好。" };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message, finish_reason: "tool_calls" in message ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }));
  });
  await new Promise<void>(resolve => brain.listen(0, "127.0.0.1", resolve));
  const address = brain.address() as import("node:net").AddressInfo;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-video-overview-"));
  const { app, context } = createApp({ dataDir: dir });
  const { db, agent } = context;
  try {
    const channel = (await request(app).post("/api/channels").send({
      name: "本地模拟", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat",
      authType: "none", models: ["mock"], allowPrivateNetwork: true, enabled: true,
    }).expect(201)).body.data;
    const setup = {
      title: "视频概述", brainChannelId: channel.id, brainModel: "mock", videoConfirmPolicy: "auto_only" as const,
      visionEnabled: true, verbatimPrompt: false, toolScope: "all" as const,
    };
    const conversation = db.createConversation(setup);
    const other = db.createConversation(setup);
    const assetId = "f123-video";
    db.createTask({ id: "test-video", channelId: "", model: "", prompt: "", input: {}, origin: "upload", status: "succeeded" });
    db.insertAsset({
      id: assetId, taskId: "test-video", fileName: "clip.mp4", mimeType: "video/mp4", byteSize: 1,
      relativePath: "clip.mp4", baseDir: db.assetsDir, sha256: "video-test",
    });
    db.appendMessage({ conversationId: conversation.id, role: "user", content: "附上视频", assetId });
    const events: string[] = [];
    const unsubscribe = agent.subscribe(conversation.id, event => events.push(event.type));
    const waitIdle = () => vi.waitFor(() => expect(db.getConversation(conversation.id)?.status).toBe("idle"), { timeout: 5000 });
    const send = (text: string) => request(app).post(`/api/conversations/${conversation.id}/messages`).send({ text, assetRefs: [assetId] }).expect(202);
    await send("你好");
    await waitIdle();
    expect(events).not.toContain("video_overview_frames");
    await send("这个视频整体讲了什么");
    await vi.waitFor(() => expect(agent.videoOverview.pending(conversation.id)?.assetId).toBe(assetId), { timeout: 5000 });
    expect(events.filter(event => event === "video_overview_frames")).toHaveLength(1);
    const { requestId } = agent.videoOverview.pending(conversation.id)!;
    const jpeg = `data:image/jpeg;base64,${(await new Jimp({ width: 8, height: 8, color: 0xff0000ff })
      .getBuffer(JimpMime.jpeg)).toString("base64")}`;
    const times = videoOverviewSampleTimes(16_000);
    const payload = { ok: true, durationMs: 16_000, planned: times.length, sheets: times.map(time => ({ timesMs: [time], jpeg })) };
    const pathFor = (id: string) => `/api/conversations/${id}/video-overview/${requestId}`;
    await request(app).post(pathFor(other.id)).send(payload).expect(409);
    await request(app).post(pathFor(conversation.id)).send({ ...payload, sheets: [{ timesMs: [500], jpeg }] }).expect(400);
    await request(app).post(pathFor(conversation.id)).send(payload).expect(200);
    await request(app).post(pathFor(conversation.id)).send(payload).expect(409);
    await waitIdle();
    unsubscribe();

    const rows = db.listMessages(conversation.id);
    const tool = rows.find(row => row.role === "tool" && row.toolName === "media_review");
    expect(videoOverviewSchema.parse(tool?.toolResult?.data?.videoOverview)).toMatchObject({ assetId, timesMs: times, durationMs: 16_000 });
    expect(rows.at(-1)?.content).toContain("画面取样");
    const visual = bodies.filter(body => body.messages.some(item => Array.isArray(item.content) && item.content.some(part => part.type === "image_url")));
    expect(visual).toHaveLength(1);
    expect((visual[0]?.messages.at(-1)?.content as Array<{ type: string }>).filter(part => part.type === "image_url")).toHaveLength(8);
    expect(JSON.stringify(rows)).not.toContain("data:image");
  } finally {
    agent.dispose();
    db.close();
    await new Promise<void>(resolve => brain.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it("按时长调整样本数，停止后拒绝迟到的抽帧结果", async () => {
  const times = videoOverviewSampleTimes(600_000);
  expect(times).toHaveLength(24);
  expect(times[0]).toBe(12_500);
  expect(times.at(-1)).toBe(587_500);
  const requests = new VideoOverviewRequests();
  const controller = new AbortController();
  const job = requests.read("chat", "video", controller.signal, () => {});
  const id = requests.pending("chat")!.requestId;
  controller.abort();
  await expect(job).rejects.toMatchObject({ name: "AbortError" });
  expect(requests.submit("chat", id, { ok: false, reason: "empty" })).toBe("expired");
});
