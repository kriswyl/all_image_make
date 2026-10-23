/**
 * 画布条（极简版）。
 *
 * 只回答一件事：**现在画布里是哪几张、它们分别是什么角色**。
 * 不加来源、哈希编号、移前/删除这些小字——管理动作全部放进素材库，
 * 这里保留一行缩略图和「管理」入口就够了。
 */
import { ChevronDown, ChevronUp, Eye, Layers, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CanvasAsset } from "../../shared/agent-types";
import { api } from "../api";
import { ASSET_DRAG_TYPE } from "../useFileDrop";

function roleLabel(position: number): string {
  if (position === 0) return "首帧";
  if (position === 1) return "尾帧";
  return "参考";
}

export function AssetStrip({
  assets,
  canvasIds,
  onPreview,
  onSetFirst,
  onSetLast,
  onRemove,
  onOpenLibrary,
  onClear,
}: {
  assets: CanvasAsset[];
  /** 画布里的图 id，有序；下标就是角色：0 首帧、1 尾帧、其余参考 */
  canvasIds: string[];
  onPreview: (assetId: string) => void;
  onSetFirst: (assetId: string) => void;
  onSetLast: (assetId: string) => void;
  onRemove: (assetId: string) => void;
  onOpenLibrary: () => void;
  onClear: () => void;
}) {
  const [menu, setMenu] = useState<{ id: string; index: number; x: number; y: number } | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    const onLayout = () => setMenu(null);
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onLayout);
    window.addEventListener("scroll", onLayout, true);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onLayout);
      window.removeEventListener("scroll", onLayout, true);
    };
  }, [menu]);

  function openMenu(event: React.MouseEvent<HTMLButtonElement>, entry: CanvasAsset, index: number) {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 150;
    const height = 152;
    setMenu({
      id: entry.asset.id,
      index,
      x: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8)),
    });
  }

  const entries = canvasIds
    .map((id) => assets.find((entry) => entry.asset.id === id))
    .filter((entry): entry is CanvasAsset => Boolean(entry));

  if (!entries.length) return null;

  const referenceCount = Math.max(0, entries.length - 2);
  const roleSummary = [
    "① 首帧",
    entries.length > 1 ? "② 尾帧" : "",
    referenceCount ? `参考 ${referenceCount}` : "",
  ].filter(Boolean).join(" · ");

  return (
    <>
    <section className="canvas-bar">
      <div className="canvas-bar-head">
        <span className="canvas-bar-title"><Layers size={13} />画布 {entries.length}</span>
        <span className="canvas-bar-roles">{roleSummary}</span>
        <button
          type="button"
          className="canvas-bar-toggle"
          aria-expanded={!collapsed}
          title={collapsed ? "展开画布缩略图" : "收起画布缩略图"}
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
        </button>
        <button type="button" className="canvas-bar-manage" onClick={onOpenLibrary}>管理</button>
        <button type="button" className="canvas-bar-clear" onClick={onClear}>清空</button>
      </div>
      {!collapsed ? <div className="canvas-bar-items">
        {entries.map((entry, index) => (
          <button
            key={entry.asset.id}
            type="button"
            className="canvas-bar-thumb"
            title={`${roleLabel(index)} · 左键看大图，右键设首帧 / 尾帧`}
            onClick={() => onPreview(entry.asset.id)}
            onContextMenu={(event) => { event.preventDefault(); openMenu(event, entry, index); }}
            draggable
            onDragStart={(event) => event.dataTransfer.setData(ASSET_DRAG_TYPE, entry.asset.id)}
          >
            <img src={api.assetUrl(entry.asset.thumbUrl ?? entry.asset.url)} alt="" loading="lazy" />
            <span className="canvas-bar-order">{index + 1}</span>
          </button>
        ))}
      </div> : null}
    </section>
    {menu ? createPortal(
      <div
        ref={menuRef}
        className="canvas-bar-menu"
        role="menu"
        aria-label="画布图片操作"
        style={{ left: menu.x, top: menu.y }}
      >
        <div className="canvas-bar-menu-title">画布第 {menu.index + 1} 张</div>
        <button type="button" role="menuitem" disabled={menu.index === 0}
          onClick={() => { onSetFirst(menu.id); setMenu(null); }}>
          设为首帧
        </button>
        <button type="button" role="menuitem" disabled={menu.index === 1}
          onClick={() => { onSetLast(menu.id); setMenu(null); }}>
          设为尾帧
        </button>
        <button type="button" role="menuitem" onClick={() => { onPreview(menu.id); setMenu(null); }}>
          <Eye size={13} />看大图
        </button>
        <button type="button" role="menuitem" className="danger"
          onClick={() => { onRemove(menu.id); setMenu(null); }}>
          <Trash2 size={13} />移出画布
        </button>
      </div>,
      document.body,
    ) : null}
    </>
  );
}
