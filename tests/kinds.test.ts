import { describe, expect, it } from "vitest";
import {
  AUDIO_ADAPTER_TYPES,
  CHAT_ADAPTER_TYPES,
  VIDEO_ADAPTER_TYPES,
  channelKindOf,
  isAudioAdapter,
  isImageAdapter,
  taskKindFor,
  taskKindOf,
  type ChannelKind,
} from "../src/shared/kinds.js";
import type { AdapterType, Channel, Task } from "../src/shared/types.js";

const IMAGE_ADAPTERS: AdapterType[] = ["openai-images", "openai-chat-image", "gemini-content", "generic-json"];

describe("渠道品类", () => {
  it("每个适配器都有明确品类，不再靠排除法", () => {
    const expected: Array<[AdapterType, ChannelKind]> = [
      ...IMAGE_ADAPTERS.map((adapter) => [adapter, "image"] as [AdapterType, ChannelKind]),
      ...VIDEO_ADAPTER_TYPES.map((adapter) => [adapter, "video"] as [AdapterType, ChannelKind]),
      ...AUDIO_ADAPTER_TYPES.map((adapter) => [adapter, "audio"] as [AdapterType, ChannelKind]),
      ...CHAT_ADAPTER_TYPES.map((adapter) => [adapter, "chat"] as [AdapterType, ChannelKind]),
    ];
    for (const [adapter, kind] of expected) expect(channelKindOf(adapter)).toBe(kind);
    // 不认识的适配器退回图片，保持旧行为；新增渠道必须登记到 kinds.ts
    expect(channelKindOf("unknown-adapter")).toBe("image");
  });

  it("音乐不是图片，也不会被生图工作台选中", () => {
    expect(isAudioAdapter("suno-music")).toBe(true);
    expect(isImageAdapter("suno-music")).toBe(false);
    expect(isImageAdapter("wan-video")).toBe(false);
    expect(isImageAdapter("openai-images")).toBe(true);
  });
});

describe("任务品类", () => {
  it("渠道优先于产物：失败的音乐任务没有产物也能判对", () => {
    expect(taskKindFor("suno-music", [])).toBe("audio");
    expect(taskKindFor("wan-video", [])).toBe("video");
    expect(taskKindFor("gemini-content", [])).toBe("image");
  });

  it("渠道被删后退回 MIME，且音频优先于封面图", () => {
    expect(taskKindFor(undefined, ["audio/mp4", "image/jpeg"])).toBe("audio");
    expect(taskKindFor(undefined, ["video/mp4"])).toBe("video");
    expect(taskKindFor(undefined, ["image/png"])).toBe("image");
    expect(taskKindFor(undefined, [])).toBe("image");
  });

  it("taskKindOf 用渠道表解析，不依赖调用方自己判断", () => {
    const channels = [{ id: "music-1", adapterType: "suno-music" }] as Channel[];
    const task = {
      id: "task-1",
      channelId: "music-1",
      assets: [{ mimeType: "audio/mp4" }, { mimeType: "image/jpeg" }],
    } as unknown as Task;
    expect(taskKindOf(task, channels)).toBe("audio");
  });
});
