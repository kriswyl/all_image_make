import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Jimp, JimpMime } from "jimp";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { AdapterType } from "../src/shared/types";
import { storeInlineVideoImages } from "../src/server/task-video-images";

const asPng = (bytes: Buffer) => `data:image/png;base64,${bytes.toString("base64")}`;
const small = await new Jimp({ width: 300, height: 300, color: 0x2389aaff }).getBuffer(JimpMime.png);
const noise = randomBytes(420 * 420 * 4);
for (let i = 3; i < noise.length; i += 4) noise[i] = 255;
const large = await new Jimp({ data: noise, width: 420, height: 420 }).getBuffer(JimpMime.png);
const mp4 = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109]);
const mediaImage = (bytes: Buffer) => ({ type: "reference_image", url: asPng(bytes) });
const tooLarge = {
  code: "fail_to_fetch_task",
  message: JSON.stringify({ error: { message: "read request body failed: http: request body too large" }, request_id: "trace-1" }),
  data: null,
};

it("video reuse reads retained frame and multipart files independently without submitting upstream", async () => {
  await fixture(async ({ app, context, model, channelId, bodies, uploads }) => {
    const id = randomUUID();
    const fields = await storeInlineVideoImages({
      seedanceVideoMedia: [
        { type: "image_url", role: "last_frame", url: asPng(large) },
        { type: "image_url", role: "first_frame", url: asPng(small) },
      ],
    }, (file, bytes) => writeFile(path.join(context.db.inputsDir, file), bytes), id);
    context.db.createTask({ id, model, channelId, prompt: "首尾帧", status: "failed", input: {
      ...fields, prompt: "首尾帧", seedanceVideoMode: "first-last-frame", duration: 5, resolution: "720p", timeoutMs: 800_000,
    } });
    await rm(path.join(context.db.inputsDir, `${id}-video-image-1.bin`));
    const reuse = (await request(app).get(`/api/generations/${id}/video-reuse`).expect(200)).body.data;
    expect(reuse).toMatchObject({
      snapshot: { mode: "first-last-frame", duration: 5, resolution: "720p" }, timeoutMs: 800_000,
      slots: [{ role: "last_frame", available: false }, { role: "first_frame", available: true }],
    });
    await request(app).get(`/api/generations/${id}/video-reuse/0`).expect(404);
    const first = await request(app).get(`/api/generations/${id}/video-reuse/1`).expect("Content-Type", /image\/png/).expect(200);
    expect(first.body).toEqual(small);

    const referenceId = randomUUID();
    const video = `${referenceId}-reference-1.mp4`;
    const audio = `${referenceId}-reference-audio-1.mp3`;
    await writeFile(path.join(context.db.inputsDir, video), mp4);
    await writeFile(path.join(context.db.inputsDir, audio), "sample");
    context.db.createTask({ id: referenceId, model, channelId, prompt: "参考", status: "succeeded", input: {
      prompt: "参考", seedanceVideoMode: "reference",
      seedanceVideoMedia: [{ type: "image_url", role: "reference_image", url: "https://example.invalid/ref.png" }],
      referenceVideos: [{ relativePath: video, mimeType: "video/mp4", fileName: "scene.mp4" }],
      referenceAudios: [{ relativePath: audio, mimeType: "audio/mpeg", fileName: "speech.mp3" }],
    } });
    const refs = (await request(app).get(`/api/generations/${referenceId}/video-reuse`).expect(200)).body.data;
    expect(refs.slots).toMatchObject([
      { role: "reference_image", available: false },
      { kind: "video", name: "scene.mp4", available: true },
      { kind: "audio", name: "speech.mp3", available: true },
    ]);
    expect(JSON.stringify(refs)).not.toContain("example.invalid");
    await request(app).get(`/api/generations/${referenceId}/video-reuse/1`).expect("Content-Type", /video\/mp4/).expect(200);
    await request(app).get(`/api/generations/${referenceId}/video-reuse/2`).expect("Content-Type", /audio\/mpeg/).expect(200);
    expect(bodies).toEqual([]);
    expect(uploads).toEqual([]);
  }, { seedance: true });
});

async function fixture(run: (mock: ReturnType<typeof createApp> & {
  channelId: string; model: string; bodies: Array<Record<string, unknown>>; uploads: Array<{ type: string; size: number }>;
}) => Promise<void>, options: { seedance?: boolean; adapter?: AdapterType; model?: string; uploadFails?: boolean; responses?: Array<() => Response> } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "chatcanvas-video-image-"));
  const app = createApp({ dataDir });
  const model = options.model ?? (options.seedance ? "sd-2.5" : "MiniMax-H3");
  const adapter = options.adapter ?? (options.seedance ? "seedance-video" : "minimax-video");
  const channel = app.context.db.saveChannel({
    name: "本地模拟", baseUrl: "https://api.tiantoken.com", authType: "none", authHeaderName: "", secretEnv: "",
    adapterType: adapter, endpoint: "",
    uploadEndpoint: "https://imageproxy.example.test/upload", allowPrivateNetwork: true, enabled: true, models: [model],
  });
  const bodies: Array<Record<string, unknown>> = [];
  const uploads: Array<{ type: string; size: number }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "https://imageproxy.example.test/upload") {
      const file = (init?.body as FormData).get("file") as File;
      uploads.push({ type: file.type, size: file.size });
      return options.uploadFails && file.type.startsWith("image/")
        ? Response.json({ error: "offline" }, { status: 502 })
        : Response.json({ url: `https://imageproxy.example.test/files/${uploads.length}` });
    }
    if (init?.method === "POST" && new URL(url).origin === "https://api.tiantoken.com") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return options.responses?.[bodies.length - 1]?.() ?? Response.json(adapter === "kling-video" ? { data: { id: "task_offline" } } : { id: "task_offline" });
    }
    if (url.endsWith("/task_offline") || url.endsWith("/tasks?task_ids=task_offline")) {
      const result = { status: "succeeded", url: "https://imageproxy.example.test/out.mp4" };
      return Response.json(adapter === "kling-video" ? { data: { status: result.status, outputs: [{ url: result.url }] } }
        : { status: result.status, metadata: { url: result.url } });
    }
    if (url === "https://imageproxy.example.test/out.mp4") return new Response(Uint8Array.from(mp4), { headers: { "content-type": "video/mp4" } });
    throw new Error(`Unexpected simulated request: ${url}`);
  }));
  try {
    await run({ ...app, channelId: channel.id, model, bodies, uploads });
  } finally {
    vi.unstubAllGlobals();
    app.context.agent.dispose();
    app.context.db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

it("routes an oversized H3 image batch through the configured uploader before the first submit and preserves order", async () => {
  await fixture(async ({ app, context, model, channelId, bodies, uploads }) => {
    const payload = { model, channelId, prompt: "两张参考图", minimaxVideoMode: "reference", minimaxVideoMedia: [mediaImage(large), mediaImage(large)] };
    const created = await request(app).post("/api/generations/reference-media").field("payload", JSON.stringify(payload))
      .attach("video", mp4, { filename: "clip.mp4", contentType: "video/mp4" }).expect(202);
    const task = await context.runner.waitFor(created.body.data.id, { timeoutMs: 6000 });
    expect(task.status).toBe("succeeded");
    expect(uploads).toEqual([{ type: "video/mp4", size: mp4.length }, { type: "image/png", size: large.length }]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      images: ["https://imageproxy.example.test/files/2", asPng(large)],
      metadata: { videos: ["https://imageproxy.example.test/files/1"] },
    });
    const trace = context.db.listDiagnostics(task.id).find((item) => item.trace?.referenceImages)?.trace?.referenceImages;
    expect(trace?.requestBytes).toBeLessThan(trace!.beforeBytes);
    expect(trace?.images.map(({ transport }) => transport)).toEqual(["uploaded", "inline"]);
    expect(context.db.getTaskRow(task.id)?.inputJson).not.toContain("imageproxy.example.test/files");
  });
});

it("compresses locally when the H3 image upload fails and keeps the source images", async () => {
  await fixture(async ({ app, context, model, channelId, bodies, uploads }) => {
    const created = await request(app).post("/api/generations").send({
      model, channelId, prompt: "保持两张图", minimaxVideoMedia: [mediaImage(large), mediaImage(large)],
    }).expect(202);
    const task = await context.runner.waitFor(created.body.data.id, { timeoutMs: 6000 });
    expect(task.status).toBe("succeeded");
    expect(uploads).toHaveLength(1);
    expect(bodies).toHaveLength(1);
    expect((bodies[0]!.images as string[])[0]).toMatch(/^data:image\/jpeg;/);
    expect(Buffer.byteLength(JSON.stringify(bodies[0]))).toBeLessThan(1024 * 1024);
    expect(context.db.listDiagnostics(task.id).find(({ trace }) => trace?.referenceImages)?.trace?.referenceImages?.images[0])
      .toMatchObject({ transport: "inline", uploadFallback: true, originalBytes: large.length });
  }, { uploadFails: true });
});

it("keeps the H3 first and last frame in their original slots and compresses them without uploading", async () => {
  await fixture(async ({ app, context, model, channelId, bodies, uploads }) => {
    const created = await request(app).post("/api/generations").send({
      model, channelId, prompt: "首尾帧",
      minimaxVideoMedia: [{ type: "last_frame", url: asPng(small) }, { type: "first_frame", url: asPng(large) }],
    }).expect(202);
    const task = await context.runner.waitFor(created.body.data.id, { timeoutMs: 6000 });
    expect(task.status).toBe("succeeded");
    expect(uploads).toHaveLength(0);
    expect(bodies[0]).toMatchObject({ metadata: { first_frame: asPng(large), last_frame: asPng(small) } });

    const oversized = await request(app).post("/api/generations").send({
      model, channelId, prompt: "首尾帧超过内联预算",
      minimaxVideoMedia: [{ type: "last_frame", url: asPng(large) }, { type: "first_frame", url: asPng(large) }],
    }).expect(202);
    expect((await context.runner.waitFor(oversized.body.data.id, { timeoutMs: 6000 })).status).toBe("succeeded");
    expect(uploads).toHaveLength(0);
    expect(bodies[1]).toMatchObject({ metadata: { first_frame: expect.stringMatching(/^data:image\//), last_frame: expect.stringMatching(/^data:image\//) } });
    expect(Buffer.byteLength(JSON.stringify(bodies[1]))).toBeLessThan(1024 * 1024);
  });
});

it.each([
  { name: "nested size rejection", response: () => Response.json(tooLarge, { status: 400 }), attempts: 2 },
  { name: "second body rejection", response: () => Response.json(tooLarge, { status: 413 }), twice: true, attempts: 2 },
  { name: "ambiguous gateway failure", response: () => new Response("Bad Gateway", { status: 502 }), attempts: 1, errorCode: "SUBMISSION_UNKNOWN" },
  { name: "generic invalid parameters", response: () => Response.json({ error: { code: "InvalidParameter" } }, { status: 400 }), attempts: 1 },
  { name: "response with a task ID", response: () => Response.json({ ...tooLarge, data: { task_id: "job" } }, { status: 413 }), attempts: 1 },
])("handles $name without blindly repeating a generation", async ({ response, attempts, twice, errorCode }) => {
  await fixture(async ({ app, context, model, channelId, bodies, uploads }) => {
    const created = await request(app).post("/api/generations").send({
      model, channelId, prompt: "仅一次补发", minimaxVideoMedia: [mediaImage(small)],
    }).expect(202);
    const task = await context.runner.waitFor(created.body.data.id, { timeoutMs: 6000 });
    expect(task.attemptCount).toBe(attempts);
    expect(bodies).toHaveLength(attempts);
    expect(bodies[0]).toMatchObject({ images: [asPng(small)] });
    expect(uploads).toHaveLength(attempts - 1);
    if (attempts === 2) {
      expect(bodies[1]).toMatchObject({ images: ["https://imageproxy.example.test/files/1"] });
      expect(task).toMatchObject(twice ? { status: "failed", errorCode: "UPSTREAM_BODY_TOO_LARGE" } : { status: "succeeded" });
    } else {
      expect(task.status).toBe("failed");
      if (errorCode) expect(task.errorCode).toBe(errorCode);
    }
  }, { responses: twice ? [response, response] : [response] });
});

it("rejects a Seedance image with invalid dimensions before uploading any media", async () => {
  await fixture(async ({ app, context, model, channelId, bodies, uploads }) => {
    const invalid = await new Jimp({ width: 240, height: 480, color: 0x2389aaff }).getBuffer(JimpMime.png);
    const payload = { model, channelId, prompt: "需要一张参考图", seedanceVideoMode: "reference",
      seedanceVideoMedia: [{ type: "image_url", role: "reference_image", url: asPng(invalid) }] };
    const created = await request(app).post("/api/generations/reference-media").field("payload", JSON.stringify(payload))
      .attach("video", mp4, { filename: "clip.mp4", contentType: "video/mp4" }).expect(202);
    const task = await context.runner.waitFor(created.body.data.id, { timeoutMs: 6000 });
    expect(task).toMatchObject({ errorCode: "REFERENCE_IMAGE_INVALID", attemptCount: 0,
      errorMessage: expect.stringMatching(/参考图 1.*240×480.*300/) });
    expect(bodies).toHaveLength(0);
    expect(uploads).toHaveLength(0);
  }, { seedance: true });
});

it("applies Wan 3.0 image dimensions and preserves frame roles and OSS temporary URLs", async () => {
  await fixture(async ({ app, context, model, channelId, bodies, uploads }) => {
    const endpoint = () => request(app).post("/api/generations");
    const transparent = await new Jimp({ width: 240, height: 1920, color: 0x2389aa00 }).getBuffer(JimpMime.png);
    const tailUrl = "oss://dashscope-instant/tail.png";
    const submit = (bytes: Buffer) => endpoint().send({ model, channelId, prompt: "首尾帧", wanVideoMode: "first-last-frame", wanVideoMedia: [
      { type: "first_frame", url: asPng(bytes) }, { type: "last_frame", url: tailUrl },
    ] }).expect(202);
    const narrow = await new Jimp({ width: 239, height: 480, color: 0x2389aaff }).getBuffer(JimpMime.png);
    const rejected = await submit(narrow);
    expect(await context.runner.waitFor(rejected.body.data.id, { timeoutMs: 6000 })).toMatchObject({
      attemptCount: 0, errorCode: "REFERENCE_IMAGE_INVALID", errorMessage: expect.stringMatching(/首帧.*239×480.*240/),
    });
    expect(bodies).toHaveLength(0);

    const submitted = await submit(transparent);
    const task = await context.runner.waitFor(submitted.body.data.id, { timeoutMs: 6000 });
    expect(task.status).toBe("succeeded");
    expect(uploads).toHaveLength(0);
    expect(bodies[0]).toMatchObject({ input: { media: [
      { type: "first_frame", url: expect.stringMatching(/^data:image\/jpeg;/) }, { type: "last_frame", url: tailUrl },
    ] } });
    expect(context.db.listDiagnostics(task.id).find(({ trace }) => trace?.referenceImages)?.trace?.referenceImages?.images).toMatchObject([
      { role: "first_frame", width: 240, height: 1920, transport: "inline" }, { role: "last_frame", transport: "url" },
    ]);
  }, { adapter: "wan-video", model: "wan3.0-video" });
});

it("compresses Grok multipart images to a shared budget and retries an explicit rejection with a smaller body", async () => {
  await fixture(async ({ app, context, model, channelId, bodies, uploads }) => {
    const submit = request(app).post("/api/generations").field("payload", JSON.stringify({ model, channelId, prompt: "三张图" }));
    for (let i = 0; i < 3; i += 1) submit.attach("referenceImages", large, { filename: `image-${i}.png`, contentType: "image/png" });
    const created = await submit.expect(202);
    const task = await context.runner.waitFor(created.body.data.id, { timeoutMs: 6000 });
    expect(task).toMatchObject({ status: "succeeded", attemptCount: 2 });
    expect(uploads).toHaveLength(0);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect((body.reference_images as Array<{ url: string }>).map(({ url }) => url)).toEqual([
      expect.stringMatching(/^data:image\//), expect.stringMatching(/^data:image\//), expect.stringMatching(/^data:image\//),
    ]);
    const diagnostics = context.db.listDiagnostics(task.id).flatMap(({ trace }) => trace?.referenceImages ? [trace.referenceImages] : []).reverse();
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics[0]!.requestBytes).toBeLessThan(diagnostics[0]!.beforeBytes);
    expect(diagnostics[0]!.requestBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(diagnostics[1]!.requestBytes).toBeLessThan(diagnostics[0]!.requestBytes);
    expect(diagnostics[0]!.images.map(({ transport }) => transport)).toEqual(["inline", "inline", "inline"]);
  }, { adapter: "grok-video", model: "grok-imagine-video", responses: [() => Response.json(tooLarge, { status: 400 })] });
});

it("keeps Kling motion-control character images inline and sends the uploaded video in its own slot", async () => {
  await fixture(async ({ app, context, model, channelId, bodies, uploads }) => {
    const created = await request(app).post("/api/generations/reference-video").field("payload", JSON.stringify({
      model, channelId, prompt: "跟随动作", klingVideoMode: "motion-control", klingVideoMedia: [{ type: "image", url: asPng(large) }],
    })).attach("file", mp4, { filename: "clip.mp4", contentType: "video/mp4" }).expect(202);
    const task = await context.runner.waitFor(created.body.data.id, { timeoutMs: 6000 });
    expect(task.status).toBe("succeeded");
    expect(uploads).toEqual([{ type: "video/mp4", size: mp4.length }]);
    expect(bodies[0]).toMatchObject({ contents: [
      { type: "prompt" }, { type: "image", url: asPng(large) }, { type: "video", url: "https://imageproxy.example.test/files/1" },
    ] });
    expect(context.db.listDiagnostics(task.id).find(({ trace }) => trace?.referenceImages)?.trace?.referenceImages?.images)
      .toMatchObject([{ role: "image", originalBytes: large.length, transport: "inline" }]);
  }, { adapter: "kling-video", model: "kling-3.0" });
});
