import { describe, expect, it } from "vitest";
import { defaultImageDraft, imageGenerationParameters } from "../src/client/chat/storyboard-image-params";

describe("分镜参考图参数", () => {
  it("按 OpenAI 协议传递尺寸和高级参数，不带 Gemini 选项", () => {
    expect(imageGenerationParameters("openai-images", { ...defaultImageDraft, size: "1536 × 1024", quality: "high", count: "2", background: "transparent", seed: "7", raw: '{"extra":true}' })).toMatchObject({ size: "1536x1024", quality: "high", count: 2, background: "transparent", rawParameters: { extra: true } });
    expect(imageGenerationParameters("openai-images", { ...defaultImageDraft, seed: "7" })).not.toHaveProperty("seed");
  });
  it("按 Gemini 和 Midjourney 协议分别发送参数", () => {
    const draft = { ...defaultImageDraft, size: "1024x1024", aspectRatio: "16:9", imageSize: "2K", seed: "7", negativePrompt: "文字", midjourneyVersion: "7" };
    expect(imageGenerationParameters("gemini-content", draft)).toMatchObject({ imageSize: "2K", aspectRatio: "16:9", seed: 7 });
    expect(imageGenerationParameters("gemini-content", draft)).not.toHaveProperty("size");
    expect(imageGenerationParameters("midjourney", draft)).toMatchObject({ aspectRatio: "16:9", negativePrompt: "文字", midjourneyVersion: "7" });
    expect(imageGenerationParameters("midjourney", draft)).not.toHaveProperty("imageSize");
  });
  it("提交前拒绝无效参数", () => {
    expect(() => imageGenerationParameters("openai-images", { ...defaultImageDraft, count: "9" })).toThrow("生成数量");
    expect(() => imageGenerationParameters("gemini-content", { ...defaultImageDraft, topP: "1.5" })).toThrow("Top P");
    expect(() => imageGenerationParameters("openai-images", { ...defaultImageDraft, size: "大图" })).toThrow("尺寸");
    expect(() => imageGenerationParameters("midjourney", { ...defaultImageDraft, raw: "[]" })).toThrow("JSON 对象");
  });
});
