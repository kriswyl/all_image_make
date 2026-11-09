/**
 * Excel 图表工作簿的真实验收。
 *
 * 流程：用本机 Excel（WPS 注册的 COM）生成一份带柱状图的工作簿 → 用本项目的
 * editXlsxPreserving 改几个单元格 → 再把改后的文件交回 Excel 打开，读单元格值与
 * 图表系列实际绘制用的数字。
 *
 * 两件事要同时成立才算通过：
 *   1. 图表部件还在（Excel 能打开并读到 ChartObjects），说明没被整本重写冲掉；
 *   2. 图表画的是新数字 —— 这是「改数，图跟着变」的硬证据。
 * 另外直接在 XML 里核对图表缓存也已同步，那是给不重算的预览器看的。
 *
 * 只使用脚本内生成的虚构数据，不读任何用户文件。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import JSZip from "jszip";
import { editXlsxPreserving } from "../src/server/chat-tools/xlsx-surgical.js";
import { matchAndEditXlsx } from "../src/server/chat-tools/spreadsheet-document.js";

const SHEET = "数据";
const VALUES = [40, 55, 30];
const output = path.resolve("artifacts", "xlsx-chart-real", new Date().toISOString().replace(/[:.]/g, "-"));
await fs.mkdir(output, { recursive: true });
const report: Record<string, unknown> = { output };

function runPowerShell(script: string, env: Record<string, string>) {
  // PowerShell 5.1 默认按本地代码页写 stdout，中文会被截断成乱码；先切到 UTF-8。
  const preamble = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; ";
  const run = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", preamble + script], {
    env: { ...process.env, ...env }, encoding: "utf8", timeout: 180000,
  });
  return `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
}

try {
  if (process.platform !== "win32") throw new Error("Excel 渲染验收依赖本机 Excel/WPS 的 COM，目前只支持 Windows");

  // 1. 生成带柱状图的源文件
  const source = path.join(output, "source.xlsx");
  runPowerShell([
    "$ErrorActionPreference='Stop'",
    "$app=New-Object -ComObject Excel.Application",
    "$app.Visible=$false; $app.DisplayAlerts=0",
    "try {",
    "  $wb=$app.Workbooks.Add()",
    "  $ws=$wb.Worksheets.Item(1)",
    `  $ws.Name='${SHEET}'`,
    "  $ws.Cells.Item(1,1).Value2='类别'; $ws.Cells.Item(1,2).Value2='数量'; $ws.Cells.Item(1,3).Value2='编号'",
    "  $ws.Cells.Item(2,1).Value2='一月'; $ws.Cells.Item(2,2).Value2=12; $ws.Cells.Item(2,3).Value2='A-001'",
    "  $ws.Cells.Item(3,1).Value2='二月'; $ws.Cells.Item(3,2).Value2=18; $ws.Cells.Item(3,3).Value2='A-002'",
    "  $ws.Cells.Item(4,1).Value2='三月'; $ws.Cells.Item(4,2).Value2=9;  $ws.Cells.Item(4,3).Value2='A-003'",
    "  $co=$ws.ChartObjects().Add(320,20,320,200)",
    "  $co.Chart.ChartType=51",
    `  $co.Chart.SetSourceData($ws.Range('A1:B4'))`,
    "  $wb.SaveAs($env:XL_OUT,51); $wb.Close(0)",
    "} finally { try { $app.Quit() } catch { } }",
    "exit 0",
  ].join("; "), { XL_OUT: source });
  const original = await fs.readFile(source);
  report.sourceBytes = original.length;

  // 2. 用本项目的代码改数（不是用 Excel 改）
  const patched = await editXlsxPreserving(original, VALUES.map((value, index) => ({
    sheet: SHEET, address: `B${index + 2}`, value,
  })));
  const target = path.join(output, "patched.xlsx");
  await fs.writeFile(target, patched.bytes);
  report.report = patched.report;

  // 3. 直接看包内：图表部件还在，且缓存已同步
  const zip = await JSZip.loadAsync(patched.bytes);
  const chartName = Object.keys(zip.files).find(name => /^xl\/charts\/chart\d+\.xml$/.test(name));
  const chartXml = chartName ? await zip.file(chartName)!.async("string") : "";
  const numCache = (/<c:numCache>([\s\S]*?)<\/c:numCache>/.exec(chartXml)?.[1] ?? "");
  const cached = [...numCache.matchAll(/<c:pt\b[^>]*><c:v>([^<]*)<\/c:v><\/c:pt>/g)].map(match => Number(match[1]));
  report.chartPart = chartName ?? null;
  report.cachedValues = cached;

  // 4. 交回 Excel 打开，读单元格与图表实际用的数字
  const probe = runPowerShell([
    "$ErrorActionPreference='Stop'",
    "$app=New-Object -ComObject Excel.Application",
    "$app.Visible=$false; $app.DisplayAlerts=0",
    "try {",
    "  $wb=$app.Workbooks.Open($env:XL_IN,0,$true)",
    "  $ws=$wb.Worksheets.Item(1)",
    "  $cells=@($ws.Range('B2').Value2,$ws.Range('B3').Value2,$ws.Range('B4').Value2)",
    "  $count=$ws.ChartObjects().Count",
    "  $vals=@()",
    "  if ($count -gt 0) { $vals=$ws.ChartObjects().Item(1).Chart.SeriesCollection(1).Values }",
    "  $wb.Close(0)",
    "  Write-Output ('cells=' + ($cells -join ','))",
    "  Write-Output ('charts=' + $count)",
    "  Write-Output ('series=' + ($vals -join ','))",
    "} finally { try { $app.Quit() } catch { } }",
    "exit 0",
  ].join("; "), { XL_IN: target });

  const cells = /cells=([\d,\-.]*)/.exec(probe)?.[1]?.split(",").map(Number) ?? [];
  const charts = Number(/charts=(\d+)/.exec(probe)?.[1] ?? 0);
  const series = /series=([\d,\-.]*)/.exec(probe)?.[1]?.split(",").map(Number) ?? [];
  report.cells = cells;
  report.charts = charts;
  report.series = series;

  const same = (list: number[]) => list.length === VALUES.length && list.every((value, index) => value === VALUES[index]);
  const checks = {
    // 文件仍能被 Excel 打开，且图表还在
    opened: cells.length === VALUES.length && charts === 1,
    // 单元格是新值
    cellsWritten: same(cells),
    // 图表画的是新值
    chartReplotted: same(series),
    // 包内缓存也是新值（不重算的预览器也能显示对）
    cacheSynced: same(cached),
    // 第二阶段（批量标记）的结论，下面再填
    markColors: false,
    markChartKept: false,
    markColumn: false,
  };
  // 5. 第二阶段：在同一份（带图表的）工作簿上做批量标记，再打开核对字体颜色与图表
  const marked = await matchAndEditXlsx(patched.bytes, {
    sheet: SHEET, column: "C", ids: ["A-001", "A-003"], fontColor: "FF0000", marker: {},
  });
  if (!marked.bytes) throw new Error("批量标记没有产出新文件");
  const markedPath = path.join(output, "marked.xlsx");
  await fs.writeFile(markedPath, marked.bytes);
  report.markReport = marked.report;

  const probe2 = runPowerShell([
    "$ErrorActionPreference='Stop'",
    "$app=New-Object -ComObject Excel.Application",
    "$app.Visible=$false; $app.DisplayAlerts=0",
    "try {",
    "  $wb=$app.Workbooks.Open($env:XL_IN,0,$true)",
    "  $ws=$wb.Worksheets.Item(1)",
    "  $col=@($ws.Range('C2').Font.Color,$ws.Range('C3').Font.Color,$ws.Range('C4').Font.Color)",
    "  $charts=$ws.ChartObjects().Count",
    "  $vals=@(); if ($charts -gt 0) { $vals=$ws.ChartObjects().Item(1).Chart.SeriesCollection(1).Values }",
    "  $head=[string]$ws.Range('D1').Value2",
    "  $mk=@($ws.Range('D2').Value2,$ws.Range('D3').Value2,$ws.Range('D4').Value2)",
    "  $wb.Close(0)",
    "  Write-Output ('colors=' + (($col | ForEach-Object { if ($_ -eq $null) { 'null' } else { $_ } }) -join ','))",
    "  Write-Output ('charts=' + $charts)",
    "  Write-Output ('series=' + ($vals -join ','))",
    "  Write-Output ('header=' + $head)",
    "  Write-Output ('marks=' + (($mk | ForEach-Object { if ($_ -eq $null) { '' } else { $_ } }) -join ','))",
    "} finally { try { $app.Quit() } catch { } }",
    "exit 0",
  ].join("; "), { XL_IN: markedPath });

  const colors = /colors=([^\r\n]*)/.exec(probe2)?.[1]?.split(",") ?? [];
  const marks = /marks=([^\r\n]*)/.exec(probe2)?.[1]?.split(",") ?? [];
  const markedCharts = Number(/charts=(\d+)/.exec(probe2)?.[1] ?? 0);
  const markedSeries = /series=([\d,\-.]*)/.exec(probe2)?.[1]?.split(",").map(Number) ?? [];
  const header = /header=([^\r\n]*)/.exec(probe2)?.[1] ?? "";
  report.marked = { colors, charts: markedCharts, series: markedSeries, header, marks };

  // 红色在 Excel 的 BGR 记法里是 255；未命中的那行应保持自动色（0）
  checks.markColors = colors[0] === "255" && colors[2] === "255" && colors[1] === "0";
  checks.markChartKept = markedCharts === 1 && same(markedSeries);
  checks.markColumn = header === "标记" && marks[0] === "1" && marks[1] === "" && marks[2] === "1";

  report.checks = checks;
  report.passed = Object.values(checks).every(Boolean);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.passed = false;
  report.error = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
}
