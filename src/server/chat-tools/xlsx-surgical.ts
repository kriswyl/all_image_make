/**
 * 直接改工作表 XML 的单元格写入。
 *
 * 为什么不走 ExcelJS：ExcelJS 把整个工作簿读进内存再整体重写，图表、数据透视表、
 * 条件格式这些部件不在它的模型里，往返一次就没了 —— 所以含这些部件的工作簿目前只能读不能改。
 *
 * 这里只做一件事：在 `xl/worksheets/sheetN.xml` 里替换目标 `<c>` 元素，需要时补共享字符串、
 * 扩 dimension、给公式打上「打开时重算」，其余部件逐字节不动；改完再把引用了这些单元格的
 * 图表缓存刷新一遍，否则图还是旧数。
 */
import { openOfficeArchive, readOfficePart } from "./office-archive.js";

const CELL_ADDRESS = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/i;
const SST_PART = "xl/sharedStrings.xml";

export type CellValue = string | number | boolean | null | { formula: string };
export type SurgicalEdit = { sheet: string; address: string; value: CellValue };

/** 单元格补丁：给 value 就改值，给 style 就换样式索引，两者可同时给。 */
type CellPatch = { row: number; column: number; ref: string; value?: CellValue; style?: number };

/** 换掉 `s`（样式索引）属性；传 null 则去掉。 */
function setStyleAttribute(openAttrs: string, style: string | null) {
  const cleaned = openAttrs.replace(/\ss="[^"]*"/, "");
  return style === null ? cleaned : `${cleaned} s="${style}"`;
}

type Span = { open: string; inner: string; start: number; end: number };
type Change = { at: number; remove: number; text: string; order: number };

const escapeXml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unescapeXml = (value: string) =>
  value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function attribute(attrs: string, name: string) {
  return new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attrs)?.[1];
}

const columnIndex = (letters: string) => [...letters.toUpperCase()].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);
function columnName(index: number) {
  let rest = index, name = "";
  while (rest > 0) { const digit = (rest - 1) % 26; name = String.fromCharCode(65 + digit) + name; rest = Math.floor((rest - 1) / 26); }
  return name;
}

function splitAddress(address: string) {
  const match = CELL_ADDRESS.exec(address.trim());
  if (!match) throw new Error(`无效单元格地址：${address}`);
  return { column: columnIndex(match[1]!), row: Number(match[2]) };
}

/** 扫出同一层级的元素；这些标签都不会嵌套自己，所以「找闭合标签」是安全的。 */
function scan(source: string, tag: string): Span[] {
  const spans: Span[] = [];
  const opener = new RegExp(`<${tag}\\b([^>]*?)(/?)>`, "g");
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source))) {
    const start = match.index;
    if (match[2] === "/") { spans.push({ open: match[1]!, inner: "", start, end: start + match[0].length }); continue; }
    const close = source.indexOf(`</${tag}>`, opener.lastIndex);
    if (close < 0) break;
    const end = close + tag.length + 3;
    spans.push({ open: match[1]!, inner: source.slice(opener.lastIndex, close), start, end });
    opener.lastIndex = end;
  }
  return spans;
}

/** 从后往前应用改动，避免偏移互相踩。同一位置的多条按 order 降序 —— 后来的排前面，最终顺序才对。 */
function applyChanges(source: string, changes: Change[]) {
  let out = source;
  for (const change of [...changes].sort((a, b) => b.at - a.at || b.order - a.order)) {
    out = out.slice(0, change.at) + change.text + out.slice(change.at + change.remove);
  }
  return out;
}

/** 关系目标可能是 `/xl/worksheets/sheet1.xml` 或 `worksheets/sheet1.xml`。 */
function resolvePart(target: string) {
  if (target.startsWith("/")) return target.slice(1);
  const stack: string[] = [];
  for (const segment of `xl/${target}`.split("/")) {
    if (segment === "..") stack.pop();
    else if (segment && segment !== ".") stack.push(segment);
  }
  return stack.join("/");
}

type Zip = Awaited<ReturnType<typeof openOfficeArchive>>;

async function sheetParts(zip: Zip) {
  const workbookFile = zip.file("xl/workbook.xml");
  if (!workbookFile) throw new Error("工作簿缺少 xl/workbook.xml");
  const workbook = (await readOfficePart(workbookFile)).toString("utf8");
  const relsFile = zip.file("xl/_rels/workbook.xml.rels");
  const rels = relsFile ? (await readOfficePart(relsFile)).toString("utf8") : "";
  const targets = new Map<string, string>();
  for (const match of rels.matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = attribute(match[1]!, "Id");
    const target = attribute(match[1]!, "Target");
    if (id && target) targets.set(id, resolvePart(target));
  }
  const parts: Array<{ name: string; part: string }> = [];
  for (const match of workbook.matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const name = attribute(match[1]!, "name");
    const part = targets.get(attribute(match[1]!, "r:id") ?? "");
    if (name && part && /^xl\/worksheets\/[^/]+\.xml$/i.test(part)) parts.push({ name, part });
  }
  return parts;
}

/** 共享字符串池：原有 `<si>` 原样保留（可能含富文本），新增的走纯文本。 */
function sharedPool(xml: string) {
  const inner = /<sst\b[^>]*>([\s\S]*?)<\/sst>/.exec(xml)?.[1] ?? "";
  const items = scan(inner, "si").map(span => `<si>${span.inner}</si>`);
  const plain = new Map<string, number>();
  items.forEach((item, index) => {
    // 只有单一 <t> 的条目才拿来去重，富文本保持原样不参与
    const single = /^<si><t(?:\s[^>]*)?>([\s\S]*?)<\/t><\/si>$/.exec(item);
    if (single && !plain.has(unescapeXml(single[1]!))) plain.set(unescapeXml(single[1]!), index);
  });
  return { items, plain };
}

type Intern = (text: string) => { xml: string; shared: boolean };

/** 有共享字符串表就走共享字符串，没有就用内联字符串 —— 避免为此新增一个包部件。 */
function makeIntern(pool: ReturnType<typeof sharedPool> | undefined): Intern {
  if (!pool) return text => ({ xml: `<is><t xml:space="preserve">${escapeXml(text)}</t></is>`, shared: false });
  return text => {
    const found = pool.plain.get(text);
    if (found !== undefined) return { xml: `<v>${found}</v>`, shared: true };
    const index = pool.items.length;
    pool.items.push(`<si><t xml:space="preserve">${escapeXml(text)}</t></si>`);
    pool.plain.set(text, index);
    return { xml: `<v>${index}</v>`, shared: true };
  };
}

/** 单元格 XML。样式属性 s 原样保留，否则改个值会把格式也换掉。 */
function renderCell(ref: string, style: string | undefined, value: CellValue, intern: Intern) {
  const s = style ? ` s="${style}"` : "";
  if (value === null || value === "") return { xml: `<c r="${ref}"${s}/>`, shared: false };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("数值必须是有限数");
    return { xml: `<c r="${ref}"${s}><v>${value}</v></c>`, shared: false };
  }
  if (typeof value === "boolean") return { xml: `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`, shared: false };
  if (typeof value === "string") {
    if (value.length > 32767) throw new Error("单元格文字超过 32767 字");
    const body = intern(value);
    // 内联字符串是 <is>，共享字符串是 <v>，靠 body 里是否以 <is 开头区分
    if (body.xml.startsWith("<is")) return { xml: `<c r="${ref}"${s} t="inlineStr">${body.xml}</c>`, shared: false };
    return { xml: `<c r="${ref}"${s} t="s">${body.xml}</c>`, shared: body.shared };
  }
  const formula = value.formula.replace(/^=/, "").trim();
  if (!formula) throw new Error("公式不能为空");
  // 外链、网页抓取与 DDE 超出支持范围，与 ExcelJS 那条路径保持同一套规则
  if (/[\u0000-\u001f\[\]|]|\b(?:WEBSERVICE|RTD|HYPERLINK|IMPORTDATA|STOCKHISTORY)\s*\(/i.test(formula)) {
    throw new Error("仅支持工作簿内部公式");
  }
  // 不写缓存值：交给 Excel/WPS 打开时重算，避免留下与公式不一致的旧数。
  return { xml: `<c r="${ref}"${s}><f>${escapeXml(formula)}</f></c>`, shared: false };
}

/** 写一批单元格到某一行，返回新的行内容。 */
function writeRow(rowInner: string, patches: CellPatch[], intern: Intern) {
  const cells = scan(rowInner, "c").map(span => ({
    ref: attribute(span.open, "r") ?? "",
    open: span.open,
    inner: span.inner,
    start: span.start,
    end: span.end,
    column: splitAddressOrZero(attribute(span.open, "r") ?? ""),
    shared: attribute(span.open, "t") === "s",
    style: attribute(span.open, "s"),
  }));
  const changes: Change[] = [];
  let sharedDelta = 0;
  const place = (patch: CellPatch, text: string) => {
    const existing = cells.find(cell => cell.ref === patch.ref);
    if (existing) changes.push({ at: existing.start, remove: existing.end - existing.start, text, order: patch.column });
    else {
      const next = cells.filter(cell => cell.column > patch.column).sort((a, b) => a.start - b.start)[0];
      changes.push({ at: next ? next.start : rowInner.length, remove: 0, text, order: patch.column });
    }
  };
  for (const patch of patches) {
    const existing = cells.find(cell => cell.ref === patch.ref);
    if (patch.value !== undefined) {
      const rendered = renderCell(patch.ref, patch.style === undefined ? existing?.style : String(patch.style), patch.value, intern);
      if (rendered.shared) sharedDelta++;
      if (existing?.shared) sharedDelta--;
      place(patch, rendered.xml);
      continue;
    }
    if (patch.style === undefined) continue;
    // 只换样式：保留原有内容，只重写开标签里的 s —— 公式、富文本、数字格式都不动。
    const open = setStyleAttribute(existing?.open ?? ` r="${patch.ref}"`, String(patch.style));
    place(patch, existing?.inner ? `<c${open}>${existing.inner}</c>` : `<c${open}/>`);
  }
  return { inner: applyChanges(rowInner, changes), sharedDelta };
}

const splitAddressOrZero = (address: string) => {
  const match = /^([A-Z]+)/i.exec(address);
  return match ? columnIndex(match[1]!) : 0;
};

function writeSheet(xml: string, patches: CellPatch[], intern: Intern) {
  const open = /<sheetData\b[^>]*?(\/?)>/.exec(xml);
  if (!open) throw new Error("工作表缺少 sheetData，无法修改");
  const startInner = open.index + open[0].length;
  const selfClosed = open[1] === "/";
  const closeAt = selfClosed ? startInner : xml.indexOf("</sheetData>", startInner);
  if (closeAt < 0) throw new Error("工作表 sheetData 结构异常");
  const inner = selfClosed ? "" : xml.slice(startInner, closeAt);

  const rows = scan(inner, "row").map(span => ({ r: Number(attribute(span.open, "r") ?? 0), open: span.open, inner: span.inner, start: span.start, end: span.end }));
  const pending = new Map<number, CellPatch[]>();
  for (const patch of patches) {
    const list = pending.get(patch.row) ?? [];
    list.push(patch);
    pending.set(patch.row, list);
  }

  const changes: Change[] = [];
  let sharedDelta = 0;
  for (const [rowNumber, list] of pending) {
    const row = rows.find(item => item.r === rowNumber);
    const written = writeRow(row?.inner ?? "", list, intern);
    sharedDelta += written.sharedDelta;
    if (row) {
      changes.push({ at: row.start, remove: row.end - row.start, text: `<row${row.open}>${written.inner}</row>`, order: rowNumber });
    } else {
      const next = rows.filter(item => item.r > rowNumber).sort((a, b) => a.start - b.start)[0];
      changes.push({ at: next ? next.start : inner.length, remove: 0, text: `<row r="${rowNumber}">${written.inner}</row>`, order: rowNumber });
    }
  }

  const rebuilt = `<sheetData>${applyChanges(inner, changes)}</sheetData>`;
  const before = xml.slice(0, open.index);
  const after = selfClosed ? xml.slice(startInner) : xml.slice(closeAt + "</sheetData>".length);
  return { xml: `${before}${rebuilt}${after}`, sharedDelta };
}

/** 新写的单元格可能落在 dimension 之外，扩一下；不改会让 Excel 认为区域外没有数据。 */
function expandDimension(xml: string, edits: Array<{ row: number; column: number }>) {
  const match = /<dimension\b[^>]*\bref="([^"]*)"/.exec(xml);
  if (!match || !edits.length) return xml;
  const [fromText, toText] = match[1]!.split(":");
  const from = splitAddress(fromText!);
  const to = toText ? splitAddress(toText) : { ...from };
  let minRow = from.row, minColumn = from.column, maxRow = to.row, maxColumn = to.column;
  for (const edit of edits) {
    minRow = Math.min(minRow, edit.row); minColumn = Math.min(minColumn, edit.column);
    maxRow = Math.max(maxRow, edit.row); maxColumn = Math.max(maxColumn, edit.column);
  }
  const ref = `${columnName(minColumn)}${minRow}:${columnName(maxColumn)}${maxRow}`;
  if (ref === match[1]) return xml;
  return xml.slice(0, match.index) + `<dimension ref="${ref}"/>` + xml.slice(match.index + match[0].length);
}

/** 写了公式要让 Excel 打开时重算，否则单元格显示为空白。 */
function markFullCalc(workbookXml: string) {
  const existing = /<calcPr\b[^>]*?\/>/.exec(workbookXml);
  if (existing) {
    const attrs = existing[0];
    const next = /fullCalcOnLoad\s*=/.test(attrs)
      ? attrs.replace(/fullCalcOnLoad\s*=\s*"[^"]*"/, 'fullCalcOnLoad="1"')
      : attrs.replace(/\s*\/>$/, ' fullCalcOnLoad="1"/>');
    return workbookXml.slice(0, existing.index) + next + workbookXml.slice(existing.index + attrs.length);
  }
  return workbookXml.replace(/<\/workbook>\s*$/, '<calcPr fullCalcOnLoad="1"/></workbook>');
}

export type SurgicalReport = {
  /** 实际写入的单元格，形如 `数据!B2` */
  cells: string[];
  /** 缓存被刷新的图表部件 */
  charts: string[];
  warnings: string[];
};

/**
 * 按单元格改工作簿，保留图表、数据透视表等 ExcelJS 不认识的部件。
 *
 * 只处理整格赋值：字符串走共享字符串池（没有池就用内联字符串），数字与布尔直接写，
 * 公式清掉缓存值并标记打开时重算。合并区域里非左上角的单元格会被拒绝 —— Excel 里它本来就不该有值。
 */
export async function editXlsxPreserving(bytes: Buffer, edits: SurgicalEdit[]) {
  const zip = await openOfficeArchive(bytes, "xl/workbook.xml", "Excel");
  if (Object.keys(zip.files).some(name => name.startsWith("_xmlsignatures/"))) {
    throw new Error("工作簿含数字签名，修改会让签名失效，请先在 Excel 里移除");
  }
  const parts = await sheetParts(zip);
  const sstFile = zip.file(SST_PART);
  const pool = sstFile ? sharedPool((await readOfficePart(sstFile)).toString("utf8")) : undefined;
  const intern = makeIntern(pool);

  const report: SurgicalReport = { cells: [], charts: [], warnings: [] };
  const byPart = new Map<string, Array<{ row: number; column: number; ref: string; value: CellValue }>>();
  for (const edit of edits) {
    const part = parts.find(item => item.name === edit.sheet);
    if (!part) throw new Error(`工作表「${edit.sheet}」不存在（现有：${parts.map(item => item.name).join("、")}）`);
    const { row, column } = splitAddress(edit.address);
    const ref = `${columnName(column)}${row}`;
    const list = byPart.get(part.part) ?? [];
    list.push({ row, column, ref, value: edit.value });
    byPart.set(part.part, list);
    report.cells.push(`${edit.sheet}!${ref}`);
  }

  let sharedDelta = 0;
  let hasFormula = false;
  for (const [part, list] of byPart) {
    const file = zip.file(part);
    if (!file) throw new Error(`工作表部件缺失：${part}`);
    const xml = (await readOfficePart(file)).toString("utf8");
    const merged = /<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/.exec(xml)?.[1] ?? "";
    for (const edit of list) {
      for (const match of merged.matchAll(/<mergeCell\b[^>]*\bref="([^"]*)"/g)) {
        const [first, last = first] = match[1]!.split(":");
        const from = splitAddress(first!);
        const to = splitAddress(last!);
        const inside = edit.row >= from.row && edit.row <= to.row && edit.column >= from.column && edit.column <= to.column;
        if (inside && (edit.row !== from.row || edit.column !== from.column)) {
          throw new Error(`${edit.ref} 属于合并区域 ${match[1]}，请改左上角单元格`);
        }
      }
      if (edit.value && typeof edit.value === "object") hasFormula = true;
    }
    const written = writeSheet(xml, list, intern);
    sharedDelta += written.sharedDelta;
    zip.file(part, expandDimension(written.xml, list));
  }

  if (pool) {
    const original = (await readOfficePart(sstFile!)).toString("utf8");
    const count = Number(/<sst\b[^>]*\bcount="(\d+)"/.exec(original)?.[1] ?? 0) + sharedDelta;
    // count 是「被引用次数」，uniqueCount 是池子大小，Excel 会校验这两个值
    zip.file(SST_PART, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${Math.max(count, 0)}" uniqueCount="${pool.items.length}">${pool.items.join("")}</sst>`);
  }

  if (hasFormula) {
    const file = zip.file("xl/workbook.xml")!;
    zip.file("xl/workbook.xml", markFullCalc((await readOfficePart(file)).toString("utf8")));
  }

  const bySheet = new Map<string, Array<{ row: number; column: number; value: CellValue }>>();
  for (const edit of edits) {
    const { row, column } = splitAddress(edit.address);
    const list = bySheet.get(edit.sheet) ?? [];
    list.push({ row, column, value: edit.value });
    bySheet.set(edit.sheet, list);
  }
  for (const part of Object.keys(zip.files).filter(name => /^xl\/charts\/chart[^/]*\.xml$/i.test(name))) {
    const xml = (await readOfficePart(zip.file(part)!)).toString("utf8");
    const refreshed = refreshChartCache(xml, bySheet, report.warnings);
    if (refreshed !== xml) { zip.file(part, refreshed); report.charts.push(part); }
  }

  return { bytes: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), report };
}

/**
 * 按 `<c:f>` 的区域引用刷新 `<c:pt>` 缓存。
 *
 * 只认「单表 + 矩形区域」。三维引用、命名区域、跨表引用一律跳过并记警告 ——
 * 猜错区域会把别的数据写进图表，比不更新更糟。
 */
function refreshChartCache(xml: string, bySheet: Map<string, Array<{ row: number; column: number; value: CellValue }>>, warnings: string[]) {
  return xml.replace(/<c:(strRef|numRef)>([\s\S]*?)<\/c:\1>/g, (block: string, kind: string, body: string) => {
    const formula = /<c:f>([\s\S]*?)<\/c:f>/.exec(body)?.[1];
    if (!formula) return block;
    const reference = /^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/.exec(unescapeXml(formula));
    if (!reference) { warnings.push(`图表引用「${formula}」不是单元格区域，未同步`); return block; }
    const sheet = (reference[1] ?? reference[2] ?? "").replace(/''/g, "'");
    const edits = bySheet.get(sheet);
    if (!edits) return block;
    const range = reference[3]!.replace(/\$/g, "").split(":");
    if (range.length > 2) { warnings.push(`图表引用「${formula}」是三维引用，未同步`); return block; }
    const from = splitAddress(range[0]!);
    const to = range[1] ? splitAddress(range[1]) : { ...from };
    const width = to.column - from.column + 1;
    if (width < 1 || to.row < from.row) return block;

    const points = new Map<number, string>();
    for (const edit of edits) {
      if (edit.row < from.row || edit.row > to.row || edit.column < from.column || edit.column > to.column) continue;
      if (edit.value === null || edit.value === "") { warnings.push(`图表区域 ${formula} 里有单元格被清空，缓存未更新`); continue; }
      if (typeof edit.value === "object") { warnings.push(`图表区域 ${formula} 里有公式，结果要等 Excel 重算，缓存未更新`); continue; }
      points.set((edit.row - from.row) * width + (edit.column - from.column), String(edit.value));
    }
    if (!points.size) return block;

    const tag = kind === "strRef" ? "c:strCache" : "c:numCache";
    const cache = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body);
    if (!cache) return block;
    const rebuilt = rebuildCache(cache[1]!, points);
    const nextBody = body.slice(0, cache.index) + `<${tag}>${rebuilt}</${tag}>` + body.slice(cache.index + cache[0].length);
    return `<c:${kind}>${nextBody}</c:${kind}>`;
  });
}

/** 已有 `<c:pt>` 只换 `<c:v>`（保住 ptExt 之类的附加节点），缺的点补在末尾并抬高 ptCount。 */
function rebuildCache(inner: string, points: Map<number, string>) {
  const seen = new Set<number>();
  let out = inner.replace(/<c:pt\b[^>]*\bidx="(\d+)"[^>]*>([\s\S]*?)<\/c:pt>/g, (whole: string, indexText: string, pointBody: string) => {
    const index = Number(indexText);
    const value = points.get(index);
    if (value === undefined) return whole;
    seen.add(index);
    const escaped = escapeXml(value);
    return /<c:v\s*\/>|<c:v>[\s\S]*?<\/c:v>/.test(pointBody)
      ? whole.replace(/<c:v\s*\/>|<c:v>[\s\S]*?<\/c:v>/, `<c:v>${escaped}</c:v>`)
      : whole.replace("</c:pt>", `<c:v>${escaped}</c:v></c:pt>`);
  });
  const missing = [...points.entries()].filter(([index]) => !seen.has(index)).sort((a, b) => a[0] - b[0]);
  if (!missing.length) return out;
  out += missing.map(([index, value]) => `<c:pt idx="${index}"><c:v>${escapeXml(value)}</c:v></c:pt>`).join("");
  const highest = missing[missing.length - 1]![0] + 1;
  const declared = Number(/<c:ptCount\b[^>]*\bval="(\d+)"/.exec(out)?.[1] ?? 0);
  if (highest > declared) out = out.replace(/<c:ptCount\b[^>]*\/>/, `<c:ptCount val="${highest}"/>`);
  return out;
}

/* ------------------------------------------------------------------ *
 * 批量标记（matchRows）
 *
 * 与上面的单元格写入共用同一套 XML 原语。区别在于这里要改「字体颜色」，
 * 而 xlsx 的颜色藏在 styles.xml：单元格的 `s` 只是 cellXfs 的索引，
 * 真正决定颜色的是 cellXfs[i].fontId → fonts[j] 里的 <color>。
 * 所以要新增一个 font、再新增一个只改了 fontId 的 xf，最后把单元格指过去 ——
 * 直接改已有 font 会把所有共用它的单元格一起染色。
 * ------------------------------------------------------------------ */

type Block = { index: number; text: string; inner: string };

function blockOf(xml: string, tag: string): Block {
  const match = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!match) throw new Error(`styles.xml 缺少 ${tag}，无法修改字体颜色`);
  return { index: match.index, text: match[0], inner: match[2]! };
}

function readStyles(xml: string) {
  const fontsBlock = blockOf(xml, "fonts");
  const xfsBlock = blockOf(xml, "cellXfs");
  return {
    xml,
    fontsBlock,
    xfsBlock,
    fonts: scan(fontsBlock.inner, "font").map(span => fontsBlock.inner.slice(span.start, span.end)),
    xfs: scan(xfsBlock.inner, "xf").map(span => xfsBlock.inner.slice(span.start, span.end)),
  };
}

type Styles = ReturnType<typeof readStyles>;

/** 只改 count，保留 `<fonts>` 上的其它属性（例如 x14ac:knownFonts）。 */
function withCount(block: Block, tag: string, count: number, body: string) {
  const attrs = /^<[a-zA-Z]+\b([^>]*)>/.exec(block.text)?.[1] ?? "";
  const next = /count="\d*"/.test(attrs) ? attrs.replace(/count="\d*"/, `count="${count}"`) : ` count="${count}"`;
  return `<${tag}${next}>${body}</${tag}>`;
}

/** 在 font 里塞一个 rgb 颜色：位置要符合 schema（sz 之后、name 之前）。 */
function withFontColor(font: string, argb: string) {
  const color = `<color rgb="${argb}"/>`;
  if (/<color\b[^>]*\/>/.test(font)) return font.replace(/<color\b[^>]*\/>/, color);
  if (/^<font\s*\/>$/.test(font)) return `<font>${color}</font>`;
  const anchor = /<(name|family|charset|scheme)\b/.exec(font);
  if (anchor) return font.slice(0, anchor.index) + color + font.slice(anchor.index);
  return font.replace(/<\/font>$/, `${color}</font>`);
}

const fontIdOf = (xf: string) => Number(/<xf\b[^>]*\bfontId="(\d+)"/.exec(xf)?.[1] ?? 0);

/** 换开标签上的一个属性；自闭合标签要先把 `/` 让开。 */
function setOpenAttribute(element: string, name: string, value: string) {
  const end = element.indexOf(">");
  const selfClosed = element[end - 1] === "/";
  let head = element.slice(0, selfClosed ? end - 1 : end).replace(/\s+$/, "");
  const tail = element.slice(end);
  const pattern = new RegExp(`\\s${name}="[^"]*"`);
  head = pattern.test(head) ? head.replace(pattern, ` ${name}="${value}"`) : `${head} ${name}="${value}"`;
  return `${head}${selfClosed ? "/" : ""}${tail}`;
}

type SheetLayout = { startInner: number; closeAt: number; selfClosed: boolean; inner: string };

/** 定位 sheetData 与其内容；写入和扫描都用这一份，避免两处口径不一致。 */
function sheetDataOf(xml: string): SheetLayout {
  const open = /<sheetData\b[^>]*?(\/?)>/.exec(xml);
  if (!open) throw new Error("工作表缺少 sheetData，无法修改");
  const startInner = open.index + open[0].length;
  const selfClosed = open[1] === "/";
  const closeAt = selfClosed ? startInner : xml.indexOf("</sheetData>", startInner);
  if (closeAt < 0) throw new Error("工作表 sheetData 结构异常");
  return { startInner, closeAt, selfClosed, inner: selfClosed ? "" : xml.slice(startInner, closeAt) };
}

export type MatchSurgicalOptions = {
  sheet: string;
  column: string;
  startRow?: number;
  endRow?: number;
  fontColor?: string;
  colorColumns?: { from: string; to: string };
  marker?: { column?: string; header?: string; headerRow?: number; value?: string | number | boolean };
};

type CellInfo = { ref: string; row: number; column: number; t?: string; s?: string; inner: string; open: string };

function cellsOfRow(rowInner: string, rowNumber: number) {
  return scan(rowInner, "c").map(span => ({
    ref: attribute(span.open, "r") ?? "",
    row: rowNumber,
    column: splitAddressOrZero(attribute(span.open, "r") ?? ""),
    t: attribute(span.open, "t"),
    s: attribute(span.open, "s"),
    inner: span.inner,
    open: span.open,
  })) satisfies CellInfo[];
}

/**
 * 按 matchRows 的语义改工作簿：命中行改字体颜色、必要时写标记列，其余部件不动。
 *
 * 与 ExcelJS 那条一样：ID 只认「普通文本或整数」，公式、合并、错误值都算跳过；
 * 区别只在于这里是直接改 XML，图表与绘图部件不会被重写。
 */
export async function matchAndEditXlsxPreserving(bytes: Buffer, options: MatchSurgicalOptions, ids: Set<string>) {
  const zip = await openOfficeArchive(bytes, "xl/workbook.xml", "Excel");
  if (Object.keys(zip.files).some(name => name.startsWith("_xmlsignatures/"))) {
    throw new Error("工作簿含数字签名，修改会让签名失效，请先在 Excel 里移除");
  }
  const parts = await sheetParts(zip);
  const part = parts.find(item => item.name === options.sheet);
  if (!part) throw new Error(`找不到工作表「${options.sheet}」`);
  const file = zip.file(part.part);
  if (!file) throw new Error(`工作表部件缺失：${part.part}`);
  const sheetXml = (await readOfficePart(file)).toString("utf8");
  if (/<sheetProtection\b/.test(sheetXml)) throw new Error(`工作表「${options.sheet}」受保护，请先在 Excel 中解除保护`);

  const sstFile = zip.file(SST_PART);
  const readPool = sstFile ? sharedPool((await readOfficePart(sstFile)).toString("utf8")) : undefined;
  const textAt = (index: number) => {
    const item = readPool?.items[index];
    if (!item) return undefined;
    return unescapeXml([...item.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(match => match[1]).join(""));
  };

  const layout = sheetDataOf(sheetXml);
  const rows = scan(layout.inner, "row").map(span => ({ r: Number(attribute(span.open, "r") ?? 0), inner: span.inner }));
  const rowCount = rows.reduce((max, row) => Math.max(max, row.r), 0);
  const cellsByRow = new Map<number, CellInfo[]>(rows.map(row => [row.r, cellsOfRow(row.inner, row.r)]));

  const merged: Array<{ from: { row: number; column: number }; to: { row: number; column: number } }> = [];
  for (const match of (/<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/.exec(sheetXml)?.[1] ?? "").matchAll(/<mergeCell\b[^>]*\bref="([^"]*)"/g)) {
    const [first, last = first] = match[1]!.split(":");
    merged.push({ from: splitAddress(first!), to: splitAddress(last!) });
  }
  const isMerged = (row: number, column: number) =>
    merged.some(range => row >= range.from.row && row <= range.to.row && column >= range.from.column && column <= range.to.column);

  /** 与 matchId 同一套规则：公式与合并不算 ID，整数按文本比较，其余非字符串算跳过。 */
  const idOf = (cell: CellInfo | undefined) => {
    if (!cell || isMerged(cell.row, cell.column)) return undefined;
    if (/<f\b/.test(cell.inner)) return undefined;
    if (cell.t === "s" || cell.t === "inlineStr") {
      const text = cell.t === "s"
        ? textAt(Number(/<v>([\s\S]*?)<\/v>/.exec(cell.inner)?.[1] ?? ""))
        : unescapeXml([...cell.inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(match => match[1]).join(""));
      return text?.trim() ? text : undefined;
    }
    if (cell.t === "b" || cell.t === "e" || cell.t === "str" || cell.t === "d") return undefined;
    const value = Number(/<v>([\s\S]*?)<\/v>/.exec(cell.inner)?.[1] ?? "");
    if (!Number.isFinite(value)) return undefined;
    return !Number.isInteger(value) || Number.isSafeInteger(value) ? String(value) : undefined;
  };
  const hasContent = (cell: CellInfo | undefined) => Boolean(cell && /<v\b|<f\b|<is\b/.test(cell.inner));

  const matchColumn = columnIndex(options.column);
  const start = options.startRow ?? 2;
  if (options.endRow !== undefined && options.endRow < start) throw new Error("结束行不能小于起始行");
  const end = Math.max(start - 1, Math.min(options.endRow ?? rowCount, rowCount));

  const matchedRows: number[] = [];
  const matched = new Set<string>();
  let skippedCells = 0;
  for (let row = start; row <= end; row++) {
    const cell = cellsByRow.get(row)?.find(item => item.column === matchColumn);
    const id = idOf(cell);
    if (id !== undefined && ids.has(id)) { matched.add(id); matchedRows.push(row); }
    else if (id === undefined && hasContent(cell)) skippedCells++;
  }
  const unmatched = [...ids].filter(id => !matched.has(id));
  const report = {
    scannedRows: Math.max(0, end - start + 1),
    requestedIds: ids.size, matchedIds: matched.size, matchedRows: matchedRows.length, unmatched, skippedCells,
  };
  if (!matchedRows.length) return { report: { ...report, surgical: true as const } };

  const from = options.colorColumns ? columnIndex(options.colorColumns.from) : matchColumn;
  const to = options.colorColumns ? columnIndex(options.colorColumns.to) : matchColumn;
  if (to < from || matchedRows.length * (to - from + 1) > 250_000) throw new Error("标色范围过大或无效，请缩小行列范围");

  // ---- 标记列 ----
  let markerColumn: number | undefined;
  let markerHeader = "";
  let markerValue: CellValue = 1;
  if (options.marker) {
    markerHeader = options.marker.header ?? "标记";
    const headerRow = options.marker.headerRow ?? 1;
    if (headerRow >= start) throw new Error("标记列的表头行必须位于匹配数据之前");
    let lastUsedColumn = 0;
    for (const cells of cellsByRow.values()) for (const cell of cells) lastUsedColumn = Math.max(lastUsedColumn, cell.column);
    const headerCells = (cellsByRow.get(headerRow) ?? []);
    const existing = headerCells.filter(cell => textOf(cell, textAt) === markerHeader).map(cell => cell.column);
    if (!options.marker.column && existing.length > 1) throw new Error("有多列同名标记，请指定要使用的列");
    markerColumn = options.marker.column ? columnIndex(options.marker.column) : existing[0] ?? lastUsedColumn + 1;
    if (markerColumn === matchColumn) throw new Error("标记列不能覆盖 ID 列");
    if (markerColumn > 16384) throw new Error("工作表已无空余列，请指定标记列");
    const headerCell = headerCells.find(cell => cell.column === markerColumn);
    if (isMerged(headerRow, markerColumn)) throw new Error(`标记列表头 ${columnName(markerColumn)}${headerRow} 被合并单元格占用，请指定其他列`);
    const headerText = headerCell ? textOf(headerCell, textAt) : undefined;
    if (headerText != null && headerText !== markerHeader) {
      throw new Error(`标记列表头 ${columnName(markerColumn)}${headerRow} 已被占用，请指定其他列`);
    }
    if (headerText == null && markerColumn <= lastUsedColumn) {
      let occupied = false;
      for (const cells of cellsByRow.values()) if (cells.some(cell => cell.column === markerColumn && hasContent(cell))) occupied = true;
      if (occupied) throw new Error("指定的标记列含现有数据，请使用空列或已有的同名标记列");
    }
    for (const row of matchedRows) {
      const cell = cellsByRow.get(row)?.find(item => item.column === markerColumn);
      if (cell && /<f\b/.test(cell.inner)) throw new Error(`标记列的 ${cell.ref} 包含公式，请使用空列`);
      if (isMerged(row, markerColumn)) throw new Error(`标记列的 ${columnName(markerColumn)}${row} 是合并单元格，请使用空列`);
    }
    markerValue = options.marker.value ?? 1;
  }

  // ---- 样式：为每个「原 xf + 颜色」组合准备一个新 xf ----
  const stylesFile = zip.file("xl/styles.xml");
  if (options.fontColor && !stylesFile) throw new Error("工作簿缺少 styles.xml，无法设置字体颜色");
  const styles = options.fontColor ? readStyles((await readOfficePart(stylesFile!)).toString("utf8")) : undefined;
  const argb = options.fontColor ? `FF${options.fontColor.replace(/^#/, "").toUpperCase()}` : "";
  const coloredXf = new Map<number, number>();
  const xfForColor = (originalStyle: number) => {
    const cached = coloredXf.get(originalStyle);
    if (cached !== undefined) return cached;
    const base = styles!.xfs[originalStyle] ?? styles!.xfs[0] ?? '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
    const baseFont = styles!.fonts[fontIdOf(base)] ?? "<font/>";
    styles!.fonts.push(withFontColor(baseFont, argb));
    const next = setOpenAttribute(base, "fontId", String(styles!.fonts.length - 1));
    styles!.xfs.push(next);
    const index = styles!.xfs.length - 1;
    coloredXf.set(originalStyle, index);
    return index;
  };

  // ---- 组装补丁 ----
  const patches: CellPatch[] = [];
  const sheetPool = sstFile ? sharedPool((await readOfficePart(sstFile)).toString("utf8")) : undefined;
  const intern = makeIntern(sheetPool);
  let richTextSkipped = 0;
  if (options.fontColor) {
    for (const row of matchedRows) {
      for (let column = from; column <= to; column++) {
        const cell = cellsByRow.get(row)?.find(item => item.column === column);
        // 共享富文本的颜色写在字符串池的 run 里，改样式索引不会生效，如实跳过
        if (cell?.t === "s" && textAt(Number(/<v>([\s\S]*?)<\/v>/.exec(cell.inner)?.[1] ?? "")) === undefined) richTextSkipped++;
        patches.push({ row, column, ref: `${columnName(column)}${row}`, style: xfForColor(Number(cell?.s ?? 0) || 0) });
      }
    }
  }
  if (options.marker && markerColumn !== undefined) {
    const headerRow = options.marker.headerRow ?? 1;
    patches.push({ row: headerRow, column: markerColumn, ref: `${columnName(markerColumn)}${headerRow}`, value: markerHeader });
    for (const row of matchedRows) patches.push({ row, column: markerColumn, ref: `${columnName(markerColumn)}${row}`, value: markerValue });
  }

  const written = writeSheet(sheetXml, patches, intern);
  zip.file(part.part, expandDimension(written.xml, patches));

  if (sstFile && sheetPool) {
    const original = (await readOfficePart(sstFile)).toString("utf8");
    const count = Number(/<sst\b[^>]*\bcount="(\d+)"/.exec(original)?.[1] ?? 0) + written.sharedDelta;
    zip.file(SST_PART, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${Math.max(count, 0)}" uniqueCount="${sheetPool.items.length}">${sheetPool.items.join("")}</sst>`);
  }
  if (styles) {
    const body = withCount(styles.fontsBlock, "fonts", styles.fonts.length, styles.fonts.join(""));
    const xfs = withCount(styles.xfsBlock, "cellXfs", styles.xfs.length, styles.xfs.join(""));
    // 两块的偏移是相对原文件的，从后往前替换
    const edits = [
      { at: styles.xfsBlock.index, length: styles.xfsBlock.text.length, text: xfs },
      { at: styles.fontsBlock.index, length: styles.fontsBlock.text.length, text: body },
    ].sort((a, b) => b.at - a.at);
    let xml = styles.xml;
    for (const edit of edits) xml = xml.slice(0, edit.at) + edit.text + xml.slice(edit.at + edit.length);
    zip.file("xl/styles.xml", xml);
  }
  if (options.marker) {
    const workbookFile = zip.file("xl/workbook.xml")!;
    zip.file("xl/workbook.xml", markFullCalc((await readOfficePart(workbookFile)).toString("utf8")));
  }

  return {
    report: { ...report, ...(richTextSkipped ? { richTextSkipped } : {}), surgical: true as const },
    bytes: await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
  };
}

/** 读单元格的纯文本（共享字符串 / 内联字符串 / 数字），用于比对标记列的表头。 */
function textOf(cell: CellInfo, textAt: (index: number) => string | undefined) {
  if (cell.t === "s") return textAt(Number(/<v>([\s\S]*?)<\/v>/.exec(cell.inner)?.[1] ?? ""));
  if (cell.t === "inlineStr") return unescapeXml([...cell.inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(match => match[1]).join(""));
  const value = /<v>([\s\S]*?)<\/v>/.exec(cell.inner)?.[1];
  return value === undefined ? undefined : unescapeXml(value);
}
