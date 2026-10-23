/**
 * 会话素材库（右侧抽屉）。
 *
 * 「本会话的图」一多，横条就变成一条挤满小缩略图的传送带：找不到图、也看不出
 * 哪张被选成了首帧 / 尾帧。这里用网格 + 来源筛选 + 搜索来解决「找图」，
 * 底部动作直接改画布顺序——首帧就是画布第 1 张，尾帧是第 2 张，其余是参考图。
 */
import { Check, Image as ImageIcon, Layers, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { assetRef, type CanvasAsset } from "../../shared/agent-types";
import type { Asset } from "../../shared/types";

type Tab = "all" | "generate" | "storyboard" | "setting" | "upload" | "canvas";
type Sort = "newest" | "oldest";

function fallbackToFull(event: React.SyntheticEvent<HTMLImageElement>, asset: Asset) {
  const image = event.currentTarget;
  if (image.dataset.fallback === "1") return;
  image.dataset.fallback = "1";
  image.src = api.assetUrl(asset.url);
}

function roleLabel(position: number): string {
  if (position === 0) return "首帧";
  if (position === 1) return "尾帧";
  return "参考";
}

function originLabel(entry: CanvasAsset): string {
  if (entry.source === "storyboard") return `第 ${entry.round} 镜`;
  if (entry.source === "setting") return "设定图";
  if (entry.source === "upload") return "上传";
  return `第 ${entry.round} 轮`;
}

export function AssetLibrary({
  open,
  assets,
  canvasIds,
  onClose,
  onPreview,
  onAddToCanvas,
  onRemoveFromCanvas,
  onSetFirst,
  onSetLast,
}: {
  open: boolean;
  assets: CanvasAsset[];
  canvasIds: string[];
  onClose: () => void;
  onPreview: (assetId: string) => void;
  onAddToCanvas: (assetIds: string[]) => void;
  onRemoveFromCanvas: (assetIds: string[]) => void;
  onSetFirst: (assetId: string) => void;
  onSetLast: (assetId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("newest");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setQuery("");
    setTab("all");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const positions = useMemo(() => new Map(canvasIds.map((id, index) => [id, index])), [canvasIds]);

  const entries = useMemo(() => {
    const text = query.trim().toLowerCase();
    return assets
      .map((entry) => {
        const position = positions.get(entry.asset.id) ?? -1;
        const origin = originLabel(entry);
        const searchable = `${entry.prompt}\n${entry.asset.fileName}\n${entry.asset.title ?? ""}\n${origin}`.toLowerCase();
        return { entry, position, origin, searchable };
      })
      .filter(({ entry, position, searchable }) => {
        if (tab === "canvas" && position < 0) return false;
        if (tab !== "all" && tab !== "canvas" && entry.source !== tab) return false;
        return !text || searchable.includes(text);
      })
      .sort((left, right) => {
        const delta = new Date(left.entry.asset.createdAt).getTime() - new Date(right.entry.asset.createdAt).getTime();
        return sort === "newest" ? -delta : delta;
      });
  }, [assets, positions, query, sort, tab]);

  const counts = useMemo(() => ({
    all: assets.length,
    generate: assets.filter((entry) => entry.source === "generate").length,
    storyboard: assets.filter((entry) => entry.source === "storyboard").length,
    setting: assets.filter((entry) => entry.source === "setting").length,
    upload: assets.filter((entry) => entry.source === "upload").length,
    canvas: assets.filter((entry) => positions.has(entry.asset.id)).length,
  }), [assets, positions]);

  if (!open) return null;

  const selectedIds = [...selected];
  const selectedInCanvas = selectedIds.filter((id) => positions.has(id));
  const selectedNotInCanvas = selectedIds.filter((id) => !positions.has(id));

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function run(action: () => void) {
    action();
    setSelected(new Set());
  }

  const tabs: Array<{ id: Tab; label: string; count: number }> = [
    { id: "all", label: "全部", count: counts.all },
    { id: "generate", label: "生成", count: counts.generate },
    { id: "storyboard", label: "分镜", count: counts.storyboard },
    { id: "setting", label: "设定", count: counts.setting },
    { id: "upload", label: "上传", count: counts.upload },
    { id: "canvas", label: "画布", count: counts.canvas },
  ];

  return (
    <div className="asset-library-overlay" role="dialog" aria-modal="true" aria-label="素材库"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="asset-library" onMouseDown={(event) => event.stopPropagation()}>
        <header className="asset-library-head">
          <div className="asset-library-title">
            <Layers size={16} />
            <div>
              <h2>素材库</h2>
              <p>共 {assets.length} 张图 · 点图选中，双击看大图</p>
            </div>
          </div>
          <button type="button" className="icon-button compact" title="关闭" onClick={onClose}><X size={15} /></button>
        </header>

        <div className="asset-library-tabs" role="tablist" aria-label="素材来源">
          {tabs.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={tab === item.id}
              className={tab === item.id ? "is-active" : ""} onClick={() => setTab(item.id)}>
              {item.label}<span>{item.count}</span>
            </button>
          ))}
        </div>

        <div className="asset-library-tools">
          <label className="asset-library-search">
            <Search size={13} />
            <input value={query} onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索画面描述 / 文件名 / 镜号…" />
          </label>
          <select value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
            <option value="newest">最新优先</option>
            <option value="oldest">最早优先</option>
          </select>
        </div>

        <div className="asset-library-grid">
          {entries.map(({ entry, position, origin }) => {
            const inCanvas = position >= 0;
            const checked = selected.has(entry.asset.id);
            return (
              <div key={entry.asset.id} className={`asset-library-item ${checked ? "is-selected" : ""}`}>
                <button
                  type="button"
                  className="asset-library-thumb"
                  onClick={() => toggle(entry.asset.id)}
                  onDoubleClick={() => onPreview(entry.asset.id)}
                  title={`${assetRef(entry.asset.id)} · ${inCanvas ? `画布第 ${position + 1} 张（${roleLabel(position)}）` : "双击看大图"}`}
                >
                  <img src={api.assetUrl(entry.asset.thumbUrl ?? entry.asset.url)} alt=""
                    loading="lazy" onError={(event) => { if (entry.asset.thumbUrl) fallbackToFull(event, entry.asset); }} />
                  <span className="asset-library-origin">{origin}</span>
                  {inCanvas ? (
                    <span className={`asset-library-order is-${roleLabel(position) === "参考" ? "ref" : roleLabel(position) === "尾帧" ? "last" : "first"}`}>
                      {position + 1} · {roleLabel(position)}
                    </span>
                  ) : null}
                  <span className={`asset-library-check ${checked ? "is-on" : ""}`}>
                    {checked ? <Check size={12} /> : null}
                  </span>
                </button>
                <div className="asset-library-caption" title={entry.prompt || entry.asset.fileName}>
                  {entry.source === "upload" ? entry.asset.fileName : (entry.prompt || entry.asset.fileName)}
                </div>
              </div>
            );
          })}
          {!entries.length ? (
            <div className="asset-library-empty">
              <ImageIcon size={22} />
              <span>{query ? "没有匹配的图" : "这个分类里还没有图"}</span>
            </div>
          ) : null}
        </div>

        <footer className="asset-library-foot">
          <span className="asset-library-selected">
            {selectedIds.length ? `已选 ${selectedIds.length} 张` : "点图选中，可批量操作"}
          </span>
          <div className="asset-library-actions">
            {selectedIds.length === 1 ? (
              <button type="button" className="secondary-button compact" onClick={() => onPreview(selectedIds[0]!)}>
                <ImageIcon size={13} />预览
              </button>
            ) : null}
            <button type="button" className="secondary-button compact" disabled={!selectedNotInCanvas.length}
              onClick={() => run(() => onAddToCanvas(selectedNotInCanvas))}>
              <Layers size={13} />加入画布{selectedNotInCanvas.length ? ` (${selectedNotInCanvas.length})` : ""}
            </button>
            <button type="button" className="secondary-button compact" disabled={selectedIds.length !== 1}
              onClick={() => run(() => onSetFirst(selectedIds[0]!))}>
              设为首帧
            </button>
            <button type="button" className="secondary-button compact" disabled={selectedIds.length !== 1}
              onClick={() => run(() => onSetLast(selectedIds[0]!))}>
              设为尾帧
            </button>
            <button type="button" className="secondary-button compact" disabled={!selectedInCanvas.length}
              onClick={() => run(() => onRemoveFromCanvas(selectedInCanvas))}>
              移出画布{selectedInCanvas.length ? ` (${selectedInCanvas.length})` : ""}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
