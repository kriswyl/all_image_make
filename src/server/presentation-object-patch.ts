/**
 * M2 第一刀：限定原位补丁。
 *
 * 只改本应用生成的「单个文本框 / 普通形状」的字号、颜色、位置、尺寸。
 * 表格、图表、图片、图标、连线都是复合或依赖对象，一律拒绝 —— 整页重做不等于改一个 shape。
 *
 * 硬约束：
 *  1. 目标必须能由 M1 的映射唯一定位；同名或缺失直接失败。
 *  2. 只允许目标页部件发生变化；其它部件哈希必须一致（ZIP 元数据不参与比较）。
 *  3. 补丁后必须能把改动同步回 plan，否则不允许继续声称旧 plan 有效。
 */
import JSZip from "jszip";
import { createHash } from "node:crypto";
import type { AiPresentation } from "./mind-document.js";
import type { PresentationElement } from "./presentation-elements.js";
import { buildObjectMap, resolveObjectBinding } from "./presentation-object-map.js";
import { packPresentationProject } from "./presentation-project.js";
import { fitChars, measureHeight } from "../shared/presentation-capacity.js";
import { syncChartWorkbook, type WorkbookSync } from "./presentation-chart-workbook.js";

export type ObjectPatch = {
  slide: number;
  elementId: string;
  /** 替换文本框内容；`\n` 表示换段，沿用第一段与第一个 run 的格式 */
  text?: string;
  /** 字号（pt） */
  fontSize?: number;
  /** 6 位十六进制，不带 # */
  color?: string;
  /** 英寸，整体替换位置与尺寸 */
  rect?: { x: number; y: number; w: number; h: number };
  /**
   * 换图：给新的图片 data URL。会新增媒体部件、追加该页关系并改 blip 指向；
   * 只影响目标页部件、它的 rels、媒体部件和 Content_Types。
   */
  image?: { data: string };
  /**
   * 改图表数据：只更新图表部件里的显示缓存（分类、系列名、数值）。
   * 内嵌数据表（ppt/embeddings/*.xlsx）不随之更新，会作为警告返回。
   */
  chart?: {
    categories?: string[];
    series?: Array<{ name?: string; values: number[] }>;
  };
  /** 改表格单元格文字：行列从 1 开始，只换文字，单元格样式与边框不动 */
  table?: { cells: Array<{ row: number; col: number; text: string }> };
};

export type PatchReport = {
  applied: Array<{ slide: number; elementId: string; operations: string[] }>;
  rejected: Array<{ slide: number; elementId: string; reason: string }>;
  /**
   * 补丁成功但结果有风险。目前只有一种：文字改长了，按当前字号放不进文本框。
   * 这类页不会被标成内容缺失，但必须让调用方看见 —— 用户打开时可能被截断。
   */
  warnings: Array<{ slide: number; elementId: string; detail: string }>;
  /** 与补丁前相比真正变了的部件；只应有目标页 */
  changedParts: string[];
  unchangedParts: number;
};

const EMU = 914400;
const PATCHABLE = new Set(["text", "shape", "image", "chart", "table"]);
const hex = (value: string) => /^[0-9A-Fa-f]{6}$/.test(value);

/** 解压后逐个部件算哈希：ZIP 时间戳、条目顺序、压缩结果都不参与。 */
async function partHashes(zip: JSZip): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const name of Object.keys(zip.files).sort()) {
    const entry = zip.files[name]!;
    if (entry.dir) continue;
    hashes.set(name, createHash("sha256").update(await entry.async("nodebuffer")).digest("hex"));
  }
  return hashes;
}

function replaced(xml: string, pattern: RegExp, value: string): { xml: string; changed: boolean } {
  if (!pattern.test(xml)) return { xml, changed: false };
  return { xml: xml.replace(pattern, value), changed: true };
}

/** 在单个形状块里改字号：只动已有的 rPr sz，不新增 run。 */
function patchFontSize(block: string, size: number): { block: string; changed: boolean } {
  let changed = false;
  const next = block.replace(/(<a:rPr\b[^>]*\bsz=")(\d+)(")/g, (_match, head: string, _old: string, tail: string) => {
    changed = true;
    return `${head}${Math.round(size * 100)}${tail}`;
  });
  return { block: next, changed };
}

/** 改文字颜色：只替换 rPr 里已有的 srgbClr，避免插入顺序不合 schema。 */
function patchTextColor(block: string, color: string): { block: string; changed: boolean } {
  let changed = false;
  const next = block.replace(/(<a:rPr\b[^>]*>)([\s\S]*?)(<\/a:rPr>)/g, (whole, head: string, body: string, tail: string) => {
    const filled = body.replace(/(<a:solidFill>\s*<a:srgbClr\b[^>]*\bval=")([0-9A-Fa-f]{6})(")/, (_m, before: string, _old: string, after: string) => {
      changed = true;
      return `${before}${color.toUpperCase()}${after}`;
    });
    return filled === body ? whole : `${head}${filled}${tail}`;
  });
  return { block: next, changed };
}

/** 改普通形状的填充色（不是文字颜色）。 */
function patchShapeFill(block: string, color: string): { block: string; changed: boolean } {
  const spPr = /(<p:spPr\b[^>]*>)([\s\S]*?)(<\/p:spPr>)/.exec(block);
  if (!spPr) return { block, changed: false };
  const body = spPr[2]!.replace(/(<a:solidFill>\s*<a:srgbClr\b[^>]*\bval=")([0-9A-Fa-f]{6})(")/, (_m, before: string, _old: string, after: string) => `${before}${color.toUpperCase()}${after}`);
  if (body === spPr[2]) return { block, changed: false };
  return { block: block.replace(spPr[0], `${spPr[1]}${body}${spPr[3]}`), changed: true };
}

function patchRect(block: string, rect: { x: number; y: number; w: number; h: number }): { block: string; changed: boolean } {
  const off = replaced(block, /(<a:off\b[^>]*\bx=")(-?\d+)("[^>]*\by=")(-?\d+)(")/, `$1${Math.round(rect.x * EMU)}$3${Math.round(rect.y * EMU)}$5`);
  const ext = replaced(off.xml, /(<a:ext\b[^>]*\bcx=")(\d+)("[^>]*\bcy=")(\d+)(")/, `$1${Math.round(rect.w * EMU)}$3${Math.round(rect.h * EMU)}$5`);
  return { block: ext.xml, changed: off.changed && ext.changed };
}

/** 文字进 XML 必须转义；控制字符按 XML 1.0 的非法范围剔除。 */
const xmlEscape = (value: string) => value
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/gu, "�")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/**
 * 替换文本框内容。
 *
 * 只动 `<a:t>` 的文字，保留 pPr 与 rPr（字号、颜色、字体、行距全部沿用）；
 * 多段时按原段落数对应，多出来的段落用第一段做模板追加，少了的段落整段移除。
 */
function patchTextContent(block: string, value: string, tag = "p:txBody"): { block: string; changed: boolean } {
  const tx = new RegExp(`(<${tag}\\b[^>]*>)([\\s\\S]*?)(<\\/${tag}>)`).exec(block);
  if (!tx) return { block, changed: false };
  const paragraphs = [...tx[2]!.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)].map(match => match[0]);
  if (!paragraphs.length) return { block, changed: false };
  const lines = value.split(/\r?\n/);

  /** 把一段的第一处文字换成 line，其余 run 清空；没有 run 的段落原样保留（不新建结构）。 */
  const fill = (paragraph: string, line: string): string => {
    let first = true;
    return paragraph.replace(/<a:br\s*\/>/g, "").replace(/<a:t>[\s\S]*?<\/a:t>/g, () => {
      const text = first ? xmlEscape(line) : "";
      first = false;
      return `<a:t>${text}</a:t>`;
    });
  };

  let index = 0;
  const inner = tx[2]!.replace(/<a:p\b[\s\S]*?<\/a:p>/g, paragraph => {
    if (index >= lines.length) { index++; return ""; }
    return fill(paragraph, lines[index++]!);
  });
  const extra = lines.slice(paragraphs.length).map(line => fill(paragraphs[0]!, line)).join("");
  const updated = `${tx[1]}${inner}${extra}${tx[3]}`;
  // 和原 txBody 比，不是和整块比：只比较文字部分是否真的变了。
  if (updated === tx[0]) return { block, changed: false };
  return { block: block.replace(tx[0], updated), changed: true };
}

type ObjectBlock = { block: string; kind: "sp" | "pic" | "graphicFrame" };
/** 找出承载该逻辑对象的块。文本框/形状是 `p:sp`，图片是 `p:pic`，表格/图表是 `p:graphicFrame`。 */
function objectBlock(xml: string, objectName: string): ObjectBlock | null {
  for (const [kind, tag] of [["pic", "p:pic"], ["sp", "p:sp"], ["graphicFrame", "p:graphicFrame"]] as const) {
    for (const match of xml.matchAll(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "g"))) {
      if (match[0].includes(`name="${objectName}"`)) return { block: match[0], kind };
    }
  }
  return null;
}

const DATA_URL = /^(?:data:)?image\/(png|jpeg|jpg);base64,([A-Za-z0-9+/=\r\n]+)$/;
const MIME_EXT: Record<string, { ext: string; mime: string }> = {
  png: { ext: "png", mime: "image/png" },
  jpeg: { ext: "jpeg", mime: "image/jpeg" },
  jpg: { ext: "jpg", mime: "image/jpg" },
};

/**
 * 换图：新增媒体部件 + 该页 rels 追加关系 + blip 指向新 rId + 必要时补 Content_Types。
 * 返回被影响的部件名，交由调用方核对「允许变化」。
 */
async function replaceImage(input: {
  zip: JSZip; slidePart: string; block: string; data: string; elementId: string;
}): Promise<{ block: string; parts: string[] }> {
  const match = DATA_URL.exec(input.data.trim());
  if (!match) throw new Error("图片必须是 png 或 jpeg 的 base64 data URL");
  const meta = MIME_EXT[match[1]!.toLowerCase()]!;
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length < 8 || bytes.length > 5 * 1024 * 1024) throw new Error("图片为空或超过 5 MB");
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const media = `ppt/media/patch-${hash}.${meta.ext}`;
  input.zip.file(media, bytes);

  const relsPath = input.slidePart.replace(/^ppt\/slides\//, "ppt/slides/_rels/") + ".rels";
  const relsFile = input.zip.file(relsPath);
  const existing = relsFile ? await relsFile.async("string") : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  const lastId = [...existing.matchAll(/Id="rId(\d+)"/g)].reduce((max, item) => Math.max(max, Number(item[1])), 0);
  const relId = `rId${lastId + 1}`;
  const relationship = `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/patch-${hash}.${meta.ext}"/>`;
  const nextRels = existing.includes("</Relationships>")
    ? existing.replace("</Relationships>", `${relationship}</Relationships>`)
    : `${existing}${relationship}`;
  input.zip.file(relsPath, nextRels);

  // 只改 blip 的关系指向，不动图片的裁剪与填充设置。
  if (!/<a:blip\b[^>]*r:embed="[^"]*"/.test(input.block)) throw new Error("这个图片对象没有可替换的关系引用");
  const block = input.block.replace(/(<a:blip\b[^>]*r:embed=")[^"]*(")/, `$1${relId}$2`);

  const parts = [relsPath, media];
  // Content_Types 只允许「补声明」，不允许改已有声明。
  const ct = input.zip.file("[Content_Types].xml");
  if (ct) {
    const xml = await ct.async("string");
    const declared = new RegExp(`<Default\\b[^>]*Extension="${meta.ext}"`, "i").test(xml);
    if (!declared) {
      input.zip.file("[Content_Types].xml", xml.replace("</Types>", `<Default Extension="${meta.ext}" ContentType="${meta.mime}"/></Types>`));
      parts.push("[Content_Types].xml");
    }
  }
  return { block, parts };
}

function syncPlanElement(element: PresentationElement, patch: ObjectPatch): PresentationElement {
  if (element.type === "text") {
    const next = { ...element, ...(patch.rect ?? {}), ...(patch.text !== undefined ? { text: patch.text } : {}) };
    if (patch.fontSize !== undefined || patch.color !== undefined) {
      next.style = {
        ...element.style,
        ...(patch.fontSize !== undefined ? { fontSize: patch.fontSize } : {}),
        ...(patch.color !== undefined ? { color: patch.color.toUpperCase() } : {}),
      };
    }
    return next;
  }
  if (element.type === "shape") {
    return { ...element, ...(patch.rect ?? {}), ...(patch.color !== undefined ? { fill: patch.color.toUpperCase() } : {}) };
  }
  if (element.type === "table" && patch.table) {
    const rows = element.rows.map((row, rowIndex) => row.map((text, colIndex) => {
      const next = patch.table!.cells.find(cell => cell.row === rowIndex + 1 && cell.col === colIndex + 1);
      return next ? next.text : text;
    }));
    return { ...element, ...(patch.rect ?? {}), rows };
  }
  if (element.type === "chart") {
    const categories = patch.chart?.categories ?? element.categories;
    const series = element.series.map((item, index) => {
      const next = patch.chart?.series?.[index];
      return next ? { name: next.name ?? item.name, values: next.values } : item;
    });
    return { ...element, ...(patch.rect ?? {}), categories, series };
  }
  return { ...element, ...(patch.rect ?? {}) } as PresentationElement;
}

const cachePoints = (values: string[]) =>
  `<c:ptCount val="${values.length}"/>` + values.map((value, index) => `<c:pt idx="${index}"><c:v>${xmlEscape(String(value))}</c:v></c:pt>`).join("");

/**
 * 改一组系列的数据缓存。
 * 只改缓存内容，`c:f` 的公式引用、格式码、系列样式都保留 —— 结构和样式不是本次操作的职责。
 */
function patchSeries(seriesXml: string, input: { name?: string; categories?: string[]; values?: number[] }): { xml: string; changed: boolean } {
  let xml = seriesXml;
  if (input.name !== undefined) {
    xml = xml.replace(/(<c:tx>[\s\S]*?<c:strCache>)[\s\S]*?(<\/c:strCache>)/, (_match, head: string, tail: string) => `${head}${cachePoints([input.name!])}${tail}`);
  }
  if (input.categories) {
    const points = input.categories.map((value, index) => `<c:pt idx="${index}"><c:v>${xmlEscape(value)}</c:v></c:pt>`).join("");
    if (/<c:multiLvlStrCache>/.test(xml)) {
      xml = xml.replace(/(<c:multiLvlStrCache>)[\s\S]*?(<\/c:multiLvlStrCache>)/, (_match, head: string, tail: string) =>
        `${head}<c:ptCount val="${input.categories!.length}"/><c:lvl>${points}</c:lvl>${tail}`);
    } else if (/<c:cat>[\s\S]*?<c:strCache>/.test(xml)) {
      xml = xml.replace(/(<c:cat>[\s\S]*?<c:strCache>)[\s\S]*?(<\/c:strCache>)/, (_match, head: string, tail: string) =>
        `${head}${cachePoints(input.categories!)}${tail}`);
    }
  }
  if (input.values) {
    xml = xml.replace(/(<c:numCache>)([\s\S]*?)(<\/c:numCache>)/, (_match, head: string, body: string, tail: string) => {
      const format = /<c:formatCode>[^<]*<\/c:formatCode>/.exec(body)?.[0] ?? "<c:formatCode>General</c:formatCode>";
      return `${head}${format}${cachePoints(input.values!.map(String))}${tail}`;
    });
  }
  return { xml, changed: xml !== seriesXml };
}

/**
 * 改表格单元格文字。单元格内是 `a:txBody`，段落与 run 结构跟文本框一致，
 * 所以复用同一套「只换 <a:t>」的逻辑，边框、底纹、字号都不动。
 */
function patchTableCell(block: string, row: number, col: number, text: string): { block: string; changed: boolean } {
  const table = /<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl>/.exec(block);
  if (!table) return { block, changed: false };
  const rows = [...table[1]!.matchAll(/<a:tr\b[^>]*>[\s\S]*?<\/a:tr>/g)].map(match => match[0]);
  const rowXml = rows[row - 1];
  if (!rowXml) return { block, changed: false };
  const cells = [...rowXml.matchAll(/<a:tc>[\s\S]*?<\/a:tc>/g)].map(match => match[0]);
  const cell = cells[col - 1];
  if (!cell) return { block, changed: false };
  const patched = patchTextContent(cell, text, "a:txBody");
  if (!patched.changed) return { block, changed: false };
  const nextTable = table[0].replace(rowXml, rowXml.replace(cell, patched.block));
  return { block: block.replace(table[0], nextTable), changed: true };
}

/** 换图表数据：改 ppt/charts/chartN.xml 的缓存，不重画图表，也不动页面布局。 */
async function replaceChartData(input: {
  zip: JSZip; slidePart: string; block: string;
  chart: NonNullable<ObjectPatch["chart"]>;
  current: { categories: string[]; series: Array<{ name: string; values: number[] }> };
}): Promise<{ parts: string[]; workbook: WorkbookSync; changed: number }> {
  const relId = /<c:chart\b[^>]*r:id="([^"]+)"/.exec(input.block)?.[1];
  if (!relId) throw new Error("这个图表对象没有关系引用");
  const relsPath = input.slidePart.replace(/^ppt\/slides\//, "ppt/slides/_rels/") + ".rels";
  const relsFile = input.zip.file(relsPath);
  if (!relsFile) throw new Error("页面关系缺失，无法定位图表部件");
  const rels = await relsFile.async("string");
  const rel = new RegExp(`<Relationship\\b[^>]*Id="${relId}"[^>]*>`).exec(rels)?.[0];
  if (!rel || !/\/chart"/.test(rel)) throw new Error("这个对象不是图表关系");
  const target = /Target="([^"]+)"/.exec(rel)?.[1];
  if (!target) throw new Error("图表关系缺少目标部件");
  // 关系目标可能是绝对的 /ppt/charts/...，也可能是相对的 ../charts/...
  const chartPart = target.startsWith("/") ? target.slice(1) : `ppt/${target.replace(/^\.\.\//, "")}`;
  const chartFile = input.zip.file(chartPart);
  if (!chartFile) throw new Error("图表部件不存在");

  const chartXml = await chartFile.async("string");
  let next = chartXml, changed = 0;
  const blocks = [...chartXml.matchAll(/<c:ser>[\s\S]*?<\/c:ser>/g)].map(match => match[0]);
  blocks.forEach((block, index) => {
    const patch = input.chart.series?.[index] ? { ...input.chart.series[index]!, ...(input.chart.categories ? { categories: input.chart.categories } : {}) }
      : input.chart.categories ? { categories: input.chart.categories } : undefined;
    if (!patch) return;
    const result = patchSeries(block, patch);
    if (result.changed) { next = next.replace(block, result.xml); changed++; }
  });
  if (!changed) throw new Error("图表数据没有变化");
  input.zip.file(chartPart, next);

  // 显示缓存改完，内嵌工作簿也要跟上，否则「编辑数据」看到的还是旧值。
  const categories = input.chart.categories ?? input.current.categories;
  const series = input.current.series.map((item, index) => {
    const next = input.chart.series?.[index];
    return next ? { name: next.name ?? item.name, values: next.values } : item;
  });
  const workbook = await syncChartWorkbook(input.zip, chartPart, { categories, series });
  return {
    parts: [chartPart, ...(workbook.status === "synced" && workbook.part ? [workbook.part] : [])],
    workbook, changed,
  };
}

export async function patchPresentationObjects(
  bytes: Buffer, plan: AiPresentation, patches: ObjectPatch[],
  images: Array<{ title: string; data: string }> = [],
): Promise<{ bytes: Buffer; plan: AiPresentation; images: Array<{ title: string; data: string }>; report: PatchReport }> {
  if (!patches.length) throw new Error("没有要应用的补丁");
  const map = await buildObjectMap(bytes, plan);
  const zip = await JSZip.loadAsync(bytes);
  const before = await partHashes(zip);
  const nextPlan = structuredClone(plan);
  const report: PatchReport = { applied: [], rejected: [], warnings: [], changedParts: [], unchangedParts: 0 };
  const touchedParts = new Set<string>();
  /** 换图会合法地多改几个部件：该页 rels、新媒体、必要时 Content_Types。 */
  const extraParts = new Set<string>();
  const nextImages = [...images];

  for (const patch of patches) {
    const reject = (reason: string) => report.rejected.push({ slide: patch.slide, elementId: patch.elementId, reason });
    const slide = nextPlan.slides[patch.slide - 1];
    if (!slide) { reject("页码不存在"); continue; }
    // 只有元素页能同步回 plan；box / lines 页没有稳定元素列表，补丁后无法保证 plan 有效。
    if (!slide.elements) { reject("这一页不是元素页（使用了 box 或 lines），补丁无法同步回可编辑源方案"); continue; }
    const element = slide.elements.find(item => item.id === patch.elementId);
    if (!element) { reject("计划里没有这个元素"); continue; }
    if (!PATCHABLE.has(element.type)) { reject(`${element.type} 是复合或依赖对象，原位补丁只支持文本框、普通形状、图片、图表与表格`); continue; }
    // 混写要在逐字段校验之前拦住，否则会被「字段只适用于文本框」这类更具体的报错盖过去。
    if (patch.chart !== undefined && (patch.text !== undefined || patch.fontSize !== undefined || patch.color !== undefined || patch.image !== undefined)) { reject("改图表数据不能和文字、样式或换图写在同一条里"); continue; }
    if (patch.image !== undefined && (patch.text !== undefined || patch.fontSize !== undefined || patch.color !== undefined)) { reject("换图不能和文字或样式补丁写在同一条里"); continue; }
    if (patch.table !== undefined && (patch.text !== undefined || patch.fontSize !== undefined || patch.color !== undefined || patch.image !== undefined || patch.chart !== undefined)) { reject("改表格单元格不能和文字、样式、换图或图表数据写在同一条里"); continue; }

    if (patch.table !== undefined) {
      if (element.type !== "table") { reject("只有表格对象能改单元格"); continue; }
      const rows = element.rows.length, cols = element.rows[0]?.length ?? 0;
      const bad = patch.table.cells.find(cell => !Number.isInteger(cell.row) || !Number.isInteger(cell.col) || cell.row < 1 || cell.row > rows || cell.col < 1 || cell.col > cols);
      if (bad) { reject(`单元格 ${bad.row}-${bad.col} 超出表格范围（${rows} 行 ${cols} 列）`); continue; }
      if (new Set(patch.table.cells.map(cell => `${cell.row}-${cell.col}`)).size !== patch.table.cells.length) { reject("同一个单元格不能在一次补丁里改两次"); continue; }
      if (patch.table.cells.some(cell => cell.text.length > 1000 || /[\r\n]/.test(cell.text))) { reject("单元格文字不能含换行，且不超过 1000 字"); continue; }
    }
    if (patch.chart !== undefined) {
      if (element.type !== "chart") { reject("只有图表对象能改数据"); continue; }
      const categories = patch.chart.categories ?? element.categories;
      if (patch.chart.series && patch.chart.series.length !== element.series.length) {
        reject(`这个图表有 ${element.series.length} 组数据，补丁给了 ${patch.chart.series.length} 组；不支持增删系列`); continue;
      }
      if (patch.chart.categories && patch.chart.categories.length !== element.categories.length) {
        reject(`这个图表有 ${element.categories.length} 个分类，补丁给了 ${patch.chart.categories.length} 个；不支持增删分类`); continue;
      }
      const wrong = (patch.chart.series ?? []).findIndex(item => item.values.length !== categories.length);
      if (wrong >= 0) { reject(`第 ${wrong + 1} 组数据的个数与分类数（${categories.length}）不一致`); continue; }
    }
    if (patch.image !== undefined) {
      if (element.type !== "image") { reject("只有图片对象能换图"); continue; }
      if (patch.text !== undefined || patch.fontSize !== undefined || patch.color !== undefined) { reject("换图不能和文字或样式补丁写在同一条里"); continue; }
    }
    if (patch.fontSize !== undefined && (element.type !== "text" || !(patch.fontSize > 0 && patch.fontSize <= 200))) { reject("字号补丁只适用于文本框，且须在 1–200pt 之间"); continue; }
    if (patch.text !== undefined && (element.type !== "text" || !patch.text.trim() || patch.text.length > 6000 || patch.text.split(/\r?\n/).length > 30)) { reject("文字补丁只适用于文本框：不能为空，最多 6000 字与 30 段"); continue; }
    if (patch.color !== undefined && !hex(patch.color)) { reject("颜色必须是 6 位十六进制"); continue; }
    if (patch.rect && !["x", "y", "w", "h"].every(key => Number.isFinite((patch.rect as Record<string, number>)[key])) || patch.rect && (patch.rect.w <= 0 || patch.rect.h <= 0)) { reject("位置补丁必须给出有限的 x/y/w/h 英寸值"); continue; }

    let binding;
    try { binding = resolveObjectBinding(map, patch.slide, patch.elementId); }
    catch (error) { reject(error instanceof Error ? error.message : String(error)); continue; }
    if (binding.objects.length !== 1) { reject("该元素在页面上对应多个形状，无法只改一个"); continue; }

    const file = zip.file(binding.slidePart);
    if (!file) { reject("页面部件缺失"); continue; }
    const xml = await file.async("string");
    const found = objectBlock(xml, binding.objects[0]!.objectName);
    if (!found) { reject("页面里找不到该对象的形状块"); continue; }

    let nextBlock = found.block;
    const operations: string[] = [];
    if (patch.table !== undefined) {
      if (element.type !== "table") { reject("只有表格对象能改单元格"); continue; }
      const rows = element.rows.length, cols = element.rows[0]?.length ?? 0;
      const bad = patch.table.cells.find(cell => !Number.isInteger(cell.row) || !Number.isInteger(cell.col) || cell.row < 1 || cell.row > rows || cell.col < 1 || cell.col > cols);
      if (bad) { reject(`单元格 ${bad.row}-${bad.col} 超出表格范围（${rows} 行 ${cols} 列）`); continue; }
      if (new Set(patch.table.cells.map(cell => `${cell.row}-${cell.col}`)).size !== patch.table.cells.length) { reject("同一个单元格不能在一次补丁里改两次"); continue; }
      if (patch.table.cells.some(cell => cell.text.length > 1000 || /[\r\n]/.test(cell.text))) { reject("单元格文字不能含换行，且不超过 1000 字"); continue; }
    }
    if (patch.chart !== undefined) {
      if (element.type !== "chart") { reject("只有图表对象能改数据"); continue; }
      const categories = patch.chart.categories ?? element.categories;
      if (patch.chart.series && patch.chart.series.length !== element.series.length) {
        reject(`这个图表有 ${element.series.length} 组数据，补丁给了 ${patch.chart.series.length} 组；不支持增删系列`); continue;
      }
      if (patch.chart.categories && patch.chart.categories.length !== element.categories.length) {
        reject(`这个图表有 ${element.categories.length} 个分类，补丁给了 ${patch.chart.categories.length} 个；不支持增删分类`); continue;
      }
      const wrong = (patch.chart.series ?? []).findIndex(item => item.values.length !== categories.length);
      if (wrong >= 0) { reject(`第 ${wrong + 1} 组数据的个数与分类数（${categories.length}）不一致`); continue; }
    }
    if (patch.image !== undefined) {
      if (found.kind !== "pic") { reject("这个对象不是图片块，无法换图"); continue; }
      try {
        const replaced = await replaceImage({ zip, slidePart: binding.slidePart, block: nextBlock, data: patch.image.data, elementId: patch.elementId });
        nextBlock = replaced.block;
        for (const part of replaced.parts) extraParts.add(part);
        operations.push("image");
        // 新图接在项目图片末尾，plan 的 imageIndex 指向它。
        nextImages.push({ title: `原位换图 ${patch.elementId}`.slice(0, 200), data: patch.image.data });
        (element as { imageIndex: number }).imageIndex = nextImages.length - 1;
      } catch (error) { reject(error instanceof Error ? error.message : String(error)); continue; }
    }
    if (patch.chart !== undefined && element.type === "chart") {
      try {
        const replaced = await replaceChartData({
          zip, slidePart: binding.slidePart, block: nextBlock, chart: patch.chart,
          current: { categories: element.categories, series: element.series },
        });
        for (const part of replaced.parts) extraParts.add(part);
        operations.push("chart");
        if (replaced.workbook.status === "failed") {
          // 同步失败才提示；没有内嵌工作簿的图表不需要。
          report.warnings.push({
            slide: patch.slide, elementId: patch.elementId,
            detail: `图表显示数据已更新，但内嵌数据表同步失败（${replaced.workbook.reason ?? "结构不匹配"}）：在 PowerPoint 里点「编辑数据」可能仍是旧值`,
          });
        }
      } catch (error) { reject(error instanceof Error ? error.message : String(error)); continue; }
    }
    if (patch.table !== undefined && element.type === "table") {
      let changedCells = 0;
      for (const cell of patch.table.cells) {
        const result = patchTableCell(nextBlock, cell.row, cell.col, cell.text);
        if (!result.changed) continue;
        nextBlock = result.block; changedCells++;
      }
      if (!changedCells) { reject("这些单元格的文字没有变化"); continue; }
      operations.push("table");
      // 单元格容量按均分估算：改长了同样要提示，不替用户缩字号。
      const rowCount = element.rows.length, colCount = element.rows[0]?.length ?? 1;
      const fontSize = element.fontSize ?? 16;
      const cellWidth = Math.max(0.3, element.w / colCount - 0.18), cellHeight = element.h / rowCount;
      for (const cell of patch.table.cells) {
        if (!cell.text.trim()) continue;
        if (measureHeight(cell.text, fontSize, { w: cellWidth, h: cellHeight }) > cellHeight + 0.06) {
          report.warnings.push({
            slide: patch.slide, elementId: patch.elementId,
            detail: `第 ${cell.row} 行第 ${cell.col} 列文字可能放不下：${fontSize}pt 下约需 ${measureHeight(cell.text, fontSize, { w: cellWidth, h: cellHeight }).toFixed(2)} 英寸，单元格只有 ${cellHeight.toFixed(2)} 英寸`,
          });
        }
      }
    }
    if (patch.text !== undefined) {
      const result = patchTextContent(nextBlock, patch.text);
      if (!result.changed) { reject("这段文字没有变化，或该元素没有可替换的文字"); continue; }
      nextBlock = result.block; operations.push("text");
    }
    if (patch.fontSize !== undefined) {
      const result = patchFontSize(nextBlock, patch.fontSize);
      if (!result.changed) { reject("该文本框没有可改的字号属性"); continue; }
      nextBlock = result.block; operations.push("fontSize");
    }
    if (patch.color !== undefined) {
      const result = element.type === "text" ? patchTextColor(nextBlock, patch.color) : patchShapeFill(nextBlock, patch.color);
      if (!result.changed) { reject(element.type === "text" ? "该文本框没有可改的文字颜色" : "该形状没有可改的填充色"); continue; }
      nextBlock = result.block; operations.push("color");
    }
    if (patch.rect) {
      const result = patchRect(nextBlock, patch.rect);
      if (!result.changed) { reject("该形状没有可改的位置与尺寸"); continue; }
      nextBlock = result.block; operations.push("rect");
    }
    if (!operations.length) { reject("补丁没有给出任何可执行的修改"); continue; }

    // 图表补丁只改图表部件，页面块本身没变，就不要把页面重写一遍。
    if (nextBlock !== found.block) {
      zip.file(binding.slidePart, xml.replace(found.block, nextBlock));
      touchedParts.add(binding.slidePart);
    }
    slide.elements = slide.elements.map(item => item.id === patch.elementId ? syncPlanElement(item, patch) : item);
    // 补丁成功不等于排版成立：文字变长后按当前字号可能放不进原文本框。
    // 这里只诊断，不擅自缩字号 —— 缩字号是用户的决定，不是补丁的副作用。
    if (patch.text !== undefined && element.type === "text") {
      const fontSize = patch.fontSize ?? element.style?.fontSize ?? 18;
      const rect = patch.rect ?? { x: element.x, y: element.y, w: element.w, h: element.h };
      const needed = measureHeight(patch.text, fontSize, { w: rect.w, h: rect.h });
      if (needed > rect.h + 0.06) {
        const keep = fitChars(patch.text, fontSize, { w: rect.w, h: rect.h });
        report.warnings.push({
          slide: patch.slide, elementId: patch.elementId,
          detail: `文字放不下：${fontSize}pt 下约需 ${needed.toFixed(2)} 英寸，文本框只有 ${rect.h.toFixed(2)} 英寸；当前约能放下 ${keep}/${Array.from(patch.text).length} 字，建议改短、拆页或调大文本框`,
        });
      }
    }
    report.applied.push({ slide: patch.slide, elementId: patch.elementId, operations });
  }

  if (!report.applied.length) {
    return { bytes, plan, images, report };
  }

  // 部件差异：只允许目标页变化，其它部件必须逐字节一致。
  const after = await partHashes(zip);
  for (const [name, hash] of before) {
    if (after.get(name) !== hash) report.changedParts.push(name);
  }
  for (const name of after.keys()) if (!before.has(name)) report.changedParts.push(name);
  report.unchangedParts = [...before.keys()].filter(name => !report.changedParts.includes(name)).length;
  const illegal = report.changedParts.filter(name => !touchedParts.has(name) && !extraParts.has(name));
  if (illegal.length) throw new Error(`补丁越界：${illegal.join("、")} 不应发生变化`);

  const packed = await packPresentationProject(
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), nextPlan, nextImages,
  );
  return { bytes: packed, plan: nextPlan, images: nextImages, report };
}
