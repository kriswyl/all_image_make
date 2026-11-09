import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { AlignmentType, Document, Footer, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";
import { afterEach, expect, it } from "vitest";
import { AppDatabase } from "../src/server/db";
import { executeChatDocumentTool, readWorkspaceFile, saveWorkspaceDocument } from "../src/server/chat-tools/documents";
import { readDocxText, styleDocxParagraphs, styleDocxText } from "../src/server/chat-tools/word-document";

/** P：Word 段落样式。只改命中段落的 pPr，文字与其它段落保持原样。 */

const databases: AppDatabase[] = [];
afterEach(() => {
  while (databases.length) { const db = databases.pop()!; try { db.close(); } catch { /* 已关闭 */ } }
});

async function sample() {
  return Packer.toBuffer(new Document({
    sections: [{
      children: [
        // 第一段故意带一个已有属性：验证注入时不把它抹掉
        new Paragraph({ alignment: AlignmentType.LEFT, children: [new TextRun("第一段正文")] }),
        new Paragraph({ children: [new TextRun({ text: "第二段正文", size: 24 })] }),
        new Paragraph("第三段正文"),
      ],
      footers: { default: new Footer({ children: [new Paragraph("原有页脚")] }) },
    }],
  }));
}

const mainXml = async (bytes: Buffer) => (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
/** 取出包含指定文字的段落，只到 </w:p> 为止（非贪婪在嵌套段落上会切错，这里按出现位置切）。 */
function paragraphOf(xml: string, text: string): string {
  const at = xml.indexOf(text);
  if (at < 0) throw new Error(`找不到包含「${text}」的段落`);
  const start = xml.lastIndexOf("<w:p>", at) >= 0 ? xml.lastIndexOf("<w:p>", at) : xml.lastIndexOf("<w:p ", at);
  const end = xml.indexOf("</w:p>", at);
  return xml.slice(start, end);
}
const attr = (fragment: string, name: string) => new RegExp(`<w:${name}\\b[^>]*>`).exec(fragment)?.[0] ?? "";

it("P01：居中对齐写入 jc，且 pPr 是段落的第一个子节点", async () => {
  const bytes = await styleDocxParagraphs(await sample(), [{ find: "第二段正文", align: "center" }]);
  const xml = await mainXml(bytes);
  const paragraph = paragraphOf(xml, "第二段正文");
  expect(attr(paragraph, "jc")).toContain('w:val="center"');
  // pPr 必须在最前面，否则 Word 会忽略整段属性
  expect(/^<w:p><w:pPr>/.test(paragraph)).toBe(true);
  // 文字与字体没被顺手改掉
  expect(paragraph).toContain(">第二段正文</w:t>");
  expect(paragraph).toContain('w:val="24"');
  // 其它段落不该出现 jc
  expect(paragraphOf(xml, "第三段正文")).not.toContain("<w:jc");
});

it("P02：行距换算成 240 分之一行，段前后换算成 twips，且合并进同一个 spacing", async () => {
  const bytes = await styleDocxParagraphs(await sample(), [
    { find: "第二段正文", lineSpacing: 1.5, spaceBefore: 6, spaceAfter: 12 },
  ]);
  const spacing = attr(paragraphOf(await mainXml(bytes), "第二段正文"), "spacing");
  expect(spacing).toContain('w:line="360"');
  expect(spacing).toContain('w:lineRule="auto"');
  expect(spacing).toContain('w:before="120"');
  expect(spacing).toContain('w:after="240"');
});

it("P03：首行缩进按字号换算，并清掉互斥的悬挂缩进；左缩进写 left", async () => {
  const bytes = await styleDocxParagraphs(await sample(), [
    // 第二段字号 12pt（sz=24），两字符 = 2 × 12 × 20 = 480 twips
    { find: "第二段正文", firstLineChars: 2, indentLeft: 18 },
  ]);
  const ind = attr(paragraphOf(await mainXml(bytes), "第二段正文"), "ind");
  expect(ind).toContain('w:firstLineChars="200"');
  expect(ind).toContain('w:firstLine="480"');
  expect(ind).toContain('w:left="360"');
  // 第三段没有字号信息，按五号 10.5pt 兜底：2 × 10.5 × 20 = 420
  const fallback = await styleDocxParagraphs(await sample(), [{ find: "第三段正文", firstLineChars: 2 }]);
  expect(attr(paragraphOf(await mainXml(fallback), "第三段正文"), "ind")).toContain('w:firstLine="420"');
});

it("P04：已有段落属性不被抹掉，pPr 子节点按 schema 顺序排列", async () => {
  const bytes = await styleDocxParagraphs(await sample(), [
    { find: "第一段正文", align: "right", lineSpacing: 2, firstLineChars: 1 },
  ]);
  const paragraph = paragraphOf(await mainXml(bytes), "第一段正文");
  const pPr = /<w:pPr>[\s\S]*?<\/w:pPr>/.exec(paragraph)![0];
  // 原有 jc 被合并成 right，而不是出现两个 jc
  expect((pPr.match(/<w:jc\b/g) ?? [])).toHaveLength(1);
  expect(attr(pPr, "jc")).toContain('w:val="right"');
  // 顺序：spacing → ind → jc
  const order = ["<w:spacing", "<w:ind", "<w:jc"].map(tag => pPr.indexOf(tag));
  expect(order.every(index => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
});

it("P05：匹配多次、找不到、没给属性、越界取值都拒绝", async () => {
  const duplicated = await Packer.toBuffer(new Document({
    sections: [{ children: [new Paragraph("重复段落 甲"), new Paragraph("重复段落 乙")] }],
  }));
  await expect(styleDocxParagraphs(duplicated, [{ find: "重复段落", align: "center" }])).rejects.toThrow(/匹配多次/);
  await expect(styleDocxParagraphs(await sample(), [{ find: "不存在", align: "center" }])).rejects.toThrow(/未找到原文/);
  await expect(styleDocxParagraphs(await sample(), [{ find: "第一段正文" }])).rejects.toThrow(/没有给出任何段落属性/);
  await expect(styleDocxParagraphs(await sample(), [{ find: "第一段正文", lineSpacing: 9 }])).rejects.toThrow(/行距倍数/);
  await expect(styleDocxParagraphs(await sample(), [{ find: "第一段正文", firstLineChars: 30 }])).rejects.toThrow(/缩进字符数/);
});

it("P06：只改 document.xml，页脚等其它部件逐字节不变", async () => {
  const original = await sample();
  const bytes = await styleDocxParagraphs(original, [{ find: "第二段正文", align: "center" }]);
  const before = await JSZip.loadAsync(original), after = await JSZip.loadAsync(bytes);
  for (const name of Object.keys(before.files)) {
    if (name === "word/document.xml" || before.files[name]!.dir) continue;
    const a = await before.file(name)!.async("nodebuffer");
    const b = await after.file(name)!.async("nodebuffer");
    expect(createHash("sha256").update(b).digest("hex"), name).toBe(createHash("sha256").update(a).digest("hex"));
  }
});

it("P07：doc_edit 支持 paragraphs；可与 styles 同提交，但不能与 edits 混用", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "word-paragraph-"));
  const db = new AppDatabase(dir);
  databases.push(db);
  const conversationId = db.createConversation({
    title: "Word 段落", brainChannelId: "mock-channel", brainModel: "mock",
    videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false,
  }).id;
  const bytes = await sample();
  const saved = saveWorkspaceDocument(db, conversationId, "段落源文件", "docx", bytes, "op-source");
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const mixed = await executeChatDocumentTool(db, conversationId, "doc_edit", JSON.stringify({
    fileId: saved.id, expectedSha256: sha256,
    edits: [{ find: "第三段正文", replace: "改过的正文" }],
    paragraphs: [{ find: "第三段正文", align: "center" }],
  }), undefined, "op-para-mixed");
  expect(mixed.ok).toBe(false);
  expect(mixed.summary).toContain("分两次提交");

  const result = await executeChatDocumentTool(db, conversationId, "doc_edit", JSON.stringify({
    fileId: saved.id, expectedSha256: sha256,
    styles: [{ find: "第二段正文", bold: true }],
    paragraphs: [{ find: "第二段正文", align: "center", lineSpacing: 1.5 }],
  }), undefined, "op-para");
  expect(result.ok).toBe(true);
  expect(result.summary).toContain("段落样式");
  expect(result.summary).toContain("字符样式");

  const updated = readWorkspaceFile(db, conversationId, String(result.data!.fileId)).bytes;
  const xml = await mainXml(updated);
  expect(attr(paragraphOf(xml, "第二段正文"), "jc")).toContain('w:val="center"');
  expect(attr(paragraphOf(xml, "第二段正文"), "spacing")).toContain('w:line="360"');
  // 字符样式也一起生效了
  expect(paragraphOf(xml, "第二段正文")).toContain("<w:b/>");
  // 文字仍可读，且没被样式修改带跑
  expect(await readDocxText(updated)).toContain("第一段正文");
});

it("P08：先改字符样式再改段落样式，两步都不丢", async () => {
  const once = await styleDocxText(await sample(), [{ find: "第二段正文", color: "B23B2E" }]);
  const twice = await styleDocxParagraphs(once, [{ find: "第二段正文", align: "justify", spaceAfter: 10 }]);
  const paragraph = paragraphOf(await mainXml(twice), "第二段正文");
  expect(paragraph).toContain('<w:color w:val="B23B2E"/>');
  // justify 在 OOXML 里是 both
  expect(attr(paragraph, "jc")).toContain('w:val="both"');
  expect(attr(paragraph, "spacing")).toContain('w:after="200"');
});
