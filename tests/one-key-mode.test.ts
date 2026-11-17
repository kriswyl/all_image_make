/**
 * 一 Key 全开：一把密钥配好全部渠道。
 *
 * 这里钉住三件事：
 * ① 预设确实覆盖了站点卖的全部模型组，且共用同一个密钥名；
 * ② 每类模型的协议路径和图床与「按站点模板逐个配」完全一致（不能因为合并就配错地址）；
 * ③ 它不进 `PROVIDER_PRESETS`，否则站点卡片和引导里的模型气泡会各翻一倍。
 */
import { describe, expect, it } from "vitest";

import {
  buildChannelDrafts, buildOneKeyDrafts, findConflictChannels, findProviderPreset,
  ONE_KEY_PRESET, ONE_KEY_PRESET_ID, ONE_KEY_SECRET_ENV, PROVIDER_PRESETS,
} from "../src/shared/provider-presets";
import { MODEL_GROUPS } from "../src/shared/model-catalog";
import type { Channel } from "../src/shared/types";

describe("一 Key 预设", () => {
  it("覆盖站点卖的全部模型组，且只出现一次", () => {
    const sourceUnits = PROVIDER_PRESETS.flatMap((preset) => preset.units);
    expect(ONE_KEY_PRESET.units).toHaveLength(sourceUnits.length);
    // 单元 id 和适配器/模型组合一一对应，合并时没有丢也没有重复
    expect(ONE_KEY_PRESET.units.map((unit) => unit.id)).toEqual(sourceUnits.map((unit) => unit.id));
    expect(new Set(ONE_KEY_PRESET.units.map((unit) => unit.id)).size).toBe(ONE_KEY_PRESET.units.length);
    expect(ONE_KEY_PRESET.units.map((unit) => unit.adapterType)).toEqual(sourceUnits.map((unit) => unit.adapterType));
    // 每一类的模型清单原样带过来：一 key 不是「只给一个代表模型」
    expect(ONE_KEY_PRESET.units.map((unit) => unit.models)).toEqual(sourceUnits.map((unit) => unit.models));
  });

  it("所有单元共用一把密钥，但渠道名各不相同", () => {
    expect(ONE_KEY_PRESET.singleKey).toBe(true);
    expect(ONE_KEY_PRESET.sharedSecretEnv).toBe(ONE_KEY_SECRET_ENV);
    expect(ONE_KEY_PRESET.units.every((unit) => unit.secretEnv === ONE_KEY_SECRET_ENV)).toBe(true);
    const names = ONE_KEY_PRESET.units.map((unit) => unit.channelName);
    expect(new Set(names).size).toBe(names.length);
    // 名字里要能认出是哪一类模型，否则列表里 12 行全叫「词元流墟」
    for (const unit of ONE_KEY_PRESET.units) expect(unit.channelName).toContain(unit.label);
  });

  it("不污染按站点分组的模板列表与模型目录", () => {
    expect(PROVIDER_PRESETS.some((preset) => preset.id === ONE_KEY_PRESET_ID)).toBe(false);
    expect(MODEL_GROUPS).toHaveLength(PROVIDER_PRESETS.flatMap((preset) => preset.units).length);
    expect(MODEL_GROUPS.some((group) => group.preset.id === ONE_KEY_PRESET_ID)).toBe(false);
    // 但按 id 找得到，向导靠它渲染第一步
    expect(findProviderPreset(ONE_KEY_PRESET_ID)).toBe(ONE_KEY_PRESET);
  });
});

describe("一 Key 生成渠道", () => {
  it("同一把密钥铺给每个渠道", () => {
    const drafts = buildOneKeyDrafts("  sk-one-key  ");
    expect(drafts).toHaveLength(ONE_KEY_PRESET.units.length);
    expect(drafts.every((draft) => draft.input.apiKey === "sk-one-key")).toBe(true);
    expect(drafts.every((draft) => draft.input.secretEnv === ONE_KEY_SECRET_ENV)).toBe(true);
    expect(drafts.every((draft) => draft.input.baseUrl === "https://api.tiantoken.com")).toBe(true);
  });

  it("协议、路径、图床和逐个配模板时完全一致", () => {
    const oneKey = new Map(buildOneKeyDrafts("sk").map((draft) => [draft.input.adapterType + ":" + draft.input.models.join(","), draft.input]));
    for (const preset of PROVIDER_PRESETS) {
      for (const unit of preset.units) {
        const [single] = buildChannelDrafts(preset, [{
          unitId: unit.id, models: [...unit.models], secretEnv: unit.secretEnv,
        }]);
        const merged = oneKey.get(single!.input.adapterType + ":" + single!.input.models.join(","));
        expect(merged, `${preset.id}/${unit.id} 没有对应的合并渠道`).toBeTruthy();
        expect(merged).toMatchObject({
          adapterType: single!.input.adapterType,
          endpoint: single!.input.endpoint,
          models: single!.input.models,
        });
        // 图床跟着单元走：视频那几个要保持各自的 imageproxy，其余不该被顺手塞一个
        expect(merged!.uploadEndpoint).toBe(single!.input.uploadEndpoint);
        expect(merged!.uploadHeaders).toEqual(single!.input.uploadHeaders);
      }
    }
  });

  it("只配勾选的模型组", () => {
    const drafts = buildOneKeyDrafts("sk", ["gpt", "suno-music"]);
    expect(drafts.map((draft) => draft.input.adapterType)).toEqual(["openai-images", "suno-music"]);
  });

  it("留空密钥也能建（服务端按环境变量兜底）", () => {
    const drafts = buildOneKeyDrafts("   ");
    expect(drafts.every((draft) => draft.input.apiKey === undefined)).toBe(true);
    expect(drafts).toHaveLength(ONE_KEY_PRESET.units.length);
  });

  it("重跑一 key 能认出自己上次建的渠道，不会堆出两套", () => {
    const [gptDraft] = buildOneKeyDrafts("sk", ["gpt"]);
    const existing: Channel = {
      id: "own", name: gptDraft!.name, baseUrl: "https://api.tiantoken.com", adapterType: "openai-images",
      authType: "bearer", authHeaderName: "", secretEnv: ONE_KEY_SECRET_ENV,
      endpoint: "/v1/images/generations", models: gptDraft!.input.models,
      allowPrivateNetwork: false, enabled: true, hasKey: true, createdAt: "", updatedAt: "",
    };
    expect(findConflictChannels(gptDraft!, [existing]).map((channel) => channel.id)).toEqual(["own"]);
  });

  it("也能覆盖掉早先按单个模板建的渠道（同站点同协议且有模型交集）", () => {
    const [gptDraft] = buildOneKeyDrafts("sk", ["gpt"]);
    const legacy: Channel = {
      id: "legacy", name: "词元流墟-gpt生图", baseUrl: "https://api.tiantoken.com", adapterType: "openai-images",
      authType: "bearer", authHeaderName: "", secretEnv: "TIANTOKEN_GPT_API_KEY",
      endpoint: "/v1/images/generations", models: ["gpt-image-2"],
      allowPrivateNetwork: false, enabled: true, hasKey: true, createdAt: "", updatedAt: "",
    };
    expect(findConflictChannels(gptDraft!, [legacy]).map((channel) => channel.id)).toEqual(["legacy"]);
  });
});
