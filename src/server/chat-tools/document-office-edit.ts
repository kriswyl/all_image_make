import { editDocxTableStructure, editDocxText, styleDocxParagraphs, styleDocxText } from "./word-document.js";
import { editXlsxCells, matchAndEditXlsx } from "./spreadsheet-document.js";
import type { DocumentEditArgs } from "./document-tool-schema.js";

export async function editWordDocument(originalBytes: Buffer, args: Pick<DocumentEditArgs, "edits" | "styles" | "paragraphs" | "tables" | "cells" | "matchRows">) {
  const { edits, styles, paragraphs, tables, cells, matchRows } = args;
  let bytes: Buffer;
  let summary: string;
  if (cells || matchRows) throw new Error("Word 不支持单元格参数；改表格用 tables");
  // 文字一改，按原文定位的样式就对不上了，必须分开提交。
  if (edits && (styles || paragraphs)) throw new Error("文字替换与样式修改请分两次提交，避免样式对着已改过的文字");
  // 表格改动会重构行列结构，和按文字定位的修改叠在一起容易互相踩，单独提交最稳。
  if (tables && (edits || styles || paragraphs)) throw new Error("表格修改请单独提交，避免与文字或样式修改互相干扰");
  if (!edits && !styles && !paragraphs && !tables) throw new Error("Word 请提供 edits（段落内文字替换）、styles（字符样式）、paragraphs（段落样式）或 tables（表格）");
  if (tables) {
    bytes = await editDocxTableStructure(originalBytes, tables);
    const actions = tables.map(item => `${item.cells ? `改 ${item.cells.length} 格` : "增删行列"}（定位「${item.find}」）`).join("、");
    summary = `已修改 ${tables.length} 处表格：${actions}；未涉及的段落与部件保持原样。`;
  } else if (edits) {
    bytes = await editDocxText(originalBytes, edits);
    summary = `已完成 ${edits.length} 处正文替换。`;
  } else {
    // 字符样式与段落样式改的是不同层级（rPr / pPr），可以一次提交，串行生效。
    bytes = originalBytes;
    if (styles) bytes = await styleDocxText(bytes, styles);
    if (paragraphs) bytes = await styleDocxParagraphs(bytes, paragraphs);
    const parts = [
      styles ? `${styles.length} 处字符样式` : "",
      paragraphs ? `${paragraphs.length} 处段落样式` : "",
    ].filter(Boolean).join("、");
    summary = `已完成 ${parts}修改（只改命中文字或段落的属性，其它内容不动）。`;
  }
  return { bytes, summary };
}

export async function editSpreadsheetDocument(
  originalBytes: Buffer,
  args: Pick<DocumentEditArgs, "edits" | "cells" | "matchRows">,
  readMatchList: (fileId: string) => Buffer,
): Promise<{ bytes?: Buffer; summary: string }> {
  const { edits, cells, matchRows } = args;
  let bytes: Buffer;
  let summary: string;
  if (matchRows) {
    if (edits || cells) throw new Error("批量匹配与逐格修改请分别提交");
    const listBytes = matchRows.list ? readMatchList(matchRows.list.fileId) : undefined;
    const result = await matchAndEditXlsx(originalBytes, matchRows, listBytes);
    const { scannedRows, requestedIds, matchedIds, matchedRows, unmatched, skippedCells } = result.report;
    summary = `已扫描 ${scannedRows} 行，${requestedIds} 个不同 ID 中命中 ${matchedIds} 个，共 ${matchedRows} 行；未找到 ${unmatched.length} 个。`;
    if (unmatched.length) {
      const sample: string[] = [];
      let chars = 0;
      for (const id of unmatched) {
        if (chars + id.length > 6000) break;
        sample.push(JSON.stringify(id));
        chars += id.length + 3;
      }
      if (sample.length) summary += `未找到的 ID${sample.length < unmatched.length ? `（前 ${sample.length} 个）` : ""}：${sample.join("、")}。`;
    }
    if (skippedCells) summary += `有 ${skippedCells} 个非空单元格因公式、合并或非普通 ID 值跳过。`;
    if (result.report.surgical) summary += "工作簿里的图表等部件原样保留。";
    if (!result.bytes) return { summary: `${summary}没有匹配行，未生成修改版。` };
    bytes = result.bytes;
    if (matchRows.fontColor) summary += matchRows.colorColumns ? "已为命中行的指定列设置字体颜色。" : "已为命中的 ID 设置字体颜色。";
    if (matchRows.marker) summary += `已写入「${matchRows.marker.header ?? "标记"}」列。`;
  } else {
    if (!cells || edits) throw new Error("Excel 请提供 cells 单元格修改列表或 matchRows 批量匹配参数");
    const result = await editXlsxCells(originalBytes, cells);
    bytes = result.bytes;
    if (result.surgical) {
      const charts = result.report.charts.length
        ? `，并刷新了 ${result.report.charts.length} 个图表的缓存（${result.report.charts.join("、")}）`
        : "";
      const warnings = result.report.warnings.length ? ` 注意：${result.report.warnings.slice(0, 2).join("；")}` : "";
      summary = `已完成 ${cells.length} 个单元格修改，工作簿里的图表等部件原样保留${charts}。${warnings}`;
    } else {
      summary = `已完成 ${cells.length} 个单元格修改。请用 Excel 或 WPS 打开并重新计算公式。`;
    }
  }
  return { bytes, summary };
}
