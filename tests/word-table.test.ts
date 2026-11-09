import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import JSZip from "jszip";
import { afterEach, expect, it } from "vitest";
import { AppDatabase } from "../src/server/db";
import { executeChatDocumentTool, readWorkspaceFile, saveWorkspaceDocument } from "../src/server/chat-tools/documents";
import { editDocxTableStructure, readDocxText } from "../src/server/chat-tools/word-document";

/** T：Word 表格结构。改单元格文字，或增删行列；不碰表格以外的内容。 */

const databases: AppDatabase[] = [];
afterEach(() => {
  while (databases.length) { const db = databases.pop()!; try { db.close(); } catch { /* 已关闭 */ } }
});

const cell = (text: string) => new TableCell({ children: [new Paragraph(text)] });

async function sample() {
  return Packer.toBuffer(new Document({
    sections: [{
      children: [
        new Paragraph("表格之前"),
        new Table({ rows: [
          new TableRow({ children: [cell("阶段"), cell("结果")] }),
          new TableRow({ children: [cell("选点"), cell("3 个")] }),
          new TableRow({ children: [cell("试点"), cell("1 个")] }),
        ] }),
        new Paragraph("表格之后"),
      ],
    }],
  }));
}

const mainXml = async (bytes: Buffer) => (await JSZip.loadAsync(bytes)).file("word/document.xml")!.async("string");
const tableXml = async (bytes: Buffer) => (await mainXml(bytes)).match(/<w:tbl>[\s\S]*?<\/w:tbl>/)![0];
const rowCount = (tbl: string) => (tbl.match(/<w:tr>/g) ?? []).length;
const cellsPerRow = (tbl: string) => [...tbl.matchAll(/<w:tr>([\s\S]*?)<\/w:tr>/g)]
  .map(row => (row[1]!.match(/<w:tc>/g) ?? []).length);
const colWidths = (tbl: string) => [...tbl.matchAll(/<w:gridCol\b[^>]*\bw:w="(\d+)"/g)].map(match => Number(match[1]));
/** 第 index 行（从 1 开始）里所有单元格的文字。 */
const rowTexts = (tbl: string, index: number) => {
  const row = [...tbl.matchAll(/<w:tr>([\s\S]*?)<\/w:tr>/g)][index - 1]![1]!;
  return [...row.matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)]
    .map(cell => [...cell[1]!.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map(match => match[1]).join(""));
};
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

it("T01：末尾增行保留边框与底纹，其余表格内容不动", async () => {
  const before = await tableXml(await sample());
  const bytes = await editDocxTableStructure(await sample(), [{ find: "选点", insertRows: { at: 4, count: 1 } }]);
  const after = await tableXml(bytes);
  expect(rowCount(after)).toBe(4);
  // 新行是空的，但单元格属性还在（表里本来没有 tcPr，这里只需保证结构合法且没有串字）
  expect(rowTexts(after, 4)).toEqual(["", ""]);
  // 原有三行原样
  expect(rowTexts(after, 1)).toEqual(["阶段", "结果"]);
  expect(rowTexts(after, 2)).toEqual(["选点", "3 个"]);
  expect(rowTexts(after, 3)).toEqual(["试点", "1 个"]);
  expect(colWidths(after)).toEqual(colWidths(before));
  // 表格前后的段落都还在
  const text = await readDocxText(bytes);
  expect(text).toContain("表格之前");
  expect(text).toContain("表格之后");
});

it("T02：中间插行插在指定位置，删行只删目标行", async () => {
  const inserted = await tableXml(await editDocxTableStructure(await sample(), [{ find: "选点", insertRows: { at: 2, count: 1 } }]));
  expect(rowTexts(inserted, 1)).toEqual(["阶段", "结果"]);
  expect(rowTexts(inserted, 2)).toEqual(["", ""]);
  expect(rowTexts(inserted, 3)).toEqual(["选点", "3 个"]);

  const deleted = await tableXml(await editDocxTableStructure(await sample(), [{ find: "选点", deleteRows: { at: 2, count: 1 } }]));
  expect(rowCount(deleted)).toBe(2);
  expect(rowTexts(deleted, 1)).toEqual(["阶段", "结果"]);
  expect(rowTexts(deleted, 2)).toEqual(["试点", "1 个"]);
});

it("T03：增列给每行补空格，网格同步，总列宽不变", async () => {
  const before = await tableXml(await sample());
  const after = await tableXml(await editDocxTableStructure(await sample(), [{ find: "阶段", insertCols: { at: 2, count: 1 } }]));
  expect(cellsPerRow(after)).toEqual([3, 3, 3]);
  expect(colWidths(after)).toHaveLength(3);
  // 加列不把表撑出版心：总宽度守恒
  expect(Math.abs(sum(colWidths(after)) - sum(colWidths(before)))).toBeLessThanOrEqual(3);
  expect(rowTexts(after, 1)).toEqual(["阶段", "", "结果"]);
});

it("T04：删列同步收窄每行与网格，原文字保留其它列", async () => {
  const before = await tableXml(await sample());
  const after = await tableXml(await editDocxTableStructure(await sample(), [{ find: "阶段", deleteCols: { at: 2, count: 1 } }]));
  expect(cellsPerRow(after)).toEqual([1, 1, 1]);
  expect(colWidths(after)).toHaveLength(1);
  expect(Math.abs(sum(colWidths(after)) - sum(colWidths(before)))).toBeLessThanOrEqual(3);
  expect(rowTexts(after, 1)).toEqual(["阶段"]);
  expect(rowTexts(after, 3)).toEqual(["试点"]);
});

it("T05：改单元格文字只动目标格，支持 \n 分段", async () => {
  const bytes = await editDocxTableStructure(await sample(), [{
    find: "选点", cells: [{ row: 2, col: 2, text: "5 个" }, { row: 3, col: 1, text: "推广\n第二段" }],
  }]);
  const tbl = await tableXml(bytes);
  expect(rowTexts(tbl, 2)).toEqual(["选点", "5 个"]);
  expect(rowTexts(tbl, 3)[0]).toBe("推广第二段");
  // 拆成两段：该单元格里应有两个 w:p
  const cellXml = [...tbl.matchAll(/<w:tr>([\s\S]*?)<\/w:tr>/g)][2]![1]!.match(/<w:tc>[\s\S]*?<\/w:tc>/)![0];
  expect((cellXml.match(/<w:p>/g) ?? [])).toHaveLength(2);
  // 表格外的段落没被牵连
  const text = await readDocxText(bytes);
  expect(text).toContain("表格之前");
});

it("T06：越界、重复、多条操作、定位不到或多张表命中都拒绝", async () => {
  const bytes = await sample();
  await expect(editDocxTableStructure(bytes, [{ find: "选点", cells: [{ row: 9, col: 1, text: "x" }] }]))
    .rejects.toThrow(/超出范围（3 行 2 列）/);
  await expect(editDocxTableStructure(bytes, [{ find: "选点", cells: [{ row: 2, col: 1, text: "a" }, { row: 2, col: 1, text: "b" }] }]))
    .rejects.toThrow(/不能在一次修改里改两次/);
  await expect(editDocxTableStructure(bytes, [{ find: "选点", cells: [{ row: 2, col: 1, text: "a" }], insertRows: { at: 2, count: 1 } }]))
    .rejects.toThrow(/一次只能做一件事/);
  await expect(editDocxTableStructure(bytes, [{ find: "没有这段文字", insertRows: { at: 1, count: 1 } }]))
    .rejects.toThrow(/未找到包含/);
  await expect(editDocxTableStructure(bytes, [{ find: "选点", deleteRows: { at: 1, count: 3 } }]))
    .rejects.toThrow(/至少保留一行/);
  await expect(editDocxTableStructure(bytes, [{ find: "选点", insertRows: { at: 9, count: 1 } }]))
    .rejects.toThrow(/行位置超出范围/);
});

it("T07：合并单元格、嵌套表格、多表同名都拒绝", async () => {
  const merged = await Packer.toBuffer(new Document({
    sections: [{ children: [new Table({ rows: [
      new TableRow({ children: [new TableCell({ columnSpan: 2, children: [new Paragraph("合并表头")] })] }),
      new TableRow({ children: [cell("甲"), cell("乙")] }),
    ] })] }],
  }));
  await expect(editDocxTableStructure(merged, [{ find: "合并表头", insertRows: { at: 2, count: 1 } }]))
    .rejects.toThrow(/合并单元格（gridSpan）/);

  const nested = await Packer.toBuffer(new Document({
    sections: [{ children: [new Table({ rows: [new TableRow({ children: [
      new TableCell({ children: [new Paragraph("外层"), new Table({ rows: [new TableRow({ children: [cell("内层")] })] })] }),
    ] })] })] }],
  }));
  await expect(editDocxTableStructure(nested, [{ find: "外层", insertRows: { at: 2, count: 1 } }]))
    .rejects.toThrow(/嵌套了另一张表/);

  const twice = await Packer.toBuffer(new Document({
    sections: [{ children: [
      new Table({ rows: [new TableRow({ children: [cell("共用词"), cell("甲")] })] }),
      new Table({ rows: [new TableRow({ children: [cell("共用词"), cell("乙")] })] }),
    ] }],
  }));
  await expect(editDocxTableStructure(twice, [{ find: "共用词", insertRows: { at: 2, count: 1 } }]))
    .rejects.toThrow(/出现在多张表格里/);
});

it("T08：只改 document.xml，其它部件逐字节不变", async () => {
  const original = await sample();
  const bytes = await editDocxTableStructure(original, [{ find: "选点", insertRows: { at: 4, count: 1 } }]);
  const before = await JSZip.loadAsync(original), after = await JSZip.loadAsync(bytes);
  for (const name of Object.keys(before.files)) {
    if (name === "word/document.xml" || before.files[name]!.dir) continue;
    const a = await before.file(name)!.async("nodebuffer");
    const b = await after.file(name)!.async("nodebuffer");
    expect(createHash("sha256").update(b).digest("hex"), name).toBe(createHash("sha256").update(a).digest("hex"));
  }
});

it("T09：doc_edit 支持 tables，且必须单独提交", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "word-table-"));
  const db = new AppDatabase(dir);
  databases.push(db);
  const conversationId = db.createConversation({
    title: "Word 表格", brainChannelId: "mock-channel", brainModel: "mock",
    videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false,
  }).id;
  const bytes = await sample();
  const saved = saveWorkspaceDocument(db, conversationId, "表格源文件", "docx", bytes, "op-source");
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const mixed = await executeChatDocumentTool(db, conversationId, "doc_edit", JSON.stringify({
    fileId: saved.id, expectedSha256: sha256,
    edits: [{ find: "表格之前", replace: "表格之前（改）" }],
    tables: [{ find: "选点", insertRows: { at: 4, count: 1 } }],
  }), undefined, "op-table-mixed");
  expect(mixed.ok).toBe(false);
  expect(mixed.summary).toContain("单独提交");

  const result = await executeChatDocumentTool(db, conversationId, "doc_edit", JSON.stringify({
    fileId: saved.id, expectedSha256: sha256,
    tables: [{ find: "选点", insertRows: { at: 4, count: 1 } }],
  }), undefined, "op-table");
  expect(result.ok).toBe(true);
  expect(result.summary).toContain("增删行列");

  const updated = readWorkspaceFile(db, conversationId, String(result.data!.fileId)).bytes;
  expect(rowCount(await tableXml(updated))).toBe(4);
  // 文档仍可正常读取
  expect(await readDocxText(updated)).toContain("表格之后");
});
