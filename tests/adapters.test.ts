import { describe, expect, it } from "vitest";
import { buildGenerationRequest, extractImageCandidates, extractVideoCandidates, normalizeTimeout, requestForDiagnostic } from "../src/server/adapters";
import type { DbChannel } from "../src/server/db";
import type { GenerationInput } from "../src/shared/types";

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

const sunoChannel: DbChannel = {
  ...channel, adapterType: "suno-music", endpoint: "/api/queue/makeAiMusic", models: ["suno_damobi_music"],
};

function sunoBody(input: Omit<GenerationInput, "channelId" | "model">) {
  return buildGenerationRequest(sunoChannel, {
    channelId: sunoChannel.id, model: "suno_damobi_music", ...input,
  }, "secret").body;
}

describe("Suno 各模式请求体", () => {
  it("灵感模式发 gpt_description_prompt", () => {
    expect(sunoBody({ prompt: "雨后的城市", musicMode: "inspiration", musicVersion: "chirp-v3-5" })).toMatchObject({
      gpt_description_prompt: "雨后的城市",
      mv: "chirp-v3-5",
      make_instrumental: false,
    });
  });

  it("自定义模式发歌词、曲风和标题", () => {
    expect(sunoBody({
      prompt: "歌词……", musicMode: "custom", musicTags: "民谣, 温暖",
      musicTitle: "雨后的城", musicVersion: "chirp-v4",
    })).toMatchObject({
      prompt: "歌词……", tags: "民谣, 温暖", title: "雨后的城", mv: "chirp-v4", make_instrumental: false,
    });
  });

  it("翻唱带 cover_clip_id 和 task=cover", () => {
    expect(sunoBody({
      prompt: "改成爵士", musicMode: "cover", musicCoverClipId: "clip-1", musicVersion: "chirp-v3-5-tau",
    })).toMatchObject({
      task: "cover", prompt: "改成爵士", cover_clip_id: "clip-1", mv: "chirp-v3-5-tau",
      metadata: { create_mode: "custom" },
    });
  });

  it("混音带两个 clip id 和固定字段", () => {
    expect(sunoBody({
      prompt: "", musicMode: "mashup", musicMashupClipIds: ["clip-1", "clip-2"], musicVersion: "chirp-crow",
    })).toMatchObject({
      task: "mashup_condition", generation_type: "TEXT", mv: "chirp-crow",
      mashup_clip_ids: ["clip-1", "clip-2"], metadata: { create_mode: "custom" },
    });
  });

  it("音效带 sound_configs，prompt 留空、纯音乐固定 true", () => {
    expect(sunoBody({
      prompt: "", musicMode: "sound", musicTitle: "Rain", musicTags: "rain",
      musicSoundConfigs: { tempo: 99, key: "D", loop: true }, musicVersion: "chirp-crow",
    })).toMatchObject({
      task: "sound", generation_type: "TEXT", title: "Rain", tags: "rain",
      mv: "chirp-crow", make_instrumental: true,
      metadata: {
        create_mode: "custom",
        sound_configs: { user_tempo: 99, user_key: "D", user_loop: true },
      },
    });
  });

  it("歌单风格和取样各自带 task，mv 缺省跟随模式", () => {
    expect(sunoBody({ prompt: "city pop", musicMode: "playlist" })).toMatchObject({
      task: "playlist_condition", generation_type: "TEXT", mv: "chirp-v3-5-tau",
      make_instrumental: false,
    });
    expect(sunoBody({ prompt: "lofi", musicMode: "sample" })).toMatchObject({
      task: "chop_sample_condition", generation_type: "TEXT", mv: "chirp-crow",
    });
  });

  it("缺源歌曲 / 缺曲风 / 混音不是两首时直接报错", () => {
    expect(() => sunoBody({ prompt: "x", musicMode: "cover" })).toThrow("翻唱模式需要选择一首源歌曲");
    expect(() => sunoBody({ prompt: "x", musicMode: "custom" })).toThrow("自定义模式需要填写曲风");
    expect(() => sunoBody({ prompt: "x", musicMode: "mashup", musicMashupClipIds: ["a"] })).toThrow("混音模式需要选择两首不同的歌曲");
    expect(() => sunoBody({ prompt: "x", musicMode: "mashup", musicMashupClipIds: ["a", "a"] })).toThrow("混音模式需要选择两首不同的歌曲");
  });
});

const klingChannel: DbChannel = {
  ...channel, adapterType: "kling-video", endpoint: "/text-to-video/{model}", models: ["kling-3.0"],
};

function klingRequest(input: Omit<GenerationInput, "channelId" | "model"> & { model?: string }) {
  const { model, ...rest } = input;
  return buildGenerationRequest(klingChannel, {
    channelId: klingChannel.id, model: model ?? "kling-3.0", ...rest,
  }, "secret");
}

describe("Kling 原生格式请求", () => {
  it("文生视频走 /text-to-video/{model}，body 不带 model", () => {
    const request = klingRequest({ prompt: "cat", duration: 5, resolution: "720p", aspectRatio: "16:9" });
    expect(request.url).toBe("https://relay.example.com/text-to-video/kling-3.0");
    expect(request.body).toMatchObject({
      prompt: "cat",
      settings: { resolution: "720p", duration: 5, aspect_ratio: "16:9", audio: "off", multi_shot: true },
    });
    expect(request.body).not.toHaveProperty("model");
    expect(request.body).not.toHaveProperty("size");
  });

  it("首帧走 /image-to-video/{model}，素材放 contents", () => {
    const request = klingRequest({
      prompt: "cat", duration: 5, resolution: "1080p", klingVideoMode: "first-frame",
      klingVideoMedia: [{ type: "first_frame", url: "data:image/jpeg;base64,AAA" }],
    });
    expect(request.url).toBe("https://relay.example.com/image-to-video/kling-3.0");
    expect(request.body).toMatchObject({
      contents: [
        { type: "prompt", text: "cat" },
        { type: "first_frame", url: "data:image/jpeg;base64,AAA" },
      ],
    });
  });

  it("Omni 走 /omni-video/{model}，参考图用 refer_image", () => {
    const request = klingRequest({
      model: "kling-3.0-omni", prompt: "cat", duration: 5, resolution: "720p", klingVideoMode: "reference",
      klingVideoMedia: [
        { type: "reference_image", url: "data:image/jpeg;base64,AAA" },
        { type: "reference_image", url: "data:image/jpeg;base64,BBB" },
      ],
    });
    expect(request.url).toBe("https://relay.example.com/omni-video/kling-3.0-omni");
    expect(request.body).toMatchObject({
      contents: [
        { type: "prompt", text: "cat" },
        { type: "refer_image", url: "data:image/jpeg;base64,AAA" },
        { type: "refer_image", url: "data:image/jpeg;base64,BBB" },
      ],
    });
  });

  it("图生视频不发 aspect_ratio，但支持 4K 与原生音频", () => {
    const request = klingRequest({
      prompt: "cat", duration: 8, resolution: "4k", audio: true, klingVideoMode: "first-frame",
      klingVideoMedia: [{ type: "first_frame", url: "data:image/jpeg;base64,AAA" }],
    });
    expect(request.body).toMatchObject({
      settings: { resolution: "4k", duration: 8, audio: "native", multi_shot: true },
    });
    expect((request.body as { settings: Record<string, unknown> }).settings).not.toHaveProperty("aspect_ratio");
  });

  it("Omni 首尾帧用 first_frame + last_frame", () => {
    const request = klingRequest({
      model: "kling-3.0-omni", prompt: "cat", klingVideoMode: "first-last-frame",
      klingVideoMedia: [
        { type: "first_frame", url: "https://cdn/first.png" },
        { type: "last_frame", url: "https://cdn/last.png" },
      ],
    });
    expect(request.url).toBe("https://relay.example.com/omni-video/kling-3.0-omni");
    expect(request.body).toMatchObject({
      contents: [
        { type: "prompt", text: "cat" },
        { type: "first_frame", url: "https://cdn/first.png" },
        { type: "last_frame", url: "https://cdn/last.png" },
      ],
    });
  });

  it("运动控制走 /motion-control/{model}，带角色图、参考视频和朝向", () => {
    const request = klingRequest({
      prompt: "dance", resolution: "1080p", duration: 15, audio: true,
      klingVideoMode: "motion-control", klingCharacterOrientation: "image",
      klingVideoMedia: [
        { type: "image", url: "https://cdn/character.png" },
        { type: "video", url: "https://cdn/motion.mp4" },
      ],
    });
    expect(request.url).toBe("https://relay.example.com/motion-control/kling-3.0");
    expect(request.body).toEqual({
      contents: [
        { type: "prompt", text: "dance" },
        { type: "image", url: "https://cdn/character.png" },
        { type: "video", url: "https://cdn/motion.mp4" },
      ],
      settings: { resolution: "1080p", audio: "original", character_orientation: "image" },
      options: { watermark_info: { enabled: false } },
    });
  });

  it("运动控制不接受 4K，也不允许用在 Omni 上", () => {
    expect(() => klingRequest({
      prompt: "dance", resolution: "4k", klingVideoMode: "motion-control",
      klingVideoMedia: [
        { type: "image", url: "https://cdn/character.png" },
        { type: "video", url: "https://cdn/motion.mp4" },
      ],
    })).toThrow(/1080p/);
    expect(() => klingRequest({
      model: "kling-3.0-omni", prompt: "dance", klingVideoMode: "motion-control",
      klingVideoMedia: [
        { type: "image", url: "https://cdn/character.png" },
        { type: "video", url: "https://cdn/motion.mp4" },
      ],
    })).toThrow(/kling-3\.0/);
  });

  it("普通模型实测支持首尾帧，但参考图仍必须换 Omni", () => {
    const frames = klingRequest({
      prompt: "cat", klingVideoMode: "first-last-frame",
      klingVideoMedia: [
        { type: "first_frame", url: "https://cdn/first.png" },
        { type: "last_frame", url: "https://cdn/last.png" },
      ],
    });
    expect(frames.url).toBe("https://relay.example.com/image-to-video/kling-3.0");
    expect(frames.body).toMatchObject({
      contents: [
        { type: "prompt", text: "cat" },
        { type: "first_frame", url: "https://cdn/first.png" },
        { type: "last_frame", url: "https://cdn/last.png" },
      ],
    });

    expect(() => klingRequest({
      prompt: "cat", klingVideoMode: "reference",
      klingVideoMedia: [{ type: "reference_image", url: "https://cdn/ref.png" }],
    })).toThrow(/omni/);
  });

  it("首尾帧数量或顺序不对直接拒绝，不把脏请求发给上游", () => {
    expect(() => klingRequest({
      prompt: "cat", klingVideoMode: "first-last-frame",
      klingVideoMedia: [{ type: "last_frame", url: "https://cdn/last.png" }],
    })).toThrow(/按顺序/);
  });
});
