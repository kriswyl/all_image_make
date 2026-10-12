import { describe, expect, it } from "vitest";
import {
  buildChannelDrafts, findConflictChannels, findProviderPreset,
  normalizeBaseUrl, PROVIDER_PRESETS,
} from "../src/shared/provider-presets";
import type { Channel } from "../src/shared/types";

function makeChannel(overrides: Partial<Channel>): Channel {
  return {
    id: "channel-1", name: "Test", baseUrl: "https://api.vectorengine.cn", adapterType: "openai-images",
    authType: "bearer", authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations",
    models: ["gpt-image-2"], allowPrivateNetwork: false, enabled: true, hasKey: false, createdAt: "", updatedAt: "",
    ...overrides,
  };
}

const vectorengineGpt = findProviderPreset("vectorengine-gpt")!;

function selectionFor(preset: ReturnType<typeof findProviderPreset>, unitId: string) {
  if (!preset) throw new Error("Preset not found");
  const unit = preset.units.find((item) => item.id === unitId)!;
  return { unitId, models: [...unit.models], secretEnv: unit.secretEnv };
}

describe("provider presets", () => {
  it("exposes the relay and video providers", () => {
    expect(PROVIDER_PRESETS.map((preset) => preset.id)).toEqual([
      "vectorengine-gpt",
      "vectorengine-gpt-c",
      "vectorengine-gemini",
      "tiantoken-gpt",
      "tiantoken-gpt-c",
      "tiantoken-gemini",
      "tiantoken-wan-video",
      "tiantoken-grok-video",
      "tiantoken-seedance",
    ]);
  });

  it("points video presets at tiantoken relay", () => {
    const wanVideo = findProviderPreset("tiantoken-wan-video")!;
    expect(wanVideo.baseUrl).toBe("https://api.tiantoken.com");
    expect(wanVideo.units.map((unit) => unit.adapterType)).toEqual(["wan-video"]);

    const grokVideo = findProviderPreset("tiantoken-grok-video")!;
    expect(grokVideo.baseUrl).toBe("https://api.tiantoken.com");
    expect(grokVideo.units.map((unit) => unit.adapterType)).toEqual(["grok-video"]);
  });

  it("keeps the relay providers on their own hosts", () => {
    expect(findProviderPreset("tiantoken-gpt")!.baseUrl).toBe("https://api.tiantoken.com");
    expect(findProviderPreset("vectorengine-gpt")!.baseUrl).toBe("https://api.vectorengine.cn");
  });

  it("gives gpt, gpt-c and gemini separate presets with distinct secret envs", () => {
    expect(vectorengineGpt.units[0].secretEnv).toBe("VECTORENGINE_API_KEY");
    expect(findProviderPreset("vectorengine-gpt-c")!.units[0].secretEnv).toBe("VECTORENGINE_GPT_C_API_KEY");
    expect(findProviderPreset("vectorengine-gemini")!.units[0].secretEnv).toBe("VECTORENGINE_GEMINI_API_KEY");
  });

  it("keeps gpt and gpt-c model lists disjoint", () => {
    const gpt = vectorengineGpt.units[0].models;
    const gptC = findProviderPreset("vectorengine-gpt-c")!.units[0].models;
    expect(gpt.some((model) => gptC.includes(model))).toBe(false);
  });
});

describe("buildChannelDrafts", () => {
  it("creates one channel per unit, carrying that unit's key", () => {
    const drafts = buildChannelDrafts(vectorengineGpt, [
      { ...selectionFor(vectorengineGpt, "gpt"), apiKey: "sk-gpt" },
    ]);
    expect(drafts.map((draft) => draft.name)).toEqual(["向量引擎-gpt生图"]);
    expect(drafts.map((draft) => draft.input.secretEnv)).toEqual(["VECTORENGINE_API_KEY"]);
    expect(drafts[0].input.apiKey).toBe("sk-gpt");
  });

  it("applies adapter default endpoints", () => {
    const [gpt] = buildChannelDrafts(vectorengineGpt, [selectionFor(vectorengineGpt, "gpt")]);
    expect(gpt.input.endpoint).toBe("/v1/images/generations");
    const gemini = findProviderPreset("vectorengine-gemini")!;
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
    const drafts = buildChannelDrafts(vectorengineGpt, [
      { unitId: "gpt", models: [], secretEnv: "A" },
      { unitId: "missing", models: ["whatever"], secretEnv: "B" },
    ]);
    expect(drafts).toHaveLength(0);
  });

  it("honours a custom secret env override", () => {
    const [draft] = buildChannelDrafts(vectorengineGpt, [{ ...selectionFor(vectorengineGpt, "gpt"), secretEnv: "MY_KEY" }]);
    expect(draft.input.secretEnv).toBe("MY_KEY");
  });
});

describe("conflict detection", () => {
  const vectorengineGptC = findProviderPreset("vectorengine-gpt-c")!;
  const [gptDraft] = buildChannelDrafts(vectorengineGpt, [selectionFor(vectorengineGpt, "gpt")]);
  const [gptCDraft] = buildChannelDrafts(vectorengineGptC, [selectionFor(vectorengineGptC, "gpt-c")]);

  it("matches the built-in channel sharing models, not the sibling -c channel", () => {
    const channels = [
      makeChannel({ id: "builtin-gpt", name: "向量引擎-gpt-image-2", models: ["gpt-image-2"] }),
      makeChannel({ id: "builtin-gpt-c", name: "向量引擎-gpt-image-2-c", models: ["gpt-image-2-c"] }),
    ];
    expect(findConflictChannels(gptDraft, channels).map((channel) => channel.id)).toEqual(["builtin-gpt"]);
    expect(findConflictChannels(gptCDraft, channels).map((channel) => channel.id)).toEqual(["builtin-gpt-c"]);
  });

  it("prefers an exact name match so re-running the wizard updates its own channel", () => {
    const channels = [
      makeChannel({ id: "own", name: "向量引擎-gpt生图", models: ["gpt-image-2"] }),
      makeChannel({ id: "other", name: "向量引擎-gpt-image-2", models: ["gpt-image-2"] }),
    ];
    expect(findConflictChannels(gptDraft, channels).map((channel) => channel.id)).toEqual(["own"]);
  });

  it("ignores other adapters, other hosts and non-overlapping models", () => {
    const channels = [
      makeChannel({ id: "gemini", adapterType: "gemini-content", models: ["gpt-image-2"] }),
      makeChannel({ id: "other-host", baseUrl: "https://api.tiantoken.com", models: ["gpt-image-2"] }),
      makeChannel({ id: "no-overlap", models: ["some-other-model"] }),
    ];
    expect(findConflictChannels(gptDraft, channels)).toHaveLength(0);
  });

  it("normalizes trailing slashes when comparing hosts", () => {
    expect(normalizeBaseUrl("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
    const channels = [makeChannel({ id: "slash", baseUrl: "https://api.vectorengine.cn/", models: ["gpt-image-2"] })];
    expect(findConflictChannels(gptDraft, channels).map((channel) => channel.id)).toEqual(["slash"]);
  });
});

describe("duplicate detection across repeated wizard runs", () => {
  it("matches the channel this unit created before, not its sibling", () => {
    const gptC = findProviderPreset("vectorengine-gpt-c")!;
    const [gptDraft] = buildChannelDrafts(vectorengineGpt, [selectionFor(vectorengineGpt, "gpt")]);
    const [gptCDraft] = buildChannelDrafts(gptC, [selectionFor(gptC, "gpt-c")]);
    const channels = [
      makeChannel({ id: "own-gpt", name: "向量引擎-gpt生图", models: gptDraft.input.models }),
      makeChannel({ id: "own-gpt-c", name: "向量引擎-gpt-c生图", models: gptCDraft.input.models }),
    ];
    expect(findConflictChannels(gptDraft, channels)[0]?.id).toBe("own-gpt");
    expect(findConflictChannels(gptCDraft, channels)[0]?.id).toBe("own-gpt-c");
  });
});
