import { useMemo } from "react";
import type { BoardNode, BoardViewport } from "../../shared/board";

/** 计算适应窗口与小地图所需的节点范围和视口映射。 */
export function useBoardMinimap(nodes: BoardNode[], viewport: BoardViewport, size: { width: number; height: number }) {
  /** 适应窗口只看真实节点范围；按世界画布 1600×1000 去缩会把两个节点缩成芝麻 */
  const contentBounds = useMemo(() => {
    if (!nodes.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + node.height);
    }
    return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
  }, [nodes]);

  /** 小地图的世界范围：内容 + 当前视口，保证视口框永远在图上 */
  const minimapBounds = useMemo(() => {
    const scale = viewport.scale || 1;
    const viewRect = {
      x: -viewport.x / scale,
      y: -viewport.y / scale,
      width: Math.max(1, size.width / scale),
      height: Math.max(1, size.height / scale),
    };
    const rects = contentBounds ? [contentBounds, viewRect] : [viewRect];
    const minX = Math.min(...rects.map((rect) => rect.x));
    const minY = Math.min(...rects.map((rect) => rect.y));
    const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
    const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
    const pad = 80;
    return { x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2, viewRect };
  }, [contentBounds, size.height, size.width, viewport]);

  const minimapLayout = useMemo(() => {
    const width = 176;
    const height = 118;
    const scale = Math.min(width / minimapBounds.width, height / minimapBounds.height);
    return {
      width,
      height,
      scale,
      offsetX: (width - minimapBounds.width * scale) / 2,
      offsetY: (height - minimapBounds.height * scale) / 2,
    };
  }, [minimapBounds]);

  return { contentBounds, minimapBounds, minimapLayout };
}
