/**
 * 无限画布的排版计算。
 *
 * 助手做「所有分镜图排成一列」这类操作时，让模型自己算 x/y 既慢又容易叠在一起；
 * 这里按节点的真实宽高算坐标，模型只要说清楚「谁、往哪个方向、分几组」。
 *
 * 约定：
 * - `axis` 是主方向。`y` = 一列往下排，`x` = 一行往右排。
 * - `columns` 是并排的轨道数：`axis: "y"` 时是列数（先填满一列再换下一列），
 *   `axis: "x"` 时是行数（先填满一行再换下一行）。
 * - 轨道之间的间距按该轨道里最宽的节点计算，所以宽窄不一的节点也不会压到相邻轨道。
 */
export interface ArrangeItem {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ArrangeOptions {
  axis: "x" | "y";
  /** 并排轨道数，默认 1 */
  columns?: number;
  /** 节点间距，默认 48 */
  gap?: number;
  /** 起点坐标；不填沿用第一个节点的当前位置 */
  origin?: { x: number; y: number };
}

export interface ArrangePosition {
  x: number;
  y: number;
}

export const ARRANGE_DEFAULT_GAP = 48;

/** 返回每个节点的新坐标，顺序与入参一致 */
export function arrangePositions(items: ArrangeItem[], options: ArrangeOptions): ArrangePosition[] {
  if (!items.length) return [];
  const gap = Math.max(0, options.gap ?? ARRANGE_DEFAULT_GAP);
  const origin = options.origin ?? { x: items[0]!.x, y: items[0]!.y };
  const tracks = Math.max(1, Math.min(options.columns ?? 1, items.length));
  const perTrack = Math.ceil(items.length / tracks);

  const positions: ArrangePosition[] = new Array(items.length);
  let crossOffset = 0;

  for (let track = 0; track < tracks; track += 1) {
    const start = track * perTrack;
    const end = Math.min(items.length, start + perTrack);
    if (start >= end) break;
    let alongOffset = 0;
    let crossExtent = 0;
    for (let index = start; index < end; index += 1) {
      const item = items[index]!;
      const alongSize = options.axis === "y" ? item.height : item.width;
      const crossSize = options.axis === "y" ? item.width : item.height;
      crossExtent = Math.max(crossExtent, crossSize);
      positions[index] = options.axis === "y"
        ? { x: origin.x + crossOffset, y: origin.y + alongOffset }
        : { x: origin.x + alongOffset, y: origin.y + crossOffset };
      alongOffset += alongSize + gap;
    }
    crossOffset += crossExtent + gap;
  }

  return positions;
}
