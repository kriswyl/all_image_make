// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError, api } from "../src/client/api";
import { useBoardDocument } from "../src/client/board/useBoardDocument";
import { createEmptyBoardDoc, DEFAULT_BOARD_VIEWPORT, type BoardView } from "../src/shared/board";

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
