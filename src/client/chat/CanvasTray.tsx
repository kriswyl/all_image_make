/**
 * 输入框里的「这一轮要带的图」。
 *
 * 不再单独占一条画布栏：选中的图直接排在输入框的附件区，和 Claude Code 的附件一样。
 * 左键看大图，右键设首帧 / 尾帧，角标写清角色；发送后由 ChatView 清空。
 */
import { Eye, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import type { Asset } from "../../shared/types";

export interface CanvasTrayItem {
  asset: Asset;
  /** 画布里的位置，0 是首帧 */
  index: number;
}

function roleLabel(position: number): string {
  if (position === 0) return "首帧";
  if (position === 1) return "尾帧";
  return "参考";
}

export function CanvasTray({
  items,
  plain = false,
  onPreview,
  onRemove,
  onSetFirst,
  onSetLast,
}: {
  items: CanvasTrayItem[];
  plain?: boolean;
  onPreview: (assetId: string) => void;
  onRemove: (assetId: string) => void;
  onSetFirst: (assetId: string) => void;
  onSetLast: (assetId: string) => void;
}) {
  const [menu, setMenu] = useState<{ id: string; index: number; x: number; y: number } | null>(null);
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

  function openMenu(event: React.MouseEvent<HTMLButtonElement>, item: CanvasTrayItem) {
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 150;
    const height = 152;
    setMenu({
      id: item.asset.id,
      index: item.index,
      x: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8)),
    });
  }

  if (!items.length) return null;

  return (
    <>
      {items.map((item) => (
        <div key={item.asset.id} className="composer-attachment is-canvas">
          <button
            type="button"
            className="composer-canvas-thumb"
            title={plain ? "本轮附件 · 点击查看大图" : `${roleLabel(item.index)} · 左键看大图，右键设首帧 / 尾帧`}
            onClick={() => onPreview(item.asset.id)}
            onContextMenu={(event) => { event.preventDefault(); if (!plain) openMenu(event, item); }}
          >
            <img src={api.assetUrl(item.asset.thumbUrl ?? item.asset.url)} alt="" loading="lazy" />
            {!plain ? <><span className="composer-canvas-order">{item.index + 1}</span>
            <span className={`composer-canvas-role is-${item.index === 0 ? "first" : item.index === 1 ? "last" : "ref"}`}>
              {roleLabel(item.index)}
            </span></> : null}
          </button>
          <button
            type="button"
            className="composer-attachment-remove"
            title="从这一轮移除"
            aria-label={`${plain ? "移除附件" : "从画布移除"} ${item.asset.fileName}`}
            onClick={() => onRemove(item.asset.id)}
          >
            <X size={11} />
          </button>
        </div>
      ))}
      {menu ? createPortal(
        <div
          ref={menuRef}
          className="canvas-bar-menu"
          role="menu"
          aria-label="画布图片操作"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(event) => event.preventDefault()}
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
