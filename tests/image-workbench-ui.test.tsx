// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Asset, Channel, Task } from "../src/shared/types";
import { api } from "../src/client/api";
import type { InpaintMaskController, ReferenceController } from "../src/client/app-shared";
import { GenerateView } from "../src/client/views/GenerateView";
import { ImageResultWorkspace } from "../src/client/views/ImageResultWorkspace";
import { useReferenceImages } from "../src/client/hooks/useReferenceImages";
import { imageReferenceLimit } from "../src/shared/image-reference-limits";
import { readPromptText } from "../src/client/video/PromptEditor";
import { ImagePromptComposer } from "../src/client/views/ImagePromptComposer";
import { ImageActionMenu } from "../src/client/ui/ImageActionMenu";
import { GlobalTooltip } from "../src/client/ui/GlobalTooltip";
import { Copy, Download } from "lucide-react";
import { HistoryView } from "../src/client/views/HistoryView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const createdAt = "2026-11-10T00:00:00.000Z";
const imageChannel: Channel = {
  id: "images", name: "Images", baseUrl: "http://127.0.0.1:1", adapterType: "openai-images",
  authType: "none", authHeaderName: "", secretEnv: "", endpoint: "", uploadEndpoint: "", uploadHeaders: {},
  models: ["gpt-image-1"], enabled: true, hasKey: true, allowPrivateNetwork: true, unifiedAgentDefault: false,
  createdAt, updatedAt: createdAt,
};
const mjChannel: Channel = { ...imageChannel, id: "mj", name: "Midjourney", adapterType: "midjourney", models: ["mj_imagine"] };

it("图片菜单由更多按钮切换，鼠标离开时保持，可用外点、Escape 和动作收起", () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const copy = vi.fn();
  const download = vi.fn();
  const preview = vi.fn();
  const pointer = (element: Element, type: string, relatedTarget: EventTarget, pointerType = "mouse") =>
    act(() => element.dispatchEvent(new PointerEvent(type, { bubbles: true, relatedTarget, pointerType })));
  const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));
  try {
    act(() => root.render(<>
      <GlobalTooltip />
      <ImageActionMenu className="test-image"
        shortcuts={[{ label: "下载", tooltip: "下载原图", icon: Download, onSelect: download }]}
        actions={[{ label: "复制", icon: Copy, onSelect: copy }]}>
        <button type="button" onClick={preview}>查看图片</button>
      </ImageActionMenu>
    </>));
    const card = host.querySelector(".test-image")!;
    const trigger = card.querySelector<HTMLButtonElement>(".image-action-trigger")!;
    const panel = card.querySelector(".image-action-menu")!;
    const action = panel.querySelector<HTMLButtonElement>("button")!;
    const shortcut = card.querySelector<HTMLButtonElement>('.image-action-shortcuts [aria-label="下载"]')!;
    const expanded = () => trigger.getAttribute("aria-expanded");
    expect(expanded()).toBe("false");
    expect(panel.hasAttribute("inert")).toBe(true);
    expect(shortcut.textContent).toBe("");
    act(() => shortcut.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    advance(150);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("下载原图");
    expect(expanded()).toBe("false");
    act(() => shortcut.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: card })));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    act(() => shortcut.click());
    expect(download).toHaveBeenCalledTimes(1);
    expect(preview).not.toHaveBeenCalled();
    expect(expanded()).toBe("false");
    pointer(card, "pointerover", document.body);
    advance(200);
    expect(expanded()).toBe("false");
    pointer(card, "pointerout", trigger);
    pointer(trigger, "pointerover", card);
    advance(200);
    expect(expanded()).toBe("false");
    act(() => trigger.click());
    expect(expanded()).toBe("true");
    pointer(trigger, "pointerout", document.body);
    advance(200);
    expect(expanded()).toBe("true");
    act(() => trigger.click());
    expect(expanded()).toBe("false");
    act(() => trigger.click());
    expect(expanded()).toBe("true");
    act(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(expanded()).toBe("false");
    act(() => trigger.click());
    act(() => action.focus());
    act(() => action.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(expanded()).toBe("false");
    expect(document.activeElement).toBe(trigger);
    act(() => trigger.click());
    act(() => action.click());
    expect(copy).toHaveBeenCalledTimes(1);
    expect(expanded()).toBe("false");
    act(() => card.querySelector<HTMLButtonElement>("button")!.click());
    expect(preview).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  }
});

it("参考图展开后按可用宽度翻页，提示词框单独展开和收起", async () => {
  const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(460);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const noop = () => {};
  const images = Array.from({ length: 7 }, (_, index) => ({
    file: new File(["image"], `ref-${index + 1}.png`),
    previewUrl: `blob:reference-${index + 1}`,
  }));
  const click = (selector: string) => act(() => { container.querySelector<HTMLButtonElement>(selector)!.click(); });
  try {
    await act(async () => root.render(<ImagePromptComposer value="" onChange={noop} disabled={false} maxReferences={16}
      references={{ images, reading: false, select: noop, dropFiles: noop, remove: noop, clear: noop, addFromAsset: async () => {} }} />));
    const strip = container.querySelector(".image-reference-strip")!;
    const stack = strip.querySelector(".image-reference-tiles")!;
    const tags = () => Array.from(stack.querySelectorAll(".vstudio-media-tag"), node => node.textContent);
    expect(tags()).toEqual(["图片5", "图片6", "图片7"]);
    await act(async () => {
      stack.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    });
    expect(tags()).toEqual(["图片1", "图片2", "图片3"]);
    click('[aria-label="下一页参考图"]');
    expect(tags()).toEqual(["图片4", "图片5", "图片6"]);
    click('[aria-label="下一页参考图"]');
    expect(tags()).toEqual(["图片7"]);
    expect(strip.querySelector('[aria-label="下一页参考图"]')?.getAttribute("aria-disabled")).toBe("true");
    click('[aria-label="上一页参考图"]');
    expect(tags()).toEqual(["图片4", "图片5", "图片6"]);
    width.mockReturnValue(900);
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    expect(tags()).toHaveLength(7);
    for (const label of ["上一页参考图", "下一页参考图"]) {
      expect(strip.querySelector(`[aria-label="${label}"]`)?.getAttribute("aria-disabled")).toBe("true");
    }
    await act(async () => {
      strip.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
    });
    expect(tags()).toEqual(["图片5", "图片6", "图片7"]);
    expect(strip.querySelector(".vstudio-asset-more")).toBeNull();

    const prompt = container.querySelector(".image-prompt-block")!;
    expect(prompt.classList.contains("is-expanded")).toBe(false);
    click('[aria-label="展开输入框"]');
    expect(prompt.classList.contains("is-expanded")).toBe(true);
    click('[aria-label="收起输入框"]');
    expect(prompt.classList.contains("is-expanded")).toBe(false);
  } finally {
    act(() => root.unmount());
    container.remove();
    width.mockRestore();
  }
});

it("工作台切换模型后显示真实额度并保留已选参考图", async () => {
  const gpt = { ...imageChannel, models: ["gpt-image-2"] };
  const gemini: Channel = { ...imageChannel, id: "gemini", adapterType: "gemini-content", models: ["gemini-3-pro-image"] };
  const noop = () => {};
  const container = document.createElement("div");
  const root = createRoot(container);
  const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: (file: File) => "blob:" + file.name });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: noop });
  let references: ReferenceController;
  function Harness({ channel }: { channel: Channel }) {
    references = useReferenceImages(noop, imageReferenceLimit(channel.adapterType, channel.models[0]).max);
    return <GenerateView channels={[gpt, gemini, mjChannel]} selectedChannelId={channel.id} selectedModel={channel.models[0]!}
      tasks={[]} activeTask={null} references={references} inpaint={{ mask: null, apply: noop, clear: noop }}
      onChannelChange={noop} onModelChange={noop} onTask={noop} onSelectTask={noop}
      onAddChannel={noop} onConfigureChannel={noop} onToast={noop} onDiagnostics={noop} />;
  }
  localStorage.setItem("vector-image:generation-draft:prompt", JSON.stringify("合并参考图"));
  try {
    await act(async () => root.render(<Harness channel={gpt} />));
    await act(async () => references.dropFiles(Array.from({ length: 16 }, (_, index) => new File(["image"], `ref-${index}.png`, { type: "image/png" }))));
    expect(container.querySelector('[aria-label="参考图 16/16"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".image-submit")?.disabled).toBe(false);
    await act(async () => root.render(<Harness channel={gemini} />));
    expect(container.querySelector('[aria-label="参考图 16/14"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".image-submit")?.disabled).toBe(true);
    expect(container.querySelector(".image-reference-note")?.textContent).toContain("当前 16 张");
    await act(async () => root.render(<Harness channel={mjChannel} />));
    expect(container.querySelector('[aria-label="参考图 16/1"]')).not.toBeNull();
    await act(async () => root.render(<Harness channel={gpt} />));
    expect(container.querySelector<HTMLButtonElement>(".image-submit")?.disabled).toBe(false);
  } finally {
    await act(async () => root.unmount());
    if (originalCreate) Object.defineProperty(URL, "createObjectURL", originalCreate);
    else Reflect.deleteProperty(URL, "createObjectURL");
    if (originalRevoke) Object.defineProperty(URL, "revokeObjectURL", originalRevoke);
    else Reflect.deleteProperty(URL, "revokeObjectURL");
  }
});

function asset(id: string, taskId: string): Asset {
  return { id, taskId, fileName: id + ".png", mimeType: "image/png", url: "/assets/" + id, byteSize: 10, createdAt };
}

function task(id: string, channel: Channel, assets: Asset[]): Task {
  return {
    id, channelId: channel.id, channelName: channel.name, model: channel.models[0]!, prompt: "历史 " + id,
    assets, status: "succeeded", progress: 100, effectiveParameters: null, attemptCount: 1,
    errorCode: null, errorMessage: null, createdAt, startedAt: createdAt, finishedAt: createdAt,
  };
}

it("右键生成历史时直接下载该缩略图对应的原图，左键仍用于切换任务", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["image"]))));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const active = task("active", imageChannel, [asset("active-image", "active")]);
  const history = task("history-image", imageChannel, [asset("cover", "history-image"), asset("other", "history-image")]);
  const failed: Task = { ...task("pending", imageChannel, []), status: "failed" };
  const select = vi.fn();
  const download = vi.spyOn(api, "downloadAsset").mockResolvedValue(true);
  const noop = () => {};
  const references: ReferenceController = {
    images: [], reading: false, select: noop, dropFiles: noop, remove: noop, clear: noop, addFromAsset: async () => {},
  };
  try {
    await act(async () => root.render(<ImageResultWorkspace task={active} tasks={[active, history, failed]} references={references}
      onTask={noop} onSelectTask={select} onToast={noop} onDiagnostics={noop} />));
    const thumbs = host.querySelectorAll<HTMLButtonElement>(".image-history-item");
    const menu = () => document.querySelector(".image-history-context-menu");
    const rightClick = (target: Element) => act(() => target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 200, clientY: 180 }),
    ));
    rightClick(thumbs[2]!);
    expect(menu()).toBeNull();
    rightClick(thumbs[1]!);
    expect(menu()?.textContent).toBe("下载");
    expect(select).not.toHaveBeenCalled();
    act(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(menu()).toBeNull();
    rightClick(thumbs[1]!);
    await act(async () => menu()?.querySelector<HTMLButtonElement>("button")?.click());
    expect(menu()).toBeNull();
    expect(download).toHaveBeenCalledExactlyOnceWith(history.assets[0]);
    expect(select).not.toHaveBeenCalled();
    act(() => thumbs[1]!.click());
    expect(select).toHaveBeenCalledExactlyOnceWith(history);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it("素材画廊的图片菜单使用这张素材及其来源任务", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const generated = task("gallery", imageChannel, [asset("first", "gallery"), asset("second", "gallery")]);
  const resubmitted = { ...generated, id: "retry", status: "queued" } satisfies Task;
  vi.spyOn(api, "libraryPage").mockResolvedValue({ items: [generated], hasMore: false });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const download = vi.spyOn(api, "downloadAsset").mockResolvedValue(true);
  const clipboardFile = new File(["sample"], "second.png", { type: "image/png" });
  const readFile = vi.spyOn(api, "assetAsFile").mockResolvedValue(clipboardFile);
  const write = vi.fn(async ([item]: { data: { "image/png": Promise<Blob> } }[]) => {
    expect(await item?.data["image/png"]).toBe(clipboardFile);
  });
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
  vi.stubGlobal("ClipboardItem", class {
    constructor(readonly data: { "image/png": Promise<Blob> }) {}
  });
  const retry = vi.spyOn(api, "retry").mockResolvedValue(resubmitted);
  const onImageTask = vi.fn();
  const onDiagnostics = vi.fn();
  const addFromAsset = vi.fn(async (_asset: Asset) => {});
  const noop = () => {};
  const references: ReferenceController = {
    images: [], reading: false, select: noop, dropFiles: noop, remove: noop, clear: noop, addFromAsset,
  };
  const click = (element: HTMLButtonElement) => act(async () => { element.click(); });
  try {
    await act(async () => root.render(<HistoryView channels={[imageChannel]} tasks={[]} references={references}
      onRefresh={noop} onDelete={noop} onDeleteSelected={noop} onClear={noop} onOpenAssetSettings={noop}
      onDiagnostics={onDiagnostics} onImageTask={onImageTask} onToast={noop} />));
    await click(host.querySelector<HTMLButtonElement>(".header-actions .filter-tabs button")!);
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 10)); });
    const card = host.querySelectorAll(".library-card-wrap")[1]!;
    const trigger = card.querySelector<HTMLButtonElement>(".image-action-trigger")!;
    const shortcuts = [...card.querySelectorAll<HTMLButtonElement>(".image-action-shortcut")];
    expect(trigger.parentElement).toBe(shortcuts[0]?.parentElement);
    expect(shortcuts.map(button => button.getAttribute("aria-label"))).toEqual(["下载", "参考"]);
    expect(shortcuts.map(button => button.dataset.tooltip)).toEqual(["下载原图", "用作参考图"]);
    expect(shortcuts.map(button => button.textContent)).toEqual(["", ""]);
    for (const shortcut of shortcuts) {
      await click(shortcut);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    }
    const buttons = [...card.querySelectorAll<HTMLButtonElement>(".image-action-menu button")];
    expect(buttons.map(button => button.textContent)).toEqual(["复制", "重绘", "诊断"]);
    for (const index of [0, 2, 1]) {
      await click(trigger);
      await click(buttons[index]!);
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    }
    expect(download).toHaveBeenCalledWith(generated.assets[1]);
    expect(readFile).toHaveBeenCalledWith(generated.assets[1]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(addFromAsset).toHaveBeenCalledWith(generated.assets[1]);
    expect(onDiagnostics).toHaveBeenCalledWith(generated);
    expect(retry).toHaveBeenCalledWith(generated.id);
    expect(onImageTask).toHaveBeenCalledWith(resubmitted);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

it("按实际任务状态切换加载动效，只有返回进度才显示百分比", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const completed = task("image", imageChannel, [asset("result", "image")]);
  const noop = () => undefined;
  const references: ReferenceController = {
    images: [], reading: false, select: noop, dropFiles: noop, remove: noop, clear: noop, addFromAsset: async () => {},
  };
  const render = (active: Task) => act(() => root.render(<ImageResultWorkspace task={active} tasks={[active]} references={references}
    onTask={noop} onSelectTask={noop} onDiagnostics={noop} onToast={noop} />));
  const stage = () => container.querySelector(".image-result-stage")!;
  try {
    render({ ...completed, status: "queued", progress: null, assets: [] });
    expect(stage().querySelector(".loading-indicator--spectrum")).not.toBeNull();
    expect(stage().textContent).toContain("排队中");
    expect(stage().textContent).not.toContain("%");
    render({ ...completed, status: "running", progress: 37, assets: [] });
    expect(stage().querySelector(".loading-indicator--aurora")).not.toBeNull();
    expect(stage().textContent).toContain("37%");
    render({ ...completed, status: "failed", errorMessage: "上游失败", assets: [] });
    expect(stage().querySelector(".loading-indicator")).toBeNull();
    expect(stage().textContent).toContain("上游失败");
    render(completed);
    expect(stage().querySelector(".loading-indicator")).toBeNull();
    expect(stage().querySelector("img")).not.toBeNull();
  } finally {
    act(() => root.unmount());
  }
});

it("切历史与切本次候选互相独立，历史 MJ 操作跟随选中的任务", async () => {
  localStorage.setItem("vector-image:generation-draft:prompt", JSON.stringify("正在编辑的提示词"));
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Blob(["image"]))));
  vi.spyOn(api, "assetUrl").mockImplementation(url => url);
  vi.spyOn(window, "confirm").mockReturnValue(true);

  const first = task("images", imageChannel, [asset("one", "images"), asset("two", "images")]);
  const mj = {
    ...task("mj", mjChannel, [asset("grid", "mj")]),
    remoteMeta: { midjourney: { buttons: [
      { label: "U1", customId: "MJ::JOB::upsample::1::example" },
      { label: "区域变体", customId: "MJ::JOB::variation::region::example" },
    ] } },
  };
  const upscale = { ...task("upscale", mjChannel, [asset("large", "upscale")]), model: "mj_upscale", remoteMeta: mj.remoteMeta };
  const onTask = vi.fn();
  const submit = vi.spyOn(api, "midjourneyAction").mockResolvedValue(upscale);
  const generate = vi.spyOn(api, "generate").mockResolvedValue(first);
  const download = vi.spyOn(api, "downloadAsset").mockResolvedValue(true);
  const addFromAsset = vi.fn(async (_asset: Asset) => {});
  const references: ReferenceController = {
    images: [], reading: false, select: vi.fn(), dropFiles: vi.fn(), remove: vi.fn(), clear: vi.fn(), addFromAsset,
  };
  const inpaint: InpaintMaskController = { mask: null, apply: vi.fn(), clear: vi.fn() };
  function Harness({ channel }: { channel: Channel }) {
    const [active, setActive] = useState<Task>(first);
    return <GenerateView
      channels={[imageChannel, mjChannel]} selectedChannelId={channel.id} selectedModel={channel.models[0]!}
      tasks={[first, mj, upscale]} activeTask={active} references={references} inpaint={inpaint}
      onTask={onTask} onSelectTask={setActive} onChannelChange={vi.fn()} onModelChange={vi.fn()}
      onAddChannel={vi.fn()} onConfigureChannel={vi.fn()} onToast={vi.fn()} onDiagnostics={vi.fn()}
    />;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (channel: Channel) => act(async () => { root.render(<Harness channel={channel} />); });
  const click = (selector: string) => act(async () => { container.querySelector<HTMLButtonElement>(selector)!.click(); });
  const prompt = () => readPromptText(container.querySelector<HTMLElement>('.image-prompt-block [role="textbox"]')!);
  const quick = () => container.querySelector(".image-quick-params")!;

  try {
    await render(imageChannel);
    expect(quick().querySelector('[aria-label="尺寸"]')).not.toBeNull();
    expect(quick().querySelector('[aria-label="模型版本"]')).toBeNull();
    expect(container.querySelector(".image-advanced")?.hasAttribute("open")).toBe(false);
    await click('[aria-label="生成参数"]');
    const parameters = container.querySelector<HTMLDetailsElement>(".image-parameters")!;
    expect(parameters.open).toBe(true);
    await click('.image-quick-params [aria-label="尺寸"]');
    const sizeOption = document.querySelector<HTMLButtonElement>('[role="listbox"][aria-label="尺寸"] [role="option"]')!;
    await act(async () => {
      sizeOption.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      sizeOption.click();
    });
    expect(parameters.open).toBe(true);
    await act(async () => {
      container.querySelector(".image-result-stage")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(parameters.open).toBe(false);
    await click('[aria-label="结果 2"]');
    expect(container.querySelector(".image-preview-trigger img")?.getAttribute("src")).toBe("/assets/two");
    await click('.image-result-stage .image-action-shortcuts [aria-label="下载"]');
    expect(download).toHaveBeenCalledExactlyOnceWith(first.assets[1]);
    await click('.image-result-stage .image-action-shortcuts [aria-label="参考"]');
    expect(addFromAsset).toHaveBeenCalledExactlyOnceWith(first.assets[1]);
    expect(container.querySelector('.image-result-stage [aria-label="图片操作"]')?.getAttribute("aria-expanded")).toBe("false");

    await click('.image-history-item[aria-label$="历史 mj"]');
    expect(prompt()).toBe("正在编辑的提示词");
    expect(container.querySelector(".image-result-candidates")).toBeNull();
    expect(container.querySelectorAll(".image-mj-actions button")).toHaveLength(1);
    await click('.image-mj-actions button[aria-label="放大 U1"]');
    expect(submit).toHaveBeenCalledWith("mj", "MJ::JOB::upsample::1::example", "放大 U1");
    expect(container.querySelector(".image-preview-trigger img")?.getAttribute("src")).toBe("/assets/large");
    expect(container.querySelector(".image-mj-actions")).toBeNull();
    await click(".image-submit");
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "images", model: "gpt-image-1", prompt: "正在编辑的提示词",
    }), [], undefined);

    await render(mjChannel);
    expect(quick().querySelector('[aria-label="宽高比"]')).not.toBeNull();
    expect(quick().querySelector('[aria-label="模型版本"]')).not.toBeNull();
    expect(quick().querySelector('[aria-label="尺寸"]')).toBeNull();
    expect(prompt()).toBe("正在编辑的提示词");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("从 @ 面板插入参考图，删除前一张后仍提交正确的图片", async () => {
  const first = { file: new File(["one"], "one.png", { type: "image/png" }), previewUrl: "blob:one" };
  const second = { file: new File(["two"], "two.png", { type: "image/png" }), previewUrl: "blob:two" };
  const generated = task("new", imageChannel, []);
  const generate = vi.spyOn(api, "generate").mockResolvedValue(generated);
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const onToast = vi.fn();
  const noop = () => undefined;
  const inpaint: InpaintMaskController = { mask: null, apply: noop, clear: noop };
  function Harness() {
    const [images, setImages] = useState([first, second]);
    return <GenerateView
      channels={[imageChannel]} selectedChannelId={imageChannel.id} selectedModel={imageChannel.models[0]!}
      tasks={[]} activeTask={null}
      references={{
        images, reading: false, select: noop, dropFiles: noop, clear: () => setImages([]),
        remove: url => setImages(current => current.filter(image => image.previewUrl !== url)),
        addFromAsset: async () => {},
      }}
      inpaint={inpaint} onTask={noop} onSelectTask={noop} onChannelChange={noop} onModelChange={noop}
      onAddChannel={noop} onConfigureChannel={noop} onToast={onToast} onDiagnostics={noop}
    />;
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const click = (selector: string) => act(async () => { container.querySelector<HTMLButtonElement>(selector)!.click(); });
  try {
    await act(async () => { root.render(<Harness />); });
    const editor = container.querySelector<HTMLElement>('.image-prompt-block [role="textbox"]')!;
    await act(async () => {
      editor.focus();
      editor.textContent = "参考 @";
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
    });
    const panel = document.querySelector(".vstudio-mention-panel")!;
    expect(panel).not.toBeNull();
    expect(panel.querySelector('[role="tablist"]')).toBeNull();
    const choices = [...panel.querySelectorAll<HTMLButtonElement>(".vstudio-mention-item")];
    expect(choices).toHaveLength(2);
    await act(async () => { choices[1]!.click(); });
    expect(readPromptText(editor).trim()).toBe("参考 @图片2");
    expect(editor.querySelector(".vstudio-chip img")?.getAttribute("src")).toBe(second.previewUrl);
    const referencePreview = () => document.querySelector('[aria-label="参考图预览"]');
    const previewButton = (selector: string) => act(async () => { referencePreview()!.querySelector<HTMLButtonElement>(selector)!.click(); });
    await click('[aria-label="查看图片2"]');
    expect(referencePreview()?.querySelector("img")?.getAttribute("src")).toBe(second.previewUrl);
    expect(referencePreview()?.textContent).not.toContain("局部重绘");
    await previewButton('[aria-label="关闭参考图预览"]');
    await act(async () => {
      container.querySelector(".image-reference-tiles")!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }));
    });
    await click('[aria-label="移除图片1"]');
    expect(readPromptText(editor).trim()).toBe("参考 @图片1");
    expect(editor.querySelector(".vstudio-chip img")?.getAttribute("src")).toBe(second.previewUrl);
    expect(container.textContent).not.toContain("局部重绘");
    await click('[aria-label="查看图片1"]');
    expect(referencePreview()?.textContent).toContain("局部重绘");
    await previewButton(".image-preview-tools button");
    expect(referencePreview()).toBeNull();
    const maskEditor = document.querySelector('[aria-label="局部重绘蒙版"]');
    expect(maskEditor).not.toBeNull();
    await act(async () => { maskEditor!.querySelector<HTMLButtonElement>('[title="关闭"]')!.click(); });
    await click(".image-submit");
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({ prompt: "参考 @图片1" }), [second.file], undefined);
    await click('[aria-label="移除图片1"]');
    await click(".image-submit");
    expect(generate).toHaveBeenCalledTimes(1);
    expect(onToast).toHaveBeenLastCalledWith("error", expect.stringContaining("@缺失图片1"));
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
