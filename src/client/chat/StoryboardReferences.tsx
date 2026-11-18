import { useState } from "react";
import { ImageIcon, Layers3, Maximize2, Plus, Sparkles, Trash2, X } from "lucide-react";
import { api } from "../api";
import { statusLabels, terminalStatuses } from "../task-ui";
import { LoadingIndicator } from "../ui/LoadingIndicator";
import type { StoryboardProjectData } from "../../shared/storyboard-project";
import type { TaskStatus } from "../../shared/types";
import type { StoryboardShot } from "./StoryboardShotWorkspace";

const referenceTypes = [
  { kind: "characters", label: "角色", field: "character", versions: "characterVersions", maxLength: 120 },
  { kind: "scenes", label: "场景", field: "scene", versions: null, maxLength: 80 },
  { kind: "props", label: "道具", field: "props", versions: "propVersions", maxLength: 200 },
] as const;
export type ReferenceKind = typeof referenceTypes[number]["kind"];
export type ReferenceTarget = { kind: ReferenceKind; index: number };
type Setting = StoryboardProjectData[ReferenceKind][number];
type ReferenceImageTarget = ReferenceTarget & { variantId?: string };

function ReferenceImage({ id, alt = "" }: { id: string | null; alt?: string }) {
  return id ? <img key={id} src={api.assetUrl(`/api/assets/${id}/thumb`)} alt={alt} loading="lazy"
    onError={(event) => {
      const fallback = api.assetUrl(`/api/assets/${id}/file`);
      if (event.currentTarget.getAttribute("src") !== fallback) event.currentTarget.src = fallback;
      else event.currentTarget.hidden = true;
    }} /> : <ImageIcon size={23} aria-hidden="true" />;
}

export function StoryboardShotInspector({ shot, data, expanded, onClose, onPatch, onField }: {
  shot: StoryboardShot;
  data: StoryboardProjectData;
  expanded: boolean;
  onClose: () => void;
  onPatch: (patch: Partial<StoryboardShot>) => void;
  onField: (field: "shotSize" | "cameraMove", value: string) => void;
}) {
  return <aside className="storydesk-inspector" data-expanded={expanded} aria-label="镜头设置">
    <div className="storydesk-inspector-title"><h2>镜头设置</h2><button type="button" className="storydesk-icon storydesk-settings-trigger" aria-label="收起镜头设置" onClick={onClose}><X size={17} /></button></div>
    <div className="storydesk-inspector-fields">
      <label className="storydesk-field"><span>预估时长</span><div className="storydesk-duration-input">
        <input key={`${shot.id}-${shot.duration}`} type="number" min="0.5" max="120" step="0.5" defaultValue={shot.duration}
          onBlur={(event) => {
            const value = event.currentTarget.valueAsNumber;
            const next = Number.isFinite(value) ? Math.max(0.5, Math.min(120, value)) : shot.duration;
            event.currentTarget.value = String(next);
            if (next !== shot.duration) onPatch({ duration: next });
          }} /><span>秒</span>
      </div></label>
      <label className="storydesk-field"><span>景别</span><input value={shot.shotSize} maxLength={40} onChange={(event) => onField("shotSize", event.target.value)} /></label>
      <label className="storydesk-field"><span>运镜</span><input value={shot.cameraMove} maxLength={80} onChange={(event) => onField("cameraMove", event.target.value)} /></label>
    </div>
    <h3>参考素材</h3>
    <div className="storydesk-inspector-fields">
      {referenceTypes.map(({ kind, label, field, versions, maxLength }) => {
        const names = (kind === "scenes" ? [shot.scene] : shot[field].split(/[、,，]/)).map((name) => name.trim()).filter(Boolean);
        const matched = [...new Set(names)].map((name) => data[kind].find((item) => item.name.trim() === name)).filter((item) => item !== undefined);
        return <section className="storydesk-link-group" key={kind}>
          <label className="storydesk-field"><span>{label}</span><input value={shot[field]} maxLength={maxLength} placeholder={kind === "scenes" ? "输入场景名称" : "多个名称用顿号分隔"}
            onChange={(event) => onPatch(kind === "scenes" ? { scene: event.target.value, sceneVersionId: "" } : { [field]: event.target.value })} /></label>
          {matched.map((item) => {
            const selected = versions ? shot[versions][item.name] || "" : shot.sceneVersionId;
            const variant = item.variants.find((entry) => entry.id === selected);
            const imageId = variant?.assetId || item.assetId;
            return <div className="storydesk-bound-ref" key={item.name}>
              <span><ReferenceImage id={imageId} /></span>
              <div><strong title={item.name}>{item.name}</strong>
                {item.variants.length ? <select aria-label={`${item.name}的版本`} value={variant?.id || ""} onChange={(event) => {
                  const value = event.target.value;
                  onPatch(versions ? { [versions]: { ...shot[versions], [item.name]: value } } : { sceneVersionId: value });
                }}><option value="">默认设定</option>{item.variants.map((entry) => <option value={entry.id} key={entry.id}>{entry.name}</option>)}</select>
                  : <small>{imageId ? "默认设定" : "待关联参考图"}</small>}
              </div>
            </div>;
          })}
        </section>;
      })}
    </div>
  </aside>;
}

export function StoryboardReferenceWorkspace({ data, onChange, onPick, onGenerate, onPreview, onRemove, generationStatus }: {
  data: StoryboardProjectData;
  onChange: (data: StoryboardProjectData) => void;
  onPick: (target: ReferenceImageTarget) => void;
  onGenerate: (target: ReferenceTarget) => void;
  onPreview: (id: string, title: string) => void;
  onRemove: (target: ReferenceTarget) => void;
  generationStatus: (kind: ReferenceKind, index: number) => TaskStatus | null;
}) {
  const [kind, setKind] = useState<ReferenceKind>("characters");
  const [active, setActive] = useState<number | null>(null);
  const type = referenceTypes.find((entry) => entry.kind === kind)!;
  const entries = data[kind];
  const current = active === null ? undefined : entries[active];
  const currentStatus = active === null ? null : generationStatus(kind, active);

  function updateSetting(patch: Partial<Setting>) {
    onChange({ ...data, [kind]: entries.map((entry, index) => index === active ? { ...entry, ...patch } : entry) });
  }

  function removeVariant(id: string) {
    if (!current || !window.confirm("删除此版本？使用它的镜头将切回默认设定。")) return;
    const shots = data.shots.map((shot) => {
      const field = type.versions;
      if (!field) return shot.scene === current.name && shot.sceneVersionId === id ? { ...shot, sceneVersionId: "" } : shot;
      if (shot[field][current.name] !== id) return shot;
      const versions = { ...shot[field] };
      delete versions[current.name];
      return { ...shot, [field]: versions };
    });
    onChange({ ...data, shots, [kind]: entries.map((entry, index) => index === active ? { ...entry, variants: entry.variants.filter((variant) => variant.id !== id) } : entry) });
  }

  function addSetting() {
    let number = entries.length + 1;
    while (entries.some((entry) => entry.name.trim() === `新${type.label}${number}`)) number++;
    onChange({ ...data, [kind]: [...entries, { name: `新${type.label}${number}`, prompt: "", assetId: null, variants: [] }] });
    setActive(entries.length);
  }

  return <div className="storydesk-library" data-detail={Boolean(current)}>
    <main className="storydesk-library-main">
      <div className="storydesk-library-header">
        <div className="storydesk-segments" role="group" aria-label="参考素材分类">
          {referenceTypes.map((item) => <button type="button" key={item.kind} aria-pressed={kind === item.kind} onClick={() => { setKind(item.kind); setActive(null); }}>
            {item.label}<small>{data[item.kind].length}</small></button>)}
        </div>
        <button type="button" className="storydesk-button" disabled={entries.length >= 12} onClick={addSetting}><Plus size={15} />新增{type.label}</button>
      </div>
      <div className="storydesk-library-grid">
        {entries.map((entry, index) => {
          const status = generationStatus(kind, index);
          return <button type="button" className="storydesk-library-card" key={index} aria-pressed={active === index} onClick={() => setActive(index)}>
          <span className="storydesk-library-cover"><ReferenceImage id={entry.assetId} />{!entry.assetId ? <small>暂无参考图</small> : null}
            {status ? <span className="storydesk-reference-status">{status === "succeeded" ? "结果可查看" : statusLabels[status]}</span> : null}</span>
          <span className="storydesk-library-caption"><strong>{entry.name || `未命名${type.label}`}</strong>
            {entry.variants.length ? <small><Layers3 size={13} />{entry.variants.length} 个版本</small> : null}</span>
          </button>;
        })}
        {!entries.length ? <div className="storydesk-library-empty"><Layers3 size={24} /><p>还没有{type.label}设定</p></div> : null}
      </div>
    </main>
    {current && active !== null ? <aside className="storydesk-inspector storydesk-reference-inspector" aria-label={`${type.label}设定`}>
      <div className="storydesk-inspector-title"><h2>{type.label}设定</h2><button type="button" className="storydesk-icon" aria-label="收起设定" onClick={() => setActive(null)}><X size={17} /></button></div>
      <div className="storydesk-inspector-fields">
        {current.assetId ? <button type="button" className="storydesk-reference-cover" aria-label="放大当前参考图"
          onClick={() => onPreview(current.assetId!, current.name || `${type.label}参考图`)}><ReferenceImage id={current.assetId} /><span><Maximize2 size={15} /></span></button> : null}
        <label className="storydesk-field"><span>名称</span><input value={current.name} maxLength={80} onChange={(event) => updateSetting({ name: event.target.value })} /></label>
        <label className="storydesk-field"><span>设定描述</span><textarea rows={4} value={current.prompt} maxLength={1000} onChange={(event) => updateSetting({ prompt: event.target.value })} /></label>
        <div className="storydesk-actions">
          <button type="button" className="storydesk-button" onClick={() => onPick({ kind, index: active })}>{current.assetId ? "更换图片" : "选择图片"}</button>
          <button type="button" className="storydesk-button" onClick={() => onGenerate({ kind, index: active })}>
            {currentStatus && !terminalStatuses.includes(currentStatus) ? <LoadingIndicator variant="dots" size={22} /> : <Sparkles size={14} />}
            {currentStatus ? currentStatus === "succeeded" ? "查看生成结果" : `${statusLabels[currentStatus]} · 查看` : "生成参考图"}
          </button>
          {current.assetId ? <button type="button" className="storydesk-link" onClick={() => updateSetting({ assetId: null })}>解除</button> : null}
        </div>
      </div>
      <div className="storydesk-inspector-title">
        <h3>设定版本</h3>
        <button type="button" className="storydesk-icon" aria-label="新增版本" title="新增版本" disabled={current.variants.length >= 12} onClick={() => {
          let number = current.variants.length + 1;
          while (current.variants.some((variant) => variant.name.trim() === `版本${number}`)) number++;
          updateSetting({ variants: [...current.variants, { id: crypto.randomUUID(), name: `版本${number}`, prompt: "", assetId: null }] });
        }}><Plus size={16} /></button>
      </div>
      <div className="storydesk-inspector-fields">
        {current.variants.map((variant) => {
          const update = (patch: Partial<Setting["variants"][number]>) => updateSetting({ variants: current.variants.map((entry) => entry.id === variant.id ? { ...entry, ...patch } : entry) });
          return <details key={variant.id} className="storydesk-variant">
            <summary><span><ReferenceImage id={variant.assetId} /></span>{variant.name || "未命名版本"}</summary>
            <div className="storydesk-inspector-fields">
              <label className="storydesk-field"><span>版本名称</span><input value={variant.name} maxLength={40} onChange={(event) => update({ name: event.target.value })} /></label>
              <label className="storydesk-field"><span>版本描述</span><textarea rows={3} value={variant.prompt} maxLength={1000} onChange={(event) => update({ prompt: event.target.value })} /></label>
              <div className="storydesk-actions">
                <button type="button" className="storydesk-button" onClick={() => onPick({ kind, index: active, variantId: variant.id })}>{variant.assetId ? "更换图片" : "选择图片"}</button>
                {variant.assetId ? <button type="button" className="storydesk-icon" aria-label="放大版本参考图"
                  onClick={() => onPreview(variant.assetId!, variant.name)}><Maximize2 size={15} /></button> : null}
                {variant.assetId ? <button type="button" className="storydesk-link" onClick={() => update({ assetId: null })}>解除</button> : null}
                <button type="button" className="storydesk-icon storydesk-danger" aria-label="删除版本" onClick={() => removeVariant(variant.id)}><Trash2 size={15} /></button>
              </div>
            </div>
          </details>;
        })}
        <button type="button" className="storydesk-button storydesk-danger" onClick={() => {
          if (!window.confirm("删除此设定？引用它的镜头将无法自动关联参考图。")) return;
          onRemove({ kind, index: active });
          onChange({ ...data, [kind]: entries.filter((_, index) => index !== active) });
          setActive(null);
        }}><Trash2 size={14} />删除设定</button>
      </div>
    </aside> : null}
  </div>;
}
