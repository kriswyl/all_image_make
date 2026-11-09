// @vitest-environment jsdom
/**
 * 视频创作框的交互底线。
 *
 * 1. 只渲染当前渠道/模型真正支持的模式（不是灰一片的假按钮）；
 * 2. 切模式保留各模式的草稿，素材与提示词都不丢；
 * 3. 展开/收起、开关参数浮层都不重新挂载编辑器——正在写的字不会消失；
 * 4. 换模型后不成立的模式要自动回退。
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../src/client/api", () => ({
  isTauriRuntime: () => false,
  api: {
    assetUrl: (url: string) => url,
    bootstrap: vi.fn(),
    polishPrompt: vi.fn(),
    generate: vi.fn(),
  },
}));

import { VideoGenerateView } from "../src/client/VideoGenerateView";
import { useMediaBuckets } from "../src/client/hooks/useMediaBuckets";
import type { Channel } from "../src/shared/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseChannel: Channel = {
  id: "kling",
  name: "Kling",
  baseUrl: "http://127.0.0.1:1",
  adapterType: "kling-video",
  authType: "none",
  authHeaderName: "",
  secretEnv: "",
  endpoint: "",
  uploadEndpoint: "",
  uploadHeaders: {},
  models: ["kling-3.0", "kling-2.5-turbo"],
  allowPrivateNetwork: true,
  unifiedAgentDefault: false,
  enabled: true,
  hasKey: true,
  createdAt: "",
  updatedAt: "",
};

const wanChannel: Channel = { ...baseChannel, id: "wan", name: "Wan", adapterType: "wan-video", models: ["wan2.5-i2v-preview"] };
/** 配了上传服务的可灵：运动控制要有参考视频，才会出现在模式列表里 */
const klingUploadChannel: Channel = { ...baseChannel, id: "kling-upload", uploadEndpoint: "http://127.0.0.1:9/upload" };
/** 配了上传服务的万相：视频编辑/延长这类「必须有参考视频」的模式才会出现 */
const wanUploadChannel: Channel = { ...wanChannel, id: "wan-upload", uploadEndpoint: "http://127.0.0.1:9/upload" };
const seedanceChannel: Channel = { ...baseChannel, id: "seedance", name: "Seedance", adapterType: "seedance-video", models: ["sd-2.5"] };
/** 配了图床上传的 Seedance：参考生视频的参考视频槽位从「暂不支持上传」变成可点 */
const seedanceUploadChannel: Channel = { ...seedanceChannel, id: "seedance-upload", uploadEndpoint: "http://127.0.0.1:9/upload" };

let root: Root | null = null;
let container: HTMLDivElement;

function Harness(props: { channelId: string; model: string }) {
  const media = useMediaBuckets(() => undefined);
  const channel = props.channelId === "wan-upload" ? wanUploadChannel
    : props.channelId === "wan" ? wanChannel
      : props.channelId === "kling-upload" ? klingUploadChannel
        : props.channelId === "seedance" ? seedanceChannel
          : props.channelId === "seedance-upload" ? seedanceUploadChannel : baseChannel;
  return (
    <VideoGenerateView
      channels={[baseChannel, wanChannel, wanUploadChannel, klingUploadChannel, seedanceChannel, seedanceUploadChannel]}
      selectedChannelId={props.channelId}
      selectedModel={props.model}
      activeTask={null}
      tasks={[]}
      media={media}
      onChannelChange={() => undefined}
      onModelChange={() => undefined}
      onAddChannel={() => undefined}
      onConfigureChannel={() => undefined}
      onTask={() => undefined}
      onSelectTask={() => undefined}
      onToast={() => undefined}
      onDiagnostics={() => undefined}
    />
  );
}

async function render(props: { channelId: string; model: string }) {
  root = createRoot(container);
  await act(async () => { root!.render(<Harness {...props} />); await Promise.resolve(); });
}

async function rerender(props: { channelId: string; model: string }) {
  await act(async () => { root!.render(<Harness {...props} />); await Promise.resolve(); });
}

/** 创作框底部的模式胶囊（当前模式的入口） */
function modeChip(): HTMLButtonElement {
  return container.querySelector(".vstudio-chip.is-mode") as HTMLButtonElement;
}

function menuLabels(): string[] {
  return [...document.querySelectorAll(".vstudio-mode-item strong")].map((item) => item.textContent ?? "");
}

async function openModeMenu() {
  await act(async () => { modeChip().click(); });
}

async function chooseMode(label: string) {
  await openModeMenu();
  const item = [...document.querySelectorAll(".vstudio-mode-item")]
    .find((node) => node.querySelector("strong")?.textContent === label) as HTMLButtonElement | undefined;
  if (!item) throw new Error(`模式菜单里没有：${label}`);
  await act(async () => { item.click(); });
}

function chipWithText(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button.vstudio-chip")].find((item) => item.textContent?.includes(text));
  if (!found) throw new Error(`找不到参数胶囊：${text}`);
  return found as HTMLButtonElement;
}

function textarea(): HTMLTextAreaElement {
  return container.querySelector("textarea.vstudio-input") as HTMLTextAreaElement;
}

async function typePrompt(value: string) {
  const input = textarea();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

let objectUrlSeed = 0;

beforeEach(() => {
  window.localStorage.clear();
  objectUrlSeed = 0;
  // jsdom 没有实现 object URL；分桶里只把它当预览地址，给个稳定的假地址即可
  Object.assign(URL, {
    createObjectURL: vi.fn(() => `blob:test/${objectUrlSeed += 1}`),
    revokeObjectURL: vi.fn(),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container.remove();
  document.querySelectorAll(".vstudio-panel").forEach((node) => node.remove());
});

it("只渲染当前模型支持的模式：turbo 没有参考生视频与运动控制", async () => {
  await render({ channelId: "kling", model: "kling-2.5-turbo" });
  await openModeMenu();
  expect(menuLabels()).toEqual(["文生视频", "首帧生视频", "首尾帧生视频"]);
  expect(menuLabels()).not.toContain("参考生视频");
});

it("没配上传服务的万相只给不需要参考视频的模式，编辑与延长不画假入口", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  await openModeMenu();
  expect(menuLabels()).toEqual(["文生视频", "首帧生视频", "首尾帧生视频", "参考生视频"]);
});

it("配了上传服务后，万相的视频编辑与视频延长才出现", async () => {
  await render({ channelId: "wan-upload", model: "wan2.5-i2v-preview" });
  await openModeMenu();
  expect(menuLabels()).toEqual([
    "文生视频", "首帧生视频", "首尾帧生视频", "参考生视频", "视频编辑", "视频延长",
  ]);
});

it("seedance 参考生视频：没配图床时视频槽锁定，配了图床出现可点的参考视频槽", async () => {
  await render({ channelId: "seedance", model: "sd-2.5" });
  await chooseMode("参考生视频");
  const locked = [...container.querySelectorAll(".vstudio-slot")]
    .find((node) => node.textContent?.includes("暂不支持上传")) as HTMLElement | undefined;
  expect(locked).toBeTruthy();
  expect((locked!.querySelector("input[type=file]") as HTMLInputElement).disabled).toBe(true);

  await rerender({ channelId: "seedance-upload", model: "sd-2.5" });
  await chooseMode("参考生视频");
  const slot = [...container.querySelectorAll(".vstudio-slot")]
    .find((node) => node.textContent?.includes("参考视频")) as HTMLElement | undefined;
  expect(slot).toBeTruthy();
  expect(slot!.textContent).not.toContain("暂不支持上传");
  const fileInput = slot!.querySelector("input[type=file]") as HTMLInputElement;
  expect(fileInput.disabled).toBe(false);
  expect(fileInput.accept).toContain("video/mp4");
});

it("切模式保留各模式的草稿，切回来提示词还在", async () => {
  await render({ channelId: "kling", model: "kling-3.0" });
  await typePrompt("雨夜街头，霓虹倒影");
  await chooseMode("首帧生视频");
  expect(textarea().value).toBe("");

  await chooseMode("文生视频");
  expect(textarea().value).toBe("雨夜街头，霓虹倒影");
});

it("展开/收起输入框不重新挂载编辑器，内容不丢", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  await typePrompt("镜头慢慢推近");
  const before = textarea();
  await act(async () => {
    (container.querySelector("button[aria-label='展开输入框']") as HTMLButtonElement).click();
  });
  expect(textarea()).toBe(before);
  expect(textarea().value).toBe("镜头慢慢推近");
  await act(async () => {
    (container.querySelector("button[aria-label='收起输入框']") as HTMLButtonElement).click();
  });
  expect(textarea()).toBe(before);
});

it("参数在创作框浮层里改，开关浮层不重挂编辑器；格式与数量是锁定项", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  await typePrompt("城市航拍");
  const before = textarea();
  await act(async () => { chipWithText("720P").click(); });
  const panel = document.querySelector(".vstudio-panel") as HTMLElement;
  expect(panel).toBeTruthy();
  // 浮层必须带上按胶囊矩形算出的定位；漏了 style 会掉到 body 末尾（之前就是这个 bug）
  expect(panel.style.top || panel.style.bottom).toBeTruthy();
  expect(panel.style.left).toBeTruthy();
  expect(textarea()).toBe(before);
  const mov = [...panel.querySelectorAll("button")].find((item) => item.textContent === "MOV") as HTMLButtonElement;
  expect(mov.disabled).toBe(true);
  const two = [...panel.querySelectorAll("button")].find((item) => item.textContent === "2") as HTMLButtonElement;
  expect(two.disabled).toBe(true);

  const ratio = [...panel.querySelectorAll("button")].find((item) => item.textContent === "9:16") as HTMLButtonElement;
  await act(async () => { ratio.click(); });
  expect(chipWithText("9:16 · 720P")).toBeTruthy();
  expect(textarea().value).toBe("城市航拍");

  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  expect(document.querySelector(".vstudio-panel")).toBeNull();
  expect(textarea()).toBe(before);
});

it("创作框里没有「粘贴公网地址」的输入框", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  await chooseMode("参考生视频");
  expect(container.querySelector(".vstudio-urls")).toBeNull();
  expect(container.querySelectorAll("input[type=text], input:not([type])").length).toBe(0);
});

it("@ 引用素材：列出已上传的图片，选中后插进提示词", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  await chooseMode("参考生视频");

  const input = container.querySelector("input[type=file][accept^='image']") as HTMLInputElement;
  const file = new File([new Uint8Array([137, 80, 78, 71])], "ref.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });

  await typePrompt("镜头推近，参考 ");
  await act(async () => { (container.querySelector("button[aria-label='引用素材']") as HTMLButtonElement).click(); });
  const panel = document.querySelector(".vstudio-mention-panel") as HTMLElement;
  expect(panel).toBeTruthy();
  expect([...panel.querySelectorAll(".vstudio-mention-tabs button")].map((item) => item.textContent))
    .toEqual(["全部", "视频", "图片", "音频"]);
  const item = [...panel.querySelectorAll(".vstudio-mention-item")]
    .find((node) => node.textContent?.includes("图片1")) as HTMLButtonElement;
  expect(item).toBeTruthy();
  await act(async () => { item.click(); });
  expect(textarea().value).toBe("镜头推近，参考 @图片1 ");
  expect(document.querySelector(".vstudio-mention-panel")).toBeNull();
});

it("在提示词里敲 @ 也会弹出素材列表", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  expect(document.querySelector(".vstudio-mention-panel")).toBeNull();
  await typePrompt("参考 @");
  expect(document.querySelector(".vstudio-mention-panel")).toBeTruthy();
});

it("切模式不丢已上传的图片：每个模式各存一份素材", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  await chooseMode("参考生视频");

  const input = container.querySelector("input[type=file][accept^='image']") as HTMLInputElement;
  expect(input).toBeTruthy();
  const file = new File([new Uint8Array([137, 80, 78, 71])], "ref.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(container.querySelectorAll(".vstudio-slot.is-filled").length).toBe(1);

  await chooseMode("文生视频");
  expect(container.querySelectorAll(".vstudio-slot.is-filled").length).toBe(0);

  await chooseMode("参考生视频");
  expect(container.querySelectorAll(".vstudio-slot.is-filled").length).toBe(1);
});

it("换模型后不成立的运动控制自动回退到文生视频", async () => {
  await render({ channelId: "kling-upload", model: "kling-3.0" });
  await chooseMode("运动控制");
  expect(container.querySelector(".page-kicker")?.textContent).toBe("运动控制");

  await rerender({ channelId: "kling-upload", model: "kling-2.5-turbo" });
  expect(container.querySelector(".page-kicker")?.textContent).toBe("文生视频");
  await openModeMenu();
  expect(menuLabels()).not.toContain("运动控制");
});
