import { LoadingIndicator } from "../ui/LoadingIndicator";
import { useEffect, useRef, useState } from "react";
import { Copy, Download, Eraser, Eye, Film, FolderOpen, History, Image as ImageIcon, LayoutGrid, Music, RefreshCw, RotateCcw, Settings2, Trash2, Wand2, X } from "lucide-react";
import { CrossModeBridgeDialog, type BridgeAssetItem } from "../board/CrossModeBridgeDialog";
import { api } from "../api";
import { LazyVideoThumb } from "../LazyVideoThumb";
import { StatusBadge, formatTime, terminalStatuses } from "../task-ui";
import { taskKind, type Asset, type ClearScope, type Channel, type Task } from "../../shared/types";
import { isSunoSong, sunoResultLabel, sunoTrackInfo, type SunoSourceSelection } from "../../shared/suno";
import type { ReferenceController, Toast } from "../app-shared";
import { copyImageToClipboard } from "../clipboard";
import { ImageActionMenu } from "../ui/ImageActionMenu";
import { retryImageResult } from "./image-result-actions";

export function HistoryView({ channels, tasks, references, onRefresh, onDelete, onDeleteSelected, onClear, onOpenAssetSettings, onDiagnostics, onImageTask, onUseMusicSource, onToast }: {
  channels: Channel[];
  tasks: Task[];
  references: ReferenceController;
  onRefresh: () => void;
  onDelete: (task: Task) => void;
  onDeleteSelected: (tasks: Task[]) => void;
  onClear: (scope: ClearScope, records: Task[]) => void;
  onOpenAssetSettings: () => void;
  onDiagnostics: (task: Task) => void;
  onImageTask: (task: Task) => void;
  onUseMusicSource?: (selection: SunoSourceSelection) => void;
  onToast: (kind: Toast["kind"], message: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | "image" | "video" | "audio">("all");
  const [mode, setMode] = useState<"assets" | "records">("records");
  const [query, setQuery] = useState("");
  const [visibleCount, setVisibleCount] = useState(60);
  const [library, setLibrary] = useState<Task[]>([]);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [libraryRevision, setLibraryRevision] = useState(0);
  const requestId = useRef(0);
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const filterKeyRef = useRef("");
  const [preview, setPreview] = useState<Task | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [bridgeItems, setBridgeItems] = useState<BridgeAssetItem[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const selectAllRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    let timer: number | undefined;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setLibraryRevision(value => value + 1), 250);
    };
    const close = api.openTaskStream({
      onTask: task => { if (task.status === "queued" || terminalStatuses.includes(task.status)) refresh(); },
      onOpen: refresh,
      onError: () => undefined,
    }, "library");
    return () => { window.clearTimeout(timer); close(); };
  }, []);
  useEffect(() => {
    const current = ++requestId.current;
    const filterKey = JSON.stringify([query, filter, mode]);
    const changingFilter = filterKeyRef.current !== filterKey;
    filterKeyRef.current = filterKey;
    const targetCount = changingFilter ? 60 : Math.max(60, libraryRef.current.length);
    setLoading(true);
    if (changingFilter) { setLibrary([]); setHasMore(false); }
    const timer = window.setTimeout(() => {
      void (async () => {
        const items: Task[] = [];
        let more = true;
        while (more && items.length < targetCount && current === requestId.current) {
          const page = await api.libraryPage({ offset: items.length, query, kind: filter, mode, includeChat: true });
          items.push(...page.items);
          more = page.hasMore && page.items.length > 0;
        }
        return { items, hasMore: more };
      })().then((page) => {
        if (current === requestId.current) { setLibrary(page.items); setHasMore(page.hasMore); setLoadError(""); }
      }).catch((error) => { if (current === requestId.current) setLoadError(error instanceof Error ? error.message : "加载素材失败"); })
        .finally(() => { if (current === requestId.current) setLoading(false); });
    }, query ? 250 : 0);
    return () => { window.clearTimeout(timer); requestId.current++; };
  }, [tasks, query, filter, mode, libraryRevision]);
  async function loadMore() {
    if (loading || !hasMore) return;
    const current = requestId.current;
    setLoading(true);
    try {
      const page = await api.libraryPage({ offset: library.length, query, kind: filter, mode, includeChat: true });
      if (current === requestId.current) { setLibrary((items) => [...items, ...page.items]); setHasMore(page.hasMore); setVisibleCount((count) => count + 60); setLoadError(""); }
    } catch (error) { if (current === requestId.current) setLoadError(error instanceof Error ? error.message : "加载素材失败"); }
    finally { if (current === requestId.current) setLoading(false); }
  }
  const records = library.filter((task) => task.origin !== "upload");
  const searchable = library.filter((task) => `${task.prompt} ${task.model} ${task.channelName} ${task.assets.map((asset) => `${asset.fileName} ${asset.title ?? ""}`).join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));
  const imageTasks = searchable.filter((task) => taskKind(task, channels) === "image");
  const videoTasks = searchable.filter((task) => taskKind(task, channels) === "video");
  const audioTasks = searchable.filter((task) => taskKind(task, channels) === "audio");
  const filtered = filter === "image" ? imageTasks
    : filter === "video" ? videoTasks
    : filter === "audio" ? audioTasks
    : searchable;
  const filteredRecords = filtered.filter((task) => task.origin !== "upload");
  const visibleRecords = filteredRecords.slice(0, visibleCount);
  const filteredAssets = filtered.flatMap((task) => task.assets.map((asset, index) => ({ task, asset, index })));
  const visibleAssets = filteredAssets.slice(0, visibleCount);
  const selectedTasks = records.filter((task) => selected.has(task.id));
  // 聊天生成的记录也能勾选：删的时候会连带把对话里的引用摘掉（见 App.confirmClear）
  const selectableRecords = visibleRecords;
  const allFilteredSelected = selectableRecords.length > 0 && selectableRecords.every(task => selected.has(task.id));

  // 列表刷新后，已经被删掉/过期的勾选要跟着清掉，否则「已选 N 条」和实际能删的对不上
  useEffect(() => {
    setSelected((current) => {
      if (!current.size) return current;
      const alive = new Set(library.map((task) => task.id));
      const next = new Set([...current].filter((id) => alive.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [library]);

  // 半选状态只能通过 DOM 属性设置，React 没有对应的 prop
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selected.size > 0 && !allFilteredSelected;
  }, [selected, allFilteredSelected]);

  /** 换筛选时清空勾选：勾中的可能已经不在眼前，留着会出现「看不见却被删掉」 */
  function changeFilter(next: "all" | "image" | "video" | "audio") {
    setFilter(next);
    setVisibleCount(60);
    setSelected(new Set());
  }

  function toggleAll() {
    setSelected(allFilteredSelected ? new Set() : new Set(selectableRecords.map(task => task.id)));
  }

  function toggleOne(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function deleteAsset(task: Task, asset: Asset) {
    const fromChat = task.historySource === "chat";
    if (!window.confirm(fromChat
      ? "这条素材来自对话，删除会移除整条生成记录，对话里对应的图也会一起消失。确定删除？"
      : "确定删除这个素材及其本地文件？生成记录和其他素材会保留。")) return;
    try {
      if (fromChat) await api.deleteTask(task.id, false, true);
      else await api.deleteLibraryAsset(asset.id);
      // 让开始于删除前的分页请求失效。
      requestId.current++;
      setLoading(false);
      setLibrary(items => fromChat
        ? items.filter(item => item.id !== task.id)
        : items.map(item => item.id === task.id ? { ...item, assets: item.assets.filter(entry => entry.id !== asset.id) } : item));
      onRefresh();
      onToast("success", fromChat ? "记录已删除" : "素材已删除");
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : fromChat ? "删除记录失败" : "删除素材失败");
    }
  }

  // 图片视频都落在应用数据目录里，路径不好记，给个按钮直接翻到那儿
  async function revealMedia() {
    try {
      const result = await api.revealMedia();
      onToast("success", `已打开素材目录：${result.opened}`);
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "打开素材目录失败");
    }
  }

  /**
   * 清理失效记录：渠道早被删、产物文件也已经不在磁盘上的那些孤儿行。
   *
   * 先问条数再删，避免用户以为会清掉整个列表；服务端只挑「文件真的没了」的，
   * 还能打开的记录一条都不动。
   */
  async function cleanStale() {
    try {
      const { count } = await api.staleTasks();
      if (!count) { onToast("success", "没有失效记录"); return; }
      if (!window.confirm(`发现 ${count} 条失效记录（渠道已删除、产物文件已丢失），清理后不可恢复。确定清理？`)) return;
      const result = await api.cleanStaleTasks();
      onToast("success", `已清理 ${result.deleted} 条失效记录`);
      requestId.current++;
      onRefresh();
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "清理失效记录失败");
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div><h1>素材管理</h1><span className="page-kicker">ASSETS & HISTORY</span></div>
        <div className="header-actions">
          <div className="filter-tabs"><button className={mode === "assets" ? "active" : ""} onClick={() => { setMode("assets"); setVisibleCount(60); setSelected(new Set()); }}>素材</button><button className={mode === "records" ? "active" : ""} onClick={() => { setMode("records"); setVisibleCount(60); setSelected(new Set()); }}>生成记录</button></div>
          {selected.size ? (
            <div className="selection-bar">
              <span>已选 <strong>{selected.size}</strong> 条</span>
              <button className="secondary-button danger" onClick={() => onDeleteSelected(selectedTasks)}><Trash2 size={16} />删除选中</button>
              <button className="secondary-button" onClick={() => setSelected(new Set())}>取消选择</button>
            </div>
          ) : null}
          {mode === "records" ? <button className="secondary-button" title="清空对应类型的全部公共生成记录，不受搜索影响" onClick={() => void api.library().then((items) => onClear(filter, items.filter((task) => task.origin !== "upload" && (filter === "all" || taskKind(task, channels) === filter)))).catch((error) => onToast("error", error instanceof Error ? error.message : "加载记录失败"))}><Trash2 size={16} />清空记录</button> : null}
          {mode === "records" ? <button className="secondary-button" title="清理「渠道已删除、产物文件也已丢失」的孤儿记录；还能显示的记录一条都不动" onClick={() => void cleanStale()}><Eraser size={16} />清理失效</button> : null}
          <button className="secondary-button" title="打开图片与视频的保存目录" onClick={() => void revealMedia()}><FolderOpen size={16} />素材目录</button>
          <button className="secondary-button" title="素材目录、gemini 渠道缺省输出尺寸" onClick={onOpenAssetSettings}><Settings2 size={16} />设置</button>
          <button className="icon-button header-icon" title="刷新历史" onClick={onRefresh}><RefreshCw size={17} /></button>
        </div>
      </div>
      <div className="library-toolbar">
          <div className="filter-tabs">
            <button className={filter === "all" ? "active" : ""} onClick={() => changeFilter("all")}>全部</button>
            <button className={filter === "image" ? "active" : ""} onClick={() => changeFilter("image")}>图片</button>
            <button className={filter === "video" ? "active" : ""} onClick={() => changeFilter("video")}>视频</button>
            <button className={filter === "audio" ? "active" : ""} onClick={() => changeFilter("audio")}>音频</button>
          </div>
        <input value={query} onChange={(event) => { setQuery(event.target.value); setVisibleCount(60); setSelected(new Set()); }} placeholder="搜索提示词、文件名、模型或渠道" aria-label="搜索素材和记录" />
      </div>
      {loadError ? <p role="alert">素材加载失败：{loadError}</p> : null}
      {mode === "assets" ? <div className="library-grid">
        {visibleAssets.map(({ task, asset, index }) => (
          <LibraryAssetCard key={asset.id} task={task} asset={asset} references={references}
            onPreview={() => { setPreviewIndex(index); setPreview(task); }}
            onDelete={() => void deleteAsset(task, asset)} onDiagnostics={onDiagnostics} onImageTask={onImageTask} onToast={onToast} />
        ))}
        {!loading && !filtered.some((task) => task.assets.length) && !loadError ? <div className="table-empty"><ImageIcon size={28} /><span>没有符合条件的素材</span></div> : null}
      </div> :
      <div className="data-table-wrap">
        <table className="data-table history-table">
          <thead><tr>
            <th className="history-select"><input ref={selectAllRef} type="checkbox" checked={allFilteredSelected} disabled={!selectableRecords.length} onChange={toggleAll} aria-label="全选已显示的记录" /></th>
            <th aria-label="预览" /><th>任务</th><th>渠道</th><th>模型</th><th>状态</th><th>时间</th><th aria-label="操作" />
          </tr></thead>
          <tbody>{visibleRecords.map((task) => {
            const kind = taskKind(task, channels);
            const first = task.assets[0];
            return (
              <tr key={task.id} className={selected.has(task.id) ? "selected" : ""}>
                <td className="history-select"><input type="checkbox" checked={selected.has(task.id)} onChange={() => toggleOne(task.id)} aria-label="勾选该记录" /></td>
                <td>
                  <button type="button" className="history-thumb" title={task.assets.length ? "查看详情" : "暂无产物"} onClick={() => { if (task.assets.length) { setPreviewIndex(0); setPreview(task); } }}>
                    {first
                      ? kind === "video"
                        ? <LazyVideoThumb src={api.assetUrl(first.url)} alt="生成结果缩略图" />
                        : kind === "audio"
                          ? first.thumbUrl
                            ? <img src={api.assetUrl(first.thumbUrl)} alt="" loading="lazy" decoding="async" />
                            : <Music size={16} />
                          : <img src={api.assetUrl(first.url)} alt="生成结果缩略图" loading="lazy" decoding="async" />
                      : <span className="history-thumb-empty">{kind === "video" ? <Film size={16} /> : kind === "audio" ? <Music size={16} /> : <ImageIcon size={16} />}</span>}
                    {task.assets.length > 1 ? <span className="history-thumb-count">{task.assets.length}</span> : null}
                  </button>
                </td>
                <td><button className="prompt-cell" title={task.assets.length ? "查看详情" : task.prompt} onClick={() => { if (task.assets.length) { setPreviewIndex(0); setPreview(task); } }}>{task.historySource === "chat" ? "聊天生成 · " : ""}{task.prompt}</button></td>
                <td>{task.channelName}</td><td>{task.model}</td>
                <td><StatusBadge status={task.status} /></td><td>{formatTime(task.createdAt)}</td>
                <td><div className="table-actions">
                  <button className="icon-button" title="查看诊断" onClick={() => onDiagnostics(task)}><Eye size={16} /></button>
                  <button className="icon-button danger" title={task.historySource === "chat" ? "删除记录（对话里的这张图也会一起移除）" : "删除记录"} onClick={() => onDelete(task)}><Trash2 size={16} /></button>
                </div></td>
              </tr>
            );
          })}</tbody>
        </table>
        {!loading && !filteredRecords.length && !loadError ? <div className="table-empty"><History size={28} /><span>暂无生成记录</span></div> : null}
      </div>}
      {loading ? <div className="table-empty" role="status"><LoadingIndicator variant="spectrum" /><span>加载中…</span></div> : null}
      {!loading && visibleCount < (mode === "assets" ? filteredAssets.length : filteredRecords.length) ? <button type="button" className="secondary-button" onClick={() => setVisibleCount((count) => count + 60)}>显示更多</button> : !loading && hasMore ? <button type="button" className="secondary-button" onClick={() => void loadMore()}>加载更多</button> : null}
      {preview ? <HistoryPreview task={preview} initialIndex={previewIndex} channels={channels} references={references} onClose={() => setPreview(null)} onSendToBoard={(asset) => { setPreview(null); setBridgeItems([{ assetId: asset.id, title: asset.title || asset.fileName, prompt: preview.prompt }]); }} onUseMusicSource={onUseMusicSource} onToast={onToast} /> : null}
      {bridgeItems ? <CrossModeBridgeDialog mode="to-board" items={bridgeItems} onClose={() => setBridgeItems(null)} onToast={onToast} /> : null}
    </div>
  );
}

function LibraryAssetCard({ task, asset, references, onPreview, onDelete, onDiagnostics, onImageTask, onToast }: {
  task: Task;
  asset: Asset;
  references: ReferenceController;
  onPreview: () => void;
  onDelete: () => void;
  onDiagnostics: (task: Task) => void;
  onImageTask: (task: Task) => void;
  onToast: (kind: Toast["kind"], message: string) => void;
}) {
  const [action, setAction] = useState<"download" | "copy" | "retry" | null>(null);
  const isVideo = asset.mimeType.startsWith("video/");
  const isAudio = asset.mimeType.startsWith("audio/");
  const isImage = asset.mimeType.startsWith("image/");
  const uploaded = task.origin === "upload";
  const fromChat = task.historySource === "chat";
  const pending = !terminalStatuses.includes(task.status);
  const continueQuery = task.errorCode === "VIDEO_TIMEOUT";
  async function run(kind: NonNullable<typeof action>, perform: () => Promise<void>, fallback: string) {
    if (action) return;
    setAction(kind);
    try { await perform(); }
    catch (error) { onToast("error", error instanceof Error ? error.message : fallback); }
    finally { setAction(null); }
  }
  const original = api.assetUrl(asset.url);
  const thumb = asset.thumbUrl ? api.assetUrl(asset.thumbUrl) : original;
  const content = <>
    <button type="button" className="library-card" onClick={onPreview}>
      <span className="library-card-media">
        {isVideo ? <LazyVideoThumb src={original} alt="视频预览" /> : isAudio && !asset.thumbUrl ? <Music size={32} /> : (
          <img src={thumb} alt="" loading="lazy" onError={(event) => {
            if (event.currentTarget.getAttribute("src") !== original) event.currentTarget.src = original;
          }} />
        )}
      </span>
      <span className="library-card-title">{asset.title || task.prompt || asset.fileName}</span>
      <span className="library-card-meta">{fromChat ? "聊天生成" : uploaded ? "上传" : "生成"} · {formatTime(asset.createdAt)}</span>
    </button>
    <button type="button" className="library-card-delete" title={fromChat ? "删除整条记录" : "删除素材"}
      aria-label={`删除素材 ${asset.title || asset.fileName}`} onClick={onDelete}><Trash2 size={16} /></button>
  </>;
  if (!isImage) return <div className="library-card-wrap">{content}</div>;

  return (
    <ImageActionMenu className="library-card-wrap" shortcuts={[
      { label: "下载", tooltip: "下载原图", icon: Download, disabled: Boolean(action), onSelect: () => void run("download", async () => {
        if (await api.downloadAsset(asset)) onToast("success", "图片已保存");
      }, "下载失败") },
      { label: "参考", tooltip: "用作参考图", icon: Wand2, disabled: references.reading, onSelect: () => void references.addFromAsset(asset) },
    ]} actions={[
      { label: "复制", icon: Copy, disabled: Boolean(action), onSelect: () => void run("copy", async () => {
        await copyImageToClipboard(() => api.assetAsFile(asset));
        onToast("success", "图片已复制到剪贴板");
      }, "复制图片失败") },
      { label: continueQuery ? "续查" : "重绘", icon: RotateCcw, disabled: Boolean(action) || uploaded || fromChat || pending,
        tooltip: uploaded ? "上传的图片可先用作参考图" : fromChat ? "回到原对话重绘" : pending ? "任务仍在生成中" : continueQuery ? "继续查询原任务" : "按原参数重新生成",
        onSelect: () => void run("retry", () => retryImageResult(task, onImageTask, onToast), "重试失败") },
      { label: "诊断", tooltip: uploaded ? "上传的图片没有生成诊断" : "查看请求诊断", icon: Eye, disabled: uploaded, onSelect: () => onDiagnostics(task) },
    ]}>{content}</ImageActionMenu>
  );
}

function HistoryPreview({ task, initialIndex, channels, references, onClose, onSendToBoard, onUseMusicSource, onToast }: {
  task: Task;
  initialIndex: number;
  channels: Channel[];
  references: ReferenceController;
  onClose: () => void;
  onSendToBoard: (asset: import("../../shared/types").Asset) => void;
  onUseMusicSource?: (selection: SunoSourceSelection) => void;
  onToast: (kind: Toast["kind"], message: string) => void;
}) {
  const [index, setIndex] = useState(initialIndex);
  const [downloading, setDownloading] = useState(false);
  const kind = taskKind(task, channels);
  const isVideo = kind === "video";
  const asset = task.assets[Math.min(index, task.assets.length - 1)];
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  async function download() {
    if (!asset) return;
    setDownloading(true);
    try { if (await api.downloadAsset(asset)) onToast("success", isVideo ? "视频已保存" : kind === "audio" ? "音频已保存" : "图片已保存"); }
    catch (error) { onToast("error", error instanceof Error ? error.message : "下载失败"); }
    finally { setDownloading(false); }
  }
  if (!asset) return null;
  const isAssetVideo = asset.mimeType.startsWith("video/");
  const isAssetAudio = asset.mimeType.startsWith("audio/");
  const musicLabel = sunoResultLabel(sunoTrackInfo(task, asset.remoteClipId));
  const canUseMusicSource = isSunoSong(task, asset)
    && channels.some(channel => channel.id === task.channelId && channel.enabled && channel.adapterType === "suno-music");
  return (
    <div className="image-preview-backdrop" role="dialog" aria-modal="true" aria-label="历史预览" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="image-preview history-preview">
        {/* disablePictureInPicture / disableRemotePlayback 去掉悬停时浮出的「画中画」「投屏」按钮 */}
        {isAssetAudio ? (
          <div className="history-audio-preview">
            {asset.thumbUrl ? <img src={api.assetUrl(asset.thumbUrl)} alt="" /> : <Music size={76} />}
            <strong>{asset.title || task.prompt}</strong>
            {musicLabel ? <small>{musicLabel}</small> : null}
            <audio src={api.assetUrl(asset.url)} controls controlsList="nodownload" autoPlay onContextMenu={(event) => event.preventDefault()} />
            {asset.lyrics ? (
              <details className="music-lyrics history-lyrics">
                <summary>歌词</summary>
                <pre>{asset.lyrics}</pre>
              </details>
            ) : null}
          </div>
        ) : isAssetVideo ? (
          <video src={api.assetUrl(asset.url)} controls controlsList="nodownload" autoPlay loop disablePictureInPicture disableRemotePlayback onContextMenu={(event) => event.preventDefault()} />
        ) : (
          <img src={api.assetUrl(asset.url)} alt="历史生成大图" />
        )}
        <div className="history-preview-bar">
          <button type="button" className="secondary-button" disabled={downloading} onClick={() => void download()}>{downloading ? <LoadingIndicator variant="dots" size={24} /> : <Download size={16} />}下载</button>
          {canUseMusicSource && onUseMusicSource ? (["cover", "mashup"] as const).map(mode => (
            <button key={mode} type="button" className="secondary-button" onClick={() => onUseMusicSource({ mode, task, asset })}>
              {mode === "cover" ? "翻唱" : "混音"}
            </button>
          )) : null}
          {task.historySource !== "chat" ? <button type="button" className="secondary-button" onClick={() => onSendToBoard(asset)}><LayoutGrid size={16} />加入画布</button> : null}
          {!isVideo && kind !== "audio" ? <button type="button" className="secondary-button" disabled={references.reading} onClick={() => void references.addFromAsset(asset)}><Wand2 size={16} />添加到参考图</button> : null}
          {task.assets.length > 1 ? <div className="history-preview-thumbs">{task.assets.map((item, i) => {
            const thumbIsVideo = item.mimeType.startsWith("video/");
            const thumbIsAudio = item.mimeType.startsWith("audio/");
            return (
              <button key={item.id} type="button" className={`stage-thumb ${i === index ? "active" : ""}`} onClick={() => setIndex(i)}>
                {thumbIsVideo
                  ? <video src={api.assetUrl(item.url)} muted playsInline preload="metadata" onContextMenu={(event) => event.preventDefault()} />
                  : thumbIsAudio
                    ? item.thumbUrl ? <img src={api.assetUrl(item.thumbUrl)} alt="" loading="lazy" /> : <Music size={16} />
                    : <img src={api.assetUrl(item.url)} alt={`结果 ${i + 1}`} loading="lazy" decoding="async" />}
              </button>
            );
          })}</div> : null}
        </div>
        <button type="button" className="image-preview-close" title="关闭预览" aria-label="关闭预览" onClick={onClose}><X size={21} /></button>
      </div>
    </div>
  );
}

/**
 * 清空历史 / 删除记录的确认弹窗。
 *
 * 除了二次确认，还要问清楚磁盘上的图片视频删不删——以前是直接删，
 * 想留图的用户只能自己去素材目录翻。
 */
export function ClearHistoryDialog({ mode, count, label, hasChatRecords, onClose, onConfirm }: {
  mode: "task" | "selection" | "scope";
  count: number;
  label: string;
  /** 选中里有聊天生成的记录：对话里的那张图会跟着消失，得先说清楚 */
  hasChatRecords?: boolean;
  onClose: () => void;
  onConfirm: (keepFiles: boolean) => Promise<void>;
}) {
  // 默认连文件一起删：和改动前的行为一致，也避免磁盘无限增长
  const [deleteFiles, setDeleteFiles] = useState(true);
  const [busy, setBusy] = useState(false);
  // 「清空」和「删除选中的几条」是两件事，标题和按钮都得分开说
  const scopeClear = mode === "scope";
  const title = scopeClear ? "清空历史" : mode === "selection" ? "删除选中的记录" : "删除记录";

  async function confirm() {
    setBusy(true);
    try { await onConfirm(!deleteFiles); } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="modal narrow" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <div><Trash2 size={18} /><h2>{title}</h2></div>
          <button className="icon-button" title="关闭" onClick={onClose} disabled={busy}><X size={18} /></button>
        </div>
        <div className="modal-body">
          <p className="modal-lead">将删除 {count} 条{label}。删除记录不可恢复，请确认本地文件怎么处理。</p>
          {hasChatRecords ? (
            <p className="modal-note">其中包含聊天生成的记录：删除后，对话里对应的图片也会一起消失（消息、画布、分镜里的引用会同步摘掉）。</p>
          ) : null}
          <div className="confirm-options" role="radiogroup" aria-label="本地文件处理方式">
            <label className={`confirm-option ${deleteFiles ? "selected" : ""}`}>
              <input type="radio" name="clear-files" checked={deleteFiles} onChange={() => setDeleteFiles(true)} />
              <span>
                <strong>同时删除本地文件</strong>
                <small>记录和磁盘上的图片、视频一起删除，无法恢复。该任务上传的参考图也会一并清理。</small>
              </span>
            </label>
            <label className={`confirm-option ${!deleteFiles ? "selected" : ""}`}>
              <input type="radio" name="clear-files" checked={!deleteFiles} onChange={() => setDeleteFiles(false)} />
              <span>
                <strong>仅删除记录，保留本地文件</strong>
                <small>图片和视频留在素材目录里，只是不再显示在生成历史中，之后可以自己去目录里整理。</small>
              </span>
            </label>
          </div>
        </div>
        <div className="modal-footer">
          <button className="secondary-button" onClick={onClose} disabled={busy}>取消</button>
          <button className="primary-button danger" onClick={() => void confirm()} disabled={busy}>
            {busy ? <LoadingIndicator variant="dots" size={24} /> : <Trash2 size={16} />}
            {scopeClear ? `清空 ${count} 条` : count === 1 ? "删除" : `删除 ${count} 条`}
          </button>
        </div>
      </div>
    </div>
  );
}

