import { useCallback, useEffect, useRef, useState } from "react";
import { LoaderCircle, X } from "lucide-react";
import { api } from "../api";
import { historyReasonLabel, historyTime } from "./board-history";

export function BoardHistoryDrawer({
  open, boardId, onClose, onRestore, onToast,
}: {
  open: boolean;
  boardId: string;
  onClose: () => void;
  onRestore: (version: number) => Promise<void>;
  onToast: (kind: "error", message: string) => void;
}) {
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<Array<{
    version: number; reason: string; createdAt: string; current: boolean;
  }>>([]);
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);
  const openRef = useRef(false);
  const requestRef = useRef(0);
  const toastRef = useRef(onToast);
  useEffect(() => { toastRef.current = onToast; }, [onToast]);

  const refreshHistory = useCallback(async () => {
    const request = ++requestRef.current;
    setHistoryLoading(true);
    try {
      const result = await api.boardHistory(boardId);
      if (request === requestRef.current) setHistoryEntries(result.entries);
    } catch (error) {
      if (request === requestRef.current) toastRef.current("error", error instanceof Error ? error.message : "创作历史加载失败");
    } finally {
      if (request === requestRef.current) setHistoryLoading(false);
    }
  }, [boardId]);

  useEffect(() => {
    openRef.current = open;
    if (open) void refreshHistory();
    return () => {
      openRef.current = false;
      requestRef.current += 1;
    };
  }, [open, refreshHistory]);

  const restoreHistory = useCallback(async (version: number) => {
    if (!window.confirm(`恢复到版本 ${version}？当前内容会作为新版本保留在历史里，可以撤销。`)) return;
    setRestoringVersion(version);
    try {
      await onRestore(version);
      if (openRef.current) await refreshHistory();
    } finally {
      setRestoringVersion(null);
    }
  }, [onRestore, refreshHistory]);

  if (!open) return null;
  return (
    <aside className="board-asset-drawer board-history-drawer" aria-label="创作历史">
      <header className="board-asset-head">
        <div>
          <strong>创作历史</strong>
          <span>{historyEntries.length} 个版本 · 最多保留 50 个</span>
        </div>
        <button type="button" className="icon-button compact" aria-label="关闭创作历史" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <div className="board-history-list">
        {historyLoading ? (
          <p className="board-asset-empty"><LoaderCircle size={12} className="spin" />正在读取历史…</p>
        ) : null}
        {!historyLoading && historyEntries.map((entry) => (
          <article key={entry.version} className={`board-history-row ${entry.current ? "is-current" : ""}`}>
            <div className="board-history-main">
              <div>
                <strong>版本 {entry.version}</strong>
                {entry.current ? <em>当前</em> : null}
              </div>
              <span>{historyReasonLabel(entry.reason)}</span>
              <time>{historyTime(entry.createdAt)}</time>
            </div>
            {entry.current ? null : (
              <button
                type="button"
                className="secondary-button compact"
                disabled={restoringVersion !== null}
                onClick={() => void restoreHistory(entry.version)}
              >
                {restoringVersion === entry.version ? <LoaderCircle size={11} className="spin" /> : null}
                恢复
              </button>
            )}
          </article>
        ))}
        {!historyLoading && !historyEntries.length ? (
          <p className="board-asset-empty">还没有历史版本。第一次修改后这里会出现快照。</p>
        ) : null}
      </div>
    </aside>
  );
}
