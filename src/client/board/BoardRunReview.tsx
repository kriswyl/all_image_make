import { useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, ListChecks, X } from "lucide-react";
import type { BoardRunStep } from "./board-run";

export function BoardRunReview({ steps, onStart, onClose }: { steps: BoardRunStep[]; onStart: (steps: BoardRunStep[], concurrency: number) => void; onClose: () => void }) {
  const [order, setOrder] = useState(steps);
  const [concurrency, setConcurrency] = useState(2);
  const total = order.reduce((sum, step) => sum + step.requestCount, 0);
  const missing = order.some((step) => step.kind !== "text" && !step.channelId);
  return createPortal(<div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="modal board-template-config" role="dialog" aria-modal="true" aria-label="核对运行计划"
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <header className="modal-header"><div><ListChecks size={17} /><h2>核对运行计划</h2></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={17} /></button></header>
      <div className="modal-body">
        <p className="board-command-empty">{order.length} 个节点，最多 {total} 次生成请求。请确认模型和渠道，实际费用以渠道为准。参考视频可能上传至所用渠道。</p>
        <label className="board-template-slot"><span>每渠道同时运行的节点</span><select autoFocus value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))}>
          {[1, 2, 4].map((count) => <option key={count} value={count}>{count} 项</option>)}</select></label>
        <div className="board-run-review-list">{order.map((step, index) => <article key={step.nodeId}>
          <div><strong>{step.title}</strong><small>{step.modelLabel ?? (step.kind === "text" ? "画布助手的对话模型" : "未配置对应模型")}{step.channelName ? ` · ${step.channelName}` : ""} · {step.requestCount} 次{step.dependencies.length ? ` · 等待 ${step.dependencies.length} 项上游` : ""}</small></div>
          <button type="button" className="icon-button" aria-label={`提高 ${step.title} 的优先级`} title="提高优先级，仍会等待上游" disabled={index === 0} onClick={() => {
            setOrder((current) => { const next = [...current]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; return next; });
          }}><ArrowUp size={14} /></button>
        </article>)}</div>
        {missing ? <p className="board-command-error" role="alert">请先配置缺少模型的节点。</p> : null}
      </div>
      <footer className="modal-footer"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={missing} onClick={() => onStart(order, concurrency)}>确认并运行</button></footer>
    </section>
  </div>, document.body);
}
