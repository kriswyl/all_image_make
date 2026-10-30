import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, X } from "lucide-react";
import { api } from "../api";
import { formatTime } from "../task-ui";
import type { Asset, Task } from "../../shared/types";

export function BoardNodeVersions({ boardId, nodeId, onClose, onApply }: { boardId: string; nodeId: string; onClose: () => void; onApply: (task: Task, asset: Asset) => Promise<void> }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [left, setLeft] = useState(0);
  const [right, setRight] = useState(1);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { let cancelled = false; void api.boardNodeVersions(boardId, nodeId).then((items) => { if (!cancelled) { setTasks(items); setRight(Math.min(1, items.length - 1)); } }).catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "读取版本失败"); }).finally(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }, [boardId, nodeId]);
  async function apply(task: Task) {
    const asset = task.assets[0]; if (!asset || busy) return;
    setBusy(true); setError("");
    try { await onApply(task, asset); onClose(); } catch (e) { setError(e instanceof Error ? e.message : "切换版本失败"); } finally { setBusy(false); }
  }
  function pane(index: number, setIndex: (index: number) => void) {
    const task = tasks[index]; const asset = task?.assets[0];
    return <div className="board-version-pane"><select value={index} onChange={(e) => setIndex(Number(e.target.value))} aria-label="选择生成版本">{tasks.map((item, i) => <option key={item.id} value={i}>{formatTime(item.finishedAt || item.createdAt)} · {item.model}</option>)}</select>
      {asset ? <div className="board-version-media">{asset.mimeType.startsWith("video/") ? <video src={api.assetUrl(asset.url)} controls preload="metadata" /> : asset.mimeType.startsWith("audio/") ? <audio src={api.assetUrl(asset.url)} controls preload="metadata" /> : <img src={api.assetUrl(asset.url)} alt="版本预览" />}</div> : null}
      {task ? <><p title={task.prompt}>{task.prompt}</p><button type="button" className="secondary-button compact" disabled={busy} onClick={() => void apply(task)}>使用此版本</button></> : null}
    </div>;
  }
  return createPortal(<div className="board-versions-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}><section className="board-versions-dialog" role="dialog" aria-modal="true" aria-label="节点生成版本对比">
    <header><div><strong>生成版本对比</strong><small>按此节点的生成任务显示；切换只替换素材，保留当前提示词和参数。</small></div><button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="关闭"><X size={16} /></button></header>
    {loading ? <p><LoaderCircle className="spin" size={16} /> 正在加载…</p> : tasks.length ? <div className="board-version-grid">{pane(left, setLeft)}{pane(Math.max(0, right), setRight)}</div> : <p>此节点还没有可对比的生成记录。上传的素材不会自动成为生成版本。</p>}
    {error ? <p role="alert" className="story-review-error">{error}</p> : null}
  </section></div>, document.body);
}
