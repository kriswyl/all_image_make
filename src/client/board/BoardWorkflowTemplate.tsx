import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { LayoutTemplate, X } from "lucide-react";
import type { BoardNode } from "../../shared/board";
import type { CanvasTemplate } from "../../shared/canvas-template";
import type { Asset } from "../../shared/types";

function TemplateDialog({ title, busy, onClose, children }: { title: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  return createPortal(<div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="modal board-template-config" role="dialog" aria-modal="true" aria-label={title}
      onKeyDown={(event) => { if (!busy && event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <header className="modal-header"><div><LayoutTemplate size={17} /><h2>{title}</h2></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose} disabled={busy}><X size={17} /></button></header>
      {children}
    </section>
  </div>, document.body);
}

export function BoardTemplateSaveDialog({ title, nodes, onSave, onClose }: {
  title: string; nodes: BoardNode[];
  onSave: (name: string, inputs: string[], outputs: string[]) => Promise<void>; onClose: () => void;
}) {
  const [name, setName] = useState(title);
  const [slots, setSlots] = useState<Record<string, "input" | "output" | "">>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      const ids = (role: "input" | "output") => nodes.filter(({ id }) => slots[id] === role).map(({ id }) => id);
      await onSave(name.trim(), ids("input"), ids("output"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "模板没有保存"); }
    finally { setBusy(false); }
  }
  return <TemplateDialog title="保存所选为流程模板" busy={busy} onClose={onClose}>
    <div className="modal-body"><label>模板名称<input autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
      <p className="board-command-empty">指定可替换输入和结果节点。生成参数、连线和分组会随模板保存。</p>
      {nodes.map((node) => <label key={node.id} className="board-template-slot"><span>{node.title || node.ref}</span>
        <select value={slots[node.id] ?? ""} onChange={(event) => setSlots((value) => ({ ...value, [node.id]: event.target.value as "input" | "output" | "" }))}>
          <option value="">普通节点</option>{node.type !== "config" ? <option value="input">可替换输入</option> : null}<option value="output">结果输出</option>
        </select></label>)}
      {error ? <p className="board-command-error" role="alert">{error}</p> : null}
    </div>
    <footer className="modal-footer"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="primary-button" disabled={busy || !name.trim()} onClick={() => void save()}>保存模板</button></footer>
  </TemplateDialog>;
}

export function BoardTemplateInputDialog({ template, assets, onImport, onClose }: {
  template: CanvasTemplate; assets: Asset[]; onClose: () => void;
  onImport: (values: Record<string, { text?: string; assetId?: string }>) => Promise<boolean>;
}) {
  const inputs = template.doc.nodes.filter((node) => node.workflowSlot === "input");
  const outputs = template.doc.nodes.filter((node) => node.workflowSlot === "output");
  const [values, setValues] = useState<Record<string, { text?: string; assetId?: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    setBusy(true);
    setError("");
    try { if (!await onImport(values)) setError("模板暂未放入画布，请检查画布保存状态"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "导入失败"); }
    finally { setBusy(false); }
  }
  return <TemplateDialog title={template.name} busy={busy} onClose={onClose}>
    <div className="modal-body">
      {inputs.map((node, index) => <label key={node.id}><span>{node.title || node.ref}</span>
        {node.type === "text" ? <textarea autoFocus={index === 0} value={values[node.id]?.text ?? node.text} maxLength={20000}
          onChange={(event) => setValues((state) => ({ ...state, [node.id]: { text: event.target.value } }))} />
          : <select value={values[node.id]?.assetId ?? ""} onChange={(event) => setValues((state) => ({ ...state, [node.id]: { assetId: event.target.value || undefined } }))}>
            <option value="">导入后在节点选择素材</option>
            {assets.filter((asset) => asset.mimeType.startsWith(`${node.type}/`)).map((asset) => <option key={asset.id} value={asset.id}>{asset.title || asset.fileName}</option>)}
          </select>}
      </label>)}
      {outputs.length ? <p className="board-command-empty">结果节点 · {outputs.map((node) => node.title || node.ref).join("、")}</p> : null}
      {error ? <p className="board-command-error" role="alert">{error}</p> : null}
    </div>
    <footer className="modal-footer"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>取消</button>
      <button type="button" className="primary-button" disabled={busy} onClick={() => void submit()}>放入画布</button></footer>
  </TemplateDialog>;
}
