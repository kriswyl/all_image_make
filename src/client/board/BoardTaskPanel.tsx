import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, Crosshair, ListChecks, X } from "lucide-react";
import { api } from "../api";
import { DiagnosticDialog } from "../dialogs/DiagnosticDialog";
import { StatusBadge, terminalStatuses } from "../task-ui";
import type { BoardNode, BoardTaskSummary } from "../../shared/board";
import type { Task } from "../../shared/types";
import type { BoardRun } from "./board-run";
import type { useBoardRun } from "./useBoardRun";

const stepLabels = { pending: "未提交", submitting: "提交中", waiting: "等待结果", choosing: "待确认主图",
  succeeded: "完成", failed: "失败", blocked: "等待上游修复", unknown: "提交待核对" } as const;

export function BoardTaskPanel({ boardId, nodes, selection, run, running, onPause, onResume, onChoose, onLocate, onRetry, onStop, onClose }: {
  boardId: string;
  nodes: BoardNode[];
  selection: string[];
  run: BoardRun | null;
  running: boolean;
  onPause: () => void;
  onResume: () => void;
  onChoose: ReturnType<typeof useBoardRun>["choose"];
  onLocate: (id: string) => void;
  onRetry: (taskIds: string[]) => void;
  onStop: (taskId: string) => void;
  onClose: () => void;
}) {
  const [tasks, setTasks] = useState<BoardTaskSummary[] | null>(null);
  const [diagnostic, setDiagnostic] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"run" | "tasks">(run ? "run" : "tasks");
  const [failedOnly, setFailedOnly] = useState(false);
  const [selectionOnly, setSelectionOnly] = useState(false);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  useEffect(() => {
    let active = true;
    let timer: number;
    async function refresh() {
      try {
        const data = await api.boardTasks(boardId);
        if (active) { setTasks(data); setError(""); }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : "读取任务失败"); }
      if (active) timer = window.setTimeout(() => void refresh(), 1800);
    }
    void refresh();
    return () => { active = false; window.clearTimeout(timer); };
  }, [boardId]);

  async function openDiagnostic(taskId: string) {
    try { setDiagnostic(await api.task(taskId)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "读取诊断失败"); }
  }

  function locateId(task: BoardTaskSummary) {
    return task.nodeIds.find((id) => byId.has(id)) ?? (byId.has(task.sourceNodeId) ? task.sourceNodeId : undefined);
  }

  const scoped = (tasks ?? []).filter((task) => !selectionOnly || selection.includes(task.sourceNodeId) || task.nodeIds.some((id) => selection.includes(id)));
  const retryable = scoped.filter((task) => ["failed", "cancelled", "expired"].includes(task.status)
    && task.nodeIds.some((id) => { const node = byId.get(id); return node && "taskId" in node && node.taskId === task.id; }));
  const visible = failedOnly ? retryable : scoped;
  return <aside className="board-command-panel board-task-panel" aria-label="画布任务">
    <header><Activity size={17} /><strong>画布任务</strong><button type="button" className="icon-button" aria-label="关闭任务面板" onClick={onClose}><X size={16} /></button></header>
    <div className="board-command-tabs">
      <button type="button" aria-pressed={tab === "run"} onClick={() => setTab("run")}><ListChecks size={14} />运行计划</button>
      <button type="button" aria-pressed={tab === "tasks"} onClick={() => setTab("tasks")}>请求记录</button>
    </div>
    {tab === "run" ? run ? <>
      <div className="board-command-toolbar"><span>{run.steps.filter(({ state }) => state === "succeeded").length} / {run.steps.length} 项完成</span>
        {running ? <button type="button" className="secondary-button compact" onClick={onPause}>暂停后续提交</button>
          : run.steps.some(({ state }) => state === "pending") ? <button type="button" className="secondary-button compact" onClick={onResume}>继续运行</button> : null}
      </div>
      <div className="board-command-list">{run.steps.map((step) => <article key={step.nodeId}>
        <div><strong>{step.title}</strong><small>{stepLabels[step.state]}{step.detail ? ` · ${step.detail}` : ""}</small></div>
        <div>{step.state === "choosing" ? <button type="button" className="secondary-button compact" onClick={() => onChoose(step.nodeId)}>确认主图</button> : null}
          <button type="button" className="icon-button" disabled={!byId.has(step.nodeId)} aria-label={`定位 ${step.title}`} onClick={() => onLocate(step.nodeId)}><Crosshair size={15} /></button></div>
      </article>)}</div>
    </> : <p className="board-command-empty">选中生成节点，点击「运行所选」即可建立计划。</p> : <>
      <div className="board-command-toolbar">
        <label><input type="checkbox" checked={failedOnly} onChange={(event) => setFailedOnly(event.target.checked)} />可重试</label>
        <label><input type="checkbox" checked={selectionOnly} onChange={(event) => setSelectionOnly(event.target.checked)} />仅选中节点</label>
        <button type="button" className="secondary-button compact" disabled={!retryable.length} onClick={() => onRetry(retryable.map(({ id }) => id))}>重试失败项</button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <div className="board-command-list">
        {tasks === null ? <p className="board-command-empty">正在读取任务…</p> : null}
        {tasks && !visible.length ? <p className="board-command-empty">暂无{failedOnly ? "可重试任务" : "生成记录"}</p> : null}
        {visible.map((task) => {
          const nodeId = locateId(task);
          return <article key={task.id}><div><strong>{(nodeId && byId.get(nodeId)?.title) || task.model}</strong>
            <small>{task.model} · {new Date(task.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}</small>
            {task.errorMessage ? <small className="board-command-error">{task.errorMessage}</small> : null}</div>
            <div><StatusBadge status={task.status} /><div className="board-task-actions">
              {nodeId ? <button type="button" className="icon-button" aria-label="定位任务节点" onClick={() => onLocate(nodeId)}><Crosshair size={14} /></button> : null}
              <button type="button" className="secondary-button compact" onClick={() => void openDiagnostic(task.id)}>诊断</button>
              {!terminalStatuses.includes(task.status) ? <button type="button" className="secondary-button compact" onClick={() => onStop(task.id)}>停止</button> : null}
              {retryable.includes(task) ? <button type="button" className="secondary-button compact" onClick={() => onRetry([task.id])}>重试</button> : null}
            </div></div></article>;
        })}
      </div>
    </>}
    {diagnostic ? createPortal(<DiagnosticDialog task={diagnostic} onClose={() => setDiagnostic(null)} />, document.body) : null}
  </aside>;
}
