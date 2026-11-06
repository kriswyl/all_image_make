import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Document, Footer, Packer, Paragraph, TextRun } from "docx";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import request from "supertest";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { executeChatDocumentTool, readWorkspaceFile } from "../src/server/chat-tools/documents.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-office-"));
  const { app, context } = createApp({ dataDir });
  cleanups.push(async () => {
    context.agent.dispose();
    context.db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const chat = () => context.db.createConversation({ title: "文档", brainChannelId: "fixture", brainModel: "fixture",
    videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false, toolScope: "all" });
  const conversation = chat();
  const run = (tool: string, args: unknown) => executeChatDocumentTool(context.db, conversation.id, tool, JSON.stringify(args));
  const upload = async (name: string, bytes: Buffer) => {
    const response = await request(app).post(`/api/conversations/${conversation.id}/documents/upload`).attach("file", bytes, name);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body.data.messages.at(-1).documents[0].id as string;
  };
  return { app, db: context.db, id: conversation.id, chat, run, upload };
}

it("uploads a Word file, edits across formatted runs, and preserves the original and footer", async () => {
  const { app, db, id, chat, run, upload } = await fixture();
  const original = await Packer.toBuffer(new Document({ sections: [{
    children: [new Paragraph({ children: [new TextRun({ text: "版本 ", bold: true }), new TextRun("001 & 附注")] })],
    footers: { default: new Footer({ children: [new Paragraph("原有页脚")] }) },
  }] }));
  const sourceId = await upload("原方案.docx", original);
  const listed = await run("doc_list", {});
  expect(JSON.parse(listed.summary).uploads).toContainEqual({ id: sourceId, name: "原方案.docx", source: "上传" });
  const read = JSON.parse((await run("doc_read", { fileId: sourceId })).summary);
  expect(read.lines).toEqual(["版本 001 & 附注"]);
  expect((await executeChatDocumentTool(db, chat().id, "doc_read", JSON.stringify({ fileId: sourceId }))).ok).toBe(false);
  const changed = await run("doc_edit", { fileId: sourceId, expectedSha256: read.sha256, edits: [{ find: "版本 001", replace: "版本 002" }] });
  expect(changed.ok, changed.summary).toBe(true);
  const fileId = changed.data!.fileId;
  const result = readWorkspaceFile(db, id, fileId).bytes;
  const [before, after] = await Promise.all([JSZip.loadAsync(original), JSZip.loadAsync(result)]);
  expect(await after.file("word/footer1.xml")!.async("string")).toBe(await before.file("word/footer1.xml")!.async("string"));
  expect(await after.file("word/document.xml")!.async("string")).toContain("<w:b/>");
  expect(JSON.parse((await run("doc_read", { fileId })).summary).lines).toEqual(["版本 002 & 附注"]);
  expect(db.getConversationDocumentFile(sourceId)).toEqual(original);
  await request(app).get(`/api/conversations/${id}/documents/files/${fileId}`).expect(200);
});

it("reads Excel by sheet and range, edits cells without losing ordinary formulas or styles, and exports a new workbook", async () => {
  const { db, id, run, upload } = await fixture();
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("销量");
  sheet.addRows([["项目", "销量", "合计"], ["甲", 12, { formula: "B2*2", result: 24 }]]);
  sheet.getCell("B2").numFmt = "0.00";
  book.addWorksheet("备注").getCell("A1").value = "保留";
  const fileId = await upload("销量.xlsx", Buffer.from(await book.xlsx.writeBuffer()));
  const info = JSON.parse((await run("doc_read", { fileId })).summary);
  expect(info.sheets.map((entry: { name: string }) => entry.name)).toEqual(["销量", "备注"]);
  const range = JSON.parse((await run("doc_read", { fileId, sheetName: "销量", range: "B2:C2" })).summary);
  expect(range.cells).toEqual([{ address: "B2", value: 12 }, { address: "C2", formula: "B2*2", cachedValue: 24 }]);
  expect((await run("doc_read", { fileId, sheetName: "销量", range: "A1:XFD1048576" })).ok).toBe(false);
  expect((await run("doc_edit", { fileId, expectedSha256: "0".repeat(64), cells: [{ sheet: "销量", address: "B2", value: 16 }] })).ok).toBe(false);

  const edited = await run("doc_edit", { fileId, expectedSha256: info.sha256, cells: [{ sheet: "销量", address: "B2", value: 16 }] });
  expect(edited.ok, edited.summary).toBe(true);
  const revision = new ExcelJS.Workbook();
  const editedBytes = readWorkspaceFile(db, id, edited.data!.fileId).bytes;
  await revision.xlsx.load(editedBytes as unknown as Parameters<typeof revision.xlsx.load>[0]);
  expect(revision.getWorksheet("销量")!.getCell("B2")).toMatchObject({ value: 16, numFmt: "0.00" });
  expect(revision.getWorksheet("销量")!.getCell("C2").formula).toBe("B2*2");
  expect(revision.getWorksheet("备注")!.getCell("A1").value).toBe("保留");
  const xml = await (await JSZip.loadAsync(editedBytes)).file("xl/workbook.xml")!.async("string");
  expect(xml).toContain('fullCalcOnLoad="1"');

  const created = await run("doc_create", { kind: "xlsx", name: "预算", sheets: [{ name: "明细", rows: [["预算", 30], ["合计", { formula: "SUM(B1)" }]] }] });
  expect(created.ok, created.summary).toBe(true);
  const generated = JSON.parse((await run("doc_read", { fileId: created.data!.fileId, sheetName: "明细", range: "B2" })).summary);
  expect(generated.cells).toEqual([{ address: "B2", formula: "SUM(B1)", cachedValue: null }]);
});

it("matches an uploaded ID list across 6020 rows, keeps duplicates and leading zeros, and writes only requested marks", async () => {
  const { db, id, run, upload } = await fixture();
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("订单");
  sheet.addRow(["用户ID", "项目", "合计"]);
  for (let row = 2; row <= 6020; row++) sheet.addRow([`other-${row}`, "订单", row]);
  const originalFont = { name: "Arial", bold: true, color: { argb: "FF204060" } };
  for (const [row, value] of [[2, 11715], [3, "00123"], [4, 123], [6020, "11715"]] as const) {
    const cell = sheet.getCell(`A${row}`);
    cell.value = value;
    cell.font = originalFont;
  }
  sheet.getCell("C2").value = { formula: "ROW()", result: 2 };
  const sourceBytes = Buffer.from(await book.xlsx.writeBuffer());
  const orders = await upload("订单.xlsx", sourceBytes);
  const list = new ExcelJS.Workbook();
  list.addWorksheet("名单").addRows([["ID"], ["11715"], ["00123"], ["缺失"], ["11715"]]);
  const listId = await upload("清单.xlsx", Buffer.from(await list.xlsx.writeBuffer()));
  const read = JSON.parse((await run("doc_read", { fileId: orders })).summary);
  const result = await run("doc_edit", { fileId: orders, expectedSha256: read.sha256, matchRows: {
    sheet: "订单", column: "A", list: { fileId: listId, sheet: "名单", column: "A" }, fontColor: "FF0000", marker: {},
  } });
  expect(result.ok, result.summary).toBe(true);
  expect(result.summary).toContain("已扫描 6019 行，3 个不同 ID 中命中 2 个，共 3 行；未找到 1 个");
  expect(result.summary).toContain('"缺失"');
  const revised = new ExcelJS.Workbook();
  const output = readWorkspaceFile(db, id, result.data!.fileId).bytes;
  await revised.xlsx.load(output as unknown as Parameters<typeof revised.xlsx.load>[0]);
  const changed = revised.getWorksheet("订单")!;
  expect(changed.getCell("D1").value).toBe("标记");
  for (const row of [2, 3, 6020]) {
    expect(changed.getCell(`A${row}`).font).toMatchObject({ name: "Arial", bold: true, color: { argb: "FFFF0000" } });
    expect(changed.getCell(`D${row}`).value).toBe(1);
  }
  expect(changed.getCell("A3").value).toBe("00123");
  expect(changed.getCell("A4").font).toMatchObject(originalFont);
  expect(changed.getCell("D4").value).toBeNull();
  expect(changed.getCell("B2").font?.color?.argb).not.toBe("FFFF0000");
  expect(changed.getCell("C2").formula).toBe("ROW()");
  expect(db.getConversationDocumentFile(orders)).toEqual(sourceBytes);

  const noMatch = await run("doc_edit", { fileId: orders, expectedSha256: read.sha256, matchRows: { sheet: "订单", column: "A", ids: ["无此ID"], fontColor: "#FF0000" } });
  expect(noMatch).toMatchObject({ ok: true, summary: expect.stringContaining("没有匹配行") });
  expect(noMatch.data).toBeUndefined();
  const collision = await run("doc_edit", { fileId: orders, expectedSha256: read.sha256, matchRows: { sheet: "订单", column: "A", ids: ["11715"], marker: { column: "B" } } });
  expect(collision).toMatchObject({ ok: false, summary: expect.stringContaining("已被占用") });
});

function samplePdf() {
  const stream = "BT /F1 12 Tf 72 720 Td (Office fixture text) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
  ];
  let data = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = data.length;
    data += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  return Buffer.from(`${data}xref\n0 7\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${data.length}\n%%EOF\n`);
}

it("uploads and reads PDF text page by page, explaining when a page needs OCR", async () => {
  const { app, id, run, upload } = await fixture();
  const fileId = await upload("资料.pdf", samplePdf());
  const first = JSON.parse((await run("doc_read", { fileId, page: 1 })).summary);
  expect(first).toMatchObject({ lines: ["Office fixture text"], page: 1, totalPages: 2, nextPage: 2 });
  const second = JSON.parse((await run("doc_read", { fileId, page: 2 })).summary);
  expect(second).toMatchObject({ nextPage: null, warning: expect.stringContaining("OCR") });
  expect((await run("doc_read", { fileId, page: 3 })).ok).toBe(false);
  await request(app).post(`/api/conversations/${id}/documents/upload`).attach("file", Buffer.from("not a workbook"), "bad.xlsx").expect(400);
});

it("loads Excel batch matching for an attachment and returns a downloadable revision in unified chat", async () => {
  const { app, db, id, upload } = await fixture();
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("销量");
  sheet.addRows([["用户ID", "销量"], ["12", 5], ["12", 8]]);
  const fileId = await upload("工作簿.xlsx", Buffer.from(await book.xlsx.writeBuffer()));
  const turnPath = `/api/conversations/${id}`;
  let initial: { tools: Array<{ function: { name: string } }>; messages: unknown[] } | undefined;
  let calls = 0;
  const mock = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls++;
      let message: { content: string; tool_calls?: object[] } = { content: "修改版已生成。" };
      if (calls === 1) {
        initial = body;
        message = { content: "", tool_calls: [{ id: "read-1", type: "function", function: { name: "doc_read", arguments: JSON.stringify({ fileId, sheetName: "销量", range: "B2" }) } }] };
      } else if (calls === 2) {
        const toolContent = body.messages.findLast((entry: { tool_call_id?: string }) => entry.tool_call_id === "read-1").content as string;
        const read = JSON.parse(toolContent.slice(toolContent.indexOf("{")));
        message = { content: "", tool_calls: [{ id: "edit-1", type: "function", function: { name: "doc_edit", arguments: JSON.stringify({
          fileId, expectedSha256: read.sha256, matchRows: { sheet: "销量", column: "A", ids: ["12"], fontColor: "FF0000", colorColumns: { from: "A", to: "B" } },
        }) } }] };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }] }));
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>(resolve => mock.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => mock.close(() => resolve())));
  const address = mock.address();
  if (!address || typeof address === "string") throw new Error("mock server unavailable");
  const channel = db.saveChannel({ name: "Mock", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat", authType: "none", authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions", models: ["fixture"], allowPrivateNetwork: true, enabled: true });
  db.updateConversation(id, { brainChannelId: channel.id });
  await request(app).post(`${turnPath}/messages`).send({ text: "按销量表 A 列找出用户 12，把匹配行 A 到 B 列字体标红" }).expect(202);
  await vi.waitFor(() => {
    expect(calls).toBe(3);
    expect(db.getConversation(id)?.status).toBe("idle");
  });
  expect(initial?.tools.map(tool => tool.function.name)).toEqual(expect.arrayContaining(["doc_read", "doc_edit"]));
  expect(JSON.stringify(initial?.messages)).toContain(fileId);
  const revised = db.listMessages(id).find(message => message.toolName === "doc_edit" && message.role === "tool");
  expect(revised?.toolResult?.ok).toBe(true);
  const outputId = String(revised?.toolResult?.data?.workspaceFileId);
  await request(app).get(`${turnPath}/documents/files/${outputId}`).expect(200);
  const downloaded = readWorkspaceFile(db, id, outputId).bytes;
  const output = new ExcelJS.Workbook();
  await output.xlsx.load(downloaded as unknown as Parameters<typeof output.xlsx.load>[0]);
  expect(output.getWorksheet("销量")!.getCell("B3").font.color?.argb).toBe("FFFF0000");
  expect(output.getWorksheet("销量")!.columnCount).toBe(2);
});
