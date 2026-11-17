import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createApp } from "../src/server/app";
import { buildCapabilityAliases, type CapabilityAlias } from "../src/server/capabilities";
import { prepareMusicInput } from "../src/server/agent-tools/audio";
import type { ToolContext } from "../src/server/agent-tools/shared";
import { nativeAudioSpecs, nativeMusicParamsSchema, nativeSpeechParamsSchema, prepareNativeAudio } from "../src/server/chat-tools/native-audio";

/**
 * 聊天侧的音乐参数必须「宽进」。
 *
 * v2.3.9 之后用户报过一次「音乐参数无效，请检查模式、歌词和源歌曲」，卡片上就是这么一句话，
 * 参数其实一个都没缺——子 schema 把父 schema 的容错重声明覆盖掉了。这些用例把宽容行为钉住，
 * 免得下次有人为了「更严谨」再把 `.strict()` 加回来。
 */
describe("聊天侧音乐参数宽容度", () => {
  it("大脑写了个枚举外的 mode、把布尔写成字符串，仍然能过", () => {
    const parsed = nativeMusicParamsSchema.safeParse({
      prompt: "雨后的城市，温暖民谣",
      mode: "song",            // 枚举里没有，父 schema 会直接丢掉
      instrumental: "false",   // 字符串，靠 z.coerce.boolean() 收下
      loop: "true",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.mode).toBeUndefined();
    expect(parsed.success && parsed.data.instrumental).toBe(false);
    expect(parsed.success && parsed.data.loop).toBe(true);
  });

  it("多给的字段直接丢掉，不整轮失败", () => {
    const parsed = nativeMusicParamsSchema.safeParse({
      prompt: "深夜 lo-fi",
      bpm: 88,                 // 大脑自己发明的字段
      aspectRatio: "1:1",
      makeInstrumental: false,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && "bpm" in parsed.data).toBe(false);
  });

  it("lyrics 当作 prompt 的别名收下", () => {
    const parsed = nativeMusicParamsSchema.safeParse({
      mode: "custom", tags: "city pop", lyrics: "[Verse]\n霓虹把街道泡软",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.lyrics).toContain("霓虹");
  });

  it("数值越界这种真错误还是要拦，并且能说清是哪个字段", () => {
    const parsed = nativeMusicParamsSchema.safeParse({ prompt: "x", tempo: 999 });
    expect(parsed.success).toBe(false);
    const issues = parsed.success ? [] : parsed.error.issues;
    expect(issues.some((issue) => issue.path.join(".") === "tempo")).toBe(true);
  });

  it("工具描述里带上了 lyrics，大脑知道可以这么写", () => {
    const spec = nativeAudioSpecs.generate_music.function.parameters as { properties: Record<string, unknown> };
    expect(Object.keys(spec.properties)).toContain("lyrics");
    expect(Object.keys(spec.properties)).toContain("instrumental");
  });

  it("配音多给的字段也直接丢掉", () => {
    const parsed = nativeSpeechParamsSchema.safeParse({ text: "你好", voice: "Kore", emotion: "warm", speed: 1.2 });
    expect(parsed.success).toBe(true);
    expect(parsed.success && "emotion" in parsed.data).toBe(false);
  });
});

describe("prompt 与 lyrics 的合并", () => {
  const alias: CapabilityAlias = {
    alias: "suno", kind: "audio", channelId: "ch-music", channelName: "音乐",
    model: "suno_damobi_music", adapterType: "suno-music", traits: "写歌",
  };
  const ctx = {
    db: { getChannel: () => ({ id: "ch-music", adapterType: "suno-music" }) },
    conversation: { id: "conv-1" },
    aliases: [alias],
    defaultAliases: {},
    verbatimPrompt: null,
    strictSubmission: false,
  } as never;

  it("只给了 lyrics 时用它当歌词", () => {
    const prepared = prepareMusicInput(ctx, { mode: "custom", tags: "city pop", lyrics: "[Verse]\n霓虹把街道泡软" });
    expect("input" in prepared && prepared.input.prompt).toContain("霓虹");
  });

  it("两个都给时 prompt 优先", () => {
    const prepared = prepareMusicInput(ctx, { mode: "custom", tags: "city pop", prompt: "[Verse]\n山顶的风", lyrics: "[Verse]\n霓虹把街道泡软" });
    expect("input" in prepared && prepared.input.prompt).toContain("山顶的风");
  });

  it("prompt 是空串时退回 lyrics", () => {
    const prepared = prepareMusicInput(ctx, { mode: "custom", tags: "city pop", prompt: "   ", lyrics: "[Verse]\n霓虹把街道泡软" });
    expect("input" in prepared && prepared.input.prompt).toContain("霓虹");
  });
});

describe("参数校验开关没被改坏", () => {
  it("schema 仍然是标准 object schema（能被 toJSONSchema 序列化）", () => {
    const json = z.toJSONSchema(nativeMusicParamsSchema) as Record<string, unknown>;
    expect(json.type).toBe("object");
  });
});

/**
 * 复现用户截图那次报错：大脑给的音乐参数里有枚举外的 mode、字符串布尔和自造字段。
 * 之前这些会让 `prepareNativeAudio` 直接回「音乐参数无效」，卡片上就是那句话。
 */
describe("脏参数不再整轮失败", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.();
  });

  const setup = async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-native-audio-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });
    await request(app).post("/api/channels").send({
      name: "音乐", baseUrl: "http://127.0.0.1:1", adapterType: "suno-music", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "/api/queue/makeAiMusic",
      models: ["suno_damobi_music"], allowPrivateNetwork: true, enabled: true,
    }).expect(201);
    const conversation = context.db.createConversation({
      title: "音频参数", brainChannelId: "brain-test", brainModel: "mock-brain",
      videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false,
    });
    const ctx = {
      db: context.db,
      conversation,
      aliases: buildCapabilityAliases(context.db.listChannels()),
      defaultAliases: {},
      verbatimPrompt: null,
      strictSubmission: true,
    } as unknown as ToolContext;
    return ctx;
  };

  it("枚举外的 mode、字符串布尔、自造字段都能走到确认卡", async () => {
    const ctx = await setup();
    const prepared = prepareNativeAudio(ctx, "generate_music", JSON.stringify({
      prompt: "写一首关于雨天的歌",
      mode: "make_song",
      instrumental: "false",
      tags: "acoustic pop",
      duration: 60,
      vocalGender: "female",
    }));
    expect("error" in prepared && prepared.error).toBeFalsy();
    const args = (prepared as { args: Record<string, unknown> }).args;
    expect(args.instrumental).toBe(false);
    // mode 认不出来就按 tags 走自定义，而不是把整轮调用打回去
    expect(args.mode).toBe("custom");
    expect(args.prompt).toContain("雨天的歌");
  });

  it("只给 lyrics 也能把歌词用上", async () => {
    const ctx = await setup();
    const prepared = prepareNativeAudio(ctx, "generate_music", JSON.stringify({
      width: 1, // 纯噪音字段
      tags: "city pop",
      lyrics: "[Verse]\n霓虹把街道泡软",
    }));
    expect("error" in prepared && prepared.error).toBeFalsy();
    const args = (prepared as { args: Record<string, unknown> }).args;
    expect(args.mode).toBe("custom");
    expect(args.prompt).toContain("霓虹把街道泡软");
  });

  it("真缺参数时，错误里说清是哪个字段", async () => {
    const ctx = await setup();
    const prepared = prepareNativeAudio(ctx, "generate_music", JSON.stringify({
      mode: "custom", tags: "city pop", title: "x".repeat(200),
    }));
    expect("error" in prepared).toBe(true);
    expect((prepared as { error: string }).error).toContain("title");
  });
});
