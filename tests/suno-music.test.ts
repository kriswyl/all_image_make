import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/server/app";
import type { Task } from "../src/shared/types";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const tracks = [
  {
    id: "track-1",
    status: "complete",
    title: "雨后的城",
    audio_url: "/audio/one.m4a",
    image_url: "/cover/one.png",
    metadata: { duration: 183.52, tags: "民谣, 温暖", prompt: "[Verse]\n雨后的城，灯光慢慢亮" },
  },
  {
    id: "track-2",
    status: "complete",
    title: "晚风",
    audio_url: "/audio/two.m4a",
    image_url: "/cover/two.png",
    metadata: { duration: 149.6, tags: "民谣, 轻快" },
  },
];

async function startMock() {
  let submitted: Record<string, unknown> | null = null;
  let polls = 0;
  let origin = "";
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/api/queue/makeAiMusic") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        submitted = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 200, data: [148787578, 148787581], success: true, message: "请求成功" }));
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/midjourney/drawInfo4") {
      polls += 1;
      const done = polls >= 2;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        code: 200,
        success: true,
        message: "请求成功",
        data: {
          id: Number(url.searchParams.get("id")),
          custom_id: "track-1",
          status: done ? 3 : 2,
          progress: done ? 100 : 0,
          errormsg: null,
          taskName: "音乐创作",
          fileInfo: done ? {
            bigUrl: new URL("/cover/one.png", origin).toString(),
            mp3Url: new URL("/audio/one.m4a", origin).toString(),
            duration: 183.52,
            thumbImg: new URL("/cover/one.png", origin).toString(),
          } : {},
          extend: JSON.stringify(tracks.map((track) => ({
            ...track,
            audio_url: new URL(track.audio_url, origin).toString(),
            image_url: new URL(track.image_url, origin).toString(),
          }))),
        },
      }));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/audio/")) {
      res.writeHead(200, { "Content-Type": "audio/x-m4a" });
      res.end(Buffer.from("fake-m4a-bytes"));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/cover/")) {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(Buffer.from(pngBase64, "base64"));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server did not start");
  origin = `http://127.0.0.1:${address.port}`;
  return { server, origin, submitted: () => submitted };
}

describe("Suno 音乐端到端", () => {
  it("提交灵感模式 → 轮询 → 两首音频和封面全部落盘", async () => {
    const mock = await startMock();
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-suno-test-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const channel = await request(app).post("/api/channels").send({
      name: "Suno Mock", baseUrl: mock.origin, adapterType: "suno-music", authType: "bearer",
      authHeaderName: "", secretEnv: "", endpoint: "/api/queue/makeAiMusic", models: ["suno_damobi_music"],
      allowPrivateNetwork: true, enabled: true, apiKey: "sk-test",
    }).expect(201);

    const created = await request(app).post("/api/generations").send({
      channelId: channel.body.data.id,
      model: "suno_damobi_music",
      prompt: "雨后的城市，温暖民谣",
      musicMode: "inspiration",
      musicVersion: "chirp-v3-5",
      musicInstrumental: false,
    }).expect(202);
    const taskId = created.body.data.id as string;

    let task: Task = created.body.data;
    for (let index = 0; index < 40 && task.status !== "succeeded" && task.status !== "failed"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      task = (await request(app).get(`/api/generations/${taskId}`).expect(200)).body.data;
    }

    expect(task.status).toBe("succeeded");
    expect(task.assets).toHaveLength(2);
    expect(task.assets.map((asset) => asset.title)).toEqual(["雨后的城", "晚风"]);
    expect(task.assets.map((asset) => asset.duration)).toEqual([183.52, 149.6]);
    expect(task.assets.every((asset) => asset.mimeType === "audio/x-m4a")).toBe(true);
    expect(task.assets.every((asset) => Boolean(asset.thumbUrl))).toBe(true);
    expect(task.assets[0]!.lyrics).toContain("雨后的城");
    expect(task.assets.map((asset) => asset.remoteClipId)).toEqual(["track-1", "track-2"]);
    expect(task.assets[0]!.tags).toContain("民谣");
    expect(mock.submitted()).toMatchObject({
      gpt_description_prompt: "雨后的城市，温暖民谣",
      mv: "chirp-v3-5",
      make_instrumental: false,
    });

    for (const asset of task.assets) {
      const audio = await request(app).get(asset.url).expect(200);
      expect(audio.headers["content-type"]).toContain("audio/");
      const thumb = await request(app).get(asset.thumbUrl!).expect(200);
      expect(thumb.headers["content-type"]).toContain("image/");
    }

    // 历史清空按音乐范围只删音乐任务
    const cleared = await request(app).delete("/api/generations?scope=audio&keepFiles=0").expect(200);
    expect(cleared.body.data.deleted).toBe(1);
  });
});
