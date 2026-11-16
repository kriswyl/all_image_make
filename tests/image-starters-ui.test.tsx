// @vitest-environment jsdom
/**
 * 空态示例墙：五张图就是五个可点的起点。
 *
 * 这里钉住两件事：示例图数量与顺序稳定；点击把对应提示词交回上层（GenerateView
 * 会填进输入框）。图片资源本身不进断言，只校验路径，换图不会误伤测试。
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

import type { ReferenceController } from "../src/client/app-shared";
import type { Channel } from "../src/shared/types";
import { readPromptText } from "../src/client/video/PromptEditor";
import { GenerateView } from "../src/client/views/GenerateView";
import { ImageResultWorkspace } from "../src/client/views/ImageResultWorkspace";
import { IMAGE_STARTERS } from "../src/client/views/image-starters";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function render(onStarterPrompt: (prompt: string) => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <ImageResultWorkspace
        task={null}
        tasks={[]}
        references={{ images: [], reading: false } as unknown as ReferenceController}
        onDiagnostics={() => undefined}
        onTask={() => undefined}
        onSelectTask={() => undefined}
        onToast={() => undefined}
        onStarterPrompt={onStarterPrompt}
      />,
    );
  });
  return { container, root };
}

it("空态展示五张示例图，顺序与配置一致", () => {
  const { container, root } = render(() => undefined);
  expect(container.querySelector(".starter-title")?.textContent).toContain("下一幅精彩，由你创作");
  const cards = [...container.querySelectorAll<HTMLButtonElement>(".starter-card")];
  expect(cards).toHaveLength(5);
  expect(cards.map((card) => card.querySelector("img")?.getAttribute("src"))).toEqual(
    IMAGE_STARTERS.map((starter) => starter.src),
  );
  act(() => root.unmount());
});

it("点示例图把对应提示词交给上层", () => {
  const onStarterPrompt = vi.fn();
  const { container, root } = render(onStarterPrompt);
  const cards = [...container.querySelectorAll<HTMLButtonElement>(".starter-card")];
  act(() => { cards[2].click(); });
  expect(onStarterPrompt).toHaveBeenCalledWith(IMAGE_STARTERS[2].prompt);
  act(() => root.unmount());
});

it("在工作台里点示例图，提示词真的落进输入框", async () => {
  const createdAt = "2026-11-16T00:00:00.000Z";
  const channel: Channel = {
    id: "images", name: "Images", baseUrl: "http://127.0.0.1:1", adapterType: "openai-images",
    authType: "none", authHeaderName: "", secretEnv: "", endpoint: "", uploadEndpoint: "", uploadHeaders: {},
    models: ["gpt-image-1"], enabled: true, hasKey: true, allowPrivateNetwork: true, unifiedAgentDefault: false,
    createdAt, updatedAt: createdAt,
  };
  const noop = () => undefined;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <GenerateView
          channels={[channel]} selectedChannelId={channel.id} selectedModel={channel.models[0]!}
          tasks={[]} activeTask={null}
          references={{
            images: [], reading: false, select: noop, dropFiles: noop, clear: noop,
            remove: noop, addFromAsset: async () => {},
          } as unknown as ReferenceController}
          inpaint={{ mask: null, apply: noop, clear: noop }}
          onTask={noop} onSelectTask={noop} onChannelChange={noop} onModelChange={noop}
          onAddChannel={noop} onConfigureChannel={noop} onToast={noop} onDiagnostics={noop}
        />,
      );
    });
    const editor = container.querySelector<HTMLElement>('.image-prompt-block [role="textbox"]')!;
    expect(readPromptText(editor)).toBe("");
    const card = container.querySelectorAll<HTMLButtonElement>(".starter-card")[4]!;
    await act(async () => { card.click(); });
    expect(readPromptText(editor)).toBe(IMAGE_STARTERS[4].prompt);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
