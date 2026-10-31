import { describe, expect, it } from "vitest";
import { CHANNEL_FIELD_SUPPORT, normalizeAspectFields, unsupportedFields, unsupportedLabels } from "../src/shared/channel-fields";

describe("渠道字段矩阵", () => {
  it("Gemini 不认负面提示词，但认 imageSize 和宽高比", () => {
    expect(unsupportedLabels("gemini-content", { negativePrompt: "水印", imageSize: "2K", aspectRatio: "16:9" }))
      .toEqual(["负面提示词"]);
  });

  it("万相认 ratio 不认 aspectRatio，可灵反过来（两个字段由适配器互转）", () => {
    expect(CHANNEL_FIELD_SUPPORT["wan-video"]?.ratio).toBe("param");
    expect(CHANNEL_FIELD_SUPPORT["wan-video"]?.aspectRatio).toBeUndefined();
    expect(CHANNEL_FIELD_SUPPORT["kling-video"]?.aspectRatio).toBe("param");
    expect(CHANNEL_FIELD_SUPPORT["kling-video"]?.ratio).toBeUndefined();
  });

  it("MJ 的画幅和排除内容写在提示词里，不算被忽略", () => {
    expect(unsupportedFields("midjourney", { aspectRatio: "16:9", negativePrompt: "文字" })).toEqual([]);
    expect(CHANNEL_FIELD_SUPPORT.midjourney?.aspectRatio).toBe("prompt");
  });

  it("空的、false、未设置的值不提示", () => {
    expect(unsupportedFields("kling-video", { seed: undefined, audio: false, watermark: "" })).toEqual([]);
    expect(unsupportedFields("kling-video", { seed: 42 }).map((item) => item.field)).toEqual(["seed"]);
  });

  it("扩写默认不提示（几乎每个节点都带着它）", () => {
    expect(unsupportedFields("kling-video", { promptExtend: true })).toEqual([]);
    expect(unsupportedFields("kling-video", { promptExtend: true }, { includeSoft: true }).map((item) => item.field))
      .toEqual(["promptExtend"]);
  });

  it("画幅字段按渠道自动转换，两派都能用同一份输入", () => {
    // 万相 / Seedance 认 ratio：只填了 aspectRatio 也转过去
    expect(normalizeAspectFields("wan-video", { aspectRatio: "16:9" })).toEqual({ aspectRatio: "16:9", ratio: "16:9" });
    expect(normalizeAspectFields("seedance-video", { aspectRatio: "9:16" }).ratio).toBe("9:16");
    // 可灵 / Grok 认 aspectRatio：只填了 ratio 也转过去
    expect(normalizeAspectFields("kling-video", { ratio: "1:1" }).aspectRatio).toBe("1:1");
    // adaptive 是可灵没有的档位，丢掉交给渠道默认
    expect(normalizeAspectFields("kling-video", { ratio: "adaptive" }).aspectRatio).toBeUndefined();
    // 全角冒号、auto 都能收拾
    expect(normalizeAspectFields("wan-video", { aspectRatio: "16：9" }).ratio).toBe("16:9");
    expect(normalizeAspectFields("wan-video", { aspectRatio: "auto" }).ratio).toBeUndefined();
    // 已经填了目标字段就不动
    expect(normalizeAspectFields("wan-video", { ratio: "4:3", aspectRatio: "16:9" }).ratio).toBe("4:3");
  });

  it("能互转的画幅不再被报成「被忽略」", () => {
    expect(unsupportedFields("wan-video", { aspectRatio: "16:9" })).toEqual([]);
    expect(unsupportedFields("kling-video", { ratio: "16:9" })).toEqual([]);
  });

  it("同一类参数的中文名去重，画幅能转就不报", () => {
    expect(unsupportedLabels("grok-video", { ratio: "16:9", size: "1024x1024" })).toEqual(["尺寸"]);
    expect(unsupportedLabels("gemini-content", { negativePrompt: "水印", quality: "high" })).toEqual(["负面提示词", "质量"]);
  });
});
