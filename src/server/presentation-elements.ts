import { z } from "zod";
import { presentationInk, presentationPanel } from "./presentation-palette.js";
type Presentation = InstanceType<typeof import("pptxgenjs").default>;
type PresentationSlide = ReturnType<Presentation["addSlide"]>;

export const PAGE_WIDTH = 13.333333;
export const PAGE_HEIGHT = 7.5;
export const MAX_SLIDES = 200;
export const MAX_ELEMENTS = 160;
export const MAX_LEGACY_LINES = 6;
export const MIN_FONT_SIZE = 12;
const color = z.string().regex(/^[0-9A-Fa-f]{6}$/);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const number = z.number().finite();
const frame = { x: number.min(0), y: number.min(0), w: number.min(0), h: number.min(0) };
export const textStyleSchema = z.object({
  fontSize: number.min(MIN_FONT_SIZE).max(96).optional(), bold: z.boolean().optional(),
  color: color.optional(), align: z.enum(["left", "center", "right"]).optional(),
  valign: z.enum(["top", "middle", "bottom"]).optional(), fontFace: z.string().min(1).max(80).optional(),
  lineSpacing: z.union([number.min(0.8).max(3), number.min(12).max(120)]).optional(), margin: number.min(0).max(0.4).optional(),
}).strict();
export const elementSchema = z.discriminatedUnion("type", [
  z.object({ id, type: z.literal("text"), ...frame, text: z.string().min(1).max(6000), style: textStyleSchema.optional() }).strict(),
  z.object({ id, type: z.literal("image"), ...frame, imageIndex: z.number().int().min(0).max(199), fit: z.enum(["contain", "cover"]).optional() }).strict(),
  z.object({ id, type: z.literal("shape"), ...frame, shape: z.enum(["rect", "roundRect", "ellipse", "line"]), fill: color.optional(), line: z.object({ color: color.optional(), width: number.min(0).max(12).optional() }).strict().optional() }).strict(),
  z.object({ id, type: z.literal("icon"), ...frame, icon: z.enum(["check", "target", "trend", "info", "arrow"]), color: color.optional() }).strict(),
  z.object({ id, type: z.literal("table"), ...frame, rows: z.array(z.array(z.string().max(1000)).min(1).max(20)).min(1).max(30), header: z.boolean().optional(), fontSize: number.min(MIN_FONT_SIZE).max(36).optional() }).strict(),
  z.object({ id, type: z.literal("chart"), ...frame, chartType: z.enum(["bar", "line", "pie"]), categories: z.array(z.string().min(1).max(100)).min(1).max(40), series: z.array(z.object({ name: z.string().min(1).max(100), values: z.array(number).min(1).max(40) }).strict()).min(1).max(8) }).strict(),
  z.object({ id, type: z.literal("connector"), from: id, to: id, label: z.string().max(120).optional(), arrow: z.boolean().optional(), color: color.optional() }).strict(),
]);
export type PresentationElement = z.infer<typeof elementSchema>;
export type Box = { direction: "row" | "column"; gap?: number; children: Array<{ flex?: number; element?: PresentationElement; box?: Box }> };
const boxSchema: z.ZodType<Box> = z.lazy(() => z.object({
  direction: z.enum(["row", "column"]), gap: number.min(0).max(1).optional(),
  children: z.array(z.object({ flex: number.min(0.1).max(20).optional(), element: elementSchema.optional(), box: boxSchema.optional() }).strict().refine((child) => Boolean(child.element) !== Boolean(child.box), "布局子项必须指定 element 或 box 之一")).min(1).max(20),
}).strict());
export const slideBoxSchema = z.object({ ...frame, layout: boxSchema }).strict();
export const designSchema = z.object({ background: color.optional(), text: color.optional(), accent: color.optional(), fontFace: z.string().min(1).max(80).optional() }).strict();
export type PresentationDesign = z.infer<typeof designSchema>;
export type ElementSlide = { elements?: PresentationElement[]; box?: z.infer<typeof slideBoxSchema>; lines?: string[] };

/** Compile constraints to the same stable-ID element representation used for rendering and patches. */
export function resolveElements(slide: ElementSlide): PresentationElement[] | undefined {
  if (slide.elements && slide.box) throw new Error("elements 与 box 不能同时指定");
  if ((slide.elements || slide.box) && slide.lines?.length) throw new Error("元素页的 lines 必须为空；正文必须放进可见文字、表格或图表元素，不能被隐藏");
  if (!slide.box) return slide.elements;
  const result: PresentationElement[] = [];
  const place = (box: Box, area: { x: number; y: number; w: number; h: number }, depth: number) => {
    if (depth > 6) throw new Error("布局嵌套超过 6 层");
    const gap = box.gap ?? 0.2, horizontal = box.direction === "row";
    const available = (horizontal ? area.w : area.h) - gap * (box.children.length - 1);
    if (available <= 0) throw new Error("布局间距超过可用空间");
    const total = box.children.reduce((sum, child) => sum + (child.flex ?? 1), 0);
    let at = horizontal ? area.x : area.y;
    for (const child of box.children) {
      const length = available * (child.flex ?? 1) / total;
      const rect = horizontal ? { x: at, y: area.y, w: length, h: area.h } : { x: area.x, y: at, w: area.w, h: length };
      if (child.box) place(child.box, rect, depth + 1);
      else if (child.element) {
        if (child.element.type === "connector") throw new Error("连线应放入绝对元素列表，不占布局槽位");
        result.push({ ...child.element, ...rect });
      }
      at += length + gap;
      if (result.length > MAX_ELEMENTS) throw new Error("页面元素过多");
    }
  };
  place(slide.box.layout, slide.box, 0);
  return result;
}

export function validateElements(elements: PresentationElement[], imageCount?: number): void {
  if (!elements.length || elements.length > MAX_ELEMENTS) throw new Error(`每页需包含 1–${MAX_ELEMENTS} 个元素`);
  const ids = new Set<string>();
  for (const element of elements) {
    if (ids.has(element.id)) throw new Error(`元素 ID 重复：${element.id}`);
    ids.add(element.id);
    if (element.type === "connector") continue;
    const { x, y, w, h } = element;
    const line = element.type === "shape" && element.shape === "line";
    if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w < 0 || h < 0 || (line ? w + h <= 0 : w <= 0 || h <= 0) || x + w > PAGE_WIDTH + 0.0001 || y + h > PAGE_HEIGHT + 0.0001) throw new Error(`元素 ${element.id} 超出页面边界或尺寸无效`);
    if (element.type === "image" && imageCount !== undefined && element.imageIndex >= imageCount) throw new Error(`元素 ${element.id} 图片素材不存在`);
    if (element.type === "table" && element.rows.some((row) => row.length !== element.rows[0]!.length)) throw new Error(`表格 ${element.id} 列数不一致`);
    if (element.type === "chart" && (element.series.some((series) => series.values.length !== element.categories.length) || element.chartType === "pie" && (element.series.length !== 1 || element.series[0]!.values.some((value) => value < 0) || element.series[0]!.values.every((value) => value === 0)))) throw new Error(`图表 ${element.id} 数据长度不匹配或饼图数据无效`);
  }
  for (const element of elements) if (element.type === "connector") {
    const from = elements.find((item) => item.id === element.from), to = elements.find((item) => item.id === element.to);
    if (!from || !to || from.type === "connector" || to.type === "connector" || from === to) throw new Error(`连线 ${element.id} 的端点无效`);
  }
}

/** Readable content is independent of geometry, so patches can be checked without trusting the reviewer. */
export function elementTexts(elements: PresentationElement[]): string[] {
  return elements.flatMap((element) => element.type === "text" ? [element.text] : element.type === "table" ? element.rows.flat() : element.type === "chart" ? [...element.categories, ...element.series.flatMap((series) => [series.name, ...series.values.map(String)])] : element.type === "connector" && element.label ? [element.label] : []);
}

/** Estimate capacity, never silently delete text or shrink below a readable floor. Actual rendering remains authoritative. */
export function layoutIssues(elements: PresentationElement[]): string[] {
  const issues: string[] = [];
  for (const element of elements) {
    if (element.type !== "text") continue;
    const size = element.style?.fontSize ?? 18, margin = element.style?.margin ?? 0;
    const chars = Math.max(1, (element.w - 2 * margin) * 72 / size);
    const rows = element.text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(Array.from(line).reduce((width, char) => width + (/[^\x00-\xff]/.test(char) ? 1 : 0.55), 0) / chars)), 0);
    const spacing = element.style?.lineSpacing;
    const needed = rows * (spacing === undefined ? size * 1.2 : spacing <= 3 ? size * spacing : spacing) / 72 + 2 * margin;
    if (needed > element.h + 0.06) issues.push(`${element.id} 文字预计需要 ${needed.toFixed(2)} 英寸高度，当前 ${element.h.toFixed(2)}`);
  }
  // Only overlapping text regions are flagged; backgrounds, icons and image overlays may be intentional.
  const texts = elements.filter((item): item is Extract<PresentationElement, { type: "text" }> => item.type === "text").map((item) => {
    const size = item.style?.fontSize ?? 18, margin = item.style?.margin ?? 0;
    const width = Array.from(item.text).reduce((sum, char) => sum + (/[^\x00-\xff]/.test(char) ? 1 : 0.55), 0) * size / 72;
    if (item.text.includes("\n") || width > item.w - 2 * margin) return item;
    // A wide empty text box is not the same as overlapping glyphs (e.g. a short left label).
    const w = Math.min(item.w, width + margin * 2), h = Math.min(item.h, size * 1.2 / 72 + margin * 2);
    return { ...item, w, h, x: item.x + (item.style?.align === "right" ? item.w - w : item.style?.align === "center" ? (item.w - w) / 2 : 0), y: item.y + (item.style?.valign === "bottom" ? item.h - h : item.style?.valign === "middle" ? (item.h - h) / 2 : 0) };
  });
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    const a = texts[i]!, b = texts[j]!;
    if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.08 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.08) issues.push(`${a.id} 与 ${b.id} 文本框重叠`);
  }
  return issues.slice(0, 12);
}

type Point = { x: number; y: number };
type Rect = { x: number; y: number; w: number; h: number };
function crosses(a: Point, b: Point, rect: Rect): boolean {
  let low = 0, high = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - rect.x], [dx, rect.x + rect.w - a.x], [-dy, a.y - rect.y], [dy, rect.y + rect.h - a.y]]) {
    if (Math.abs(p!) < 0.000001) { if (q! < 0) return false; continue; }
    const ratio = q! / p!;
    if (p! < 0) low = Math.max(low, ratio); else high = Math.min(high, ratio);
    if (low > high) return false;
  }
  return low < 0.9999 && high > 0.0001;
}

/** Route non-adjacent relations around intermediate cards instead of cutting through their text. */
export function connectorRoute(elements: PresentationElement[], connector: Extract<PresentationElement, { type: "connector" }>): Point[] {
  const a = elements.find((item) => item.id === connector.from), b = elements.find((item) => item.id === connector.to);
  if (!a || !b || a.type === "connector" || b.type === "connector") throw new Error("连线端点无效");
  const contains = (outer: Rect, inner: Rect) => outer.x <= inner.x + 0.01 && outer.y <= inner.y + 0.01 && outer.x + outer.w >= inner.x + inner.w - 0.01 && outer.y + outer.h >= inner.y + inner.h - 0.01;
  const obstacles = elements.filter((item): item is Exclude<PresentationElement, { type: "connector" }> => item.type !== "connector" && item.id !== a.id && item.id !== b.id).filter((item) => !contains(a, item) && !contains(b, item) && !contains(item, a) && !contains(item, b));
  const horizontal = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
  const start = { x: horizontal ? a.x + (b.x > a.x ? a.w : 0) : a.x + a.w / 2, y: horizontal ? a.y + a.h / 2 : a.y + (b.y > a.y ? a.h : 0) };
  const end = { x: horizontal ? b.x + (b.x > a.x ? 0 : b.w) : b.x + b.w / 2, y: horizontal ? b.y + b.h / 2 : b.y + (b.y > a.y ? 0 : b.h) };
  if (!obstacles.some((rect) => crosses(start, end, rect))) return [start, end];
  const candidates: Point[][] = [];
  for (const gap of [0.3, 0.6, 0.9]) {
    for (const below of [true, false]) {
      const y = below ? Math.max(a.y + a.h, b.y + b.h) + gap : Math.min(a.y, b.y) - gap;
      candidates.push([{ x: a.x + a.w / 2, y: below ? a.y + a.h : a.y }, { x: a.x + a.w / 2, y }, { x: b.x + b.w / 2, y }, { x: b.x + b.w / 2, y: below ? b.y + b.h : b.y }]);
    }
    for (const right of [true, false]) {
      const x = right ? Math.max(a.x + a.w, b.x + b.w) + gap : Math.min(a.x, b.x) - gap;
      candidates.push([{ x: right ? a.x + a.w : a.x, y: a.y + a.h / 2 }, { x, y: a.y + a.h / 2 }, { x, y: b.y + b.h / 2 }, { x: right ? b.x + b.w : b.x, y: b.y + b.h / 2 }]);
    }
  }
  const valid = candidates.filter((points) => points.every((point) => point.x >= 0.15 && point.y >= 0.15 && point.x <= PAGE_WIDTH - 0.15 && point.y <= PAGE_HEIGHT - 0.15));
  const score = (points: Point[]) => points.slice(1).reduce((sum, point, index) => sum + Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y) + obstacles.filter((rect) => crosses(points[index]!, point, rect)).length * 1000, 0);
  valid.sort((left, right) => score(left) - score(right));
  return valid[0] ?? [start, end];
}

export function renderElements(ppt: Presentation, slide: PresentationSlide, elements: PresentationElement[], images: Array<{ data: string }>, design: PresentationDesign = {}): void {
  validateElements(elements, images.length);
  const accent = design.accent ?? "286D9C", ink = design.text ?? "243443", font = design.fontFace ?? "Microsoft YaHei";
  const paper = design.background ?? "FFFFFF", panel = presentationPanel(paper);
  const chartInk = presentationInk(paper, ink);
  for (const element of elements) {
    if (element.type === "connector") continue;
    const rect = { x: element.x, y: element.y, w: element.w, h: element.h, objectName: element.id };
    switch (element.type) {
      case "text": {
        const style = element.style ?? {};
        slide.addText(element.text, { ...rect, fontFace: style.fontFace ?? font, fontSize: style.fontSize ?? 18, bold: style.bold, color: style.color ?? ink, align: style.align, valign: style.valign ?? "top", margin: (style.margin ?? 0) * 72, lineSpacingMultiple: style.lineSpacing === undefined ? 1.15 : style.lineSpacing <= 3 ? style.lineSpacing : undefined, lineSpacing: style.lineSpacing !== undefined && style.lineSpacing > 3 ? style.lineSpacing : undefined, breakLine: false });
        break;
      }
      case "image": slide.addImage({ ...rect, data: images[element.imageIndex]!.data, sizing: { type: element.fit ?? "contain", w: element.w, h: element.h } }); break;
      case "shape": slide.addShape(ppt.ShapeType[element.shape], { ...rect, ...(element.fill ? { fill: { color: element.fill } } : { fill: { color: "FFFFFF", transparency: 100 } }), line: { color: element.line?.color ?? element.fill ?? accent, width: element.line?.width ?? 1 }, ...(element.shape === "roundRect" ? { rectRadius: 0.12 } : {}) }); break;
      case "table": {
        const rows = element.rows.map((row, index) => {
          const header = Boolean(element.header && index === 0);
          const background = header ? accent : index % 2 ? panel : paper;
          const color = presentationInk(background, header ? undefined : ink);
          return row.map(text => ({ text, options: { bold: header, color, fill: { color: background } } }));
        });
        slide.addTable(rows, { ...rect, fontFace: font, fontSize: element.fontSize ?? 16, border: { color: panel, pt: 0.5 }, margin: 5, rowH: element.h / element.rows.length, autoPage: false });
        break;
      }
      case "chart": slide.addChart(ppt.ChartType[element.chartType], element.series.map((series) => ({ name: series.name, labels: element.categories, values: series.values })), { ...rect, showLegend: element.series.length > 1 || element.chartType === "pie", showValue: true, showTitle: false, chartArea: { fill: { color: paper } }, plotArea: { fill: { color: paper } }, chartColors: [accent, "77A6B6", "D8A657", "778CA3", "7DA87B", "BD8D99", "9A8EB8", "B5B584"], showLabel: element.chartType === "pie", catAxisLabelFontFace: font, catAxisLabelFontSize: 12, catAxisLabelColor: chartInk, valAxisLabelFontFace: font, valAxisLabelFontSize: 12, valAxisLabelColor: chartInk, dataLabelColor: chartInk, legendColor: chartInk, legendFontSize: 12 }); break;
      case "icon": {
        const c = element.color ?? accent;
        if (element.icon === "target" || element.icon === "info") {
          slide.addShape(ppt.ShapeType.ellipse, { ...rect, line: { color: c, width: 2 }, fill: { color: "FFFFFF", transparency: 100 } });
          if (element.icon === "target") slide.addShape(ppt.ShapeType.ellipse, { x: element.x + element.w * 0.32, y: element.y + element.h * 0.32, w: element.w * 0.36, h: element.h * 0.36, fill: { color: c }, line: { color: c } });
          else slide.addText("i", { ...rect, fontFace: font, fontSize: Math.max(12, Math.min(element.w, element.h) * 40), bold: true, color: c, align: "center", valign: "middle", margin: 0 });
        } else {
          const points = element.icon === "check" ? [[0.1, 0.5, 0.35, 0.8], [0.35, 0.8, 0.9, 0.15]] : element.icon === "trend" ? [[0.05, 0.85, 0.4, 0.4], [0.4, 0.4, 0.6, 0.6], [0.6, 0.6, 0.95, 0.1]] : [[0.05, 0.5, 0.95, 0.5]];
          for (const [x1, y1, x2, y2] of points) slide.addShape(ppt.ShapeType.line, { x: element.x + Math.min(x1!, x2!) * element.w, y: element.y + Math.min(y1!, y2!) * element.h, w: Math.abs(x2! - x1!) * element.w, h: Math.abs(y2! - y1!) * element.h, flipV: y2! < y1!, line: { color: c, width: 2.5, ...(element.icon === "arrow" ? { endArrowType: "triangle" as const } : {}) } });
        }
        break;
      }
    }
  }
  for (const element of elements) if (element.type === "connector") {
    const points = connectorRoute(elements, element);
    let labelStart = points[0]!, labelEnd = points[1]!, longest = 0;
    for (let i = 1; i < points.length; i++) {
      const from = points[i - 1]!, to = points[i]!;
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      if (length > longest) { longest = length; labelStart = from; labelEnd = to; }
      if (length <= 0.0001) continue;
      slide.addShape(ppt.ShapeType.line, { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), w: Math.abs(to.x - from.x), h: Math.abs(to.y - from.y), flipH: to.x < from.x, flipV: to.y < from.y, line: { color: element.color ?? accent, width: 1.5, ...(element.arrow && i === points.length - 1 ? { endArrowType: "triangle" as const } : {}) }, objectName: `${element.id}-segment-${i}` });
    }
    if (element.label) slide.addText(element.label, { x: Math.max(0, Math.min(PAGE_WIDTH - 2, (labelStart.x + labelEnd.x) / 2 - 1)), y: Math.max(0, Math.min(PAGE_HEIGHT - 0.4, (labelStart.y + labelEnd.y) / 2 - 0.4)), w: 2, h: 0.4, fontFace: font, fontSize: 12, color: element.color ?? accent, align: "center", margin: 0 });
  }
}

export const ELEMENT_DESIGN_GUIDE = `优先输出元素级页面：{layout:"content",title,subtitle:"",lines:[],notes,sourceIds,elements:[...]}；旧 layout 仍兼容。画布 13.333333×7.5 英寸，安全边距左右0.6上下0.45。每个元素有稳定唯一 id（字母数字_-）和 type。普通元素必填 x,y,w,h；不得越界。text 元素的 text 字段**必须是字符串**，样式放在同级的 style；不能写成 text:{text,style}。text:{text,style?:{fontSize,bold,color,align,valign,fontFace,lineSpacing,margin}}；align只能为left/center/right，valign只能为top/middle/bottom（垂直居中用middle）；image:{imageIndex,fit:"contain"|"cover"}；shape:{shape:"rect"|"roundRect"|"ellipse"|"line",fill?,line?:{color,width}}；icon:{icon:"check"|"target"|"trend"|"info"|"arrow",color?}；table:{rows:二维字符串数组,header?,fontSize?}；chart:{chartType:"bar"|"line"|"pie",categories:[分类],series:[{name,values:[有限数字]}]}；connector:{id,type:"connector",from:端点元素id,to:端点元素id,label?,arrow?:布尔,color?}，连线无x/y/w/h。所有颜色为6位十六进制无#。表格各行列数相同，图表每组数据长度等于分类数，无真实数据不得编造图表。图片只能引用提供的图片编号。原生文本框可编辑，标题必须实际出现在text元素中。style.lineSpacing可填0.8–3的倍数（如1.2），或12–120的磅值；style.margin单位英寸。正文建议18–22pt，标题28–36pt，注释至少12pt；按文本容量给足宽高，禁止依赖自动缩字。每页围绕一个主张，提供必要支撑、事实和条件，密集内容拆页。可用无方向的connector表达来源中明确的关联，不擅自添加因果箭头。每页最多160元素。约束布局可用box代替elements：box:{x,y,w,h,layout:{direction:"row"|"column",gap:英寸,children:[{flex:比例,element:完整普通元素}|{flex:比例,box:递归布局}]}}，element坐标会被槽位覆盖；box和elements不能同时给。`;
