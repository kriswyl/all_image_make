// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BoardInspector } from "../src/client/board/BoardInspector";
import { createEmptyBoardDoc, parseBoardDoc, type BoardDoc, type BoardView } from "../src/shared/board";
import type { Asset } from "../src/shared/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("shows the resolved role and edits or removes only the selected video reference", () => {
  const host = document.createElement("div");
  host.className = "board-canvas";
  document.body.append(host);
  const root = createRoot(host);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this === host ? new DOMRect(0, 0, 900, 700) : new DOMRect(250, 350, 120, 42);
  });
  const base = { x: 0, y: 0, width: 300, height: 200, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
  const initial = parseBoardDoc({
    ...createEmptyBoardDoc(), nextRef: 5, nodes: [
      { ...base, id: "video", ref: "n1", type: "video", title: "窗边", source: "upload", status: "empty", assetId: null, prompt: "镜头推近" },
      { ...base, id: "text", ref: "n2", type: "text", title: "文本", text: "一只小猫" },
      { ...base, id: "first", ref: "n3", type: "image", title: "窗边小猫", source: "upload", status: "succeeded", assetId: "asset-cat" },
      { ...base, id: "empty", ref: "n4", type: "image", title: "备用图", source: "upload", status: "empty", assetId: null },
    ], edges: [
      { id: "edge-text", source: "text", target: "video", kind: "input", role: "text" },
      { id: "edge-image", source: "first", target: "video", kind: "input" },
      { id: "edge-empty", source: "empty", target: "video", kind: "input" },
    ],
  });
  const locate = vi.fn();
  const generate = vi.fn();
  const noop = () => {};
  const assets = new Map<string, Asset>([["asset-cat", {
    id: "asset-cat", title: "窗边小猫", fileName: "cat.png", url: "/assets/cat.png", mimeType: "image/png",
  } as Asset]]);
  function Harness() {
    const [doc, setDoc] = useState<BoardDoc>(initial);
    const view: BoardView = { doc, id: "board", version: 1, title: "画布", threadId: "thread",
      viewport: { x: 0, y: 0, scale: 1 }, selection: ["video"], uiState: {}, canUndo: false, canRedo: false };
    return <BoardInspector view={view} node={doc.nodes[0]!} assets={assets}
      imageAliases={[]} defaultImageAlias="" videoAliases={[{ alias: "video", model: "seedance", channelName: "测试", channelId: "channel", adapterType: "seedance-video" }]}
      defaultVideoAlias="video" audioAliases={[]} defaultSpeechAlias="" defaultMusicAlias=""
      onUpdateNode={(id, patch) => setDoc((previous) => parseBoardDoc({
        ...previous, nodes: previous.nodes.map((node) => node.id === id ? { ...node, ...patch } : node),
      }))} onUpdateEdge={(id, patch) => setDoc((previous) => ({
        ...previous, edges: previous.edges.map((edge) => edge.id === id ? { ...edge, ...patch } : edge),
      }))}
      onRemoveReference={(id) => setDoc((previous) => ({ ...previous, edges: previous.edges.filter((edge) => edge.id !== id) }))}
      onLocateReference={locate} onGenerate={generate} onDeleteNode={noop} onPreview={noop} onPickImage={noop}
      onPickReference={noop} onRemoveAsset={noop} onStopTask={noop} onRetryTask={noop} onExtractFrame={noop}
      onCompareVersions={noop} onClose={noop} onApplyStyle={noop} onConnectReference={() => true} onUploadMediaIntoNode={noop} />;
  }
  const button = (label: string, within: ParentNode = host) => [...within.querySelectorAll<HTMLButtonElement>("button")]
    .find((item) => item.textContent?.includes(label) || item.getAttribute("aria-label")?.includes(label))!;
  const detail = () => document.querySelector<HTMLElement>('[aria-label="引用详情"]')!;
  try {
    act(() => root.render(<Harness />));
    expect(button("窗边小猫").textContent).toContain("首帧");
    const tile = button("窗边小猫").parentElement!;
    act(() => tile.dispatchEvent(new MouseEvent("pointerover", { bubbles: true })));
    expect(document.querySelector(".board-reference-hover img")?.getAttribute("src")).toContain("/assets/cat.png");
    act(() => tile.dispatchEvent(new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body })));
    expect(document.querySelector(".board-reference-hover")).toBeNull();
    act(() => button("生成方式：首帧生视频").click());
    const mode = document.querySelector<HTMLElement>('[aria-label="生成方式"]')!;
    act(() => button("参考生视频", mode).click());
    expect(button("生成方式：参考生视频")).toBeTruthy();
    expect(button("窗边小猫").textContent).toContain("参考图");
    act(() => button("生成方式：参考生视频").click());
    act(() => button("自动（按连线角色）", document.querySelector<HTMLElement>('[aria-label="生成方式"]')!).click());
    expect(button("窗边小猫").textContent).toContain("首帧");
    const editor = host.querySelector<HTMLElement>('[role="textbox"][aria-label="提示词"]')!;
    act(() => {
      editor.focus();
      editor.textContent = "镜头推近 @";
      window.getSelection()!.collapse(editor.firstChild!, editor.textContent.length);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const mention = document.querySelector<HTMLElement>('[aria-label="引用素材"][role="dialog"]')!;
    act(() => button("图片3", mention).click());
    expect(editor.querySelector('[data-token="@图片3"]')).toBeTruthy();
    expect(button("备用图").textContent).toContain("未就绪");
    act(() => button("一只小猫").click());
    expect(detail().textContent).toContain("一只小猫");
    act(() => button("定位来源", detail()).click());
    expect(locate).toHaveBeenCalledWith("text");
    act(() => button("窗边小猫").dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(locate).toHaveBeenLastCalledWith("first");
    act(() => button("窗边小猫").click());
    const role = detail().querySelector<HTMLSelectElement>("select")!;
    act(() => { role.value = "reference"; role.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(button("窗边小猫").textContent).toContain("参考图");
    act(() => button("移除引用 图片3").click());
    expect(button("窗边小猫")).toBeUndefined();
    expect(editor.textContent).not.toContain("@图片3");
    expect(button("一只小猫")).toBeTruthy();
    act(() => button("生成视频").click());
    expect(generate).toHaveBeenCalledWith("video");
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});
