import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { openOfficeArchive, readOfficePart } from "./office-archive.js";

const MAIN = "word/document.xml";
const textOptions = { preserveOrder: true, ignoreAttributes: false, commentPropName: "#comment", cdataPropName: "#cdata" };
const parser = new XMLParser({ ...textOptions, parseTagValue: false, trimValues: false });
const builder = new XMLBuilder({ ...textOptions, suppressEmptyNode: true });
type XmlNode = Record<string, unknown>;

function tag(node: XmlNode) { return Object.keys(node).find(key => key !== ":@"); }
function children(node: XmlNode): XmlNode[] {
  const value = node[tag(node) ?? ""];
  return Array.isArray(value) ? value as XmlNode[] : [];
}

async function readBody(bytes: Buffer) {
  const zip = await openOfficeArchive(bytes, MAIN, "Word");
  const xml = (await readOfficePart(zip.file(MAIN)!)).toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Word 正文包含不支持的 XML 声明");
  const nodes = parser.parse(xml) as XmlNode[];
  const root = nodes.find(node => /(?:^|:)document$/.test(tag(node) ?? ""));
  if (!root) throw new Error("Word 文件里没有正文");
  const prefix = tag(root)!.slice(0, -"document".length);
  const body = children(root).find(node => tag(node) === `${prefix}body`);
  if (!body) throw new Error("Word 文件里没有正文");
  return { zip, nodes, body, prefix };
}

function paragraphText(paragraph: XmlNode, prefix: string) {
  const pieces: string[] = [];
  function visit(node: XmlNode) {
    const name = tag(node);
    if (name === `${prefix}t`) pieces.push(children(node).map(child => String(child["#text"] ?? "")).join(""));
    else if (name === `${prefix}tab`) pieces.push("\t");
    else if (name === `${prefix}br` || name === `${prefix}cr`) pieces.push("\n");
    else if (name !== `${prefix}del` && name !== `${prefix}p`) children(node).forEach(visit);
  }
  children(paragraph).forEach(visit);
  return pieces.join("");
}

function paragraphStyle(paragraph: XmlNode, prefix: string) {
  const properties = children(paragraph).find(node => tag(node) === `${prefix}pPr`);
  const style = properties && children(properties).find(node => tag(node) === `${prefix}pStyle`);
  const attrs = style?.[":@"] as Record<string, string> | undefined;
  const match = /heading\s*([1-6])$/i.exec(attrs?.[`@_${prefix}val`] ?? "");
  return match ? `${"#".repeat(Number(match[1]))} ` : "";
}

/**
 * 按文字唯一命中一个段落。
 *
 * 替换文字、字符样式、段落样式三条入口共用同一套匹配规则：命中 0 次报「未找到」，
 * 命中多处报「匹配多次」，绝不按顺序取第一个 —— 猜错位置比报错更难收拾。
 */
function matchParagraph(body: XmlNode, prefix: string, find: string, label: string) {
  if (/[\u0000-\u001f]/.test(find)) throw new Error(`${label}仅支持段落内文字，请勿包含换行或控制字符`);
  const paragraphs: XmlNode[] = [];
  function collect(node: XmlNode) {
    const name = tag(node);
    if (name === `${prefix}p`) paragraphs.push(node);
    else if (name !== `${prefix}del` && name !== `${prefix}drawing`) children(node).forEach(collect);
  }
  collect(body);
  const matches = paragraphs.filter(paragraph => paragraphText(paragraph, prefix).includes(find));
  if (!matches.length) throw new Error(`${label}未找到原文，请重新读取文件`);
  if (matches.length > 1 || paragraphText(matches[0]!, prefix).split(find).length > 2) {
    throw new Error(`${label}匹配多次，请提供更多上下文以确定位置`);
  }
  return matches[0]!;
}

export async function readDocxText(bytes: Buffer): Promise<string> {
  const { body, prefix } = await readBody(bytes);
  const lines: string[] = [];
  function collect(node: XmlNode, target: string[]) {
    const name = tag(node);
    if (name === `${prefix}p`) {
      const text = paragraphText(node, prefix).trim();
      if (text) target.push(paragraphStyle(node, prefix) + text);
    } else if (name === `${prefix}tr`) {
      const cells = children(node).filter(cell => tag(cell) === `${prefix}tc`).map(cell => {
        const parts: string[] = [];
        children(cell).forEach(part => collect(part, parts));
        return parts.join(" ").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
      });
      if (cells.length) target.push(`| ${cells.join(" | ")} |`);
    } else if (name !== `${prefix}del` && name !== `${prefix}drawing`) {
      children(node).forEach(child => collect(child, target));
    }
  }
  collect(body, lines);
  if (!lines.length) throw new Error("Word 文档里没有可读文字");
  return lines.join("\n");
}

/** Replace unique text within normal paragraph runs. Keep style and non-body package parts. */
export async function editDocxText(bytes: Buffer, edits: Array<{ find: string; replace: string }>) {
  const { zip, nodes, body, prefix } = await readBody(bytes);
  if (Object.keys(zip.files).some(name => name.startsWith("_xmlsignatures/"))) throw new Error("带数字签名的 Word 文件不能直接修改");
  const paragraphs: XmlNode[] = [];
  function collect(node: XmlNode) {
    const name = tag(node);
    if (name === `${prefix}p`) paragraphs.push(node);
    else if (name !== `${prefix}del` && name !== `${prefix}drawing`) children(node).forEach(collect);
  }
  collect(body);
  for (const [index, edit] of edits.entries()) {
    const label = `第 ${index + 1} 处修改`;
    if (/[\u0000-\u001f]/.test(edit.find + edit.replace)) throw new Error(`${label}仅支持段落内文字替换，请勿包含换行或控制字符`);
    const matches = paragraphs.flatMap(paragraph => {
      const text = paragraphText(paragraph, prefix);
      const start = text.indexOf(edit.find);
      return start < 0 ? [] : [{ paragraph, repeat: text.indexOf(edit.find, start + 1) >= 0 }];
    });
    if (!matches.length) throw new Error(`${label}未找到原文，请重新读取文件`);
    if (matches.length !== 1 || matches[0]!.repeat) throw new Error(`${label}匹配多次，请提供更多上下文以确定位置`);
    const runs = children(matches[0]!.paragraph);
    const groups: XmlNode[][] = [[]];
    for (const run of runs) {
      if (tag(run) === `${prefix}pPr`) continue;
      if (tag(run) !== `${prefix}r`) { groups.push([]); continue; }
      for (const item of children(run)) {
        if (tag(item) === `${prefix}t`) groups.at(-1)!.push(item);
        else if (tag(item) !== `${prefix}rPr`) groups.push([]);
      }
    }
    const readText = (node: XmlNode) => children(node).map(child => String(child["#text"] ?? "")).join("");
    const group = groups.find(items => items.map(readText).join("").includes(edit.find));
    if (!group || runs.some(run => children(run).some(item => tag(item) === `${prefix}fldChar`))) {
      throw new Error(`${label}跨越链接、字段或其他特殊格式，请缩小修改范围`);
    }
    const start = group.map(readText).join("").indexOf(edit.find);
    const end = start + edit.find.length;
    let position = 0;
    for (const item of group) {
      const text = readText(item);
      const stop = position + text.length;
      if (position < end && stop > start) {
        const left = Math.max(0, start - position);
        const value = text.slice(0, left) + (position <= start ? edit.replace : "") + text.slice(Math.min(text.length, end - position));
        item[`${prefix}t`] = [{ "#text": value }];
        if (/^\s|\s$/.test(value)) item[":@"] = { ...(item[":@"] as object | undefined), "@_xml:space": "preserve" };
      }
      position = stop;
    }
  }
  zip.file(MAIN, builder.build(nodes));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** Word 字符属性在 rPr 里的 schema 顺序；乱序会让部分阅读器告警。 */
const RPR_ORDER = [
  "rStyle", "rFonts", "b", "bCs", "i", "iCs", "caps", "smallCaps", "strike", "dstrike", "outline", "shadow",
  "emboss", "imprint", "noProof", "snapToGrid", "vanish", "webHidden", "color", "spacing", "w", "kern",
  "position", "sz", "szCs", "highlight", "u", "effect", "bdr", "shd", "fitText", "vertAlign", "rtl", "cs",
  "em", "lang", "eastAsianLayout", "specVanish", "oMath",
];

export type DocxTextStyle = {
  find: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  /** 6 位十六进制，不带 # */
  color?: string;
  /** 磅值，写入时换算成半磅 */
  fontSize?: number;
};

/**
 * 给指定文字加字符样式。
 *
 * 只改命中文字所在的 run 的 rPr，段落属性、其它 run、页眉页脚和包内部件都不动。
 * 文字跨多个 run 时，样式会落到每一个相交的 run 上（不拆 run，避免破坏原有格式）。
 */
export async function styleDocxText(bytes: Buffer, styles: DocxTextStyle[]) {
  const { zip, nodes, body, prefix } = await readBody(bytes);
  if (Object.keys(zip.files).some(name => name.startsWith("_xmlsignatures/"))) throw new Error("带数字签名的 Word 文件不能直接修改");

  const readText = (node: XmlNode) => children(node).map(child => String(child["#text"] ?? "")).join("");
  const setProperty = (rPr: XmlNode, name: string, value?: Record<string, string>) => {
    const items = children(rPr);
    const node: XmlNode = { [`${prefix}${name}`]: [], ...(value ? { ":@": value } : {}) };
    const index = items.findIndex(item => tag(item) === `${prefix}${name}`);
    if (index >= 0) items.splice(index, 1, node);
    else items.push(node);
    // 按 rPr 的 schema 顺序重排，未知节点保持相对位置跟在后面。
    items.sort((left, right) => {
      const rank = (node: XmlNode) => {
        const key = (tag(node) ?? "").slice(prefix.length);
        const at = RPR_ORDER.indexOf(key);
        return at < 0 ? RPR_ORDER.length : at;
      };
      return rank(left) - rank(right);
    });
  };

  for (const [index, style] of styles.entries()) {
    const label = `第 ${index + 1} 处样式`;
    const paragraph = matchParagraph(body, prefix, style.find, label);

    const runs = children(paragraph).filter(run => tag(run) === `${prefix}r`);
    const text = runs.map(run => children(run).filter(item => tag(item) === `${prefix}t`).map(readText).join("")).join("");
    const start = text.indexOf(style.find);
    if (start < 0) throw new Error(`${label}跨越表格、字段或其他结构，请缩小范围`);
    const end = start + style.find.length;

    let position = 0;
    let touched = 0;
    for (const run of runs) {
      const piece = children(run).filter(item => tag(item) === `${prefix}t`).map(readText).join("");
      const from = position, to = position + piece.length;
      position = to;
      if (!piece || to <= start || from >= end) continue;
      if (children(run).some(item => tag(item) === `${prefix}fldChar`)) throw new Error(`${label}落在字段或链接里，请缩小修改范围`);
      let rPr = children(run).find(item => tag(item) === `${prefix}rPr`);
      if (!rPr) {
        rPr = { [`${prefix}rPr`]: [] };
        children(run).unshift(rPr);
      }
      if (style.bold !== undefined) setProperty(rPr, "b", style.bold ? undefined : { [`@_${prefix}val`]: "0" });
      if (style.italic !== undefined) setProperty(rPr, "i", style.italic ? undefined : { [`@_${prefix}val`]: "0" });
      if (style.underline !== undefined) setProperty(rPr, "u", { [`@_${prefix}val`]: style.underline ? "single" : "none" });
      if (style.color !== undefined) setProperty(rPr, "color", { [`@_${prefix}val`]: style.color.toUpperCase() });
      if (style.fontSize !== undefined) {
        setProperty(rPr, "sz", { [`@_${prefix}val`]: String(Math.round(style.fontSize * 2)) });
        setProperty(rPr, "szCs", { [`@_${prefix}val`]: String(Math.round(style.fontSize * 2)) });
      }
      touched++;
    }
    if (!touched) throw new Error(`${label}没有落到可样式的文字上`);
  }

  zip.file(MAIN, builder.build(nodes));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** `w:pPr` 子节点的 schema 顺序；乱序时 Word 可能整段忽略，或只认前半截。 */
const PPR_ORDER = [
  "pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl", "numPr",
  "suppressLineNumbers", "pBdr", "shd", "tabs", "suppressAutoHyphens", "kinsoku", "wordWrap",
  "overflowPunct", "topLinePunct", "autoSpaceDE", "autoSpaceDN", "bidi", "adjustRightInd",
  "snapToGrid", "spacing", "ind", "contextualSpacing", "mirrorIndents", "suppressOverlap", "jc",
  "textDirection", "textAlignment", "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr",
  "sectPr", "pPrChange",
];

const ALIGN_VALUES = { left: "left", center: "center", right: "right", justify: "both" } as const;

export type DocxParagraphStyle = {
  find: string;
  /** 对齐方式 */
  align?: keyof typeof ALIGN_VALUES;
  /** 倍数行距（1.5 即 1.5 倍），写入为 w:line = 240 × 倍数 */
  lineSpacing?: number;
  /** 段前间距（磅） */
  spaceBefore?: number;
  /** 段后间距（磅） */
  spaceAfter?: number;
  /** 首行缩进字符数，中文常用 2 */
  firstLineChars?: number;
  /** 左缩进（磅） */
  indentLeft?: number;
};

/** 段落第一个 run 的字号（磅），用于把「字符数」换算成 twips；取不到时按五号 10.5pt 算。 */
function paragraphFontSize(paragraph: XmlNode, prefix: string) {
  for (const run of children(paragraph)) {
    if (tag(run) !== `${prefix}r`) continue;
    const rPr = children(run).find(item => tag(item) === `${prefix}rPr`);
    const size = rPr && children(rPr).find(item => tag(item) === `${prefix}sz`);
    const value = Number((size?.[":@"] as Record<string, string> | undefined)?.[`@_${prefix}val`]);
    if (value > 0) return value / 2;
  }
  return 10.5;
}

/**
 * 往 `pPr` 里写一个属性节点，按 schema 顺序重排。
 *
 * 与字符样式不同的是这里**合并属性**而不是整节点替换：`w:spacing` 上可能同时挂着
 * 行距与段前段后，整节点替换会把用户原有的那几项抹掉。`remove` 用来清掉互斥项，
 * 例如设首行缩进时必须去掉悬挂缩进，否则 Word 按悬挂算。
 */
function setParagraphAttribute(pPr: XmlNode, prefix: string, name: string, attrs: Record<string, string>, remove: string[] = []) {
  const items = children(pPr);
  const key = `${prefix}${name}`;
  let node = items.find(item => tag(item) === key);
  if (!node) {
    node = { [key]: [] };
    items.push(node);
  }
  const current = { ...((node[":@"] as Record<string, string> | undefined) ?? {}) };
  for (const drop of remove) delete current[`@_${prefix}${drop}`];
  node[":@"] = { ...current, ...attrs };
  items.sort((left, right) => {
    const rank = (item: XmlNode) => {
      const at = PPR_ORDER.indexOf((tag(item) ?? "").slice(prefix.length));
      return at < 0 ? PPR_ORDER.length : at;
    };
    return rank(left) - rank(right);
  });
}

/**
 * 给指定段落加段落级样式：对齐、行距、段前段后、缩进。
 *
 * 只改命中段落的 `pPr`：文字、字符样式、其它段落、表格结构与包内部件都不动。
 * 匹配规则与文字替换一致 —— 唯一命中才改。
 */
export async function styleDocxParagraphs(bytes: Buffer, styles: DocxParagraphStyle[]) {
  const { zip, nodes, body, prefix } = await readBody(bytes);
  if (Object.keys(zip.files).some(name => name.startsWith("_xmlsignatures/"))) throw new Error("带数字签名的 Word 文件不能直接修改");

  for (const [index, style] of styles.entries()) {
    const label = `第 ${index + 1} 处段落样式`;
    const given = [style.align, style.lineSpacing, style.spaceBefore, style.spaceAfter, style.firstLineChars, style.indentLeft];
    if (given.every(value => value === undefined)) throw new Error(`${label}没有给出任何段落属性`);
    if (style.lineSpacing !== undefined && !(style.lineSpacing >= 0.5 && style.lineSpacing <= 5)) {
      throw new Error(`${label}行距倍数须在 0.5–5 之间`);
    }
    for (const value of [style.spaceBefore, style.spaceAfter, style.indentLeft]) {
      if (value !== undefined && !(value >= 0 && value <= 500)) throw new Error(`${label}段间距与缩进须在 0–500 磅之间`);
    }
    if (style.firstLineChars !== undefined && !(style.firstLineChars >= 0 && style.firstLineChars <= 20)) {
      throw new Error(`${label}首行缩进字符数须在 0–20 之间`);
    }

    const paragraph = matchParagraph(body, prefix, style.find, label);
    const items = children(paragraph);
    let pPr = items.find(node => tag(node) === `${prefix}pPr`);
    if (pPr) {
      // pPr 必须是段落的第一个子节点，否则整段属性会被忽略。
      if (items[0] !== pPr) {
        items.splice(items.indexOf(pPr), 1);
        items.unshift(pPr);
      }
    } else {
      pPr = { [`${prefix}pPr`]: [] };
      items.unshift(pPr);
    }

    if (style.align) setParagraphAttribute(pPr, prefix, "jc", { [`@_${prefix}val`]: ALIGN_VALUES[style.align] });
    if (style.lineSpacing !== undefined) {
      setParagraphAttribute(pPr, prefix, "spacing", {
        [`@_${prefix}line`]: String(Math.round(style.lineSpacing * 240)),
        [`@_${prefix}lineRule`]: "auto",
      });
    }
    if (style.spaceBefore !== undefined || style.spaceAfter !== undefined) {
      const attrs: Record<string, string> = {};
      if (style.spaceBefore !== undefined) attrs[`@_${prefix}before`] = String(Math.round(style.spaceBefore * 20));
      if (style.spaceAfter !== undefined) attrs[`@_${prefix}after`] = String(Math.round(style.spaceAfter * 20));
      setParagraphAttribute(pPr, prefix, "spacing", attrs);
    }
    if (style.firstLineChars !== undefined || style.indentLeft !== undefined) {
      const attrs: Record<string, string> = {};
      const remove: string[] = [];
      if (style.firstLineChars !== undefined) {
        attrs[`@_${prefix}firstLineChars`] = String(Math.round(style.firstLineChars * 100));
        // Word 自己也是两个都写：firstLineChars 给支持字符单位的阅读器，
        // firstLine 给只认 twips 的阅读器，两者不能互相矛盾。
        attrs[`@_${prefix}firstLine`] = String(Math.round(style.firstLineChars * paragraphFontSize(paragraph, prefix) * 20));
        remove.push("hanging", "hangingChars");
      }
      if (style.indentLeft !== undefined) attrs[`@_${prefix}left`] = String(Math.round(style.indentLeft * 20));
      setParagraphAttribute(pPr, prefix, "ind", attrs, remove);
    }
  }

  zip.file(MAIN, builder.build(nodes));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

const copyNode = (node: XmlNode): XmlNode => JSON.parse(JSON.stringify(node));
const attrOf = (node: XmlNode, prefix: string, name: string) =>
  (node[":@"] as Record<string, string> | undefined)?.[`@_${prefix}${name}`];

/** 节点下所有 `w:t` 的文字，按出现顺序拼接。 */
function allText(node: XmlNode, prefix: string) {
  const parts: string[] = [];
  function walk(current: XmlNode) {
    if (tag(current) === `${prefix}t`) parts.push(children(current).map(child => String(child["#text"] ?? "")).join(""));
    else children(current).forEach(walk);
  }
  walk(node);
  return parts.join("");
}

function tableRows(table: XmlNode, prefix: string) {
  return children(table).filter(node => tag(node) === `${prefix}tr`);
}
function rowCells(row: XmlNode, prefix: string) {
  return children(row).filter(node => tag(node) === `${prefix}tc`);
}
/** 单元格按行拼接，行间用换行、格间用竖线 —— 避免匹配串跨格拼出假命中。 */
function tableText(table: XmlNode, prefix: string) {
  return tableRows(table, prefix)
    .map(row => rowCells(row, prefix).map(cell => allText(cell, prefix)).join(" | "))
    .join("\n");
}

function hasNestedTable(table: XmlNode, prefix: string) {
  let found = false;
  function walk(node: XmlNode) {
    for (const child of children(node)) {
      if (found) return;
      if (tag(child) === `${prefix}tbl`) { found = true; return; }
      walk(child);
    }
  }
  walk(table);
  return found;
}

/** 结构类操作的前提：没有嵌套表、没有合并单元格、没有行级跨列跳过。 */
function tableStructureIssue(table: XmlNode, prefix: string): string | undefined {
  if (hasNestedTable(table, prefix)) return "表格里嵌套了另一张表";
  for (const row of tableRows(table, prefix)) {
    const trPr = children(row).find(node => tag(node) === `${prefix}trPr`);
    const skip = trPr && children(trPr).find(node => tag(node) === `${prefix}gridBefore` || tag(node) === `${prefix}gridAfter`);
    if (skip && Number(attrOf(skip, prefix, "val") ?? 0) > 0) return "表格有行级跨列跳过（gridBefore/gridAfter）";
    for (const cell of rowCells(row, prefix)) {
      const tcPr = children(cell).find(node => tag(node) === `${prefix}tcPr`);
      if (!tcPr) continue;
      const span = children(tcPr).find(node => tag(node) === `${prefix}gridSpan`);
      if (span && Number(attrOf(span, prefix, "val") ?? 1) > 1) return "表格含合并单元格（gridSpan）";
      if (children(tcPr).some(node => tag(node) === `${prefix}vMerge`)) return "表格含合并单元格（vMerge）";
    }
  }
  return undefined;
}

/** 清空单元格内容但保留 tcPr（边框、底纹、宽度）与段落属性。 */
function clearCellText(cell: XmlNode, prefix: string) {
  for (const paragraph of children(cell).filter(node => tag(node) === `${prefix}p`)) {
    const items = children(paragraph);
    for (let index = items.length - 1; index >= 0; index--) {
      if (tag(items[index]!) !== `${prefix}pPr`) items.splice(index, 1);
    }
  }
}

/**
 * 重写单元格文字。
 *
 * 保留单元格首段的 pPr 与首个 run 的 rPr，其余内联内容整体替换：单元格里的多段会被
 * 合并成「按 \n 拆开的新段落」，这是改文字的必然结果，不假装保留了原有分段格式。
 */
function writeCellText(cell: XmlNode, prefix: string, text: string) {
  const paragraphs = children(cell).filter(node => tag(node) === `${prefix}p`);
  const source = paragraphs[0];
  const pPr = source && children(source).find(node => tag(node) === `${prefix}pPr`);
  const firstRun = source && children(source).find(node => tag(node) === `${prefix}r`);
  const rPr = firstRun && children(firstRun).find(node => tag(node) === `${prefix}rPr`);

  const rebuilt = text.split("\n").map(line => {
    const paragraph: XmlNode = { [`${prefix}p`]: [] };
    const kids = children(paragraph);
    if (pPr) kids.push(copyNode(pPr));
    if (line) {
      const run: XmlNode = { [`${prefix}r`]: [] };
      if (rPr) children(run).push(copyNode(rPr));
      children(run).push({
        [`${prefix}t`]: [{ "#text": line }],
        // 首尾空格会被 XML 解析器吃掉，必须显式声明保留
        ...(/^\s|\s$/.test(line) ? { ":@": { "@_xml:space": "preserve" } } : {}),
      });
      kids.push(run);
    }
    return paragraph;
  });

  const items = children(cell);
  const positions = items.map((node, index) => tag(node) === `${prefix}p` ? index : -1).filter(index => index >= 0);
  if (!positions.length) { items.push(...rebuilt); return; }
  items.splice(positions[0]!, positions.length, ...rebuilt);
}

/**
 * 列数变化后按原总宽度重新分配。
 *
 * Word 的列宽是「网格 + 单元格 tcW」两处，只改一处不生效；总宽度保持不变，
 * 是为了不让表格撑出版心 —— 加一列就把表撑出页面比不加更糟。
 */
function resizeColumns(table: XmlNode, prefix: string, widths: number[]) {
  const grid = children(table).find(node => tag(node) === `${prefix}tblGrid`);
  if (grid) {
    children(grid).filter(node => tag(node) === `${prefix}gridCol`).forEach((column, index) => {
      if (widths[index] === undefined) return;
      column[":@"] = { ...((column[":@"] as object | undefined) ?? {}), [`@_${prefix}w`]: String(widths[index]) };
    });
  }
  tableRows(table, prefix).forEach(row => {
    rowCells(row, prefix).forEach((cell, index) => {
      const width = widths[index];
      if (width === undefined) return;
      const tcPr = children(cell).find(node => tag(node) === `${prefix}tcPr`);
      const tcW = tcPr && children(tcPr).find(node => tag(node) === `${prefix}tcW`);
      if (!tcW) return;
      // 百分比或自动宽度的单元格不参与绝对宽度分配
      if ((attrOf(tcW, prefix, "type") ?? "dxa") !== "dxa") return;
      tcW[":@"] = { ...((tcW[":@"] as object | undefined) ?? {}), [`@_${prefix}w`]: String(width) };
    });
  });
}

function gridWidths(table: XmlNode, prefix: string) {
  const grid = children(table).find(node => tag(node) === `${prefix}tblGrid`);
  const columns = grid ? children(grid).filter(node => tag(node) === `${prefix}gridCol`) : [];
  return columns.map(column => Number(attrOf(column, prefix, "w") ?? 2000) || 2000);
}

export type DocxTableEdit = {
  /** 用来定位表格的特征文字：必须唯一落在一张表里 */
  find: string;
  /** 改单元格文字，行列从 1 开始；\n 分段 */
  cells?: Array<{ row: number; col: number; text: string }>;
  insertRows?: { at: number; count: number };
  deleteRows?: { at: number; count: number };
  insertCols?: { at: number; count: number };
  deleteCols?: { at: number; count: number };
};

/**
 * 改 Word 表格：单元格文字，或增删行列。
 *
 * 每条只做一件事；改文字只影响目标单元格，增删行列会克隆相邻行/列（保留边框与底纹）
 * 并清空内容。总列宽保持不变。含合并单元格或嵌套表的表格直接拒绝 —— 复制一行
 * 在有合并的表格里得不到语义正确的结果。
 */
export async function editDocxTableStructure(bytes: Buffer, edits: DocxTableEdit[]) {
  const { zip, nodes, body, prefix } = await readBody(bytes);
  if (Object.keys(zip.files).some(name => name.startsWith("_xmlsignatures/"))) throw new Error("带数字签名的 Word 文件不能直接修改");

  const tables: XmlNode[] = [];
  function collect(node: XmlNode) {
    const name = tag(node);
    if (name === `${prefix}tbl`) tables.push(node);
    else if (name !== `${prefix}del` && name !== `${prefix}drawing`) children(node).forEach(collect);
  }
  collect(body);
  if (!tables.length) throw new Error("Word 文档里没有表格");

  for (const [index, edit] of edits.entries()) {
    const label = `第 ${index + 1} 处表格修改`;
    const operations = [edit.cells, edit.insertRows, edit.deleteRows, edit.insertCols, edit.deleteCols].filter(Boolean);
    if (operations.length !== 1) throw new Error(`${label}一次只能做一件事：改单元格，或者增删行列`);

    const matched = tables.filter(table => tableText(table, prefix).includes(edit.find));
    if (!matched.length) throw new Error(`${label}未找到包含「${edit.find}」的表格，请重新读取文件`);
    if (matched.length > 1) throw new Error(`${label}的定位文字出现在多张表格里，请换一段更独特的文字`);
    const table = matched[0]!;
    const problem = tableStructureIssue(table, prefix);
    if (problem) throw new Error(`${label}无法修改：${problem}`);

    const rows = tableRows(table, prefix);
    const cols = rowCells(rows[0]!, prefix).length;
    if (rows.some(row => rowCells(row, prefix).length !== cols)) throw new Error(`${label}无法修改：各行单元格数不一致`);

    if (edit.cells) {
      if (edit.cells.some(cell => !Number.isInteger(cell.row) || !Number.isInteger(cell.col)
        || cell.row < 1 || cell.row > rows.length || cell.col < 1 || cell.col > cols)) {
        throw new Error(`${label}单元格超出范围（${rows.length} 行 ${cols} 列）`);
      }
      if (new Set(edit.cells.map(cell => `${cell.row}-${cell.col}`)).size !== edit.cells.length) {
        throw new Error(`${label}同一个单元格不能在一次修改里改两次`);
      }
      for (const cell of edit.cells) writeCellText(rowCells(rows[cell.row - 1]!, prefix)[cell.col - 1]!, prefix, cell.text);
      continue;
    }

    const operation = (edit.insertRows ?? edit.deleteRows ?? edit.insertCols ?? edit.deleteCols)!;
    const isRow = Boolean(edit.insertRows ?? edit.deleteRows);
    const inserting = Boolean(edit.insertRows ?? edit.insertCols);
    const { at, count } = operation;
    const limit = isRow ? rows.length : cols;
    if (!Number.isInteger(at) || !Number.isInteger(count) || count < 1 || count > 10) {
      throw new Error(`${label}增删行列的 at / count 必须是整数，count 在 1–10 之间`);
    }
    if (!inserting && limit - count < 1) throw new Error(`${label}删完后至少保留一${isRow ? "行" : "列"}`);
    const maxAt = inserting ? limit + 1 : limit - count + 1;
    if (at < 1 || at > maxAt) throw new Error(`${label}${isRow ? "行" : "列"}位置超出范围：当前 ${limit} ${isRow ? "行" : "列"}，at 应在 1–${maxAt}`);
    const next = inserting ? limit + count : limit - count;
    if (isRow && (next < 1 || next > 100)) throw new Error(`${label}改完后会是 ${next} 行，超出 1–100 行的限制`);
    if (!isRow && (next < 1 || next > 20)) throw new Error(`${label}改完后会是 ${next} 列，超出 1–20 列的限制`);

    /** 克隆锚点并插到它前面（追加时插到后面），保持「at 是插入后的位置」。 */
    const spliceClones = (parent: XmlNode, siblings: XmlNode[], make: () => XmlNode) => {
      const items = children(parent);
      const anchor = siblings[Math.min(at, siblings.length) - 1]!;
      const append = at > siblings.length;
      const clones = Array.from({ length: count }, make);
      items.splice(items.indexOf(anchor) + (append ? 1 : 0), 0, ...clones);
    };

    if (isRow) {
      if (inserting) {
        spliceClones(table, rows, () => {
          const clone = copyNode(rows[Math.min(at, rows.length) - 1]!);
          rowCells(clone, prefix).forEach(cell => clearCellText(cell, prefix));
          return clone;
        });
      } else {
        children(table).splice(children(table).indexOf(rows[at - 1]!), count);
      }
    } else {
      const widths = gridWidths(table, prefix);
      const total = widths.reduce((sum, width) => sum + width, 0) || cols * 2000;
      /** 网格列必须跟着增删，只改宽度会让网格与单元格对不上。位置要和单元格一致。 */
      const spliceGrid = (mode: "insert" | "delete", templateIndex: number, amount: number) => {
        const grid = children(table).find(node => tag(node) === `${prefix}tblGrid`);
        const columns = grid ? children(grid).filter(node => tag(node) === `${prefix}gridCol`) : [];
        if (!grid || !columns.length) return;
        const items = children(grid);
        if (mode === "delete") {
          items.splice(items.indexOf(columns[templateIndex]!), amount);
          return;
        }
        const anchor = columns[templateIndex]!;
        const index = items.indexOf(anchor) + (at > columns.length ? 1 : 0);
        items.splice(index, 0, ...Array.from({ length: amount }, () => copyNode(anchor)));
      };

      if (inserting) {
        const after = cols + count;
        for (const row of rows) spliceClones(row, rowCells(row, prefix), () => {
          const clone = copyNode(rowCells(row, prefix)[Math.min(at, cols) - 1]!);
          clearCellText(clone, prefix);
          return clone;
        });
        spliceGrid("insert", Math.min(at, cols) - 1, count);
        const scaled = widths.map(width => Math.max(240, Math.round(width * (cols / after))));
        const fresh = Math.round(total / after);
        scaled.splice(at - 1, 0, ...Array.from({ length: count }, () => fresh));
        resizeColumns(table, prefix, scaled);
      } else {
        for (const row of rows) children(row).splice(children(row).indexOf(rowCells(row, prefix)[at - 1]!), count);
        spliceGrid("delete", at - 1, count);
        const remaining = widths.filter((_width, index) => index < at - 1 || index >= at - 1 + count);
        const rest = remaining.reduce((sum, width) => sum + width, 0) || total;
        resizeColumns(table, prefix, remaining.map(width => Math.max(240, Math.round(width * (total / rest)))));
      }
    }
  }

  zip.file(MAIN, builder.build(nodes));
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
