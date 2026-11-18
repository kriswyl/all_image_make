// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useBoardRun } from "../src/client/board/useBoardRun";
import type { UseBoardResult } from "../src/client/board/useBoard";
import { createEmptyBoardDoc, DEFAULT_BOARD_VIEWPORT, type BoardView, type ImageBoardNode } from "../src/shared/board";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => localStorage.clear());

it("重开画布保留计划，明确继续前不提交，未确认的提交不重放", async () => {
  const image: ImageBoardNode = { type: "image", id: "image", ref: "n1", title: "镜头", x: 0, y: 0, width: 300, height: 300,
    createdAt: "", updatedAt: "", status: "empty", source: "generated", assetId: null, prompt: "首帧" };
  const doc = { ...createEmptyBoardDoc(), nodes: [image, { ...image, id: "another", ref: "n2" }], nextRef: 3 };
  const view: BoardView = { id: "film", title: "短片", doc, version: 1, viewport: DEFAULT_BOARD_VIEWPORT, uiState: {}, selection: [], canUndo: false, canRedo: false, threadId: "thread" };
  const base = { title: "镜头", kind: "image", requestCount: 1, dependencies: [] };
  localStorage.setItem("chatcanvas.board-run.film", JSON.stringify({ boardId: view.id, createdAt: "", steps: [
    { ...base, nodeId: "image", state: "submitting" }, { ...base, nodeId: "another", state: "pending" },
  ] }));
  const generate = vi.fn<UseBoardResult["generate"]>().mockResolvedValue(null);
  const onError = vi.fn();
  const root = createRoot(document.createElement("div"));
  let run!: ReturnType<typeof useBoardRun>;
  function Harness() { run = useBoardRun(view.id, { view, generate, submitting: false }, onError); return null; }
  try {
    await act(async () => root.render(<Harness />));
    expect(run.run?.steps[0]?.state).toBe("unknown");
    expect(generate).not.toHaveBeenCalled();
    await act(async () => run.resume());
    expect(generate).toHaveBeenCalledExactlyOnceWith("another", { count: 1 }, undefined);
    expect(run.run?.steps[1]?.state).toBe("unknown");
  } finally { act(() => root.unmount()); }
});
