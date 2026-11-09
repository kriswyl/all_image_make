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

const SHEET = "数据";
const VALUES = [40, 55, 30];
const output = path.resolve("artifacts", "xlsx-chart-real", new Date().toISOString().replace(/[:.]/g, "-"));
await fs.mkdir(output, { recursive: true });
const report: Record<string, unknown> = { output };

function runPowerShell(script: string, env: Record<string, string>) {
  const run = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
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
    "  $ws.Cells.Item(1,1).Value2='类别'; $ws.Cells.Item(1,2).Value2='数量'",
    "  $ws.Cells.Item(2,1).Value2='一月'; $ws.Cells.Item(2,2).Value2=12",
    "  $ws.Cells.Item(3,1).Value2='二月'; $ws.Cells.Item(3,2).Value2=18",
    "  $ws.Cells.Item(4,1).Value2='三月'; $ws.Cells.Item(4,2).Value2=9",
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
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2)).catch(() => {});
}
