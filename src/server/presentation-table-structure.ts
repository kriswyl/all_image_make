/**
 * 表格结构补丁：增删行列。
 *
 * 只改 `<a:tbl>` 内部的 `<a:tr>` / `<a:tc>` / `<a:tblGrid>`，单元格边框、底纹、
 * 字号都靠复制模板行/列保留；总行高与总列宽保持不变，避免表格撑出文本框。
 *
 * 合并单元格（gridSpan / rowSpan / hMerge / vMerge）一律拒绝：结构不规整时
 * 复制一行或一列无法保证语义，宁可让调用方先取消合并。
 */

type Parsed = {
  block: string;
  /** 原始 `<a:tbl>...</a:tbl>`，用来在原位替换，保住外层 `<p:graphicFrame>` */
  tableXml: string;
  inner: string;
  rows: string[];
  grid: string;
  widths: number[];
  heights: number[];
};

const ROW = /<a:tr\b[^>]*>[\s\S]*?<\/a:tr>/g;
const CELL = /<a:tc\b[^>]*>[\s\S]*?<\/a:tc>/g;
const GRID = /<a:tblGrid\b[^>]*>([\s\S]*?)<\/a:tblGrid>/;

const rowsOf = (inner: string) => [...inner.matchAll(ROW)].map(match => match[0]);
const cellsOf = (row: string) => [...row.matchAll(CELL)].map(match => match[0]);
const blank = (xml: string) => xml.replace(/<a:t>[\s\S]*?<\/a:t>/g, "<a:t></a:t>");
const attrNumber = (tag: string, name: string) => Number(new RegExp(`\\b${name}="(\\d+)"`).exec(tag)?.[1] ?? 0);
const setRowHeight = (row: string, height: number) => row.replace(/(<a:tr\b[^>]*\bh=")\d+(")/, `$1${height}$2`);

function parse(block: string): Parsed | null {
  const table = /(<a:tbl\b[^>]*>)([\s\S]*?)(<\/a:tbl>)/.exec(block);
  if (!table) return null;
  const inner = table[2]!;
  const rows = rowsOf(inner);
  if (!rows.length) return null;
  const grid = GRID.exec(inner)?.[0] ?? "";
  const widths = [...grid.matchAll(/<a:gridCol\b[^>]*\bw="(\d+)"/g)].map(match => Number(match[1]));
  if (!widths.length) return null;
  const heights = rows.map(row => attrNumber(row, "h"));
  return { block, tableXml: table[0], inner, rows, grid, widths, heights };
}

function rebuild(parsed: Parsed, rows: string[], widths: number[], grid: string): string {
  const first = parsed.rows[0]!, last = parsed.rows[parsed.rows.length - 1]!;
  const nextGrid = grid.replace(/<a:tblGrid\b[^>]*>[\s\S]*?<\/a:tblGrid>/, `<a:tblGrid>${widths.map(width => `<a:gridCol w="${width}"/>`).join("")}</a:tblGrid>`);
  const inner = parsed.inner.replace(grid, nextGrid);
  const start = inner.indexOf(first), end = inner.indexOf(last) + last.length;
  // 只替换表格本身，外层 graphicFrame 与其中的位置信息必须原样保留。
  const table = parsed.tableXml.replace(parsed.inner, `${inner.slice(0, start)}${rows.join("")}${inner.slice(end)}`);
  return parsed.block.replace(parsed.tableXml, table);
}

/** 行数变化后按总高度均分，表格外框（a:ext）不变，避免撑出文本框。 */
function normalizedRows(rows: string[], total: number): string[] {
  if (!total) return rows;
  const height = Math.round(total / rows.length);
  return rows.map(row => setRowHeight(row, height));
}

function assertNoMerge(parsed: Parsed): void {
  if (/(?:gridSpan|rowSpan|hMerge|vMerge)=/.test(parsed.inner)) throw new Error("表格包含合并单元格，暂不支持增删行列");
}

export function insertRows(block: string, at: number, count: number): { block: string; changed: boolean } {
  const parsed = parse(block);
  if (!parsed) return { block, changed: false };
  assertNoMerge(parsed);
  if (at < 1 || at > parsed.rows.length + 1) return { block, changed: false };
  const template = parsed.rows[at - 1] ?? parsed.rows[parsed.rows.length - 1]!;
  const added = Array.from({ length: count }, () => blank(template));
  const rows = [...parsed.rows.slice(0, at - 1), ...added, ...parsed.rows.slice(at - 1)];
  const total = parsed.heights.reduce((sum, value) => sum + value, 0);
  return { block: rebuild(parsed, normalizedRows(rows, total), parsed.widths, parsed.grid), changed: true };
}

export function deleteRows(block: string, at: number, count: number): { block: string; changed: boolean } {
  const parsed = parse(block);
  if (!parsed) return { block, changed: false };
  assertNoMerge(parsed);
  if (at < 1 || at + count - 1 > parsed.rows.length || parsed.rows.length - count < 1) return { block, changed: false };
  const rows = [...parsed.rows.slice(0, at - 1), ...parsed.rows.slice(at - 1 + count)];
  const total = parsed.heights.reduce((sum, value) => sum + value, 0);
  return { block: rebuild(parsed, normalizedRows(rows, total), parsed.widths, parsed.grid), changed: true };
}

export function insertColumns(block: string, at: number, count: number): { block: string; changed: boolean } {
  const parsed = parse(block);
  if (!parsed) return { block, changed: false };
  assertNoMerge(parsed);
  const columns = parsed.widths.length;
  if (at < 1 || at > columns + 1) return { block, changed: false };
  const total = parsed.widths.reduce((sum, value) => sum + value, 0);
  const widths = Array.from({ length: columns + count }, () => Math.round(total / (columns + count)));
  const rows = parsed.rows.map(row => {
    const cells = cellsOf(row);
    const template = cells[at - 1] ?? cells[cells.length - 1]!;
    const added = Array.from({ length: count }, () => blank(template));
    const nextCells = [...cells.slice(0, at - 1), ...added, ...cells.slice(at - 1)];
    const first = cells[0]!, last = cells[cells.length - 1]!;
    const start = row.indexOf(first), end = row.indexOf(last) + last.length;
    return row.slice(0, start) + nextCells.join("") + row.slice(end);
  });
  return { block: rebuild(parsed, rows, widths, parsed.grid), changed: true };
}

export function deleteColumns(block: string, at: number, count: number): { block: string; changed: boolean } {
  const parsed = parse(block);
  if (!parsed) return { block, changed: false };
  assertNoMerge(parsed);
  const columns = parsed.widths.length;
  if (at < 1 || at + count - 1 > columns || columns - count < 1) return { block, changed: false };
  const total = parsed.widths.reduce((sum, value) => sum + value, 0);
  const widths = Array.from({ length: columns - count }, () => Math.round(total / (columns - count)));
  const rows = parsed.rows.map(row => {
    const cells = cellsOf(row);
    const nextCells = [...cells.slice(0, at - 1), ...cells.slice(at - 1 + count)];
    const first = cells[0]!, last = cells[cells.length - 1]!;
    const start = row.indexOf(first), end = row.indexOf(last) + last.length;
    return row.slice(0, start) + nextCells.join("") + row.slice(end);
  });
  return { block: rebuild(parsed, rows, widths, parsed.grid), changed: true };
}

/** 结构补丁后页面上真正的行列数，供 plan 同步与范围校验。 */
export function tableShape(block: string): { rows: number; columns: number } | null {
  const parsed = parse(block);
  if (!parsed) return null;
  return { rows: parsed.rows.length, columns: parsed.widths.length };
}
