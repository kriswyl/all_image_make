import { describe, expect, it } from "vitest";
import {
  adapterDefaultEndpoint, buildChannelDrafts, findConflictChannels, findProviderPreset,
  normalizeBaseUrl, PROVIDER_PRESETS,
} from "../src/shared/provider-presets";
import type { Channel } from "../src/shared/types";

function makeChannel(overrides: Partial<Channel>): Channel {
  return {
    id: "channel-1", name: "Test", baseUrl: "https://api.tiantoken.com", adapterType: "openai-images",
    authType: "bearer", authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations",
    models: ["gpt-image-2"], allowPrivateNetwork: false, enabled: true, hasKey: false, createdAt: "", updatedAt: "",
    ...overrides,
  };
}

const tiantokenGpt = findProviderPreset("tiantoken-gpt")!;

function selectionFor(preset: ReturnType<typeof findProviderPreset>, unitId: string) {
  if (!preset) throw new Error("Preset not found");
  const unit = preset.units.find((item) => item.id === unitId)!;
  return { unitId, models: [...unit.models], secretEnv: unit.secretEnv };
}

describe("provider presets", () => {
  it("exposes only the relay and video providers we still support", () => {
    expect(PROVIDER_PRESETS.map((preset) => preset.id)).toEqual([
      "tiantoken-gpt",
      "tiantoken-gpt-c",
      "tiantoken-gemini",
      "tiantoken-midjourney",
      "tiantoken-wan-video",
      "tiantoken-grok-video",
      "tiantoken-seedance",
      "tiantoken-kling-video",
      "tiantoken-suno",
      "tiantoken-gemini-tts",
      "tiantoken-chat",
    ]);
    // 向量引擎模板暂时下线；手工自定义渠道仍然可以填它的 Base URL
    expect(PROVIDER_PRESETS.some((preset) => preset.id.startsWith("vectorengine"))).toBe(false);
  });

  it("exposes the chat brain as an openai-chat unit, not a generation unit", () => {
    const chat = findProviderPreset("tiantoken-chat")!;
    expect(chat.baseUrl).toBe("https://api.tiantoken.com");
    expect(chat.units.map((unit) => unit.adapterType)).toEqual(["openai-chat"]);
    expect(chat.units[0].secretEnv).toBe("TIANTOKEN_CHAT_API_KEY");
    // 大脑默认路径必须和 openai-chat 服务端默认值一致，否则渠道建出来会打错地址
    expect(chat.units[0].endpoint ?? adapterDefaultEndpoint("openai-chat").endpoint).toBe("/v1/chat/completions");
  });

  it("points video presets at tiantoken relay", () => {
    const wanVideo = findProviderPreset("tiantoken-wan-video")!;
    expect(wanVideo.baseUrl).toBe("https://api.tiantoken.com");
    expect(wanVideo.units.map((unit) => unit.adapterType)).toEqual(["wan-video"]);

    const grokVideo = findProviderPreset("tiantoken-grok-video")!;
    expect(grokVideo.baseUrl).toBe("https://api.tiantoken.com");
    expect(grokVideo.units.map((unit) => unit.adapterType)).toEqual(["grok-video"]);
  });

  it("adds the Gemini TTS unit with the three requested models", () => {
    const tts = findProviderPreset("tiantoken-gemini-tts")!;
    expect(tts.units.map((unit) => unit.adapterType)).toEqual(["gemini-tts"]);
    expect(tts.units[0]!.secretEnv).toBe("TIANTOKEN_GEMINI_TTS_API_KEY");
    expect(tts.units[0]!.models).toEqual([
      "gemini-3.8-flash-tts",
      "gemini-3.8-flash-lite-tts",
      "gemini-3.1-flash-tts-preview",
    ]);
    const [draft] = buildChannelDrafts(tts, [selectionFor(tts, "gemini-tts")]);
    expect(draft!.input.endpoint).toBe("/v1beta/models/{model}:generateContent");
  });

  it("adds Midjourney with mj_imagine and action models", () => {
    const mj = findProviderPreset("tiantoken-midjourney")!;
    expect(mj.units.map((unit) => unit.adapterType)).toEqual(["midjourney"]);
    // mj_edits 不再展示：加参考图时 mj_imagine 自动走图生图
    expect(mj.units[0]!.models).toEqual([
      "mj_imagine", "mj_upscale", "mj_variation", "mj_reroll",
    ]);
    const [draft] = buildChannelDrafts(mj, [selectionFor(mj, "midjourney")]);
    expect(draft!.input.endpoint).toBe("/mj/submit/imagine");
  });

  it("keeps image presets on the tiantoken relay", () => {
    expect(findProviderPreset("tiantoken-gpt")!.baseUrl).toBe("https://api.tiantoken.com");
    expect(findProviderPreset("tiantoken-gemini")!.baseUrl).toBe("https://api.tiantoken.com");
  });

  it("gives gpt, gpt-c and gemini separate presets with distinct secret envs", () => {
    expect(tiantokenGpt.units[0].secretEnv).toBe("TIANTOKEN_GPT_API_KEY");
    expect(findProviderPreset("tiantoken-gpt-c")!.units[0].secretEnv).toBe("TIANTOKEN_GPT_C_API_KEY");
    expect(findProviderPreset("tiantoken-gemini")!.units[0].secretEnv).toBe("TIANTOKEN_GEMINI_API_KEY");
  });

  it("keeps gpt and gpt-c model lists disjoint", () => {
    const gpt = tiantokenGpt.units[0].models;
    const gptC = findProviderPreset("tiantoken-gpt-c")!.units[0].models;
    expect(gpt.some((model) => gptC.includes(model))).toBe(false);
  });

  it("includes nano-banana 2.1 in the gemini image models", () => {
    const models = findProviderPreset("tiantoken-gemini")!.units[0].models;
    expect(models).toContain("gemini-nano-banana-2.1");
    expect(models).toContain("gemini-nano-banana-2.1-preview");
  });
});

describe("buildChannelDrafts", () => {
  it("creates one channel per unit, carrying that unit's key", () => {
    const drafts = buildChannelDrafts(tiantokenGpt, [
      { ...selectionFor(tiantokenGpt, "gpt"), apiKey: "sk-gpt" },
    ]);
    expect(drafts.map((draft) => draft.name)).toEqual(["词元流墟-gpt生图"]);
    expect(drafts.map((draft) => draft.input.secretEnv)).toEqual(["TIANTOKEN_GPT_API_KEY"]);
    expect(drafts[0].input.apiKey).toBe("sk-gpt");
  });

  it("applies adapter default endpoints", () => {
    const [gpt] = buildChannelDrafts(tiantokenGpt, [selectionFor(tiantokenGpt, "gpt")]);
    expect(gpt.input.endpoint).toBe("/v1/images/generations");
    const gemini = findProviderPreset("tiantoken-gemini")!;
    const [geminiDraft] = buildChannelDrafts(gemini, [selectionFor(gemini, "gemini")]);
    expect(geminiDraft.input.endpoint).toBe("/v1beta/models/{model}:generateContent");
  });

  it("keeps the video presets on their documented endpoints", () => {
    const wan = findProviderPreset("tiantoken-wan-video")!;
    const [wanDraft] = buildChannelDrafts(wan, [selectionFor(wan, "wan-video")]);
    expect(wanDraft.input.endpoint).toBe("/api/v1/services/aigc/video-generation/video-synthesis");

    const grok = findProviderPreset("tiantoken-grok-video")!;
    const [grokDraft] = buildChannelDrafts(grok, [selectionFor(grok, "grok-video")]);
    expect(grokDraft.input.endpoint).toBe("/v1/videos/generations");
    expect(grokDraft.input.models).toEqual([
      "grok-imagine-video", "grok-imagine-video-1.5-preview", "grok-imagine-video-1.5",
    ]);
  });

  it("no longer exposes a Midjourney unit", () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.units.some((unit) => unit.id === "mj")).toBe(false);
      expect(preset.units.map((unit) => unit.adapterType)).not.toContain("midjourney-task");
    }
  });

  it("drops empty and unknown units", () => {
    const drafts = buildChannelDrafts(tiantokenGpt, [
      { unitId: "gpt", models: [], secretEnv: "A" },
      { unitId: "missing", models: ["whatever"], secretEnv: "B" },
    ]);
    expect(drafts).toHaveLength(0);
  });

  it("honours a custom secret env override", () => {
    const [draft] = buildChannelDrafts(tiantokenGpt, [{ ...selectionFor(tiantokenGpt, "gpt"), secretEnv: "MY_KEY" }]);
    expect(draft.input.secretEnv).toBe("MY_KEY");
  });
});

describe("conflict detection", () => {
  const tiantokenGptC = findProviderPreset("tiantoken-gpt-c")!;
  const [gptDraft] = buildChannelDrafts(tiantokenGpt, [selectionFor(tiantokenGpt, "gpt")]);
  const [gptCDraft] = buildChannelDrafts(tiantokenGptC, [selectionFor(tiantokenGptC, "gpt-c")]);

  it("matches the built-in channel sharing models, not the sibling -c channel", () => {
    const channels = [
      makeChannel({ id: "builtin-gpt", name: "词元流墟-gpt-image-2", models: ["gpt-image-2"] }),
      makeChannel({ id: "builtin-gpt-c", name: "词元流墟-gpt-image-2-c", models: ["gpt-image-2-c"] }),
    ];
    expect(findConflictChannels(gptDraft, channels).map((channel) => channel.id)).toEqual(["builtin-gpt"]);
    expect(findConflictChannels(gptCDraft, channels).map((channel) => channel.id)).toEqual(["builtin-gpt-c"]);
  });

  it("prefers an exact name match so re-running the wizard updates its own channel", () => {
    const channels = [
      makeChannel({ id: "own", name: "词元流墟-gpt生图", models: ["gpt-image-2"] }),
      makeChannel({ id: "other", name: "词元流墟-gpt-image-2", models: ["gpt-image-2"] }),
    ];
    expect(findConflictChannels(gptDraft, channels).map((channel) => channel.id)).toEqual(["own"]);
  });

  it("ignores other adapters, other hosts and non-overlapping models", () => {
    const channels = [
      makeChannel({ id: "gemini", adapterType: "gemini-content", models: ["gpt-image-2"] }),
      makeChannel({ id: "other-host", baseUrl: "https://api.vectorengine.cn", models: ["gpt-image-2"] }),
      makeChannel({ id: "no-overlap", models: ["some-other-model"] }),
    ];
    expect(findConflictChannels(gptDraft, channels)).toHaveLength(0);
  });

  it("normalizes trailing slashes when comparing hosts", () => {
    expect(normalizeBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
    const channels = [makeChannel({ id: "slash", baseUrl: "https://api.tiantoken.com/", models: ["gpt-image-2"] })];
    expect(findConflictChannels(gptDraft, channels).map((channel) => channel.id)).toEqual(["slash"]);
  });
});

describe("duplicate detection across repeated wizard runs", () => {
  it("matches the channel this unit created before, not its sibling", () => {
    const gptC = findProviderPreset("tiantoken-gpt-c")!;
    const [gptDraft] = buildChannelDrafts(tiantokenGpt, [selectionFor(tiantokenGpt, "gpt")]);
    const [gptCDraft] = buildChannelDrafts(gptC, [selectionFor(gptC, "gpt-c")]);
    const channels = [
      makeChannel({ id: "own-gpt", name: "词元流墟-gpt生图", models: gptDraft.input.models }),
      makeChannel({ id: "own-gpt-c", name: "词元流墟-gpt-c生图", models: gptCDraft.input.models }),
    ];
    expect(findConflictChannels(gptDraft, channels)[0]?.id).toBe("own-gpt");
    expect(findConflictChannels(gptCDraft, channels)[0]?.id).toBe("own-gpt-c");
  });
});
