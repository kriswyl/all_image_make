import { LoadingIndicator } from "../ui/LoadingIndicator";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Clapperboard, Download, Film, Pause, Play, SkipBack, SkipForward, X } from "lucide-react";
import { api, isTauriRuntime } from "../api";
import type { StoryboardPreviewBoard, StoryboardProjectData } from "../../shared/storyboard-project";
import { shotDuration, shotNumber } from "./StoryboardShotWorkspace";

function csvCell(value: unknown) {
  let text = String(value ?? "");
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function storyboardCsv(data: StoryboardProjectData, board?: StoryboardPreviewBoard) {
  const rows: unknown[][] = [["镜号", "场景", "角色", "道具", "景别", "运镜", "时长(秒)", "原文", "图片提示词", "视频提示词", "台词", "说话人", "声音", "分镜图文件", "视频文件", "配音文件"]];
  data.shots.forEach((shot, index) => {
    const media = board?.shots.find((item) => item.shotId === shot.id);
    const namedVersions = (text: string, settings: StoryboardProjectData["characters"], selected: Record<string, string>) => text.split(/[、,，]/).map((part) => {
      const name = part.trim(); const variant = settings.find((item) => item.name === name)?.variants.find((item) => item.id === selected[name]);
      return variant ? `${name}（${variant.name}）` : name;
    }).filter(Boolean).join("、");
    const sceneVariant = data.scenes.find((item) => item.name === shot.scene)?.variants.find((item) => item.id === shot.sceneVersionId);
    const scene = sceneVariant ? `${shot.scene}（${sceneVariant.name}）` : shot.scene;
    rows.push([index + 1, scene, namedVersions(shot.character, data.characters, shot.characterVersions), namedVersions(shot.props, data.props, shot.propVersions), shot.shotSize, shot.cameraMove, shot.duration, shot.sourceText, shot.prompt, shot.videoPrompt, shot.dialogue, shot.speaker, shot.soundEffect, media?.image?.fileName, media?.video?.fileName, media?.audio?.fileName]);
  });
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function StoryboardPreview({ id, data, startIndex = 0, initialBoardId, onClose }: {
  id: string; data: StoryboardProjectData; startIndex?: number; initialBoardId?: string; onClose: () => void;
}) {
  const [boards, setBoards] = useState<StoryboardPreviewBoard[]>([]);
  const [boardId, setBoardId] = useState("");
  const [index, setIndex] = useState(startIndex);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [draftNote, setDraftNote] = useState("");
  const [showStrip, setShowStrip] = useState(false);
  const remaining = useRef(0);
  const finished = useRef(false);
  const mediaRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let cancelled = false;
    void api.storyboardPreview(id).then((items) => {
      if (cancelled) return;
      setBoards(items);
      setBoardId(items.find((item) => item.id === initialBoardId)?.id ?? items[0]?.id ?? "");
    }).catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "加载画布失败"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, initialBoardId]);
  const board = boards.find((item) => item.id === boardId);
  const shot = data.shots[index];
  const media = board?.shots.find((item) => item.shotId === shot?.id);
  useEffect(() => {
    remaining.current = (shot?.duration ?? 0) * 1000;
    finished.current = false;
  }, [shot?.id, shot?.duration, boardId]);
  useEffect(() => {
    const video = mediaRef.current;
    if (video) { if (playing) void video.play().catch(() => undefined); else video.pause(); }
    if (!playing || !shot) return;
    const started = Date.now();
    const timer = window.setTimeout(() => {
      remaining.current = 0;
      if (index >= data.shots.length - 1) {
        finished.current = true;
        setPlaying(false);
      } else setIndex(index + 1);
    }, remaining.current || shot.duration * 1000);
    return () => { window.clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (Date.now() - started)); };
  }, [playing, index, shot?.id, shot?.duration, data.shots.length, boardId]);
  async function exportCsv() {
    try {
      const content = storyboardCsv(data, board);
      const filename = `${data.name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)}-分镜表.csv`;
      if (isTauriRuntime()) {
        const [{ save }, { writeFile }] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
        const path = await save({ title: "导出分镜表", defaultPath: filename, filters: [{ name: "CSV", extensions: ["csv"] }] });
        if (path) await writeFile(path, new TextEncoder().encode(content));
      } else {
        const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
        const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
    } catch (e) { setError(e instanceof Error ? e.message : "导出失败"); }
  }
  /** 导出剪映草稿：让用户选剪映的草稿目录，素材由服务端复制进去 */
  async function exportDraft() {
    if (!board) { setError("先在「画布」里选一块有镜头素材的画布"); return; }
    try {
      let targetDir = "";
      if (isTauriRuntime()) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const picked = await open({ directory: true, title: "选择剪映草稿目录（com.lveditor.draft）" });
        if (!picked || Array.isArray(picked)) return;
        targetDir = picked;
      } else {
        const typed = window.prompt("剪映草稿目录，例如 C:\Users\你\AppData\Local\JianyingPro\User Data\Projects\com.lveditor.draft");
        if (!typed) return;
        targetDir = typed.trim();
      }
      setExporting(true);
      setDraftNote("");
      const result = await api.exportStoryboardDraft(id, { boardId: board.id, targetDir, name: `${data.name}-成片` });
      setDraftNote(`已导出 ${result.clips} 个镜头${result.skipped ? `，跳过 ${result.skipped} 个没有画面的镜头` : ""}：${result.path}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "导出剪映草稿失败");
    } finally {
      setExporting(false);
    }
  }

  function goTo(next: number) {
    setPlaying(false);
    setIndex(next);
  }

  return createPortal(<div className="story-reference-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="storydesk-dialog storydesk-preview" role="dialog" tabIndex={-1} aria-modal="true" aria-label="分镜粗剪预览">
      <header><div><h2>粗剪预览</h2><p>{data.name} · 按预估时长播放</p></div>
        <button type="button" className="storydesk-icon" aria-label="关闭粗剪" onClick={onClose}><X size={18} /></button></header>
      {loading ? <p role="status"><LoadingIndicator variant="dots" size={24} />正在读取画布…</p> : <label className="storydesk-board-select"><span>素材来源</span>
        <select value={boardId} onChange={(event) => { setPlaying(false); setBoardId(event.target.value); }}>
          <option value="">仅预览分镜文字</option>{boards.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}
        </select>
      </label>}
      <div className="storydesk-preview-stage" key={`${boardId}-${shot?.id}`}>
        {media?.video ? <video ref={mediaRef} src={api.assetUrl(media.video.url)} controls muted={Boolean(media.audio)} playsInline />
          : media?.image ? <img src={api.assetUrl(media.image.url)} alt={`第 ${index + 1} 镜`} />
          : <div><Clapperboard size={26} /><strong>第 {index + 1} 镜暂无画面</strong><p>{shot?.prompt}</p></div>}
        {playing && media?.audio ? <audio src={api.assetUrl(media.audio.url)} autoPlay /> : null}
      </div>
      <div className="storydesk-preview-controls">
        <div className="storydesk-actions">
          <button type="button" className="storydesk-icon" aria-label="上一镜" disabled={index === 0} onClick={() => goTo(index - 1)}><SkipBack size={16} /></button>
          <button type="button" className="storydesk-button is-primary" onClick={() => {
            if (!playing && finished.current) {
              finished.current = false;
              if (index === 0 && mediaRef.current) mediaRef.current.currentTime = 0;
              setIndex(0);
            }
            setPlaying(!playing);
          }}>{playing ? <Pause size={15} /> : <Play size={15} />}{playing ? "暂停" : "播放"}</button>
          <button type="button" className="storydesk-icon" aria-label="下一镜" disabled={index >= data.shots.length - 1} onClick={() => goTo(index + 1)}><SkipForward size={16} /></button>
        </div>
        <strong>第 {index + 1} / {data.shots.length} 镜 · {shotDuration(shot?.duration ?? 0)}</strong>
        <button type="button" className="storydesk-button" aria-pressed={showStrip || playing} disabled={playing} onClick={() => setShowStrip(!showStrip)}><Film size={15} />镜头条</button>
      </div>
      {shot?.dialogue ? <p className="storydesk-preview-dialogue">{shot.speaker ? `${shot.speaker} · ` : ""}{shot.dialogue}</p> : null}
      {showStrip || playing ? <div className="storydesk-preview-strip" aria-label="镜头条">
        {data.shots.map((item, position) => {
          const frame = board?.shots.find((entry) => entry.shotId === item.id);
          return <button type="button" key={item.id} aria-current={position === index ? "true" : undefined} onClick={() => goTo(position)}>
            <span>{frame?.image ? <img src={api.assetUrl(frame.image.url)} alt="" loading="lazy" /> : <Clapperboard size={15} />}</span>
            <small>{shotNumber(position)} · {shotDuration(item.duration)}</small>
          </button>;
        })}
      </div> : null}
      {error ? <p role="alert" className="story-review-error">{error}</p> : null}
      {draftNote ? <p role="status">{draftNote}</p> : null}
      <footer><span className="storydesk-muted">总计 {shotDuration(data.shots.reduce((sum, item) => sum + item.duration, 0))}</span>
        <button type="button" className="storydesk-button" onClick={() => void exportCsv()}><Download size={15} />导出分镜表</button>
        <button type="button" className="storydesk-button" disabled={exporting || !board} onClick={() => void exportDraft()}>{exporting ? <LoadingIndicator variant="dots" size={24} /> : <Film size={15} />}导出剪映草稿</button>
      </footer>
    </section>
  </div>, document.body);
}
