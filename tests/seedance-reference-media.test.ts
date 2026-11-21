import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { Jimp, JimpMime } from "jimp";
import { afterEach, describe, expect, it, vi } from "vitest";

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
const TINY_PNG = `data:image/png;base64,${(await new Jimp({ width: 300, height: 300, color: 0x714168ff }).getBuffer(JimpMime.png)).toString("base64")}`;

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
      .field("payload", JSON.stringify({
        channelId: channel.id, model: "sd-2.5", prompt: "参考混合素材", seedanceVideoMode: "reference",
        seedanceVideoMedia: [{ type: "image_url", url: TINY_PNG, role: "reference_image" }],
      }))
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
    expect(content.find(item => item.type === "image_url")).toMatchObject({
      image_url: { url: TINY_PNG }, role: "reference_image",
    });

    // 参考素材落库是数组：Seedance 可以带多段，旧任务的单段字段仍然能读
    const stored = JSON.parse(context.db.getTaskRow(created.id)!.inputJson);
    expect(stored.seedanceVideoMedia[0]).toMatchObject({ inlineImage: { mimeType: "image/png" } });
    expect(stored.referenceVideos.map((item: { fileName: string }) => item.fileName)).toEqual(["shot.mp4"]);
    expect(stored.referenceAudios.map((item: { fileName: string }) => item.fileName)).toEqual(["bgm.mp3"]);
    expect(stored.referenceAudios[0].relativePath).toMatch(/-reference-audio-1\.mp3$/);
    expect(await fs.readFile(path.join(context.db.inputsDir, stored.referenceAudios[0].relativePath))).toEqual(mp3);
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

describe("视频提交和参考图存储", () => {
  async function makeSeedanceApp() {
    const submitted: Array<Record<string, unknown>> = [];
    const uploads: string[] = [];
    let origin = "";
    origin = await startMock((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/upload") {
          uploads.push("hit");
          res.end(JSON.stringify({ url: `${origin}/files/inline.png` }));
          return;
        }
        if (req.method === "POST") {
          submitted.push(JSON.parse(Buffer.concat(chunks).toString()));
          res.end(JSON.stringify(req.url?.includes("kling") ? { data: { id: "remote-1" } } : { id: "remote-1" }));
          return;
        }
        if (req.url?.startsWith("/tasks?")) {
          res.end(JSON.stringify({ data: [{ status: "failed", message: "fixture finished" }] }));
          return;
        }
        res.end(JSON.stringify({ status: "failed", error: { message: "fixture finished" } }));
      });
    });
    const { app, context } = await makeApp("seedance-pure-image-");
    const channel = context.db.saveChannel({
      name: "Seedance", baseUrl: origin, adapterType: "seedance-video", authType: "none", authHeaderName: "",
      secretEnv: "", endpoint: "/api/v3/contents/generations/tasks", uploadEndpoint: `${origin}/upload`,
      models: ["sd-2.5", "sd-2.0"], allowPrivateNetwork: true, enabled: true,
    });
    return { app, context, channel, submitted, uploads };
  }

  it("只放一张首帧图、multipart 里没有任何文件，也能建任务", async () => {
    const { app, context, channel, submitted, uploads } = await makeSeedanceApp();
    const created = (await request(app).post("/api/generations/reference-media")
      .field("payload", JSON.stringify({
        channelId: channel.id,
        model: "sd-2.5",
        prompt: "纯图参考，不出声",
        seedanceVideoMode: "first-frame",
        seedanceVideoMedia: [{ type: "image_url", url: TINY_PNG, role: "first_frame" }],
      }))
      .expect(202)).body.data;

    await context.runner.waitFor(created.id, { timeoutMs: 6000 });

    // 内联图不需要图床：一次上传都不该发生
    expect(uploads).toHaveLength(0);
    expect(submitted).toHaveLength(1);
    const content = submitted[0].content as Array<Record<string, unknown>>;
    expect(content.find((item) => item.type === "image_url")).toMatchObject({
      image_url: { url: TINY_PNG },
      role: "first_frame",
    });
  });

  it("二点零的纯图也一样能过（不是 2.5 特有）", async () => {
    const { app, context, channel } = await makeSeedanceApp();
    const created = (await request(app).post("/api/generations/reference-media")
      .field("payload", JSON.stringify({
        channelId: channel.id,
        model: "sd-2.0",
        prompt: "纯图",
        seedanceVideoMode: "first-frame",
        seedanceVideoMedia: [{ type: "image_url", url: TINY_PNG, role: "first_frame" }],
      }))
      .expect(202)).body.data;
    await context.runner.waitFor(created.id, { timeoutMs: 6000 });
    expect(created.id).toBeTruthy();
  });

  it.each([
    { mode: "text-to-video", roles: [] },
    { mode: "first-frame", roles: ["first_frame"] },
    { mode: "first-last-frame", roles: ["first_frame", "last_frame"] },
    { mode: "reference", roles: Array<string>(30).fill("reference_image") },
  ])("JSON 路径支持 $mode，按原始角色和顺序出网", async ({ mode, roles }) => {
    const { app, context, channel, submitted, uploads } = await makeSeedanceApp();
    const urls = roles.map((_, index) => index % 2 ? "https://example.com/reference.png" : TINY_PNG);
    const response = await request(app).post("/api/generations").send({
      channelId: channel.id, model: "sd-2.5", prompt: "颜色流动", seedanceVideoMode: mode,
      seedanceVideoMedia: roles.map((role, index) => ({ type: "image_url", url: urls[index], role })),
    }).expect(202);
    await context.runner.waitFor(response.body.data.id, { timeoutMs: 6000 });
    expect(submitted[0]?.content).toEqual([
      { type: "text", text: "颜色流动" },
      ...roles.map((role, index) => ({ type: "image_url", role, image_url: { url: urls[index] } })),
    ]);
    expect(uploads).toEqual([]);
  });

  it("重试可读取旧版内联图片，新任务只存文件元数据，删除任务会清理文件", async () => {
    const { app, context, channel, submitted } = await makeSeedanceApp();
    const unpadded = TINY_PNG.replace(/=+$/, "");
    const input = {
      channelId: channel.id, model: "sd-2.5", prompt: "兼容旧任务", seedanceVideoMode: "first-last-frame",
      seedanceVideoMedia: [
        { type: "image_url", url: TINY_PNG, role: "first_frame" },
        { type: "image_url", url: unpadded, role: "last_frame" },
      ],
    };
    const oldId = "legacy-video-reference";
    context.db.createTask({ id: oldId, channelId: channel.id, model: input.model, prompt: input.prompt, input, status: "failed" });
    const first = (await request(app).post(`/api/generations/${oldId}/retry`).expect(202)).body.data;
    await context.runner.waitFor(first.id, { timeoutMs: 6000 });
    const firstRow = context.db.getTaskRow(first.id)!;
    expect(firstRow.inputJson).not.toContain("data:image");
    const stored = JSON.parse(firstRow.inputJson).seedanceVideoMedia;
    const files = stored.map((entry: { inlineImage: { relativePath: string } }) => entry.inlineImage.relativePath);
    expect(await fs.readFile(path.join(context.db.inputsDir, files[0]))).toEqual(Buffer.from(TINY_PNG.split(",")[1]!, "base64"));
    expect(first.inputParameters.media[0]).toMatchObject({ role: "first_frame", inlineBytes: expect.any(Number) });
    expect(JSON.stringify(first.inputParameters)).not.toContain(files[0]);
    const second = (await request(app).post(`/api/generations/${first.id}/retry`).expect(202)).body.data;
    await context.runner.waitFor(second.id, { timeoutMs: 6000 });
    expect(submitted.map((request) => request.content)).toEqual(Array.from({ length: 2 }, () => [
      { type: "text", text: input.prompt },
      ...input.seedanceVideoMedia.map(({ type, role, url }) => ({ type, role, image_url: { url } })),
    ]));
    await request(app).delete(`/api/generations/${first.id}`).expect(200);
    for (const file of files) await expect(fs.stat(path.join(context.db.inputsDir, file))).rejects.toMatchObject({ code: "ENOENT" });
    const secondFile = JSON.parse(context.db.getTaskRow(second.id)!.inputJson).seedanceVideoMedia[0].inlineImage.relativePath;
    await fs.unlink(path.join(context.db.inputsDir, secondFile));
    const missing = await request(app).post(`/api/generations/${second.id}/retry`).expect(400);
    expect(missing.body.error.code).toBe("REFERENCE_IMAGE_MISSING");
    expect(submitted).toHaveLength(2);
    expect(context.db.getTaskRow(oldId)?.inputJson).toContain(TINY_PNG);
  });

  it("任务建档失败会回收已写入的视频参考图", async () => {
    const { app, context, channel, submitted } = await makeSeedanceApp();
    vi.spyOn(context.db, "createTask").mockImplementationOnce(() => { throw new Error("fixture database write failed"); });
    await request(app).post("/api/generations").send({
      channelId: channel.id, model: "sd-2.5", prompt: "测试回滚", seedanceVideoMode: "first-frame",
      seedanceVideoMedia: [{ type: "image_url", url: TINY_PNG, role: "first_frame" }],
    }).expect(500);
    expect(await fs.readdir(context.db.inputsDir)).toEqual([]);
    expect(submitted).toEqual([]);
  });

  it("仍在写文件前检查内联预算，Data URL 大小写不影响限额", async () => {
    const { app, context, channel, submitted } = await makeSeedanceApp();
    const response = await request(app).post("/api/generations").send({
      channelId: channel.id, model: "sd-2.5", prompt: "超过请求预算", seedanceVideoMode: "first-frame",
      seedanceVideoMedia: [{ type: "image_url", url: "DATA:image/png;base64," + "A".repeat(40 * 1024 * 1024), role: "first_frame" }],
    }).expect(400);
    expect(response.body.error.message).toContain("40 MB");
    expect(await fs.readdir(context.db.inputsDir)).toEqual([]);
    expect(submitted).toEqual([]);
  });

  it.each([
    { adapterType: "wan-video", model: "wan3.0-video", field: "wanVideoMedia", modeField: "wanVideoMode" },
    { adapterType: "kling-video", model: "kling-3.0-omni", field: "klingVideoMedia", modeField: "klingVideoMode" },
  ] as const)("$adapterType 的参考图也从文件恢复为原始载荷", async ({ adapterType, model, field, modeField }) => {
    const { app, context, channel, submitted } = await makeSeedanceApp();
    const videoChannel = context.db.saveChannel({
      name: adapterType, baseUrl: channel.baseUrl, adapterType, authType: "none", authHeaderName: "",
      secretEnv: "", endpoint: "/video", models: [model], allowPrivateNetwork: true, enabled: true,
    });
    const created = (await request(app).post("/api/generations").send({
      channelId: videoChannel.id, model, prompt: "开始", [modeField]: "first-frame",
      [field]: [{ type: "first_frame", url: TINY_PNG }],
    }).expect(202)).body.data;
    await context.runner.waitFor(created.id, { timeoutMs: 6000 });
    const row = context.db.getTaskRow(created.id)!;
    expect(row.inputJson).not.toContain("data:image");
    expect(JSON.parse(row.inputJson)[field][0]).toMatchObject({
      type: "first_frame", inlineImage: { mimeType: "image/png" },
    });
    expect(JSON.stringify(submitted[0])).toContain(TINY_PNG);
  });

  it("Grok 的 JSON 和 multipart 都按实际参考图数量校验 7 张上限", async () => {
    const { app, context, channel, submitted } = await makeSeedanceApp();
    const model = "grok-imagine-video";
    const grokChannel = context.db.saveChannel({
      name: "Grok", baseUrl: channel.baseUrl, adapterType: "grok-video", authType: "none", authHeaderName: "",
      secretEnv: "", endpoint: "/v1/videos/generations", models: [model], allowPrivateNetwork: true, enabled: true,
    });
    const input = { channelId: grokChannel.id, model, prompt: "参考图校验" };
    const image = { base64: TINY_PNG.split(",")[1]!, mimeType: "image/png", fileName: "grok.png" };
    const json = (count: number) => request(app).post("/api/generations").send({
      ...input, referenceImages: Array(count).fill(image),
    });
    function multipart(count: number) {
      let call = request(app).post("/api/generations").field("payload", JSON.stringify(input));
      for (let index = 0; index < count; index += 1) call = call.attach("referenceImages", Buffer.from(image.base64, "base64"), `ref-${index}.png`);
      return call;
    }
    for (const make of [json, multipart]) {
      const over = await make(8).expect(400);
      expect(over.body.error).toMatchObject({ code: "MODE_MEDIA_LIMIT", message: expect.stringContaining("7 张") });
      const allowed = (await make(7).expect(202)).body.data;
      await context.runner.waitFor(allowed.id, { timeoutMs: 6000 });
    }
    expect(submitted.map((body) => body.reference_images)).toEqual(Array.from({ length: 2 }, () => Array(7).fill({ url: TINY_PNG })));
  });

  it("素材真的为空时仍然拒绝，码是 UPLOAD_EMPTY", async () => {
    const { app, channel } = await makeSeedanceApp();
    const response = await request(app).post("/api/generations/reference-media")
      .field("payload", JSON.stringify({ channelId: channel.id, model: "sd-2.5", prompt: "空的", seedanceVideoMode: "first-frame" }))
      .expect(400);
    expect(response.body.error.code).toBe("UPLOAD_EMPTY");
  });

  it("连 payload 都没带也是 UPLOAD_EMPTY，而不是 INVALID_INPUT", async () => {
    const { app } = await makeSeedanceApp();
    const response = await request(app).post("/api/generations/reference-media").expect(400);
    expect(response.body.error.code).toBe("UPLOAD_EMPTY");
  });
});
