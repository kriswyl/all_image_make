import { describe, expect, it } from "vitest";
import { CHANNEL_FIELD_SUPPORT, normalizeAspectFields, unsupportedFields, unsupportedLabels } from "../src/shared/channel-fields";
import { buildCapabilityAliases, buildCapabilityManifest } from "../src/server/capabilities";
import type { DbChannel } from "../src/server/db";

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

describe("能力清单从矩阵派生", () => {
  const channel = (id: string, adapterType: string, models: string[]) => ({
    id, name: id, baseUrl: "https://relay.example.com", adapterType, authType: "bearer",
    authHeaderName: "", secretEnv: "", endpoint: "", models, allowPrivateNetwork: false,
    enabled: true, createdAt: "", updatedAt: "",
  }) as unknown as DbChannel;

  it("参数部分跟着矩阵和视频能力走，不用另写一遍", () => {
    const manifest = buildCapabilityManifest(buildCapabilityAliases([
      channel("gem", "gemini-content", ["gemini-3-pro"]),
      channel("gpt", "openai-images", ["gpt-image-2"]),
      channel("wan", "wan-video", ["wan3.0-video"]),
      channel("kling", "kling-video", ["kling-3.0"]),
    ]));
    const lines = manifest.split("\n");
    const gem = lines.find((line) => line.startsWith("alias=gemini-3-pro"))!;
    expect(gem).toContain("尺寸(imageSize)=1K|2K|4K");
    expect(gem).toContain("宽高比(aspectRatio)=");
    expect(gem).not.toContain("负面词");

    const gpt = lines.find((line) => line.startsWith("alias=gpt-image-2"))!;
    expect(gpt).toContain("尺寸(size)=");
    expect(gpt).toContain("负面词(negative_prompt)");

    // 视频渠道的画幅字段名和音频支持都从能力表来
    const wan = lines.find((line) => line.startsWith("alias=wan-3.0-video"))!;
    expect(wan).toContain("画幅(ratio)=");
    expect(wan).toContain("音频=✔");
    const kling = lines.find((line) => line.startsWith("alias=kling-3.0"))!;
    expect(kling).toContain("画幅(aspectRatio)=");
  });
});
