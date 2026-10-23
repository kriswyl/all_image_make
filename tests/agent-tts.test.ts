import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/server/app";
import { pcmToWav } from "../src/server/adapters";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("对话里生成配音", () => {
  it("generate_speech 同步完成，音频回到工具卡片，且不碰画布", async () => {
    let origin = "";
    let brainCalls = 0;
    let submitted: Record<string, unknown> | null = null;
    const wav = pcmToWav(Buffer.alloc(48_000), 24_000, 1);

    const mock = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", origin || "http://127.0.0.1");
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        if (url.pathname === "/v1/chat/completions") {
          brainCalls += 1;
          const plan = brainCalls === 1
            ? { tool: "generate_speech", args: { text: "你好，欢迎收听。", voice: "Kore", style: "亲切" }, say: "这就读。" }
            : { tool: "reply", args: { text: "配音好了。" }, say: "好了。" };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(plan) } }] }));
          return;
        }
        if (url.pathname.includes(":generateContent")) {
          submitted = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: wav.toString("base64") } }] } }],
          }));
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

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-agent-tts-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    await request(app).post("/api/channels").send({
      name: "Brain", baseUrl: origin, adapterType: "openai-chat", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
      models: ["mock-brain"], allowPrivateNetwork: true, enabled: true,
    }).expect(201);
    await request(app).post("/api/channels").send({
      name: "TTS", baseUrl: origin, adapterType: "gemini-tts", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "/v1beta/models/{model}:generateContent",
      models: ["mock-tts"], allowPrivateNetwork: true, enabled: true,
    }).expect(201);

    const conversationId = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id as string;
    await request(app).post(`/api/conversations/${conversationId}/messages`)
      .send({ text: "把「你好，欢迎收听。」读一下" }).expect(202);

    let view: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      view = (await request(app).get(`/api/conversations/${conversationId}`).expect(200)).body.data;
      const status = (view as { status: string }).status;
      const messages = (view as { messages: Array<{ role: string }> }).messages;
      if (status === "idle" && messages.some((item) => item.role === "tool") && brainCalls >= 2) break;
    }

    type Row = {
      role: string; content: string | null; toolName: string | null;
      toolResult: { ok: boolean; assetId?: string; mimeType?: string; async?: boolean } | null;
      assetId: string | null;
    };
    const messages = (view as unknown as { messages: Row[] }).messages;
    const planRow = messages.find((item) => item.toolName === "generate_speech")!;
    const resultRow = messages.find((item) => item.role === "tool")!;
    expect(planRow).toBeTruthy();
    expect(resultRow.toolResult?.ok).toBe(true);
    expect(resultRow.toolResult?.mimeType).toBe("audio/wav");
    expect(resultRow.toolResult?.assetId).toBeTruthy();
    expect(resultRow.toolResult?.async).toBeUndefined();
    expect(resultRow.content).toContain("配音完成");
    expect((view as { canvasAssetIds: string[] }).canvasAssetIds).toEqual([]);
    const media = (view as { mediaAssets: Array<{ asset: { mimeType: string; duration: number } }> }).mediaAssets;
    expect(media).toHaveLength(1);
    expect(media[0]!.asset.mimeType).toBe("audio/wav");
    expect(media[0]!.asset.duration).toBe(1);

    expect(submitted).toMatchObject({
      contents: [{ parts: [{ text: "你好，欢迎收听。", annotations: [{ type: "speech_metadata", style: "亲切" }] }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
      },
    });
  }, 20_000);
});
