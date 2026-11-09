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
