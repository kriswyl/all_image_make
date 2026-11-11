/**
 * 素材排的分页容量。
 *
 * 一排放不下就**翻页**，不做横向滚动——横向滚动要么藏掉后面几格（用户以为没传上），
 * 要么得把箭头浮在格子上（压住最后一张，点不到）。所以这里先把「入口格 + 两侧箭头」
 * 占的位置扣掉，剩下的宽度才用来算一页能放几张；箭头是排里的普通兄弟节点，
 * 每一格都完整露出来。
 *
 * 尺寸和 CSS 保持一致：`.vstudio-slot` 84×64、`gap: 8px`、`.vstudio-asset-more` 24px。
 */

export const ASSET_TILE_WIDTH = 84;
export const ASSET_TILE_GAP = 8;
export const ASSET_ARROW_WIDTH = 24;

/**
 * 一页最多放几张素材格。
 *
 * @param stripWidth 素材排可用宽度（不含两侧箭头与本排 gap）
 * @param hasAddSlot 最左边是否有「参考内容」入口格
 */
export function assetPageCapacity(stripWidth: number, hasAddSlot: boolean): number {
  // 宽度还没量出来（首帧、jsdom）：先不切页，全放一页，量到之后自然会重算
  if (stripWidth <= 0) return Number.POSITIVE_INFINITY;
  const reserved = (hasAddSlot ? ASSET_TILE_WIDTH + ASSET_TILE_GAP : 0)
    + 2 * (ASSET_ARROW_WIDTH + ASSET_TILE_GAP);
  // n 格实际占 n * (宽 + gap) - gap，所以反过来要把末尾那个 gap 减掉
  return Math.max(1, Math.floor((stripWidth - reserved + ASSET_TILE_GAP) / (ASSET_TILE_WIDTH + ASSET_TILE_GAP)));
}

export function assetPageCount(total: number, capacity: number): number {
  if (!Number.isFinite(capacity) || capacity <= 0) return 1;
  return Math.max(1, Math.ceil(total / capacity));
}
