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
