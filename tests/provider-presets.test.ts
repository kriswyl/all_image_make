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

const vectorengine = findProviderPreset("vectorengine")!;

function selectionFor(unitId: string) {
  const unit = vectorengine.units.find((item) => item.id === unitId)!;
  return { unitId, models: [...unit.models], secretEnv: unit.secretEnv };
}

describe("provider presets", () => {
  it("exposes the two relay providers", () => {
    expect(PROVIDER_PRESETS.map((preset) => preset.id)).toEqual(["vectorengine", "tiantoken"]);
  });

  it("gives gpt, gpt-c and gemini separate units with distinct secret envs", () => {
    const envs = vectorengine.units.map((unit) => unit.secretEnv);
    expect(new Set(envs).size).toBe(vectorengine.units.length);
    expect(vectorengine.units.find((unit) => unit.id === "gpt")!.secretEnv).toBe("VECTORENGINE_API_KEY");
    expect(vectorengine.units.find((unit) => unit.id === "gpt-c")!.secretEnv).toBe("VECTORENGINE_GPT_C_API_KEY");
    expect(vectorengine.units.find((unit) => unit.id === "gemini")!.secretEnv).toBe("VECTORENGINE_GEMINI_API_KEY");
  });

  it("keeps gpt and gpt-c model lists disjoint", () => {
    const gpt = vectorengine.units.find((unit) => unit.id === "gpt")!.models;
    const gptC = vectorengine.units.find((unit) => unit.id === "gpt-c")!.models;
    expect(gpt.some((model) => gptC.includes(model))).toBe(false);
  });
});

describe("buildChannelDrafts", () => {
  it("creates one channel per unit, carrying that unit's key", () => {
    const drafts = buildChannelDrafts(vectorengine, [
      { ...selectionFor("gpt"), apiKey: "sk-gpt" },
      { ...selectionFor("gpt-c"), apiKey: "sk-gpt-c" },
      selectionFor("gemini"),
    ]);
    expect(drafts.map((draft) => draft.name)).toEqual(["向量引擎-gpt", "向量引擎-gpt-c", "向量引擎-gemini"]);
    expect(drafts.map((draft) => draft.input.secretEnv)).toEqual([
      "VECTORENGINE_API_KEY", "VECTORENGINE_GPT_C_API_KEY", "VECTORENGINE_GEMINI_API_KEY",
    ]);
    expect(drafts[0].input.apiKey).toBe("sk-gpt");
    expect(drafts[1].input.apiKey).toBe("sk-gpt-c");
    expect(drafts[2].input.apiKey).toBeUndefined();
  });

  it("applies adapter default endpoints", () => {
    const [gpt, gemini] = buildChannelDrafts(vectorengine, [selectionFor("gpt"), selectionFor("gemini")]);
    expect(gpt.input.endpoint).toBe("/v1/images/generations");
    expect(gemini.input.endpoint).toBe("/v1beta/models/{model}:generateContent");
  });

  it("no longer exposes a Midjourney unit", () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.units.some((unit) => unit.id === "mj")).toBe(false);
      expect(preset.units.map((unit) => unit.adapterType)).not.toContain("midjourney-task");
    }
  });

  it("drops empty and unknown units", () => {
    const drafts = buildChannelDrafts(vectorengine, [
      { unitId: "gpt", models: [], secretEnv: "A" },
      { unitId: "missing", models: ["whatever"], secretEnv: "B" },
    ]);
    expect(drafts).toHaveLength(0);
  });

  it("honours a custom secret env override", () => {
    const [draft] = buildChannelDrafts(vectorengine, [{ ...selectionFor("gpt"), secretEnv: "MY_KEY" }]);
    expect(draft.input.secretEnv).toBe("MY_KEY");
  });
});

describe("conflict detection", () => {
  const [gptDraft, gptCDraft] = buildChannelDrafts(vectorengine, [selectionFor("gpt"), selectionFor("gpt-c")]);

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
      makeChannel({ id: "own", name: "向量引擎-gpt", models: ["gpt-image-2"] }),
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
    const [gptDraft, gptCDraft] = buildChannelDrafts(vectorengine, [selectionFor("gpt"), selectionFor("gpt-c")]);
    const channels = [
      makeChannel({ id: "own-gpt", name: "向量引擎-gpt", models: gptDraft.input.models }),
      makeChannel({ id: "own-gpt-c", name: "向量引擎-gpt-c", models: gptCDraft.input.models }),
    ];
    expect(findConflictChannels(gptDraft, channels)[0]?.id).toBe("own-gpt");
    expect(findConflictChannels(gptCDraft, channels)[0]?.id).toBe("own-gpt-c");
  });
});
