/**
 * 图表内嵌工作簿同步。
 *
 * PowerPoint 的「编辑数据」打开的是 `ppt/embeddings/*.xlsx`，而幻灯片显示的是
 * `chartN.xml` 里的缓存。只改缓存会让两者不一致，所以这里把同一份数据写回工作簿。
 *
 * 用外科式改写而不是整本重写：只动 `xl/worksheets/sheet1.xml` 的单元格、
 * `xl/sharedStrings.xml` 的字符串池和 `xl/tables/*.xml` 的列名，样式与表定义保持原样。
 */
import JSZip from "jszip";

export type ChartWorkbookData = {
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
};

export type WorkbookSync = {
  status: "synced" | "missing" | "failed";
  part?: string;
  reason?: string;
};

const decode = (value: string) => value
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const encode = (value: string) => value
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/gu, "�")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** 列字母转序号，只处理 A–Z 足够（图表列数上限 8+1）。 */
const columnIndex = (letters: string) => [...letters].reduce((sum, char) => sum * 26 + (char.charCodeAt(0) - 64), 0);

function readSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, body]) =>
    // 富文本 <si><r><t>..</t></r></si> 拼起来；纯文本直接取 <t>
    [...body!.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(([, text]) => decode(text!)).join(""));
}

function writeSharedStrings(values: string[], references: number): string {
  const items = values.map(value => value ? `<si><t xml:space="preserve">${encode(value)}</t></si>` : "<si><t xml:space=\"preserve\"></t></si>").join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${references}" uniqueCount="${values.length}">${items}</sst>`;
}

/** 找到嵌入工作簿：图表的 rels 里 Type 以 /package 结尾。 */
async function workbookPart(zip: JSZip, chartPart: string): Promise<string | null> {
  const rels = zip.file(`ppt/charts/_rels/${chartPart.split("/").pop()}.rels`);
  if (!rels) return null;
  const xml = await rels.async("string");
  const match = /<Relationship\b[^>]*Type="[^"]*\/package"[^>]*>/.exec(xml);
  if (!match) return null;
  const target = /Target="([^"]+)"/.exec(match[0])?.[1];
  if (!target) return null;
  return target.startsWith("/") ? target.slice(1) : `ppt/${target.replace(/^\.\.\//, "")}`;
}

export async function syncChartWorkbook(zip: JSZip, chartPart: string, data: ChartWorkbookData): Promise<WorkbookSync> {
  const part = await workbookPart(zip, chartPart);
  if (!part) return { status: "missing" };
  const file = zip.file(part);
  if (!file) return { status: "missing" };

  try {
    const workbook = await JSZip.loadAsync(await file.async("nodebuffer"));
    const sheetName = "xl/worksheets/sheet1.xml";
    const sheetFile = workbook.file(sheetName);
    if (!sheetFile) return { status: "failed", reason: "工作簿没有 sheet1.xml" };
    const sheet = await sheetFile.async("string");
    const shared = readSharedStrings(await workbook.file("xl/sharedStrings.xml")?.async("string"));

    /** 复用已有字符串，没有就追加，返回索引。 */
    const intern = (value: string) => {
      const existing = shared.indexOf(value);
      if (existing >= 0) return existing;
      shared.push(value);
      return shared.length - 1;
    };

    const categories = data.categories.map(value => intern(value));
    const names = data.series.map(item => intern(item.name));

    const nextSheet = sheet.replace(/<row\b([^>]*)>([\s\S]*?)<\/row>/g, (whole, attrs: string, body: string) => {
      const rowNumber = Number(/r="(\d+)"/.exec(attrs)?.[1] ?? 0);
      if (!rowNumber) return whole;
      const isHeader = rowNumber === 1;
      const category = isHeader ? undefined : categories[rowNumber - 2];
      const nextBody = body.replace(/<c\b([^>]*)>([\s\S]*?)<\/c>/g, (cell, cellAttrs: string, inner: string) => {
        const ref = /r="([A-Z]+)\d+"/.exec(cellAttrs)?.[1];
        if (!ref) return cell;
        const column = columnIndex(ref);
        const clean = cellAttrs.replace(/\s+t="[^"]*"/, "");
        if (isHeader) {
          // 第 1 行：B 起是系列名，A 列是空字符串
          if (column === 1) return `<c${clean} t="s"><v>${intern("")}</v></c>`;
          const name = names[column - 2];
          if (name === undefined) return cell;
          return `<c${clean} t="s"><v>${name}</v></c>`;
        }
        if (column === 1) {
          if (category === undefined) return cell;
          return `<c${clean} t="s"><v>${category}</v></c>`;
        }
        const values = data.series[column - 2]?.values;
        const value = values?.[rowNumber - 2];
        if (value === undefined) return cell;
        // 数值单元格不能带 t="s"，也不要保留旧的缓存字符串
        return `<c${clean}><v>${Number(value)}</v></c>`;
      });
      return `<row${attrs}>${nextBody}</row>`;
    });

    if (nextSheet === sheet) return { status: "failed", reason: "工作簿结构与图表数据对不上" };
    workbook.file(sheetName, nextSheet);
    // count 是「被引用次数」，uniqueCount 是池子大小；Excel 会校验这两个值。
    workbook.file("xl/sharedStrings.xml", writeSharedStrings(shared, (nextSheet.match(/t="s"/g) ?? []).length));

    // 表对象（Excel 的「表格」）会把列名一起记下来，名字改了要跟着改，否则 Excel 会报不一致。
    for (const name of Object.keys(workbook.files).filter(item => /^xl\/tables\/table\d+\.xml$/.test(item))) {
      const tableFile = workbook.file(name)!;
      const table = await tableFile.async("string");
      const nextTable = table.replace(/<tableColumn\b([^>]*)\/>/g, (whole, attrs: string) => {
        const id = Number(/id="(\d+)"/.exec(attrs)?.[1] ?? 0);
        const column = id; // 第 1 列是分类列，2 起对应系列
        const label = column === 1 ? "Column1" : data.series[column - 2]?.name;
        if (label === undefined) return whole;
        return `<tableColumn${attrs.replace(/\bname="[^"]*"/, `name="${encode(label)}"`)}/>`;
      });
      if (nextTable !== table) workbook.file(name, nextTable);
    }

    zip.file(part, await workbook.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    return { status: "synced", part };
  } catch (error) {
    return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}
