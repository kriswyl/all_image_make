/**
 * D2：容量诊断（文档第 12 条 / 第 19.4 节遗留项）。
 *
 * 规矩：装不下时不许「静默缩字号 → 截断 → 塞备注」。顺序必须是
 * 缩字号（有下限）→ 约束内重排（如两栏）→ 按语义边界压缩 → 仍不够才截断，
 * 且每一次降级都要留下可核对的诊断，页面才能被标成「不完整」。
 *
 * 这里只做「量」和「算」：不碰 OOXML，也不决定页面该讲什么。
 */

export type CapacityRect = { w: number; h: number };

export type CapacitySlot = {
  /** 元素 id，与渲染器一致，便于把诊断对回到具体位置 */
  id: string;
  text: string;
  rect: CapacityRect;
  /** 首选字号 */
  fontSize: number;
  /** 该槽位允许的最小字号；低于它就是突破底线 */
  minFontSize: number;
};

export type CapacityIssue = {
  slot: string;
  /** too_long：单段太长；too_many：条目太多；font_floor：压到最小字号仍放不下 */
  kind: "too_long" | "too_many" | "font_floor";
  /** 在最小字号下仍超出多少英寸（>0 表示放不下） */
  overBy: number;
  /** 最小字号下最多能保留几个字 */
  keepChars: number;
  /** 建议动作：reflow 换排法 / compress 压缩文字 / split_page 拆页 */
  remedy: "reflow" | "compress" | "split_page";
  detail: string;
};

export type CapacityDiagnosis = {
  ok: boolean;
  issues: CapacityIssue[];
  /** 压缩后仍丢字的槽位；这些页不能算「内容完整」 */
  truncated: string[];
  /**
   * 因为容量不足改用了重排。`row_height` 表示放弃了行高上限、按内容需要分配
   * （只在条目少、纵向还有余量时有效）；换排法必须记下来，否则「放得下」不可复现。
   */
  reflowed: Array<{ slot: string; mode: "row_height"; detail: string }>;
};

/** 中日韩字符按 1 个字宽，西文按 0.55 估。与 layoutIssues 同一口径，避免两套度量打架。 */
const charWidth = (char: string) => (/[^\x00-\xff]/.test(char) ? 1 : 0.55);
export const textUnits = (text: string) => Array.from(text).reduce((sum, char) => sum + charWidth(char), 0);

const charsPerLine = (rect: CapacityRect, fontSize: number) => Math.max(1, rect.w * 72 / fontSize);
const maxRows = (rect: CapacityRect, fontSize: number) => Math.max(1, Math.floor((rect.h + 0.06) * 72 / (fontSize * 1.2)));

/** 这段文字在给定字号下需要多高（英寸）。 */
export function measureHeight(text: string, fontSize: number, rect: CapacityRect): number {
  const perLine = charsPerLine(rect, fontSize);
  const rows = text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(textUnits(line) / perLine)), 0);
  return rows * fontSize * 1.2 / 72;
}

/** 给定字号、框高，这段文字最多能留下几个字（不做省略号占位）。 */
export function fitChars(text: string, fontSize: number, rect: CapacityRect): number {
  if (measureHeight(text, fontSize, rect) <= rect.h + 0.06) return Array.from(text).length;
  const total = maxRows(rect, fontSize) * Math.floor(charsPerLine(rect, fontSize));
  if (total >= Array.from(text).length) return total;
  // 按字宽折算：一行能放下的「字」数比西文单位少，用二分保证不越过真实容量。
  const chars = Array.from(text);
  let low = 0, high = chars.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (measureHeight(chars.slice(0, middle).join(""), fontSize, rect) <= rect.h + 0.06) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** 语义边界：在这些字符之后断开比从字中间切更可读。 */
const CLAUSE = /[。！？；.!?;，,、：:）)」』】]/;
/**
 * 按容量压缩：优先在分句处断开；断点太靠前就退到字边界。
 * 返回 `cut` 表示确实丢了字 —— 调用方必须把它记进诊断，不能当作正常排版。
 */
export function compressText(text: string, budget: number): { text: string; cut: boolean } {
  const chars = Array.from(text);
  if (budget >= chars.length) return { text, cut: false };
  if (budget <= 0) return { text: "", cut: chars.length > 0 };
  let at = budget;
  for (let index = Math.min(budget, chars.length - 1); index >= Math.ceil(budget * 0.55); index--) {
    if (CLAUSE.test(chars[index]!)) { at = index + 1; break; }
  }
  const head = chars.slice(0, at).join("").trimEnd().replace(/[。！？；.!?;，,、：:）)」』】]+$/u, "");
  return { text: head ? `${head}…` : "…", cut: true };
}

/**
 * 诊断一组槽位。`items` 用于判断「条目太多」——同一容器里条目数超过容量时，
 * 换排法（两栏）比压缩每一条更保内容。
 */
export function diagnoseSlots(input: {
  slots: CapacitySlot[];
  /** 每组条目的槽位 id 与容器可用高度，用于判定 too_many */
  containers?: Array<{ id: string; count: number; rows: 1 | 2 | 3 }>;
}): CapacityDiagnosis {
  const issues: CapacityIssue[] = [];
  for (const slot of input.slots) {
    const needed = measureHeight(slot.text, slot.minFontSize, slot.rect);
    const overBy = needed - (slot.rect.h + 0.06);
    if (needed <= slot.rect.h + 0.06) continue;
    const keepChars = fitChars(slot.text, slot.minFontSize, slot.rect);
    const length = Array.from(slot.text).length;
    const kind = keepChars >= length ? "font_floor" : "too_long";
    issues.push({
      slot: slot.id, kind, overBy: Math.round(overBy * 100) / 100, keepChars,
      remedy: keepChars >= length * 0.5 ? "compress" : "split_page",
      detail: `最小字号 ${slot.minFontSize}pt 下仍差 ${overBy.toFixed(2)} 英寸，只能保留约 ${keepChars}/${length} 字`,
    });
  }
  for (const container of input.containers ?? []) {
    if (container.count <= container.rows * 2) continue;
    issues.push({
      slot: container.id, kind: "too_many", overBy: 0, keepChars: 0, remedy: "reflow",
      detail: `${container.count} 条内容排在 ${container.rows} 行里，单栏放不下，应改为两栏或拆页`,
    });
  }
  return {
    ok: issues.length === 0,
    issues,
    truncated: [],
    reflowed: [],
  };
}
