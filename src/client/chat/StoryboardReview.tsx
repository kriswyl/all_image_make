import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowUp, Check, LayoutGrid, LoaderCircle, Plus, Trash2, X } from "lucide-react";
import { api } from "../api";
import { confirmGeneration } from "../generation-confirm";
import { OPENAI_SIZE_PRESETS } from "../../shared/image-sizes";
import { defaultImageDraft, imageGenerationParameters, type ImageDraft } from "./storyboard-image-params";
import { statusLabels, terminalStatuses } from "../task-ui";
import { assembleStoryboardPrompt, type StoryboardProject, type StoryboardProjectData } from "../../shared/storyboard-project";
import type { Asset, Task } from "../../shared/types";
import { StoryboardPreview } from "./StoryboardPreview";
import { StylePresetPicker } from "./StylePresetPicker";
import { applyStyleSuffix, stripStyleSuffix, type StylePreset } from "../../shared/style-presets";
import { replacePromptClause } from "../../shared/prompt-clauses";

type Shot = StoryboardProjectData["shots"][number];
const emptyShot = (): Shot => ({ id: crypto.randomUUID(), prompt: "", duration: 5, character: "", scene: "", characterVersions: {}, sceneVersionId: "", props: "", propVersions: {}, sourceText: "", dialogue: "", speaker: "", shotSize: "", cameraMove: "", videoPrompt: "", soundEffect: "", finalImagePrompt: "", finalVideoPrompt: "" });

export function StoryboardReview({ id, onClose, onToast, onImport }: {
  id: string; onClose: () => void; onToast?: (kind: "ok" | "error", text: string) => void;
  onImport: (id: string, name: string, description?: string) => void;
}) {
  const [project, setProject] = useState<StoryboardProject | null>(null);
  const [data, setData] = useState<StoryboardProjectData | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(0);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [sceneFilter, setSceneFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [stylePresets, setStylePresets] = useState<StylePreset[]>([]);
  const [splitSuggestion, setSplitSuggestion] = useState<{ shotId: string; shots: Array<{ prompt: string; videoPrompt: string; dialogue: string; sourceText: string; shotSize: string; cameraMove: string }> } | null>(null);
  const [generator, setGenerator] = useState<{ kind: "characters" | "scenes" | "props"; index: number } | null>(null);
  const [picker, setPicker] = useState<{ kind: "characters" | "scenes" | "props"; index: number; variantId?: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api.storyboardProject(id).then((value) => { if (!cancelled) { setProject(value); setData(value.data); setSelected(new Set(value.data.shots.slice(0, 30).map((shot) => shot.id))); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "加载分镜失败"); });
    return () => { cancelled = true; };
  }, [id]);
  const close = () => { if (!busy && (!dirty || window.confirm("还有未保存的修改，确定关闭？"))) onClose(); };
  useEffect(() => { const handle = (event: KeyboardEvent) => { if (event.key === "Escape") { if (generator) return; if (previewOpen) setPreviewOpen(false); else if (picker) setPicker(null); else close(); } }; window.addEventListener("keydown", handle); return () => window.removeEventListener("keydown", handle); });
  function change(next: StoryboardProjectData) { setData(next); setDirty(true); }
  /** 套用/清除风格模板：先按上一套的原文剥掉，再拼新的，来回切不会越拼越长 */
  function applyStylePreset(preset: StylePreset | null) {
    if (!data) return;
    const previousName = data.brief.style?.trim() ?? "";
    const previous = previousName ? stylePresets.find((item) => item.name === previousName)?.prompt : undefined;
    const suffix = preset?.prompt ?? "";
    change({
      ...data,
      brief: { ...data.brief, style: preset?.name ?? "" },
      shots: data.shots.map((shot) => ({
        ...shot,
        prompt: suffix
          ? applyStyleSuffix(shot.prompt, { prompt: suffix }, previous)
          : stripStyleSuffix(shot.prompt, previous),
      })),
    });
  }
  function changeShot(index: number, patch: Partial<Shot>) { if (!data) return; change({ ...data, shots: data.shots.map((shot, i) => i === index ? { ...shot, ...patch } : shot) }); }
  function move(index: number, delta: number) {
    if (!data || index + delta < 0 || index + delta >= data.shots.length) return;
    const shots = [...data.shots]; [shots[index], shots[index + delta]] = [shots[index + delta]!, shots[index]!];
    change({ ...data, shots }); setActive(index + delta);
  }
  /**
   * 改景别 / 运镜时顺手把对应片段写进提示词。
   *
   * 以前这两个字段只在「生成模板」那一刻才拼进去，审阅里改了看不出效果；
   * 现在改完立刻体现在 prompt（景别）和 videoPrompt（景别 / 运镜）里，
   * 主体、场景、台词一个字都不动。
   */
  function changeShotField(index: number, field: string, value: string) {
    if (!data) return;
    const shot = data.shots[index];
    if (!shot) return;
    if (field === "shotSize") {
      changeShot(index, {
        shotSize: value,
        prompt: replacePromptClause(shot.prompt, "景别", value),
        ...(shot.videoPrompt.trim() ? { videoPrompt: replacePromptClause(shot.videoPrompt, "景别", value) } : {}),
      });
      return;
    }
    if (field === "cameraMove") {
      changeShot(index, {
        cameraMove: value,
        ...(shot.videoPrompt.trim() ? { videoPrompt: replacePromptClause(shot.videoPrompt, "运镜", value) } : {}),
      });
      return;
    }
    changeShot(index, { [field]: value });
  }
  function remove(index: number) {
    if (!data || data.shots.length <= 1 || !window.confirm("删除这个镜头？保存后生效，已导入的画布不受影响。")) return;
    const removed = data.shots[index]!; change({ ...data, shots: data.shots.filter((_, i) => i !== index) });
    setSelected((old) => { const next = new Set(old); next.delete(removed.id); return next; }); setActive(Math.max(0, Math.min(index, data.shots.length - 2)));
  }
  async function syncToCanvas() {
    if (!project || !data || busy) return;
    setBusy(true); setError("");
    try {
      const saved = dirty ? await save() : project;
      if (!saved) return;
      const result = await api.syncStoryboardCanvas(id);
      onToast?.("ok", result.nodes
        ? `已同步 ${result.nodes} 个画布节点${result.conflicts.length ? `；${result.conflicts.length} 块画布刚被改过，已跳过` : ""}`
        : "画布上没有需要更新的节点");
    } catch (e) { setError(e instanceof Error ? e.message : "同步失败"); }
    finally { setBusy(false); }
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
        <nav className="story-steps" aria-label="分镜制作步骤">
          {([ [1, "确认镜头", `${data.shots.length} 个镜头`], [2, "准备资产", `${[...data.characters, ...data.scenes, ...data.props].filter((item) => item.assetId).length}/${data.characters.length + data.scenes.length + data.props.length} 已有参考图`], [3, "合成提示词", `${data.shots.filter((item) => item.finalImagePrompt && item.finalVideoPrompt).length}/${data.shots.length} 已合成`] ] as const).map(([number, title, detail]) => <button type="button" key={number} className={step === number ? "active" : ""} onClick={() => setStep(number)} aria-current={step === number ? "step" : undefined}><b>{number}</b><span><strong>{title}</strong><small>{detail}</small></span></button>)}
        </nav>
        <div className="story-review-body" style={{ display: step === 1 ? undefined : "none" }}>
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
            <div className="story-review-style">
              <span>风格模板<small>套用到全部镜头的提示词末尾</small></span>
              <StylePresetPicker value="" valueName={data.brief.style} onPresets={setStylePresets}
                onChange={applyStylePreset}
                toast={(kind, text) => onToast?.(kind === "success" ? "ok" : "error", text)} />
            </div>
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
                {([ ["scene", "场景"], ["character", "角色（多人用、分隔）"], ["props", "道具（多个用、分隔）"], ["shotSize", "景别"], ["cameraMove", "运镜"], ["speaker", "说话人"] ] as const).map(([field, label]) => <label key={field}>{label}<input value={shot[field]} onChange={(e) => (field === "scene" ? changeShot(active, { scene: e.target.value, sceneVersionId: "" }) : changeShotField(active, field, e.target.value))} /></label>)}
                {shot.character.split(/[、,，]/).map((name) => name.trim()).filter(Boolean).map((name) => { const setting = data.characters.find((item) => item.name === name); return setting?.variants.length ? <label key={name}>{name}的版本<select value={shot.characterVersions[name] ?? ""} onChange={(e) => changeShot(active, { characterVersions: { ...shot.characterVersions, [name]: e.target.value } })}><option value="">默认设定</option>{setting.variants.map((v) => <option value={v.id} key={v.id}>{v.name}</option>)}</select></label> : null; })}
                {shot.props.split(/[、,，]/).map((name) => name.trim()).filter(Boolean).map((name) => { const setting = data.props.find((item) => item.name === name); return setting?.variants.length ? <label key={name}>{name}的版本<select value={shot.propVersions[name] ?? ""} onChange={(e) => changeShot(active, { propVersions: { ...shot.propVersions, [name]: e.target.value } })}><option value="">默认设定</option>{setting.variants.map((v) => <option value={v.id} key={v.id}>{v.name}</option>)}</select></label> : null; })}
                {data.scenes.find((item) => item.name === shot.scene)?.variants.length ? <label>场景版本<select value={shot.sceneVersionId} onChange={(e) => changeShot(active, { sceneVersionId: e.target.value })}><option value="">默认设定</option>{data.scenes.find((item) => item.name === shot.scene)?.variants.map((v) => <option value={v.id} key={v.id}>{v.name}</option>)}</select></label> : null}
                <label>预估时长（秒）<input type="number" min="0.5" max="120" step="0.5" value={shot.duration} onChange={(e) => changeShot(active, { duration: Math.max(0.5, Math.min(120, Number(e.target.value) || 0.5)) })} /></label>
                {([ ["sourceText", "对应原文"], ["prompt", "首帧画面 / 图片提示词"], ["videoPrompt", "动作与运镜 / 视频提示词"], ["dialogue", "台词或旁白"], ["soundEffect", "声音提示"] ] as const).map(([field, label]) => <label className="wide" key={field}>{label}<textarea value={shot[field]} onChange={(e) => changeShot(active, { [field]: e.target.value })} rows={field === "prompt" || field === "videoPrompt" ? 3 : 2} /></label>)}
              </div>
            </> : null}
          </main>
        </div>
        {step === 2 ? <main className="story-stage-content story-review-main">
          <div className="story-stage-intro"><div><h2>准备资产</h2><p>整理角色、场景和道具，可生成参考图或从素材库选择。没有参考图也可以继续。</p></div><span>全局风格：{data.brief.style || "未指定"}</span></div>
          {([ ["characters", "角色"], ["scenes", "场景"], ["props", "道具"] ] as const).map(([kind, label]) => <section className="story-asset-section" key={kind}><h3>{label} <small>{data[kind].length}</small></h3><div className="story-asset-grid">
            {data[kind].map((item, index) => <article className="story-asset-card" key={`${kind}-${index}`}>
              <button type="button" className="story-asset-image" onClick={() => setPicker({ kind, index })}>{item.assetId ? <img src={api.assetUrl(`/api/assets/${item.assetId}/file`)} alt={`${item.name}参考图`} /> : <span>＋<br />选择参考图</span>}</button>
              <input aria-label={`${label}名称`} value={item.name} onChange={(e) => change({ ...data, [kind]: data[kind].map((entry, i) => i === index ? { ...entry, name: e.target.value } : entry) })} />
              <textarea aria-label={`${label}描述`} placeholder="填写设定描述" rows={3} value={item.prompt} onChange={(e) => change({ ...data, [kind]: data[kind].map((entry, i) => i === index ? { ...entry, prompt: e.target.value } : entry) })} />
              <div className="story-asset-actions"><button type="button" onClick={() => setPicker({ kind, index })}>{item.assetId ? "更换图片" : "选择图片"}</button><button type="button" onClick={() => setGenerator({ kind, index })}>{item.assetId ? "重新生成" : "生成参考图"}</button>{item.assetId ? <button type="button" onClick={() => change({ ...data, [kind]: data[kind].map((entry, i) => i === index ? { ...entry, assetId: null } : entry) })}>解除</button> : null}<button type="button" onClick={() => { if (window.confirm("删除此设定？引用它的镜头不会自动连接参考图。")) change({ ...data, [kind]: data[kind].filter((_, i) => i !== index) }); }}>删除</button></div>
            </article>)}
            <button type="button" className="story-asset-add" disabled={data[kind].length >= 12} onClick={() => change({ ...data, [kind]: [...data[kind], { name: `新${label}${data[kind].length + 1}`, prompt: "", assetId: null, variants: [] }] })}><Plus size={20} />添加{label}</button>
          </div></section>)}
          <p className="story-stage-note">设定版本可在“确认镜头”中的设定区域管理。修改名称后请核对镜头中的引用。</p>
        </main> : null}
        {step === 3 ? <main className="story-stage-content story-review-main">
          <div className="story-stage-intro"><div><h2>合成提示词</h2><p>按镜头信息拼合提示词，可逐镜编辑。修改镜头信息后，请重新合成对应镜头；不会自动覆盖手工修改。</p></div><button type="button" className="secondary-button" onClick={() => { if (data.shots.some((item) => item.finalImagePrompt || item.finalVideoPrompt) && !window.confirm("重新合成全部镜头会覆盖已编辑的最终提示词，继续？")) return; change({ ...data, shots: data.shots.map((item) => ({ ...item, finalImagePrompt: assembleStoryboardPrompt(item, "image"), finalVideoPrompt: assembleStoryboardPrompt(item, "video") })) }); }}>合成全部镜头</button></div>
          <div className="story-prompt-table"><table><thead><tr><th>镜号</th><th>时长</th><th>画面描述</th><th>景别 / 运镜</th><th>对白 / 音效</th><th>最终提示词</th></tr></thead><tbody>{data.shots.map((item, index) => <tr key={item.id}><td>{index + 1}</td><td>{item.duration}s</td><td>{item.prompt}</td><td>{item.shotSize || "—"}<br />{item.cameraMove || "—"}</td><td>{item.dialogue || "—"}<br />{item.soundEffect || ""}</td><td><button type="button" className="link-btn" onClick={() => { if ((item.finalImagePrompt || item.finalVideoPrompt) && !window.confirm("重新合成会覆盖该镜头已编辑的最终提示词，继续？")) return; changeShot(index, { finalImagePrompt: assembleStoryboardPrompt(item, "image"), finalVideoPrompt: assembleStoryboardPrompt(item, "video") }); }}>合成此镜</button><label>图片<textarea rows={3} maxLength={5000} placeholder="待合成" value={item.finalImagePrompt} onChange={(e) => changeShot(index, { finalImagePrompt: e.target.value })} /></label><label>视频<textarea rows={3} maxLength={5000} placeholder="待合成" value={item.finalVideoPrompt} onChange={(e) => changeShot(index, { finalVideoPrompt: e.target.value })} /></label></td></tr>)}</tbody></table></div>
        </main> : null}
        <footer className="story-review-footer"><span>{error ? <span role="alert" className="story-review-error">{error}</span> : dirty ? "有未保存的修改" : "修改不会自动覆盖已导入的画布"}</span>{step > 1 ? <button type="button" className="secondary-button" onClick={() => setStep(step === 3 ? 2 : 1)}>上一步</button> : null}{step < 3 ? <button type="button" className="secondary-button" onClick={() => setStep(step === 1 ? 2 : 3)}>下一步</button> : null}<button type="button" className="secondary-button" disabled={busy} onClick={() => setPreviewOpen(true)}>粗剪预览 / 导出</button><button type="button" className="secondary-button" disabled={busy} onClick={() => void syncToCanvas()}>同步到画布</button><button type="button" className="secondary-button" disabled={busy || !dirty} onClick={() => void persist(false)}><Check size={15} />保存</button><button type="button" className="primary-button" disabled={busy || !selected.size || selected.size > 30} onClick={() => void persist(true)}>{busy ? <LoaderCircle className="spin" size={15} /> : <LayoutGrid size={15} />}保存并导入所选镜头</button></footer>
      </>}
    </section>
    {generator && data && data[generator.kind][generator.index] ? <StoryboardAssetGenerator
      kind={generator.kind} item={data[generator.kind][generator.index]!} style={data.brief.style}
      onClose={() => setGenerator(null)} onChoose={(asset) => {
        change({ ...data, [generator.kind]: data[generator.kind].map((entry, i) => i === generator.index ? { ...entry, assetId: asset.id } : entry) });
        setGenerator(null); onToast?.("ok", "参考图已生成并关联，请保存分镜");
      }} /> : null}
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


type ImageChoice = { alias: string; model: string; channelName: string; channelId: string; adapterType: string };
function StoryboardAssetGenerator({ kind, item, style, onClose, onChoose }: {
  kind: "characters" | "scenes" | "props";
  item: StoryboardProjectData["characters"][number]; style: string;
  onClose: () => void; onChoose: (asset: Asset) => void;
}) {
  const label = kind === "characters" ? "角色" : kind === "scenes" ? "场景" : "道具";
  const guide = kind === "characters" ? "同一人物的正面、侧面、背面全身三视图，统一服装、比例和光线，简洁背景，无文字。" : kind === "scenes" ? "展示环境全貌、空间结构、光线与色调，保持场景细节一致，无人物，无文字。" : "清晰展示外形、材质和细节，简洁背景，单件物品，无文字。";
  const [prompt, setPrompt] = useState(() => [`${label}设定图：${item.name}。`, item.prompt, guide, style ? `视觉风格：${style}` : ""].filter(Boolean).join(" "));
  const [choices, setChoices] = useState<ImageChoice[]>([]);
  const [params, setParams] = useState<ImageDraft>({ ...defaultImageDraft });
  const updateParam = (key: keyof ImageDraft, value: string) => setParams((current) => ({ ...current, [key]: value }));
  const [alias, setAlias] = useState("");
  const [task, setTask] = useState<Task | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.capabilities(), api.settings()]).then(([capabilities, settings]) => {
      if (cancelled) return;
      const options = capabilities.aliases.filter((entry) => entry.kind === "image");
      setChoices(options); setAlias(options.find((entry) => entry.alias === settings.defaultImageAlias)?.alias ?? options[0]?.alias ?? "");
    }).catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "加载模型失败"); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!task || terminalStatuses.includes(task.status)) return;
    let cancelled = false;
    const timer = window.setInterval(() => { void api.task(task.id).then((next) => { if (!cancelled) { setTask(next); setError(""); } }).catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "查询进度失败，正在重试；也可稍后到素材库查看"); }); }, 2500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [task]);
  const generating = submitting || Boolean(task && !terminalStatuses.includes(task.status));
  function close() {
    if (generating && !window.confirm("任务仍在生成，关闭后结果会保留在素材库，可稍后手动选择。确定关闭？")) return;
    onClose();
  }
  async function submit() {
    const model = choices.find((entry) => entry.alias === alias);
    if (!model || !prompt.trim() || generating) return;
    let parameters: ReturnType<typeof imageGenerationParameters>;
    try { parameters = imageGenerationParameters(model.adapterType, params); }
    catch (e) { setError(e instanceof Error ? e.message : "参数有误"); return; }
    if (!confirmGeneration({ kind: `${label}参考图生成`, model: model.model, channel: model.channelName, detail: `请求数量：${parameters.count ?? 1} 张${item.assetId ? "；生成后可选择替换当前参考图" : ""}` })) return;
    setSubmitting(true); setError("");
    try { setTask(await api.generate({ channelId: model.channelId, model: model.model, prompt: prompt.trim(), ...parameters })); }
    catch (e) { setError(e instanceof Error ? e.message : "提交失败"); }
    finally { setSubmitting(false); }
  }
  const images = task?.assets.filter((asset) => asset.mimeType.startsWith("image/")) ?? [];
  const adapter = choices.find((entry) => entry.alias === alias)?.adapterType ?? "";
  const openai = ["openai-images", "openai-chat-image", "generic-json"].includes(adapter);
  const gemini = adapter === "gemini-content";
  const mj = adapter === "midjourney";
  return <div className="story-reference-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
    <section className="story-reference-picker story-generator" role="dialog" aria-modal="true" aria-label={`生成${label}参考图`}>
      <header><strong>生成{label}参考图 · {item.name}</strong><button type="button" className="icon-button" aria-label="关闭生成窗口" onClick={close}><X size={16} /></button></header>
      <label>生图模型<select value={alias} disabled={generating || loading} onChange={(e) => setAlias(e.target.value)}><option value="">{loading ? "正在加载模型…" : "请选择生图模型"}</option>{choices.map((entry) => <option key={entry.alias} value={entry.alias}>{entry.model} · {entry.channelName}</option>)}</select></label>
      {!loading && !choices.length ? <p>尚未配置生图模型，请先在模型设置中添加。</p> : null}
      <label>生成提示词<textarea rows={5} value={prompt} disabled={generating} maxLength={20000} onChange={(e) => setPrompt(e.target.value)} /></label>
      <div className="story-generator-heading"><strong>生成参数</strong><small>根据所选模型显示可用选项</small></div>
      <div className="story-generator-grid">
        {openai ? <>
          <label>图片尺寸<input list="story-generator-sizes" value={params.size} disabled={generating} placeholder="自动，或输入宽x高" onChange={(e) => updateParam("size", e.target.value)} /><datalist id="story-generator-sizes">{OPENAI_SIZE_PRESETS.map((size) => <option value={size} key={size} />)}</datalist><small>可选择预设或自定义尺寸，具体支持范围由上游决定。</small></label>
          <label>质量<select value={params.quality} disabled={generating} onChange={(e) => updateParam("quality", e.target.value)}><option value="">自动</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
          <label>数量<input type="number" min="1" max="8" step="1" value={params.count} disabled={generating} onChange={(e) => updateParam("count", e.target.value)} /></label>
          <label>输出格式<select value={params.outputFormat} disabled={generating} onChange={(e) => updateParam("outputFormat", e.target.value)}><option value="">自动</option><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select></label>
        </> : null}
        {gemini || mj ? <label>画幅比例<input list="story-generator-ratios" value={params.aspectRatio} disabled={generating} placeholder="自动，或输入 16:9" onChange={(e) => updateParam("aspectRatio", e.target.value)} /><datalist id="story-generator-ratios">{["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"].map((value) => <option value={value} key={value} />)}</datalist></label> : null}
        {gemini ? <label>输出尺寸<select value={params.imageSize} disabled={generating} onChange={(e) => updateParam("imageSize", e.target.value)}><option value="">自动</option><option>1K</option><option>2K</option><option>4K</option></select></label> : null}
        {mj ? <label>模型版本<select value={params.midjourneyVersion} disabled={generating} onChange={(e) => updateParam("midjourneyVersion", e.target.value)}><option value="">默认</option>{["8.2", "7", "6.1", "6"].map((value) => <option key={value}>{value}</option>)}</select></label> : null}
      </div>
      <details className="story-generator-advanced"><summary>高级参数</summary><div className="story-generator-grid">
        {openai || mj ? <label className="wide">负面提示词<textarea rows={2} maxLength={10000} value={params.negativePrompt} disabled={generating} placeholder="不希望出现的内容" onChange={(e) => updateParam("negativePrompt", e.target.value)} /></label> : null}
        {openai ? <>
          <label>背景<select value={params.background} disabled={generating} onChange={(e) => updateParam("background", e.target.value)}><option value="">自动</option><option value="opaque">不透明</option><option value="transparent">透明</option></select></label>
          <label>风格<select value={params.style} disabled={generating} onChange={(e) => updateParam("style", e.target.value)}><option value="">自动</option><option value="vivid">Vivid</option><option value="natural">Natural</option></select></label>
          <label>内容审核<select value={params.moderation} disabled={generating} onChange={(e) => updateParam("moderation", e.target.value)}><option value="">自动</option><option value="low">低限制</option></select></label>
          <label>响应格式<select value={params.responseFormat} disabled={generating} onChange={(e) => updateParam("responseFormat", e.target.value)}><option value="">自动</option><option value="url">URL</option><option value="b64_json">Base64</option></select></label>
        </> : null}
        {gemini ? <>
          {([ ["temperature", "温度", "0", "2", "0.1"], ["topP", "Top P", "0", "1", "0.01"], ["topK", "Top K", "1", "100", "1"], ["maxOutputTokens", "最大输出 Token", "1", "32768", "1"], ["seed", "随机种子", "0", "2147483647", "1"] ] as const).map(([field, text, min, max, step]) => <label key={field}>{text}<input type="number" min={min} max={max} step={step} placeholder="自动" value={params[field]} disabled={generating} onChange={(e) => updateParam(field, e.target.value)} /></label>)}
          <label>响应模态<select value={params.responseModalities} disabled={generating} onChange={(e) => updateParam("responseModalities", e.target.value)}><option value="IMAGE">仅图片</option><option value="TEXT,IMAGE">文本与图片</option></select></label>
        </> : null}
        <label>超时时间（秒）<input type="number" min="10" max="1800" step="1" value={params.timeoutSeconds} disabled={generating} onChange={(e) => updateParam("timeoutSeconds", e.target.value)} /></label>
        <label className="wide">渠道额外参数（JSON）<textarea rows={3} value={params.raw} disabled={generating} spellCheck={false} onChange={(e) => updateParam("raw", e.target.value)} /><small>仅在需要传递渠道特有字段时填写。</small></label>
      </div></details>
      <p>生成结果会保存到素材库，选择图片后关联到当前{label}；记得保存分镜。</p>
      {task ? <p role="status">{statusLabels[task.status]}{task.progress != null ? ` · ${task.progress}%` : ""}{task.errorMessage ? `：${task.errorMessage}` : ""}</p> : null}
      {error ? <p className="story-review-error" role="alert">{error}</p> : null}
      {task?.status === "succeeded" && !images.length ? <p className="story-review-error">任务已完成，但没有返回图片。</p> : null}
      {images.length ? <div className="story-generator-results">{images.map((asset) => <button type="button" key={asset.id} onClick={() => onChoose(asset)} title="使用这张图片"><img src={api.assetUrl(asset.thumbUrl || asset.url)} onError={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = api.assetUrl(asset.url); }} alt="生成结果" /><span>使用这张图片</span></button>)}</div> : null}
      <footer><button type="button" className="secondary-button" onClick={close}>关闭</button><button type="button" className="primary-button" disabled={loading || generating || !alias || !prompt.trim()} onClick={() => void submit()}>{generating ? <><LoaderCircle className="spin" size={15} /> 生成中</> : task ? "重新生成" : "生成参考图"}</button></footer>
    </section>
  </div>;
}
