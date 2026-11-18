import { useEffect, useId, useRef, useState, type Dispatch, type KeyboardEvent, type SetStateAction } from "react";
import { AudioLines, Check, CircleCheck, CloudUpload, CornerDownLeft, Eye, Globe2, Grid2X2, ImageIcon, Layers3, List, Play, Search, Trash2, Video, X } from "lucide-react";
import { api } from "../api";
import { formatDuration } from "../task-ui";
import { LoadingIndicator } from "../ui/LoadingIndicator";
import type { Asset } from "../../shared/types";
import type { UseBoardResult } from "./useBoard";

type AssetType = "all" | "image" | "video" | "audio";
type MaterialSource = "board" | "shared";
const assetFilters = [
  { type: "all", label: "全部", icon: null },
  { type: "image", label: "图片", icon: ImageIcon },
  { type: "video", label: "视频", icon: Video },
  { type: "audio", label: "音频", icon: AudioLines },
] as const;

function matchesType(asset: Asset, type: AssetType) {
  return type === "all" || asset.mimeType.startsWith(`${type}/`);
}

function MaterialCard({ asset, selected, disabled, onSelect, onPreview }: {
  asset: Asset;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onPreview: () => void;
}) {
  const name = asset.title || asset.fileName;
  const video = matchesType(asset, "video");
  const audio = matchesType(asset, "audio");
  const duration = asset.duration && asset.duration > 0 ? formatDuration(asset.duration) : null;
  const originalUrl = api.assetUrl(asset.url);
  return (
    <article className={`board-material-card${selected ? " is-selected" : ""}`}>
      <button type="button" className={`board-material-tile${audio ? " is-audio" : ""}`}
        aria-pressed={selected} aria-label={name} title={name} disabled={disabled}
        onClick={onSelect} onDoubleClick={onPreview}>
        <span className="board-material-cover" aria-hidden="true">
          {video ? <video src={`${originalUrl}#t=0.1`} muted playsInline preload="metadata" />
            : audio && !asset.thumbUrl ? <AudioLines size={38} strokeWidth={1.4} />
            : <img src={api.assetUrl(asset.thumbUrl ?? asset.url)} alt="" loading="lazy" onError={(event) => {
              const image = event.currentTarget;
              if (!audio && image.getAttribute("src") !== originalUrl) image.src = originalUrl;
              else image.style.visibility = "hidden";
            }} />}
          {duration ? <span className="board-material-duration">{duration}</span> : null}
        </span>
        <span className="board-material-details">
          <strong>{name}</strong>
          <small>{video ? "视频" : audio ? "音频" : "图片"}{duration ? ` · ${duration}` : ""}</small>
        </span>
        {selected ? <span className="board-material-mark" aria-hidden="true"><Check size={14} strokeWidth={2.5} /></span> : null}
      </button>
      <button type="button" className={`board-material-preview${video ? " is-video" : ""}`} aria-label={`预览 ${name}`} title="预览"
        disabled={disabled} onClick={onPreview}>{video ? <Play size={15} fill="currentColor" /> : <Eye size={16} />}</button>
    </article>
  );
}

/** 画布素材选择与公共素材分页。 */
export function BoardMaterialDialog({ board, currentId, boardAssets, assetSearch, setAssetSearch, assetType, setAssetType, setAssets, targetNodeId, onUseReferenceImage, onPreview, previewOpen, onClose, onToast }: {
  board: UseBoardResult;
  currentId: string | null;
  boardAssets: Asset[];
  assetSearch: string;
  setAssetSearch: Dispatch<SetStateAction<string>>;
  assetType: AssetType;
  setAssetType: Dispatch<SetStateAction<AssetType>>;
  setAssets: Dispatch<SetStateAction<Map<string, Asset>>>;
  targetNodeId: string | null;
  onUseReferenceImage?: (asset: Asset) => Promise<boolean>;
  onPreview: (asset: Asset) => void;
  previewOpen: boolean;
  onClose: () => void;
  onToast: (kind: "success" | "error", message: string) => void;
}) {
  const [source, setSource] = useState<MaterialSource>("board");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sharedAssets, setSharedAssets] = useState<Asset[]>([]);
  const [sharedOffset, setSharedOffset] = useState(0);
  const [sharedMore, setSharedMore] = useState(false);
  const [sharedLoading, setSharedLoading] = useState(false);
  const sharedRequestRef = useRef(0);
  const uploadRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [uploadVersion, setUploadVersion] = useState(0);
  const single = Boolean(targetNodeId || onUseReferenceImage);
  const title = onUseReferenceImage ? "添加引用图片" : targetNodeId ? "选择素材填入节点" : "选择素材";
  const actionLabel = onUseReferenceImage ? "添加引用" : targetNodeId ? "使用素材" : "插入画布";
  const query = assetSearch.trim().toLowerCase();
  const matchingBoardAssets = boardAssets.filter((asset) =>
    `${asset.title ?? ""} ${asset.fileName} ${asset.tags ?? ""}`.toLowerCase().includes(query));
  const boardAssetIds = new Set(boardAssets.map((asset) => asset.id));
  const visibleAssets = (source === "board" ? matchingBoardAssets : sharedAssets.filter((asset) => !boardAssetIds.has(asset.id)))
    .filter((asset) => matchesType(asset, assetType));
  const visibleById = new Map(visibleAssets.map((asset) => [asset.id, asset]));
  const selectedAssets = selectedIds.flatMap((id) => {
    const asset = visibleById.get(id);
    return asset ? [asset] : [];
  });

  useEffect(() => {
    const opener = document.activeElement;
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus(); };
  }, []);

  useEffect(() => {
    if (!previewOpen) dialogRef.current?.focus();
  }, [previewOpen]);

  function resetSelection() {
    setSelectedIds([]);
    if (resultsRef.current) resultsRef.current.scrollTop = 0;
  }

  function changeSource(next: MaterialSource) {
    if (next === source) return;
    resetSelection();
    setSource(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    event.stopPropagation();
    if (event.key === "Escape" && !busy) {
      event.preventDefault();
      onClose();
    }
    if (event.key !== "Tab") return;
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not([tabindex='-1'])")];
    const first = focusable[0];
    const last = focusable.at(-1);
    if ((event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget))
      || (!event.shiftKey && document.activeElement === last)) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    }
  }

  function selectAsset(id: string) {
    if (selectedIds.includes(id)) setSelectedIds((ids) => ids.filter((item) => item !== id));
    else setSelectedIds((ids) => single ? [id] : [...ids, id]);
  }

  async function useAsset(asset: Asset) {
    if (!currentId) return;
    if (onUseReferenceImage) {
      if (await onUseReferenceImage(asset)) onClose();
      return;
    }
    if (!targetNodeId) return;
    const node = board.view?.doc.nodes.find((item) => item.id === targetNodeId);
    if (!node || (node.type !== "image" && node.type !== "video" && node.type !== "audio") || node.status === "loading") { onToast("error", "节点不存在或正在生成，请稍后再试"); return; }
    if (!asset.mimeType.startsWith(`${node.type}/`)) { onToast("error", "素材类型与节点不匹配"); return; }
    try {
      if (!await board.ensureSaved()) { onToast("error", "画布尚未保存，请等待恢复后再选择素材"); return; }
      await api.linkBoardAsset(currentId, asset.id);
      setAssets((items) => new Map(items).set(asset.id, asset));
      board.updateNode(targetNodeId, { assetId: asset.id, source: node.type === "image" ? "library" : "upload", status: "succeeded" });
      onToast("success", "已将素材放入节点");
      onClose();
    } catch (error) { onToast("error", error instanceof Error ? error.message : "选择素材失败"); }
  }

  async function confirmSelection() {
    if (!currentId || busy || !selectedAssets.length) return;
    setBusy(true);
    let inserted = 0;
    try {
      if (single) {
        await useAsset(selectedAssets[0]!);
        return;
      }
      if (source === "board") {
        const wanted = new Set(selectedAssets.map((asset) => asset.id));
        const nodes = (board.view?.doc.nodes ?? []).flatMap((node) => {
          if ((node.type === "image" || node.type === "video" || node.type === "audio") && node.assetId && wanted.delete(node.assetId)) return [node.id];
          return [];
        });
        const ids = board.duplicateNodes(nodes);
        if (!ids.length) return;
        board.setSelection(ids);
        inserted = ids.length;
      } else {
        if (!await board.ensureSaved()) throw new Error("画布尚未保存，请稍后再插入素材");
        for (let start = 0; start < selectedAssets.length; start += 50) {
          const batch = selectedAssets.slice(start, start + 50);
          const result = await api.addAssetsToBoard(currentId, batch.map((asset) => ({ assetId: asset.id })));
          const added = new Set(result.added.map((item) => item.assetId));
          inserted += added.size;
          setAssets((items) => {
            const next = new Map(items);
            for (const asset of batch) if (added.has(asset.id)) next.set(asset.id, asset);
            return next;
          });
        }
        if (inserted) await board.reload();
      }
      if (!inserted) throw new Error("素材未能插入画布");
      if (inserted < selectedAssets.length) onToast("error", `已插入 ${inserted} 项，还有 ${selectedAssets.length - inserted} 项未能插入`);
      else onToast("success", `已插入 ${inserted} 项素材`);
      onClose();
    } catch (error) {
      if (source === "shared" && inserted) await board.reload();
      const fallback = onUseReferenceImage ? "添加引用失败" : "插入素材失败";
      onToast("error", `${inserted ? `已插入 ${inserted} 项，` : ""}${error instanceof Error ? error.message : fallback}`);
    } finally {
      setBusy(false);
    }
  }

  async function removeSelection() {
    if (busy || source !== "board" || !selectedAssets.length) return;
    if (!window.confirm(`从当前画布移除 ${selectedAssets.length} 项素材？引用它们的节点会被清空，素材文件会保留。`)) return;
    setBusy(true);
    try {
      if (!await board.ensureSaved()) throw new Error("画布尚未保存，请稍后再移除素材");
      for (const asset of selectedAssets) await board.removeAsset(asset.id);
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "移除素材失败");
    } finally {
      setBusy(false);
    }
  }

  async function uploadFiles(files: File[]) {
    if (!currentId || busy) return;
    setBusy(true);
    const uploaded: Asset[] = [];
    try {
      for (const file of files) uploaded.push(await api.uploadBoardAsset(currentId, file));
      if (onUseReferenceImage && uploaded[0]) {
        if (await onUseReferenceImage(uploaded[0])) onClose();
      } else onToast("success", `已上传 ${uploaded.length} 个文件到素材库`);
    } catch (error) { onToast("error", `${uploaded.length ? `已上传 ${uploaded.length} 个；` : ""}${error instanceof Error ? error.message : "上传失败"}`); }
    finally {
      if (uploaded.length) {
        setAssets((items) => { const next = new Map(items); for (const asset of uploaded) next.set(asset.id, asset); return next; });
        setAssetSearch("");
        if (!onUseReferenceImage) {
          if (!targetNodeId) setAssetType("all");
          resetSelection();
          setSource("shared");
        }
        setUploadVersion((value) => value + 1);
      }
      setBusy(false);
    }
  }

  useEffect(() => {
    if (source !== "shared") return;
    const requestId = ++sharedRequestRef.current;
    let active = true;
    setSharedAssets([]); setSharedOffset(0); setSharedMore(false); setSharedLoading(true);
    const timer = window.setTimeout(() => void api.libraryPage({ query: assetSearch, kind: assetType, mode: "assets" }).then((page) => {
      if (active) { setSharedAssets(page.items.flatMap((task) => task.assets)); setSharedOffset(page.items.length); setSharedMore(page.hasMore); }
    }).catch((error) => { if (active) onToast("error", error instanceof Error ? error.message : "读取公共素材失败"); }).finally(() => { if (active) setSharedLoading(false); }), assetSearch ? 250 : 0);
    return () => { active = false; if (sharedRequestRef.current === requestId) sharedRequestRef.current++; window.clearTimeout(timer); };
  }, [currentId, source, assetSearch, assetType, uploadVersion]);

  async function loadMoreSharedAssets() {
    if (sharedLoading || !sharedMore) return;
    const requestId = sharedRequestRef.current;
    setSharedLoading(true);
    try {
      const page = await api.libraryPage({ offset: sharedOffset, query: assetSearch, kind: assetType, mode: "assets" });
      if (sharedRequestRef.current !== requestId) return;
      setSharedAssets((items) => [...items, ...page.items.flatMap((task) => task.assets)]);
      setSharedOffset((offset) => offset + page.items.length);
      setSharedMore(page.hasMore);
    } catch (error) { if (sharedRequestRef.current === requestId) onToast("error", error instanceof Error ? error.message : "读取公共素材失败"); }
    finally { if (sharedRequestRef.current === requestId) setSharedLoading(false); }
  }

  const hasMore = source === "shared" && sharedMore;
  const loading = source === "shared" && sharedLoading;

  return (
    <div className="board-material-overlay" inert={previewOpen}
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section ref={dialogRef} className="board-material-dialog" role="dialog" aria-modal="true"
        aria-labelledby={titleId} tabIndex={-1} onKeyDown={handleKeyDown}>
        <header className="board-material-head">
          <div className="board-material-heading">
            <span className="board-material-emblem"><ImageIcon size={21} /></span>
            <h2 id={titleId}>{title}</h2>
          </div>
          <button type="button" className="board-material-icon board-material-close" aria-label="关闭素材库"
            disabled={busy} onClick={onClose}><X size={17} /></button>
        </header>

        <div className="board-material-sources">
          <div className="board-material-segments" role="group" aria-label="素材来源">
            <button type="button" aria-pressed={source === "board"} disabled={busy} onClick={() => changeSource("board")}>
              <Layers3 size={16} />画布素材
            </button>
            <button type="button" aria-pressed={source === "shared"} disabled={busy} onClick={() => changeSource("shared")}>
              <Globe2 size={16} />公共素材
            </button>
          </div>
          <input ref={uploadRef} type="file" tabIndex={-1} className="file-input" disabled={busy}
            accept={onUseReferenceImage ? "image/png,image/jpeg,image/webp" : "image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/webm"}
            multiple={!onUseReferenceImage} onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = "";
              if (files.length) void uploadFiles(files);
            }} />
          <button type="button" className="board-material-primary" disabled={busy || !currentId}
            onClick={() => uploadRef.current?.click()}>
            <CloudUpload size={17} />{onUseReferenceImage ? "上传图片" : "上传素材"}
          </button>
        </div>

        <div className="board-material-controls">
          {single ? null : (
            <div className="board-material-filters" role="group" aria-label="素材类型">
              {assetFilters.map(({ type, label, icon: Icon }) => (
                <button type="button" key={type} aria-pressed={assetType === type} disabled={busy} onClick={() => {
                  if (type === assetType) return;
                  resetSelection();
                  setAssetType(type);
                }}>
                  {Icon ? <Icon size={15} /> : null}{label}
                  {source === "board" ? <small>{matchingBoardAssets.filter((asset) => matchesType(asset, type)).length}</small> : null}
                </button>
              ))}
            </div>
          )}
          <div className="board-material-tools">
            <label className="board-material-search">
              <Search size={16} />
              <input type="search" aria-label="搜索素材" placeholder={source === "board" ? "搜索名称、标签…" : "搜索素材名称…"}
                disabled={busy} value={assetSearch} onChange={(event) => { resetSelection(); setAssetSearch(event.target.value); }} />
            </label>
            <div className="board-material-segments board-material-layout" role="group" aria-label="查看方式">
              <button type="button" aria-label="网格视图" title="网格视图" aria-pressed={layout === "grid"}
                onClick={() => setLayout("grid")}><Grid2X2 size={16} /></button>
              <button type="button" aria-label="列表视图" title="列表视图" aria-pressed={layout === "list"}
                onClick={() => setLayout("list")}><List size={17} /></button>
            </div>
          </div>
        </div>

        <div ref={resultsRef} className="board-material-results" aria-busy={loading}>
          {visibleAssets.length ? (
            <div className={`board-material-grid${layout === "list" ? " is-list" : ""}`}>
              {visibleAssets.map((asset) => <MaterialCard key={asset.id} asset={asset} selected={selectedIds.includes(asset.id)}
                disabled={busy} onSelect={() => selectAsset(asset.id)} onPreview={() => onPreview(asset)} />)}
            </div>
          ) : null}
          {loading || hasMore ? (
            <div className="board-material-more">
              {loading ? <span role="status"><LoadingIndicator variant="dots" size={30} />正在加载素材</span>
                : <button type="button" className="secondary-button compact" disabled={busy} onClick={() => void loadMoreSharedAssets()}>加载更多</button>}
            </div>
          ) : null}
          {!visibleAssets.length && !loading && !hasMore ? (
            <div className="board-material-empty">
              <ImageIcon size={26} strokeWidth={1.5} />
              <p>{query ? "没有符合条件的素材" : source === "board" ? "当前画布暂无此类素材" : "暂无公共素材"}</p>
              {source === "board" ? (
                <button type="button" className="secondary-button compact" disabled={busy} onClick={() => changeSource("shared")}>浏览公共素材</button>
              ) : null}
            </div>
          ) : null}
        </div>

        <footer className="board-material-footer">
          <span className="board-material-selection" aria-live="polite">
            <CircleCheck size={18} />{selectedAssets.length ? `已选择 ${selectedAssets.length} 项` : "未选择素材"}
          </span>
          <div className="board-material-footer-actions">
            {source === "board" ? (
              <button type="button" className="board-material-icon board-material-remove" aria-label="从画布移除所选素材"
                title="从画布移除" disabled={busy || !selectedAssets.length} onClick={() => void removeSelection()}><Trash2 size={17} /></button>
            ) : null}
            <button type="button" className="board-material-primary" disabled={busy || !currentId || !selectedAssets.length}
              onClick={() => void confirmSelection()}><CornerDownLeft size={16} />{actionLabel}</button>
          </div>
        </footer>
      </section>
    </div>
  );
}
