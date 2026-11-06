import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { usesPlainChat, type ChatToolScope, type ConversationView } from "../../shared/agent-types";

/** 保留原始聊天记录；这里只查看发送给模型的历史摘要。 */
export function ContextSummaryControl({ view, onBudgetChange, onAutoContinueChange, onChatLimitsChange, onBoardLimitsChange, onToolScopeChange, onVisionChange, onCompress, compressing, disabled }: {
  view: ConversationView;
  onBudgetChange: (budget: number) => void;
  onAutoContinueChange?: (limit: number) => void;
  onChatLimitsChange?: (patch: { chatToolRoundLimit?: number; chatModelCallLimit?: number; chatTurnMinutes?: number; chatTokenLimit?: number }) => void;
  /** 只有画布助手面板传：单轮思考次数 / 任务完成后的自动续跑次数 */
  onBoardLimitsChange?: (patch: { boardMaxRounds?: number; boardAutoContinueLimit?: number }) => void;
  onToolScopeChange?: (scope: ChatToolScope) => void;
  onVisionChange?: (enabled: boolean) => void;
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
  const [roundsValue, setRoundsValue] = useState(String(view.boardMaxRounds ?? 10));
  const [autoContinueValue, setAutoContinueValue] = useState(String(view.boardAutoContinueLimit ?? 3));
  const [chatRounds, setChatRounds] = useState(String(view.chatToolRoundLimit ?? 16));
  const [modelCalls, setModelCalls] = useState(String(view.chatModelCallLimit ?? 500));
  const [turnMinutes, setTurnMinutes] = useState(String(view.chatTurnMinutes ?? 30));
  const [tokenLimit, setTokenLimit] = useState(String(view.chatTokenLimit ?? 0));
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
  function saveBoardLimits(field: "boardMaxRounds" | "boardAutoContinueLimit", raw: string, minimum: number, maximum: number, fallback: number) {
    const parsed = Number(raw);
    if (!raw.trim() || !Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      if (field === "boardMaxRounds") setRoundsValue(String(fallback)); else setAutoContinueValue(String(fallback));
      return;
    }
    if (parsed !== fallback) onBoardLimitsChange?.({ [field]: parsed });
  }
  function saveChatLimit(field: "chatToolRoundLimit" | "chatModelCallLimit" | "chatTurnMinutes" | "chatTokenLimit", raw: string, max: number, current: number, set: (value: string) => void, min = 1) {
    const parsed = Number(raw);
    if (!raw.trim() || !Number.isInteger(parsed) || parsed < min || parsed > max) { set(String(current)); return; }
    if (parsed !== current) onChatLimitsChange?.({ [field]: parsed });
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
      <button ref={triggerRef} type="button" className="context-summary-trigger" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)} title="查看摘要与调整会话设置">{onToolScopeChange ? "对话设置" : view.contextSummary ? "已压缩 · 查看摘要" : "上下文设置"}</button>
      {open ? <div id={panelId} className="context-summary-panel">
        <div className="context-summary-head"><strong>{onToolScopeChange ? "对话设置" : "上下文压缩"}</strong><button type="button" className="context-summary-close" aria-label="关闭设置" onClick={() => { setOpen(false); triggerRef.current?.focus(); }}><X size={14} /></button></div>
        {onToolScopeChange && (view.toolScope == null ? <>
          <button type="button" className="secondary-button" disabled={disabled || view.status === "awaiting_confirmation" || view.status === "waiting_task"} onClick={() => onToolScopeChange("all")}>启用统一助手</button>
          <small>旧会话可以在待确认和生成任务处理完后切换，聊天记录会保留。</small>
        </> : <label>
          <span>允许使用工具</span>
          <input type="checkbox" checked={view.toolScope === "all"} disabled={disabled} onChange={event => onToolScopeChange(event.target.checked ? "all" : "conversation")} />
        </label>)}
        {onVisionChange ? <label>
          <span>允许助手看图</span>
          <input type="checkbox" checked={view.visionEnabled} disabled={disabled} onChange={event => onVisionChange(event.target.checked)} />
        </label> : null}
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
        {onAutoContinueChange && usesPlainChat(view) ? <>
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
        {onChatLimitsChange && usesPlainChat(view) ? <>
          <label>工具调用轮数<input aria-label="工具调用轮数" type="number" min={1} max={100} value={chatRounds} disabled={disabled} onChange={(event) => setChatRounds(event.target.value)} onBlur={() => saveChatLimit("chatToolRoundLimit", chatRounds, 100, view.chatToolRoundLimit ?? 16, setChatRounds)} /><span>轮</span></label>
          <label>模型调用上限<input aria-label="模型调用上限" type="number" min={1} max={1000} value={modelCalls} disabled={disabled} onChange={(event) => setModelCalls(event.target.value)} onBlur={() => saveChatLimit("chatModelCallLimit", modelCalls, 1000, view.chatModelCallLimit ?? 500, setModelCalls)} /><span>次</span></label>
          <label>处理时间上限<input aria-label="处理时间上限" type="number" min={1} max={180} value={turnMinutes} disabled={disabled} onChange={(event) => setTurnMinutes(event.target.value)} onBlur={() => saveChatLimit("chatTurnMinutes", turnMinutes, 180, view.chatTurnMinutes ?? 30, setTurnMinutes)} /><span>分钟</span></label>
          <label>本轮 token 上限<input aria-label="本轮 token 上限" type="number" min={0} max={10000000} value={tokenLimit} disabled={disabled} onChange={(event) => setTokenLimit(event.target.value)} onBlur={() => saveChatLimit("chatTokenLimit", tokenLimit, 10000000, view.chatTokenLimit ?? 0, setTokenLimit, 0)} /><span>tokens</span></label>
          <small>上限针对一条消息；达到时间后不再发起新的模型请求，已在进行的请求仍可能产生用量。PPT 分批规划和审校均计入调用次数。</small>
          <small>token 上限为 0 时关闭；按渠道返回的输入与输出用量累计，每次请求结束后检查，可能超过设定值。渠道未返回完整用量时将停止后续请求；该上限不等同于费用上限，自动压缩历史的用量不计入。</small>
        </> : null}
        {onBoardLimitsChange ? <>
          <label>单轮思考次数
            <input aria-label="单轮思考次数" type="number" min={1} max={30} step={1} disabled={disabled}
              value={roundsValue}
              onChange={(event) => setRoundsValue(event.target.value)}
              onBlur={() => saveBoardLimits("boardMaxRounds", roundsValue, 1, 30, view.boardMaxRounds ?? 10)}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
            <span>轮</span>
          </label>
          <label>自动续跑次数
            <input aria-label="自动续跑次数" type="number" min={0} max={20} step={1} disabled={disabled}
              value={autoContinueValue}
              onChange={(event) => setAutoContinueValue(event.target.value)}
              onBlur={() => saveBoardLimits("boardAutoContinueLimit", autoContinueValue, 0, 20, view.boardAutoContinueLimit ?? 3)}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
            <span>次</span>
          </label>
          <small>单轮思考次数：一条消息里模型最多连续调几次工具。自动续跑：任务跑完后最多自动接着做几次，设 0 关闭。</small>
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
