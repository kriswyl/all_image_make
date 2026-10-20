/**
 * 「这次视频用哪几张图、哪种模式」的纯逻辑。
 *
 * 这里是用户报的问题 2 的核心：一两张图 + 同时支持首尾帧/参考生视频的模型，
 * 不能替用户猜。规则要能单独测，不能藏在网络请求和确认卡后面。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/server/app";
import { resolveVideoSelection } from "../src/server/agent-tools";
import type { GenerateVideoArgs } from "../src/shared/agent-types";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const pngBytes = Buffer.from(pngBase64, "base64");
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function setup(count = 3) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-select-"));
  const { app, context } = createApp({ dataDir });
  cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

  const brain = (await request(app).post("/api/channels").send({
    name: "Brain", baseUrl: "http://127.0.0.1:1", adapterType: "openai-chat", authType: "none",
    authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
    models: ["mock-brain"], allowPrivateNetwork: true, enabled: true,
  }).expect(201)).body.data;

  const conversationId = (await request(app).post("/api/conversations")
    .send({ brainChannelId: brain.id, brainModel: "mock-brain" })).body.data.id as string;

  let call = request(app).post(`/api/conversations/${conversationId}/uploads`);
  for (let index = 0; index < count; index += 1) call = call.attach("images", pngBytes, `图${index + 1}.png`);
  const ids = (await call.expect(201)).body.data.canvasAssetIds as string[];
  return { app, context, conversationId, ids };
}

function args(overrides: Partial<GenerateVideoArgs> = {}): GenerateVideoArgs {
  return { prompt: "测试", ...overrides };
}

describe("resolveVideoSelection", () => {
  it("一张图不写 mode：默认首帧；Grok 默认参考图", async () => {
    const { context, conversationId, ids } = await setup(1);
    const conversation = context.db.getConversation(conversationId)!;

    const wan = resolveVideoSelection(context.db, conversation, args({ imageRefs: [ids[0]!.slice(0, 4)] }), "wan-video", []);
    expect(wan.selection?.mode).toBe("first-frame");
    expect(wan.selection?.roles).toEqual(["first_frame"]);

    const grok = resolveVideoSelection(context.db, conversation, args({ imageRefs: [ids[0]!] }), "grok-video", []);
    expect(grok.selection?.mode).toBe("reference");
    expect(grok.selection?.roles).toEqual(["reference_image"]);
  });

  it("两张图不写 mode：万相/Seedance 拒绝并要求先 ask；Grok 直接按参考图", async () => {
    const { context, conversationId, ids } = await setup(2);
    const conversation = context.db.getConversation(conversationId)!;
    const refs = ids.map((id) => id.slice(0, 4));

    for (const adapter of ["wan-video", "seedance-video"]) {
      const result = resolveVideoSelection(context.db, conversation, args({ imageRefs: refs }), adapter, []);
      expect(result.selection).toBeUndefined();
      expect(result.error).toContain("ask");
      expect(result.error).toContain("first-last-frame");
      expect(result.error).toContain("reference");
    }

    const grok = resolveVideoSelection(context.db, conversation, args({ imageRefs: refs }), "grok-video", []);
    expect(grok.selection?.mode).toBe("reference");
    expect(grok.selection?.assets).toHaveLength(2);
  });

  it("首尾帧：正好两张，顺序就是首帧、尾帧；数量不对直接失败", async () => {
    const { context, conversationId, ids } = await setup(3);
    const conversation = context.db.getConversation(conversationId)!;

    const ok = resolveVideoSelection(context.db, conversation,
      args({ mode: "first-last-frame", imageRefs: [ids[0]!, ids[1]!] }), "wan-video", []);
    expect(ok.selection?.roles).toEqual(["first_frame", "last_frame"]);
    expect(ok.selection?.assets.map((asset) => asset.id)).toEqual([ids[0], ids[1]]);

    const one = resolveVideoSelection(context.db, conversation,
      args({ mode: "first-last-frame", imageRefs: [ids[0]!] }), "wan-video", []);
    expect(one.error).toContain("正好 2 张");

    const same = resolveVideoSelection(context.db, conversation,
      args({ mode: "first-last-frame", imageRefs: [ids[0]!, ids[0]!] }), "wan-video", []);
    expect(same.error).toContain("同一张");
  });

  it("参考生视频：1~N 张都是 reference_image；重复的会去重并说明", async () => {
    const { context, conversationId, ids } = await setup(3);
    const conversation = context.db.getConversation(conversationId)!;
    const result = resolveVideoSelection(context.db, conversation,
      args({ mode: "reference", imageRefs: ids }), "wan-video", []);
    expect(result.selection?.roles).toEqual(["reference_image", "reference_image", "reference_image"]);

    const duped = resolveVideoSelection(context.db, conversation,
      args({ mode: "reference", imageRefs: [ids[0]!, ids[0]!, ids[1]!] }), "wan-video", []);
    expect(duped.selection?.assets).toHaveLength(2);
    expect(duped.selection?.notes.join("")).toContain("重复");
  });

  it("Grok 不认首帧/首尾帧；文生视频也不能塞 imageRefs", async () => {
    const { context, conversationId, ids } = await setup(2);
    const conversation = context.db.getConversation(conversationId)!;

    expect(resolveVideoSelection(context.db, conversation,
      args({ mode: "first-frame", imageRefs: [ids[0]!] }), "grok-video", []).error).toContain("不支持");
    expect(resolveVideoSelection(context.db, conversation,
      args({ mode: "first-last-frame", imageRefs: [ids[0]!, ids[1]!] }), "grok-video", []).error).toContain("不支持");
    expect(resolveVideoSelection(context.db, conversation,
      args({ mode: "text-to-video", imageRefs: [ids[0]!] }), "wan-video", []).error).toContain("不带图片");
    expect(resolveVideoSelection(context.db, conversation,
      args({ mode: "video-edit" }), "wan-video", []).error).toContain("不支持");
  });

  it("本条消息附带的图优先；没有附带、画布多于一张且点名 current 时要求先选", async () => {
    const { context, conversationId, ids } = await setup(2);
    const conversation = context.db.getConversation(conversationId)!;

    const attached = resolveVideoSelection(context.db, conversation, args(), "wan-video", [ids[1]!]);
    expect(attached.selection?.mode).toBe("first-frame");
    expect(attached.selection?.assets.map((asset) => asset.id)).toEqual([ids[1]]);

    const ambiguous = resolveVideoSelection(context.db, conversation, args({ imageFrom: "current" }), "wan-video", []);
    expect(ambiguous.error).toContain("画布上有 2 张图");

    // 没点名、没附带、也没说要当前画布：当成纯文生视频，不要擅自带图
    const text = resolveVideoSelection(context.db, conversation, args(), "wan-video", []);
    expect(text.selection?.mode).toBe("text-to-video");
    expect(text.selection?.assets).toEqual([]);

    // 明确 imageFrom:none 时同理
    const explicitText = resolveVideoSelection(context.db, conversation, args({ imageFrom: "none" }), "wan-video", []);
    expect(explicitText.selection?.mode).toBe("text-to-video");
  });

  it("引用不存在 / 不是图片时硬失败，不静默少发一张", async () => {
    const { context, conversationId } = await setup(1);
    const conversation = context.db.getConversation(conversationId)!;
    const result = resolveVideoSelection(context.db, conversation,
      args({ mode: "first-frame", imageRefs: ["deadbeef"] }), "wan-video", []);
    expect(result.selection).toBeUndefined();
    expect(result.error).toContain("deadbeef");
  });
});
