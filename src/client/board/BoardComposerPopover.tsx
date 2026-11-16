import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function BoardComposerPopover({ anchor, onClose, label, width: preferredWidth = 384, children }: {
  anchor: HTMLButtonElement | null;
  onClose: () => void;
  label: string;
  width?: number;
  children: ReactNode;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; width: number; maxHeight: number }>();

  // 画布平移、缩放和节点拖动都会引起父组件重新渲染。
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const canvas = anchor.closest(".board-canvas")?.getBoundingClientRect();
      const minX = Math.max(8, (canvas?.left ?? 0) + 8);
      const maxX = Math.min(window.innerWidth - 8, (canvas?.right ?? window.innerWidth) - 8);
      const width = Math.min(preferredWidth, Math.max(0, maxX - minX));
      const left = Math.max(minX, Math.min(rect.left + (rect.width - width) / 2, maxX - width));
      const above = rect.top - Math.max(8, (canvas?.top ?? 0) + 8) - 6;
      const below = Math.min(window.innerHeight - 8, (canvas?.bottom ?? window.innerHeight) - 8) - rect.bottom - 6;
      const opensBelow = above < 200 && below > above;
      const top = opensBelow ? rect.bottom + 6 : undefined;
      const bottom = opensBelow ? undefined : window.innerHeight - rect.top + 6;
      const maxHeight = Math.max(0, Math.min(480, opensBelow ? below : above));
      setPosition((current) => current?.left === left && current.top === top && current.bottom === bottom
        && current.width === width && current.maxHeight === maxHeight
        ? current : { left, top, bottom, width, maxHeight });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  });

  useLayoutEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (anchor?.contains(event.target) || menuRef.current?.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest(".style-preset-overlay")) return;
      onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest(".style-preset-overlay")) return;
      event.preventDefault();
      onClose();
      anchor?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", escape);
    };
  }, [anchor, onClose]);

  const visible = Boolean(position && position.maxHeight > 0 && position.width > 0);
  useLayoutEffect(() => {
    if (visible) menuRef.current?.focus({ preventScroll: true });
  }, [visible]);

  if (!visible) return null;
  return createPortal(
    <div ref={menuRef} tabIndex={-1} className="board-composer-popover" role="region" aria-label={label} style={position}>
      {children}
    </div>,
    document.body,
  );
}
