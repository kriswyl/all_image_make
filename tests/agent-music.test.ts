import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/server/app";
import { shouldConfirm } from "../src/server/agent";
import { generateMusicSchema } from "../src/server/agent-tools";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("对话里生成音乐", () => {
  it("用户明确要歌时直接提交；完成后两张音频都回到工具卡片，且不碰画布", async () => {
    let origin = "";
    let brainCalls = 0;
    let submitted: Record<string, unknown> | null = null;
    let polls = 0;
    const musicRequests: string[] = [];

    const mock = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", origin || "http://127.0.0.1");
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        if (url.pathname === "/v1/chat/completions") {
          brainCalls += 1;
          const plan = brainCalls === 1
            ? { tool: "generate_music", args: { prompt: "雨后的城市，温暖民谣", mode: "inspiration" }, say: "这就写。" }
            : { tool: "reply", args: { text: "两首已经好了，听听看。" }, say: "写好了。" };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(plan) } }] }));
          return;
        }
        if (url.pathname === "/api/queue/makeAiMusic") {
          submitted = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          musicRequests.push(url.pathname);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ code: 200, data: [11, 12], success: true, message: "请求成功" }));
          return;
        }
        if (url.pathname === "/api/midjourney/drawInfo4") {
          polls += 1;
          const done = polls >= 2;
          const tracks = [
            { id: "a", status: "complete", title: "雨后的城", audio_url: `${origin}/audio/a.m4a`, image_url: `${origin}/cover/a.png`, metadata: { duration: 180, prompt: "[Verse]\n雨后的城" } },
            { id: "b", status: "complete", title: "晚风", audio_url: `${origin}/audio/b.m4a`, image_url: `${origin}/cover/b.png`, metadata: { duration: 150, prompt: "[Verse]\n晚风" } },
          ];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            code: 200, success: true,
            data: {
              id: Number(url.searchParams.get("id")), status: done ? 3 : 2, progress: done ? 100 : 0,
              errormsg: null, taskName: "音乐创作",
              fileInfo: done ? { mp3Url: `${origin}/audio/a.m4a`, bigUrl: `${origin}/cover/a.png`, duration: 180 } : {},
              extend: JSON.stringify(tracks),
            },
          }));
          return;
        }
        if (url.pathname.startsWith("/audio/")) {
          res.writeHead(200, { "Content-Type": "audio/x-m4a" });
          res.end(Buffer.from("audio-bytes"));
          return;
        }
        if (url.pathname.startsWith("/cover/")) {
          res.writeHead(200, { "Content-Type": "image/png" });
          res.end(Buffer.from(pngBase64, "base64"));
          return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found" } }));
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { mock.close(() => resolve()); }));
    const address = mock.address();
    if (!address || typeof address === "string") throw new Error("mock server did not start");
    origin = `http://127.0.0.1:${address.port}`;

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-agent-music-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    await request(app).post("/api/channels").send({
      name: "Brain", baseUrl: origin, adapterType: "openai-chat", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
      models: ["mock-brain"], allowPrivateNetwork: true, enabled: true,
    }).expect(201);
    const music = (await request(app).post("/api/channels").send({
      name: "Music", baseUrl: origin, adapterType: "suno-music", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "/api/queue/makeAiMusic",
      models: ["suno_damobi_music"], allowPrivateNetwork: true, enabled: true,
    }).expect(201)).body.data;

    const conversationId = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id as string;
    await request(app).post(`/api/conversations/${conversationId}/messages`)
      .send({ text: "写一首关于雨后城市的歌" }).expect(202);

    let view: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      view = (await request(app).get(`/api/conversations/${conversationId}`).expect(200)).body.data;
      const status = (view as { status: string }).status;
      const messages = (view as { messages: Array<{ role: string }> }).messages;
      if (status === "idle" && messages.filter((item) => item.role === "tool").length >= 1 && brainCalls >= 2) break;
    }

    type Row = {
      role: string; content: string | null; toolName: string | null;
      toolResult: { ok: boolean; assetId?: string; assetIds?: string[]; mimeType?: string; async?: boolean } | null;
      assetId: string | null;
    };
    const messages = (view as unknown as { messages: Row[] }).messages;
    const planRow = messages.find((item) => item.toolName === "generate_music")!;
    const resultRow = messages.find((item) => item.role === "tool")!;
    expect(planRow).toBeTruthy();
    expect(resultRow.toolResult?.ok).toBe(true);
    expect(resultRow.toolResult?.mimeType).toContain("audio/");
    expect(resultRow.toolResult?.assetIds).toHaveLength(2);
    expect(resultRow.toolResult?.async).toBeUndefined();
    expect(resultRow.content).toContain("雨后的城");
    expect(resultRow.content).toContain("晚风");
    // 音乐不是图片：画布保持为空
    expect((view as { canvasAssetIds: string[] }).canvasAssetIds).toEqual([]);
    // 一次两首都要进会话素材表，否则第二首在卡片里既没有封面也没有歌词
    const media = (view as { mediaAssets: Array<{ asset: { title: string | null; lyrics: string | null } }> }).mediaAssets;
    expect(media).toHaveLength(2);
    expect(media.map((item) => item.asset.title)).toEqual(["雨后的城", "晚风"]);
    expect(media.every((item) => Boolean(item.asset.lyrics))).toBe(true);

    expect(submitted).toMatchObject({
      gpt_description_prompt: "雨后的城市，温暖民谣",
      mv: "chirp-v3-5",
      make_instrumental: false,
    });
    expect(musicRequests).toEqual(["/api/queue/makeAiMusic"]);
    expect(music.models).toEqual(["suno_damobi_music"]);
  }, 20_000);
});

describe("generate_music 参数", () => {
  it("sound / mashup 允许没有 prompt，cover 带源歌曲引用", () => {
    expect(generateMusicSchema.safeParse({
      mode: "sound", title: "Rain", tags: "rain", tempo: 99, key: "D", loop: true,
    }).success).toBe(true);
    expect(generateMusicSchema.safeParse({
      mode: "mashup", sourceAssetRefs: ["#a3f1", "#b4e2"], title: "混音",
    }).success).toBe(true);
    expect(generateMusicSchema.safeParse({
      mode: "cover", prompt: "改成爵士", sourceAssetRefs: ["#a3f1"],
    }).success).toBe(true);
    // 源歌曲最多两个，第三个直接拒绝
    expect(generateMusicSchema.safeParse({
      mode: "mashup", sourceAssetRefs: ["#1", "#2", "#3"],
    }).success).toBe(false);
  });
});

describe("音乐确认策略", () => {
  it("用户明确要音乐时不拦；自动续跑时按策略确认", () => {
    expect(shouldConfirm("generate_music", false, "auto_only")).toBe(false);
    expect(shouldConfirm("generate_music", true, "auto_only")).toBe(true);
    expect(shouldConfirm("generate_music", true, "always")).toBe(true);
    expect(shouldConfirm("generate_music", true, "never")).toBe(false);
    // 图片不进入这个闸门
    expect(shouldConfirm("generate_image", true, "always")).toBe(false);
  });
});
