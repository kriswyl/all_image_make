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

// jsdom 里 <video>/<audio> 永远不触发 loadedmetadata，真读时长会卡到 15s 超时。
// 这里只替掉「读时长」这一件事，其余（dataURL、封面帧）保持原样。
vi.mock("../src/client/video/media-builders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/client/video/media-builders")>();
  return { ...actual, mediaDuration: vi.fn(async () => 5) };
});

import { VideoGenerateView } from "../src/client/VideoGenerateView";
import { api } from "../src/client/api";
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
/** Grok 没有模式表，但应该照样有参考图上传入口 */
const grokChannel: Channel = { ...baseChannel, id: "grok", name: "Grok", adapterType: "grok-video", models: ["grok-imagine-video"] };

let root: Root | null = null;
let container: HTMLDivElement;
/** 最近一次 toast：很多校验只体现在提示文案上 */
let lastToast: { kind: string; message: string } | null = null;
function resetToast() { lastToast = null; }
function takeToast() { return lastToast?.message ?? ""; }

function Harness(props: { channelId: string; model: string }) {
  const media = useMediaBuckets(() => undefined);
  const channel = props.channelId === "wan-upload" ? wanUploadChannel
    : props.channelId === "wan" ? wanChannel
      : props.channelId === "kling-upload" ? klingUploadChannel
        : props.channelId === "seedance" ? seedanceChannel
          : props.channelId === "seedance-upload" ? seedanceUploadChannel
            : props.channelId === "grok" ? grokChannel : baseChannel;
  return (
    <VideoGenerateView
      channels={[baseChannel, wanChannel, wanUploadChannel, klingUploadChannel, seedanceChannel, seedanceUploadChannel, grokChannel]}
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
      onDelete={() => undefined}
      onToast={(kind, message) => { lastToast = { kind, message }; }}
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

/** 创作框底部的模式入口（参数模块的左边一格） */
function modeChip(): HTMLButtonElement {
  return container.querySelector(".vstudio-bar-mode") as HTMLButtonElement;
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

/** 参数模块（点它开参数浮层）；显示的是比例 / 分辨率 / 时长 / 声音 / 条数 */
function paramBar(): HTMLButtonElement {
  const found = container.querySelector("button.vstudio-bar-params") as HTMLButtonElement | null;
  if (!found) throw new Error("找不到参数模块");
  return found;
}

/** 提示词输入框：富文本 contenteditable，正文和 @ 胶囊在同一棵 DOM 里 */
function promptBox(): HTMLDivElement {
  const found = container.querySelector(".vstudio-prompt .vstudio-input") as HTMLDivElement | null;
  if (!found) throw new Error("找不到提示词输入框");
  return found;
}

/** 提示词纯文本（胶囊读 data-token，与提交给后端的一致） */
function promptText(): string {
  const box = promptBox();
  return Array.from(box.childNodes).map((node) => (
    node.nodeType === Node.TEXT_NODE ? node.nodeValue ?? ""
      : (node as HTMLElement).dataset?.token ?? node.textContent ?? ""
  )).join("");
}

async function typePrompt(value: string) {
  const box = promptBox();
  await act(async () => {
    box.textContent = value;
    // 模拟真人打字：光标停在末尾，再把「输入事件」发出去
    const range = document.createRange();
    range.selectNodeContents(box);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function openMention(tab: "全部" | "视频" | "图片" | "音频" = "全部") {
  await act(async () => {
    (container.querySelector("button[aria-label='引用素材']") as HTMLButtonElement).click();
  });
  const panel = document.querySelector(".vstudio-mention-panel") as HTMLElement;
  if (!panel) throw new Error("@ 面板没有打开");
  const target = [...panel.querySelectorAll(".vstudio-mention-tabs button")]
    .find((node) => node.textContent?.startsWith(tab)) as HTMLButtonElement;
  await act(async () => { target.click(); });
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

it("只渲染当前模型支持的模式：turbo 只有文生与首尾帧，没有运动控制", async () => {
  await render({ channelId: "kling", model: "kling-2.5-turbo" });
  await openModeMenu();
  expect(menuLabels()).toEqual(["文生视频", "首尾帧生视频"]);
  expect(menuLabels()).not.toContain("运动控制");
  expect(menuLabels()).not.toContain("参考生视频");
});

it("没配上传服务的万相只给不需要参考视频的入口，编辑与延长不画假入口", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  await openModeMenu();
  expect(menuLabels()).toEqual(["提示词生视频", "首尾帧生视频"]);
});

it("配了上传服务后，万相的视频编辑与视频延长才出现", async () => {
  await render({ channelId: "wan-upload", model: "wan2.5-i2v-preview" });
  await openModeMenu();
  expect(menuLabels()).toEqual([
    "提示词生视频", "首尾帧生视频", "视频编辑", "视频延长",
  ]);
});

it("空态在提示词左侧留一个虚线「参考内容」格，正文让出左边一列", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  const assets = container.querySelector(".vstudio-assets") as HTMLElement;
  expect(assets).toBeTruthy();
  // 折叠态：素材浮在左、提示词整块让位；两者仍是 body 的两个子节点
  const body = container.querySelector(".vstudio-body") as HTMLElement;
  expect(body.classList.contains("is-folded")).toBe(true);
  expect([...body.children].map((node) => node.className))
    .toEqual(["vstudio-assets", "vstudio-prompt"]);

  const add = container.querySelector(".vstudio-slot-add") as HTMLButtonElement;
  expect(add).toBeTruthy();
  expect(add.textContent).toContain("参考内容");
  expect(container.querySelectorAll(".vstudio-media-tile").length).toBe(0);

  // 点了先问「加哪种」，图片那一行直接开系统选择框
  await act(async () => { add.click(); });
  const menu = document.querySelector(".vstudio-asset-add") as HTMLElement;
  expect(menu).toBeTruthy();
  const imageInput = container.querySelector("input[type=file][accept^='image']") as HTMLInputElement;
  const pick = vi.spyOn(imageInput, "click");
  const imageItem = [...menu.querySelectorAll("button")]
    .find((node) => node.querySelector("span")?.textContent === "添加图片") as HTMLButtonElement;
  await act(async () => { imageItem.click(); });
  expect(pick).toHaveBeenCalledTimes(1);

  // 上传入口也还在 @ 面板里
  expect(container.querySelector("button[aria-label='引用素材']")).toBeTruthy();
});

it("模型不支持参考素材时（可灵 3.0）不摆参考内容入口，就是一个干净的输入框", async () => {
  await render({ channelId: "kling", model: "kling-3.0" });
  expect(container.querySelector(".vstudio-assets")).toBeNull();
  expect(container.querySelector(".vstudio-prompt .vstudio-input")).toBeTruthy();
});

it("seedance 参考视频的上传入口在 @ 面板里：没配图床时写明原因、按钮不可点", async () => {
  await render({ channelId: "seedance", model: "sd-2.5" });
  await openMention("视频");
  let upload = document.querySelector(".vstudio-mention-upload") as HTMLButtonElement;
  expect(upload).toBeTruthy();
  expect(upload.disabled).toBe(true);
  expect(upload.textContent).toContain("该渠道未配置上传服务");

  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  await rerender({ channelId: "seedance-upload", model: "sd-2.5" });
  await openMention("视频");
  upload = document.querySelector(".vstudio-mention-upload") as HTMLButtonElement;
  expect(upload.disabled).toBe(false);
  const input = container.querySelector("input[type=file][accept^='video/mp4']") as HTMLInputElement;
  expect(input.disabled).toBe(false);
});

it("@ 面板里有上传图片的入口，说明写清格式与上限", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  await openMention("图片");
  const upload = document.querySelector(".vstudio-mention-upload") as HTMLButtonElement;
  expect(upload).toBeTruthy();
  expect(upload.disabled).toBe(false);
  expect(upload.textContent).toContain("上传图片");
  expect(upload.title).toContain("PNG");
});

it("展开后下方出现居中的收起键，点它回到默认高度", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  expect(container.querySelector(".vstudio-collapse")).toBeNull();
  await act(async () => {
    (container.querySelector("button[aria-label='展开输入框']") as HTMLButtonElement).click();
  });
  const collapse = container.querySelector(".vstudio-collapse") as HTMLButtonElement;
  expect(collapse).toBeTruthy();
  await act(async () => { collapse.click(); });
  expect(container.querySelector(".vstudio-collapse")).toBeNull();
});

it("展开创作框时创作记录让位，收起后重新出现", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  const page = () => container.querySelector(".vstudio-page") as HTMLElement;
  const records = () => container.querySelector(".record-panel") as HTMLElement;
  expect(page().classList.contains("is-focus")).toBe(false);
  expect(records().hidden).toBe(false);

  await act(async () => {
    (container.querySelector("button[aria-label='展开输入框']") as HTMLButtonElement).click();
  });
  // 两个区域不争同一块高度：展开 = 专注编辑，记录区整块收起
  expect(page().classList.contains("is-focus")).toBe(true);
  expect(records().hidden).toBe(true);
  expect(container.querySelector(".vstudio-composer.is-expanded")).toBeTruthy();

  await act(async () => { (container.querySelector(".vstudio-collapse") as HTMLButtonElement).click(); });
  expect(page().classList.contains("is-focus")).toBe(false);
  expect(records().hidden).toBe(false);
});

it("切模式保留各模式的草稿，切回来提示词还在", async () => {
  await render({ channelId: "kling", model: "kling-3.0" });
  await typePrompt("雨夜街头，霓虹倒影");
  await chooseMode("首尾帧生视频");
  expect(promptText()).toBe("");

  await chooseMode("文生视频");
  expect(promptText()).toBe("雨夜街头，霓虹倒影");
});

it("展开/收起输入框不重新挂载编辑器，内容不丢", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  await typePrompt("镜头慢慢推近");
  const before = promptBox();
  await act(async () => {
    (container.querySelector("button[aria-label='展开输入框']") as HTMLButtonElement).click();
  });
  expect(promptBox()).toBe(before);
  expect(promptText()).toBe("镜头慢慢推近");
  await act(async () => {
    (container.querySelector("button[aria-label='收起输入框']") as HTMLButtonElement).click();
  });
  expect(promptBox()).toBe(before);
});

it("参数是一个点击模块，点在模块上开浮层；开关浮层不重挂编辑器", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  await typePrompt("城市航拍");
  const before = promptBox();
  await act(async () => { paramBar().click(); });
  const panel = document.querySelector(".vstudio-panel") as HTMLElement;
  expect(panel).toBeTruthy();
  // 浮层必须带上按胶囊矩形算出的定位；漏了 style 会掉到 body 末尾（之前就是这个 bug）
  expect(panel.style.top || panel.style.bottom).toBeTruthy();
  expect(panel.style.left).toBeTruthy();
  expect(promptBox()).toBe(before);
  const mov = [...panel.querySelectorAll("button")].find((item) => item.textContent === "MOV") as HTMLButtonElement;
  expect(mov.disabled).toBe(true);
  const two = [...panel.querySelectorAll("button")].find((item) => item.textContent === "2") as HTMLButtonElement;
  expect(two.disabled).toBe(true);

  const ratio = [...panel.querySelectorAll("button")].find((item) => item.textContent === "9:16") as HTMLButtonElement;
  await act(async () => { ratio.click(); });
  expect(paramBar().textContent).toContain("9:16");
  expect(paramBar().textContent).toContain("720P");
  expect(promptText()).toBe("城市航拍");

  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
  expect(document.querySelector(".vstudio-panel")).toBeNull();
  expect(promptBox()).toBe(before);
});

it("创作框里没有「粘贴公网地址」的输入框", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  await chooseMode("提示词生视频");
  expect(container.querySelector(".vstudio-urls")).toBeNull();
  expect(container.querySelectorAll("input[type=text], input:not([type])").length).toBe(0);
});

it("@ 引用素材：列出已上传的图片，选中后插进提示词", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  await chooseMode("提示词生视频");

  const input = container.querySelector("input[type=file][accept^='image']") as HTMLInputElement;
  const file = new File([new Uint8Array([137, 80, 78, 71])], "ref.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });

  await typePrompt("镜头推近，参考 ");
  await act(async () => { (container.querySelector("button[aria-label='引用素材']") as HTMLButtonElement).click(); });
  const panel = document.querySelector(".vstudio-mention-panel") as HTMLElement;
  expect(panel).toBeTruthy();
  // 页签后面会跟一个数量角标，比较去掉数字后的文案
  expect([...panel.querySelectorAll(".vstudio-mention-tabs button")]
    .map((item) => item.textContent?.replace(/\d+$/, "")))
    .toEqual(["全部", "视频", "图片", "音频"]);
  const item = [...panel.querySelectorAll(".vstudio-mention-item")]
    .find((node) => node.textContent?.includes("图片1")) as HTMLButtonElement;
  expect(item).toBeTruthy();
  await act(async () => { item.click(); });
  expect(promptText()).toBe("镜头推近，参考 @图片1 ");
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
  await chooseMode("提示词生视频");

  const input = container.querySelector("input[type=file][accept^='image']") as HTMLInputElement;
  expect(input).toBeTruthy();
  const file = new File([new Uint8Array([137, 80, 78, 71])], "ref.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(container.querySelectorAll(".vstudio-media-tile").length).toBe(1);

  await chooseMode("首尾帧生视频");
  expect(container.querySelectorAll(".vstudio-media-tile").length).toBe(0);

  await chooseMode("提示词生视频");
  expect(container.querySelectorAll(".vstudio-media-tile").length).toBe(1);
});

it("参考内容铺成一排，不用悬停就看得见，点格子看详情", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  await chooseMode("提示词生视频");

  const input = container.querySelector("input[type=file][accept^='image']") as HTMLInputElement;
  const files = [1, 2].map((index) => new File([new Uint8Array([137, 80, 78, 71])], `ref${index}.png`, { type: "image/png" }));
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });

  // 加完就在那一排里，不需要鼠标扫过
  expect(container.querySelectorAll(".vstudio-media-tile").length).toBe(2);
  expect([...container.querySelectorAll(".vstudio-media-tag")].map((node) => node.textContent))
    .toEqual(["图片1", "图片2"]);

  // 点素材格 → 详情浮层（大图 + 名称/体积）
  const tile = container.querySelector(".vstudio-media-open") as HTMLButtonElement;
  await act(async () => { tile.click(); });
  const detail = document.querySelector(".vstudio-media-detail") as HTMLElement;
  expect(detail).toBeTruthy();
  expect(detail.querySelector("img")).toBeTruthy();
  expect(detail.textContent).toContain("图片1");
});

it("多张素材默认叠成 3 张一摞并写总数，只有悬停这一摞才摊开", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  await chooseMode("提示词生视频");

  const input = container.querySelector("input[type=file][accept^='image']") as HTMLInputElement;
  const files = [1, 2, 3, 4].map((index) => new File([new Uint8Array([137, 80, 78, 71])], `ref${index}.png`, { type: "image/png" }));
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });

  const assets = container.querySelector(".vstudio-assets") as HTMLElement;
  const stack = assets.querySelector(".vstudio-asset-stack") as HTMLElement;
  // 只露最近 3 张、最新那张压在最上面，角标写总数 4
  expect([...stack.children].map((node) => node.querySelector(".vstudio-media-tag")?.textContent))
    .toEqual(["图片2", "图片3", "图片4"]);
  expect(stack.getAttribute("data-count")).toBe("4");
  expect(assets.classList.contains("is-stacked")).toBe(true);
  expect(stack.classList.contains("is-collapsed")).toBe(true);
  // 每张带 --tile-i，CSS 据此算错开角度和层叠顺序
  expect((stack.children[1] as HTMLElement).style.getPropertyValue("--tile-i")).toBe("1");
  // 折叠态不摆任何添加入口：要加素材先把这一摞悬停展开，再点「参考内容」
  expect(assets.querySelector(".vstudio-slot-add")).toBeNull();
  expect(assets.querySelector(".vstudio-stack-add")).toBeNull();
  expect((container.querySelector(".vstudio-body") as HTMLElement).classList.contains("is-folded")).toBe(true);

  // 悬停在素材排的空白处（不是那一摞）不展开
  await act(async () => {
    assets.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
  });
  expect(assets.classList.contains("is-stacked")).toBe(true);

  // 悬停那一摞才摊开：4 张全在同一排，回到「上排 + 下文」，大虚线格回来
  await act(async () => {
    stack.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
  });
  expect(assets.classList.contains("is-stacked")).toBe(false);
  expect((container.querySelector(".vstudio-asset-stack") as HTMLElement).classList.contains("is-collapsed")).toBe(false);
  expect((container.querySelector(".vstudio-body") as HTMLElement).classList.contains("is-folded")).toBe(false);
  expect(container.querySelector(".vstudio-slot-add")).toBeTruthy();
  expect(container.querySelectorAll(".vstudio-media-tile").length).toBe(4);
  expect(container.querySelector(".vstudio-input")).toBeTruthy();

  // 移出整条素材排才收回（中途去点翻页箭头不会收起）
  await act(async () => {
    assets.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
  });
  expect((container.querySelector(".vstudio-assets") as HTMLElement).classList.contains("is-stacked")).toBe(true);
});

it("参考内容里没有「清空图片」按钮，移除靠素材格右上角", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  await chooseMode("提示词生视频");

  const input = container.querySelector("input[type=file][accept^='image']") as HTMLInputElement;
  const files = [1, 2].map((index) => new File([new Uint8Array([137, 80, 78, 71])], `ref${index}.png`, { type: "image/png" }));
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });

  expect(container.textContent).not.toContain("清空图片");
  expect(container.querySelector(".vstudio-clear")).toBeNull();
  // 加完会先展开 2.4 秒，此刻能看到每张的移除键
  expect(container.querySelectorAll(".vstudio-media-remove").length).toBe(2);
});

it("提示词里的 @ 素材一直是带缩略图的胶囊（编辑中也是），点开能看详情", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  await chooseMode("提示词生视频");

  const input = container.querySelector("input[type=file][accept^='image']") as HTMLInputElement;
  const file = new File([new Uint8Array([137, 80, 78, 71])], "ref.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });

  await typePrompt("参考 @图片1 的配色");
  // 不用失焦：输入框里现在就是胶囊，和提交时的记号是同一份文本
  const chips = promptBox().querySelectorAll(".vstudio-chip");
  expect(chips.length).toBe(1);
  expect(chips[0]!.textContent).toContain("@图片1");
  expect(chips[0]!.querySelector("img")).toBeTruthy();
  // 胶囊前后的普通文字还在原位
  expect(promptBox().textContent).toBe("参考 @图片1 的配色");
  expect(promptText()).toBe("参考 @图片1 的配色");

  await act(async () => { (chips[0] as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  expect(document.querySelector(".vstudio-media-detail")).toBeTruthy();
});

it("拖进来的文件按类型分派：图片、视频、音频各走各的，不收的当场说明原因", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  await chooseMode("首尾帧生视频");
  const composer = container.querySelector(".vstudio-composer") as HTMLElement;

  async function drop(files: File[]) {
    resetToast();
    const event = new Event("drop", { bubbles: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { types: ["Files"], files, getData: () => "" },
    });
    await act(async () => { composer.dispatchEvent(event); });
    return takeToast();
  }

  // 图片：进图片桶（首尾帧最多 2 张，多出来的会被拦住）
  const png = new File([new Uint8Array([137, 80, 78, 71])], "frame.png", { type: "image/png" });
  await drop([png]);
  const assets = container.querySelector(".vstudio-assets") as HTMLElement;
  await act(async () => {
    assets.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
  });
  expect([...container.querySelectorAll(".vstudio-media-tag")].map((node) => node.textContent)).toEqual(["首帧"]);

  // 视频：首尾帧不收参考视频，给出的是这条原因，而不是「只支持 PNG/JPEG/WebP」
  const mov = new File([new Uint8Array([0, 0, 0, 24])], "clip.mp4", { type: "video/mp4" });
  const videoMessage = await drop([mov]);
  expect(videoMessage).toContain("不接受参考视频");
  expect(videoMessage).not.toContain("仅支持 PNG");

  // 其他类型：明确说清楚能拖什么
  const txt = new File([new Uint8Array([104])], "notes.txt", { type: "text/plain" });
  const message = await drop([txt]);
  expect(message).toContain("notes.txt");
});

it("编辑中胶囊不会被后续打字打散；素材被移除或压根不存在时，记号退回普通文字", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  await chooseMode("提示词生视频");

  const input = container.querySelector("input[type=file][accept^='image']") as HTMLInputElement;
  const file = new File([new Uint8Array([137, 80, 78, 71])], "ref.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });

  await typePrompt("参考 @图片1 的配色");
  expect(promptBox().querySelectorAll(".vstudio-chip").length).toBe(1);

  // 接着往下写：胶囊还在，位置也对
  await typePrompt("参考 @图片1 的配色，镜头推进");
  expect(promptBox().querySelectorAll(".vstudio-chip").length).toBe(1);
  expect(promptText()).toBe("参考 @图片1 的配色，镜头推进");

  // 没匹配到素材的记号保持普通文字，不假装生效
  await typePrompt("参考 @图片9 的配色");
  expect(promptBox().querySelectorAll(".vstudio-chip").length).toBe(0);
  expect(promptBox().textContent).toBe("参考 @图片9 的配色");

  // 素材被移除后，原来的 @图片1 也不再是胶囊
  await typePrompt("参考 @图片1 的配色");
  expect(promptBox().querySelectorAll(".vstudio-chip").length).toBe(1);
  const assets = container.querySelector(".vstudio-assets") as HTMLElement;
  await act(async () => {
    assets.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
  });
  await act(async () => {
    (container.querySelector(".vstudio-media-remove") as HTMLButtonElement).click();
  });
  expect(promptBox().querySelectorAll(".vstudio-chip").length).toBe(0);
  expect(promptText()).toBe("参考 @图片1 的配色");
});

it("参考内容入口能加图片、视频和音频：收多种素材时先问加哪种，不能传的写明原因", async () => {
  await render({ channelId: "wan-upload", model: "wan2.5-i2v-preview" });
  const slot = container.querySelector(".vstudio-slot-add") as HTMLButtonElement;
  expect(slot.textContent).toContain("参考内容");
  await act(async () => { slot.click(); });

  const menu = document.querySelector(".vstudio-asset-add") as HTMLElement;
  expect(menu).toBeTruthy();
  expect([...menu.querySelectorAll("button")].map((node) => node.querySelector("span")?.textContent))
    .toEqual(["添加图片", "添加视频", "添加音频"]);

  // 选「添加视频」走的是视频文件输入框，不是图片那个
  const videoInput = container.querySelector("input[type=file][accept^='video/mp4']") as HTMLInputElement;
  const pickVideo = vi.spyOn(videoInput, "click");
  const videoItem = [...menu.querySelectorAll("button")]
    .find((node) => node.querySelector("span")?.textContent === "添加视频") as HTMLButtonElement;
  await act(async () => { videoItem.click(); });
  expect(pickVideo).toHaveBeenCalledTimes(1);
  expect(document.querySelector(".vstudio-asset-add")).toBeNull();

  // 没配上传服务的渠道：视频那行写明原因，点不动
  await rerender({ channelId: "seedance", model: "sd-2.5" });
  await act(async () => { (container.querySelector(".vstudio-slot-add") as HTMLButtonElement).click(); });
  const blocked = [...(document.querySelector(".vstudio-asset-add") as HTMLElement).querySelectorAll("button")]
    .find((node) => node.querySelector("span")?.textContent === "添加视频") as HTMLButtonElement;
  expect(blocked.disabled).toBe(true);
  expect(blocked.textContent).toContain("该渠道未配置上传服务");
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

it("多段额度的渠道一次能选多段参考视频；单段渠道的选择框只让选一个", async () => {
  await render({ channelId: "seedance-upload", model: "sd-2.5" });
  const picker = () => container.querySelector("input[type=file][accept^='video/mp4']") as HTMLInputElement;

  // Seedance 2.5 能放 10 段：文件对话框开多选，一次点三个就进三段
  expect(picker().multiple).toBe(true);
  const files = [1, 2, 3].map((index) => new File([new Uint8Array([0, 0, 0])], `shot${index}.mp4`, { type: "video/mp4" }));
  Object.defineProperty(picker(), "files", { value: files, configurable: true });
  await act(async () => {
    picker().dispatchEvent(new Event("change", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });

  expect([...container.querySelectorAll(".vstudio-media-tag")].map((node) => node.textContent))
    .toEqual(["视频1", "视频2", "视频3"]);
  // 三段都在，不该只剩最后一段（这正是「只能上传一次」的根因）
  expect(container.querySelectorAll(".vstudio-media-tile").length).toBe(3);

  // 万相只有 1 段额度：选择框不开多选，避免选了三个却只留下一段
  await rerender({ channelId: "wan-upload", model: "wan2.5-i2v-preview" });
  expect(picker().multiple).toBe(false);
});

it("Grok 也有参考内容上传入口：没有模式胶囊，但能选参考图", async () => {
  await render({ channelId: "grok", model: "grok-imagine-video" });
  // Grok 没有「生成方式」列表，所以不画模式胶囊；之前 spec 为 null 连这一格都没有
  expect(container.querySelector(".vstudio-bar-mode")).toBeNull();
  const add = container.querySelector(".vstudio-slot-add") as HTMLButtonElement;
  expect(add).toBeTruthy();
  expect(add.textContent).toContain("参考内容");

  const imageInput = container.querySelector("input[type=file][accept^='image']") as HTMLInputElement;
  expect(imageInput.disabled).toBe(false);
  const files = [new File([new Uint8Array([137, 80, 78, 71])], "ref.png", { type: "image/png" })];
  Object.defineProperty(imageInput, "files", { value: files, configurable: true });
  await act(async () => { imageInput.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(container.querySelectorAll(".vstudio-media-tile").length).toBe(1);
  expect(container.querySelector(".vstudio-media-tag")?.textContent).toBe("图片1");
});

it("Grok 提交时把参考图当通用 referenceImages 带上，不再报「没有可用的生成方式」", async () => {
  await render({ channelId: "grok", model: "grok-imagine-video" });
  await typePrompt("一只猫在窗台上晒太阳");
  const imageInput = container.querySelector("input[type=file][accept^='image']") as HTMLInputElement;
  const files = [new File([new Uint8Array([137, 80, 78, 71])], "cat.png", { type: "image/png" })];
  Object.defineProperty(imageInput, "files", { value: files, configurable: true });
  await act(async () => { imageInput.dispatchEvent(new Event("change", { bubbles: true })); });

  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  const generate = vi.mocked(api.generate).mockClear();
  generate.mockResolvedValue({ id: "grok-task" } as never);
  await act(async () => {
    (container.querySelector("button.vstudio-send") as HTMLButtonElement).click();
  });

  expect(generate).toHaveBeenCalledTimes(1);
  const [input, referenceFiles] = generate.mock.calls[0]! as unknown as [{ channelId: string }, File[]];
  expect(input.channelId).toBe("grok");
  expect(referenceFiles).toHaveLength(1);
  expect(referenceFiles[0]!.name).toBe("cat.png");
  expect(takeToast()).toBe("视频任务已提交");
  confirm.mockRestore();
});

it("文本布局固定：折叠与展开只换素材层，左边留白和输入框尺寸都不变", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  await chooseMode("提示词生视频");
  const body = () => container.querySelector(".vstudio-body") as HTMLElement;
  const gutter = () => body().style.getPropertyValue("--asset-gutter");
  expect(gutter()).toBe("148px");

  const input = container.querySelector("input[type=file][accept^='image']") as HTMLInputElement;
  const files = [1, 2, 3, 4].map((index) => new File([new Uint8Array([137, 80, 78, 71])], `ref${index}.png`, { type: "image/png" }));
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(body().classList.contains("is-folded")).toBe(true);
  expect(gutter()).toBe("148px");

  const stack = container.querySelector(".vstudio-asset-stack") as HTMLElement;
  await act(async () => {
    stack.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
  });
  expect(body().classList.contains("is-folded")).toBe(false);
  // 展开是覆盖在文字上，不是把正文推下去：留白与输入框都还在原处
  expect(gutter()).toBe("148px");
  expect(container.querySelector(".vstudio-prompt .vstudio-input")).toBeTruthy();
});

it("首尾帧固定两格并排：不折叠、不展开、不带动画类", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  await chooseMode("首尾帧生视频");
  const stack = container.querySelector(".vstudio-asset-stack") as HTMLElement;
  expect(stack.classList.contains("is-fixed-slots")).toBe(true);
  expect(stack.classList.contains("is-collapsed")).toBe(false);
  expect(container.querySelectorAll(".vstudio-slot-pair").length).toBe(2);
  expect([...container.querySelectorAll(".vstudio-slot-pair .vstudio-slot span")].map((n) => n.textContent))
    .toEqual(["首帧", "尾帧"]);
  expect(container.querySelector(".vstudio-slot-link")).toBeTruthy();
  // 首尾帧没有折叠角标，也没有任何添加入口格
  expect(container.querySelector(".vstudio-stack-add")).toBeNull();
  expect(container.querySelector(".vstudio-slot-add")).toBeNull();
  expect((container.querySelector(".vstudio-body") as HTMLElement).style.getPropertyValue("--asset-gutter"))
    .toBe("190px");

  // 悬停两格不会触发展开：位置与两格格式保持不动
  await act(async () => {
    stack.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
  });
  expect((container.querySelector(".vstudio-body") as HTMLElement).classList.contains("is-folded")).toBe(true);
  expect(container.querySelectorAll(".vstudio-slot-pair").length).toBe(2);
});

it("上传素材不改变创作框结构：提示行恒在、输入框不被替换、没有折叠小圆 +", async () => {
  await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
  await chooseMode("提示词生视频");
  const hints = container.querySelector(".vstudio-hints") as HTMLElement;
  const input = container.querySelector(".vstudio-input") as HTMLElement;
  const body = container.querySelector(".vstudio-body") as HTMLElement;
  expect(hints).toBeTruthy();
  expect(input).toBeTruthy();

  const imageInput = container.querySelector("input[type=file][accept^='image']") as HTMLInputElement;
  const files = [1, 2, 3].map((index) => new File([new Uint8Array([137, 80, 78, 71])], `ref${index}.png`, { type: "image/png" }));
  Object.defineProperty(imageInput, "files", { value: files, configurable: true });
  await act(async () => { imageInput.dispatchEvent(new Event("change", { bubbles: true })); });

  // 素材进来了，但提示行容器、输入框节点、body 都还是同一批，不会多出一行把框撑高
  expect(container.querySelector(".vstudio-hints")).toBe(hints);
  expect(container.querySelector(".vstudio-input")).toBe(input);
  expect(container.querySelector(".vstudio-body")).toBe(body);
  expect(container.querySelector(".vstudio-stack-add")).toBeNull();
  expect(container.querySelectorAll(".vstudio-media-tile").length).toBe(3);
});

it("多页翻页不打断操作：展开层带 has-pages，点下一页后素材排保持展开", async () => {
  // jsdom 没有布局，clientWidth 恒为 0（容量 Infinity，全部塞一页）。
  // 这里把创作框宽度撑到 900px：10 张素材按容量 8 分两页，才能走到真实翻页路径。
  // 回归背景：展开层宽随页内容缩放时，点「下一页」按钮会从指针底下溜走，
  // 指针落进正文误触 mouseleave，素材排当场折叠。CSS 靠 has-pages 把展开宽度钉住。
  const hadClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return 900; } });
  try {
    await render({ channelId: "wan", model: "wan2.5-i2v-preview" });
    await chooseMode("提示词生视频");

    const imageInput = container.querySelector("input[type=file][accept^='image']") as HTMLInputElement;
    const files = Array.from({ length: 10 }, (_, index) =>
      new File([new Uint8Array([137, 80, 78, 71])], `ref${index}.png`, { type: "image/png" }));
    Object.defineProperty(imageInput, "files", { value: files, configurable: true });
    await act(async () => { imageInput.dispatchEvent(new Event("change", { bubbles: true })); });

    // 悬停那一摞展开：出现两端翻页键，素材层带 has-pages 标记
    const stack = container.querySelector(".vstudio-asset-stack") as HTMLElement;
    await act(async () => {
      stack.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    });
    expect((container.querySelector(".vstudio-body") as HTMLElement).classList.contains("is-folded")).toBe(false);
    expect((container.querySelector(".vstudio-assets") as HTMLElement).classList.contains("has-pages")).toBe(true);

    const next = [...container.querySelectorAll(".vstudio-asset-more")].pop() as HTMLButtonElement;
    expect(next.getAttribute("aria-label")).toBe("下一页参考内容");
    expect(next.disabled).toBe(false);
    await act(async () => { next.click(); });

    // 点完下一页素材排必须还是展开的：翻页只换内容，不收回、不藏翻页键
    expect((container.querySelector(".vstudio-body") as HTMLElement).classList.contains("is-folded")).toBe(false);
    expect(container.querySelector(".vstudio-asset-stack.is-collapsed")).toBeNull();
    expect([...container.querySelectorAll(".vstudio-asset-more")].pop() as HTMLButtonElement | null).toBeTruthy();
  } finally {
    if (hadClientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", hadClientWidth);
    else delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth;
  }
});
