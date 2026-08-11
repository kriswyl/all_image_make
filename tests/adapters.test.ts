import { describe, expect, it } from "vitest";
import { buildGenerationRequest, extractImageCandidates, extractRemoteTaskId, readRemoteState, requestForDiagnostic } from "../src/server/adapters";
import type { DbChannel } from "../src/server/db";

const channel: DbChannel = {
  id: "channel-1", name: "Test", baseUrl: "https://relay.example.com", adapterType: "openai-images",
  authType: "bearer", authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations", statusEndpoint: "",
  models: ["image-model"], allowPrivateNetwork: false, enabled: true, createdAt: "", updatedAt: "",
};

const referenceImage = {
  base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  mimeType: "image/png" as const,
  fileName: "source.png",
};

describe("adapter request building", () => {
  it("maps common image parameters and preserves raw parameters", () => {
    const request = buildGenerationRequest(channel, {
      channelId: channel.id, model: "image-model", prompt: "city", size: "1280x720", count: 1,
      quality: "high", outputFormat: "webp", background: "transparent",
      moderation: "low", style: "natural", responseFormat: "b64_json", stream: true,
      rawParameters: { seed: 42 },
    }, "secret");
    expect(request.url).toBe("https://relay.example.com/v1/images/generations");
    expect(request.headers.Authorization).toBe("Bearer secret");
    expect(request.body).toMatchObject({
      model: "image-model", prompt: "city", size: "1280x720", n: 1, quality: "high", output_format: "webp",
      background: "transparent", moderation: "low", style: "natural",
      response_format: "b64_json", stream: true, seed: 42,
    });
  });

  it("builds an OpenAI multipart edit request without exposing image data", () => {
    const request = buildGenerationRequest(channel, {
      channelId: channel.id, model: "image-model", prompt: "restyle", referenceImage,
      size: "1024x1024", count: 1, rawParameters: { quality: "high" },
    }, "secret");
    expect(request.url).toBe("https://relay.example.com/v1/images/edits");
    expect(request.headers["Content-Type"]).toBeUndefined();
    expect(request.formData?.get("model")).toBe("image-model");
    expect(request.formData?.get("prompt")).toBe("restyle");
    expect(request.formData?.get("quality")).toBe("high");
    expect(request.formData?.get("image")).toBeInstanceOf(Blob);
    const diagnostic = requestForDiagnostic(request);
    expect(diagnostic.body).toMatchObject({ image: { fileName: "source.png", mimeType: "image/png" } });
    expect(JSON.stringify(diagnostic)).not.toContain(referenceImage.base64);
  });

  it("maps reference images for JSON adapters and lets raw parameters override defaults", () => {
    const chat = buildGenerationRequest({ ...channel, adapterType: "openai-chat-image", endpoint: "/v1/chat/completions" }, {
      channelId: channel.id, model: "chat-image", prompt: "restyle", referenceImage,
    }, "secret");
    expect(chat.body?.messages).toMatchObject([{ content: [
      { type: "text", text: "restyle" },
      { type: "image_url", image_url: { url: expect.stringContaining("data:image/png;base64,") } },
    ] }]);

    const gemini = buildGenerationRequest({ ...channel, adapterType: "gemini-content", endpoint: "/v1beta/models/{model}:generateContent" }, {
      channelId: channel.id, model: "gemini-image", prompt: "restyle", referenceImage,
    }, "secret");
    expect(gemini.body?.contents).toMatchObject([{ parts: [
      { inlineData: { mimeType: "image/png", data: referenceImage.base64 } },
      { text: "restyle" },
    ] }]);

    const midjourney = buildGenerationRequest({ ...channel, adapterType: "midjourney-task", endpoint: "/mj/submit/imagine" }, {
      channelId: channel.id, model: "mj", prompt: "restyle", referenceImage,
      rawParameters: { base64Array: ["relay-override"] },
    }, "secret");
    expect(midjourney.body?.base64Array).toEqual(["relay-override"]);

    const generic = buildGenerationRequest({ ...channel, adapterType: "generic-json" }, {
      channelId: channel.id, model: "generic", prompt: "restyle", referenceImage,
    }, "secret");
    expect(generic.body?.image).toBe(`data:image/png;base64,${referenceImage.base64}`);
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
