import { describe, expect, it } from "vitest";
import {
  RECORD_GAP_Y,
  RECORD_FALLBACK_PAGE_SIZE,
  recordPageLayout,
} from "../src/client/video/record-paging";

/**
 * 每页数量随窗口变的底线：算出来的卡片必须真的放得进这块区域，
 * 窗口变大时容量不能反而变小，也不能为了塞满而无限加行。
 */
describe("创作记录分页容量", () => {
  it("尺寸还没量出来时退回一页 3 条，页面不空白", () => {
    expect(recordPageLayout(0, 0).pageSize).toBe(RECORD_FALLBACK_PAGE_SIZE);
    expect(recordPageLayout(0, 600).columns).toBe(3);
  });

  it("1440 宽的一屏：3 列 1 行，正好铺满一行", () => {
    const layout = recordPageLayout(846, 260);
    expect(layout.columns).toBe(3);
    expect(layout.rows).toBe(1);
    expect(layout.pageSize).toBe(3);
  });

  it("同样高度下窗口越宽，列数与每页条数只增不减", () => {
    let previous = 0;
    for (let width = 500; width <= 1800; width += 20) {
      const { pageSize, columns } = recordPageLayout(width, 520);
      expect(pageSize, `width=${width}`).toBeGreaterThanOrEqual(previous);
      expect(columns).toBeLessThanOrEqual(5);
      previous = pageSize;
    }
  });

  it("窗口变高时加行，一页能放的变多；不会为了让画面填满而超出高度", () => {
    expect(recordPageLayout(1200, 700).pageSize).toBeGreaterThan(recordPageLayout(1200, 250).pageSize);
    for (const height of [220, 400, 700, 1000]) {
      const { rows, cardHeight } = recordPageLayout(1200, height);
      const used = rows * cardHeight + (rows - 1) * RECORD_GAP_Y;
      expect(used, `height=${height}`).toBeLessThanOrEqual(height);
    }
  });

  it("列数不会超过 5，每页条数有上限，极窄窗口也给一列", () => {
    expect(recordPageLayout(4000, 3000).columns).toBe(5);
    expect(recordPageLayout(4000, 3000).pageSize).toBeLessThanOrEqual(12);
    expect(recordPageLayout(160, 200).columns).toBe(1);
    expect(recordPageLayout(160, 200).pageSize).toBeGreaterThanOrEqual(1);
  });
});
