import { useEffect, useLayoutEffect, useState } from "react";
import type { CSSProperties, RefObject } from "react";

/**
 * 贴着触发元素弹出的面板定位。
 *
 * 与 `ui/SelectMenu` 同一套思路：面板是 portal，位置按触发元素的矩形算，
 * 下方放不下就翻到上方，左右夹在视口内。抽出来是因为创作框里有三个浮层
 * （模式菜单、参数面板、@ 素材面板）要共用同一套边界处理。
 *
 * align 决定水平对齐方式：
 * - "start"：面板左缘贴触发元素左缘（底部胶囊的菜单）；
 * - "end"：面板右缘贴触发元素右缘——@ 按钮在创作框右上角，左对齐会把面板
 *   推到窗口最右边、一半悬在窗外，看起来就是「歪的」；右对齐让它收进窗口。
 */
export type PanelAlign = "start" | "end";

/** 不是元素也能当锚点：textarea 的光标位置量出来就是这样一个矩形 */
export interface PanelAnchorRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function anchorRect(anchor: HTMLElement | PanelAnchorRect): PanelAnchorRect {
  return "getBoundingClientRect" in anchor ? anchor.getBoundingClientRect() : anchor;
}

export function useAnchoredPanelStyle(
  open: boolean,
  anchor: HTMLElement | PanelAnchorRect | null,
  width: number,
  maxHeight: number,
  align: PanelAlign = "start",
): CSSProperties | null {
  const [style, setStyle] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    if (!open || !anchor) { setStyle(null); return; }
    const place = () => {
      const rect = anchorRect(anchor);
      const panelWidth = Math.min(width, window.innerWidth - 16);
      const preferred = align === "end" ? rect.right - panelWidth : rect.left;
      const left = Math.min(Math.max(8, preferred), window.innerWidth - panelWidth - 8);
      const openUp = rect.bottom + maxHeight + 12 > window.innerHeight && rect.top > maxHeight + 12;
      setStyle(openUp
        ? { left, width: panelWidth, bottom: window.innerHeight - rect.top + 8, maxHeight: Math.min(maxHeight, rect.top - 16) }
        : { left, width: panelWidth, top: rect.bottom + 8, maxHeight: Math.min(maxHeight, window.innerHeight - rect.bottom - 24) });
    };
    place();
    // 打开期间窗口缩放、页面滚动都重算，浮层不跟着锚点漂走
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, anchor, width, maxHeight, align]);
  return style;
}

/** 点外面 / Esc 收起。触发元素本身不算「外面」，否则点胶囊会先收起再打开 */
export function usePanelDismiss(
  open: boolean,
  onClose: () => void,
  panelRef: RefObject<HTMLElement | null>,
  anchor: HTMLElement | null,
) {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose, panelRef, anchor]);
}
