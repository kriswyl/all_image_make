import { LoadingIndicator } from "../ui/LoadingIndicator";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Check, ChevronDown, Clapperboard, Film, Layers3, ListChecks, MoreHorizontal, Settings2, Text, X } from "lucide-react";
import { api } from "../api";
import { assembleStoryboardPrompt, type StoryboardPreviewBoard, type StoryboardProject, type StoryboardProjectData } from "../../shared/storyboard-project";
import type { Asset, TaskStatus } from "../../shared/types";
import { StoryboardPreview } from "./StoryboardPreview";
import { StylePresetPicker } from "./StylePresetPicker";
import { applyStyleSuffix, stripStyleSuffix, type StylePreset } from "../../shared/style-presets";
import { replacePromptClause } from "../../shared/prompt-clauses";
import { shotDuration, StoryboardPromptEditor, StoryboardShotEditor, StoryboardShotRail } from "./StoryboardShotWorkspace";
import { StoryboardReferenceWorkspace, StoryboardShotInspector, type ReferenceTarget } from "./StoryboardReferences";
import { StoryboardAssetGenerator } from "./StoryboardAssetGenerator";
import { StoryboardImageViewer } from "./StoryboardImageViewer";
import "./storyboard-review.css";

type Shot = StoryboardProjectData["shots"][number];
type GenerationSession = ReferenceTarget & { id: string; status: TaskStatus | null };
const emptyShot = (): Shot => ({ id: crypto.randomUUID(), prompt: "", duration: 5, character: "", scene: "", characterVersions: {}, sceneVersionId: "", props: "", propVersions: {}, sourceText: "", dialogue: "", speaker: "", shotSize: "", cameraMove: "", videoPrompt: "", soundEffect: "", finalImagePrompt: "", finalVideoPrompt: "" });
const activeDialog = () => document.querySelector<HTMLElement>(".storydesk-preview, .storydesk-overlay [aria-modal='true']");

export function StoryboardReview({ id, onClose, onToast, onImport }: {
  id: string; onClose: () => void; onToast?: (kind: "ok" | "error", text: string) => void;
  onImport: (id: string, name: string, description?: string) => void;
}) {
  const [project, setProject] = useState<StoryboardProject | null>(null);
  const [data, setData] = useState<StoryboardProjectData | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(0);
  const [view, setView] = useState<"shots" | "library" | "prompts">("shots");
  const [sceneFilter, setSceneFilter] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [confirmImport, setConfirmImport] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [boards, setBoards] = useState<StoryboardPreviewBoard[]>([]);
  const [boardId, setBoardId] = useState("");
  const [stylePresets, setStylePresets] = useState<StylePreset[]>([]);
  const [splitSuggestion, setSplitSuggestion] = useState<{ shotId: string; shots: Array<{ prompt: string; videoPrompt: string; dialogue: string; sourceText: string; shotSize: string; cameraMove: string }> } | null>(null);
  const [generator, setGenerator] = useState<string | null>(null);
  const [generationSessions, setGenerationSessions] = useState<GenerationSession[]>([]);
  const [referencePreview, setReferencePreview] = useState<{ id: string; title: string } | null>(null);
  const [picker, setPicker] = useState<(ReferenceTarget & { variantId?: string }) | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api.storyboardProject(id).then((value) => { if (!cancelled) { setProject(value); setData(value.data); setSelected(new Set(value.data.shots.slice(0, 30).map((shot) => shot.id))); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "加载分镜失败"); });
    return () => { cancelled = true; };
  }, [id]);
  useEffect(() => {
    let cancelled = false;
    void api.storyboardPreview(id).then((items) => {
      if (cancelled) return;
      setBoards(items);
      setBoardId(items[0]?.id ?? "");
    }).catch(() => {
      if (!cancelled) setBoards([]);
    });
    return () => { cancelled = true; };
  }, [id]);
  useEffect(() => {
    const opener = document.activeElement;
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);
  useEffect(() => {
    const dialog = activeDialog();
    if (dialog?.tabIndex === -1 && dialog.hasAttribute("tabindex")) dialog.focus();
    else dialog?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [generator, picker, settingsOpen, previewOpen, confirmImport]);
  const close = () => { if (!busy && (!dirty || window.confirm("还有未保存的修改，确定关闭？"))) onClose(); };
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (event.defaultPrevented || document.querySelector(".style-preset-overlay")) return;
      if (event.key === "Tab") {
        const dialog = activeDialog();
        if (!dialog) return;
        const controls = Array.from(dialog.querySelectorAll<HTMLElement>("button, input, textarea, select, summary, video[controls], [tabindex]"))
          .filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest("[inert]") && element.getClientRects().length);
        const first = controls[0];
        const last = controls.at(-1);
        if (first && last && (!dialog.contains(document.activeElement)
          || (event.shiftKey ? document.activeElement === first || document.activeElement === dialog : document.activeElement === last))) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
        return;
      }
      if (event.key !== "Escape" || generator || referencePreview) return;
      if (previewOpen) setPreviewOpen(false);
      else if (picker) setPicker(null);
      else if (confirmImport) setConfirmImport(false);
      else if (settingsOpen) setSettingsOpen(false);
      else if (menuOpen) setMenuOpen(false);
      else if (inspectorOpen) setInspectorOpen(false);
      else close();
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  });
  const updateGenerationStatus = useCallback((sessionId: string, status: TaskStatus | null) => {
    setGenerationSessions((previous) => {
      const session = previous.find((entry) => entry.id === sessionId);
      if (!session || session.status === status) return previous;
      return previous.map((entry) => entry.id === sessionId ? { ...entry, status } : entry);
    });
  }, []);
  function openGenerator(target: ReferenceTarget) {
    const existing = generationSessions.find((entry) => entry.kind === target.kind && entry.index === target.index);
    const sessionId = existing?.id ?? crypto.randomUUID();
    if (!existing) setGenerationSessions((previous) => [...previous, { ...target, id: sessionId, status: null }]);
    setGenerator(sessionId);
  }
  function removeReferenceSession(target: ReferenceTarget) {
    setGenerationSessions((previous) => previous.flatMap((entry) => {
      if (entry.kind !== target.kind || entry.index < target.index) return [entry];
      if (entry.index === target.index) return [];
      return [{ ...entry, index: entry.index - 1 }];
    }));
  }
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
    const missing = data.shots.findIndex((shot) => !shot.prompt.trim());
    if (missing >= 0) {
      setActive(missing); setView("shots"); setSceneFilter(""); setSelectedOnly(false);
      setError(`第 ${missing + 1} 镜缺少首帧画面描述。`);
      return null;
    }
    const saved = await api.saveStoryboardProject(id, project.revision, data);
    setProject(saved); setData(saved.data); setDirty(false); setError(""); return saved;
  }
  function listMissingReferences() {
    if (!data) return [];
    const roles = new Set(data.characters.map((item) => item.name.trim()));
    const scenes = new Set(data.scenes.map((item) => item.name.trim()));
    const props = new Set(data.props.map((item) => item.name.trim()));
    return data.shots.flatMap((item, index) => {
      if (!selected.has(item.id)) return [];
      const names = item.character.split(/[、,，]/).map((value) => value.trim()).filter((value) => value && !roles.has(value));
      if (item.scene.trim() && !scenes.has(item.scene.trim())) names.push(item.scene.trim());
      names.push(...item.props.split(/[、,，]/).map((value) => value.trim()).filter((value) => value && !props.has(value)));
      return names.length ? [{ index, names: [...new Set(names)] }] : [];
    });
  }
  async function persist(importAfter: boolean, acceptedMissing = false) {
    if (!project || !data || busy) return;
    if (importAfter && (!selected.size || selected.size > 30)) { setError("请选择 1 至 30 个镜头导入。"); return; }
    if (importAfter && !acceptedMissing && listMissingReferences().length) {
      setConfirmImport(true);
      return;
    }
    setBusy(true); setError("");
    try {
      const saved = dirty ? await save() : project;
      if (!saved) return;
      if (importAfter) {
        const ordered = saved.data.shots.filter((item) => selected.has(item.id)).map((item) => item.id);
        const template = await api.storyboardSelectionTemplate(id, saved.revision, ordered);
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
    setSelected((old) => { const next = new Set(old); if (old.has(original.id) && old.size < 30 && replacements[1]) next.add(replacements[1].id); return next; });
    setActive(index); setSplitSuggestion(null);
  }
  const shot = data?.shots[active];
  const allRows = data?.shots.map((item, index) => ({ shot: item, index })) ?? [];
  const scenes = [...new Set(allRows.map((row) => row.shot.scene).filter(Boolean))];
  const filter = scenes.includes(sceneFilter) ? sceneFilter : "";
  const rows = allRows.filter((row) => (!filter || row.shot.scene === filter) && (!selectedOnly || selected.has(row.shot.id)));
  const selectedRows = allRows.filter((row) => selected.has(row.shot.id));
  const totalDuration = allRows.reduce((sum, row) => sum + row.shot.duration, 0);
  const selectedDuration = selectedRows.reduce((sum, row) => sum + row.shot.duration, 0);
  const media = new Map(boards.find((board) => board.id === boardId)?.shots.map((item) => [item.shotId, item]));
  const blocked = Boolean(generator || picker || settingsOpen || previewOpen || confirmImport || referencePreview);

  function changeFilter(value: string, only: boolean) {
    setSceneFilter(value);
    setSelectedOnly(only);
    const matches = allRows.filter((row) => (!value || row.shot.scene === value) && (!only || selected.has(row.shot.id)));
    if (matches[0] && !matches.some((row) => row.index === active)) setActive(matches[0].index);
  }
  function selectShot(id: string, checked: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (checked && next.size < 30) next.add(id);
      if (!checked) next.delete(id);
      return next;
    });
  }
  function addShot() {
    if (!data || data.shots.length >= 60) return;
    change({ ...data, shots: [...data.shots, emptyShot()] });
    setSceneFilter("");
    setSelectedOnly(false);
    setView("shots");
    setActive(data.shots.length);
  }
  function compose(all: boolean) {
    if (!data || !shot) return;
    const targets = all ? data.shots : [shot];
    if (targets.some((item) => item.finalImagePrompt || item.finalVideoPrompt)
      && !window.confirm(all ? "重新合成全部镜头会覆盖已编辑的最终提示词，继续？" : "重新合成会覆盖当前镜头的最终提示词，继续？")) return;
    change({ ...data, shots: data.shots.map((item) => all || item.id === shot.id ? {
      ...item, finalImagePrompt: assembleStoryboardPrompt(item, "image"), finalVideoPrompt: assembleStoryboardPrompt(item, "video"),
    } : item) });
  }

  return createPortal(<div className="storydesk-overlay">
    <section className="storydesk" role="dialog" tabIndex={-1} aria-modal={blocked ? undefined : true} aria-label="分镜审阅" inert={blocked}>
      <header className="storydesk-top">
        <div className="storydesk-project">
          <span className="storydesk-emblem"><Clapperboard size={19} /></span>
          <div><p>分镜审阅</p><h1 title={data?.name}>{data?.name || "分镜项目"}</h1></div>
        </div>
        <div className="storydesk-top-actions">
          {data ? <>
            <span className="storydesk-project-meta">{allRows.length} 镜 <span>·</span> {shotDuration(totalDuration)}</span>
            <button type="button" className="storydesk-button" disabled={busy} onClick={() => { setMenuOpen(false); setPreviewOpen(true); }}><Film size={16} />粗剪预览</button>
            <button type="button" className="storydesk-button" disabled={busy || !dirty} onClick={() => void persist(false)}><Check size={16} />保存</button>
            <div className="storydesk-menu">
              {menuOpen ? <button type="button" className="storydesk-menu-scrim" aria-label="关闭项目菜单" tabIndex={-1} onClick={() => setMenuOpen(false)} /> : null}
              <button type="button" className="storydesk-icon" aria-label="项目选项" aria-expanded={menuOpen} disabled={busy} onClick={() => setMenuOpen(!menuOpen)}><MoreHorizontal size={19} /></button>
              {menuOpen ? <div className="storydesk-menu-panel">
                <button type="button" onClick={() => { setMenuOpen(false); setSettingsOpen(true); }}><Settings2 size={15} />项目设置</button>
                <button type="button" onClick={() => { setMenuOpen(false); void syncToCanvas(); }}><ArrowUpRight size={15} />同步已有画布</button>
              </div> : null}
            </div>
          </> : null}
          <button type="button" className="storydesk-icon" aria-label="关闭分镜审阅" onClick={close} disabled={busy}><X size={19} /></button>
        </div>
      </header>
      {!data ? <div className="story-review-loading">{error ? <span role="alert">{error}</span> : <><LoadingIndicator variant="dots" size={24} />正在加载分镜…</>}</div> : <>
        <nav className="storydesk-nav" aria-label="分镜工作区" inert={busy}>
          <div>
            {([{ key: "shots", label: "镜头", icon: Clapperboard }, { key: "library", label: "参考素材", icon: Layers3 }, { key: "prompts", label: "最终提示词", icon: Text }] as const).map(({ key, label, icon: Icon }) =>
              <button type="button" key={key} aria-current={view === key ? "page" : undefined} onClick={() => { setView(key); setInspectorOpen(false); }}><Icon size={16} />{label}</button>)}
          </div>
          <span role="status" className="storydesk-save-state" data-dirty={dirty}>{busy ? "正在处理…" : dirty ? "有未保存的修改" : "已保存"}</span>
        </nav>
        <div className="storydesk-body" inert={busy}>
          {view === "library" ? <StoryboardReferenceWorkspace data={data} onChange={change} onPick={setPicker} onGenerate={openGenerator}
            onPreview={(assetId, title) => setReferencePreview({ id: assetId, title })} onRemove={removeReferenceSession}
            generationStatus={(kind, index) => generationSessions.find((entry) => entry.kind === kind && entry.index === index)?.status ?? null} /> : <>
            <div className="storydesk-workspace" data-view={view}>
              <StoryboardShotRail rows={rows} active={active} selected={selected} media={media} filter={filter} scenes={scenes}
                showingSelected={selectedOnly} onFilter={(value) => changeFilter(value, selectedOnly)} onActivate={setActive}
                onSelect={selectShot} onSelectRows={() => setSelected(new Set(rows.slice(0, 30).map((row) => row.shot.id)))}
                onClear={() => { setSelected(new Set()); setSelectedOnly(false); }} onAdd={data.shots.length < 60 ? addShot : null} />
              {shot && view === "shots" ? <>
                <StoryboardShotEditor key={shot.id} shot={shot} index={active} count={allRows.length} media={media.get(shot.id)}
                  boardPicker={boards.length > 1 ? <label className="storydesk-board-select"><span>素材来源</span><select aria-label="预览画布" value={boardId} onChange={(event) => setBoardId(event.target.value)}>
                    {boards.map((board) => <option key={board.id} value={board.id}>{board.title}</option>)}
                  </select></label> : undefined}
                  splitSuggestion={splitSuggestion?.shotId === shot.id ? splitSuggestion.shots : undefined}
                  onPatch={(patch) => changeShot(active, patch)} onMove={(delta) => move(active, delta)} onRemove={() => remove(active)}
                  onSplit={() => void suggestSplit()} onApplySplit={applySplit} onDismissSplit={() => setSplitSuggestion(null)}
                  onSettings={() => setInspectorOpen(true)} />
                {inspectorOpen ? <button type="button" className="storydesk-inspector-scrim" aria-label="关闭镜头设置" tabIndex={-1} onClick={() => setInspectorOpen(false)} /> : null}
                <StoryboardShotInspector shot={shot} data={data} expanded={inspectorOpen} onClose={() => setInspectorOpen(false)}
                  onPatch={(patch) => changeShot(active, patch)} onField={(field, value) => changeShotField(active, field, value)} />
              </> : shot ? <StoryboardPromptEditor shot={shot} index={active} count={allRows.length}
                onPatch={(patch) => changeShot(active, patch)} onCompose={compose} onNavigate={(index) => { setActive(index); setSceneFilter(""); setSelectedOnly(false); }} /> : null}
            </div>
          </>}
        </div>
        {error ? <div className="storydesk-error" role="alert">{error}<button type="button" className="storydesk-icon" aria-label="关闭提示" onClick={() => setError("")}><X size={15} /></button></div> : null}
        <footer className="storydesk-footer">
          <div className="storydesk-selection" aria-live="polite"><span><ListChecks size={18} /></span><div><strong>已选 {selectedRows.length} <small>/ 30 镜</small></strong>
            <small>合计 {shotDuration(selectedDuration)}</small></div></div>
          <div className="storydesk-actions">
            <button type="button" className="storydesk-button" aria-pressed={selectedOnly} disabled={busy || (!selectedRows.length && !selectedOnly)} onClick={() => {
              changeFilter("", !selectedOnly); setView("shots");
            }}>{selectedOnly ? "查看全部" : "查看已选"}<ChevronDown size={14} /></button>
            <button type="button" className="storydesk-button is-primary" disabled={busy || !selectedRows.length} onClick={() => void persist(true)}>
              导入 {selectedRows.length} 镜到画布 <ArrowUpRight size={16} />
            </button>
          </div>
        </footer>
      </>}
    </section>
    {settingsOpen && data ? <div className="story-reference-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
      <section className="storydesk-dialog" role="dialog" tabIndex={-1} aria-modal="true" aria-label="项目设置">
        <header><h2>项目设置</h2><button type="button" className="storydesk-icon" aria-label="关闭项目设置" onClick={() => setSettingsOpen(false)}><X size={18} /></button></header>
        <label className="storydesk-field"><span>项目名称</span><input value={data.name} maxLength={80} onChange={(event) => change({ ...data, name: event.target.value })} /></label>
        <div className="storydesk-field"><span>全局风格模板</span>
          <StylePresetPicker value="" valueName={data.brief.style} onPresets={setStylePresets} onChange={applyStylePreset}
            toast={(kind, message) => onToast?.(kind === "success" ? "ok" : "error", message)} /></div>
        <div className="storydesk-settings-fields">
          {([["contentType", "内容类型", 80], ["duration", "目标时长", 80], ["aspectRatio", "画面比例", 40],
            ["style", "视觉风格", 300], ["density", "拆镜密度", 80], ["fidelity", "原文处理要求", 200]] as const).map(([field, label, maxLength]) =>
            <label className="storydesk-field" key={field}><span>{label}</span><input value={data.brief[field]} maxLength={maxLength}
              onChange={(event) => change({ ...data, brief: { ...data.brief, [field]: event.target.value } })} /></label>)}
        </div>
        <footer><button type="button" className="storydesk-button is-primary" onClick={() => setSettingsOpen(false)}>完成编辑</button></footer>
      </section>
    </div> : null}
    {confirmImport ? <div className="story-reference-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) setConfirmImport(false); }}>
      <section className="storydesk-dialog storydesk-import-dialog" role="alertdialog" tabIndex={-1} aria-modal="true" aria-label="核对导入素材">
        <header><h2>部分镜头缺少匹配设定</h2><button type="button" className="storydesk-icon" aria-label="关闭导入确认" onClick={() => setConfirmImport(false)}><X size={18} /></button></header>
        <p>这些角色、场景或道具在导入时将跳过自动关联。</p>
        <ul>{listMissingReferences().map(({ index, names }) => <li key={index}><strong>第 {index + 1} 镜</strong><span>{names.join("、")}</span></li>)}</ul>
        <footer><button type="button" className="storydesk-button" onClick={() => setConfirmImport(false)}>返回检查</button>
          <button type="button" className="storydesk-button is-primary" onClick={() => { setConfirmImport(false); void persist(true, true); }}>继续导入</button></footer>
      </section>
    </div> : null}
    {data ? generationSessions.map((session) => {
      const item = data[session.kind][session.index];
      if (!item) return null;
      return <StoryboardAssetGenerator key={session.id} sessionId={session.id} visible={generator === session.id}
        kind={session.kind} item={item} style={data.brief.style} onStatus={updateGenerationStatus}
        onClose={() => setGenerator(null)} onChoose={(asset) => {
          change({ ...data, [session.kind]: data[session.kind].map((entry, index) => index === session.index ? { ...entry, assetId: asset.id } : entry) });
          setGenerator(null); onToast?.("ok", "参考图已关联，请保存分镜");
        }} />;
    }) : null}
    {referencePreview ? <StoryboardImageViewer url={api.assetUrl(`/api/assets/${referencePreview.id}/file`)}
      title={referencePreview.title} onClose={() => setReferencePreview(null)} /> : null}
    {previewOpen && data ? <StoryboardPreview id={id} data={data} startIndex={active} initialBoardId={boardId} onClose={() => setPreviewOpen(false)} /> : null}
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
      {loading ? <span><LoadingIndicator variant="dots" size={24} /> 加载中…</span> : null}
    </section>
  </div>;
}
