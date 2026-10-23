/**
 * 画布 = 一组图。
 *
 * 这里钉的是**多张画布真的出去了**，而不只是库里存了个数组：
 * 改图时整组进参考图、生视频只吃主图一张、总张数封顶在 8。
 *
 * 最后那条同时修掉一个既有错：改图原来发 画布 1 + extraReferences 最多 8 = 9 张，
 * 而落库上限是 8，整个任务会被 `REFERENCE_IMAGE_LIMIT` 直接拒掉——静默烧掉一次调用。
 */
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/server/app";
import { resolveCanvasRefs, runAgentTool } from "../src/server/agent-tools";
import { MAX_CANVAS_IMAGES, MAX_REFERENCE_IMAGES } from "../src/shared/types";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const pngBytes = Buffer.from(pngBase64, "base64");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** 数 multipart 请求体里有几段 PNG 字节头——就是「发了几张图」 */
function countPngParts(raw: Buffer) {
  return raw.toString("latin1").split(PNG_SIGNATURE.toString("latin1")).length - 1;
}

/**
 * 一个假中转站同时演大脑、生图、生视频。
 *
 * `plan` 决定大脑这一轮说什么；两个 `hits` 数组把**发出去的真实字节**留下来，
 * 因为「画布有几张」这件事只有在那里才看得见。
 */
async function startMock(plan: unknown | unknown[]) {
  // 允许按轮次给剧本：view_images / 「先问再生成」这类用例需要不止一个计划
  const plans = Array.isArray(plan) ? plan : [plan];
  const imageHits: Array<{ url: string; raw: Buffer }> = [];
  const chatBodies: string[] = [];
  const videoHits: Buffer[] = [];

  const mock = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url?.includes("/chat/completions")) {
        chatBodies.push(raw.toString("utf8"));
        // 有剧本就按轮次走，用完一律收尾——否则大脑会一直要图
        const body = chatBodies.length <= plans.length
          ? plans[chatBodies.length - 1]
          : { tool: "reply", args: { text: "好了。" }, say: "好了。" };
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(body) } }] }));
        return;
      }
      if (req.url?.includes("/video-synthesis")) {
        videoHits.push(raw);
        res.end(JSON.stringify({ output: { task_id: "remote-1", task_status: "RUNNING" } }));
        return;
      }
      imageHits.push({ url: req.url ?? "", raw });
      res.end(JSON.stringify({ data: [{ b64_json: pngBase64 }] }));
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => { mock.close(() => resolve()); }));
  const address = mock.address();
  if (!address || typeof address === "string") throw new Error("mock server did not start");
  const base = `http://127.0.0.1:${address.port}`;

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-canvas-"));
  const { app, context } = createApp({ dataDir });
  cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

  const brain = (await request(app).post("/api/channels").send({
    name: "Brain", baseUrl: base, adapterType: "openai-chat", authType: "none",
    authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
    models: ["mock-brain"], allowPrivateNetwork: true, enabled: true,
  }).expect(201)).body.data;
  await request(app).post("/api/channels").send({
    name: "Images", baseUrl: base, adapterType: "openai-images", authType: "none",
    authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations",
    models: ["mock-image"], allowPrivateNetwork: true, enabled: true,
  }).expect(201);
  await request(app).post("/api/channels").send({
    name: "Video", baseUrl: base, adapterType: "wan-video", authType: "none",
    authHeaderName: "", secretEnv: "", endpoint: "/api/v1/services/aigc/video-generation/video-synthesis",
    models: ["wan3.0-video"], allowPrivateNetwork: true, enabled: true,
  }).expect(201);

  const conversationId = (await request(app).post("/api/conversations")
    .send({ brainChannelId: brain.id, brainModel: "mock-brain", videoConfirmPolicy: "never" }).expect(201)).body.data.id as string;

  return { app, context, conversationId, imageHits, videoHits, chatBodies };
}

/** 传 N 张图进会话，返回它们的 assetId（按上传顺序） */
async function uploadImages(app: ReturnType<typeof createApp>["app"], conversationId: string, count: number) {
  let call = request(app).post(`/api/conversations/${conversationId}/uploads`);
  for (let index = 0; index < count; index += 1) call = call.attach("images", pngBytes, `图${index + 1}.png`);
  const body = (await call.expect(201)).body.data as { canvasAssetIds: string[] };
  return body.canvasAssetIds;
}

/**
 * 直接调 `set_canvas`，不绕对话。
 *
 * 绕一圈的话，大脑得先在**第二轮**才知道画布上有哪些 ref，测试会变成在测提示词；
 * 而这里要测的是「一组 ref 进来之后发生了什么」。`set_canvas` 只碰 db 和 conversation，
 * 所以 aliases / emit 这些给空的就够。
 */
function runSetCanvas(mock: Awaited<ReturnType<typeof startMock>>, args: Record<string, unknown>) {
  const conversation = mock.context.db.getConversation(mock.conversationId)!;
  return runAgentTool("set_canvas", args, {
    db: mock.context.db, runner: mock.context.runner, sessionKeys: mock.context.sessionKeys,
    conversation, aliases: [], defaultAliases: {}, verbatimPrompt: null, turnAttachmentIds: [], emit: () => undefined,
  }).then((outcome) => outcome.result);
}

async function settle(app: ReturnType<typeof createApp>["app"], conversationId: string) {
  let last: unknown = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const view = (await request(app).get(`/api/conversations/${conversationId}`).expect(200)).body.data as {
      status: string; messages: Array<{ role: string }>;
    };
    // 等的是「大脑接上了话」，不是「有工具结果」：`reply` 那一轮根本不落 tool 行，
    // 按 tool 行等会让纯对话的用例一直等到超时（上传那几条自己也是 user 行，不算）
    if (view.status === "idle" && view.messages.some((row) => row.role !== "user")) return view;
    last = view;
  }
  throw new Error(`会话没有在预期时间内跑完：${JSON.stringify(last)?.slice(0, 600)}`);
}

describe("resolveCanvasRefs", () => {
  it("去重保序；解析不出来的进 notes 而不是整体失败", async () => {
    const mock = await startMock({ tool: "reply", args: { text: "嗯" }, say: "嗯" });
    const uploaded = await uploadImages(mock.app, mock.conversationId, 2);
    const db = mock.context.db;

    // `#abcd` 就是 id 前四位，大脑拿到的引用就长这样
    const refs = [uploaded[0]!.slice(0, 4), uploaded[1]!.slice(0, 4), uploaded[0]!.slice(0, 4), "deadbeef"];
    const { ids, notes } = resolveCanvasRefs(db, mock.conversationId, refs);
    expect(ids).toEqual([uploaded[0], uploaded[1]]);
    // 重复的那张不提，只提真的没找到的那个——「重复」不是错误，用户没必要知道
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("deadbeef");

    // 一个都解析不出来时返回空 ids，调用方据此硬失败（别让大脑把画布悄悄清空）
    expect(resolveCanvasRefs(db, mock.conversationId, ["nope1", "nope2"]).ids).toEqual([]);
    // cap 是硬上限：给了 2 的 cap、4 个有效引用，只留前两个并把多出来的说出来
    const capped = resolveCanvasRefs(db, mock.conversationId, [uploaded[0]!.slice(0, 4), uploaded[1]!.slice(0, 4)], 1);
    expect(capped.ids).toEqual([uploaded[0]]);
    expect(capped.notes.join("")).toContain("最多 1 张");
  });
});

describe("画布一组图，真的整组发出去", () => {
  it("画布 2 张时，改图的请求体里有 2 段图片字节", async () => {
    const mock = await startMock({ tool: "edit_image", args: { prompt: "改成夜景" }, say: "改这张。" });
    await uploadImages(mock.app, mock.conversationId, 2);

    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "改成夜景" }).expect(202);
    await settle(mock.app, mock.conversationId);

    // 走 /images/edits 本身就说明带图了（openai-images 有参考图才自动改走这条）
    const edit = mock.imageHits.find((hit) => hit.url.includes("/images/edits"));
    expect(edit).toBeTruthy();
    expect(countPngParts(edit!.raw)).toBe(2);
  });

  it("生成成功后不自动改动画布：新产物只进素材库", async () => {
    const mock = await startMock({ tool: "generate_image", args: { prompt: "猫" }, say: "画。" });
    await uploadImages(mock.app, mock.conversationId, 2);
    const before = (await request(mock.app).get(`/api/conversations/${mock.conversationId}`).expect(200)).body.data as {
      canvasAssetIds: string[];
    };
    expect(before.canvasAssetIds).toHaveLength(2);

    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "画一只猫" }).expect(202);
    await settle(mock.app, mock.conversationId);

    const after = (await request(mock.app).get(`/api/conversations/${mock.conversationId}`).expect(200)).body.data as {
      canvasAssetIds: string[]; canvasImages: Array<{ id: string }>; sessionImages: Array<{ asset: { id: string } }>;
    };
    // 用户没再挑图，画布保持上传的那两张；新产物只是多进了一份素材库
    expect(after.canvasAssetIds).toEqual(before.canvasAssetIds);
    expect(after.canvasImages.map((item) => item.id)).toEqual(after.canvasAssetIds);
    expect(after.sessionImages).toHaveLength(3);
  });

  it("生视频按 imageRefs 选图：只发指定的那一张 first_frame", async () => {
    // 三张附带的图 + 一句「让它动起来」在语义上是模糊的（到底哪一张？），
    // 服务器会拒绝没有 mode 的多图请求；这里模拟大脑已经问清楚并选中了第 2 张。
    const plan: { tool: string; args: Record<string, unknown>; say: string } = {
      tool: "generate_video", args: { prompt: "动起来", mode: "first-frame" }, say: "生成视频。",
    };
    const mock = await startMock(plan);
    const uploaded = await uploadImages(mock.app, mock.conversationId, 3);
    plan.args.imageRefs = [uploaded[1]!.slice(0, 4)];

    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "让第二张动起来" }).expect(202);
    await settle(mock.app, mock.conversationId);

    const videoTask = mock.context.db.listTaskRows().find((row) => row.channelAdapterType === "wan-video");
    expect(videoTask).toBeTruthy();
    const input = JSON.parse(videoTask!.inputJson) as { wanVideoMedia?: Array<{ type: string }> };
    expect(input.wanVideoMedia).toHaveLength(1);
    expect(input.wanVideoMedia![0]!.type).toBe("first_frame");
    expect(mock.videoHits).toHaveLength(1);
    const sent = JSON.parse(mock.videoHits[0]!.toString("utf8")) as { input: { media: Array<{ type: string; url: string }> } };
    expect(sent.input.media).toHaveLength(1);
    expect(sent.input.media[0]!.url).toContain(pngBase64.slice(0, 40));

    // 工具结果里要留下「这次用了哪一张」，而不是笼统一句「用主图」
    const row = mock.context.db.listMessages(mock.conversationId)
      .find((item) => item.toolName === "generate_video" && item.toolResult);
    const inputs = row?.toolResult?.data?.videoInputs as Array<{ assetId: string; role: string }> | undefined;
    expect(inputs).toEqual([{ assetId: uploaded[1], role: "first_frame" }]);
  });

  it("本条消息附带的图优先于画布：只改附带的那一张，不再整组都发", async () => {
    const mock = await startMock([
      { tool: "reply", args: { text: "好。" }, say: "好。" },
      { tool: "edit_image", args: { prompt: "换成夜景" }, say: "改这张。" },
      { tool: "reply", args: { text: "改好了。" }, say: "改好了。" },
    ]);
    const uploaded = await uploadImages(mock.app, mock.conversationId, 2);
    // 先跑一轮，把「上传」那两条从本轮附件里隔开——模拟用户后来从会话里拖了一张图进来
    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "先别动" }).expect(202);
    await settle(mock.app, mock.conversationId);

    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`)
      .send({ text: "把这张图的背景换成夜景", assetRefs: [uploaded[1]] }).expect(202);
    await settle(mock.app, mock.conversationId);

    const edit = mock.imageHits.find((hit) => hit.url.includes("/images/edits"));
    expect(edit).toBeTruthy();
    // 用户只附带了第 2 张，就只发第 2 张；画布上那张第 1 张不该被带进去
    expect(countPngParts(edit!.raw)).toBe(1);
    // 第二轮的大脑请求里，附带图被明确标成「本条消息附带的图片」
    expect(mock.chatBodies[1]).toContain("本条消息附带的图片");
  });

  it("没有附带图、画布多于一张又没指定时，改图失败并要求先选图", async () => {
    const mock = await startMock([
      { tool: "reply", args: { text: "好。" }, say: "好。" },
      { tool: "edit_image", args: { prompt: "换成夜景" }, say: "改这张。" },
      { tool: "reply", args: { text: "你要改哪一张？" }, say: "你要改哪一张？" },
    ]);
    await uploadImages(mock.app, mock.conversationId, 2);
    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "先别动" }).expect(202);
    await settle(mock.app, mock.conversationId);

    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "改成夜景" }).expect(202);
    await settle(mock.app, mock.conversationId);

    // 一次生成请求都不该发出去
    expect(mock.imageHits).toHaveLength(0);
    const row = mock.context.db.listMessages(mock.conversationId)
      .find((item) => item.toolName === "edit_image" && item.toolResult);
    expect(row?.toolResult?.ok).toBe(false);
    expect(row?.toolResult?.error).toBe("IMAGE_SELECTION_INVALID");
    expect(row?.toolResult?.summary).toContain("画布上有 2 张图");
    expect(row?.toolResult?.summary).toContain("view_images");
  });

  it("两张图没写 mode 的生视频请求会被拒绝，让大脑先问用户", async () => {
    const mock = await startMock([
      { tool: "reply", args: { text: "好。" }, say: "好。" },
      { tool: "generate_video", args: { prompt: "用这两张做视频" }, say: "生成视频。" },
      { tool: "reply", args: { text: "要首尾帧还是参考图？" }, say: "要首尾帧还是参考图？" },
    ]);
    const uploaded = await uploadImages(mock.app, mock.conversationId, 2);
    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "先别动" }).expect(202);
    await settle(mock.app, mock.conversationId);

    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`)
      .send({ text: "用这两张做视频", assetRefs: uploaded }).expect(202);
    await settle(mock.app, mock.conversationId);

    expect(mock.videoHits).toHaveLength(0);
    expect(mock.context.db.listTaskRows().some((row) => row.channelAdapterType === "wan-video")).toBe(false);
    const row = mock.context.db.listMessages(mock.conversationId)
      .find((item) => item.toolName === "generate_video" && item.toolResult);
    expect(row?.toolResult?.error).toBe("VIDEO_SELECTION_INVALID");
    expect(row?.toolResult?.summary).toContain("ask");
    expect(row?.toolResult?.summary).toContain("first-last-frame");
    expect(row?.toolResult?.summary).toContain("reference");
  });

  it("首尾帧：两张图按顺序落成 first_frame + last_frame", async () => {
    const mock = await startMock([
      { tool: "reply", args: { text: "好。" }, say: "好。" },
      { tool: "generate_video", args: { prompt: "首尾帧", mode: "first-last-frame" }, say: "生成视频。" },
    ]);
    const uploaded = await uploadImages(mock.app, mock.conversationId, 2);
    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "先别动" }).expect(202);
    await settle(mock.app, mock.conversationId);

    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`)
      .send({ text: "开头这张、结尾那张", assetRefs: [uploaded[0], uploaded[1]] }).expect(202);
    await settle(mock.app, mock.conversationId);

    const videoTask = mock.context.db.listTaskRows().find((row) => row.channelAdapterType === "wan-video");
    expect(videoTask).toBeTruthy();
    const input = JSON.parse(videoTask!.inputJson) as {
      wanVideoMode?: string; wanVideoMedia?: Array<{ type: string }>;
    };
    expect(input.wanVideoMode).toBe("first-last-frame");
    expect(input.wanVideoMedia?.map((item) => item.type)).toEqual(["first_frame", "last_frame"]);
  });

  it("参考生视频：三张图都按 reference_image 发出去", async () => {
    const mock = await startMock([
      { tool: "reply", args: { text: "好。" }, say: "好。" },
      { tool: "generate_video", args: { prompt: "参考这三张", mode: "reference" }, say: "生成视频。" },
    ]);
    const uploaded = await uploadImages(mock.app, mock.conversationId, 3);
    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "先别动" }).expect(202);
    await settle(mock.app, mock.conversationId);

    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`)
      .send({ text: "参考这三张生成视频", assetRefs: uploaded }).expect(202);
    await settle(mock.app, mock.conversationId);

    const videoTask = mock.context.db.listTaskRows().find((row) => row.channelAdapterType === "wan-video");
    expect(videoTask).toBeTruthy();
    const input = JSON.parse(videoTask!.inputJson) as {
      wanVideoMode?: string; wanVideoMedia?: Array<{ type: string }>;
    };
    expect(input.wanVideoMode).toBe("reference");
    expect(input.wanVideoMedia?.map((item) => item.type)).toEqual([
      "reference_image", "reference_image", "reference_image",
    ]);
  });

  it("参考图总量封顶 8：画布 8 张 + 额外 2 张时，多的被丢掉并说出来", async () => {
    // 这条同时钉住今天那个既有错——不封顶的话 9 张会让 persistInputImages 直接把任务拒掉
    const mock = await startMock({
      tool: "edit_image",
      args: { prompt: "合成", extraReferences: ["last", "last"] },
      say: "合成。",
    });
    await uploadImages(mock.app, mock.conversationId, MAX_CANVAS_IMAGES);

    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "把这些合成一张" }).expect(202);
    await settle(mock.app, mock.conversationId);

    const edit = mock.imageHits.find((hit) => hit.url.includes("/images/edits"));
    expect(edit).toBeTruthy();
    expect(countPngParts(edit!.raw)).toBe(MAX_REFERENCE_IMAGES);

    // 工具调用和执行结果落在同一行，但回放时是两条——取带 result 的那条
    const rows = mock.context.db.listMessages(mock.conversationId).filter((row) => row.toolName === "edit_image");
    const done = rows.find((row) => row.toolResult) ?? rows[0]!;
    // extraReferences 写的是 "last"，而它已经在画布里了——那是「重复」不是「超限」，
    // 所以任务必须成功，不该被 REFERENCE_IMAGE_LIMIT 整体拒掉
    expect(done.toolResult?.ok).toBe(true);
    expect(done.status).toBe("ok");
  });
});

describe("大脑看到的东西", () => {
  it("本条消息附带了图时，视觉附件就是这几张，而不是画布主图", async () => {
    // 这条钉住用户报的那个问题：附了一张图说「换背景」，助手却去改了画布主图。
    // 现在附带的图会直接给大脑看，并且不再声称「用户说这张默认指主图」。
    const mock = await startMock({ tool: "reply", args: { text: "收到。" }, say: "收到。" });
    const uploaded = await uploadImages(mock.app, mock.conversationId, 2);

    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "看看这两张" }).expect(202);
    await settle(mock.app, mock.conversationId);

    const sent = mock.chatBodies[0]!;
    expect(sent).toContain(uploaded[0]!.slice(0, 4));
    expect(sent).toContain(uploaded[1]!.slice(0, 4));
    expect(sent).toContain("本条消息附带的图片");
    // 「主图」这个说法不能再作为默认目标的依据
    expect(sent).not.toContain("默认指它");
    // 两张附带图 = 两段 data URI。按 `data:image/` 数而不是钉死 png：
    // 缩略图**一律重新编码成 JPEG**（`writeThumbnail`），钉死 png 会数出 0 张
    expect(sent.split("data:image/").length - 1).toBe(2);
  });

  it("没有附带图时，大脑可以调 view_images 再看画布；看过不留工具卡", async () => {
    const mock = await startMock([
      { tool: "reply", args: { text: "好。" }, say: "好。" },
      { tool: "view_images", args: {}, say: "" },
      { tool: "reply", args: { text: "看完了，第二张是夜景。" }, say: "看完了。" },
    ]);
    await uploadImages(mock.app, mock.conversationId, 2);
    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "先别动" }).expect(202);
    await settle(mock.app, mock.conversationId);

    const before = mock.chatBodies.length;
    await request(mock.app).post(`/api/conversations/${mock.conversationId}/messages`).send({ text: "画布上都是什么？" }).expect(202);
    await settle(mock.app, mock.conversationId);

    // view_images 会多问一趟大脑：第二轮请求里应该带着画布缩略图
    expect(mock.chatBodies.length).toBeGreaterThanOrEqual(before + 2);
    const observed = mock.chatBodies[before + 1]!;
    expect(observed).toContain("view_images");
    expect(observed).toContain("画布第 1 张");
    expect(observed.split("data:image/").length - 1).toBe(2);
    // 看图是内部动作，不该在对话里留下一条工具结果
    expect(mock.context.db.listMessages(mock.conversationId).some((row) => row.toolName === "view_images")).toBe(false);
  });

  it("set_canvas 一次设一组：整组落库，主图是第一张", async () => {
    const mock = await startMock({
      tool: "set_canvas",
      args: { assetRefs: [] },   // 真的 ref 下面填：第一轮得先有图
      say: "换画布。",
    });
    const uploaded = await uploadImages(mock.app, mock.conversationId, 3);
    // 直接调工具最省事：走一轮对话的话，大脑得先在第二轮才知道这些 ref
    const result = await runSetCanvas(mock, { assetRefs: [uploaded[2]!.slice(0, 4), uploaded[0]!.slice(0, 4)] });

    expect(result.ok).toBe(true);
    // ToolResult.assetId 保持单值契约（喂给大脑的那份），装的是主图
    expect(result.assetId).toBe(uploaded[2]);
    expect(result.data?.canvasAssetIds).toEqual([uploaded[2], uploaded[0]]);
    const view = (await request(mock.app).get(`/api/conversations/${mock.conversationId}`).expect(200)).body.data as {
      canvasAssetIds: string[]; canvasImages: Array<{ id: string }>;
    };
    expect(view.canvasAssetIds).toEqual([uploaded[2], uploaded[0]]);
    expect(view.canvasImages.map((item) => item.id)).toEqual([uploaded[2], uploaded[0]]);
  });

  it("set_canvas 一个 ref 都没解析出来时硬失败，不把画布悄悄清空", async () => {
    const mock = await startMock({ tool: "reply", args: { text: "嗯" }, say: "嗯" });
    const uploaded = await uploadImages(mock.app, mock.conversationId, 1);
    const result = await runSetCanvas(mock, { assetRefs: ["deadbeef"] });
    expect(result.ok).toBe(false);
    // 原来的画布原封不动——大脑抄错 ref 的代价不该是用户丢画布
    const view = (await request(mock.app).get(`/api/conversations/${mock.conversationId}`).expect(200)).body.data as {
      canvasAssetIds: string[];
    };
    expect(view.canvasAssetIds).toEqual(uploaded);
  });
});

describe("PATCH 画布", () => {
  it("非 uuid / 不存在 / 视频各自 400，重复的自动去掉", async () => {
    const mock = await startMock({ tool: "reply", args: { text: "嗯" }, say: "嗯" });
    const uploaded = await uploadImages(mock.app, mock.conversationId, 2);
    const patch = (body: object) => request(mock.app).patch(`/api/conversations/${mock.conversationId}`).send(body);

    // 非 uuid 和超上限都由 zod 挡在最前面（服务端压根拿不到那个列表）
    expect((await patch({ canvasAssetIds: ["不是-uuid"] }).expect(400)).body.error.code).toBe("INVALID_INPUT");
    expect((await patch({ canvasAssetIds: ["11111111-1111-4111-8111-111111111111"] }).expect(400)).body.error.code).toBe("ASSET_NOT_FOUND");
    expect((await patch({ canvasAssetIds: Array.from({ length: MAX_CANVAS_IMAGES + 1 }, (_, i) => uploaded[i % 2]!) }).expect(400)).body.error.code)
      .toBe("INVALID_INPUT");

    // 重复点两下不该变成 400，也不该在画布上出现两张一样的
    const deduped = (await patch({ canvasAssetIds: [uploaded[1], uploaded[0], uploaded[1]] }).expect(200)).body.data as {
      canvasAssetIds: string[];
    };
    expect(deduped.canvasAssetIds).toEqual([uploaded[1], uploaded[0]]);

    // 清空画布 = 空数组，和「没传这个键」是两回事
    const cleared = (await patch({ canvasAssetIds: [] }).expect(200)).body.data as { canvasAssetIds: string[]; sessionImages: unknown[] };
    expect(cleared.canvasAssetIds).toEqual([]);
    expect(cleared.sessionImages).toHaveLength(2);
  });

  it("老前端传 currentAssetId 仍然生效（zod 会把不认识的键剥掉，归一成数组才不会静默失效）", async () => {
    const mock = await startMock({ tool: "reply", args: { text: "嗯" }, say: "嗯" });
    const uploaded = await uploadImages(mock.app, mock.conversationId, 2);
    const patch = (body: object) => request(mock.app).patch(`/api/conversations/${mock.conversationId}`).send(body);

    const set = (await patch({ currentAssetId: uploaded[1] }).expect(200)).body.data as { canvasAssetIds: string[] };
    expect(set.canvasAssetIds).toEqual([uploaded[1]]);
    const cleared = (await patch({ currentAssetId: null }).expect(200)).body.data as { canvasAssetIds: string[] };
    expect(cleared.canvasAssetIds).toEqual([]);
  });

  it("视频不能当画布", async () => {
    const mock = await startMock({ tool: "reply", args: { text: "嗯" }, say: "嗯" });
    // 造一条视频产物：等假中转站把视频跑完要绕一大圈，而这个用例测的只是那条校验分支
    const db = mock.context.db;
    db.createTask({ id: "task-video", channelId: "", model: "", prompt: "视频", input: {}, origin: "upload", status: "succeeded" });
    db.insertAsset({
      id: "33333333-3333-4333-8333-333333333333", taskId: "task-video", fileName: "a.mp4", mimeType: "video/mp4",
      byteSize: 1, relativePath: "a.mp4", baseDir: db.assetsDir, sha256: "x", thumbPath: "",
    });

    const response = await request(mock.app).patch(`/api/conversations/${mock.conversationId}`)
      .send({ canvasAssetIds: ["33333333-3333-4333-8333-333333333333"] }).expect(400);
    expect(response.body.error.code).toBe("ASSET_NOT_IMAGE");
  });
});
