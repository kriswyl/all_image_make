import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import type { ConversationView } from "../../shared/agent-types";

/** 保留原始聊天记录；这里只查看发送给模型的历史摘要。 */
export function ContextSummaryControl({ view, onBudgetChange, onAutoContinueChange, onCompress, compressing, disabled }: {
  view: ConversationView;
  onBudgetChange: (budget: number) => void;
  onAutoContinueChange?: (limit: number) => void;
  onCompress: () => void;
  compressing?: boolean;
  disabled?: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(view.contextBudget ?? 350000));
  const [continuationValue, setContinuationValue] = useState(String(view.chatAutoContinueLimit ?? 20));
  const [editingContinuation, setEditingContinuation] = useState(false);
  const budget = view.contextBudget ?? 350000;
  function save() {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 4000 || parsed > 2000000) {
      setValue(String(budget));
      setEditing(false);
      return;
    }
    setEditing(false);
    if (parsed !== budget) onBudgetChange(parsed);
  }
  function saveContinuation() {
    const parsed = Number(continuationValue);
    const current = view.chatAutoContinueLimit ?? 20;
    setEditingContinuation(false);
    if (!continuationValue.trim() || !Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
      setContinuationValue(String(current));
      return;
    }
    if (parsed !== current) onAutoContinueChange?.(parsed);
  }
  useEffect(() => {
    if (!open) return;
    const closeFromOutside = () => {
      if (editing) save();
      if (editingContinuation) saveContinuation();
      setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) closeFromOutside();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { closeFromOutside(); triggerRef.current?.focus(); }
    };
    // 捕获阶段先接收事件，画布和其他控件阻止冒泡也不会影响关闭。
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => { document.removeEventListener("pointerdown", onPointerDown, true); document.removeEventListener("keydown", onKeyDown, true); };
  }, [open, editing, value, budget, onBudgetChange, editingContinuation, continuationValue, view.chatAutoContinueLimit, onAutoContinueChange]);
  return (
    <div ref={rootRef} className="context-summary-control">
      <button ref={triggerRef} type="button" className="context-summary-trigger" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)} title="查看摘要与设置上下文预算">{view.contextSummary ? "已压缩 · 查看摘要" : "上下文设置"}</button>
      {open ? <div id={panelId} className="context-summary-panel">
        <div className="context-summary-head"><strong>上下文压缩</strong><button type="button" className="context-summary-close" aria-label="关闭上下文设置" onClick={() => { setOpen(false); triggerRef.current?.focus(); }}><X size={14} /></button></div>
        <p>保留原始记录和最近对话；较早内容可能被概括。预算为估算输入 token，不包含模型输出。</p>
        <label>输入预算
          <input type="number" min={4000} max={2000000} step={1000}
            value={editing ? value : String(budget)}
            onFocus={() => { setValue(String(budget)); setEditing(true); }}
            onChange={(event) => setValue(event.target.value)}
            onBlur={save}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
          <span>tokens</span>
        </label>
        {onAutoContinueChange && view.chatMode === "chat" ? <>
          <label>自动续写次数
            <input aria-label="自动续写次数" type="number" min={0} max={100} step={1} disabled={disabled}
              value={editingContinuation ? continuationValue : String(view.chatAutoContinueLimit ?? 20)}
              onFocus={() => { setContinuationValue(String(view.chatAutoContinueLimit ?? 20)); setEditingContinuation(true); }}
              onChange={(event) => setContinuationValue(event.target.value)} onBlur={saveContinuation}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
            <span>次</span>
          </label>
          <small>设为 0 关闭；回答达到输出上限时自动接续，每次续写都会产生模型用量。</small>
        </> : null}
        <button type="button" className="secondary-button compact context-compress-button" onClick={onCompress} disabled={disabled || compressing}>
          {compressing ? "正在压缩…" : "立即压缩"}
        </button>
        <small>压缩会调用当前对话模型并产生相应的模型用量。</small>
        {view.contextSummary ? <><small>已概括至消息 #{view.contextSummary.throughSeq}</small><div className="context-summary-text">{view.contextSummary.text}</div></> : <small>目前没有压缩摘要。</small>}
      </div> : null}
    </div>
  );
}
