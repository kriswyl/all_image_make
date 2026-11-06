/**
 * Markdown ⇄ 其它格式的转换。
 *
 * 模型最擅长写 Markdown，用户要的是能打开的 Word / 能讲的 PPT。
 * 这里只做"够用"的转换：标题、段落、列表、引用、代码块、表格、常见行内样式。
 * 复杂排版（分栏、页眉页脚、图表）不在范围内——需要的话应该给模板，而不是硬解析。
 */
export { readDocxText } from "./word-document.js";
import {
  AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} from "docx";
import type { DocumentNode, MindDocument } from "../mind-document.js";

const HEADING_LEVELS = [
  HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
] as const;

/** 行内样式：**粗**、*斜*、`代码`、~~删除~~ */
function inlineRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`|\*[^*]+\*|_[^_]+_)/g;
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) runs.push(new TextRun(text.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith("**") || token.startsWith("__")) runs.push(new TextRun({ text: token.slice(2, -2), bold: true }));
    else if (token.startsWith("~~")) runs.push(new TextRun({ text: token.slice(2, -2), strike: true }));
    else if (token.startsWith("`")) runs.push(new TextRun({ text: token.slice(1, -1), font: "Consolas" }));
    else runs.push(new TextRun({ text: token.slice(1, -1), italics: true }));
    last = match.index + token.length;
  }
  if (last < text.length) runs.push(new TextRun(text.slice(last)));
  return runs.length ? runs : [new TextRun("")];
}

function tableRows(lines: string[]): string[][] {
  return lines
    .filter((line) => !/^\|?\s*:?-{2,}/.test(line))
    .map((line) => line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim()));
}

/** Markdown → Word。返回 docx 字节 */
export async function markdownToDocx(markdown: string, title = "文档"): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;

  const hasHeading = lines.some((line) => /^#\s+/.test(line));
  if (!hasHeading && title.trim()) {
    children.push(new Paragraph({ text: title.trim(), heading: HeadingLevel.HEADING_1 }));
  }

  while (index < lines.length) {
    const line = lines[index]!;

    if (/^\s*```/.test(line)) {
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index]!)) {
        children.push(new Paragraph({ children: [new TextRun({ text: lines[index]!, font: "Consolas", size: 18 })], spacing: { after: 0 } }));
        index += 1;
      }
      index += 1;
      continue;
    }

    if (/^\s*\|/.test(line) && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[index + 1]!)) {
      const block: string[] = [];
      while (index < lines.length && /^\s*\|/.test(lines[index]!)) { block.push(lines[index]!); index += 1; }
      const rows = tableRows(block);
      if (rows.length) {
        children.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: rows.map((cells, rowIndex) => new TableRow({
            children: cells.map((cell) => new TableCell({
              children: [new Paragraph({ children: [new TextRun({ text: cell, bold: rowIndex === 0 })] })],
            })),
          })),
        }));
        children.push(new Paragraph({ text: "" }));
      }
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      children.push(new Paragraph({ children: inlineRuns(heading[2]!), heading: HEADING_LEVELS[heading[1]!.length - 1]! }));
      index += 1;
      continue;
    }

    if (/^\s*([-*+])\s+/.test(line)) {
      const level = Math.min(4, Math.floor((line.match(/^\s*/)?.[0].length ?? 0) / 2));
      children.push(new Paragraph({ children: inlineRuns(line.replace(/^\s*[-*+]\s+/, "")), bullet: { level } }));
      index += 1;
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const level = Math.min(4, Math.floor((line.match(/^\s*/)?.[0].length ?? 0) / 2));
      const text = line.replace(/^\s*(\d+)[.)]\s+/, (_all, number: string) => `${number}. `);
      children.push(new Paragraph({ children: inlineRuns(text), indent: { left: 360 * (level + 1) } }));
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      children.push(new Paragraph({
        children: inlineRuns(line.replace(/^\s*>\s?/, "")),
        indent: { left: 360 },
        border: { left: { style: "single", size: 12, color: "CCCCCC", space: 8 } },
      }));
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      children.push(new Paragraph({ text: "", border: { bottom: { style: "single", size: 6, color: "CCCCCC", space: 1 } } }));
      index += 1;
      continue;
    }

    if (!line.trim()) {
      children.push(new Paragraph({ text: "" }));
      index += 1;
      continue;
    }

    children.push(new Paragraph({ children: inlineRuns(line), alignment: AlignmentType.LEFT }));
    index += 1;
  }

  const doc = new Document({
    creator: "ChatCanvas",
    title,
    styles: { default: { document: { run: { font: "Microsoft YaHei", size: 22 } } } },
    sections: [{ children }],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

/**
 * 把 Markdown 大纲变成导图结构，用来走现有的"导图 → PPT"流水线。
 *
 * 规则：一级标题当根，二级当章节，三级及以下往下挂；列表项挂到最近的标题下。
 * 没有任何标题时按空行分段，每段当一节。
 */
export function markdownToMind(markdown: string, title: string): MindDocument {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const root: DocumentNode = { title: title.trim() || "演示文稿", notes: "", children: [] };
  let section: DocumentNode = root;
  let subsection: DocumentNode | null = null;
  const preamble: string[] = [];

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      if (level === 1) { root.title = text || root.title; section = root; subsection = null; continue; }
      if (level === 2) { section = { title: text, notes: "", children: [] }; root.children.push(section); subsection = null; continue; }
      const node = { title: text, notes: "", children: [] };
      (subsection ?? section).children.push(node);
      subsection = node;
      continue;
    }
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet && bullet[1]!.trim()) {
      (subsection ?? section).children.push({ title: bullet[1]!.trim(), notes: "", children: [] });
      continue;
    }
    const plain = line.trim();
    if (!plain) continue;
    if (section === root) preamble.push(plain);
    else (subsection ?? section).children.push({ title: plain, notes: "", children: [] });
  }

  if (root.children.length) root.notes = preamble.join("\n");
  else {
    const paragraphs = markdown.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
    for (const paragraph of paragraphs) {
      root.children.push({ title: paragraph.split("\n")[0]!.slice(0, 60), notes: paragraph, children: [] });
    }
  }
  if (!root.children.length) root.children.push({ title: "内容", notes: markdown.slice(0, 2000), children: [] });
  return { format: "xmind", sheets: [root], warnings: ["由 Markdown 大纲生成，原排版不保留。"] };
}
