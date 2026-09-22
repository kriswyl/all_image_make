import { describe, expect, it } from "vitest";
import { buildGenerationRequest, extractImageCandidates, normalizeTimeout, requestForDiagnostic } from "../src/server/adapters";
import type { DbChannel } from "../src/server/db";

const channel: DbChannel = {
  id: "channel-1", name: "Test", baseUrl: "https://relay.example.com", adapterType: "openai-images",
  authType: "bearer", authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations",
  models: ["image-model"], allowPrivateNetwork: false, enabled: true, createdAt: "", updatedAt: "",
};

const referenceImage = {
  base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  mimeType: "image/png" as const,
  fileName: "source.png",
};
const referenceImage2 = { ...referenceImage, fileName: "source-2.png" };

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
      channelId: channel.id, model: "image-model", prompt: "restyle", referenceImages: [referenceImage, referenceImage2],
      size: "1024x1024", count: 1, rawParameters: { quality: "high" },
    }, "secret");
    expect(request.url).toBe("https://relay.example.com/v1/images/edits");
    expect(request.headers["Content-Type"]).toBeUndefined();
    expect(request.formData?.get("model")).toBe("image-model");
    expect(request.formData?.get("prompt")).toBe("restyle");
    expect(request.formData?.get("quality")).toBe("high");
    expect(request.formData?.getAll("image[]")).toHaveLength(2);
    const diagnostic = requestForDiagnostic(request);
    expect(diagnostic.body).toMatchObject({ "image[]": [{ fileName: "source.png" }, { fileName: "source-2.png" }] });
    expect(JSON.stringify(diagnostic)).not.toContain(referenceImage.base64);
  });

  it("redacts raw image fields in multipart diagnostics", () => {
    const request = buildGenerationRequest(channel, {
      channelId: channel.id, model: "image-model", prompt: "restyle", referenceImages: [referenceImage, referenceImage2],
      rawParameters: { "image[]": [referenceImage.base64, referenceImage2.base64], quality: "high" },
    }, "secret");
    const diagnostic = requestForDiagnostic(request);
    const diagnosticBody = diagnostic.body as Record<string, unknown>;
    expect(diagnosticBody["image[]"]).toEqual([
      `[IMAGE_DATA ${Buffer.byteLength(referenceImage.base64, "base64")} bytes]`,
      `[IMAGE_DATA ${Buffer.byteLength(referenceImage2.base64, "base64")} bytes]`,
    ]);
    expect(JSON.stringify(diagnostic)).not.toContain(referenceImage.base64);
  });

  it("maps reference images for JSON adapters and lets raw parameters override defaults", () => {
    const chat = buildGenerationRequest({ ...channel, adapterType: "openai-chat-image", endpoint: "/v1/chat/completions" }, {
      channelId: channel.id, model: "chat-image", prompt: "restyle", referenceImages: [referenceImage, referenceImage2],
    }, "secret");
    expect(chat.body?.messages).toMatchObject([{ content: [
      { type: "text", text: "restyle" },
      { type: "image_url", image_url: { url: expect.stringContaining("data:image/png;base64,") } },
      { type: "image_url", image_url: { url: expect.stringContaining("data:image/png;base64,") } },
    ] }]);

    const gemini = buildGenerationRequest({ ...channel, adapterType: "gemini-content", endpoint: "/v1beta/models/{model}:generateContent" }, {
      channelId: channel.id, model: "gemini-image", prompt: "restyle", referenceImages: [referenceImage, referenceImage2],
    }, "secret");
    expect(gemini.body?.contents).toMatchObject([{ parts: [
      { inlineData: { mimeType: "image/png", data: referenceImage.base64 } },
      { inlineData: { mimeType: "image/png", data: referenceImage2.base64 } },
      { text: "restyle" },
    ] }]);

    const generic = buildGenerationRequest({ ...channel, adapterType: "generic-json" }, {
      channelId: channel.id, model: "generic", prompt: "restyle", referenceImages: [referenceImage, referenceImage2],
    }, "secret");
    expect(generic.body?.images).toEqual([
      `data:image/png;base64,${referenceImage.base64}`,
      `data:image/png;base64,${referenceImage2.base64}`,
    ]);
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

  it("carries the requested timeout onto the prepared request", () => {
    const request = buildGenerationRequest(channel, {
      channelId: channel.id, model: "image-model", prompt: "city", timeoutMs: 300_000,
    }, "secret");
    expect(request.timeoutMs).toBe(300_000);
  });

  it("falls back to the default timeout when none is requested", () => {
    const request = buildGenerationRequest(channel, { channelId: channel.id, model: "image-model", prompt: "city" }, "secret");
    expect(request.timeoutMs).toBe(180_000);
  });
});

describe("normalizeTimeout", () => {
  it("clamps to the supported range and keeps valid values", () => {
    expect(normalizeTimeout(undefined)).toBe(180_000);
    expect(normalizeTimeout(300_000)).toBe(300_000);
    expect(normalizeTimeout(1_000)).toBe(10_000);
    expect(normalizeTimeout(9_999_999)).toBe(1_800_000);
    expect(normalizeTimeout(Number.NaN)).toBe(180_000);
  });
});

describe("response normalization", () => {
  it("extracts common URL and base64 image shapes", () => {
    const images = extractImageCandidates({ data: [{ url: "https://cdn.example.com/a.png" }, { b64_json: "a".repeat(200) }] });
    expect(images).toHaveLength(2);
    expect(images[0].url).toContain("a.png");
  });

});
