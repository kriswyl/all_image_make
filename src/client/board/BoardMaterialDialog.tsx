import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { AudioLines, Upload, X } from "lucide-react";
import { api } from "../api";
import type { Asset } from "../../shared/types";
import type { UseBoardResult } from "./useBoard";

type AssetType = "all" | "image" | "video" | "audio";

/** 画布素材选择与公共素材分页。 */
export function BoardMaterialDialog({ board, currentId, boardAssets, assetSearch, setAssetSearch, assetType, setAssetType, setAssets, targetNodeId, onPreview, onClose, onToast }: {
  board: UseBoardResult;
  currentId: string | null;
  boardAssets: Asset[];
  assetSearch: string;
  setAssetSearch: Dispatch<SetStateAction<string>>;
  assetType: AssetType;
  setAssetType: Dispatch<SetStateAction<AssetType>>;
  setAssets: Dispatch<SetStateAction<Map<string, Asset>>>;
  targetNodeId: string | null;
  onPreview: (asset: Asset) => void;
  onClose: () => void;
  onToast: (kind: "success" | "error", message: string) => void;
}) {
  const [sharedAssets, setSharedAssets] = useState<Asset[]>([]);
  const [sharedOffset, setSharedOffset] = useState(0);
  const [sharedMore, setSharedMore] = useState(false);
  const [sharedLoading, setSharedLoading] = useState(false);
  const sharedRequestRef = useRef(0);
  const uploadRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [uploadVersion, setUploadVersion] = useState(0);

  async function useAsset(asset: Asset) {
    if (!currentId || !targetNodeId || busy) return;
    const node = board.view?.doc.nodes.find((item) => item.id === targetNodeId);
    if (!node || (node.type !== "image" && node.type !== "video" && node.type !== "audio") || node.status === "loading") { onToast("error", "节点不存在或正在生成，请稍后再试"); return; }
    if (!asset.mimeType.startsWith(`${node.type}/`)) { onToast("error", "素材类型与节点不匹配"); return; }
    setBusy(true);
    try {
      if (!await board.ensureSaved()) { onToast("error", "画布尚未保存，请等待恢复后再选择素材"); return; }
      await api.linkBoardAsset(currentId, asset.id);
      setAssets((items) => new Map(items).set(asset.id, asset));
      board.updateNode(targetNodeId, { assetId: asset.id, source: node.type === "image" ? "library" : "upload", status: "succeeded" });
      onToast("success", "已将素材放入节点");
      onClose();
    } catch (error) { onToast("error", error instanceof Error ? error.message : "选择素材失败"); }
    finally { setBusy(false); }
  }

  async function uploadFiles(files: File[]) {
    if (!currentId || busy) return;
    setBusy(true);
    const uploaded: Asset[] = [];
    try {
      for (const file of files) uploaded.push(await api.uploadBoardAsset(currentId, file));
      onToast("success", `已上传 ${uploaded.length} 个文件到素材库`);
    } catch (error) { onToast("error", `${uploaded.length ? `已上传 ${uploaded.length} 个；` : ""}${error instanceof Error ? error.message : "上传失败"}`); }
    finally {
      if (uploaded.length) {
        setAssets((items) => { const next = new Map(items); for (const asset of uploaded) next.set(asset.id, asset); return next; });
        setAssetSearch("");
        if (!targetNodeId) setAssetType("all");
        setUploadVersion((value) => value + 1);
      }
      setBusy(false);
    }
  }

  useEffect(() => {
    const requestId = ++sharedRequestRef.current;
    let active = true;
    setSharedAssets([]); setSharedOffset(0); setSharedMore(false); setSharedLoading(true);
    const timer = window.setTimeout(() => void api.libraryPage({ query: assetSearch, kind: assetType, mode: "assets" }).then((page) => {
      if (active) { setSharedAssets(page.items.flatMap((task) => task.assets)); setSharedOffset(page.items.length); setSharedMore(page.hasMore); }
    }).catch((error) => { if (active) onToast("error", error instanceof Error ? error.message : "读取公共素材失败"); }).finally(() => { if (active) setSharedLoading(false); }), assetSearch ? 250 : 0);
    return () => { active = false; if (sharedRequestRef.current === requestId) sharedRequestRef.current++; window.clearTimeout(timer); };
  }, [currentId, assetSearch, assetType, uploadVersion]);

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

  return (
        <div className="board-material-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
        <aside className="board-material-dialog" role="dialog" aria-modal="true" aria-label="选择素材">
          <header className="board-asset-head">
            <div>
              <strong>{targetNodeId ? "选择素材填入节点" : "选择素材"}</strong>
              <span>画布素材与公共素材</span>
            </div>
            <button type="button" className="icon-button compact" aria-label="关闭素材抽屉" onClick={() => onClose()}>
              <X size={14} />
            </button>
          </header>
          <div className="board-material-controls">
            <input ref={uploadRef} type="file" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/webm" multiple className="file-input" onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ""; if (files.length) void uploadFiles(files); }} />
            <button type="button" className="secondary-button compact" disabled={busy} onClick={() => uploadRef.current?.click()}><Upload size={14} />上传图片、视频或音频</button>
            <input aria-label="搜索素材" placeholder="搜索素材" value={assetSearch} onChange={(event) => setAssetSearch(event.target.value)} />
            <div className="filter-tabs">{([['all', '全部'], ['image', '图片'], ['video', '视频'], ['audio', '音频']] as const).map(([type, label]) => <button type="button" key={type} className={assetType === type ? 'active' : ''} onClick={() => setAssetType(type)}>{label}</button>)}</div>
          </div>
          <div className="board-asset-list board-material-grid">
            {boardAssets.filter((asset) => (assetType === "all" || asset.mimeType.startsWith(`${assetType}/`)) && `${asset.fileName} ${asset.title ?? ""}`.toLowerCase().includes(assetSearch.toLowerCase())).map((asset) => {
              const video = asset.mimeType.startsWith("video/");
              const audio = asset.mimeType.startsWith("audio/");
              return (
                <article key={asset.id} className="board-asset-card">
                  <button
                    type="button"
                    className="board-asset-thumb"
                    title="预览"
                    onClick={() => onPreview(asset)}
                  >
                    {video
                      ? <video src={`${api.assetUrl(asset.url)}#t=0.1`} muted preload="metadata" playsInline />
                      : audio
                        ? <span className="board-asset-audio"><AudioLines size={20} /></span>
                        : <img src={api.assetUrl(asset.thumbUrl ?? asset.url)} onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = api.assetUrl(asset.url); }} alt="" loading="lazy" />}
                  </button>
                  <div className="board-asset-meta">
                    <strong title={asset.fileName}>{asset.fileName}</strong>
                    <span>{video ? "视频" : audio ? "音频" : "图片"} · {(asset.byteSize / 1024).toFixed(0)} KB</span>
                  </div>
                  <div className="board-asset-actions">
                    {targetNodeId ? <button type="button" className="secondary-button compact" disabled={busy} onClick={() => void useAsset(asset)}>使用此素材</button> : (
                      <button
                        type="button"
                        className="secondary-button compact"
                        onClick={() => {
                          const source = board.view?.doc.nodes.find((node) => (node.type === "image" || node.type === "video" || node.type === "audio") && node.assetId === asset.id);
                          if (source) { const ids = board.duplicateNodes([source.id]); if (ids.length) board.setSelection(ids); }
                        }}
                      >
                        插入画布
                      </button>
                    )}
                    <button
                      type="button"
                      className="secondary-button compact is-danger"
                      onClick={() => {
                        if (!window.confirm("从这块无限画布移除这个素材？引用它的节点会被清空，素材文件本身不会删除。")) return;
                        void board.removeAsset(asset.id);
                      }}
                    >
                      移除
                    </button>
                  </div>
                </article>
              );
            })}
            {sharedAssets.filter((asset) => (assetType === "all" || asset.mimeType.startsWith(`${assetType}/`)) && !boardAssets.some((item) => item.id === asset.id)).map((asset) => (
              <article key={asset.id} className="board-asset-card">
                <button type="button" className="board-asset-thumb" title="预览" onClick={() => onPreview(asset)}>{asset.mimeType.startsWith("video/") ? <video src={`${api.assetUrl(asset.url)}#t=0.1`} muted preload="metadata" playsInline /> : asset.mimeType.startsWith("audio/") && !asset.thumbUrl ? <span className="board-asset-audio"><AudioLines size={32} /></span> : <img src={api.assetUrl(asset.thumbUrl ?? asset.url)} onError={(event) => { event.currentTarget.onerror = null; if (asset.mimeType.startsWith("image/")) event.currentTarget.src = api.assetUrl(asset.url); }} alt="" loading="lazy" />}</button>
                <div className="board-asset-meta"><strong title={asset.fileName}>{asset.title || asset.fileName}</strong><span>{asset.mimeType.startsWith("video/") ? "视频" : asset.mimeType.startsWith("audio/") ? "音频" : "图片"}</span></div>
                {targetNodeId ? <button type="button" className="secondary-button compact" disabled={busy} onClick={() => void useAsset(asset)}>使用此素材</button> : <button type="button" className="secondary-button compact" onClick={() => {
                  if (!currentId) return;
                  void (async () => {
                    try {
                      if (!await board.ensureSaved()) { onToast("error", "画布尚未保存，请等待恢复后再插入素材"); return; }
                      const result = await api.addAssetsToBoard(currentId, [{ assetId: asset.id }]);
                      if (!result.added.length) { onToast("error", "素材未能插入画布"); return; }
                      setAssets((current) => new Map(current).set(asset.id, asset));
                      await board.reload();
                    } catch (error) { onToast("error", error instanceof Error ? error.message : "插入素材失败"); }
                  })();
                }}>插入画布</button>}
              </article>
            ))}
            {!sharedLoading && !sharedAssets.some((asset) => assetType === "all" || asset.mimeType.startsWith(`${assetType}/`)) && !boardAssets.some((asset) => (assetType === "all" || asset.mimeType.startsWith(`${assetType}/`)) && `${asset.fileName} ${asset.title ?? ""}`.toLowerCase().includes(assetSearch.toLowerCase())) ? <p className="board-asset-empty">没有符合条件的素材</p> : null}
            {sharedLoading ? <p className="board-asset-empty">加载中…</p> : sharedMore ? <button type="button" className="secondary-button" onClick={() => void loadMoreSharedAssets()}>加载更多</button> : null}
          </div>
        </aside>
        </div>
  );
}
