import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Document, Footer, Packer, Paragraph, TextRun } from "docx";
import JSZip from "jszip";
import { afterEach, expect, it } from "vitest";
import { AppDatabase } from "../src/server/db";
import { executeChatDocumentTool, readWorkspaceFile, saveWorkspaceDocument } from "../src/server/chat-tools/documents";
import { readDocxText, styleDocxText } from "../src/server/chat-tools/word-document";

/** W：Word 字符样式。只改命中文字的 run，其它 run 与页脚保持原样。 */

const databases: AppDatabase[] = [];
afterEach(() => {
  while (databases.length) { const db = databases.pop()!; try { db.close(); } catch { /* 已关闭 */ } }
});

async function sample() {
  return Packer.toBuffer(new Document({
    sections: [{
      children: [
        new Paragraph({ children: [new TextRun({ text: "版本 ", bold: true }), new TextRun("001 与附注")] }),
        new Paragraph("普通段落不需要改动"),
      ],
      footers: { default: new Footer({ children: [new Paragraph("原有页脚")] }) },
    }],
  }));
}

const mainXml = async (bytes: Buffer) => (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
/** 取出包含指定文字的 run 的 rPr。 */
function rprOf(xml: string, text: string): string {
  const runs = [...xml.matchAll(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g)].map(match => match[0]);
  const run = runs.find(item => [...item.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(match => match[1]).join("").includes(text));
  if (!run) throw new Error(`找不到包含「${text}」的 run`);
  return /<w:rPr>[\s\S]*?<\/w:rPr>/.exec(run)?.[0] ?? "";
}

it("W01：加粗 / 颜色 / 字号落到命中文字的 run，相邻 run 不动", async () => {
  const bytes = await styleDocxText(await sample(), [{ find: "001", bold: true, color: "B23B2E", fontSize: 14 }]);
  const xml = await mainXml(bytes);
  const target = rprOf(xml, "001 与附注");
  expect(target).toContain("<w:b/>");
  expect(target).toContain('<w:color w:val="B23B2E"/>');
  expect(target).toContain('<w:sz w:val="28"/>');
  expect(target).toContain('<w:szCs w:val="28"/>');
  // 相邻 run（原本就加粗的「版本」）不应被追加颜色或字号
  const sibling = rprOf(xml, "版本 ");
  expect(sibling).not.toContain('w:val="B23B2E"');
  expect(sibling).not.toContain("<w:sz ");
  // 文字本身没变
  expect(await readDocxText(bytes)).toContain("版本 001 与附注");
});

it("W02：斜体与下划线可设可关，rPr 按 schema 顺序排列", async () => {
  const bytes = await styleDocxText(await sample(), [
    { find: "普通段落", italic: true, underline: true },
    { find: "版本 ", bold: false },
  ]);
  const xml = await mainXml(bytes);
  const italic = rprOf(xml, "普通段落不需要改动");
  expect(italic).toContain("<w:i/>");
  expect(italic).toContain('<w:u w:val="single"/>');
  // 关闭加粗：保留 b 但置 0，不删除节点
  expect(rprOf(xml, "版本 ")).toContain('<w:b w:val="0"/>');

  const ordered = await styleDocxText(await sample(), [{ find: "001", bold: true, color: "286D9C", fontSize: 16 }]);
  const props = rprOf(await mainXml(ordered), "001 与附注");
  const order = ["<w:b/>", "<w:color", "<w:sz ", "<w:szCs"].map(tag => props.indexOf(tag));
  expect(order.every(index => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
});

it("W03：匹配多次或找不到时拒绝，不猜位置", async () => {
  const duplicated = await Packer.toBuffer(new Document({
    sections: [{ children: [new Paragraph("重复内容 甲"), new Paragraph("重复内容 乙")] }],
  }));
  await expect(styleDocxText(duplicated, [{ find: "重复内容", bold: true }])).rejects.toThrow(/匹配多次/);
  await expect(styleDocxText(await sample(), [{ find: "不存在的文字", bold: true }])).rejects.toThrow(/未找到原文/);
});

it("W04：只改 document.xml，页脚等其它部件逐字节不变", async () => {
  const original = await sample();
  const bytes = await styleDocxText(original, [{ find: "001", color: "B23B2E" }]);
  const before = await JSZip.loadAsync(original), after = await JSZip.loadAsync(bytes);
  for (const name of Object.keys(before.files)) {
    if (name === "word/document.xml" || before.files[name]!.dir) continue;
    const a = await before.file(name)!.async("nodebuffer");
    const b = await after.file(name)!.async("nodebuffer");
    expect(createHash("sha256").update(b).digest("hex"), name).toBe(createHash("sha256").update(a).digest("hex"));
  }
});

it("W05：doc_edit 支持 styles；与 edits 同提交会被拒绝", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "word-style-"));
  const db = new AppDatabase(dir);
  databases.push(db);
  const conversationId = db.createConversation({
    title: "Word 样式", brainChannelId: "mock-channel", brainModel: "mock",
    videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false,
  }).id;
  const bytes = await sample();
  const saved = saveWorkspaceDocument(db, conversationId, "样式源文件", "docx", bytes, "op-source");
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const mixed = await executeChatDocumentTool(db, conversationId, "doc_edit", JSON.stringify({
    fileId: saved.id, expectedSha256: sha256,
    edits: [{ find: "001", replace: "002" }],
    styles: [{ find: "001", bold: true }],
  }), undefined, "op-mixed");
  expect(mixed.ok).toBe(false);
  expect(mixed.summary).toContain("分两次提交");

  const result = await executeChatDocumentTool(db, conversationId, "doc_edit", JSON.stringify({
    fileId: saved.id, expectedSha256: sha256,
    styles: [{ find: "001", bold: true, color: "B23B2E" }],
  }), undefined, "op-style");
  expect(result.ok).toBe(true);
  expect(result.summary).toContain("字符样式修改");
  const updated = readWorkspaceFile(db, conversationId, String(result.data!.fileId)).bytes;
  expect(rprOf(await mainXml(updated), "001 与附注")).toContain('<w:color w:val="B23B2E"/>');
  // 原文仍可读
  expect(await readDocxText(updated)).toContain("版本 001 与附注");
});
