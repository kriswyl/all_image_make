import { describe, expect, it } from "vitest";
import {
  BUILTIN_STYLE_PRESETS, applyStyleSuffix, mergeStyleNegative, stripStyleSuffix,
} from "../src/shared/style-presets";

const cinematic = { prompt: BUILTIN_STYLE_PRESETS[0]!.prompt };

describe("风格模板", () => {
  it("拼到提示词末尾，剥掉时能回到原文", () => {
    const base = "清晨的老巷早餐铺，老陈在揉面";
    const styled = applyStyleSuffix(base, cinematic);
    expect(styled).toBe(`${base}，${cinematic.prompt}`);
    expect(stripStyleSuffix(styled, cinematic.prompt)).toBe(base);
  });

  it("换风格时不会越拼越长，也不会残留上一套形容词", () => {
    const base = "清晨的老巷早餐铺";
    const once = applyStyleSuffix(base, cinematic);
    const twice = applyStyleSuffix(once, { prompt: "黑白摄影，高反差硬光" }, cinematic.prompt);
    expect(twice).toBe(`${base}，黑白摄影，高反差硬光`);
    expect(twice).not.toContain("35mm");
  });

  it("相同的风格重复套用是幂等的", () => {
    const base = "雨夜的街道";
    const once = applyStyleSuffix(base, cinematic);
    expect(applyStyleSuffix(once, cinematic, cinematic.prompt)).toBe(once);
  });

  it("负面词去重合并", () => {
    expect(mergeStyleNegative("水印", { negative: "水印，文字" })).toBe("水印，文字");
    expect(mergeStyleNegative("", { negative: "" })).toBe("");
  });

  it("内置风格的 id 和名字都不重复", () => {
    expect(new Set(BUILTIN_STYLE_PRESETS.map((item) => item.id)).size).toBe(BUILTIN_STYLE_PRESETS.length);
    expect(new Set(BUILTIN_STYLE_PRESETS.map((item) => item.name)).size).toBe(BUILTIN_STYLE_PRESETS.length);
  });
});
