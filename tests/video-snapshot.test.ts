/**
 * 参数快照与模式守卫。
 *
 * 两件事必须成立：
 * 1. 任务落库的 input_json 是**提交那一刻**的参数，之后改表单改不到它；
 * 2. 界面能拿到脱敏版本（不含 base64），据此展示「本次参数」并复用。
 * 顺带守一条：绕过界面直接提交不成立的模式要被服务端拒绝。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/server/app";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-snapshot-"));
  const { app, context } = createApp({ dataDir });
  cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });
  const channel = (await request(app).post("/api/channels").send({
    name: "Wan", baseUrl: "http://127.0.0.1:1", adapterType: "wan-video", authType: "none",
    authHeaderName: "", secretEnv: "", endpoint: "/generate", models: ["wan2.5-i2v-preview"],
    allowPrivateNetwork: true, enabled: true,
  }).expect(201)).body.data;
  const seedance = (await request(app).post("/api/channels").send({
    name: "Seedance", baseUrl: "http://127.0.0.1:1", adapterType: "seedance-video", authType: "none",
    authHeaderName: "", secretEnv: "", endpoint: "/generate", models: ["doubao-seedance-2.0"],
    allowPrivateNetwork: true, enabled: true,
  }).expect(201)).body.data;
  const kling = (await request(app).post("/api/channels").send({
    name: "Kling", baseUrl: "http://127.0.0.1:1", adapterType: "kling-video", authType: "none",
    authHeaderName: "", secretEnv: "", endpoint: "", models: ["kling-2.5-turbo"],
    allowPrivateNetwork: true, enabled: true,
  }).expect(201)).body.data;
  return { app, channel, seedance, kling };
}

describe("任务参数快照", () => {
  it("提交时落库快照，内联素材只留字节数，不回传 base64", async () => {
    const { app, channel } = await setup();
    const created = await request(app).post("/api/generations").send({
      channelId: channel.id,
      model: channel.models[0],
      prompt: "海边日落，镜头缓慢推进",
      wanVideoMode: "reference",
      wanVideoMedia: [{ type: "reference_image", url: `data:image/png;base64,${pngBase64}` }],
      resolution: "720P",
      ratio: "16:9",
      duration: 5,
      audio: true,
    }).expect(202);
    const taskId = created.body.data.id as string;
    const task = (await request(app).get(`/api/generations/${taskId}`).expect(200)).body.data;

    expect(task.inputParameters).toMatchObject({
      prompt: "海边日落，镜头缓慢推进",
      mode: "reference",
      resolution: "720P",
      ratio: "16:9",
      duration: 5,
      audio: true,
    });
    expect(task.inputParameters.media[0]).toMatchObject({ type: "reference_image" });
    expect(task.inputParameters.media[0].url).toBeUndefined();
    expect(JSON.stringify(task.inputParameters)).not.toContain("base64");
  });

  it("之后的提交参数改动不会影响历史任务", async () => {
    const { app, channel } = await setup();
    const first = (await request(app).post("/api/generations").send({
      channelId: channel.id, model: channel.models[0], prompt: "第一条",
      wanVideoMode: "text-to-video", resolution: "720P", duration: 5,
    }).expect(202)).body.data;
    await request(app).post("/api/generations").send({
      channelId: channel.id, model: channel.models[0], prompt: "第二条",
      wanVideoMode: "text-to-video", resolution: "1080P", duration: 10,
    }).expect(202);
    const again = (await request(app).get(`/api/generations/${first.id}`).expect(200)).body.data;
    expect(again.inputParameters.prompt).toBe("第一条");
    expect(again.inputParameters.duration).toBe(5);
    expect(again.inputParameters.resolution).toBe("720P");
  });
});

describe("模式与素材守卫", () => {
  it("视频编辑缺少参考视频时拒绝，并指向素材缺失", async () => {
    const { app, channel } = await setup();
    const response = await request(app).post("/api/generations").send({
      channelId: channel.id, model: channel.models[0], prompt: "改成赛博朋克",
      wanVideoMode: "video-edit", resolution: "720P", duration: 5,
    }).expect(400);
    expect(response.body.error.code).toBe("MODE_MEDIA_REQUIRED");
  });

  it("Seedance 没有视频编辑语义，直接拒绝而不是发给上游", async () => {
    const { app, seedance } = await setup();
    const response = await request(app).post("/api/generations").send({
      channelId: seedance.id, model: seedance.models[0], prompt: "延长这段视频",
      seedanceVideoMode: "video-edit", resolution: "720p", duration: 5,
    }).expect(400);
    // Seedance 的模式枚举里根本没有 video-edit，请求体这一层就被挡下；
    // 能通过枚举的非法组合（缺素材、模型不支持）由 video-mode-guard 拦。
    expect(response.body.error.code).toBe("INVALID_INPUT");
  });

  it("可灵 turbo 不支持参考图模式，模型级能力也要拦", async () => {
    const { app, kling } = await setup();
    const response = await request(app).post("/api/generations").send({
      channelId: kling.id, model: kling.models[0], prompt: "参考这张图",
      klingVideoMode: "reference", resolution: "720p", duration: 5,
      klingVideoMedia: [{ type: "reference_image", url: `data:image/png;base64,${pngBase64}` }],
    }).expect(400);
    expect(response.body.error.code).toBe("MODE_UNSUPPORTED");
  });

  it("固定槽位模式的图片数量必须齐", async () => {
    const { app, channel } = await setup();
    const response = await request(app).post("/api/generations").send({
      channelId: channel.id, model: channel.models[0], prompt: "首尾帧",
      wanVideoMode: "first-last-frame", resolution: "720P", duration: 5,
      wanVideoMedia: [{ type: "first_frame", url: `data:image/png;base64,${pngBase64}` }],
    }).expect(400);
    expect(response.body.error.code).toBe("MODE_MEDIA_REQUIRED");
  });
});
