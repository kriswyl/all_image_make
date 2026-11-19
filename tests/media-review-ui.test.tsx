// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AssetLightbox } from "../src/client/chat/AssetLightbox";
import { VideoOverviewCard } from "../src/client/chat/MediaReviewCard";
import { extractVideoOverview } from "../src/client/chat/video-frame";
import type { VideoOverview } from "../src/shared/media-review";
import type { Asset } from "../src/shared/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("概述卡显示实际的抽样位置，点击时间码可以回看视频", () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const overview: VideoOverview = {
    assetId: "f123-video", title: "样片", durationMs: 20000, planned: 8, timesMs: [500, 10500],
  };
  const onSeek = vi.fn();
  try {
    act(() => root.render(<VideoOverviewCard overview={overview} onSeek={onSeek} />));
    expect(container.textContent).toContain("全片画面取样");
    expect(container.textContent).toContain("2/8 帧");
    expect(container.textContent).toContain("未读取音轨");
    const buttons = [...container.querySelectorAll("button")];
    act(() => buttons.find(button => button.textContent === "00:00.500")!.click());
    expect(onSeek).toHaveBeenCalledWith(overview.assetId, 500);

    const asset = { id: overview.assetId, fileName: "clip.mp4", mimeType: "video/mp4" } as Asset;
    act(() => root.render(<AssetLightbox assetId={overview.assetId} asset={asset} startAtMs={10500} onClose={() => {}} />));
    const video = container.querySelector("video")!;
    act(() => video.dispatchEvent(new Event("loadedmetadata")));
    expect(video.currentTime).toBe(10.5);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("长片均匀截取 24 帧，并把相邻画面合并为 8 张模型输入", async () => {
  const video = document.createElement("video");
  let currentTime = 0;
  let readyState: number = HTMLMediaElement.HAVE_METADATA;
  Object.defineProperties(video, {
    duration: { value: 600 },
    videoWidth: { value: 1920 },
    videoHeight: { value: 1080 },
    readyState: { get: () => readyState },
    currentTime: {
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value;
        readyState = HTMLMediaElement.HAVE_CURRENT_DATA;
        queueMicrotask(() => video.dispatchEvent(new Event("seeked")));
      },
    },
    load: { value: () => queueMicrotask(() => video.dispatchEvent(new Event("loadedmetadata"))) },
    pause: { value: vi.fn() },
  });
  const drawImage = vi.fn();
  const createElement = document.createElement.bind(document);
  const elements = vi.spyOn(document, "createElement").mockImplementation((name, options) => name === "video" ? video : createElement(name, options));
  const contexts = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
  const encode = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/jpeg;base64,/9j/");
  try {
    const result = await extractVideoOverview("http://127.0.0.1:17892/api/assets/a/file", new AbortController().signal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.planned).toBe(24);
    expect(result.sheets).toHaveLength(8);
    expect(result.sheets[0]?.timesMs).toEqual([12500, 37500, 62500]);
    expect(result.sheets.at(-1)?.timesMs.at(-1)).toBe(587500);
    expect(drawImage).toHaveBeenCalledTimes(24);
    expect(video.preload).toBe("metadata");
    expect(video.hasAttribute("src")).toBe(false);
  } finally {
    elements.mockRestore();
    contexts.mockRestore();
    encode.mockRestore();
  }
});
