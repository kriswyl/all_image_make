import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { afterEach, expect, it } from "vitest";
import { AppDatabase } from "../src/server/db";
import { executeChatDocumentTool, readWorkspaceFile, saveWorkspaceDocument } from "../src/server/chat-tools/documents";
import { editXlsxCells, matchAndEditXlsx } from "../src/server/chat-tools/spreadsheet-document";
import { editXlsxPreserving, matchAndEditXlsxPreserving } from "../src/server/chat-tools/xlsx-surgical";

/** X：含图表的工作簿。改单元格不能把图表冲掉，图表缓存要跟着更新。 */

const databases: AppDatabase[] = [];
afterEach(() => {
  while (databases.length) { const db = databases.pop()!; try { db.close(); } catch { /* 已关闭 */ } }
});

const CHART = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:chart><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>数据!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>数量</c:v></c:pt></c:strCache></c:strRef></c:tx><c:cat><c:strRef><c:f>数据!$A$2:$A$4</c:f><c:strCache><c:ptCount val="3"/><c:pt idx="0"><c:v>一月</c:v></c:pt><c:pt idx="1"><c:v>二月</c:v></c:pt><c:pt idx="2"><c:v>三月</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>数据!$B$2:$B$4</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="3"/><c:pt idx="0"><c:v>12</c:v></c:pt><c:pt idx="1"><c:v>18</c:v></c:pt><c:pt idx="2"><c:v>9</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`;

const DRAWING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><xdr:twoCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>9</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="图表 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;

const REL = (target: string, id: string, type: string) =>
  `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;

/** 用 ExcelJS 造数据表，再把图表相关的包部件手工插进去 —— 等价于「Excel 里插了张柱状图」。 */
async function chartedWorkbook() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("数据");
  sheet.addRow(["类别", "数量", "编号"]);
  sheet.addRow(["一月", 12, "A-001"]);
  sheet.addRow(["二月", 18, "A-002"]);
  sheet.addRow(["三月", 9, "A-003"]);
  const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer() as unknown as Buffer);

  zip.file("xl/charts/chart1.xml", CHART);
  zip.file("xl/drawings/drawing1.xml", DRAWING);
  zip.file("xl/drawings/_rels/drawing1.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${REL("../charts/chart1.xml", "rId1", "chart")}</Relationships>`);

  const sheetRels = "xl/worksheets/_rels/sheet1.xml.rels";
  const existing = zip.file(sheetRels);
  const rels = existing
    ? await existing.async("string")
    : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;
  zip.file(sheetRels, rels.replace("</Relationships>", `${REL("../drawings/drawing1.xml", "rIdDrawing", "drawing")}</Relationships>`));

  const sheetXml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  // 图表引用必须排在 pageSetup 之后；直接放在 </worksheet> 前最稳。
  zip.file("xl/worksheets/sheet1.xml", sheetXml.replace("</worksheet>", '<drawing r:id="rIdDrawing"/></worksheet>'));

  const types = await zip.file("[Content_Types].xml")!.async("string");
  zip.file("[Content_Types].xml", types.replace("</Types>",
    '<Override PartName="/xl/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>'
    + '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>'));

  return zip.generateAsync({ type: "nodebuffer" });
}

const partOf = async (bytes: Buffer, name: string) => (await JSZip.loadAsync(bytes)).file(name)?.async("string");
const cacheOf = (chart: string, tag: "numCache" | "strCache") => {
  const block = new RegExp(`<c:${tag}>([\\s\\S]*?)</c:${tag}>`).exec(chart)?.[1] ?? "";
  return [...block.matchAll(/<c:pt\b[^>]*><c:v>([^<]*)<\/c:v><\/c:pt>/g)].map(match => match[1]);
};
const numCacheOf = (chart: string) => cacheOf(chart, "numCache");
const catCacheOf = (chart: string) => {
  const block = /<c:cat>([\s\S]*?)<\/c:cat>/.exec(chart)?.[1] ?? "";
  return [...block.matchAll(/<c:v>([^<]*)<\/c:v>/g)].map(match => match[1]);
};
const seriesCacheOf = (chart: string) => {
  const block = /<c:tx>([\s\S]*?)<\/c:tx>/.exec(chart)?.[1] ?? "";
  return [...block.matchAll(/<c:v>([^<]*)<\/c:v>/g)].map(match => match[1]);
};

it("X01：含图表的工作簿现在能改单元格，且图表部件原样保留", async () => {
  const bytes = await chartedWorkbook();
  const result = await editXlsxPreserving(bytes, [
    { sheet: "数据", address: "B2", value: 40 },
    { sheet: "数据", address: "B3", value: 55 },
  ]);
  expect(result.report.cells).toEqual(["数据!B2", "数据!B3"]);
  expect(await partOf(result.bytes, "xl/worksheets/sheet1.xml")).toContain("<v>40</v>");

  // 图表与绘图部件一个字都不该变
  const before = await JSZip.loadAsync(bytes);
  const after = await JSZip.loadAsync(result.bytes);
  for (const name of ["xl/drawings/drawing1.xml", "xl/drawings/_rels/drawing1.xml.rels", "xl/styles.xml", "xl/theme/theme1.xml", "[Content_Types].xml"]) {
    const a = await before.file(name)!.async("nodebuffer");
    const b = await after.file(name)!.async("nodebuffer");
    expect(createHash("sha256").update(b).digest("hex"), name).toBe(createHash("sha256").update(a).digest("hex"));
  }
  // 图表部件本身仍在（缓存会变，所以只比结构）
  expect(await partOf(result.bytes, "xl/charts/chart1.xml")).toContain("<c:barChart>");
});

it("X02：图表缓存跟着更新（数值、分类、系列名）", async () => {
  const bytes = await chartedWorkbook();
  const result = await editXlsxPreserving(bytes, [
    { sheet: "数据", address: "B2", value: 40 },
    { sheet: "数据", address: "B3", value: 55 },
    { sheet: "数据", address: "A2", value: "首月" },
    { sheet: "数据", address: "B1", value: "产量" },
  ]);
  expect(result.report.charts).toEqual(["xl/charts/chart1.xml"]);
  const chart = (await partOf(result.bytes, "xl/charts/chart1.xml"))!;
  expect(numCacheOf(chart)).toEqual(["40", "55", "9"]);
  expect(catCacheOf(chart)).toEqual(["首月", "二月", "三月"]);
  expect(seriesCacheOf(chart)).toEqual(["产量"]);
  // 格式码与结构不动
  expect(chart).toContain("<c:formatCode>General</c:formatCode>");
  expect(result.report.warnings).toEqual([]);
});

it("X03：改完的文件仍能被 ExcelJS 正常读回", async () => {
  const bytes = await chartedWorkbook();
  const result = await editXlsxPreserving(bytes, [{ sheet: "数据", address: "B2", value: 40 }, { sheet: "数据", address: "A2", value: "首月" }]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(result.bytes as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet("数据")!;
  expect(sheet.getCell("B2").value).toBe(40);
  expect(sheet.getCell("A2").value).toBe("首月");
  expect(sheet.getCell("B1").value).toBe("数量");
});

it("X04：写公式清掉缓存值，并标记打开时重算", async () => {
  const bytes = await chartedWorkbook();
  const result = await editXlsxPreserving(bytes, [{ sheet: "数据", address: "B5", value: { formula: "SUM(B2:B4)" } }]);
  const sheet = (await partOf(result.bytes, "xl/worksheets/sheet1.xml"))!;
  const cell = /<c r="B5"[^>]*>[\s\S]*?<\/c>/.exec(sheet)![0];
  expect(cell).toContain("<f>SUM(B2:B4)</f>");
  expect(cell).not.toContain("<v>");
  expect(await partOf(result.bytes, "xl/workbook.xml")).toContain('fullCalcOnLoad="1"');
  // 公式没有结果可写，图表缓存不应被它影响
  expect(result.report.warnings.some(item => item.includes("公式"))).toBe(false);
  await expect(editXlsxPreserving(bytes, [{ sheet: "数据", address: "B6", value: { formula: "WEBSERVICE(\"http://x\")" } }]))
    .rejects.toThrow(/仅支持工作簿内部公式/);
});

it("X05：写到原有区域之外会补行、扩 dimension", async () => {
  const bytes = await chartedWorkbook();
  const result = await editXlsxPreserving(bytes, [{ sheet: "数据", address: "D7", value: "补充" }]);
  const sheet = (await partOf(result.bytes, "xl/worksheets/sheet1.xml"))!;
  expect(sheet).toContain('<dimension ref="A1:D7"/>');
  expect(sheet).toMatch(/<row r="7"><c r="D7" t="s"><v>\d+<\/v><\/c><\/row>/);
  // 行仍按升序，原有行没被挪动
  const order = [...sheet.matchAll(/<row r="(\d+)"/g)].map(match => Number(match[1]));
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(await partOf(result.bytes, "xl/sharedStrings.xml")).toContain("补充");
});

it("X06：合并区域非左上角、工作表不存在都拒绝", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("数据");
  sheet.addRow(["表头", ""]);
  sheet.addRow(["甲", 1]);
  sheet.mergeCells("A1:B1");
  const bytes = await workbook.xlsx.writeBuffer() as unknown as Buffer;
  await expect(editXlsxPreserving(Buffer.from(bytes), [{ sheet: "数据", address: "B1", value: "x" }]))
    .rejects.toThrow(/合并区域 A1:B1/);
  // 左上角是允许的：文字进共享字符串池，单元格里是索引
  const ok = await editXlsxPreserving(Buffer.from(bytes), [{ sheet: "数据", address: "A1", value: "新表头" }]);
  expect(await partOf(ok.bytes, "xl/sharedStrings.xml")).toContain("新表头");
  expect(await partOf(ok.bytes, "xl/worksheets/sheet1.xml")).toMatch(/<c r="A1" t="s"><v>\d+<\/v><\/c>/);
  await expect(editXlsxPreserving(Buffer.from(bytes), [{ sheet: "不存在", address: "A1", value: "x" }]))
    .rejects.toThrow(/工作表「不存在」不存在/);
});

it("X07：普通工作簿仍走原路径，含图表的走外科式写入", async () => {
  const plain = new ExcelJS.Workbook();
  plain.addWorksheet("表").addRow(["甲", 1]);
  const plainResult = await editXlsxCells(Buffer.from(await plain.xlsx.writeBuffer() as unknown as Buffer), [{ sheet: "表", address: "B2", value: 2 }]);
  expect(plainResult.surgical).toBe(false);

  const charted = await editXlsxCells(await chartedWorkbook(), [{ sheet: "数据", address: "B2", value: 40 }]);
  expect(charted.surgical).toBe(true);
  expect(charted.report!.charts).toEqual(["xl/charts/chart1.xml"]);
});

it("X08：doc_edit 端到端，摘要说明图表被保留并刷新", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xlsx-chart-"));
  const db = new AppDatabase(dir);
  databases.push(db);
  const conversationId = db.createConversation({
    title: "Excel 图表", brainChannelId: "mock-channel", brainModel: "mock",
    videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false,
  }).id;
  const bytes = await chartedWorkbook();
  const saved = saveWorkspaceDocument(db, conversationId, "图表工作簿", "xlsx", bytes, "op-source");

  const result = await executeChatDocumentTool(db, conversationId, "doc_edit", JSON.stringify({
    fileId: saved.id, expectedSha256: createHash("sha256").update(bytes).digest("hex"),
    cells: [{ sheet: "数据", address: "B2", value: 40 }],
  }), undefined, "op-xlsx-chart");
  expect(result.ok).toBe(true);
  expect(result.summary).toContain("图表等部件原样保留");
  expect(result.summary).toContain("刷新了 1 个图表的缓存");

  const updated = readWorkspaceFile(db, conversationId, String(result.data!.fileId)).bytes;
  expect(await partOf(updated, "xl/charts/chart1.xml")).toContain("<c:v>40</c:v>");
});

/* ------------------------------------------------------------------ *
 * Y：批量标记（matchRows）走 ZIP 补丁
 * 颜色藏在 styles.xml（cellXfs → fontId → fonts/color），所以要新增 font 与 xf，
 * 直接改已有 font 会把所有共用它的单元格一起染色。
 * ------------------------------------------------------------------ */

const stylesOf = async (bytes: Buffer) => (await partOf(bytes, "xl/styles.xml"))!;
/** 取某个单元格的 s 索引，再顺着 cellXfs/fonts 找出它的颜色。 */
async function colorOf(bytes: Buffer, ref: string) {
  const sheet = (await partOf(bytes, "xl/worksheets/sheet1.xml"))!;
  const styleIndex = Number(new RegExp(`<c r="${ref}"[^>]*\\bs="(\\d+)"`).exec(sheet)?.[1] ?? 0);
  const styles = await stylesOf(bytes);
  const xfs = [...(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? "").matchAll(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)].map(match => match[0]);
  const fontId = Number(/fontId="(\d+)"/.exec(xfs[styleIndex] ?? "")?.[1] ?? 0);
  const fonts = [...(/<fonts\b[^>]*>([\s\S]*?)<\/fonts>/.exec(styles)?.[1] ?? "").matchAll(/<font\b[^>]*?(?:\/>|>[\s\S]*?<\/font>)/g)].map(match => match[0]);
  return /<color\b[^>]*\brgb="([^"]+)"/.exec(fonts[fontId] ?? "")?.[1] ?? null;
}
const styleIndex = async (bytes: Buffer, ref: string) => {
  const sheet = (await partOf(bytes, "xl/worksheets/sheet1.xml"))!;
  return Number(new RegExp(`<c r="${ref}"[^>]*\\bs="(\\d+)"`).exec(sheet)?.[1] ?? 0);
};

it("Y01：带图表的工作簿能批量标色，图表部件原样保留", async () => {
  const bytes = await chartedWorkbook();
  const result = await matchAndEditXlsx(bytes, { sheet: "数据", column: "C", ids: ["A-001", "A-003"], fontColor: "FF0000" });
  expect(result.bytes).toBeTruthy();
  expect(result.report.surgical).toBe(true);
  expect(result.report.matchedIds).toBe(2);
  expect(result.report.matchedRows).toBe(2);
  expect(result.report.unmatched).toEqual([]);

  // 命中的两行变红，中间那行不动
  expect(await colorOf(result.bytes!, "C2")).toBe("FFFF0000");
  expect(await colorOf(result.bytes!, "C4")).toBe("FFFF0000");
  expect(await styleIndex(result.bytes!, "C3")).toBe(0);
  // 图表与绘图部件逐字节不变
  const before = await JSZip.loadAsync(bytes), after = await JSZip.loadAsync(result.bytes!);
  for (const name of ["xl/charts/chart1.xml", "xl/drawings/drawing1.xml", "xl/theme/theme1.xml", "[Content_Types].xml"]) {
    const a = await before.file(name)!.async("nodebuffer");
    const b = await after.file(name)!.async("nodebuffer");
    expect(createHash("sha256").update(b).digest("hex"), name).toBe(createHash("sha256").update(a).digest("hex"));
  }
  // 原有字体没被污染：第 0 号字体仍无 color
  const styles = await stylesOf(result.bytes!);
  expect(/<fonts\b[^>]*>\s*<font>/.test(styles)).toBe(true);
});

it("Y02：标记列加在最后一列之后，表头与值都写进去，图表不动", async () => {
  const bytes = await chartedWorkbook();
  const result = await matchAndEditXlsx(bytes, { sheet: "数据", column: "C", ids: ["A-002"], marker: {} });
  const sheet = (await partOf(result.bytes!, "xl/worksheets/sheet1.xml"))!;
  // 现有 A–C 三列 → 标记列是 D
  expect(await partOf(result.bytes!, "xl/sharedStrings.xml")).toContain("标记");
  expect(sheet).toMatch(/<row r="1"[^>]*>[\s\S]*?<c r="D1" t="s">/);
  expect(sheet).toMatch(/<row r="3"[^>]*>[\s\S]*?<c r="D3"><v>1<\/v><\/c>/);
  expect(sheet).not.toContain('<c r="D2"');
  expect(await partOf(result.bytes!, "xl/charts/chart1.xml")).toBe(await partOf(bytes, "xl/charts/chart1.xml"));
  // 写入标记列后要让 Excel 重算
  expect(await partOf(result.bytes!, "xl/workbook.xml")).toContain('fullCalcOnLoad="1"');
});

it("Y03：标色范围可指定多列，空白单元格也会被补上样式", async () => {
  const bytes = await chartedWorkbook();
  const result = await matchAndEditXlsx(bytes, {
    sheet: "数据", column: "C", ids: ["A-001"], fontColor: "2A716B", colorColumns: { from: "A", to: "C" },
  });
  for (const ref of ["A2", "B2", "C2"]) expect(await colorOf(result.bytes!, ref)).toBe("FF2A716B");
  // 未命中的行整行都不该被染色
  for (const ref of ["A3", "B3", "C3"]) expect(await styleIndex(result.bytes!, ref)).toBe(0);
});

it("Y04：报告的扫描行数、未命中清单与跳过计数与整本重写一致", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("表");
  sheet.addRow(["编号", "值"]);
  sheet.addRow(["A-001", 1]);
  sheet.addRow([{ formula: "CONCATENATE(\"A-\",\"002\")", result: "A-002" }, 2]);
  sheet.addRow(["A-003", 3]);
  const plain = Buffer.from(await workbook.xlsx.writeBuffer() as unknown as Buffer);

  const options = { sheet: "表", column: "A", ids: ["A-001", "A-002", "A-999"], fontColor: "FF0000" };
  const viaExcelJs = await matchAndEditXlsx(plain, options);
  expect(viaExcelJs.report.surgical).toBe(false);

  // 同一份文件加上图表部件，走 ZIP 补丁，报告数字应完全一致
  const zip = await JSZip.loadAsync(plain);
  zip.file("xl/charts/chart1.xml", CHART);
  const charted = await zip.generateAsync({ type: "nodebuffer" });
  const viaPatch = await matchAndEditXlsx(charted, options);
  expect(viaPatch.report.surgical).toBe(true);
  for (const key of ["scannedRows", "requestedIds", "matchedIds", "matchedRows", "skippedCells", "unmatched"] as const) {
    expect(viaPatch.report[key], key).toEqual(viaExcelJs.report[key]);
  }
  // 公式单元格不算 ID：A-002 在两条路径里都应落在未命中清单
  expect(viaPatch.report.skippedCells).toBe(1);
  expect(viaPatch.report.unmatched).toEqual(["A-002", "A-999"]);
});

it("Y05：标记列冲突（覆盖 ID 列、被占用）都拒绝", async () => {
  const bytes = await chartedWorkbook();
  await expect(matchAndEditXlsx(bytes, { sheet: "数据", column: "C", ids: ["A-001"], marker: { column: "C" } }))
    .rejects.toThrow(/标记列不能覆盖 ID 列/);
  await expect(matchAndEditXlsx(bytes, { sheet: "数据", column: "C", ids: ["A-001"], marker: { column: "A" } }))
    .rejects.toThrow(/已被占用/);
});

it("Y06：受保护的工作表拒绝修改", async () => {
  const zip = await JSZip.loadAsync(await chartedWorkbook());
  const sheet = (await zip.file("xl/worksheets/sheet1.xml")!.async("string"))
    .replace("</sheetData>", "</sheetData><sheetProtection sheet=\"1\" objects=\"1\" scenarios=\"1\"/>");
  zip.file("xl/worksheets/sheet1.xml", sheet);
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  await expect(matchAndEditXlsx(bytes, { sheet: "数据", column: "C", ids: ["A-001"], fontColor: "FF0000" }))
    .rejects.toThrow(/受保护/);
});

it("Y07：doc_edit 批量标记端到端，摘要说明部件被保留", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xlsx-match-"));
  const db = new AppDatabase(dir);
  databases.push(db);
  const conversationId = db.createConversation({
    title: "Excel 批量", brainChannelId: "mock-channel", brainModel: "mock",
    videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false,
  }).id;
  const bytes = await chartedWorkbook();
  const saved = saveWorkspaceDocument(db, conversationId, "图表工作簿", "xlsx", bytes, "op-source");

  const result = await executeChatDocumentTool(db, conversationId, "doc_edit", JSON.stringify({
    fileId: saved.id, expectedSha256: createHash("sha256").update(bytes).digest("hex"),
    matchRows: { sheet: "数据", column: "C", ids: ["A-001", "A-002"], fontColor: "FF0000", marker: {} },
  }), undefined, "op-xlsx-match");
  expect(result.ok).toBe(true);
  expect(result.summary).toContain("图表等部件原样保留");

  const updated = readWorkspaceFile(db, conversationId, String(result.data!.fileId)).bytes;
  expect(await colorOf(updated, "C2")).toBe("FFFF0000");
  expect(await partOf(updated, "xl/charts/chart1.xml")).toBe(await partOf(bytes, "xl/charts/chart1.xml"));
});
