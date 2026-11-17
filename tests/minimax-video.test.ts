import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { buildGenerationRequest } from "../src/server/adapters";
import { prepareNativeVideo } from "../src/server/chat-tools/native-video";
import { generateVideo } from "../src/server/agent-tools/video";
import { buildCapabilityAliases } from "../src/server/capabilities";
import { withConfirmedVideoSelection } from "../src/server/agent-confirm";
import { defaultVideoDraft, reconcileVideoDraft } from "../src/shared/video-draft";
import { referenceMediaLimits, videoModeSpec, videoModesFor } from "../src/shared/video-modes";
import type { BoardDoc, BoardNode } from "../src/shared/board";
import type { GenerationInput } from "../src/shared/types";

const model = "MiniMax-H3";
const adapter = "minimax-video";
const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const first = `data:image/png;base64,${pngBytes.toString("base64")}`;
const last = "data:image/png;base64,dGFpbA==";
const audioBytes = Buffer.from("RIFFxxxxWAVEfmt ");
const audio = `data:audio/wav;base64,${audioBytes.toString("base64")}`;
const video = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup() {
  const calls: Array<{ path: string; body: Record<string, unknown>; method: string }> = [];
  const uploaded: string[] = [];
  let origin = "";
  let failNextPoll = false;
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    res.setHeader("content-type", "application/json");
    if (url === "/upload" && req.method === "POST") {
      uploaded.push(/filename="([^"]+)"/.exec(raw)?.[1] ?? "");
      res.end(JSON.stringify({ url: `https://cdn.example.test/reference-${uploaded.length}.mp4` }));
    } else if (url === "/asset" && req.method === "GET") {
      res.setHeader("content-type", "video/mp4");
      res.end(video);
    } else {
      calls.push({ path: url, method: req.method ?? "", body: raw ? JSON.parse(raw) : {} });
      if (url === "/v1/video/generations" && req.method === "POST") {
        res.end(JSON.stringify({ id: "task_h3", task_id: "task_h3", status: "queued", progress: 0 }));
      } else if (url === "/v1/videos/task_h3") {
        if (failNextPoll) {
          failNextPoll = false;
          res.end(JSON.stringify({ status: "failed", error: { message: "upstream fixture failure" } }));
        } else {
          // No file extension, as with a signed download endpoint.
          res.end(JSON.stringify({ status: "completed", progress: 100, metadata: { url: `${origin}/asset` } }));
        }
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock did not start");
  origin = `http://127.0.0.1:${address.port}`;
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-h3-"));
  const { app, context } = createApp({ dataDir });
  cleanups.push(async () => {
    context.db.close();
    await fs.rm(dataDir, { force: true, recursive: true });
  });
  const api = request(app);
  const registered = await api.post("/api/channels").send({
    name: "MiniMax H3", baseUrl: origin, adapterType: adapter, authType: "none",
    models: [model], uploadEndpoint: `${origin}/upload`, allowPrivateNetwork: true, enabled: true,
  }).expect(201);
  const channel = context.db.getChannel(registered.body.data.id)!;
  const input = { channelId: channel.id, model, prompt: "一只猫在窗台上晒太阳" };
  return {
    api, context, channel, input, calls, uploaded,
    failPollOnce() { failNextPoll = true; },
    submissions() { return calls.filter(({ method }) => method === "POST").map(({ body }) => body); },
    settle: (id: string) => context.runner.waitFor(id, { timeoutMs: 6000 }),
  };
}

it("shares the H3 modes and conservative defaults", () => {
  expect(videoModesFor(adapter, model).map(({ id }) => id)).toEqual(["prompt", "frames"]);
  const limits = referenceMediaLimits(adapter, model, videoModeSpec(adapter, model, "reference"));
  expect(limits).toEqual({ videos: 3, audios: 3, total: 12, audioNeedsVisual: true });
  const draft = defaultVideoDraft(adapter, "prompt");
  expect(draft.resolution).toBe("768P");
  expect(reconcileVideoDraft({ ...draft, ratio: "9:16", resolution: "1080P" }, { adapter, model, mode: "frames" }).draft)
    .toMatchObject({ ratio: "adaptive", resolution: "768P", audio: false });
});

it("uses the relay contract in all four modes with explicit roles and downloads metadata.url", async () => {
  const h3 = await setup();
  const cases: Array<{ input: Partial<GenerationInput>; body: Record<string, unknown> }> = [
    { input: { ratio: "adaptive", audio: false, duration: 4, seed: 1, rawParameters: { generate_audio: false } },
      body: { duration: 4, metadata: { resolution: "768P", ratio: "16:9" } } },
    { input: { minimaxVideoMode: "first-frame", ratio: "9:16", resolution: "2K", minimaxVideoMedia: [{ type: "first_frame", url: first }] },
      body: { duration: 5, metadata: { resolution: "2K", first_frame: first } } },
    { input: { minimaxVideoMode: "first-last-frame", minimaxVideoMedia: [{ type: "last_frame", url: last }, { type: "first_frame", url: first }] },
      body: { duration: 5, metadata: { resolution: "768P", first_frame: first, last_frame: last } } },
    { input: { minimaxVideoMode: "reference", minimaxVideoMedia: [{ type: "reference_image", url: first }, { type: "audio", url: audio }] },
      body: { duration: 5, images: [first], metadata: { resolution: "768P", audios: [audio] } } },
    {
      input: {
        minimaxVideoMode: "reference", duration: 8, ratio: "adaptive", resolution: "2K",
        minimaxVideoMedia: [
          { type: "reference_image", url: "https://example.com/person.jpg" },
          { type: "video", url: "https://example.com/motion.mp4" },
          { type: "audio", url: "https://example.com/voice.wav" },
        ],
      },
      body: {
        duration: 8,
        images: ["https://example.com/person.jpg"],
        metadata: {
          resolution: "2K", ratio: "adaptive",
          videos: ["https://example.com/motion.mp4"], audios: ["https://example.com/voice.wav"],
        },
      },
    },
  ];
  for (const [index, entry] of cases.entries()) {
    const payload = { ...h3.input, ...entry.input };
    const expected = { model, prompt: payload.prompt, ...entry.body };
    expect(buildGenerationRequest(h3.channel, payload, "").body).toEqual(expected);
    const result = await h3.api.post("/api/generations").send(payload).expect(202);
    const task = await h3.settle(result.body.data.id);
    expect(task).toMatchObject({ status: "succeeded", assets: [{ mimeType: "video/mp4" }] });
    expect(h3.calls[index * 2]).toMatchObject({ path: "/v1/video/generations", body: expected });
    expect(h3.calls[index * 2 + 1]?.path).toBe("/v1/videos/task_h3");
    expect(task.inputParameters).toMatchObject({ nativeAudio: true });
    expect(h3.context.db.getTaskRow(task.id)?.inputJson).not.toContain("data:");
    expect(h3.context.db.getTaskRow(task.id)?.effectiveJson).not.toContain("data:");
  }
  expect(h3.uploaded).toEqual([]);
});

it("uploads all local videos, restores inline image and audio on retry, and never uploads audio", async () => {
  const h3 = await setup();
  h3.failPollOnce();
  const created = await h3.api.post("/api/generations/reference-media").field("payload", JSON.stringify({
    ...h3.input,
    minimaxVideoMode: "reference",
    minimaxVideoMedia: [{ type: "reference_image", url: first }, { type: "audio", url: audio }],
  }))
    .attach("video", video, { filename: "one.mp4", contentType: "video/mp4" })
    .attach("video", video, { filename: "two.mp4", contentType: "video/mp4" })
    .expect(202);
  const id = created.body.data.id;
  expect((await h3.settle(id)).status).toBe("failed");
  const retried = await h3.api.post(`/api/generations/${id}/retry`).expect(202);
  expect((await h3.settle(retried.body.data.id)).status).toBe("succeeded");
  expect(h3.uploaded).toEqual(["one.mp4", "two.mp4", "one.mp4", "two.mp4"]);
  expect(h3.submissions()).toEqual([0, 2].map((offset) => ({
    model, prompt: h3.input.prompt, duration: 5, images: [first],
    metadata: {
      resolution: "768P",
      videos: [1, 2].map((index) => `https://cdn.example.test/reference-${offset + index}.mp4`),
      audios: [audio],
    },
  })));
});

it("rejects incompatible roles, audio-only input, out-of-range parameters and excess combined references", async () => {
  const h3 = await setup();
  const invalid: Array<Partial<GenerationInput>> = [
    { duration: 3 }, { duration: -1 }, { resolution: "1080P" }, { prompt: "字".repeat(7001) },
    { minimaxVideoMode: "first-last-frame", minimaxVideoMedia: [{ type: "first_frame", url: first }, { type: "first_frame", url: last }] },
    { minimaxVideoMode: "reference", minimaxVideoMedia: [{ type: "first_frame", url: first }] },
    { minimaxVideoMedia: [{ type: "audio", url: audio }] },
    { minimaxVideoMedia: [
      ...Array.from({ length: 9 }, () => ({ type: "reference_image" as const, url: first })),
      ...Array.from({ length: 3 }, () => ({ type: "video" as const, url: "https://cdn.example.test/shot.mp4" })),
      { type: "audio", url: audio },
    ] },
  ];
  for (const item of invalid) await h3.api.post("/api/generations").send({ ...h3.input, ...item }).expect(400);
  expect(h3.calls).toEqual([]);
});

it.each(["config", "video"] as const)("sends MiniMax references from a canvas %s node", async (type) => {
  const h3 = await setup();
  const id = (await h3.api.post("/api/boards").send({ title: "H3" }).expect(201)).body.data.id;
  const upload = async (bytes: Buffer, filename: string, contentType: string) => {
    const response = await h3.api.post(`/api/boards/${id}/assets`).attach("file", bytes, { filename, contentType }).expect(201);
    return response.body.data.id as string;
  };
  const clipId = await upload(video, "clip.mp4", "video/mp4");
  const soundId = await upload(audioBytes, "sound.wav", "audio/wav");
  const imageId = await upload(pngBytes, "reference.png", "image/png");
  const now = new Date().toISOString();
  const base = (ref: string) => ({ id: `node-${ref}`, ref, x: 0, y: 0, width: 300, height: 200, title: ref, createdAt: now, updatedAt: now });
  const settings = { ...base("n1"), prompt: h3.input.prompt, model };
  const target: BoardNode = type === "config"
    ? { ...settings, type, mode: "video", useUpstreamText: true, count: 1, status: "idle" }
    : { ...settings, type, assetId: null, source: "upload", status: "empty" };
  const sources: BoardNode[] = [
    { ...base("n2"), type: "video", assetId: clipId, source: "upload", status: "succeeded" },
    { ...base("n3"), type: "audio", assetId: soundId, source: "upload", status: "succeeded" },
    { ...base("n4"), type: "image", assetId: imageId, source: "upload", status: "succeeded" },
  ];
  const doc: BoardDoc = { version: 1, nextRef: 5, nodes: [target, ...sources], edges: sources.map(({ id: source }) => ({
    id: `edge-${source}`, source, target: target.id, kind: "input",
  })) };
  await h3.api.put(`/api/boards/${id}`).send({ doc, baseVersion: 1 }).expect(200);
  const result = await h3.api.post(`/api/boards/${id}/generate`).send({ nodeId: target.id }).expect(202);
  expect((await h3.settle(result.body.data.task.id)).status).toBe("succeeded");
  expect(h3.submissions()[0]).toMatchObject({
    images: [expect.stringContaining("data:image/")],
    metadata: { videos: ["https://cdn.example.test/reference-1.mp4"], audios: [audio] },
  });
  expect(h3.uploaded).toEqual([h3.context.db.getAsset(clipId)?.fileName]);
});

it("accepts a frame in the legacy multipart payload without requiring attached files", async () => {
  const h3 = await setup();
  const result = await h3.api.post("/api/generations/reference-media").field("payload", JSON.stringify({
    ...h3.input, minimaxVideoMode: "first-frame", minimaxVideoMedia: [{ type: "first_frame", url: first }],
  })).expect(202);
  expect((await h3.settle(result.body.data.id)).status).toBe("succeeded");
  expect(h3.submissions()[0]).toMatchObject({ metadata: { first_frame: first } });
});

it("keeps reference audio in the native conversation confirmation and resumes with its exact asset", async () => {
  const h3 = await setup();
  const conversation = h3.context.db.createConversation({
    title: "H3", brainChannelId: "brain", brainModel: "mock", videoConfirmPolicy: "always",
    visionEnabled: false, verbatimPrompt: false,
  });
  const pic = (await h3.api.post(`/api/conversations/${conversation.id}/uploads`)
    .attach("images", pngBytes, { filename: "reference.png", contentType: "image/png" }).expect(201)).body.data.uploadedAssetIds[0];
  await h3.api.post(`/api/conversations/${conversation.id}/media`)
    .attach("files", audioBytes, { filename: "voice.wav", contentType: "audio/wav" }).expect(201);
  const sound = h3.context.db.listConversationAssets(conversation.id).find(({ asset }) => asset.mimeType === "audio/wav")!.asset.id;
  const args = { modelHint: model, prompt: h3.input.prompt, mode: "reference" };
  const prepared = prepareNativeVideo(h3.context.db, conversation, JSON.stringify({ ...args, imageRefs: [pic], audioRefs: [sound] }), []);
  expect(prepared).toHaveProperty("preview.videoInputs", [
    { assetId: pic, role: "reference_image" },
    { assetId: sound, role: "reference_audio", fileName: "voice.wav" },
  ]);
  if (!prepared.preview) throw new Error("Confirmation preview missing");
  const confirmed = withConfirmedVideoSelection(prepared.args, prepared.preview) as unknown as typeof prepared.args;
  expect(confirmed).toMatchObject({ mode: "reference", imageRefs: [pic], audioRefs: [sound] });
  const { db, sessionKeys, runner } = h3.context;
  const outcome = await generateVideo({ db, sessionKeys, runner, conversation, confirmed: true,
    aliases: buildCapabilityAliases(db.listChannels()), defaultAliases: {}, turnAttachmentIds: [], verbatimPrompt: null, emit() {} }, confirmed);
  expect(outcome.result).toMatchObject({ ok: true });
  expect((await h3.settle(outcome.result.taskId!)).status).toBe("succeeded");
  expect(h3.submissions()[0]).toMatchObject({
    images: [expect.stringMatching(/^data:image\//)], metadata: { audios: [audio] },
  });
  expect(h3.uploaded).toEqual([]);
});
