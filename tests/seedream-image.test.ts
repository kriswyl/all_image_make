import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Jimp, JimpMime } from "jimp";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import { buildGenerationRequest, requestForDiagnostic } from "../src/server/adapters";
import { imageReferenceLimit } from "../src/shared/image-reference-limits";
import { SEEDREAM_ADAPTER, SEEDREAM_MODELS, seedreamSize } from "../src/shared/seedream";
import type { Task } from "../src/shared/types";

it("豆包使用官方清晰度与尺寸边界", () => {
  expect(seedreamSize({})).toBe("2K");
  expect(seedreamSize({ imageSize: "2K", aspectRatio: "16:9" })).toBe("2816x1584");
  expect(seedreamSize({ size: "1.5K", aspectRatio: "9:16" })).toBe("1152x2048");
  expect(seedreamSize({ size: "999×999" })).toBe("999x999");
  expect(seedreamSize({ size: "1280x720" })).toBe("1280x720");
  for (const size of ["4K", "512x512", "2600x2000", "16000x64"]) {
    expect(() => seedreamSize({ size })).toThrow();
  }
  for (const model of [...SEEDREAM_MODELS, "doubao-seedream-5-5-261028"]) {
    expect(imageReferenceLimit(SEEDREAM_ADAPTER, model).max).toBe(10);
  }
});

it("豆包生成通过 JSON 提交参考图，4 张拆成 4 个任务，失败后只重试对应任务", async () => {
  const png = await new Jimp({ width: 24, height: 24, color: 0xf0295fff }).getBuffer(JimpMime.png);
  const jpeg = await new Jimp({ width: 24, height: 24, color: 0x226efaff }).getBuffer(JimpMime.jpeg);
  const requests: Record<string, unknown>[] = [];
  const imageUrl = "http://127.0.0.1:1/assets/actual-jpeg.png";
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === imageUrl) return new Response(Uint8Array.from(jpeg), { headers: { "Content-Type": "image/png" } });
    if (url !== "http://127.0.0.1:1/v1/images/generations") throw new Error("Unexpected upstream URL");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    requests.push(body);
    if (requests.length === 2) return Response.json({ error: { message: "网关暂时失败" } }, { status: 502 });
    const inputCount = Array.isArray(body.image) ? body.image.length : body.image ? 1 : 0;
    return Response.json({
      model: "doubao-seedream-5-5-261028",
      data: [{ url: imageUrl }],
      usage: { input_images: requests.length === 3 ? 0 : inputCount, generated_images: 1, output_tokens: 4096 },
    });
  });
  vi.stubGlobal("fetch", network);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-seedream-"));
  const { app, context: { db, runner, agent } } = createApp({ dataDir: dir });
  try {
    const channel = (await request(app).post("/api/channels").send({
      name: "模拟豆包", baseUrl: "http://127.0.0.1:1", adapterType: SEEDREAM_ADAPTER, authType: "none",
      models: SEEDREAM_MODELS, allowPrivateNetwork: true, enabled: true,
    }).expect(201)).body.data;
    const input = { channelId: channel.id, model: SEEDREAM_MODELS[0], prompt: "保留参考图主色", size: "999x999" };
    const bridge = db.getChannel(channel.id)!;
    const text = buildGenerationRequest(bridge, input, "");
    expect(text.body).toEqual({ model: input.model, prompt: input.prompt, size: "999x999", watermark: false, response_format: "url" });
    expect(buildGenerationRequest(bridge, { ...input, watermark: true }, "").body?.watermark).toBe(true);
    const reference = { fileName: "source.png", mimeType: "image/png" as const, base64: png.toString("base64") };
    const one = buildGenerationRequest(bridge, { ...input, referenceImages: [reference], rawParameters: { n: 8, image: "ignored" } }, "");
    expect(one.body).toMatchObject({ image: `data:image/png;base64,${reference.base64}` });
    expect(one.body).not.toHaveProperty("n");
    expect(JSON.stringify(requestForDiagnostic(one))).not.toContain(reference.base64);
    expect(() => buildGenerationRequest({ ...bridge, endpoint: "/v1/images/edits" }, input, "")).toThrow();
    await request(app).post("/api/generations").send({ ...input, size: "512x512" }).expect(400);
    await request(app).post("/api/generations").send({ ...input, count: 2 }).expect(400);
    const tooMany = request(app).post("/api/generations").field("payload", JSON.stringify(input));
    for (let i = 0; i < 11; i++) tooMany.attach("referenceImages", png, { filename: `ref-${i}.png`, contentType: "image/png" });
    expect((await tooMany.expect(400)).body.error.code).toBe("REFERENCE_IMAGE_LIMIT");
    expect(requests).toHaveLength(0);

    const batch = request(app).post("/api/generations/image-batch").field("payload", JSON.stringify({ ...input, count: 4 }));
    for (let i = 0; i < 10; i++) batch.attach("referenceImages", png, { filename: `ref-${i}.png`, contentType: "image/png" });
    const created = (await batch.expect(202)).body.data.tasks as Task[];
    expect(created).toHaveLength(4);
    const terminal = await Promise.all(created.map(task => runner.waitFor(task.id, { timeoutMs: 9000 })));
    expect(requests, JSON.stringify(terminal.map(task => [task.status, task.errorCode, task.errorMessage]))).toHaveLength(4);
    for (const body of requests) {
      expect(body).not.toHaveProperty("n");
      expect(body.watermark).toBe(false);
      expect(body.image).toEqual(Array.from({ length: 10 }, () => `data:image/png;base64,${reference.base64}`));
    }
    const failed = terminal.find(task => task.status === "failed")!;
    expect(failed).toBeDefined();
    expect(terminal.filter(task => task.status === "succeeded")).toHaveLength(3);
    const mismatch = terminal.find(task => task.remoteMeta?.seedream?.acceptedReferences === 0)!;
    expect(mismatch.status).toBe("succeeded");
    expect(mismatch.remoteMeta?.seedream?.warning).toContain("未使用参考图");
    expect(mismatch.assets[0]?.mimeType).toBe("image/jpeg");
    expect(mismatch.assets[0]?.fileName).toMatch(/\.jpg$/);
    const retried = (await request(app).post(`/api/generations/${failed.id}/retry`).expect(202)).body.data as Task;
    const recovered = await runner.waitFor(retried.id, { timeoutMs: 9000 });
    expect(recovered.status).toBe("succeeded");
    expect(recovered.remoteMeta?.seedream).toMatchObject({ requestedReferences: 10, acceptedReferences: 10, generatedImages: 1 });
    expect(requests).toHaveLength(5);
  } finally {
    vi.unstubAllGlobals();
    agent.dispose();
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
