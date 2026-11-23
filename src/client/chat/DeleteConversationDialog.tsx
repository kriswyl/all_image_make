import { Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CONVERSATION_TRASH_DAYS } from "../../shared/agent-types";

export function DeleteConversationDialog({ title, permanent = false, onClose, onConfirm }: {
  title: string;
  permanent?: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const headingId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const deleting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const opener = document.activeElement;
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);

  useEffect(() => {
    if (busy) dialog.current?.focus();
    else cancel.current?.focus();
  }, [busy]);

  async function deleteConversation() {
    if (deleting.current) return;
    deleting.current = true;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onClose();
    } catch (reason) {
      deleting.current = false;
      setBusy(false);
      setError(reason instanceof Error ? reason.message : "删除会话失败");
    }
  }

  return createPortal(
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !deleting.current) onClose();
    }}>
      <section ref={dialog} className="modal narrow conversation-delete-dialog" role="alertdialog" tabIndex={-1}
        aria-modal="true" aria-labelledby={headingId} aria-describedby={descriptionId} aria-busy={busy}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (!deleting.current) onClose();
          } else if (event.key === "Tab") {
            event.preventDefault();
            if (!deleting.current) (document.activeElement === cancel.current ? confirm.current : cancel.current)?.focus();
          }
        }}>
        <div className="modal-header"><div><Trash2 size={18} aria-hidden="true" /><h2 id={headingId}>{permanent ? "永久删除会话？" : "移到最近删除？"}</h2></div></div>
        <div className="modal-body">
          <p id={descriptionId} className="modal-lead">{permanent ? "将永久删除" : "将移走"}「<strong>{title}</strong>」。
            {permanent ? "聊天记录和仅在此会话使用的上传附件将无法恢复。" : `可在 ${CONVERSATION_TRASH_DAYS} 天内从「最近删除」恢复。`}</p>
          {error ? <p className="form-error" role="alert">{error}</p> : null}
        </div>
        <div className="modal-footer">
          <button ref={cancel} className="secondary-button" type="button" disabled={busy} onClick={onClose}>取消</button>
          <button ref={confirm} className="primary-button danger" type="button" disabled={busy} onClick={() => void deleteConversation()}>
            {busy ? "正在删除…" : permanent ? "永久删除" : "移到最近删除"}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}
