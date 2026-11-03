import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FileDown, LoaderCircle, X } from "lucide-react";
import { api } from "../api";

export function MindPptPreview({ conversationId, documentId, name, onClose }: { conversationId: string; documentId: string; name: string; onClose: () => void }) {
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof api.mindDocumentPlan>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { let active = true; void api.mindDocumentPlan(conversationId, documentId).then((value) => { if (active) setPlan(value); }).catch((e) => { if (active) setError(e instanceof Error ? e.message : "预览失败"); }); return () => { active = false; }; }, [conversationId, documentId]);
  async function save() {
    if (!plan) return false;
    setBusy(true); setError(""); setNotice("");
    try { const result = await api.saveMindDocumentPlan(conversationId, documentId, plan.slides); setPlan({ ...plan, slides: result.slides }); setDirty(false); setNotice("拆页方案已保存"); return true; }
    catch (e) { setError(e instanceof Error ? e.message : "保存失败"); return false; }
    finally { setBusy(false); }
  }
  async function downloadSource() {
    setBusy(true); setError("");
    try { await api.downloadMindSource(conversationId, documentId, name); }
    catch (e) { setError(e instanceof Error ? e.message : "下载失败"); }
    finally { setBusy(false); }
  }
  async function download() {
    if (dirty && !await save()) return;
    setBusy(true); setError("");
    try { await api.downloadMindPptx(conversationId, documentId, `${name.replace(/\.xmind$/i, "") || "思维导图"}.pptx`); }
    catch (e) { setError(e instanceof Error ? e.message : "导出失败"); }
    finally { setBusy(false); }
  }
  function close() { if (!busy && (!dirty || window.confirm("拆页方案有未保存的修改，确定关闭？"))) onClose(); }
  function updateSlide(index: number, patch: Partial<(NonNullable<typeof plan>)["slides"][number]>) {
    setPlan((current) => current ? { ...current, slides: current.slides.map((slide, i) => i === index ? { ...slide, ...patch } : slide) } : null); setDirty(true); setNotice("");
  }
  return createPortal(<div className="mind-preview-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}><section className="mind-preview-dialog" role="dialog" aria-modal="true" aria-label="XMind 转 PPT 拆页预览">
    <header><div><strong>按原结构导出 PPT</strong><small>{name} · 规则拆页；需要 AI 整理请在聊天中提出</small></div><button className="icon-button" type="button" aria-label="关闭" onClick={close} disabled={busy}><X size={18} /></button></header>
    <main>{error ? <p role="alert" className="story-review-error">{error}</p> : null}{!plan && !error ? <p><LoaderCircle className="spin" size={16} /> 正在解析拆页…</p> : null}{plan ? <><p className="mind-preview-hint">共 {plan.slides.length} 页。这里展示拆页内容，可修改每页标题和内容，实际版式以导出的 PPT 为准。</p>{plan.warnings.map((warning) => <p className="mind-preview-hint" key={warning}>{warning}</p>)}<div className="mind-preview-list">{plan.slides.map((slide, i) => <article key={i}><span>{String(i + 1).padStart(2, "0")}</span><div><label>标题<input value={slide.title} maxLength={2000} onChange={(e) => updateSlide(i, { title: e.target.value })} /></label><label>页面内容<textarea rows={Math.max(3, slide.lines.length)} value={slide.lines.join("\n")} onChange={(e) => updateSlide(i, { lines: e.target.value ? e.target.value.split("\n") : [] })} placeholder="每行一条，最多 7 行" /></label><small>最多 7 行，每行不超过 200 字；{slide.notes ? "含演讲者备注" : "无演讲者备注"}</small></div></article>)}</div></> : null}</main>
    <footer>{notice ? <span className="mind-preview-hint" role="status">{notice}</span> : null}{plan?.sourceAvailable ? <button type="button" className="secondary-button" onClick={() => void downloadSource()} disabled={busy}>下载原文件</button> : null}<button type="button" className="secondary-button" onClick={close} disabled={busy}>关闭</button><button type="button" className="secondary-button" onClick={() => void save()} disabled={!dirty || busy}>保存方案</button><button type="button" className="primary-button" onClick={() => void download()} disabled={!plan || busy}>{busy ? <LoaderCircle className="spin" size={15} /> : <FileDown size={15} />}按原结构导出</button></footer>
  </section></div>, document.body);
}
