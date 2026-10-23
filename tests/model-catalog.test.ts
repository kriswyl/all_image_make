/**
 * 「先选模型」引导的数据层：模型组从模板派生，选中后能正确归并成渠道草稿。
 * 这里不渲染 React，只钉住「选了什么 → 保存成什么」。
 */
import { describe, expect, it } from "vitest";
import {
  MODEL_GROUPS, MODEL_GROUP_SECTIONS, RECOMMENDED_MODELS,
  draftForGroup, duplicateFor, findModelGroup, groupsForKind, recommendedModelFor,
} from "../src/shared/model-catalog";
import type { Channel } from "../src/shared/types";

function makeChannel(overrides: Partial<Channel>): Channel {
  return {
    id: "channel-1", name: "词元流墟-gpt生图", baseUrl: "https://api.tiantoken.com",
    adapterType: "openai-images", authType: "bearer", authHeaderName: "", secretEnv: "TIANTOKEN_GPT_API_KEY",
    endpoint: "/v1/images/generations", models: ["gpt-image-2"], allowPrivateNetwork: false,
    enabled: true, hasKey: true, createdAt: "", updatedAt: "",
    ...overrides,
  };
}

describe("model catalog", () => {
  it("从模板派生出三类模型组，不再包含向量引擎", () => {
    expect(MODEL_GROUPS.map((group) => group.key)).toEqual([
      "tiantoken-gpt:gpt",
      "tiantoken-gpt-c:gpt-c",
      "tiantoken-gemini:gemini",
      "tiantoken-midjourney:midjourney",
      "tiantoken-wan-video:wan-video",
      "tiantoken-grok-video:grok-video",
      "tiantoken-seedance:seedance-video",
      "tiantoken-kling-video:kling-video",
      "tiantoken-suno:suno-music",
      "tiantoken-gemini-tts:gemini-tts",
      "tiantoken-chat:chat",
    ]);
    expect(MODEL_GROUPS.every((group) => !group.key.startsWith("vectorengine"))).toBe(true);
    expect(MODEL_GROUPS.filter((group) => group.kind === "image")).toHaveLength(4);
    expect(MODEL_GROUPS.filter((group) => group.kind === "video")).toHaveLength(4);
    expect(MODEL_GROUPS.filter((group) => group.kind === "audio")).toHaveLength(2);
    expect(MODEL_GROUPS.filter((group) => group.kind === "chat")).toHaveLength(1);
    expect(MODEL_GROUP_SECTIONS.map((section) => section.kind)).toEqual(["image", "video", "audio", "chat"]);
  });

  it("推荐组合里的模型都真的属于对应模型组", () => {
    for (const [key, model] of Object.entries(RECOMMENDED_MODELS)) {
      const group = findModelGroup(key);
      expect(group).toBeTruthy();
      expect(group!.unit.models).toContain(model);
    }
  });

  it("生图推荐落在 -c 系列：gpt-image-2.5-sunburst-c", () => {
    expect(RECOMMENDED_MODELS["tiantoken-gpt-c:gpt-c"]).toBe("gpt-image-2.5-sunburst-c");
    const recommended = recommendedModelFor("image");
    expect(recommended?.model).toBe("gpt-image-2.5-sunburst-c");
    expect(recommended?.group.kind).toBe("image");
  });

  it("每类都能拿到用于聚光灯的推荐模型，且不会指向别的类", () => {
    for (const kind of ["chat", "image", "video", "audio"] as const) {
      const recommended = recommendedModelFor(kind);
      expect(recommended).toBeTruthy();
      expect(recommended!.group.kind).toBe(kind);
      expect(groupsForKind(kind).some((group) => group.key === recommended!.group.key)).toBe(true);
      expect(recommended!.group.unit.models).toContain(recommended!.model);
    }
  });

  it("选中的模型归并成一份渠道草稿：名字、地址、环境变量、模型都对", () => {
    const group = findModelGroup("tiantoken-gpt-c:gpt-c")!;
    const draft = draftForGroup(group, ["gpt-image-2-c", "gpt-image-2.5-flare-c"], "TIANTOKEN_GPT_C_API_KEY", "sk-test");
    expect(draft).toBeTruthy();
    expect(draft!.name).toBe("词元流墟-gpt-c生图");
    expect(draft!.input.baseUrl).toBe("https://api.tiantoken.com");
    expect(draft!.input.adapterType).toBe("openai-images");
    expect(draft!.input.models).toEqual(["gpt-image-2-c", "gpt-image-2.5-flare-c"]);
    expect(draft!.input.secretEnv).toBe("TIANTOKEN_GPT_C_API_KEY");
    expect(draft!.input.apiKey).toBe("sk-test");
  });

  it("已有同模型渠道时识别为覆盖，而不是再建一个", () => {
    const group = findModelGroup("tiantoken-gpt:gpt")!;
    const draft = draftForGroup(group, ["gpt-image-2"], "TIANTOKEN_GPT_API_KEY")!;
    expect(duplicateFor(draft, [makeChannel({})])?.id).toBe("channel-1");
    expect(duplicateFor(draft, [makeChannel({ baseUrl: "https://api.vectorengine.cn" })])).toBeUndefined();
    expect(duplicateFor(draft, [makeChannel({ name: "另一个渠道", models: ["gemini-3-pro-image"] })])).toBeUndefined();
  });
});
