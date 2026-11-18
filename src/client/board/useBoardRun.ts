import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardRun, BoardRunStep } from "./board-run";
import { nextBoardRunStep, refreshBoardRun } from "./board-run";
import type { UseBoardResult } from "./useBoard";

const keyFor = (boardId: string) => `chatcanvas.board-run.${boardId}`;

function readRun(boardId: string) {
  try {
    const run = JSON.parse(localStorage.getItem(keyFor(boardId)) ?? "null") as BoardRun | null;
    if (!run || run.boardId !== boardId || !Array.isArray(run.steps)) return null;
    return { ...run, steps: run.steps.map((step): BoardRunStep => step.state === "submitting"
      ? { ...step, state: "unknown", detail: "上次提交未收到确认，请先核对任务记录" } : step) };
  } catch { return null; }
}

export function useBoardRun(boardId: string | null, board: Pick<UseBoardResult, "view" | "generate" | "submitting">, onError: (message: string) => void) {
  const [run, setRun] = useState<BoardRun | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const activeId = useRef(boardId);
  const inflight = useRef<string | null>(null);
  activeId.current = boardId;
  const runForBoard = run?.boardId === boardId ? run : null;
  const running = runningId !== null && runningId === boardId;

  const record = useCallback((value: BoardRun) => {
    try { localStorage.setItem(keyFor(value.boardId), JSON.stringify(value)); }
    catch { onError("运行进度无法保存，已暂停继续提交"); setRunningId(null); return false; }
    if (activeId.current === value.boardId) setRun(value);
    return true;
  }, [onError]);

  useEffect(() => {
    setRunningId(null);
    setRun(boardId ? readRun(boardId) : null);
  }, [boardId]);

  useEffect(() => {
    const doc = board.view?.id === boardId ? board.view.doc : null;
    if (!runForBoard || !doc || inflight.current === boardId) return;
    const refreshed = refreshBoardRun(runForBoard, doc);
    if (refreshed !== runForBoard) { record(refreshed); return; }
    if (!running || board.submitting) return;
    const step = nextBoardRunStep(runForBoard);
    if (!step) {
      if (!runForBoard.steps.some(({ state }) => state === "waiting" || state === "choosing")) setRunningId(null);
      return;
    }
    const update = (patch: Partial<BoardRunStep>): BoardRun => ({ ...runForBoard,
      steps: runForBoard.steps.map((item) => item.nodeId === step.nodeId ? { ...item, ...patch } : item) });
    if (!doc.nodes.some((node) => node.id === step.nodeId && node.type !== "text" && node.status !== "loading")) {
      record(update({ state: "failed", detail: "节点已移除或正在运行" }));
      return;
    }
    if (!record(update({ state: "submitting" }))) return;
    inflight.current = runForBoard.boardId;
    void board.generate(step.nodeId, { ...(step.model ? { model: step.model } : {}), ...(step.kind === "image" ? { count: step.requestCount } : {}) }, step.channelId)
      .then((result) => {
        inflight.current = null;
        if (!result) {
          record(update({ state: "unknown", detail: "提交未确认，请查看任务记录或节点提示" }));
          return;
        }
        const taskIds = result.taskIds ?? (result.taskId ? [result.taskId] : []);
        record(update({ state: taskIds.length ? "waiting" : "succeeded", taskIds, resultIds: result.resultNodeIds }));
      });
  }, [boardId, board.view, board.submitting, board.generate, running, runForBoard, record]);

  return {
    run: runForBoard, running,
    start(steps: BoardRunStep[], concurrency: number) {
      if (!boardId || inflight.current || !steps.length) return;
      if (record({ boardId, steps, concurrency, createdAt: new Date().toISOString() })) setRunningId(boardId);
    },
    pause() { setRunningId(null); },
    resume() { if (boardId) setRunningId(boardId); },
    applyRetries(taskIds: Map<string, string>) {
      if (!runForBoard || !taskIds.size || inflight.current) return;
      let applied = false;
      const steps = runForBoard.steps.map((step): BoardRunStep => {
        if (!step.taskIds?.some((id) => taskIds.has(id))) return step;
        applied = true;
        return { ...step, state: "waiting", detail: undefined, taskIds: step.taskIds.map((id) => taskIds.get(id) ?? id) };
      });
      if (applied) record({ ...runForBoard, steps: steps.map((step) => step.state === "blocked" ? { ...step, state: "pending", detail: undefined } : step) });
    },
    choose(nodeId: string) {
      if (!runForBoard || inflight.current) return;
      const step = runForBoard.steps.find((item) => item.nodeId === nodeId);
      const node = board.view?.doc.nodes.find((item) => item.id === nodeId);
      if (!step || node?.type !== "image" || !node.assetId || !node.taskId || !step.taskIds?.includes(node.taskId) || node.status !== "succeeded") {
        onError("请先展开图片节点，选择本轮生成的可用主图");
        return;
      }
      record({ ...runForBoard, steps: runForBoard.steps.map((step) => step.nodeId === nodeId && step.state === "choosing"
        ? { ...step, state: "succeeded", detail: undefined } : step) });
    },
  };
}
