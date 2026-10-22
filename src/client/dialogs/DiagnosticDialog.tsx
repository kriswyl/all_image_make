import { useEffect, useState } from "react";
import { Activity, LoaderCircle, X } from "lucide-react";
import { api } from "../api";
import { LoadingScreen, StatusBadge, formatTime } from "../task-ui";
import type { Diagnostic, Task } from "../../shared/types";

export function DiagnosticDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const [items, setItems] = useState<Diagnostic[] | null>(null);
  useEffect(() => { void api.diagnostics(task.id).then(setItems).catch(() => setItems([])); }, [task.id]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="modal diagnostic-modal"><div className="modal-header"><div><Activity size={18} /><h2>请求诊断</h2></div><button className="icon-button" title="关闭" onClick={onClose}><X size={18} /></button></div><div className="diagnostic-summary"><StatusBadge status={task.status} /><span>{task.model}</span><span>{task.id.slice(0, 8)}</span></div><div className="diagnostic-list">{items === null ? <LoadingScreen compact /> : items.length ? items.map((item) => {
      // 中间轮询不存完整响应（一个视频任务上百次能把库撑到几 MB），request 为 null 就是摘要行
      const compact = item.request === null;
      return (
        <article key={item.id} className={`diagnostic-entry ${compact ? "compact" : ""}`}>
          <header>
            <span>HTTP {item.httpStatus ?? "-"}</span>
            <span>{item.durationMs != null ? `${item.durationMs} ms` : ""}</span>
            <span>{formatTime(item.createdAt)}</span>
          </header>
          {compact ? (
            <p className="diagnostic-compact">{pollSummary(item.response)}<small>中间轮询只保留状态摘要，完整响应见最后一次</small></p>
          ) : (
            <><h3>Request</h3><pre>{JSON.stringify(item.request, null, 2)}</pre><h3>Response</h3><pre>{JSON.stringify(item.response, null, 2)}</pre></>
          )}
        </article>
      );
    }) : <div className="table-empty"><Activity size={28} /><span>暂无诊断记录</span></div>}</div></div></div>;
}

function pollSummary(response: unknown) {
  if (!response || typeof response !== "object") return "轮询中";
  const record = response as Record<string, unknown>;
  const parts: string[] = [typeof record.status === "string" ? record.status : "进行中"];
  if (typeof record.progress === "number") parts.push(`${record.progress}%`);
  return `${typeof record.poll === "number" ? `第 ${record.poll} 次轮询 · ` : ""}${parts.join(" · ")}`;
}

