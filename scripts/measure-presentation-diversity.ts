/**
 * 版式多样性度量：把「款式是否重复」变成可对比的数字。
 *
 * 背景：改造前只能靠肉眼说「九页同构图」。这里给出三个可复现的口径：
 *   1. 骨架多样性   —— 不同「元素类型骨架」数 / 正文页数
 *   2. 几何多样性   —— 不同「量化几何构图」数 / 正文页数（防「换了元素名但布局一样」）
 *   3. 连续同构      —— 最长连续相同构图段（同 seriesId 的案例系列允许一致）
 *
 * 只读：打开已有 .pptx，不调用模型、不写入任何文件版本。
 * 用法：
 *   npm run eval:diversity                       # 最近 10 个已发布 PPT
 *   npm run eval:diversity -- --conversation <id>
 *   npm run eval:diversity -- --limit 20 --json
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { AppDatabase } from "../src/server/db.js";

const require = createRequire(import.meta.url);
const JSZip = require("jszip") as typeof import("jszip");

const args = process.argv.slice(2);
const option = (name: string, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? fallback : fallback;
};
const flag = (name: string) => args.includes(name);

const dataDir = path.resolve(option("--data", "data"));
const limit = Number(option("--limit", "10"));
const conversationFilter = option("--conversation", "");
const asJson = flag("--json");
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
  console.error("--limit 必须是 1–200 的整数");
  process.exit(1);
}

/** 渲染器自产的元素 id；模型自由提交的元素通常是 p2-rule / c1-l 这类。 */
const RENDERER_IDS = /^(accent-rule|title|takeaway|marker-\d+|item-\d+|panel-\d+|heading-\d+|picture|table|chart|page-status|page-number|overflow-note|cover-rule|cover-title|cover-subtitle|kpi-\d+|kpi-value-\d+|kpi-label-\d+|kpi-note-\d+|timeline-axis|timeline-node-\d+|timeline-title-\d+|timeline-detail-\d+|timeline-index-\d+|quote-bar|quote-text|quote-source)$/;
/** 模型整页元素的命名习惯（`p2-rule` / `p3-c1`）；这是遗留通道的指纹。 */
const MODEL_IDS = /^p\d+-/;
/** 封面/章节页不参与多样性计算：它们本来就该一致。 */
const NON_BODY = /^(cover|section)/i;

type SlideShape = {
  index: number;
  layout: string;
  skeleton: string;
  geometry: string;
  elements: number;
  fonts: number[];
  authorship: "renderer" | "model" | "mixed";
  title: string;
};

type FileMetric = {
  conversationId: string;
  fileId: string;
  name: string;
  slides: number;
  bodyPages: number;
  skeletonCount: number;
  skeletonRatio: number;
  geometryCount: number;
  geometryRatio: number;
  longestRun: number;
  runs: Array<{ geometry: string; pages: number[] }>;
  rendererPages: number;
  modelPages: number;
  fontPalette: number[];
  /** 通过判据只看多样性：几何多样性 ≥ 0.6 且无 4 页以上连续同构 */
  passed: boolean;
  /** 不达判据的原因 */
  reasons: string[];
  /** 不参与判据、但需要如实记录的观察（如模型自由排版页） */
  warnings: string[];
  pages: SlideShape[];
};

/** 用元素 id 去掉页码前缀与序号，得到「骨架」；只比较结构类型序列。 */
function skeletonOf(names: string[]): string {
  return names
    .map(name => name.replace(/^p\d+-/, "").replace(/[-_]?\d+$/g, ""))
    .filter(Boolean)
    .join("+");
}

/** 量化几何：把坐标尺寸按 0.05 英寸取整后排序，忽略文字内容与颜色。 */
function geometryOf(boxes: Array<{ x: number; y: number; w: number; h: number }>): string {
  const quantize = (value: number) => Math.round(value / 0.05) * 0.05;
  return boxes
    .map(box => `${quantize(box.x)},${quantize(box.y)},${quantize(box.w)},${quantize(box.h)}`)
    .sort()
    .join("|");
}

function parseSlide(xml: string, index: number): SlideShape {
  const names = [...xml.matchAll(/name="([^"]*)"/g)].map(match => match[1]!).filter(name => name && !/^Slide \d+$/.test(name));
  const boxes: Array<{ x: number; y: number; w: number; h: number }> = [];
  for (const shape of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
    const off = shape[0].match(/<a:off x="(\d+)" y="(\d+)"\/>/);
    const ext = shape[0].match(/<a:ext cx="(\d+)" cy="(\d+)"\/>/);
    if (!off || !ext) continue;
    boxes.push({ x: +off[1]! / 914400, y: +off[2]! / 914400, w: +ext[1]! / 914400, h: +ext[2]! / 914400 });
  }
  const fonts = [...new Set([...xml.matchAll(/sz="(\d+)"/g)].map(match => Math.round(+match[1]! / 100)))].sort((a, b) => b - a);
  // 只看「有渲染器标准 id」还是「有模型整页元素前缀」，不要拿单个前缀猜。
  const hasRenderer = names.some(name => RENDERER_IDS.test(name));
  const hasModel = names.some(name => MODEL_IDS.test(name));
  const authorship = hasRenderer && hasModel ? "mixed" : hasModel ? "model" : "renderer";
  const firstText = xml.match(/<a:t>([\s\S]*?)<\/a:t>/)?.[1] ?? "";
  return {
    index, layout: /<p:graphicFrame>/.test(xml) ? "table/chart" : "text", skeleton: skeletonOf(names),
    geometry: geometryOf(boxes), elements: boxes.length, fonts, authorship, title: firstText.slice(0, 24),
  };
}

async function measure(bytes: Buffer, meta: { conversationId: string; fileId: string; name: string }): Promise<FileMetric> {
  const zip = await JSZip.loadAsync(bytes);
  const slideNames = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const pages: SlideShape[] = [];
  for (const [index, name] of slideNames.entries()) pages.push(parseSlide(await zip.file(name)!.async("string"), index + 1));

  const body = pages.filter(page => !NON_BODY.test(page.title) && page.index > 1);
  const skeletons = new Set(body.map(page => page.skeleton));
  const geometries = new Set(body.map(page => page.geometry));

  const runs: FileMetric["runs"] = [];
  let current: FileMetric["runs"][number] | undefined;
  for (const page of body) {
    if (current && current.geometry === page.geometry) current.pages.push(page.index);
    else {
      if (current && current.pages.length > 1) runs.push(current);
      current = { geometry: page.geometry, pages: [page.index] };
    }
  }
  if (current && current.pages.length > 1) runs.push(current);
  const longestRun = runs.reduce((max, run) => Math.max(max, run.pages.length), 1);

  const ratio = (count: number) => body.length ? Math.round((count / body.length) * 1000) / 1000 : 0;
  const reasons: string[] = [];
  if (body.length >= 4 && ratio(geometries.size) < 0.6) reasons.push(`几何多样性 ${ratio(geometries.size)} < 0.6`);
  if (longestRun >= 4) reasons.push(`连续 ${longestRun} 页同构图（≥4 视为无理由重复）`);
  const modelPages = body.filter(page => page.authorship !== "renderer").length;
  // 作者归属不影响多样性判据，但它是「主题被绕过」的直接证据，必须单独记录。
  const warnings = modelPages ? [`${modelPages} 页为模型自由元素排版（主题令牌不参与，皮肤可能不一致）`] : [];

  return {
    ...meta, slides: pages.length, bodyPages: body.length,
    skeletonCount: skeletons.size, skeletonRatio: ratio(skeletons.size),
    geometryCount: geometries.size, geometryRatio: ratio(geometries.size),
    longestRun, runs,
    rendererPages: body.length - modelPages, modelPages,
    fontPalette: [...new Set(body.flatMap(page => page.fonts))].sort((a, b) => b - a),
    passed: reasons.length === 0, reasons, warnings, pages,
  };
}

const db = new AppDatabase(dataDir);
const conversations = conversationFilter
  ? [{ id: conversationFilter }]
  : db.listConversations().map(conversation => ({ id: conversation.id }));

type Entry = { conversationId: string; fileId: string; name: string; bytes: Buffer; createdAt: string };
const entries: Entry[] = [];
for (const conversation of conversations) {
  let files: ReturnType<AppDatabase["listWorkspaceDocuments"]> = [];
  try { files = db.listWorkspaceDocuments(conversation.id); } catch { continue; }
  for (const file of files) {
    if (!/\.pptx$/i.test(file.name)) continue;
    let bytes: Buffer;
    try { bytes = await fs.readFile(path.join(file.baseDir, conversation.id, file.name)); } catch { continue; }
    entries.push({ conversationId: conversation.id, fileId: file.id, name: file.name, bytes, createdAt: file.createdAt });
  }
}
entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const selected = entries.slice(0, limit);
if (!selected.length) {
  console.error("没有找到可分析的 .pptx（先跑一次生成，或用 --data 指定数据目录）");
  process.exitCode = 1;
} else {
  const metrics: FileMetric[] = [];
  for (const entry of selected) {
    try { metrics.push(await measure(entry.bytes, { conversationId: entry.conversationId, fileId: entry.fileId, name: entry.name })); }
    catch (error) { console.error(`跳过 ${entry.name}：${error instanceof Error ? error.message : error}`); }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const output = path.resolve("artifacts", "presentation-diversity", stamp);
  const summary = {
    generatedAt: new Date().toISOString(), dataDir, files: metrics.length,
    criteria: { geometryRatio: 0.6, maxConsecutiveSameGeometry: 4 },
    passed: metrics.filter(metric => metric.passed).length,
    aggregate: {
      medianGeometryRatio: median(metrics.map(metric => metric.geometryRatio)),
      medianSkeletonRatio: median(metrics.map(metric => metric.skeletonRatio)),
      maxLongestRun: metrics.reduce((max, metric) => Math.max(max, metric.longestRun), 0),
      modelAuthoredPages: metrics.reduce((sum, metric) => sum + metric.modelPages, 0),
    },
    files_: metrics,
  };
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(summary, null, 2));
  if (asJson) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`分析 ${metrics.length} 个文件（${dataDir}）\n`);
    for (const metric of metrics) {
      console.log(`${metric.passed ? "PASS" : "FAIL"}  [${metric.conversationId.slice(0, 8)}] ${metric.name.replace(/^\d{4}-\d\d-\d\dT[\d.-]+Z-/, "")}`);
      console.log(`      正文 ${metric.bodyPages} 页 | 骨架 ${metric.skeletonCount} (${metric.skeletonRatio}) | 几何 ${metric.geometryCount} (${metric.geometryRatio}) | 最长连续 ${metric.longestRun} | 模型排版页 ${metric.modelPages} | 字号 ${metric.fontPalette.join("/")}`);
      for (const reason of metric.reasons) console.log(`      · ${reason}`);
      for (const warning of metric.warnings) console.log(`      ! ${warning}`);
    }
    console.log(`\n几何多样性中位数 ${summary.aggregate.medianGeometryRatio}，最长连续 ${summary.aggregate.maxLongestRun}，模型排版页合计 ${summary.aggregate.modelAuthoredPages}`);
    console.log(`报告 ${path.join(output, "report.json")}`);
  }
  if (metrics.some(metric => !metric.passed)) process.exitCode = 0; // 度量不阻断，只记录基线
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round(((sorted[middle - 1]! + sorted[middle]!) / 2) * 1000) / 1000;
}
