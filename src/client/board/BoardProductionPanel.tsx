import { useEffect, useState } from "react";
import { Check, Clapperboard, Crosshair, Film, Play, RefreshCw, X } from "lucide-react";
import { api } from "../api";
import type { StoryboardMediaRole, StoryboardProduction } from "../../shared/storyboard-project";

const mediaLabel: Record<StoryboardMediaRole, string> = { image: "首帧", video: "视频", audio: "配音" };

export function BoardProductionPanel({ boardId, projectIds, boardVersion, onLocate, onSwitch, onReview, onClose, onRun, onSync, onBeforeWrite }: {
  boardId: string;
  projectIds: string[];
  boardVersion: number;
  onLocate: (id: string) => void;
  onSwitch: (id: string) => void;
  onReview: (id: string) => void;
  onClose: () => void;
  onRun: (ids: string[]) => void;
  onSync: (id: string, revision: number, shotIds: string[]) => Promise<boolean>;
  onBeforeWrite: () => Promise<boolean>;
}) {
  const [chosenProject, setChosenProject] = useState(projectIds[0] ?? "");
  const projectId = projectIds.includes(chosenProject) ? chosenProject : projectIds[0];
  const [value, setValue] = useState<StoryboardProduction | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState<"all" | "references" | "failed">("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const project = value?.id === projectId ? value : null;

  useEffect(() => {
    if (!projectId) return;
    let current = true;
    void api.storyboardProduction(projectId, boardId).then((result) => { if (current) { setValue(result); setError(""); } })
      .catch((error) => { if (current) setError(error instanceof Error ? error.message : "读取制作进度失败"); });
    return () => { current = false; };
  }, [projectId, boardId, boardVersion, reload]);

  async function setDelivery(shotId: string, role: StoryboardMediaRole, nodeId: string | null) {
    if (!project || busy) return;
    setBusy(true);
    setError("");
    try {
      if (!await onBeforeWrite()) throw new Error("请等待画布保存后再定版");
      setValue(await api.pinStoryboardDelivery(project.id, boardId, { revision: project.revision, shotId, role, nodeId }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "更新定版失败"); }
    finally { setBusy(false); }
  }

  async function updateReferences() {
    if (!project || busy || !selected.length) return;
    setBusy(true);
    setError("");
    try {
      if (!await onSync(project.id, project.revision, selected)) throw new Error("请等待画布保存后再更新引用");
      setReload((current) => current + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "更新引用失败"); }
    finally { setBusy(false); }
  }

  const shots = project?.shots.filter((shot) => filter === "all" || (filter === "references"
    ? shot.references.some((item) => item.outdated) : shot.nodes.some((node) => node.status === "failed"))) ?? [];
  const selectedShots = project?.shots.filter((shot) => selected.includes(shot.id)) ?? [];
  const outdated = selectedShots.some((shot) => shot.references.some((reference) => reference.outdated));
  const runnable = selectedShots.flatMap((shot) => shot.nodes.filter((node) => !shot.delivery?.[node.role]).map(({ id }) => id));

  return <aside className="board-command-panel board-project-panel" aria-label="分镜制作">
    <header><Clapperboard size={17} /><strong>{project?.name || "分镜制作"}</strong><button type="button" className="icon-button" onClick={onClose} aria-label="关闭制作面板"><X size={16} /></button></header>
    <div className="board-command-toolbar">
      {projectIds.length > 1 ? <select aria-label="选择关联分镜" value={projectId} onChange={(event) => { setChosenProject(event.target.value); setSelected([]); }}>
        {projectIds.map((id, index) => <option key={id} value={id}>{project?.id === id ? project.name : `分镜项目 ${index + 1}`}</option>)}</select> : null}
      {project && project.boards.length > 1 ? <select aria-label="项目画布" value={boardId} onChange={(event) => onSwitch(event.target.value)}>
        {project.boards.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select> : null}
      <button type="button" className="secondary-button compact" disabled={!project || busy} onClick={() => project && onReview(project.id)}><Film size={14} />打开审阅</button>
      <button type="button" className="icon-button" aria-label="刷新项目" onClick={() => setReload((current) => current + 1)}><RefreshCw size={14} /></button>
    </div>
    <div className="board-command-toolbar">
      <select aria-label="筛选镜头" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
        <option value="all">全部镜头</option><option value="references">参考图有更新</option><option value="failed">有失败结果</option>
      </select>
      <button type="button" className="secondary-button compact" disabled={busy || !outdated} onClick={() => void updateReferences()}>更新所选引用</button>
      <button type="button" className="secondary-button compact" disabled={busy || !runnable.length} onClick={() => onRun(runnable)}><Play size={13} />运行未定版</button>
    </div>
    {error ? <p className="board-command-empty board-command-error" role="alert">{error}</p> : null}
    <div className="board-command-list board-project-shots">
      {shots.map((shot) => <article key={shot.id}>
        <div className="board-project-shot">
          <label><input type="checkbox" aria-label={`选中第 ${project!.shots.indexOf(shot) + 1} 镜`} checked={selected.includes(shot.id)} onChange={(event) => {
            setSelected((items) => event.target.checked ? [...items, shot.id] : items.filter((id) => id !== shot.id));
          }} /><strong>{String(project!.shots.indexOf(shot) + 1).padStart(2, "0")} · {shot.scene || shot.title}</strong><small>{shot.duration} 秒</small></label>
          {shot.references.some((reference) => reference.outdated) ? <p className="board-command-error">{shot.references.filter((reference) => reference.outdated).map(({ title }) => title).join("、")}可更新</p> : null}
          {(Object.keys(mediaLabel) as StoryboardMediaRole[]).filter((role) => shot.delivery?.[role] && !shot.nodes.some((node) => node.role === role && node.pinned)).map((role) =>
            <div className="board-project-pinned" key={role}><small>交付使用已定版的{mediaLabel[role]}</small>
              <button type="button" className="secondary-button compact" disabled={busy} onClick={() => void setDelivery(shot.id, role, null)}>取消定版</button></div>)}
          {shot.nodes.length ? <div className="board-project-nodes">{shot.nodes.map((node) => <div key={node.id}>
            <button type="button" className="board-project-locate" title={`定位 ${node.title}`} onClick={() => onLocate(node.id)}><Crosshair size={12} />{mediaLabel[node.role]}{node.status === "failed" ? " · 失败" : node.status === "loading" ? " · 生成中" : ""}</button>
            {node.pinned ? <button type="button" className="secondary-button compact" disabled={busy} onClick={() => void setDelivery(shot.id, node.role, null)} title="取消定版"><Check size={12} />已定版</button>
              : node.assetId && node.status === "succeeded" ? <button type="button" className="secondary-button compact" disabled={busy} onClick={() => void setDelivery(shot.id, node.role, node.id)}>定版</button> : null}
          </div>)}</div> : <small>此镜未导入当前画布</small>}
        </div>
      </article>)}
      {!shots.length && !error ? <p className="board-command-empty">{project ? "这个筛选下没有镜头" : "正在读取分镜…"}</p> : null}
    </div>
  </aside>;
}
