import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/server/app";
import { pcmToWav } from "../src/server/adapters";
import type { Task } from "../src/shared/types";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function startMock() {
  let submitted: Record<string, unknown> | null = null;
  const wav = pcmToWav(Buffer.alloc(48_000), 24_000, 1); // 1 秒静音
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname.includes(":generateContent")) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        submitted = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          candidates: [{
            content: {
              parts: [{ inlineData: { mimeType: "audio/wav", data: wav.toString("base64") } }],
            },
          }],
        }));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server did not start");
  return { origin: `http://127.0.0.1:${address.port}`, submitted: () => submitted };
}

describe("Gemini TTS 端到端", () => {
  it("提交 → 内联 WAV 落盘 → 历史里能看到时长和标题", async () => {
    const mock = await startMock();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-tts-test-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const channel = await request(app).post("/api/channels").send({
      name: "TTS Mock", baseUrl: mock.origin, adapterType: "gemini-tts", authType: "bearer",
      authHeaderName: "", secretEnv: "", endpoint: "/v1beta/models/{model}:generateContent",
      models: ["gemini-3.8-flash-lite-tts"], allowPrivateNetwork: true, enabled: true, apiKey: "sk-test",
    }).expect(201);

    const created = await request(app).post("/api/generations").send({
      channelId: channel.body.data.id,
      model: "gemini-3.8-flash-lite-tts",
      prompt: "第一行标题\n第二行正文",
      ttsVoice: "Kore",
      ttsStyle: "自然、像聊天",
      ttsLanguage: "zh-CN",
    }).expect(202);
    const taskId = created.body.data.id as string;

    let task: Task = created.body.data;
    for (let index = 0; index < 40 && task.status !== "succeeded" && task.status !== "failed"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      task = (await request(app).get(`/api/generations/${taskId}`).expect(200)).body.data;
    }

    expect(task.status).toBe("succeeded");
    expect(task.assets).toHaveLength(1);
    expect(task.assets[0]).toMatchObject({
      mimeType: "audio/wav",
      duration: 1,
      title: "第一行标题 第二行正文",
    });
    expect(mock.submitted()).toMatchObject({
      contents: [{
        role: "user",
        parts: [{ text: "第一行标题\n第二行正文", annotations: [{ type: "speech_metadata", style: "自然、像聊天" }] }],
      }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          languageCode: "zh-CN",
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
        },
      },
    });
    expect(JSON.stringify(mock.submitted())).not.toContain("maxOutputTokens");

    const audio = await request(app).get(task.assets[0]!.url).expect(200);
    expect(audio.headers["content-type"]).toContain("audio/wav");
    expect(Number(audio.headers["content-length"])).toBeGreaterThan(44);

    // 前端下载按钮走 ?download=1，服务端必须回 attachment 而不是内联播放
    const download = await request(app).get(`${task.assets[0]!.url}?download=1`).expect(200);
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect(download.headers["content-type"]).toContain("audio/wav");
  });
});
