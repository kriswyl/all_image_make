import { describe, expect, it } from "vitest";
import { buildGenerationRequest } from "../src/server/adapters";
import { detectImageMime, isSvgBytes } from "../src/server/vision";
import { extensionForMime } from "../src/server/tasks";
import { clampSidebarWidth, sidebarWidthLimit, MIN_WORKSPACE_WIDTH } from "../src/client/layout";
import {
  DEFAULT_FRAME_COUNT, DEFAULT_FRAME_DURATION_MS, frameParameters, gifBudgetMessage,
  gifSheetFits, IMAGE_OUTPUT_FORMATS, imageOutputFormatSchema,
} from "../src/shared/image-formats";
import {
  SEEDANCE_LIMITS, seedanceLimits, seedanceVersion, validateSeedanceMedia,
} from "../src/shared/seedance-capabilities";
import type { DbChannel } from "../src/server/db";

const imageChannel: DbChannel = {
  id: "channel-1", name: "Test", baseUrl: "https://relay.example.com", adapterType: "openai-images",
  authType: "bearer", authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations",
  models: ["gpt-image-2.6-sunburst"], allowPrivateNetwork: false, enabled: true, createdAt: "", updatedAt: "",
};
const seedanceChannel: DbChannel = {
  ...imageChannel, adapterType: "seedance-video", endpoint: "/api/v3/contents/generations/tasks",
  models: ["sd-2.5", "sd-2.0-fast"],
};
const referenceImage = {
  base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  mimeType: "image/png" as const,
  fileName: "source.png",
};
const maskImage = { ...referenceImage, fileName: "source-mask.png" };

describe("① 窄窗口布局：侧栏不能吃掉主区", () => {
  it("宽窗口允许拖到 420，窄窗口按主区最小宽度收回", () => {
    expect(sidebarWidthLimit(1600)).toBe(420);
    expect(clampSidebarWidth(1600, 420)).toBe(420);
    expect(clampSidebarWidth(900, 420)).toBe(900 - MIN_WORKSPACE_WIDTH); // 280
    expect(clampSidebarWidth(760, 420)).toBe(190); // 下限兜底
    // 非法视口（例如 SSR / 旧数据）回落到默认侧栏宽度，不把界面压没
    expect(clampSidebarWidth(Number.NaN, 420)).toBe(236);
  });
  it("已保存的宽侧栏在窗口变窄时被收回，重新变宽不会自动撑回", () => {
    const stored = 420;
    expect(clampSidebarWidth(980, stored)).toBe(360);
    expect(clampSidebarWidth(1600, clampSidebarWidth(980, stored))).toBe(360);
  });
});

describe("② GIF / SVG 与帧参数", () => {
  it("格式枚举统一包含 svg，zod 也认", () => {
    expect(IMAGE_OUTPUT_FORMATS).toEqual(["png", "jpeg", "webp", "gif", "svg"]);
    expect(imageOutputFormatSchema.safeParse("svg").success).toBe(true);
    expect(imageOutputFormatSchema.safeParse("pdf").success).toBe(false);
  });
  it("sprite sheet 经验护栏：768 可用、1024 超预算、少帧可用", () => {
    expect(gifSheetFits("512x512", 9)).toBe(true);
    expect(gifSheetFits("768x768", 9)).toBe(true);
    expect(gifSheetFits("1024x1024", 9)).toBe(false);
    expect(gifBudgetMessage("1024x1024", 9)).toContain("sprite sheet");
    expect(gifSheetFits("1024x1024", 1)).toBe(true);
    expect(gifBudgetMessage("auto", 9)).toBeUndefined();
  });
  it("帧参数只在 GIF 输出时发，默认值 9 × 200ms", () => {
    expect(frameParameters("gif")).toEqual({ frame_count: DEFAULT_FRAME_COUNT, frame_duration_ms: DEFAULT_FRAME_DURATION_MS });
    expect(frameParameters("gif", 12, 100)).toEqual({ frame_count: 12, frame_duration_ms: 100 });
    expect(frameParameters("svg", 12, 100)).toEqual({});
    expect(frameParameters(undefined)).toEqual({});
  });
});

describe("② SVG 落盘链路", () => {
  it("按文本签名识别 SVG，并给出 .svg 扩展名", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
    expect(isSvgBytes(svg)).toBe(true);
    expect(detectImageMime(svg)).toBe("image/svg+xml");
    expect(extensionForMime("image/svg+xml")).toBe("svg");
    expect(isSvgBytes(Buffer.from("<?xml version=\"1.0\"?><html></html>"))).toBe(false);
    expect(detectImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
  });
});

describe("③ 标注引导层已移除", () => {
  it("显式 markup 不再进入请求，只剩高级 JSON 的原样透传", () => {
    // 产品决定不做标注层：类型与 UI 都删了，高级 JSON 里写同名 key 仍是普通字段。
    const request = buildGenerationRequest(imageChannel, {
      channelId: imageChannel.id, model: "gpt-image-2.6-sunburst", prompt: "改成红色",
      referenceImages: [referenceImage],
      rawParameters: { markup: { image_url: "https://example.com/m.png" } },
    }, "secret");
    expect(request.formData?.get("markup[image_url]")).toBeNull();
    expect(request.formData?.get("markup")).toBe('{"image_url":"https://example.com/m.png"}');
  });
  it("局部重绘蒙版仍然照常发送", () => {
    const request = buildGenerationRequest(imageChannel, {
      channelId: imageChannel.id, model: "gpt-image-2.6-sunburst", prompt: "改成红色",
      referenceImages: [referenceImage], maskImage,
    }, "secret");
    expect(request.url).toBe("https://relay.example.com/v1/images/edits");
    expect(request.formData?.get("mask")).toBeTruthy();
    // 诊断里只留元信息，不回显 PNG 字节
    const diagnostic = JSON.stringify(request.diagnosticBody ?? {});
    expect(diagnostic).toContain("source-mask.png");
    expect(diagnostic).not.toContain(referenceImage.base64);
  });
});

describe("④ Seedance 参考多模态与版本上限", () => {
  it("按模型区分 2.0 / 2.5 上限", () => {
    expect(seedanceVersion("sd-2.5")).toBe("2.5");
    expect(seedanceVersion("sd-2.0-fast")).toBe("2.0");
    expect(seedanceVersion("seedance-2.5")).toBe("2.5");
    expect(seedanceLimits("sd-2.5")).toEqual(SEEDANCE_LIMITS["2.5"]);
    expect(SEEDANCE_LIMITS["2.0"]).toMatchObject({ maxImages: 9, maxVideos: 3, maxAudios: 3 });
    expect(SEEDANCE_LIMITS["2.5"]).toMatchObject({ maxImages: 30, maxVideos: 10, maxAudios: 10, maxTotal: 50 });
  });
  it("超过版本上限或地址非法时给出明确原因", () => {
    const media = Array.from({ length: 4 }, (_, i) => ({
      type: "video_url" as const, url: `https://example.com/v${i}.mp4`, role: "reference_video" as const,
    }));
    expect(validateSeedanceMedia(media, "sd-2.0-fast")).toContain("参考视频最多 3 段");
    expect(validateSeedanceMedia(media, "sd-2.5")).toBeUndefined();
    expect(validateSeedanceMedia([{ type: "audio_url", url: "data:audio/mp3;base64,AAAA" }], "sd-2.5"))
      .toContain("公网 URL");
    expect(validateSeedanceMedia([{ type: "video_url", url: "ftp://x/y.mp4" }], "sd-2.5"))
      .toContain("http(s)");
  });
  it("content 数组现在包含 video_url / audio_url，不再静默丢弃", () => {
    const request = buildGenerationRequest(seedanceChannel, {
      channelId: seedanceChannel.id, model: "sd-2.5", prompt: "城市夜景",
      seedanceVideoMedia: [
        { type: "image_url", url: "data:image/png;base64,AAAA", role: "reference_image" },
        { type: "video_url", url: "https://example.com/clip.mp4", role: "reference_video" },
        { type: "audio_url", url: "https://example.com/bgm.mp3", role: "reference_audio" },
      ],
    }, "secret");
    const content = (request.body?.content ?? []) as Array<Record<string, unknown>>;
    expect(content.map(item => item.type)).toEqual(["text", "image_url", "video_url", "audio_url"]);
    expect(content[2]).toMatchObject({ video_url: { url: "https://example.com/clip.mp4" }, role: "reference_video" });
    expect(content[3]).toMatchObject({ audio_url: { url: "https://example.com/bgm.mp3" }, role: "reference_audio" });
  });
  it("服务端也按版本拦截超限素材", () => {
    expect(() => buildGenerationRequest(seedanceChannel, {
      channelId: seedanceChannel.id, model: "sd-2.0-fast", prompt: "城市夜景",
      seedanceVideoMedia: Array.from({ length: 4 }, (_, i) => ({
        type: "video_url" as const, url: `https://example.com/v${i}.mp4`, role: "reference_video" as const,
      })),
    }, "secret")).toThrow(/参考视频最多 3 段/);
  });
  it("内联 base64 音频（实验）能进 content，前端未勾选时仍按公网地址拦", () => {
    const media = [{ type: "audio_url" as const, url: "data:audio/mpeg;base64,AAAA", role: "reference_audio" as const }];
    expect(validateSeedanceMedia(media, "sd-2.5")).toContain("公网 URL");
    expect(validateSeedanceMedia(media, "sd-2.5", { allowInlineAudio: true })).toBeUndefined();
    const request = buildGenerationRequest(seedanceChannel, {
      channelId: seedanceChannel.id, model: "sd-2.5", prompt: "配音参考", seedanceVideoMedia: media,
    }, "secret");
    expect((request.body?.content as Array<Record<string, unknown>>)[1])
      .toMatchObject({ type: "audio_url", audio_url: { url: "data:audio/mpeg;base64,AAAA" } });
  });
});
