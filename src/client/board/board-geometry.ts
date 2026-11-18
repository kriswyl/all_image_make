import type { BoardEdge, BoardNode } from "../../shared/board";

/** 画布视口、节点包围盒与连线的纯计算。 */
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 3;

export function clampScale(value: number) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

export interface ImageDimensions { width: number; height: number }

export function fitBoardImageSize(bounds: ImageDimensions, image: ImageDimensions): ImageDimensions {
  const scale = Math.min(bounds.width / image.width, bounds.height / image.height);
  return { width: image.width * scale, height: image.height * scale };
}

type BoardRect = Pick<BoardNode, "x" | "y" | "width" | "height">;

export function boardFitViewport(bounds: BoardRect | null, size: { width: number; height: number }, fallback?: BoardRect) {
  if (!bounds) return { x: 80, y: 80, scale: 1 };
  const scale = Math.min(1.05, size.width / (bounds.width + 120), size.height / (bounds.height + 120));
  if (scale < MIN_SCALE && fallback && fallback !== bounds) return boardFitViewport(fallback, size);
  const fitted = clampScale(scale);
  return { scale: fitted, x: (size.width - bounds.width * fitted) / 2 - bounds.x * fitted,
    y: (size.height - bounds.height * fitted) / 2 - bounds.y * fitted };
}

export function edgePath(source: BoardRect, target: BoardRect): string {
  const sx = source.x + source.width;
  const sy = source.y + source.height / 2;
  const tx = target.x;
  const ty = target.y + target.height / 2;
  const bend = Math.max(30, Math.abs(tx - sx) * 0.42);
  return `M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}`;
}

export function edgeClass(edge: BoardEdge): string {
  if (edge.kind === "result") return "is-result";
  if (edge.role === "text") return "is-text";
  if (edge.role === "first-frame") return "is-first";
  if (edge.role === "last-frame") return "is-last";
  return "is-reference";
}

export function rectsIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function nodesBounds(nodes: BoardNode[]): { x: number; y: number; width: number; height: number } | null {
  if (!nodes.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}
