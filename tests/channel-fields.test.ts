import { describe, expect, it } from "vitest";
import { CHANNEL_FIELD_SUPPORT, unsupportedFields, unsupportedLabels } from "../src/shared/channel-fields";

describe("渠道字段矩阵", () => {
  it("Gemini 不认负面提示词，但认 imageSize 和宽高比", () => {
    expect(unsupportedLabels("gemini-content", { negativePrompt: "水印", imageSize: "2K", aspectRatio: "16:9" }))
      .toEqual(["负面提示词"]);
  });

  it("万相认 ratio 不认 aspectRatio，可灵反过来", () => {
    expect(unsupportedFields("wan-video", { aspectRatio: "16:9", ratio: "16:9" }).map((item) => item.field))
      .toEqual(["aspectRatio"]);
    expect(unsupportedFields("kling-video", { aspectRatio: "16:9", ratio: "16:9" }).map((item) => item.field))
      .toEqual(["ratio"]);
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

  it("同一类参数的中文名去重", () => {
    expect(unsupportedLabels("grok-video", { ratio: "16:9", size: "1024x1024" })).toEqual(["画幅比例", "尺寸"]);
  });
});
