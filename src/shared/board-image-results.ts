import type { BoardDoc, BoardNode, ImageBoardNode } from "./board.js";

/** Keep the primary node and its connections in place; exchange only the displayed results. */
export function promoteBoardImageResult(doc: BoardDoc, primaryId: string, memberId: string): BoardDoc {
  const primary = doc.nodes.find((node) => node.id === primaryId);
  const member = doc.nodes.find((node) => node.id === memberId);
  if (primary?.type !== "image" || member?.type !== "image" || primary.id === member.id
    || !primary.imageResultGroup?.memberIds.includes(memberId)
    || primary.status === "loading" || member.status !== "succeeded" || !member.assetId) return doc;

  const result = (node: ImageBoardNode) => ({
    assetId: node.assetId, taskId: node.taskId, resultIndex: node.resultIndex,
    naturalWidth: node.naturalWidth, naturalHeight: node.naturalHeight,
    source: node.source, status: node.status, error: node.error,
  });
  const updatedAt = new Date().toISOString();
  return {
    ...doc,
    nodes: doc.nodes.map((node) => node.id === primaryId ? { ...primary, ...result(member), updatedAt }
      : node.id === memberId ? { ...member, ...result(primary), updatedAt } : node),
  };
}

export function setBoardImageResultsExpanded(doc: BoardDoc, primaryId: string, expanded: boolean): BoardDoc {
  const primary = doc.nodes.find((node) => node.id === primaryId);
  const group = primary?.type === "image" ? primary.imageResultGroup : undefined;
  if (!primary || !group || group.expanded === expanded) return doc;
  const images = new Set(doc.nodes.filter((node) => node.type === "image").map((node) => node.id));
  const memberIds = [...new Set(group.memberIds)].filter((id) => id !== primaryId && images.has(id));
  const members = new Set(memberIds);
  const size = { width: primary.width, height: primary.height };
  const positions = expanded ? placeImageResultGrid(doc.nodes.filter((node) => !members.has(node.id)), primary, memberIds.length, size) : [];
  const byId = new Map(memberIds.map((id, index) => [id, positions[index]]));
  return {
    ...doc,
    nodes: doc.nodes.map((node) => {
      if (node.id === primaryId && node.type === "image") {
        return { ...node, imageResultGroup: memberIds.length ? { memberIds, expanded } : undefined };
      }
      const position = byId.get(node.id);
      return position ? { ...node, ...size, ...position } : node;
    }),
  };
}

interface NodeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: NodeRect, b: NodeRect, gap = 24): boolean {
  return a.x < b.x + b.width + gap
    && a.x + a.width + gap > b.x
    && a.y < b.y + b.height + gap
    && a.y + a.height + gap > b.y;
}

/**
 * 给生成结果找一个不压住已有节点的位置。
 *
 * 以前的算法固定放在配置节点右侧 120px，模板里每行都这么放时，下一行的
 * 文本 / 配置节点正好在落点上，于是新图直接盖住旧卡片。这里从「当前内容最右侧」
 * 开始向右下扫描，直到整块矩形与所有节点都不相交。
 */
export function placeResultNode(
  nodes: BoardNode[],
  size: { width: number; height: number },
  preferredX: number,
  preferredY: number,
): { x: number; y: number } {
  // 先试配置节点右侧；被占就往下找，一列排满再往右挪一列。
  // 这样结果通常还在原节点附近，又不会盖住下一行的文本 / 配置卡。
  for (let column = 0; column < 12; column += 1) {
    const x = Math.round(preferredX + column * (size.width + 120));
    for (let row = 0; row < 40; row += 1) {
      const y = Math.round(preferredY + row * (size.height + 48));
      const candidate = { x, y, ...size };
      if (!nodes.some((node) => overlaps(candidate, node))) return { x, y };
    }
  }
  const maxRight = nodes.length ? Math.max(...nodes.map((node) => node.x + node.width)) : 0;
  return { x: Math.round(maxRight + 160), y: Math.round(preferredY) };
}

/** 整批占用同一个区域，避免一张被障碍挤走后打散网格。 */
export function placeImageResultGrid(
  nodes: BoardNode[],
  source: NodeRect,
  count: number,
  card: { width: number; height: number },
) {
  if (count < 1) return [];
  const columns = count > 2 ? 2 : 1;
  const rows = Math.ceil(count / columns);
  const gap = 42;
  const origin = placeResultNode(nodes, {
    width: columns * card.width + (columns - 1) * gap,
    height: rows * card.height + (rows - 1) * gap,
  }, source.x + source.width + 40, source.y);
  return Array.from({ length: count }, (_, index) => ({
    x: origin.x + index % columns * (card.width + gap),
    y: origin.y + Math.floor(index / columns) * (card.height + gap),
  }));
}

