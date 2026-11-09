import ExcelJS from "exceljs";
import { z } from "zod";
import { openOfficeArchive, readOfficePart } from "./office-archive.js";
import { editXlsxPreserving } from "./xlsx-surgical.js";

const MAX_NEW_CELLS = 50_000;
const MAX_READ_CELLS = 500;
const MAX_READ_CHARS = 18_000;
const CELL_ADDRESS = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/i;
const columnSchema = z.string().regex(/^[A-Z]{1,3}$/i);
const rowNumber = z.number().int().min(1).max(1_048_576);
const MAX_MATCH_ROWS = 100_000;
const MAX_MATCH_IDS = 5_000;
export const spreadsheetValueSchema = z.union([
  z.string().max(32767), z.number(), z.boolean(), z.null(),
  z.object({ formula: z.string().trim().min(1).max(8192) }).strict(),
]);
export const sheetSchema = z.object({
  name: z.string().trim().min(1).max(31),
  rows: z.array(z.array(spreadsheetValueSchema).max(256)).max(10_000),
});
export const cellEditSchema = z.object({ sheet: z.string().min(1).max(31), address: z.string().regex(CELL_ADDRESS), value: spreadsheetValueSchema });

const matchRange = { sheet: z.string().min(1).max(31), column: columnSchema, startRow: rowNumber.optional(), endRow: rowNumber.optional() };
export const matchRowsSchema = z.object({
  ...matchRange,
  ids: z.array(z.string().min(1).max(128)).min(1).max(MAX_MATCH_IDS).optional(),
  list: z.object({ fileId: z.string().min(1), ...matchRange }).strict().optional(),
  fontColor: z.string().regex(/^#?[0-9a-f]{6}$/i).optional(),
  colorColumns: z.object({ from: columnSchema, to: columnSchema }).strict().optional(),
  marker: z.object({
    column: columnSchema.optional(), header: z.string().trim().min(1).max(80).optional(),
    headerRow: rowNumber.optional(), value: z.union([z.string().min(1).max(256), z.number(), z.boolean()]).optional(),
  }).strict().optional(),
}).strict();

type MatchRows = z.infer<typeof matchRowsSchema>;

function coordinate(address: string) {
  if (!CELL_ADDRESS.test(address)) throw new Error(`无效单元格地址：${address}`);
  const column = address.replace(/\d/g, "").toUpperCase().split("").reduce((number, char) => number * 26 + char.charCodeAt(0) - 64, 0);
  const row = Number(address.replace(/\D/g, ""));
  if (column > 16384 || row > 1048576) throw new Error(`单元格地址超出 Excel 范围：${address}`);
  return { row, column };
}

function writeValue(value: z.infer<typeof spreadsheetValueSchema>): ExcelJS.CellValue {
  if (value == null || typeof value !== "object") return value;
  const formula = value.formula.replace(/^=/, "").trim();
  // External workbook links, web calls and DDE are outside the supported formula scope.
  if (!formula || /[\u0000-\u001f\[\]|]|\b(?:WEBSERVICE|RTD|HYPERLINK|IMPORTDATA|STOCKHISTORY)\s*\(/i.test(formula)) throw new Error("仅支持工作簿内部公式");
  return { formula };
}

/** ExcelJS 的模型里没有这些部件，整本往返一次就会丢；有它们时改走外科式写入。 */
const COMPLEX_PARTS = /^(?:_xmlsignatures\/|customXml\/|xl\/(?:charts(?:heets)?|drawings|pivot[^/]*|slicers?[^/]*|externalLinks|embeddings|queryTables|activeX|model)\/|xl\/connections\.xml$)/i;

async function loadWorkbook(bytes: Buffer, editing = false) {
  const zip = await openOfficeArchive(bytes, "xl/workbook.xml", "Excel");
  if (editing && Object.keys(zip.files).some(name => COMPLEX_PARTS.test(name))) {
    throw new Error("此工作簿包含图表、数据透视表、外部连接或其他复杂组件。可以读取数据，当前无法在保留这些组件的情况下修改工作簿");
  }
  let mergedCells = 0;
  for (const part of Object.values(zip.files)) {
    if (part.dir) continue;
    const content = await readOfficePart(part);
    if (!/^xl\/worksheets\/[^/]+\.xml$/i.test(part.name)) continue;
    for (const match of content.toString("utf8").matchAll(/<(?:\w+:)?mergeCell\b[^>]*\bref\s*=\s*["']([^"']+)["']/g)) {
      const [first, last = first] = match[1]!.replace(/\$/g, "").split(":");
      const from = coordinate(first!);
      const to = coordinate(last!);
      if (to.row < from.row || to.column < from.column) throw new Error("Excel 包含无效的合并区域");
      mergedCells += (to.row - from.row + 1) * (to.column - from.column + 1);
      if (mergedCells > 250_000) throw new Error("Excel 合并区域过大，请缩小范围后上传");
    }
  }
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]); }
  catch { throw new Error("无法解析 Excel 工作簿，文件可能已损坏或包含不支持的结构"); }
  if (!workbook.worksheets.length || workbook.worksheets.length > 100) throw new Error("Excel 工作表数量必须在 1 到 100 之间");
  return workbook;
}

function sheetInventory(workbook: ExcelJS.Workbook) {
  return workbook.worksheets.map(sheet => ({ name: sheet.name, rows: sheet.rowCount, columns: sheet.columnCount, state: sheet.state }));
}

export async function inspectXlsx(bytes: Buffer) {
  return sheetInventory(await loadWorkbook(bytes));
}

function describeCell(cell: ExcelJS.Cell) {
  if (cell.type === ExcelJS.ValueType.Formula) return { address: cell.address, formula: cell.formula, cachedValue: cell.result ?? null };
  const value = cell.value;
  if (value == null || typeof value !== "object" || value instanceof Date) return { address: cell.address, value };
  return { address: cell.address, value: cell.text };
}

export async function readXlsx(bytes: Buffer, sheetName?: string, range?: string) {
  const workbook = await loadWorkbook(bytes);
  if (!sheetName) {
    if (range) throw new Error("指定单元格范围时也要填写 sheetName");
    return { sheets: sheetInventory(workbook), hint: "用 sheetName 和 A1 范围读取数据。公式的 cachedValue 来自原文件，可能尚未重算。" };
  }
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new Error(`找不到工作表「${sheetName}」`);
  const defaultEnd = Math.min(20, Math.max(1, sheet.rowCount));
  const endColumn = String.fromCharCode(64 + Math.min(12, Math.max(1, sheet.columnCount)));
  const selection = range ?? `A1:${endColumn}${defaultEnd}`;
  const parts = selection.split(":");
  if (parts.length > 2) throw new Error("范围应为 A1 或 A1:H20");
  const from = coordinate(parts[0]!);
  const to = coordinate(parts[1] ?? parts[0]!);
  const cellCount = (to.row - from.row + 1) * (to.column - from.column + 1);
  if (to.row < from.row || to.column < from.column || cellCount > MAX_READ_CELLS) throw new Error("每次最多读取 500 个单元格，请缩小范围后继续");
  const cells: ReturnType<typeof describeCell>[] = [];
  let chars = 0;
  for (let row = from.row; row <= to.row; row++) {
    for (let column = from.column; column <= to.column; column++) {
      const cell = sheet.findRow(row)?.findCell(column);
      if (!cell || cell.type === ExcelJS.ValueType.Null || cell.type === ExcelJS.ValueType.Merge) continue;
      const result = describeCell(cell);
      chars += JSON.stringify(result).length;
      if (chars > MAX_READ_CHARS) {
        if (cellCount === 1) throw new Error(`单元格 ${cell.address} 文字超过读取上限，请在 Excel 中查看`);
        throw new Error("选中范围内的文字过多，请缩小范围后继续");
      }
      cells.push(result);
    }
  }
  return { sheet: sheet.name, range: selection.toUpperCase(), rows: sheet.rowCount, columns: sheet.columnCount, cells, hint: "省略了空单元格。cachedValue 是保存时的公式结果，可能尚未重算。" };
}

export async function createXlsx(sheets: z.infer<typeof sheetSchema>[]) {
  const workbook = new ExcelJS.Workbook();
  let cells = 0;
  for (const sheet of sheets) {
    if (/[\[\]:*?/\\]/.test(sheet.name) || /^'|'$/.test(sheet.name) || workbook.worksheets.some(item => item.name.toLowerCase() === sheet.name.toLowerCase())) {
      throw new Error(`无效或重复的工作表名称：${sheet.name}`);
    }
    const worksheet = workbook.addWorksheet(sheet.name);
    for (const row of sheet.rows) {
      cells += row.length;
      if (cells > MAX_NEW_CELLS) throw new Error("一次最多写入 50000 个单元格");
      worksheet.addRow(row.map(writeValue));
    }
  }
  workbook.calcProperties.fullCalcOnLoad = true;
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function editXlsx(bytes: Buffer, edits: z.infer<typeof cellEditSchema>[]) {
  const workbook = await loadWorkbook(bytes, true);
  const changed = new Set<string>();
  for (const edit of edits) {
    const sheet = workbook.getWorksheet(edit.sheet);
    if (!sheet) throw new Error(`找不到工作表「${edit.sheet}」`);
    if ((sheet.model as { sheetProtection?: unknown }).sheetProtection) throw new Error(`工作表「${sheet.name}」受保护，请先在 Excel 中解除保护`);
    const { row, column } = coordinate(edit.address);
    const cell = sheet.getCell(row, column);
    const key = `${sheet.id}:${cell.address}`;
    if (changed.has(key)) throw new Error(`单元格 ${sheet.name}!${cell.address} 重复修改`);
    if (cell.isMerged && cell.master.address !== cell.address) throw new Error(`请修改合并单元格的左上角 ${cell.master.address}`);
    const current = cell.value;
    if (current && typeof current === "object" && ("shareType" in current || "sharedFormula" in current)) throw new Error(`单元格 ${sheet.name}!${cell.address} 使用共享或数组公式，暂不能单独修改`);
    cell.value = writeValue(edit.value);
    changed.add(key);
  }
  workbook.calcProperties.fullCalcOnLoad = true;
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function matchId(cell: ExcelJS.Cell | undefined): string | undefined {
  if (!cell || cell.isMerged || cell.type === ExcelJS.ValueType.Formula) return;
  const value = cell.value;
  if (typeof value === "number" && (!Number.isInteger(value) || Number.isSafeInteger(value))) return String(value);
  const text = typeof value === "string" ? value : cell.type === ExcelJS.ValueType.RichText ? cell.text : undefined;
  return text?.trim() ? text : undefined;
}

function hasIdContent(cell: ExcelJS.Cell | undefined) {
  const value = cell?.value;
  return value != null && (typeof value !== "string" || Boolean(value.trim()));
}

function scanRange(sheet: ExcelJS.Worksheet, range: Pick<MatchRows, "column" | "startRow" | "endRow">) {
  const column = coordinate(`${range.column}1`).column;
  const start = range.startRow ?? 2;
  if (range.endRow !== undefined && range.endRow < start) throw new Error("结束行不能小于起始行");
  const end = Math.min(range.endRow ?? sheet.rowCount, sheet.rowCount);
  if (end - start + 1 > MAX_MATCH_ROWS) throw new Error("一次最多匹配 10 万行，请缩小行范围");
  return { column, start, end };
}

async function readMatchIds(bytes: Buffer, list: NonNullable<MatchRows["list"]>) {
  const workbook = await loadWorkbook(bytes);
  const sheet = workbook.getWorksheet(list.sheet);
  if (!sheet) throw new Error(`ID 清单中找不到工作表「${list.sheet}」`);
  const { column, start, end } = scanRange(sheet, list);
  const ids = new Set<string>();
  for (let row = start; row <= end; row++) {
    const cell = sheet.findRow(row)?.findCell(column);
    const id = matchId(cell);
    if (id !== undefined) {
      if (id.length > 128) throw new Error(`ID 清单中的 ${cell!.address} 超过 128 个字符`);
      ids.add(id);
    } else if (hasIdContent(cell)) throw new Error(`ID 清单中的 ${cell!.address} 需要使用普通文本或数值，请检查公式、合并单元格和数字精度`);
    if (ids.size > MAX_MATCH_IDS) throw new Error("一次最多匹配 5000 个不同 ID，请缩小清单范围");
  }
  return ids;
}

function prepareMarker(sheet: ExcelJS.Worksheet, marker: NonNullable<MatchRows["marker"]>, matchColumn: number, start: number) {
  const headerRow = marker.headerRow ?? 1;
  const header = marker.header ?? "标记";
  if (headerRow >= start) throw new Error("标记列的表头行必须位于匹配数据之前");
  const existing: number[] = [];
  let lastUsedColumn = 0;
  sheet.eachRow(row => row.eachCell((_cell, column) => { lastUsedColumn = Math.max(lastUsedColumn, column); }));
  sheet.findRow(headerRow)?.eachCell((cell, column) => { if (cell.value === header) existing.push(column); });
  if (!marker.column && existing.length > 1) throw new Error("有多列同名标记，请指定要使用的列");
  const column = marker.column ? coordinate(`${marker.column}1`).column : existing[0] ?? lastUsedColumn + 1;
  if (column === matchColumn) throw new Error("标记列不能覆盖 ID 列");
  if (column > 16384) throw new Error("工作表已无空余列，请指定标记列");
  const headerCell = sheet.getCell(headerRow, column);
  if (headerCell.isMerged || (headerCell.value != null && headerCell.value !== header)) throw new Error(`标记列表头 ${headerCell.address} 已被占用，请指定其他列`);
  if (headerCell.value == null && column <= lastUsedColumn) {
    let occupied = false;
    sheet.eachRow(row => { if (row.findCell(column)?.value != null) occupied = true; });
    if (occupied) throw new Error("指定的标记列含现有数据，请使用空列或已有的同名标记列");
  }
  return { column, header, headerCell, value: marker.value ?? 1 };
}

function applyFontColor(cell: ExcelJS.Cell, color: { argb: string }) {
  if (cell.type === ExcelJS.ValueType.Merge) return;
  // Loaded cells can share the same style object, so assign a fresh one.
  cell.style = { ...cell.style, font: { ...cell.font, color } };
  if (cell.type === ExcelJS.ValueType.RichText) {
    const value = cell.value as ExcelJS.CellRichTextValue;
    cell.value = { richText: value.richText.map(run => ({ ...run, font: { ...run.font, color } })) };
  }
}

export async function matchAndEditXlsx(bytes: Buffer, options: MatchRows, listBytes?: Buffer) {
  if (Boolean(options.ids) === Boolean(options.list)) throw new Error("请提供一组 ID 或一份 Excel 清单，两者选其一");
  if (!options.fontColor && !options.marker) throw new Error("请指定字体颜色或标记列");
  if (options.colorColumns && !options.fontColor) throw new Error("指定标色列范围时也要提供字体颜色");
  const ids = options.list && listBytes ? await readMatchIds(listBytes, options.list) : new Set(options.ids?.filter(id => id.trim()));
  if (!ids.size) throw new Error("指定范围没有可匹配的 ID，请检查清单和起始行");
  const workbook = await loadWorkbook(bytes, true);
  const sheet = workbook.getWorksheet(options.sheet);
  if (!sheet) throw new Error(`找不到工作表「${options.sheet}」`);
  if ((sheet.model as { sheetProtection?: unknown }).sheetProtection) throw new Error(`工作表「${sheet.name}」受保护，请先在 Excel 中解除保护`);
  const { column, start, end } = scanRange(sheet, options);
  const rows: number[] = [];
  const matched = new Set<string>();
  let skippedCells = 0;
  for (let row = start; row <= end; row++) {
    const cell = sheet.findRow(row)?.findCell(column);
    const id = matchId(cell);
    if (id !== undefined && ids.has(id)) {
      matched.add(id);
      rows.push(row);
    } else if (id === undefined && hasIdContent(cell)) skippedCells++;
  }
  const unmatched = [...ids].filter(id => !matched.has(id));
  const report = { scannedRows: Math.max(0, end - start + 1), requestedIds: ids.size, matchedIds: matched.size, matchedRows: rows.length, unmatched, skippedCells };
  if (!rows.length) return { report };

  const from = options.colorColumns ? coordinate(`${options.colorColumns.from}1`).column : column;
  const to = options.colorColumns ? coordinate(`${options.colorColumns.to}1`).column : column;
  if (to < from || rows.length * (to - from + 1) > 250_000) throw new Error("标色范围过大或无效，请缩小行列范围");
  const marker = options.marker ? prepareMarker(sheet, options.marker, column, start) : undefined;
  if (marker) {
    for (const row of rows) {
      const cell = sheet.getCell(row, marker.column);
      if (cell.isMerged || cell.type === ExcelJS.ValueType.Formula) throw new Error(`标记列的 ${cell.address} 包含公式或合并单元格，请使用空列`);
    }
    marker.headerCell.value = marker.header;
  }
  const color = options.fontColor ? { argb: `FF${options.fontColor.replace(/^#/, "").toUpperCase()}` } : undefined;
  for (const row of rows) {
    if (color) for (let col = from; col <= to; col++) applyFontColor(sheet.getCell(row, col), color);
    if (marker) sheet.getCell(row, marker.column).value = marker.value;
  }
  if (marker) workbook.calcProperties.fullCalcOnLoad = true;
  return { report, bytes: Buffer.from(await workbook.xlsx.writeBuffer()) };
}

/**
 * 改单元格的统一入口：普通工作簿走 ExcelJS，含图表等复杂部件时走外科式写入。
 *
 * 不一律用外科式写：ExcelJS 那条路径已经覆盖了样式、公式校验、合并与边界检查，
 * 也经过了更多真实文件的检验。只有它做不到的情况（会丢部件）才切过去。
 */
export async function editXlsxCells(bytes: Buffer, cells: Array<z.infer<typeof cellEditSchema>>) {
  const zip = await openOfficeArchive(bytes, "xl/workbook.xml", "Excel");
  const complex = Object.keys(zip.files).some(name => COMPLEX_PARTS.test(name));
  if (!complex) return { bytes: await editXlsx(bytes, cells), surgical: false as const, report: undefined };
  const result = await editXlsxPreserving(bytes, cells);
  return { bytes: result.bytes, surgical: true as const, report: result.report };
}
