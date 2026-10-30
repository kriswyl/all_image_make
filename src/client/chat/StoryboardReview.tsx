import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Check, LayoutGrid, LoaderCircle, Plus, Trash2, X } from "lucide-react";
import { api } from "../api";
import type { StoryboardProject, StoryboardProjectData } from "../../shared/storyboard-project";
import type { Asset } from "../../shared/types";
import { StoryboardPreview } from "./StoryboardPreview";

type Shot = StoryboardProjectData["shots"][number];
const emptyShot = (): Shot => ({ id: crypto.randomUUID(), prompt: "", duration: 5, character: "", scene: "", characterVersions: {}, sceneVersionId: "", props: "", propVersions: {}, sourceText: "", dialogue: "", speaker: "", shotSize: "", cameraMove: "", videoPrompt: "", soundEffect: "" });

export function StoryboardReview({ id, onClose, onToast, onImport }: {
  id: string; onClose: () => void; onToast?: (kind: "ok" | "error", text: string) => void;
  onImport: (id: string, name: string, description?: string) => void;
}) {
  const [project, setProject] = useState<StoryboardProject | null>(null);
  const [data, setData] = useState<StoryboardProjectData | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(0);
  const [sceneFilter, setSceneFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [splitSuggestion, setSplitSuggestion] = useState<{ shotId: string; shots: Array<{ prompt: string; videoPrompt: string; dialogue: string; sourceText: string; shotSize: string; cameraMove: string }> } | null>(null);
  const [picker, setPicker] = useState<{ kind: "characters" | "scenes" | "props"; index: number; variantId?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api.storyboardProject(id).then((value) => { if (!cancelled) { setProject(value); setData(value.data); setSelected(new Set(value.data.shots.slice(0, 30).map((shot) => shot.id))); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "加载分镜失败"); });
    return () => { cancelled = true; };
  }, [id]);
  const close = () => { if (!busy && (!dirty || window.confirm("还有未保存的修改，确定关闭？"))) onClose(); };
  useEffect(() => { const handle = (event: KeyboardEvent) => { if (event.key === "Escape") { if (previewOpen) setPreviewOpen(false); else if (picker) setPicker(null); else close(); } }; window.addEventListener("keydown", handle); return () => window.removeEventListener("keydown", handle); });
  function change(next: StoryboardProjectData) { setData(next); setDirty(true); }
  function changeShot(index: number, patch: Partial<Shot>) { if (!data) return; change({ ...data, shots: data.shots.map((shot, i) => i === index ? { ...shot, ...patch } : shot) }); }
  function move(index: number, delta: number) {
    if (!data || index + delta < 0 || index + delta >= data.shots.length) return;
    const shots = [...data.shots]; [shots[index], shots[index + delta]] = [shots[index + delta]!, shots[index]!];
    change({ ...data, shots }); setActive(index + delta);
  }
  function remove(index: number) {
    if (!data || data.shots.length <= 1 || !window.confirm("删除这个镜头？保存后生效，已导入的画布不受影响。")) return;
    const removed = data.shots[index]!; change({ ...data, shots: data.shots.filter((_, i) => i !== index) });
    setSelected((old) => { const next = new Set(old); next.delete(removed.id); return next; }); setActive(Math.max(0, Math.min(index, data.shots.length - 2)));
  }
  async function save(): Promise<StoryboardProject | null> {
    if (!project || !data) return null;
    if (data.shots.some((shot) => !shot.prompt.trim())) { setError("请填写每个镜头的首帧画面描述。"); return null; }
    const saved = await api.saveStoryboardProject(id, project.revision, data);
    setProject(saved); setData(saved.data); setDirty(false); setError(""); return saved;
  }
  async function persist(importAfter: boolean) {
    if (!project || !data || busy) return;
    if (importAfter && (!selected.size || selected.size > 30)) { setError("请选择 1 至 30 个镜头导入。"); return; }
    if (importAfter) {
      const roles = new Set(data.characters.map((item) => item.name.trim()));
      const scenes = new Set(data.scenes.map((item) => item.name.trim()));
      const props = new Set(data.props.map((item) => item.name.trim()));
      const missing = data.shots.flatMap((item, index) => {
        if (!selected.has(item.id)) return [];
        const names = item.character.split(/[、,，]/).map((value) => value.trim()).filter((value) => value && !roles.has(value));
        if (item.scene.trim() && !scenes.has(item.scene.trim())) names.push(item.scene.trim());
        names.push(...item.props.split(/[、,，]/).map((value) => value.trim()).filter((value) => value && !props.has(value)));
        return names.length ? [`镜头 ${index + 1}：${names.join("、")}`] : [];
      });
      if (missing.length && !window.confirm(`以下角色、场景或道具没有匹配的设定，导入时不会自动连参考图：\n${missing.join("\n")}\n\n仍然导入？`)) return;
    }
    setBusy(true); setError("");
    try {
      const saved = dirty ? await save() : project;
      if (!saved) return;
      if (importAfter) {
        const template = await api.storyboardSelectionTemplate(id, saved.revision, [...selected]);
        onImport(template.id, template.name, template.description); onClose();
      } else onToast?.("ok", "分镜已保存，已有画布不会自动改动");
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); }
    finally { setBusy(false); }
  }
  async function suggestSplit() {
    if (!project || !data || busy) return;
    if (dirty) { setError("请先保存当前修改，再请求拆分建议。"); return; }
    const current = data.shots[active];
    if (!current || data.shots.length >= 60) return;
    setBusy(true); setError(""); setSplitSuggestion(null);
    try { const result = await api.splitStoryboardShot(id, project.revision, current.id); setSplitSuggestion({ shotId: current.id, shots: result.shots }); }
    catch (e) { setError(e instanceof Error ? e.message : "拆分建议生成失败"); }
    finally { setBusy(false); }
  }
  function applySplit() {
    if (!data || !splitSuggestion || data.shots.length >= 60) return;
    if (dirty) { setError("分镜已有未保存修改，请先保存并重新生成拆分建议。"); return; }
    const index = data.shots.findIndex((item) => item.id === splitSuggestion.shotId);
    if (index < 0) return;
    const original = data.shots[index]!;
    const replacements = splitSuggestion.shots.map((draft, i) => ({ ...original, ...draft, id: i === 0 ? original.id : crypto.randomUUID(), duration: Math.max(0.5, original.duration / 2), sourceText: draft.sourceText || original.sourceText }));
    change({ ...data, shots: [...data.shots.slice(0, index), ...replacements, ...data.shots.slice(index + 1)] });
    setSelected((old) => { const next = new Set(old); if (old.has(original.id)) next.add(replacements[1]!.id); return next; });
    setActive(index); setSplitSuggestion(null);
  }
  const shot = data?.shots[active];
  return createPortal(<div className="story-review-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section className="story-review" role="dialog" aria-modal="true" aria-label="分镜审阅">
      <header className="story-review-header"><div><strong>分镜审阅</strong><small>先核对和编辑，再选择镜头导入；不会自动生成素材。</small></div><button className="icon-button" aria-label="关闭" onClick={close} disabled={busy}><X size={18} /></button></header>
      {!data ? <div className="story-review-loading">{error || <><LoaderCircle className="spin" size={18} /> 正在加载分镜…</>}</div> : <>
        <div className="story-review-body">
          <aside className="story-review-sidebar">
            <div className="story-review-filter"><strong>{data.shots.length} 个镜头</strong><select value={sceneFilter} onChange={(e) => setSceneFilter(e.target.value)} aria-label="筛选场景"><option value="">全部场景</option>{[...new Set(data.shots.map((item) => item.scene).filter(Boolean))].map((scene) => <option key={scene}>{scene}</option>)}</select></div>
            <div className="story-review-select"><button type="button" onClick={() => setSelected(new Set(data.shots.filter((item) => !sceneFilter || item.scene === sceneFilter).slice(0, 30).map((item) => item.id)))}>选择当前（前 30）</button><button type="button" onClick={() => setSelected(new Set())}>清空</button><span>已选 {selected.size}/30</span></div>
            <div className="story-review-list">{data.shots.map((item, index) => !sceneFilter || item.scene === sceneFilter ? <div className={`story-review-shot ${active === index ? "active" : ""}`} key={item.id}>
              <input type="checkbox" checked={selected.has(item.id)} aria-label={`选择第 ${index + 1} 镜`} onChange={(e) => setSelected((old) => { const next = new Set(old); if (e.target.checked) next.add(item.id); else next.delete(item.id); return next; })} />
              <button type="button" onClick={() => setActive(index)}><strong>第 {index + 1} 镜 · {item.scene || "未标场景"}</strong><span>{item.prompt || "待填写画面"}</span></button>
            </div> : null)}</div>
            <button type="button" className="secondary-button compact" disabled={data.shots.length >= 60} onClick={() => { const item = emptyShot(); change({ ...data, shots: [...data.shots, item] }); setActive(data.shots.length); setSceneFilter(""); }}><Plus size={14} />新增镜头</button>
          </aside>
          <main className="story-review-main">
            <label>项目名称<input value={data.name} onChange={(e) => change({ ...data, name: e.target.value })} maxLength={80} /></label>
            <details className="story-review-settings"><summary>创作目标与拆镜参数</summary>
              <div className="story-review-fields" style={{ marginTop: 12 }}>{([ ["contentType", "内容类型"], ["duration", "目标时长"], ["aspectRatio", "画面比例"], ["style", "视觉风格"], ["density", "拆镜密度"], ["fidelity", "原文处理要求"] ] as const).map(([field, label]) => <label key={field}>{label}<input value={data.brief[field]} onChange={(e) => change({ ...data, brief: { ...data.brief, [field]: e.target.value } })} /></label>)}</div>
              <small>用于记录和核对创作目标；修改后不会自动重写已生成的镜头。</small>
            </details>
            <details className="story-review-settings"><summary>角色设定（{data.characters.length}）与场景设定（{data.scenes.length}）与道具设定（{data.props.length}）</summary>
              {(["characters", "scenes", "props"] as const).map((kind) => <div className="story-review-setting-group" key={kind}><strong>{kind === "characters" ? "角色" : kind === "scenes" ? "场景" : "道具"}</strong>{data[kind].map((item, index) => <div className="story-setting-block" key={index}>
              <div className="story-review-setting">
                <input aria-label={kind === "characters" ? "角色名称" : kind === "scenes" ? "场景名称" : "道具名称"} value={item.name} onChange={(e) => change({ ...data, [kind]: data[kind].map((entry, i) => i === index ? { ...entry, name: e.target.value } : entry) })} />
                <textarea aria-label="设定描述" value={item.prompt} onChange={(e) => change({ ...data, [kind]: data[kind].map((entry, i) => i === index ? { ...entry, prompt: e.target.value } : entry) })} />
                <div className="story-reference-actions">{item.assetId ? <img src={api.assetUrl(`/api/assets/${item.assetId}/thumb`)} onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = api.assetUrl(`/api/assets/${item.assetId}/file`); }} alt={`${item.name}参考图`} /> : null}<button type="button" className="secondary-button compact" onClick={() => setPicker({ kind, index })}>{item.assetId ? "更换参考图" : "选择参考图"}</button>{item.assetId ? <button type="button" className="link-btn" onClick={() => change({ ...data, [kind]: data[kind].map((entry, i) => i === index ? { ...entry, assetId: null } : entry) })}>解除</button> : null}</div>
                <button type="button" className="icon-button danger" title="删除设定" onClick={() => { if (window.confirm("删除此设定？引用它的镜头不会自动连接参考图。")) change({ ...data, [kind]: data[kind].filter((_, i) => i !== index) }); }}><Trash2 size={14} /></button>
              </div>
              {item.variants.map((version) => <div className="story-review-setting story-variant" key={version.id}>
                <input aria-label="版本名称" placeholder="如雨夜装 / 夜景" value={version.name} onChange={(e) => change({ ...data, [kind]: data[kind].map((entry, i) => i === index ? { ...entry, variants: entry.variants.map((v) => v.id === version.id ? { ...v, name: e.target.value } : v) } : entry) })} />
                <textarea aria-label="版本描述" placeholder="描述与默认设定的差异" value={version.prompt} onChange={(e) => change({ ...data, [kind]: data[kind].map((entry, i) => i === index ? { ...entry, variants: entry.variants.map((v) => v.id === version.id ? { ...v, prompt: e.target.value } : v) } : entry) })} />
                <div className="story-reference-actions">{version.assetId ? <img src={api.assetUrl(`/api/assets/${version.assetId}/file`)} alt={`${version.name}参考图`} /> : null}<button type="button" className="secondary-button compact" onClick={() => setPicker({ kind, index, variantId: version.id })}>{version.assetId ? "更换参考图" : "选择参考图"}</button>{version.assetId ? <button type="button" className="link-btn" onClick={() => change({ ...data, [kind]: data[kind].map((entry, i) => i === index ? { ...entry, variants: entry.variants.map((v) => v.id === version.id ? { ...v, assetId: null } : v) } : entry) })}>解除</button> : null}</div>
                <button type="button" className="icon-button danger" title="删除版本" onClick={() => { if (!window.confirm("删除这个版本并将使用它的镜头切回默认设定？")) return; const shots = data.shots.map((shot) => kind === "scenes" && shot.scene === item.name && shot.sceneVersionId === version.id ? { ...shot, sceneVersionId: "" } : kind === "characters" && shot.characterVersions[item.name] === version.id ? { ...shot, characterVersions: Object.fromEntries(Object.entries(shot.characterVersions).filter(([key]) => key !== item.name)) } : kind === "props" && shot.propVersions[item.name] === version.id ? { ...shot, propVersions: Object.fromEntries(Object.entries(shot.propVersions).filter(([key]) => key !== item.name)) } : shot); change({ ...data, shots, [kind]: data[kind].map((entry, i) => i === index ? { ...entry, variants: entry.variants.filter((v) => v.id !== version.id) } : entry) }); }}><Trash2 size={14} /></button>
              </div>)}
              <button type="button" className="link-btn" disabled={item.variants.length >= 12} onClick={() => change({ ...data, [kind]: data[kind].map((entry, i) => i === index ? { ...entry, variants: [...entry.variants, { id: crypto.randomUUID(), name: `版本${entry.variants.length + 1}`, prompt: "", assetId: null }] } : entry) })}><Plus size={13} />添加{kind === "characters" ? "服装 / 状态" : kind === "scenes" ? "昼夜 / 场景" : "道具"}版本</button>
              </div>)}<button type="button" className="secondary-button compact" disabled={data[kind].length >= 12} onClick={() => change({ ...data, [kind]: [...data[kind], { name: kind === "characters" ? "新角色" : kind === "scenes" ? "新场景" : "新道具", prompt: "", assetId: null, variants: [] }] })}><Plus size={13} />添加{kind === "characters" ? "角色" : kind === "scenes" ? "场景" : "道具"}</button></div>)}
              <small>镜头里的角色和场景名称须与设定名称一致；修改名称后请同步检查镜头。</small>
            </details>
            {shot ? <><div className="story-review-editor-head"><strong>第 {active + 1} 镜</strong><div><button type="button" className="secondary-button compact" disabled={busy || data.shots.length >= 60} onClick={() => void suggestSplit()}>AI 拆成两镜</button><button type="button" className="icon-button" title="上移" disabled={active === 0} onClick={() => move(active, -1)}><ArrowUp size={16} /></button><button type="button" className="icon-button" title="下移" disabled={active === data.shots.length - 1} onClick={() => move(active, 1)}><ArrowDown size={16} /></button><button type="button" className="icon-button danger" title="删除镜头" disabled={data.shots.length <= 1} onClick={() => remove(active)}><Trash2 size={16} /></button></div></div>
              {splitSuggestion?.shotId === shot.id ? <div className="story-split-suggestion"><strong>拆分建议（应用前请核对台词与画面）</strong>{splitSuggestion.shots.map((draft, i) => <article key={i}><b>建议镜头 {i + 1}</b><p>画面：{draft.prompt}</p><p>视频：{draft.videoPrompt || "未填写"}</p><p>台词：{draft.dialogue || "无"}</p><p>原文：{draft.sourceText || "未提供"}</p></article>)}<div><button type="button" className="secondary-button compact" onClick={() => setSplitSuggestion(null)}>放弃建议</button><button type="button" className="primary-button compact" onClick={applySplit}>应用并继续编辑</button></div></div> : null}
              <div className="story-review-fields">
                {([ ["scene", "场景"], ["character", "角色（多人用、分隔）"], ["props", "道具（多个用、分隔）"], ["shotSize", "景别"], ["cameraMove", "运镜"], ["speaker", "说话人"] ] as const).map(([field, label]) => <label key={field}>{label}<input value={shot[field]} onChange={(e) => changeShot(active, field === "scene" ? { scene: e.target.value, sceneVersionId: "" } : { [field]: e.target.value })} /></label>)}
                {shot.character.split(/[、,，]/).map((name) => name.trim()).filter(Boolean).map((name) => { const setting = data.characters.find((item) => item.name === name); return setting?.variants.length ? <label key={name}>{name}的版本<select value={shot.characterVersions[name] ?? ""} onChange={(e) => changeShot(active, { characterVersions: { ...shot.characterVersions, [name]: e.target.value } })}><option value="">默认设定</option>{setting.variants.map((v) => <option value={v.id} key={v.id}>{v.name}</option>)}</select></label> : null; })}
                {shot.props.split(/[、,，]/).map((name) => name.trim()).filter(Boolean).map((name) => { const setting = data.props.find((item) => item.name === name); return setting?.variants.length ? <label key={name}>{name}的版本<select value={shot.propVersions[name] ?? ""} onChange={(e) => changeShot(active, { propVersions: { ...shot.propVersions, [name]: e.target.value } })}><option value="">默认设定</option>{setting.variants.map((v) => <option value={v.id} key={v.id}>{v.name}</option>)}</select></label> : null; })}
                {data.scenes.find((item) => item.name === shot.scene)?.variants.length ? <label>场景版本<select value={shot.sceneVersionId} onChange={(e) => changeShot(active, { sceneVersionId: e.target.value })}><option value="">默认设定</option>{data.scenes.find((item) => item.name === shot.scene)?.variants.map((v) => <option value={v.id} key={v.id}>{v.name}</option>)}</select></label> : null}
                <label>预估时长（秒）<input type="number" min="0.5" max="120" step="0.5" value={shot.duration} onChange={(e) => changeShot(active, { duration: Math.max(0.5, Math.min(120, Number(e.target.value) || 0.5)) })} /></label>
                {([ ["sourceText", "对应原文"], ["prompt", "首帧画面 / 图片提示词"], ["videoPrompt", "动作与运镜 / 视频提示词"], ["dialogue", "台词或旁白"], ["soundEffect", "声音提示"] ] as const).map(([field, label]) => <label className="wide" key={field}>{label}<textarea value={shot[field]} onChange={(e) => changeShot(active, { [field]: e.target.value })} rows={field === "prompt" || field === "videoPrompt" ? 3 : 2} /></label>)}
              </div>
            </> : null}
          </main>
        </div>
        <footer className="story-review-footer"><span>{error ? <span role="alert" className="story-review-error">{error}</span> : dirty ? "有未保存的修改" : "修改不会自动覆盖已导入的画布"}</span><button type="button" className="secondary-button" disabled={busy} onClick={() => setPreviewOpen(true)}>粗剪预览 / 导出</button><button type="button" className="secondary-button" disabled={busy || !dirty} onClick={() => void persist(false)}><Check size={15} />保存</button><button type="button" className="primary-button" disabled={busy || !selected.size || selected.size > 30} onClick={() => void persist(true)}>{busy ? <LoaderCircle className="spin" size={15} /> : <LayoutGrid size={15} />}保存并导入所选镜头</button></footer>
      </>}
    </section>
    {previewOpen && data ? <StoryboardPreview id={id} data={data} onClose={() => setPreviewOpen(false)} /> : null}
    {picker && data ? <StoryboardReferencePicker onClose={() => setPicker(null)} onChoose={(asset) => { change({ ...data, [picker.kind]: data[picker.kind].map((entry, i) => i !== picker.index ? entry : picker.variantId ? { ...entry, variants: entry.variants.map((v) => v.id === picker.variantId ? { ...v, assetId: asset.id } : v) } : { ...entry, assetId: asset.id }) }); setPicker(null); }} /> : null}
  </div>, document.body);
}

function StoryboardReferencePicker({ onClose, onChoose }: { onClose: () => void; onChoose: (asset: Asset) => void }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Asset[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(""); setItems([]); setOffset(0); setHasMore(false);
    const timer = window.setTimeout(() => { void api.libraryPage({ query, kind: "image", mode: "assets" }).then((page) => {
      if (!cancelled) { setItems(page.items.flatMap((task) => task.assets.filter((asset) => asset.mimeType.startsWith("image/")))); setOffset(page.items.length); setHasMore(page.hasMore); }
    }).catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "素材加载失败"); }).finally(() => { if (!cancelled) setLoading(false); }); }, query ? 250 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query]);
  async function more() {
    if (loading) return; setLoading(true);
    try { const page = await api.libraryPage({ query, kind: "image", mode: "assets", offset }); setItems((current) => [...current, ...page.items.flatMap((task) => task.assets.filter((asset) => asset.mimeType.startsWith("image/")))]); setOffset((current) => current + page.items.length); setHasMore(page.hasMore); }
    catch (e) { setError(e instanceof Error ? e.message : "加载失败"); } finally { setLoading(false); }
  }
  return <div className="story-reference-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <section className="story-reference-picker" role="dialog" aria-modal="true" aria-label="选择设定参考图">
      <header><strong>选择设定参考图</strong><button type="button" className="icon-button" aria-label="关闭素材选择" onClick={onClose}><X size={16} /></button></header>
      <p>选择公共素材库中的单张图片；保存分镜后会在导入画布时自动复用。</p>
      <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜索参考图" placeholder="搜索素材名称或提示词" />
      <div className="story-reference-grid">{items.map((asset) => <button key={asset.id} type="button" onClick={() => onChoose(asset)} title={asset.title || asset.fileName}><img src={api.assetUrl(asset.thumbUrl || asset.url)} onError={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = api.assetUrl(asset.url); }} alt="" /><span>{asset.title || asset.fileName}</span></button>)}{!loading && !items.length && !error ? <p>没有找到图片，可先在素材管理或画布中上传。</p> : null}</div>
      {error ? <span className="story-review-error" role="alert">{error}</span> : null}
      {hasMore ? <button type="button" className="secondary-button" disabled={loading} onClick={() => void more()}>加载更多</button> : null}
      {loading ? <span><LoaderCircle className="spin" size={14} /> 加载中…</span> : null}
    </section>
  </div>;
}
