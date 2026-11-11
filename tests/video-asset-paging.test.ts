import { expect, it, describe } from "vitest";
import {
  ASSET_ARROW_WIDTH,
  ASSET_TILE_GAP,
  ASSET_TILE_WIDTH,
  assetPageCapacity,
  assetPageCount,
} from "../src/client/video/asset-paging";

/**
 * 素材排分页的底线：箭头是排里的普通兄弟节点，**不会压在素材格上**。
 *
 * 这里的算式和 CSS 是同一组数字（84 宽 / 8 gap / 24 箭头）。只要「一页 N 格 +
 * 入口格 + 两个箭头」的总宽不超过素材排宽度，箭头就不可能和任何一格重叠；
 * 同时 N+1 格一定放不下，说明 N 已经是这一排能放的最多。
 */
const STEP = ASSET_TILE_WIDTH + ASSET_TILE_GAP;
const RESERVED = (hasAdd: boolean) => (hasAdd ? ASSET_TILE_WIDTH + ASSET_TILE_GAP : 0) + 2 * (ASSET_ARROW_WIDTH + ASSET_TILE_GAP);

describe("素材排分页容量", () => {
  it("宽度还没量出来时不切页，全部放一行", () => {
    expect(assetPageCapacity(0, true)).toBe(Number.POSITIVE_INFINITY);
    expect(assetPageCount(12, assetPageCapacity(0, true))).toBe(1);
  });

  it("最窄的时候也至少留一格", () => {
    expect(assetPageCapacity(40, true)).toBe(1);
    expect(assetPageCapacity(40, false)).toBe(1);
  });

  it("一页放得下的格数 + 入口 + 两侧箭头不会超出这一排，再多一格就放不下", () => {
    for (const hasAdd of [true, false]) {
      for (let width = 160; width <= 1400; width += 1) {
        const capacity = assetPageCapacity(width, hasAdd);
        const used = RESERVED(hasAdd) + capacity * STEP - ASSET_TILE_GAP;
        // 容量被兜底成 1 的极窄宽度下不成立（入口格 + 两个箭头本身就比一排宽），
        // 这时宁可挤一格也不能给出 0，所以只对 2 格以上校验不溢出
        if (capacity >= 2) expect(used, `width=${width} hasAdd=${hasAdd}`).toBeLessThanOrEqual(width);
        // 下一格一定越界：说明算出来的就是上限，不是随手少放一格
        const next = RESERVED(hasAdd) + (capacity + 1) * STEP - ASSET_TILE_GAP;
        expect(next, `width=${width} hasAdd=${hasAdd}`).toBeGreaterThan(width);
      }
    }
  });

  it("有「参考内容」入口格时，比没有入口少放一格", () => {
    const withAdd = assetPageCapacity(600, true);
    const withoutAdd = assetPageCapacity(600, false);
    expect(withoutAdd).toBeGreaterThanOrEqual(withAdd);
    expect(withoutAdd - withAdd).toBeLessThanOrEqual(1);
  });

  it("页数按容量向上取整，正好整除时不多出一页", () => {
    expect(assetPageCount(9, 4)).toBe(3);
    expect(assetPageCount(8, 4)).toBe(2);
    expect(assetPageCount(0, 4)).toBe(1);
    expect(assetPageCount(3, 0)).toBe(1);
  });
});
