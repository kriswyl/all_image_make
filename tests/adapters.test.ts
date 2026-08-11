import { describe, expect, it } from "vitest";
import { buildGenerationRequest, extractImageCandidates, extractRemoteTaskId, readRemoteState } from "../src/server/adapters";
import type { DbChannel } from "../src/server/db";

const channel: DbChannel = {
  id: "channel-1", name: "Test", baseUrl: "https://relay.example.com", adapterType: "openai-images",
  authType: "bearer", authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations", statusEndpoint: "",
  models: ["image-model"], allowPrivateNetwork: false, enabled: true, createdAt: "", updatedAt: "",
};

describe("adapter request building", () => {
  it("maps common image parameters and preserves raw parameters", () => {
    const request = buildGenerationRequest(channel, {
      channelId: channel.id, model: "image-model", prompt: "city", size: "1024x1024", count: 1,
      quality: "high", outputFormat: "webp", background: "transparent", outputCompression: 80,
      moderation: "low", style: "natural", responseFormat: "b64_json", stream: true, partialImages: 2,
      user: "test-user", rawParameters: { seed: 42 },
    }, "secret");
    expect(request.url).toBe("https://relay.example.com/v1/images/generations");
    expect(request.headers.Authorization).toBe("Bearer secret");
    expect(request.body).toMatchObject({
      model: "image-model", prompt: "city", size: "1024x1024", n: 1, quality: "high", output_format: "webp",
      background: "transparent", output_compression: 80, moderation: "low", style: "natural",
      response_format: "b64_json", stream: true, partial_images: 2, user: "test-user", seed: 42,
    });
  });

  it("builds Gemini content shape", () => {
    const request = buildGenerationRequest({ ...channel, adapterType: "gemini-content", authType: "x-api-key", authHeaderName: "x-goog-api-key", endpoint: "/v1beta/models/{model}:generateContent" }, {
      channelId: channel.id, model: "banana-model", prompt: "poster", aspectRatio: "16:9", imageSize: "2K", count: 2,
      temperature: 0.7, topP: 0.9, topK: 32, maxOutputTokens: 4096, seed: 7,
      responseModalities: ["IMAGE"], rawParameters: { generationConfig: { candidateCount: 1, imageConfig: { imageSize: "1K" } } },
    }, "gemini-key");
    expect(request.url).toContain("banana-model:generateContent");
    expect(request.headers["x-goog-api-key"]).toBe("gemini-key");
    expect(request.body).toMatchObject({ contents: [{ role: "user", parts: [{ text: "poster" }] }] });
    expect(request.body?.generationConfig).toMatchObject({
      candidateCount: 1, temperature: 0.7, topP: 0.9, topK: 32, maxOutputTokens: 4096, seed: 7,
      responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "16:9", imageSize: "1K" },
    });
  });

  it("maps common Midjourney task controls", () => {
    const request = buildGenerationRequest({ ...channel, adapterType: "midjourney-task", endpoint: "/mj/submit/imagine" }, {
      channelId: channel.id, model: "mj-model", prompt: "landscape", aspectRatio: "3:2", mjVersion: "7",
      processMode: "fast", stylize: 500, chaos: 20, weirdness: 100, seed: 9,
    }, "secret");
    expect(request.body).toMatchObject({
      model: "mj-model", prompt: "landscape", aspect_ratio: "3:2", version: "7", process_mode: "fast",
      stylize: 500, chaos: 20, weirdness: 100, seed: 9,
    });
  });
});

describe("response normalization", () => {
  it("extracts common URL and base64 image shapes", () => {
    const images = extractImageCandidates({ data: [{ url: "https://cdn.example.com/a.png" }, { b64_json: "a".repeat(200) }] });
    expect(images).toHaveLength(2);
    expect(images[0].url).toContain("a.png");
  });

  it("reads asynchronous task identifiers and status", () => {
    expect(extractRemoteTaskId({ data: { taskId: "task-9" } })).toBe("task-9");
    expect(readRemoteState({ data: { status: "SUCCESS", progress: "100%" } })).toMatchObject({ status: "succeeded", progress: 100 });
  });
});
