import { describe, expect, it } from "vitest";
import { buildGenerationRequest, extractImageCandidates, extractVideoCandidates, normalizeTimeout, requestForDiagnostic } from "../src/server/adapters";
import type { DbChannel } from "../src/server/db";

const channel: DbChannel = {
  id: "channel-1", name: "Test", baseUrl: "https://relay.example.com", adapterType: "openai-images",
  authType: "bearer", authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations",
  models: ["image-model"], allowPrivateNetwork: false, enabled: true, createdAt: "", updatedAt: "",
};

const wanVideoChannel: DbChannel = {
  ...channel, adapterType: "wan-video", endpoint: "/api/v1/services/aigc/video-generation/video-synthesis",
  models: ["wan3.0-video"],
};

const grokVideoChannel: DbChannel = {
  ...channel, adapterType: "grok-video", endpoint: "/v1/videos/generations", models: ["grok-imagine-video"],
};

const seedanceChannel: DbChannel = {
  ...channel, adapterType: "seedance-video", endpoint: "/api/v3/contents/generations/tasks",
  models: ["sd-2.5"],
};

const referenceImage = {
  base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  mimeType: "image/png" as const,
  fileName: "source.png",
};
const referenceImage2 = { ...referenceImage, fileName: "source-2.png" };
const maskImage = {
  base64: referenceImage.base64,
  mimeType: "image/png" as const,
  fileName: "source-mask.png",
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

  it("appends a PNG mask part for OpenAI image edits and summarizes it", () => {
    const request = buildGenerationRequest(channel, {
      channelId: channel.id, model: "image-model", prompt: "replace the sky",
      referenceImages: [referenceImage], maskImage,
    }, "secret");
    expect(request.url).toBe("https://relay.example.com/v1/images/edits");
    expect(request.formData?.getAll("image")).toHaveLength(1);
    const masks = request.formData?.getAll("mask") ?? [];
    expect(masks).toHaveLength(1);
    const mask = masks[0] as File;
    expect(mask.type).toBe("image/png");
    expect(mask.name).toBe("source-mask.png");

    const diagnostic = requestForDiagnostic(request);
    expect(diagnostic.body).toMatchObject({
      mask: { fileName: "source-mask.png", mimeType: "image/png", byteSize: 68 },
    });
    expect(JSON.stringify(diagnostic)).not.toContain(maskImage.base64);
  });

  it("appends a keep-outside-unchanged instruction when a mask is present", () => {
    // mask 是引导式编辑，明确写一次「只改蒙版区域」能减少整图重画
    const masked = buildGenerationRequest(channel, {
      channelId: channel.id, model: "image-model", prompt: "replace the sky",
      referenceImages: [referenceImage], maskImage,
    }, "secret");
    expect(masked.formData?.get("prompt")).toBe("replace the sky\n\n只修改蒙版标记的区域；蒙版以外的画面保持完全不变。用户对颜色、材质或物体的描述只作用于蒙版区域内的对象，不要应用到蒙版外的相似物体上；不要重新绘制整张图。");

    const plain = buildGenerationRequest(channel, {
      channelId: channel.id, model: "image-model", prompt: "replace the sky",
      referenceImages: [referenceImage],
    }, "secret");
    expect(plain.formData?.get("prompt")).toBe("replace the sky");
  });

  it("lets an explicit mask win over rawParameters.mask without dropping other raw fields", () => {
    const request = buildGenerationRequest(channel, {
      channelId: channel.id, model: "image-model", prompt: "replace the sky",
      referenceImages: [referenceImage], maskImage,
      rawParameters: { mask: "legacy-string-mask", quality: "high" },
    }, "secret");
    const masks = request.formData?.getAll("mask") ?? [];
    expect(masks).toHaveLength(1);
    expect(masks[0]).not.toBe("legacy-string-mask");
    expect((masks[0] as File).type).toBe("image/png");
    expect(request.formData?.get("quality")).toBe("high");
  });

  it("keeps legacy raw mask fields working and redacts them in diagnostics", () => {
    const request = buildGenerationRequest(channel, {
      channelId: channel.id, model: "image-model", prompt: "replace the sky",
      referenceImages: [referenceImage],
      rawParameters: { mask: referenceImage.base64 },
    }, "secret");
    const masks = request.formData?.getAll("mask") ?? [];
    expect(masks).toHaveLength(1);
    expect(masks[0]).toBe(referenceImage.base64);
    expect((requestForDiagnostic(request).body as Record<string, unknown>).mask).toBe("[IMAGE_DATA 68 bytes]");
    expect(JSON.stringify(requestForDiagnostic(request))).not.toContain(referenceImage.base64);
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

describe("wan video request building", () => {
  function wanBody(input: Partial<Parameters<typeof buildGenerationRequest>[1]>) {
    const request = buildGenerationRequest(wanVideoChannel, {
      channelId: wanVideoChannel.id, model: "wan3.0-video", prompt: "a cat", ...input,
    }, "secret");
    return { request, body: request.body as { input: Record<string, unknown>; parameters: Record<string, unknown> } };
  }

  it("enables async mode, which the upstream API requires", () => {
    const { request } = wanBody({});
    expect(request.headers["X-DashScope-Async"]).toBe("enable");
    expect(request.url).toBe("https://relay.example.com/api/v1/services/aigc/video-generation/video-synthesis");
  });

  it("omits media entirely for text-to-video", () => {
    const { body } = wanBody({ wanVideoMode: "text-to-video" });
    expect(body.input.media).toBeUndefined();
    expect(body.input.prompt).toBe("a cat");
  });

  it("passes each media slot through with the type the caller assigned", () => {
    const { body } = wanBody({
      wanVideoMode: "first-last-frame",
      wanVideoMedia: [
        { type: "first_frame", url: "data:image/png;base64,AAAA" },
        { type: "last_frame", url: "data:image/png;base64,BBBB" },
      ],
    });
    expect(body.input.media).toEqual([
      { type: "first_frame", url: "data:image/png;base64,AAAA" },
      { type: "last_frame", url: "data:image/png;base64,BBBB" },
    ]);
  });

  it("keeps reference video and audio URLs as given", () => {
    const { body } = wanBody({
      wanVideoMode: "reference",
      wanVideoMedia: [
        { type: "reference_image", url: "data:image/png;base64,AAAA" },
        { type: "reference_video", url: "https://cdn.example.com/clip.mp4" },
        { type: "reference_audio", url: "oss://bucket/track.mp3" },
      ],
    });
    expect(body.input.media).toHaveLength(3);
    expect(body.input.media).toContainEqual({ type: "reference_video", url: "https://cdn.example.com/clip.mp4" });
    expect(body.input.media).toContainEqual({ type: "reference_audio", url: "oss://bucket/track.mp3" });
  });

  it("forces prompt_extend on for file and link media, as the docs require", () => {
    const fileBody = wanBody({
      wanVideoMode: "file-to-video",
      promptExtend: false,
      wanVideoMedia: [{ type: "file", url: "https://cdn.example.com/deck.pptx" }],
    }).body;
    expect(fileBody.parameters.prompt_extend).toBe(true);

    const linkBody = wanBody({
      wanVideoMode: "file-to-video",
      promptExtend: false,
      wanVideoMedia: [{ type: "link", url: "https://example.com/article" }],
    }).body;
    expect(linkBody.parameters.prompt_extend).toBe(true);
  });

  it("respects an explicit prompt_extend of false when no document is attached", () => {
    const { body } = wanBody({ wanVideoMode: "text-to-video", promptExtend: false });
    expect(body.parameters.prompt_extend).toBe(false);
  });

  it("sends ratio and audio rather than aspect_ratio", () => {
    const { body } = wanBody({ ratio: "16:9", audio: false, resolution: "720P", duration: 10 });
    expect(body.parameters).toMatchObject({ ratio: "16:9", audio: false, resolution: "720P", duration: 10 });
    expect(body.parameters.aspect_ratio).toBeUndefined();
  });

  it("accepts the smart duration sentinel", () => {
    const { body } = wanBody({ duration: -1 });
    expect(body.parameters.duration).toBe(-1);
  });

  it("falls back to reference_image for legacy uploads without an explicit mode", () => {
    const { body } = wanBody({ referenceImages: [referenceImage, referenceImage2] });
    expect(body.input.media).toEqual([
      { type: "reference_image", url: `data:image/png;base64,${referenceImage.base64}` },
      { type: "reference_image", url: `data:image/png;base64,${referenceImage2.base64}` },
    ]);
  });
});

describe("grok video request building", () => {
  it("sends aspect_ratio and keeps reference images on the Grok field", () => {
    const request = buildGenerationRequest(grokVideoChannel, {
      channelId: grokVideoChannel.id, model: "grok-imagine-video", prompt: "a dog",
      duration: 12, resolution: "1080p", aspectRatio: "9:16", referenceImages: [referenceImage],
    }, "secret");
    expect(request.url).toBe("https://relay.example.com/v1/videos/generations");
    expect(request.headers["X-DashScope-Async"]).toBeUndefined();
    expect(request.body).toMatchObject({
      model: "grok-imagine-video", prompt: "a dog", duration: 12, resolution: "1080p", aspect_ratio: "9:16",
    });
    expect(request.body?.reference_images).toEqual([{ url: `data:image/png;base64,${referenceImage.base64}` }]);
  });
});

describe("seedance video request building", () => {
  it("builds text-to-video content array with no media", () => {
    const request = buildGenerationRequest(seedanceChannel, {
      channelId: seedanceChannel.id, model: "sd-2.5", prompt: "a cat running",
      duration: 5, resolution: "720p", ratio: "16:9", seed: 42, audio: false,
    }, "secret");
    expect(request.url).toBe("https://relay.example.com/api/v3/contents/generations/tasks");
    expect(request.body).toEqual({
      model: "sd-2.5",
      content: [{ type: "text", text: "a cat running" }],
      resolution: "720p",
      ratio: "16:9",
      duration: 5,
      generate_audio: false,
      seed: 42,
    });
  });

  it("attaches role to image_url entries from seedanceVideoMedia", () => {
    const request = buildGenerationRequest(seedanceChannel, {
      channelId: seedanceChannel.id, model: "sd-2.5", prompt: "extend from frame",
      seedanceVideoMedia: [
        { type: "image_url", url: "data:image/png;base64,abc", role: "first_frame" },
        { type: "image_url", url: "https://example.com/last.png", role: "last_frame" },
      ],
      resolution: "1080p", ratio: "adaptive", duration: 10,
    }, "secret");
    expect(request.body?.content).toEqual([
      { type: "text", text: "extend from frame" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" }, role: "first_frame" },
      { type: "image_url", image_url: { url: "https://example.com/last.png" }, role: "last_frame" },
    ]);
  });

  it("omits role when not provided (reference images)", () => {
    const request = buildGenerationRequest(seedanceChannel, {
      channelId: seedanceChannel.id, model: "sd-2.5", prompt: "ref mode",
      seedanceVideoMedia: [{ type: "image_url", url: "data:image/png;base64,xyz" }],
    }, "secret");
    expect(request.body?.content).toEqual([
      { type: "text", text: "ref mode" },
      { type: "image_url", image_url: { url: "data:image/png;base64,xyz" } },
    ]);
  });

  it("defaults generate_audio to false when audio is omitted", () => {
    const request = buildGenerationRequest(seedanceChannel, { channelId: seedanceChannel.id, model: "sd-2.5", prompt: "test" }, "secret");
    expect(request.body?.generate_audio).toBe(false);
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

  it("finds the Seedance video URL nested under content", () => {
    const videos = extractVideoCandidates({
      id: "cgt-123", status: "succeeded",
      content: { video_url: "https://tos.example.com/out.mp4?X-Tos-Expires=86400" },
      duration: 5,
    });
    expect(videos).toHaveLength(1);
    expect(videos[0].url).toContain("out.mp4");
  });

  // 封面图字段名里也带 url，不能让它排在成品视频前面被当成视频存下来
  it("ranks the real video above a cover image and marks it as strong", () => {
    const videos = extractVideoCandidates({
      status: "unknown",
      cover_url: "https://cdn.example.com/cover.jpg",
      video: "https://cdn.example.com/out.mp4",
    });
    expect(videos[0].url).toContain("out.mp4");
    expect(videos[0].strong).toBe(true);
    expect(videos.find((item) => item.url.includes("cover.jpg"))?.strong).toBe(false);
  });

  it("finds no video while the relay still returns an empty video field", () => {
    const videos = extractVideoCandidates({ id: "task-1", video: "", status: "unknown", progress: 0 });
    expect(videos).toHaveLength(0);
  });
});
