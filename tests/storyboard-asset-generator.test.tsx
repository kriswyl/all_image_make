// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { StoryboardReview } from "../src/client/chat/StoryboardReview";
import { storyboardProjectDataSchema } from "../src/shared/storyboard-project";
import type { Asset, Task } from "../src/shared/types";

it("keeps following a reference task after closing and only links a result when asked", async () => {
  const data = storyboardProjectDataSchema.parse({
    name: "分镜", characters: [], scenes: [], props: [{ name: "腕表" }],
    shots: [{ id: "shot", prompt: "桌面上的腕表。" }],
  });
  const image: Asset = {
    id: "asset", taskId: "generation", fileName: "watch.png", title: "腕表参考图",
    mimeType: "image/png", url: "/original/watch.png", thumbUrl: "/thumb/watch.png", byteSize: 1000, createdAt: "2026-11-18",
  };
  const queued = { id: "generation", status: "queued", assets: [] } as unknown as Task;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
  environment.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(api, "storyboardProject").mockResolvedValue({ id: "board", revision: 1, data });
  vi.spyOn(api, "storyboardPreview").mockResolvedValue([]);
  vi.spyOn(api, "settings").mockResolvedValue({ defaultImageAlias: "gpt" } as Awaited<ReturnType<typeof api.settings>>);
  vi.spyOn(api, "capabilities").mockResolvedValue({ aliases: [{
    alias: "gpt", kind: "image", model: "gpt-image-1.5", channelId: "channel", channelName: "测试渠道", adapterType: "openai-images",
  }] } as Awaited<ReturnType<typeof api.capabilities>>);
  const generate = vi.spyOn(api, "generate").mockResolvedValue(queued);
  const poll = vi.spyOn(api, "task").mockResolvedValue({ ...queued, status: "succeeded", assets: [image] });

  async function click(selector: string) {
    const element = document.querySelector<HTMLElement>(selector);
    expect(element, selector).not.toBeNull();
    await act(async () => element!.click());
  }

  try {
    await act(async () => root.render(<StoryboardReview id="board" onClose={() => undefined} onImport={() => undefined} />));
    await click(".storydesk-nav button:nth-child(2)");
    await click(".storydesk-library-header .storydesk-segments button:nth-child(3)");
    await click(".storydesk-library-card");
    await click(".storydesk-reference-inspector .storydesk-actions button:nth-child(2)");
    expect(document.querySelector(".story-generator .model-picker-trigger img")).not.toBeNull();
    await click(".story-generator footer .is-primary");
    expect(document.querySelector(".story-generator-state")?.textContent).toContain("排队中");
    await click('[aria-label="关闭生成窗口"]');
    expect(document.querySelector(".story-generator")).toBeNull();
    expect(document.querySelector(".storydesk-reference-status")?.textContent).toBe("排队中");
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(poll).toHaveBeenCalledWith("generation");
    expect(document.querySelector(".storydesk-reference-status")?.textContent).toBe("结果可查看");
    await click(".storydesk-reference-inspector .storydesk-actions button:nth-child(2)");
    expect(generate).toHaveBeenCalledTimes(1);
    await click(".story-generator-thumb");
    expect(document.querySelector(".story-image-stage img")?.getAttribute("src")).toBe("/original/watch.png");
    expect(document.querySelector('[aria-label="放大当前参考图"]')).toBeNull();
    await click(".story-image-viewer footer .is-primary");
    expect(document.querySelector(".story-image-viewer")).toBeNull();
    expect(document.querySelector('[aria-label="放大当前参考图"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    environment.IS_REACT_ACT_ENVIRONMENT = previousEnvironment;
  }
});
