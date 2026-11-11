/**
 * 创作记录一页放几张卡片。
 *
 * 之前写死「一页 3 条」：窗口拉大之后右边空一截、下面空一大块，看起来像没加载完。
 * 这里按记录区**实际可用宽高**算列数与行数：列数由宽度和卡片最小宽度决定，
 * 行数由剩下的高度和卡片估算高度决定，两者相乘就是这一页的容量。
 *
 * 记录区不滚动（.record-scroll 是 overflow:hidden），所以算出来的卡片必须真的
 * 放得下：估算高度宁可保守一点，也不要让最后一排被裁掉。
 *
 * 卡片宽度有上限 320px：再宽下去缩略图会变很高，反而把行数挤少——「窗口拉宽
 * 20px，一页从 4 条掉到 2 条」这种跳变就是这么来的。列数照算，但整排网格
 * 最多铺到 maxWidth，多出来的宽度留白，不会把卡片撑高。
 */

/** 卡片再窄就不好看缩略图了；和设计稿 3 列时的 271px 差不多 */
export const RECORD_MIN_CARD_WIDTH = 240;
export const RECORD_MAX_CARD_WIDTH = 320;
export const RECORD_MAX_COLUMNS = 5;
export const RECORD_GAP_X = 16;
export const RECORD_GAP_Y = 20;
/** 16:9 缩略图之下的标题 + 状态那两行，含卡片自身 9px 间距 */
export const RECORD_CARD_TEXT_HEIGHT = 64;
export const RECORD_MAX_PAGE_SIZE = 12;
/** 尺寸量不到时（首帧、jsdom）退回旧行为，别让页面空白 */
export const RECORD_FALLBACK_PAGE_SIZE = 3;

export interface RecordPageLayout {
  columns: number;
  rows: number;
  pageSize: number;
  /** 网格的最大宽度：卡片不被撑得超过 RECORD_MAX_CARD_WIDTH */
  maxWidth: number;
  /** 估算的卡片高度，留给测试和排错看 */
  cardHeight: number;
}

export function recordPageLayout(width: number, height: number): RecordPageLayout {
  const fallback: RecordPageLayout = {
    columns: 3, rows: 1, pageSize: RECORD_FALLBACK_PAGE_SIZE,
    maxWidth: 3 * RECORD_MAX_CARD_WIDTH + 2 * RECORD_GAP_X, cardHeight: 0,
  };
  if (width <= 0 || height <= 0) return fallback;

  const cardWidthFor = (count: number) =>
    Math.min(RECORD_MAX_CARD_WIDTH, (width - (count - 1) * RECORD_GAP_X) / count);
  const cardHeightFor = (count: number) =>
    Math.round(cardWidthFor(count) * 9 / 16) + RECORD_CARD_TEXT_HEIGHT;

  let columns = Math.min(
    RECORD_MAX_COLUMNS,
    Math.max(1, Math.floor((width + RECORD_GAP_X) / (RECORD_MIN_CARD_WIDTH + RECORD_GAP_X))),
  );
  // 窗口特别矮时，多加一列让卡片变窄变矮，保证至少一行真的放得下
  while (columns < RECORD_MAX_COLUMNS && cardHeightFor(columns) > height) columns += 1;

  const cardHeight = cardHeightFor(columns);
  const rows = Math.min(3, Math.max(1, Math.floor((height + RECORD_GAP_Y) / (cardHeight + RECORD_GAP_Y))));
  return {
    columns,
    rows,
    pageSize: Math.min(RECORD_MAX_PAGE_SIZE, columns * rows),
    maxWidth: columns * RECORD_MAX_CARD_WIDTH + (columns - 1) * RECORD_GAP_X,
    cardHeight,
  };
}
