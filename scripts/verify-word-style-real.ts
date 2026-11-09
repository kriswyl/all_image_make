/**
 * Word 样式的真实渲染验收（字符属性 + 段落属性）。
 *
 * 流程：用 docx 生成一份普通文档 → 用本项目的 styleDocxText / styleDocxParagraphs 打补丁 →
 * 同一份源文件与补丁文件各交本机 WPS（Word COM）导出 PDF → 用 pdfjs 读回文字、颜色、字体与
 * 文本坐标，靠「补丁前后同一行文字的位置差」判断段落属性是否真的生效。
 *
 * 与 `eval:wps` 的区别：那条验的是 PPT 出图，这条验的是 Word 的字符与段落属性。
 * 只使用脚本内生成的虚构文本，不读任何用户文件。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { AlignmentType, Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from "docx";
import { editDocxTableStructure, styleDocxParagraphs, styleDocxText } from "../src/server/chat-tools/word-document.js";

const COLOR = "B23B2E";
const PLAIN = "这是普通文字";
const ACCENT = "这段应该加粗变红";
const TAIL = "后面恢复普通";
const BASELINE = "左对齐基线这一行保持不动";
const CENTERED = "待居中段落";
const SPACED = "行距段落要加倍";
const AFTER = "行距之后的段落";
const AFTER_TABLE = "表格之后的行";
const CELL_OLD = "3 个";
const CELL_NEW = "9 个";

const output = path.resolve("artifacts", "word-style-real", new Date().toISOString().replace(/[:.]/g, "-"));
await fs.mkdir(output, { recursive: true });

const report: Record<string, unknown> = { output, color: COLOR };

type Line = { text: string; left: number; right: number; baseline: number };
type TextItem = { str?: string; transform?: number[]; width?: number };

/** 把 pdfjs 的文本片段按基线合并成行；同一行的片段可能被拆成好几块。 */
function toLines(items: TextItem[]): Line[] {
  const lines: Line[] = [];
  for (const item of items) {
    if (!item.str || !item.str.trim() || !item.transform) continue;
    const x = item.transform[4]!;
    const y = item.transform[5]!;
    const width = item.width ?? 0;
    const line = lines.find(candidate => Math.abs(candidate.baseline - y) < 2);
    if (line) {
      line.text += item.str;
      line.left = Math.min(line.left, x);
      line.right = Math.max(line.right, x + width);
    } else {
      lines.push({ text: item.str, left: x, right: x + width, baseline: y });
    }
  }
  return lines;
}

/** 交本机 WPS（Word COM）导出 PDF。路径走环境变量，避免拼进命令串。 */
async function exportPdf(docx: string, pdf: string) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "$app=New-Object -ComObject Word.Application",
    "$app.Visible=$false; $app.DisplayAlerts=0",
    "try {",
    "  $doc=$app.Documents.Open($env:WORD_VERIFY_IN,$false,$true)",
    "  $doc.SaveAs2($env:WORD_VERIFY_OUT,17)",
    "  $pages=$doc.ComputeStatistics(2)",
    "  $doc.Close(0)",
    "  Write-Output ('pages=' + $pages)",
    "} finally { try { $app.Quit() } catch { } }",
    // WPS 的 Quit 常抛 RPC 异常，但文档已经导出；显式退出 0，别让退出码掩盖结果。
    "exit 0",
  ].join("; ");
  const run = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, WORD_VERIFY_IN: docx, WORD_VERIFY_OUT: pdf },
    encoding: "utf8", timeout: 180000,
  });
  const exists = await fs.access(pdf).then(() => true).catch(() => false);
  if (!exists) throw new Error(`WPS 没有导出 PDF：${(run.stderr || run.stdout || "").trim().slice(0, 400)}`);
  return Number(/pages=(\d+)/.exec(run.stdout)?.[1] ?? 0);
}

try {
  if (process.platform !== "win32") throw new Error("Word 渲染验收依赖本机 WPS 的 Word COM，目前只支持 Windows");

  // 1. 生成「无任何样式」的源文件：四段纯文字，靠补丁制造差异，避免生成器自带属性干扰判断。
  const source = await Packer.toBuffer(new Document({
    sections: [{
      children: [
        new Paragraph({ children: [new TextRun(PLAIN), new TextRun(ACCENT), new TextRun(TAIL)] }),
        new Paragraph({ alignment: AlignmentType.LEFT, children: [new TextRun(BASELINE)] }),
        new Paragraph({ children: [new TextRun(CENTERED)] }),
        new Paragraph({ children: [new TextRun(SPACED)] }),
        new Paragraph({ children: [new TextRun(AFTER)] }),
        new Table({ rows: [
          new TableRow({ children: [
            new TableCell({ children: [new Paragraph("阶段")] }),
            new TableCell({ children: [new Paragraph("结果")] }),
          ] }),
          new TableRow({ children: [
            new TableCell({ children: [new Paragraph("选点")] }),
            new TableCell({ children: [new Paragraph(CELL_OLD)] }),
          ] }),
        ] }),
        new Paragraph({ children: [new TextRun(AFTER_TABLE)] }),
      ],
    }],
  }));
  await fs.writeFile(path.join(output, "source.docx"), source);

  // 2. 用项目的补丁改样式 —— 验的是我们的代码，不是 docx 库。
  const styled = await editDocxTableStructure(
    await styleDocxParagraphs(
      await styleDocxText(source, [{ find: ACCENT, bold: true, color: COLOR }]),
      [{ find: CENTERED, align: "center" }, { find: SPACED, lineSpacing: 2 }],
    ),
    // 两条：先改一个单元格的文字，再在末尾加一行 —— 表格结构与内容都要真的落到渲染里
    [{ find: "选点", cells: [{ row: 2, col: 2, text: CELL_NEW }] }, { find: "阶段", insertRows: { at: 3, count: 1 } }],
  );
  const docx = path.join(output, "styled.docx");
  await fs.writeFile(docx, styled);

  // 3. 源文件与补丁文件都导出一次，后面按「同一行文字的位置差」判断是否生效。
  const sourcePdf = path.join(output, "source.pdf");
  const styledPdf = path.join(output, "styled.pdf");
  const pages = await exportPdf(docx, styledPdf);
  const sourcePages = await exportPdf(path.join(output, "source.docx"), sourcePdf);
  report.pages = pages;
  report.sourcePages = sourcePages;
  report.pdfBytes = (await fs.stat(styledPdf)).size;

  // 4. 读回 PDF：文字、颜色、字体、坐标四类证据。
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { getDocument } = pdfjs;
  const root = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")).replace(/\\/g, "/");

  async function read(file: string) {
    const bytes = await fs.readFile(file);
    const task = getDocument({ data: new Uint8Array(bytes), useWasm: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false,
      cMapUrl: `${root}/cmaps/`, standardFontDataUrl: `${root}/standard_fonts/` });
    const document = await task.promise;
    const page = await document.getPage(1);
    const content = await page.getTextContent();
    const items = content.items as TextItem[];
    const viewport = page.getViewport({ scale: 1 });
    const operators = await page.getOperatorList();
    const fills = operators.fnArray
      .map((fn, index) => ({ fn, args: operators.argsArray[index] }))
      .filter(item => item.fn === pdfjs.OPS.setFillRGBColor)
      .map(item => String((item.args as unknown[])?.[0] ?? "").toLowerCase());
    await task.destroy();
    return { text: items.map(item => item.str ?? "").join(""), lines: toLines(items), fills, width: viewport.width };
  }

  const after = await read(styledPdf);
  const before = await read(sourcePdf);

  const find = (lines: Line[], token: string) => lines.find(line => line.text.includes(token));

  // 字体资源单独取一次：加粗与否看的是「命中的那一段用了哪个字体资源」。
  const fontOf = async (file: string, token: string) => {
    const bytes = await fs.readFile(file);
    const task = getDocument({ data: new Uint8Array(bytes), useWasm: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false,
      cMapUrl: `${root}/cmaps/`, standardFontDataUrl: `${root}/standard_fonts/` });
    const document = await task.promise;
    const page = await document.getPage(1);
    const content = await page.getTextContent();
    const item = (content.items as TextItem[]).find(entry => entry.str?.includes(token));
    const name = (item as { fontName?: string } | undefined)?.fontName ?? null;
    await task.destroy();
    return name;
  };

  const fonts = {
    plain: await fontOf(styledPdf, PLAIN),
    accent: await fontOf(styledPdf, ACCENT),
  };

  const centered = find(after.lines, CENTERED);
  const centeredBefore = find(before.lines, CENTERED);
  const spacedAfterLine = find(after.lines, AFTER);
  const spacedBeforeLine = find(before.lines, AFTER);
  const centerOffset = centered ? Math.abs((centered.left + centered.right) / 2 - after.width / 2) : Infinity;
  const centerOffsetBefore = centeredBefore ? Math.abs((centeredBefore.left + centeredBefore.right) / 2 - before.width / 2) : 0;
  const spacingDelta = (spacedBeforeLine?.baseline ?? 0) - (spacedAfterLine?.baseline ?? 0);
  // 表格多了一行 → 表后的那段被推下去
  const tableShift = (find(before.lines, AFTER_TABLE)?.baseline ?? 0) - (find(after.lines, AFTER_TABLE)?.baseline ?? 0);

  report.text = after.text;
  report.fillColors = after.fills;
  report.fonts = fonts;
  report.centerOffset = { styled: Number(centerOffset.toFixed(2)), source: Number(centerOffsetBefore.toFixed(2)), pageWidth: Number(after.width.toFixed(2)) };
  report.spacingDelta = Number(spacingDelta.toFixed(2));
  // 表后那段同时受「行距加倍」和「多一行」影响，扣掉前者才是表格的真实贡献。
  report.tableShift = Number(tableShift.toFixed(2));
  report.tableRowShift = Number((tableShift - spacingDelta).toFixed(2));
  report.baselines = {
    spaced: { styled: spacedAfterLine?.baseline ?? null, source: spacedBeforeLine?.baseline ?? null },
  };

  const checks = {
    // 文字在：真渲染过，不是只改了 XML
    textPresent: after.text.includes(ACCENT) && after.text.includes(PLAIN),
    // 颜色在：且只出现一次（只有这一段变红）
    colorApplied: after.fills.filter(color => color === `#${COLOR.toLowerCase()}`).length === 1,
    // 加粗：命中段与普通段用了不同的字体资源
    boldApplied: Boolean(fonts.accent) && Boolean(fonts.plain) && fonts.accent !== fonts.plain,
    // 居中：补丁后偏离页面中线不超过页宽 3%，且源文件确实没居中
    centered: centerOffset < after.width * 0.03 && centerOffsetBefore > after.width * 0.1,
    // 行距：后面那段被推下去了（2 倍行距至少多出半个行高）
    lineSpacing: spacingDelta > 6,
    // 表格单元格：改后的文字真的出现在渲染结果里，且旧值已经不在了
    tableCell: after.text.includes(CELL_NEW) && !after.text.includes(CELL_OLD),
    // 表格结构：扣掉行距影响后，仍被推低一个行高左右（约 12–18pt）
    tableRow: tableShift - spacingDelta > 6,
    pageCount: pages === 1 && sourcePages === 1,
  };
  report.checks = checks;
  report.passed = Object.values(checks).every(Boolean);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await fs.mkdir(output, { recursive: true }).catch(() => {});
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
}
