import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, LoaderCircle, Pause, Play, X } from "lucide-react";
import { api, isTauriRuntime } from "../api";
import type { StoryboardPreviewBoard, StoryboardProjectData } from "../../shared/storyboard-project";

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

export function StoryboardPreview({ id, data, onClose }: { id: string; data: StoryboardProjectData; onClose: () => void }) {
  const [boards, setBoards] = useState<StoryboardPreviewBoard[]>([]);
  const [boardId, setBoardId] = useState("");
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const remaining = useRef(0);
  const mediaRef = useRef<HTMLVideoElement>(null);
  useEffect(() => { let cancelled = false; void api.storyboardPreview(id).then((items) => { if (!cancelled) { setBoards(items); setBoardId(items[0]?.id ?? ""); } }).catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "加载画布失败"); }).finally(() => { if (!cancelled) setLoading(false); }); return () => { cancelled = true; }; }, [id]);
  const board = boards.find((item) => item.id === boardId);
  const shot = data.shots[index];
  const media = board?.shots.find((item) => item.shotId === shot?.id);
  useEffect(() => { remaining.current = (shot?.duration ?? 0) * 1000; }, [shot?.id, shot?.duration, boardId]);
  useEffect(() => {
    const video = mediaRef.current;
    if (video) { if (playing) void video.play().catch(() => undefined); else video.pause(); }
    if (!playing || !shot) return;
    const started = Date.now();
    const timer = window.setTimeout(() => { remaining.current = 0; if (index >= data.shots.length - 1) setPlaying(false); else setIndex(index + 1); }, remaining.current || shot.duration * 1000);
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
  return createPortal(<div className="story-reference-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}><section className="story-preview-dialog" role="dialog" aria-modal="true" aria-label="分镜粗剪预览">
    <header><div><strong>分镜粗剪预览</strong><small>按镜头预估时长播放，供检查节奏；不是成片或精确混音。同画布重复导入时使用最新节点。</small></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={16} /></button></header>
    {loading ? <p><LoaderCircle size={14} className="spin" /> 正在读取画布…</p> : <label>画布 <select value={boardId} onChange={(e) => { setPlaying(false); setBoardId(e.target.value); }}><option value="">仅预览分镜文字</option>{boards.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label>}
    <div className="story-preview-stage" key={`${boardId}-${shot?.id}`}>{media?.video ? <video ref={mediaRef} src={api.assetUrl(media.video.url)} controls muted={Boolean(media.audio)} playsInline /> : media?.image ? <img src={api.assetUrl(media.image.url)} alt={`第 ${index + 1} 镜`} /> : <div>第 {index + 1} 镜尚无画面<br /><small>{shot?.prompt}</small></div>}
      {playing && media?.audio ? <audio src={api.assetUrl(media.audio.url)} autoPlay /> : null}</div>
    <div className="story-preview-details"><strong>第 {index + 1} / {data.shots.length} 镜 · {shot?.duration} 秒</strong><span>{shot?.dialogue || shot?.videoPrompt || shot?.prompt}</span></div>
    <div className="story-preview-strip">{data.shots.map((item, i) => { const frame = board?.shots.find((entry) => entry.shotId === item.id); return <button type="button" key={item.id} className={i === index ? "active" : ""} onClick={() => { setPlaying(false); setIndex(i); }}>{frame?.image ? <img src={api.assetUrl(frame.image.thumbUrl || frame.image.url)} alt="" /> : null}<span>第 {i + 1} 镜<br />{item.duration} 秒</span></button>; })}</div>
    {error ? <p role="alert" className="story-review-error">{error}</p> : null}
    <footer><button type="button" className="secondary-button" onClick={() => { if (!playing && index === data.shots.length - 1) setIndex(0); setPlaying(!playing); }}>{playing ? <Pause size={15} /> : <Play size={15} />}{playing ? "暂停" : "播放"}</button><span>总计 {data.shots.reduce((sum, item) => sum + item.duration, 0).toFixed(1)} 秒</span><button type="button" className="secondary-button" onClick={() => void exportCsv()}><Download size={15} />导出分镜表及素材清单</button></footer>
  </section></div>, document.body);
}
