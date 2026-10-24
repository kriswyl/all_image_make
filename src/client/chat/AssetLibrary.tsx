/**
 * 会话素材库（右侧抽屉）。
 *
 * 「本会话的图」一多，横条就变成一条挤满小缩略图的传送带：找不到图、也看不出
 * 哪张被选成了首帧 / 尾帧。这里用网格 + 来源筛选 + 搜索来解决「找图」，
 * 底部动作直接改画布顺序——首帧就是画布第 1 张，尾帧是第 2 张，其余是参考图。
 */
import { Eye, Image as ImageIcon, Layers, LoaderCircle, Search, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { SelectMenu } from "../ui/SelectMenu";
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
  onToggleCanvas,
  onSetFirst,
  onSetLast,
  onDeleteAsset,
  initialTab = "all",
}: {
  open: boolean;
  assets: CanvasAsset[];
  canvasIds: string[];
  onClose: () => void;
  onPreview: (assetId: string) => void;
  /** 点一下就是加入 / 移出画布 */
  onToggleCanvas: (assetId: string) => void;
  onSetFirst: (assetId: string) => void;
  onSetLast: (assetId: string) => void;
  /** 右键删除：永久删除磁盘文件并清理会话里的引用 */
  onDeleteAsset: (assetId: string) => Promise<void> | void;
  /** 从画布条的「管理」打开时直接落在「画布」页 */
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("newest");
  const [focused, setFocused] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ assetId: string; x: number; y: number } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFocused(null);
    setQuery("");
    setTab(initialTab);
    setMenu(null);
    setDeleteTarget(null);
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // 右键菜单：点外面 / 滚动画布 / 改窗口大小 / Esc 都收起，避免菜单飘在原地
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onPointerDown = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest(".asset-context-menu")) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

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

  const focusedEntry = focused ? assets.find((entry) => entry.asset.id === focused) : undefined;
  const focusedInCanvas = Boolean(focused && positions.has(focused));

  function focusAndToggle(id: string) {
    setFocused(id);
    onToggleCanvas(id);
  }

  async function confirmDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await onDeleteAsset(deleteTarget.id);
      setDeleteTarget(null);
      setFocused(null);
    } finally {
      setDeleting(false);
    }
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
              <p>共 {assets.length} 张图 · 点图加入 / 移出画布，双击看大图</p>
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
          <SelectMenu
            value={sort}
            options={[{ value: "newest", label: "最新优先" }, { value: "oldest", label: "最早优先" }]}
            onChange={(next) => setSort(next as Sort)}
            ariaLabel="排序方式"
            minWidth={96}
            className="asset-sort"
          />
        </div>

        <div className="asset-library-grid">
          {entries.map(({ entry, position, origin }) => {
            const inCanvas = position >= 0;
            return (
              <div
                key={entry.asset.id}
                className={`asset-library-item ${inCanvas ? "is-in-canvas" : ""} ${focused === entry.asset.id ? "is-focused" : ""}`}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  // 菜单宽高固定，靠近右边 / 底部时往回收，避免被窗口裁掉
                  setMenu({
                    assetId: entry.asset.id,
                    x: Math.max(8, Math.min(event.clientX, window.innerWidth - 184)),
                    y: Math.max(8, Math.min(event.clientY, window.innerHeight - 148)),
                  });
                }}
              >
                <button
                  type="button"
                  className="asset-library-thumb"
                  onClick={() => focusAndToggle(entry.asset.id)}
                  onDoubleClick={() => onPreview(entry.asset.id)}
                  title={`${assetRef(entry.asset.id)} · ${inCanvas ? `画布第 ${position + 1} 张（${roleLabel(position)}）` : "单击加入画布，双击看大图"}`}
                >
                  <img src={api.assetUrl(entry.asset.thumbUrl ?? entry.asset.url)} alt=""
                    loading="lazy" onError={(event) => { if (entry.asset.thumbUrl) fallbackToFull(event, entry.asset); }} />
                  <span className="asset-library-origin">{origin}</span>
                  {inCanvas ? (
                    <span className={`asset-library-order is-${roleLabel(position) === "参考" ? "ref" : roleLabel(position) === "尾帧" ? "last" : "first"}`}>
                      {position + 1} · {roleLabel(position)}
                    </span>
                  ) : null}
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
            {focused
              ? `已选：${focusedEntry?.asset.fileName ?? "这张图"}`
              : "点图加入 / 移出画布，双击看大图"}
          </span>
          <div className="asset-library-actions">
            {focused ? (
              <>
                <button type="button" className="secondary-button compact" onClick={() => onPreview(focused)}>
                  <ImageIcon size={13} />预览
                </button>
                {focusedInCanvas ? (
                  <>
                    <button type="button" className="secondary-button compact" onClick={() => onSetFirst(focused)}>
                      设为首帧
                    </button>
                    <button type="button" className="secondary-button compact" onClick={() => onSetLast(focused)}>
                      设为尾帧
                    </button>
                    <button type="button" className="secondary-button compact" onClick={() => onToggleCanvas(focused)}>
                      移出画布
                    </button>
                  </>
                ) : (
                  <button type="button" className="secondary-button compact" onClick={() => onToggleCanvas(focused)}>
                    加入画布
                  </button>
                )}
              </>
            ) : null}
          </div>
        </footer>
      </div>

      {menu ? (() => {
        const item = entries.find(({ entry }) => entry.asset.id === menu.assetId);
        if (!item) return null;
        const inCanvas = positions.has(menu.assetId);
        return createPortal(
          <div
            className="canvas-bar-menu asset-context-menu"
            role="menu"
            aria-label="图片操作"
            style={{ left: menu.x, top: menu.y }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div className="canvas-bar-menu-title">{originLabel(item.entry)} · {item.entry.asset.fileName}</div>
            <button type="button" role="menuitem" onClick={() => { setMenu(null); onPreview(menu.assetId); }}>
              <Eye size={13} />查看大图
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => { setMenu(null); onToggleCanvas(menu.assetId); }}
            >
              <Layers size={13} />{inCanvas ? "移出画布" : "加入画布"}
            </button>
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => {
                // 画面描述可能很长，确认框只留一小段，别把弹窗撑成一面墙
                const raw = item.entry.prompt.trim() || item.entry.asset.fileName;
                setDeleteTarget({
                  id: menu.assetId,
                  label: raw.length > 36 ? `${raw.slice(0, 36)}…` : raw,
                });
                setMenu(null);
              }}
            >
              <Trash2 size={13} />删除图片
            </button>
          </div>,
          document.body,
        );
      })() : null}

      {deleteTarget ? createPortal(
        <div
          className="modal-backdrop storyboard-confirm-backdrop"
          role="presentation"
          onMouseDown={(event) => { if (event.target === event.currentTarget && !deleting) setDeleteTarget(null); }}
        >
          <div className="modal storyboard-confirm asset-delete-dialog" role="dialog" aria-modal="true" aria-label="删除图片">
            <div className="modal-header">
              <div><Trash2 size={18} /><h2>删除图片</h2></div>
              <button type="button" className="icon-button" onClick={() => setDeleteTarget(null)} disabled={deleting}><X size={18} /></button>
            </div>
            <div className="modal-body">
              <p className="modal-lead">确定删除「<strong>{deleteTarget.label}</strong>」？</p>
              <p className="storyboard-reference-note">
                会删除磁盘上的原图和缩略图，并从生成历史、画布和相关分镜引用里移除，无法恢复。
              </p>
            </div>
            <div className="modal-footer">
              <button type="button" className="secondary-button" onClick={() => setDeleteTarget(null)} disabled={deleting}>取消</button>
              <button type="button" className="primary-button danger" disabled={deleting} onClick={() => void confirmDelete()}>
                {deleting ? <LoaderCircle size={16} className="spin" /> : <Trash2 size={16} />}
                {deleting ? "删除中…" : "确认删除"}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
