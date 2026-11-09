/**
 * Word 字符样式的真实渲染验收。
 *
 * 流程：用 docx 生成一份普通文档 → 用本项目的 styleDocxText 加粗变红 → 交本机 WPS（Word COM）
 * 导出 PDF → 用 pdfjs 读回文字、颜色与字体，确认样式真的落到了渲染结果上。
 *
 * 与 `eval:wps` 的区别：那条验的是 PPT 出图，这条验的是 Word 的字符属性。
 * 只使用脚本内生成的虚构文本，不读任何用户文件。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { styleDocxText } from "../src/server/chat-tools/word-document.js";

const COLOR = "B23B2E";
const PLAIN = "这是普通文字";
const ACCENT = "这段应该加粗变红";
const TAIL = "后面恢复普通";

const output = path.resolve("artifacts", "word-style-real", new Date().toISOString().replace(/[:.]/g, "-"));
await fs.mkdir(output, { recursive: true });

const report: Record<string, unknown> = { output, color: COLOR };
try {
  if (process.platform !== "win32") throw new Error("Word 渲染验收依赖本机 WPS 的 Word COM，目前只支持 Windows");

  // 1. 生成「未加样式」的源文件：三段同字号，只靠样式区分，避免字号差异干扰判断。
  const source = await Packer.toBuffer(new Document({
    sections: [{ children: [new Paragraph({ children: [
      new TextRun({ text: PLAIN }),
      new TextRun({ text: ACCENT }),
      new TextRun({ text: TAIL }),
    ] })] }],
  }));
  await fs.writeFile(path.join(output, "source.docx"), source);

  // 2. 用项目的补丁改样式，而不是直接生成带样式的文件 —— 这样验的是我们的代码。
  const styled = await styleDocxText(source, [{ find: ACCENT, bold: true, color: COLOR }]);
  const docx = path.join(output, "styled.docx");
  await fs.writeFile(docx, styled);

  // 3. 交本机 WPS 导出 PDF；路径通过环境变量传入，避免拼进命令串。
  const pdf = path.join(output, "styled.pdf");
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
  const pages = Number(/pages=(\d+)/.exec(run.stdout)?.[1] ?? 0);
  report.pages = pages;
  report.pdfBytes = (await fs.stat(pdf)).size;

  // 4. 读回 PDF：文字、颜色、字体三项都要对得上。
  const bytes = await fs.readFile(pdf);
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { getDocument } = pdfjs;
  const root = path.dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")).replace(/\\/g, "/");
  const task = getDocument({ data: new Uint8Array(bytes), useWasm: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false,
    cMapUrl: `${root}/cmaps/`, standardFontDataUrl: `${root}/standard_fonts/` });
  const document = await task.promise;
  const page = await document.getPage(1);
  const content = await page.getTextContent();
  const items = (content.items as Array<{ str?: string; fontName?: string }>).filter(item => Boolean(item.str?.trim()));
  const text = items.map(item => item.str).join("");
  const accent = items.find(item => item.str?.includes(ACCENT));
  const plain = items.find(item => item.str?.includes(PLAIN));
  const operators = await page.getOperatorList();
  const fillColors = operators.fnArray
    .map((fn, index) => ({ fn, args: operators.argsArray[index] }))
    .filter(item => item.fn === pdfjs.OPS.setFillRGBColor)
    .map(item => String((item.args as unknown[])?.[0] ?? "").toLowerCase());
  await task.destroy();

  report.text = text;
  report.fillColors = fillColors;
  report.fonts = { plain: plain?.fontName ?? null, accent: accent?.fontName ?? null };

  const checks = {
    // 文字在：真渲染过，不是只改了 XML
    textPresent: text.includes(ACCENT) && text.includes(PLAIN),
    // 颜色在：且只出现一次（只有这一段变红）
    colorApplied: fillColors.filter(color => color === `#${COLOR.toLowerCase()}`).length === 1,
    // 加粗：命中段与普通段用了不同的字体资源
    boldApplied: Boolean(accent?.fontName) && Boolean(plain?.fontName) && accent!.fontName !== plain!.fontName,
    pageCount: pages === 1,
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
