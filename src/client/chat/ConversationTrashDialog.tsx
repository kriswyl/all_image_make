import { RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CONVERSATION_TRASH_DAYS, DEFAULT_CONVERSATION_TITLE, type TrashedConversation } from "../../shared/agent-types";
import { api } from "../api";
import { DeleteConversationDialog } from "./DeleteConversationDialog";

const formatDate = (value: string) => new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function ConversationTrashDialog({ onClose, onRestore }: { onClose: () => void; onRestore: (id: string) => Promise<void> }) {
  const headingId = useId();
  const [items, setItems] = useState<TrashedConversation[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<TrashedConversation | null>(null);
  const close = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement;
    close.current?.focus();
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);

  useEffect(() => {
    if (!loading) return;
    let cancelled = false;
    void api.trashedConversations().then((result) => {
      if (!cancelled) setItems(result);
    }, (reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "无法读取最近删除");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [loading]);

  function removeItem(id: string) {
    setItems((current) => current?.filter((item) => item.id !== id) ?? null);
    close.current?.focus();
  }

  async function restore(id: string) {
    setError("");
    setRestoring(id);
    try { await onRestore(id); removeItem(id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "恢复会话失败"); }
    finally { setRestoring(null); }
  }

  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !purgeTarget) onClose();
    }}>
      <section className="modal conversation-trash-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId} onKeyDown={(event) => {
        if (event.key === "Escape" && !purgeTarget) { event.stopPropagation(); onClose(); }
        if (event.key !== "Tab" || purgeTarget) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const first = buttons[0];
        const last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
        <div className="modal-header">
          <div><Trash2 size={18} aria-hidden="true" /><h2 id={headingId}>最近删除</h2></div>
          <button ref={close} className="icon-button" type="button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body">
          <p className="modal-lead">会话保留 {CONVERSATION_TRASH_DAYS} 天，到期后自动清理。</p>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          {loading ? <p role="status" className="modal-lead">正在读取…</p> : null}
          {!loading && items === null ? <div><button type="button" className="secondary-button" onClick={() => { setError(""); setLoading(true); }}>重试</button></div> : null}
          {items?.length === 0 ? <p className="conversation-trash-empty">没有已删除的会话</p> : null}
          {items?.length ? <ul className="conversation-trash-list">{items.map((item) => (
            <li key={item.id}>
              <div className="conversation-trash-info">
                <strong>{item.title || DEFAULT_CONVERSATION_TITLE}</strong>
                <small>{formatDate(item.deletedAt)} 删除 · {formatDate(item.expiresAt)} 到期</small>
              </div>
              <div className="conversation-trash-actions">
                <button type="button" className="secondary-button compact" disabled={restoring !== null} onClick={() => void restore(item.id)}>
                  <RotateCcw size={13} />{restoring === item.id ? "恢复中…" : "恢复"}
                </button>
                <button type="button" className="secondary-button danger compact" disabled={restoring !== null} onClick={() => setPurgeTarget(item)}>永久删除</button>
              </div>
            </li>
          ))}</ul> : null}
        </div>
      </section>
      {purgeTarget ? <DeleteConversationDialog permanent title={purgeTarget.title || DEFAULT_CONVERSATION_TITLE} onClose={() => setPurgeTarget(null)} onConfirm={async () => {
        await api.purgeConversation(purgeTarget.id);
        removeItem(purgeTarget.id);
      }} /> : null}
    </div>,
    document.body,
  );
}
