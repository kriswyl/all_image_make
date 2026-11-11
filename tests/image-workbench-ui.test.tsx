// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Asset, Channel, Task } from "../src/shared/types";
import { api } from "../src/client/api";
import type { InpaintMaskController, ReferenceController } from "../src/client/app-shared";
import { GenerateView } from "../src/client/views/GenerateView";
import { readPromptText } from "../src/client/video/PromptEditor";

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
    await click('[aria-label="结果 2"]');
    expect(container.querySelector(".image-preview-trigger img")?.getAttribute("src")).toBe("/assets/two");
    const reference = [...container.querySelectorAll<HTMLButtonElement>(".image-result-tools button")]
      .find(button => button.textContent?.trim() === "参考")!;
    await act(async () => { reference.click(); });
    expect(addFromAsset).toHaveBeenCalledWith(first.assets[1]);

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
