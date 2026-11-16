import { describe, expect, it } from "vitest";
import {
  KLING_MODE_CAPABILITIES,
  klingModesForModel,
} from "../src/shared/video-capabilities.js";
import { supportedVideoModes } from "../src/shared/video-modes.js";

describe("可灵模型与模式", () => {
  it("能力按模型开放，不是所有模型都长一样", () => {
    expect(klingModesForModel("kling-3.0")).toEqual([
      "text-to-video", "first-frame", "first-last-frame", "motion-control",
    ]);
    expect(klingModesForModel("kling-3.0-turbo")).toEqual([
      "text-to-video", "first-frame", "first-last-frame",
    ]);
    expect(klingModesForModel("kling-3.0-omni")).toEqual([
      "text-to-video", "first-frame", "first-last-frame", "reference",
    ]);
  });

  it("通用生成模式不包含可灵专用运动控制", () => {
    expect(supportedVideoModes("kling-video", "kling-3.0")).toEqual(["text-to-video", "first-frame", "first-last-frame"]);
    expect(supportedVideoModes("kling-video", "kling-3.0-omni")).toEqual([
      "text-to-video", "first-frame", "first-last-frame", "reference",
    ]);
    expect(supportedVideoModes("kling-video", "kling-3.0-turbo")).toEqual([
      "text-to-video", "first-frame", "first-last-frame",
    ]);
  });

  it("分辨率与音频档位跟随模式", () => {
    expect(KLING_MODE_CAPABILITIES["text-to-video"].resolutions).toContain("4k");
    expect(KLING_MODE_CAPABILITIES["motion-control"].resolutions).toEqual(["720p", "1080p"]);
    expect(KLING_MODE_CAPABILITIES["motion-control"].audioModes).toEqual(["original", "off"]);
    expect(KLING_MODE_CAPABILITIES["first-frame"].aspectRatio).toBe(false);
    expect(KLING_MODE_CAPABILITIES["motion-control"].durationEditable).toBe(false);
  });
});
