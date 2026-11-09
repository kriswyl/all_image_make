import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp, type AppContext } from "../src/server/app";
import { audioExtension } from "../src/server/tasks";
import { validateReferenceMedia } from "../src/server/reference-video";
import { AppError } from "../src/server/app-error";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function startMock(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("监听失败");
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${address.port}`;
}

/** 最小的 MP4 / MP3 头，够通过签名校验即可。 */
const mp4 = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const mp3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xfb]);

async function makeApp(prefix: string) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const { app, context } = createApp({ dataDir });
  cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });
  return { app, context };
}

describe("Seedance 参考视频 / 音频：与万相同一条图床上传链路", () => {
  it("本地视频与音频都先上传换公网地址，再进 content 数组", async () => {
    const uploads: Array<{ name: string; size: number }> = [];
    const submitted: Array<Record<string, unknown>> = [];
    let origin = "";
    origin = await startMock((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/upload") {
          const name = /filename="([^"]+)"/.exec(body.toString("latin1"))?.[1] ?? "unknown";
          uploads.push({ name, size: body.length });
          res.end(JSON.stringify({ url: `${origin}/files/${uploads.length}-${name}` }));
          return;
        }
        if (req.method === "POST") {
          submitted.push(JSON.parse(body.toString()));
          res.end(JSON.stringify({ id: "remote-1" }));
          return;
        }
        // 轮询直接给失败，避免测试等真实进度
        res.end(JSON.stringify({ status: "failed", error: { message: "fixture finished" } }));
      });
    });

    const { app, context } = await makeApp("seedance-reference-media-");
    const channel = context.db.saveChannel({
      name: "Seedance", baseUrl: origin, adapterType: "seedance-video", authType: "none", authHeaderName: "",
      secretEnv: "", endpoint: "/api/v3/contents/generations/tasks", uploadEndpoint: `${origin}/upload`,
      models: ["sd-2.5"], allowPrivateNetwork: true, enabled: true,
    });

    const created = (await request(app).post("/api/generations/reference-media")
      .field("payload", JSON.stringify({ channelId: channel.id, model: "sd-2.5", prompt: "参考这两段素材", seedanceVideoMode: "reference" }))
      .attach("video", mp4, { filename: "shot.mp4", contentType: "video/mp4" })
      .attach("audio", mp3, { filename: "bgm.mp3", contentType: "audio/mpeg" })
      .expect(202)).body.data;

    await context.runner.waitFor(created.id, { timeoutMs: 6000 });

    expect(uploads).toHaveLength(2);
    expect(uploads[0].name).toBe("shot.mp4");
    expect(uploads[1].name).toBe("bgm.mp3");
    expect(submitted).toHaveLength(1);
    const content = submitted[0].content as Array<Record<string, unknown>>;
    expect(content.find(item => item.type === "video_url")).toMatchObject({
      video_url: { url: `${origin}/files/1-shot.mp4` }, role: "reference_video",
    });
    expect(content.find(item => item.type === "audio_url")).toMatchObject({
      audio_url: { url: `${origin}/files/2-bgm.mp3` }, role: "reference_audio",
    });
    // 本地文件不进请求体，落地的是公网地址
    expect(JSON.stringify(submitted[0])).not.toContain("data:");

    const stored = JSON.parse(context.db.getTaskRow(created.id)!.inputJson);
    expect(stored.referenceVideo.fileName).toBe("shot.mp4");
    expect(stored.referenceAudio.fileName).toBe("bgm.mp3");
    expect(stored.referenceAudio.relativePath).toMatch(/-reference-audio\.mp3$/);
    expect(await fs.readFile(path.join(context.db.inputsDir, stored.referenceAudio.relativePath))).toEqual(mp3);
  });

  it("重试会重新上传同一份本地素材（图床链接可能过期）", async () => {
    let uploads = 0;
    const submitted: Array<Record<string, unknown>> = [];
    let origin = "";
    origin = await startMock((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/upload") { uploads += 1; res.end(JSON.stringify({ url: `${origin}/files/${uploads}.mp3` })); return; }
        if (req.method === "POST") { submitted.push(JSON.parse(Buffer.concat(chunks).toString())); res.end(JSON.stringify({ id: `remote-${submitted.length}` })); return; }
        res.end(JSON.stringify({ status: "failed", error: { message: "fixture finished" } }));
      });
    });

    const { app, context } = await makeApp("seedance-reference-audio-retry-");
    const channel = context.db.saveChannel({
      name: "Seedance", baseUrl: origin, adapterType: "seedance-video", authType: "none", authHeaderName: "",
      secretEnv: "", endpoint: "/api/v3/contents/generations/tasks", uploadEndpoint: `${origin}/upload`,
      models: ["sd-2.5"], allowPrivateNetwork: true, enabled: true,
    });

    const created = (await request(app).post("/api/generations/reference-media")
      .field("payload", JSON.stringify({ channelId: channel.id, model: "sd-2.5", prompt: "只有音频", seedanceVideoMode: "reference" }))
      .attach("audio", mp3, { filename: "voice.mp3", contentType: "audio/mpeg" })
      .expect(202)).body.data;
    await context.runner.waitFor(created.id, { timeoutMs: 6000 });

    const retried = (await request(app).post(`/api/generations/${created.id}/retry`).expect(202)).body.data;
    await context.runner.waitFor(retried.id, { timeoutMs: 6000 });
    expect(uploads).toBe(2);
    expect(submitted.map(item => (item.content as Array<Record<string, unknown>>).find(part => part.type === "audio_url")))
      .toMatchObject([
        { audio_url: { url: `${origin}/files/1.mp3` } },
        { audio_url: { url: `${origin}/files/2.mp3` } },
      ]);
  });

  it("非参考模式提交本地音频时明确拒绝", async () => {
    const origin = await startMock((_req, res) => { res.writeHead(404); res.end(); });
    const { app, context } = await makeApp("seedance-audio-reject-");
    const channel = context.db.saveChannel({
      name: "Seedance", baseUrl: origin, adapterType: "seedance-video", authType: "none", authHeaderName: "",
      secretEnv: "", endpoint: "/api/v3/contents/generations/tasks", uploadEndpoint: `${origin}/upload`,
      models: ["sd-2.5"], allowPrivateNetwork: true, enabled: true,
    });
    const response = await request(app).post("/api/generations/reference-media")
      .field("payload", JSON.stringify({ channelId: channel.id, model: "sd-2.5", prompt: "首帧", seedanceVideoMode: "first-frame" }))
      .attach("audio", mp3, { filename: "voice.mp3", contentType: "audio/mpeg" })
      .expect(400);
    expect(response.body.error.code).toBe("REFERENCE_AUDIO_UNSUPPORTED");
  });
});

describe("参考音频校验", () => {
  it("按容器校验签名，并给出落盘扩展名", () => {
    expect(() => validateReferenceMedia({ buffer: mp3, mimetype: "audio/mpeg", originalname: "a.mp3" }, "audio")).not.toThrow();
    expect(() => validateReferenceMedia({ buffer: Buffer.from("not-audio-at-all"), mimetype: "audio/mpeg", originalname: "a.mp3" }, "audio"))
      .toThrow(AppError);
    expect(() => validateReferenceMedia({ buffer: mp3, mimetype: "image/png", originalname: "a.png" }, "audio")).toThrow(/MP3/);
    expect(audioExtension("audio/mpeg")).toBe("mp3");
    expect(audioExtension("audio/wav")).toBe("wav");
    expect(audioExtension("audio/mp4")).toBe("m4a");
    expect(audioExtension("audio/aac")).toBe("aac");
  });
});
