// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError, api } from "../src/client/api";
import { useBoard } from "../src/client/board/useBoard";
import { BoardCanvas } from "../src/client/board/BoardCanvas";
import { useBoardDocument } from "../src/client/board/useBoardDocument";
import { createEmptyBoardDoc, DEFAULT_BOARD_VIEWPORT, directUpstreamImages, type BoardView } from "../src/shared/board";
import type { Asset, Task } from "../src/shared/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function board(id: string, version = 1): BoardView {
  return {
    id, version, title: id, doc: createEmptyBoardDoc(), viewport: DEFAULT_BOARD_VIEWPORT,
    selection: [], uiState: {}, threadId: `thread-${id}`, canUndo: false, canRedo: false,
  };
}

async function mountBoard(initialId: string) {
  const root = createRoot(document.createElement("div"));
  const toast = vi.fn();
  let state!: ReturnType<typeof useBoardDocument>;
  function Harness({ id }: { id: string }) {
    state = useBoardDocument(id, toast);
    return null;
  }
  const show = (id: string) => act(async () => { root.render(<Harness id={id} />); });
  await show(initialId);
  return { show, get state() { return state; }, toast, unmount: () => act(() => root.unmount()) };
}

it("保存期间继续编辑，后续保存使用已确认的版本和最新文档", async () => {
  vi.useFakeTimers();
  const initial = board("a");
  vi.spyOn(api, "board").mockResolvedValue(initial);
  let finishFirst!: (value: BoardView) => void;
  const save = vi.spyOn(api, "saveBoard")
    .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
    .mockImplementation(async (_id, input) => ({ ...initial, version: 3, doc: input.doc }));
  const ui = await mountBoard("a");
  try {
    act(() => ui.state.applyLocal(doc => ({ ...doc, nextRef: 2 }), "first"));
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    act(() => ui.state.applyLocal(doc => ({ ...doc, nextRef: 3 }), "second"));
    await act(async () => { finishFirst({ ...initial, version: 2, doc: { ...initial.doc, nextRef: 2 } }); });
    expect(ui.state.view?.doc.nextRef).toBe(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(save).toHaveBeenNthCalledWith(2, "a", { baseVersion: 2, doc: { ...initial.doc, nextRef: 3 }, reason: "second" });
    expect(ui.state.view?.version).toBe(3);
  } finally { ui.unmount(); }
});

it("生成提交期间继续编辑，回包合并结果节点并接着保存本地修改", async () => {
  vi.useFakeTimers();
  const initial = board("submit");
  const base = { x: 0, y: 0, width: 300, height: 200, title: "", createdAt: "", updatedAt: "" };
  initial.doc.nodes = [{ ...base, id: "text", ref: "n1", type: "text", text: "原文" },
    { ...base, id: "image", ref: "n2", type: "image", assetId: null, source: "generated", status: "empty" }];
  initial.doc.nextRef = 3;
  vi.spyOn(api, "board").mockResolvedValue(initial);
  let finish!: (result: Awaited<ReturnType<typeof api.generateBoardNode>>) => void;
  vi.spyOn(api, "generateBoardNode").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const save = vi.spyOn(api, "saveBoard").mockImplementation(async (_id, input) => ({ ...initial, version: 3, doc: input.doc }));
  const root = createRoot(document.createElement("div"));
  const toast = vi.fn();
  let state!: ReturnType<typeof useBoard>;
  function Harness() { state = useBoard(initial.id, toast); return null; }
  try {
    await act(async () => root.render(<Harness />));
    let request!: ReturnType<typeof state.generate>;
    await act(async () => { request = state.generate("image"); });
    expect(state.submitting).toBe(true);
    act(() => {
      state.updateNode("text", { text: "新文本" });
      state.addNode("text", { x: 80, y: 80 });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(450); });
    expect(save).not.toHaveBeenCalled();
    const remote = { ...initial, version: 2, doc: { ...initial.doc, nextRef: 4,
      nodes: [...initial.doc.nodes, { ...base, id: "result", ref: "n3", type: "image" as const, assetId: null, status: "empty" as const, source: "generated" as const }] } };
    await act(async () => {
      finish({ board: remote, kind: "image", task: null, resultNodeIds: ["result"], configNodeId: "image", prompt: "", modelAlias: "", referenceCount: 0 });
      await request;
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(state.view?.doc.nodes[0]).toMatchObject({ text: "新文本" });
    expect(state.view?.doc.nodes.map((node) => node.ref)).toEqual(["n1", "n2", "n3", "n4"]);
    expect(save).toHaveBeenCalledWith(initial.id, expect.objectContaining({ baseVersion: 2 }));
  } finally { act(() => root.unmount()); }
});

it("切板后旧保存响应不覆盖新板，版本冲突使用服务端快照", async () => {
  vi.useFakeTimers();
  vi.spyOn(api, "board").mockImplementation(async id => board(id));
  let finishFirst!: (value: BoardView) => void;
  const latest = { ...board("b", 4), title: "别处更新" };
  const save = vi.spyOn(api, "saveBoard")
    .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
    .mockRejectedValueOnce(new ApiError("版本冲突", 409, "BOARD_VERSION_CONFLICT", { board: latest }));
  const ui = await mountBoard("a");
  try {
    act(() => ui.state.applyLocal(doc => ({ ...doc, nextRef: 2 }), "old"));
    await ui.show("b");
    expect(save).toHaveBeenCalledWith("a", expect.objectContaining({ baseVersion: 1 }));
    await act(async () => { finishFirst(board("a", 2)); });
    expect(ui.state.view?.id).toBe("b");
    act(() => ui.state.applyLocal(doc => ({ ...doc, nextRef: 2 }), "conflicting"));
    await act(async () => { await ui.state.flush(); });
    expect(ui.state.view).toEqual(latest);
    expect(ui.toast).toHaveBeenCalledWith("error", "无限画布已在别处更新，已重新加载");
  } finally { ui.unmount(); }
});

it.each(["导入模板", "恢复历史"] as const)("%s 的旧画布响应不会覆盖切换后的画布", async (action) => {
  vi.spyOn(api, "board").mockImplementation(async id => board(id));
  let finish!: (value: BoardView) => void;
  const response = new Promise<BoardView>(resolve => { finish = resolve; });
  const importTemplate = vi.spyOn(api, "importTemplateToBoard")
    .mockImplementation(async () => ({ board: await response, addedNodes: 1 }));
  const restoreVersion = vi.spyOn(api, "restoreBoardVersion").mockReturnValue(response);
  const root = createRoot(document.createElement("div"));
  const toast = vi.fn();
  let state!: ReturnType<typeof useBoard>;
  function Harness({ id }: { id: string }) {
    state = useBoard(id, toast);
    return null;
  }
  const show = (id: string) => act(async () => { root.render(<Harness id={id} />); });

  try {
    await show("a");
    let pending!: Promise<number | null | void>;
    await act(async () => {
      pending = action === "导入模板" ? state.importTemplate("template") : state.restoreVersion(2);
    });
    if (action === "导入模板") expect(importTemplate).toHaveBeenCalledWith("a", "template");
    else expect(restoreVersion).toHaveBeenCalledWith("a", 2, 1);
    await show("b");
    await act(async () => {
      finish(board("a", 3));
      await pending;
    });
    expect(state.view?.id).toBe("b");
    expect(state.view?.version).toBe(1);
  } finally { act(() => root.unmount()); }
});

it("多图任务的前一张结果卡已删除时，剩余卡仍接收自己的图片", async () => {
  const initial = board("a");
  initial.doc.nodes = [{
    id: "second", ref: "n2", type: "image", x: 420, y: 80, width: 240, height: 240,
    title: "结果 2", createdAt: "", updatedAt: "", source: "generated", status: "loading",
    assetId: null, taskId: "batch", resultIndex: 1,
  }];
  vi.spyOn(api, "board").mockResolvedValue(initial);
  vi.spyOn(api, "task").mockResolvedValue({
    id: "batch", status: "succeeded", assets: [
      { id: "first-image", mimeType: "image/png" }, { id: "second-image", mimeType: "image/png" },
    ],
  } as Task);
  vi.spyOn(api, "saveBoard").mockImplementation(async (_id, input) => ({ ...initial, version: 2, doc: input.doc }));
  const root = createRoot(document.createElement("div"));
  let state!: ReturnType<typeof useBoard>;
  const toast = vi.fn();
  function Harness() {
    state = useBoard("a", toast);
    return null;
  }
  try {
    await act(async () => { root.render(<Harness />); });
    expect(state.view?.doc.nodes[0]).toMatchObject({ id: "second", status: "succeeded", assetId: "second-image" });
  } finally {
    act(() => root.unmount());
  }
});

it("生图配置节点汇总不同请求的结果，不会用单张失败覆盖成功图片", async () => {
  const initial = board("a");
  const base = { x: 0, y: 0, width: 240, height: 240, createdAt: "", updatedAt: "" };
  initial.doc.nodes = [
    { ...base, id: "config", ref: "n1", title: "批量", type: "config", mode: "image",
      prompt: "测试", count: 2, useUpstreamText: true, status: "loading",
      lastTaskId: "request-a", imageBatchResultIds: ["a", "b"] },
    { ...base, id: "a", ref: "n2", title: "结果 1", type: "image", source: "generated",
      status: "loading", assetId: null, taskId: "request-a", resultIndex: 0 },
    { ...base, id: "b", ref: "n3", title: "结果 2", type: "image", source: "generated",
      status: "loading", assetId: null, taskId: "request-b", resultIndex: 0 },
  ];
  vi.spyOn(api, "board").mockResolvedValue(initial);
  vi.spyOn(api, "task").mockImplementation(async (id) => (id === "request-a"
    ? { id, status: "failed", errorMessage: "渠道拒绝此张", assets: [] }
    : { id, status: "succeeded", assets: [{ id: "second-image", mimeType: "image/png" }] }) as unknown as Task);
  vi.spyOn(api, "saveBoard").mockImplementation(async (_id, input) => ({ ...initial, version: 2, doc: input.doc }));
  const root = createRoot(document.createElement("div"));
  const toast = vi.fn();
  let state!: ReturnType<typeof useBoard>;
  function Harness() { state = useBoard("a", toast); return null; }
  try {
    await act(async () => { root.render(<Harness />); });
    expect(state.view?.doc.nodes).toMatchObject([
      { status: "failed", error: expect.stringContaining("1 张失败") },
      { status: "failed", error: "渠道拒绝此张", assetId: null },
      { status: "succeeded", assetId: "second-image" },
    ]);
  } finally { act(() => root.unmount()); }
});

it("图组可展开并切换主图，收起后沿用原节点的下游连线", async () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const initial = board("a");
  const base = { y: 80, width: 240, height: 240, createdAt: "", updatedAt: "" };
  initial.doc.nodes = [
    { ...base, x: 0, id: "primary", ref: "n1", title: "主卡", type: "image", source: "generated",
      status: "succeeded", assetId: "first", taskId: "task-first",
      imageResultGroup: { memberIds: ["alternate"], expanded: false } },
    { ...base, x: 280, id: "alternate", ref: "n2", title: "结果 2", type: "image", source: "generated",
      status: "succeeded", assetId: "second", taskId: "task-second" },
    { ...base, x: 310, id: "target", ref: "n3", title: "已有卡", type: "image",
      source: "upload", status: "empty", assetId: null },
  ];
  initial.doc.edges = [{ id: "edge", source: "primary", target: "target", kind: "input", role: "reference" }];
  vi.spyOn(api, "board").mockResolvedValue(initial);
  vi.spyOn(api, "saveBoard").mockImplementation(async (_id, input) => ({ ...initial, version: 2, doc: input.doc }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const toast = vi.fn();
  const noop = () => {};
  const assets = new Map(["first", "second"].map((id) => [id, { id, url: `/${id}.png`, fileName: `${id}.png`, mimeType: "image/png" } as Asset]));
  let state!: ReturnType<typeof useBoard>;
  function Harness() {
    state = useBoard("a", toast);
    return <BoardCanvas board={state} assets={assets} onPickImage={noop} onUploadMediaIntoNode={noop}
      onUploadFiles={noop} onPreviewAsset={noop} onDeleteNode={noop} onCompareVersions={noop}
      onExtractFrame={noop} renderNodeSettings={() => null} />;
  }
  try {
    await act(async () => { root.render(<Harness />); });
    expect(host.querySelector('[data-board-node-id="alternate"]')).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="展开 2 张图片"]')!.click());
    const alternate = host.querySelector<HTMLElement>('[data-board-node-id="alternate"]')!;
    expect(parseInt(alternate.style.top)).toBeGreaterThan(320);
    const promote = [...alternate.querySelectorAll("button")].find((button) => button.textContent === "设为主图")!;
    act(() => promote.click());
    expect(directUpstreamImages(state.view!.doc, "target")[0]).toMatchObject({ id: "primary", assetId: "second", taskId: "task-second" });
    expect(state.view!.doc.nodes.find((node) => node.id === "alternate")).toMatchObject({ assetId: "first", taskId: "task-first" });
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="收起图片结果"]')!.click());
    expect(host.querySelector('[data-board-node-id="alternate"]')).toBeNull();
    expect(host.querySelector('[data-board-node-id="primary"] img')?.getAttribute("src")).toContain("/second.png");
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
