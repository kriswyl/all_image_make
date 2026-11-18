import { useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Clapperboard, Film, ImageIcon, PanelRight, Plus, Sparkles, Trash2 } from "lucide-react";
import { api } from "../api";
import type { StoryboardPreviewBoard, StoryboardProjectData } from "../../shared/storyboard-project";

export type StoryboardShot = StoryboardProjectData["shots"][number];
export type ShotMedia = StoryboardPreviewBoard["shots"][number];
type ShotRow = { shot: StoryboardShot; index: number };
type ShotText = "prompt" | "videoPrompt" | "dialogue" | "soundEffect" | "sourceText";

export function shotNumber(index: number) {
  return String(index + 1).padStart(2, "0");
}

export function shotDuration(seconds: number) {
  return `${Number(seconds.toFixed(2))} 秒`;
}

export function StoryboardShotRail({ rows, active, selected, media, filter, scenes, showingSelected, onFilter, onActivate, onSelect, onSelectRows, onClear, onAdd }: {
  rows: ShotRow[];
  active: number;
  selected: ReadonlySet<string>;
  media: ReadonlyMap<string, ShotMedia>;
  filter: string;
  scenes: string[];
  showingSelected: boolean;
  onFilter: (value: string) => void;
  onActivate: (index: number) => void;
  onSelect: (id: string, checked: boolean) => void;
  onSelectRows: () => void;
  onClear: () => void;
  onAdd: (() => void) | null;
}) {
  return <aside className="storydesk-rail" aria-label="镜头列表">
    <div className="storydesk-rail-tools">
      <select aria-label="筛选场景" value={filter} onChange={(event) => onFilter(event.target.value)}>
        <option value="">全部场景</option>
        {scenes.map((scene) => <option key={scene}>{scene}</option>)}
      </select>
      <div>
        <button type="button" className="storydesk-link" disabled={!rows.length} onClick={onSelectRows} title="最多选中前 30 镜">选中当前列表</button>
        <button type="button" className="storydesk-link" disabled={!selected.size} onClick={onClear}>清空</button>
      </div>
    </div>
    <div className="storydesk-rail-list">
      {rows.map(({ shot, index }, position) => {
        const frame = media.get(shot.id);
        const differentScene = position === 0 || rows[position - 1]?.shot.scene !== shot.scene;
        return <div key={shot.id}>
          {differentScene ? <h3 className="storydesk-scene-label">{shot.scene || "未标场景"}</h3> : null}
          <div className="storydesk-rail-row" data-current={active === index}>
            <button type="button" aria-current={active === index ? "true" : undefined}
              aria-label={`查看第 ${index + 1} 镜`} onClick={() => onActivate(index)}>
              <span className="storydesk-rail-frame">
                {frame?.image ? <img src={api.assetUrl(frame.image.thumbUrl || frame.image.url)} alt="" loading="lazy" onError={(event) => {
                  const url = api.assetUrl(frame.image!.url);
                  if (event.currentTarget.getAttribute("src") !== url) event.currentTarget.src = url;
                  else event.currentTarget.hidden = true;
                }} /> : frame?.video ? <Film size={15} /> : <Clapperboard size={15} />}
              </span>
              <span className="storydesk-row-text"><strong>{shotNumber(index)} <span>{shot.shotSize || "镜头"}</span></strong>
                <small title={shot.prompt}>{shot.prompt || "待填写首帧"}</small></span>
              <time>{shotDuration(shot.duration)}</time>
            </button>
            <input type="checkbox" checked={selected.has(shot.id)} disabled={!selected.has(shot.id) && selected.size >= 30}
              title={selected.size >= 30 && !selected.has(shot.id) ? "已选满 30 镜" : undefined} aria-label={`勾选第 ${index + 1} 镜用于导入`}
              onChange={(event) => onSelect(shot.id, event.target.checked)} />
          </div>
        </div>;
      })}
      {!rows.length ? <p className="storydesk-muted storydesk-rail-empty">{showingSelected ? "当前没有已选镜头" : "当前场景没有镜头"}</p> : null}
    </div>
    <div className="storydesk-rail-bottom"><button type="button" className="storydesk-button" disabled={!onAdd} onClick={onAdd ?? undefined}><Plus size={15} />新增镜头</button></div>
  </aside>;
}

export function StoryboardShotEditor({ shot, index, count, media, boardPicker, splitSuggestion, onPatch, onMove, onRemove, onSplit, onApplySplit, onDismissSplit, onSettings }: {
  shot: StoryboardShot;
  index: number;
  count: number;
  media?: ShotMedia;
  boardPicker?: ReactNode;
  splitSuggestion?: Array<Pick<StoryboardShot, "prompt" | "videoPrompt" | "dialogue" | "sourceText">>;
  onPatch: (patch: Partial<StoryboardShot>) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
  onSplit: () => void;
  onApplySplit: () => void;
  onDismissSplit: () => void;
  onSettings: () => void;
}) {
  const [tab, setTab] = useState<"visual" | "voice" | "source">("visual");
  const textField = (field: ShotText, label: string, rows: number, maxLength: number) =>
    <label key={field} className="storydesk-field"><span>{label}</span>
      <textarea rows={rows} maxLength={maxLength} value={shot[field]} onChange={(event) => onPatch({ [field]: event.target.value })} />
    </label>;

  return <main className="storydesk-editor">
    <div className="storydesk-editor-inner">
      <header className="storydesk-shot-head">
        <div className="storydesk-shot-title"><span>{shotNumber(index)}</span><div><h2>{shot.scene || `第 ${index + 1} 镜`}</h2>
          <p>{[shot.shotSize, shot.cameraMove, shotDuration(shot.duration)].filter(Boolean).join(" · ")}</p></div></div>
        <div className="storydesk-actions">
          <button type="button" className="storydesk-icon storydesk-settings-trigger" aria-label="镜头设置" title="镜头设置" onClick={onSettings}><PanelRight size={17} /></button>
          <button type="button" className="storydesk-icon" aria-label="上移镜头" title="上移镜头" disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp size={16} /></button>
          <button type="button" className="storydesk-icon" aria-label="下移镜头" title="下移镜头" disabled={index === count - 1} onClick={() => onMove(1)}><ArrowDown size={16} /></button>
          <button type="button" className="storydesk-icon storydesk-danger" aria-label="删除镜头" title="删除镜头" disabled={count <= 1} onClick={onRemove}><Trash2 size={16} /></button>
        </div>
      </header>
      {media?.video || media?.image ? <figure className="storydesk-shot-media">
        <div key={media.video?.id ?? media.image?.id}>
          {media.video ? <video src={api.assetUrl(media.video.url)} controls preload="metadata" playsInline />
            : <img src={api.assetUrl(media.image!.url)} alt={`第 ${index + 1} 镜画面`} />}
        </div>
        <figcaption><span>{media.video ? <Film size={14} /> : <ImageIcon size={14} />}{media.video ? "画布视频" : "画布首帧"}</span>{boardPicker}</figcaption>
      </figure> : <div className="storydesk-no-media"><span><ImageIcon size={15} />此镜头暂无画布画面</span>{boardPicker}</div>}
      {splitSuggestion ? <section className="story-split-suggestion">
        <strong>拆分建议</strong>
        {splitSuggestion.map((draft, position) => <article key={position}><b>建议镜头 {position + 1}</b>
          <p>{draft.prompt}</p><p>{draft.videoPrompt}</p><p>{draft.dialogue}</p><p>{draft.sourceText}</p></article>)}
        <div><button type="button" className="storydesk-button" onClick={onDismissSplit}>放弃</button>
          <button type="button" className="storydesk-button is-primary" onClick={onApplySplit}>应用拆分</button></div>
      </section> : null}
      <div className="storydesk-edit-card">
        <div className="storydesk-edit-toolbar">
          <div className="storydesk-segments" role="group" aria-label="镜头编辑内容">
            {([["visual", "画面与动作"], ["voice", "对白与声音"], ["source", "原文"]] as const).map(([value, label]) =>
              <button type="button" key={value} aria-pressed={tab === value} onClick={() => setTab(value)}>{label}</button>)}
          </div>
          <button type="button" className="storydesk-button" disabled={count >= 60} onClick={onSplit}><Sparkles size={14} />AI 拆镜</button>
        </div>
        <div className="storydesk-edit-fields">
          {tab === "visual" ? <>{textField("prompt", "首帧画面", 3, 2000)}{textField("videoPrompt", "动作与运镜", 3, 2000)}</> : null}
          {tab === "voice" ? <><label className="storydesk-field"><span>说话人</span><input value={shot.speaker} maxLength={120} onChange={(event) => onPatch({ speaker: event.target.value })} /></label>
            {textField("dialogue", "台词或旁白", 4, 1000)}{textField("soundEffect", "声音提示", 3, 500)}</> : null}
          {tab === "source" ? textField("sourceText", "对应原文", 8, 3000) : null}
        </div>
      </div>
    </div>
  </main>;
}

export function StoryboardPromptEditor({ shot, index, count, onPatch, onCompose, onNavigate }: {
  shot: StoryboardShot;
  index: number;
  count: number;
  onPatch: (patch: Partial<StoryboardShot>) => void;
  onCompose: (all: boolean) => void;
  onNavigate: (index: number) => void;
}) {
  const [mode, setMode] = useState<"image" | "video">("image");
  const field = mode === "image" ? "finalImagePrompt" : "finalVideoPrompt";
  return <main className="storydesk-editor">
    <div className="storydesk-editor-inner">
      <header className="storydesk-shot-head">
        <div className="storydesk-shot-title"><span>{shotNumber(index)}</span><div><h2>{shot.scene || `第 ${index + 1} 镜`}</h2><p>{shotDuration(shot.duration)} · 最终提示词</p></div></div>
        <div className="storydesk-actions">
          <button type="button" className="storydesk-icon" aria-label="上一镜" disabled={index === 0} onClick={() => onNavigate(index - 1)}><ChevronLeft size={17} /></button>
          <button type="button" className="storydesk-icon" aria-label="下一镜" disabled={index >= count - 1} onClick={() => onNavigate(index + 1)}><ChevronRight size={17} /></button>
        </div>
      </header>
      <div className="storydesk-edit-card">
        <div className="storydesk-edit-toolbar">
          <div className="storydesk-segments" role="group" aria-label="提示词类型">
            <button type="button" aria-pressed={mode === "image"} onClick={() => setMode("image")}><ImageIcon size={15} />图片</button>
            <button type="button" aria-pressed={mode === "video"} onClick={() => setMode("video")}><Film size={15} />视频</button>
          </div>
          <div className="storydesk-actions">
            <button type="button" className="storydesk-button" onClick={() => onCompose(false)}><Sparkles size={14} />合成此镜</button>
            <button type="button" className="storydesk-link" onClick={() => onCompose(true)}>合成全部</button>
          </div>
        </div>
        <div className="storydesk-edit-fields">
          <label className="storydesk-field"><span>{mode === "image" ? "最终图片提示词" : "最终视频提示词"} <small>{shot[field].length} / 5000</small></span>
            <textarea value={shot[field]} maxLength={5000} rows={12} placeholder="可直接撰写，也可以从镜头内容合成" onChange={(event) => onPatch({ [field]: event.target.value })} />
          </label>
          <details className="storydesk-source-note"><summary>查看镜头原描述</summary><p>{mode === "video" ? shot.videoPrompt || shot.prompt : shot.prompt}</p></details>
        </div>
      </div>
    </div>
  </main>;
}
