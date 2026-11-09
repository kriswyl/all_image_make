import { z } from "zod";
import type { AiPresentation } from "./mind-document.js";
import { PAGE_HEIGHT, layoutIssues, resolveElements, validateElements, type PresentationDesign, type PresentationElement } from "./presentation-elements.js";
import { presentationInk, presentationPanel } from "./presentation-palette.js";
import { DEFAULT_THEME_ID, getTheme, type ThemeTokens } from "../shared/presentation-theme.js";
import { compressText, fitChars, measureHeight, type CapacityDiagnosis } from "../shared/presentation-capacity.js";

const DEFAULT_THEME = getTheme(DEFAULT_THEME_ID);

const line = z.string().trim().min(1).max(160);
export const slideContentSchema = z.object({
  page: z.number().int().positive(),
  title: z.string().trim().min(1).max(70),
  takeaway: z.string().trim().max(140).optional(),
  layout: z.enum(["bullets", "cards", "process", "comparison", "table", "chart", "image", "kpi", "timeline", "quote"]),
  bullets: z.array(line).max(6).optional(),
  groups: z.array(z.object({ title: z.string().trim().min(1).max(44), items: z.array(line).min(1).max(3) })).min(2).max(4).optional(),
  table: z.array(z.array(z.string().trim().max(80)).min(2).max(5)).min(2).max(7).optional(),
  chart: z.object({
    type: z.enum(["bar", "line", "pie"]),
    categories: z.array(z.string().trim().min(1).max(24)).min(2).max(8),
    series: z.array(z.object({ name: z.string().trim().min(1).max(32), values: z.array(z.number().finite()).min(2).max(8) })).min(1).max(3),
  }).optional(),
  /** kpi：2–4 个指标卡，数字必须来自原文。 */
  metrics: z.array(z.object({
    label: z.string().trim().min(1).max(18),
    value: z.string().trim().min(1).max(14),
    note: z.string().trim().max(40).optional(),
  })).min(2).max(4).optional(),
  /** timeline：3–6 个有先后顺序的阶段。 */
  steps: z.array(z.object({
    title: z.string().trim().min(1).max(24),
    detail: z.string().trim().max(60).optional(),
  })).min(3).max(6).optional(),
  /** quote：一句结论或引文 + 出处。 */
  quote: z.object({
    text: z.string().trim().min(2).max(120),
    source: z.string().trim().max(40).optional(),
  }).optional(),
  imageIndex: z.number().int().min(0).max(199).optional(),
  notes: z.string().trim().max(1500).optional(),
});
export type SlideContent = z.infer<typeof slideContentSchema>;
type Slide = AiPresentation["slides"][number];
type Text = Extract<PresentationElement, { type: "text" }>;
type Rect = Pick<Text, "x" | "y" | "w" | "h">;
const xmlText = (value: string) => value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/gu, "�");
const singleLine = (value: string) => xmlText(value).replace(/\s+/g, " ");
const textKey = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\p{P}\s]/gu, "");

export function validSlideContent(content: SlideContent, images: number[]): boolean {
  const { layout, bullets, groups, table, chart, imageIndex, metrics, steps, quote } = content;
  if (imageIndex !== undefined && !images.includes(imageIndex)) return false;
  if (layout === "kpi") return !!metrics && metrics.length >= 2;
  if (layout === "timeline") return !!steps && steps.length >= 3;
  if (layout === "quote") return !!quote && textKey(quote.text) !== textKey(content.title) && !!textKey(quote.text);
  if (layout === "table") return !!table && table.every(row => row.length === table[0]!.length && row.some(Boolean));
  if (layout === "chart") return !!chart && chart.series.every(series => series.values.length === chart.categories.length) &&
    (chart.type !== "pie" || chart.series.length === 1 && chart.series[0]!.values.every(value => value >= 0) && chart.series[0]!.values.some(value => value > 0));
  const title = textKey(content.title);
  const body = (value: string) => {
    const key = textKey(value);
    return !!key && key !== title;
  };
  if (layout === "cards" || layout === "process" || layout === "comparison") {
    return !!groups && (layout !== "comparison" || groups.length === 2) &&
      groups.every(group => group.items.some(item => body(item) && textKey(item) !== textKey(group.title)));
  }
  return !!bullets?.some(body) && (layout !== "image" || imageIndex !== undefined);
}

/** Stable editable geometry, shared typography, and full-length text retained in notes. */
export function renderContentSlide(
  content: SlideContent, design: PresentationDesign, sourceIds: string[], sourceNotes: string,
  status?: "精简页" | "待补全", imageIndex?: number, theme: ThemeTokens = DEFAULT_THEME,
): { slide: Slide; overflow: boolean; capacity: CapacityDiagnosis } {
  const elements: PresentationElement[] = [];
  const moved: string[] = [];
  // 容量诊断随渲染一起产出：哪一页被压缩、被截断、放宽了行高，都必须能核对。
  const capacity: CapacityDiagnosis = { ok: true, issues: [], truncated: [], reflowed: [] };
  const paper = design.background ?? theme.colors.background;
  // 面板/墨色仍由对比度推导兜底：主题可以给建议色，但不能把文字压到看不清。
  const panel = design.background ? presentationPanel(paper) : theme.colors.panel ?? presentationPanel(paper);
  const ink = presentationInk(paper, design.text ?? theme.colors.ink), panelInk = presentationInk(panel, design.text ?? theme.colors.ink);
  const accent = design.accent ?? theme.colors.accent;
  const fontFace = design.fontFace ?? theme.typography.fontFace;
  const { layout: geometry, typography } = theme;
  const add = (id: string, value: string | undefined, rect: Rect, size: number, min: number, color = ink, bold = false) => {
    if (!value) return;
    const item: Text = { type: "text", id, ...rect, text: xmlText(value), style: { fontSize: size, color, bold, margin: 0, valign: "middle", fontFace } };
    // 第一层：缩字号，但有下限；到下限就停，不许无声突破。
    while (layoutIssues([item]).length && item.style!.fontSize! > min) item.style!.fontSize! -= 1;
    if (layoutIssues([item]).length) {
      // 第二层：按语义边界压缩（分句处断开），而不是从字中间硬切。
      const fontSize = item.style!.fontSize!;
      const budget = fitChars(item.text, fontSize, rect);
      const compressed = compressText(item.text, budget);
      item.text = compressed.text;
      // 压缩本身可能因为字宽估算与真实排版差一点，仍放不下就继续退字。
      let chars = Array.from(item.text);
      while (layoutIssues([item]).length && chars.length > 1) {
        chars = chars.slice(0, -1);
        item.text = `${chars.join("").trimEnd()}…`;
      }
      if (compressed.cut) {
        // 只要真的丢字，就必须留证据：这一页不能被当成「内容完整」。
        capacity.truncated.push(id);
        capacity.issues.push({
          slot: id, kind: fontSize <= min ? "font_floor" : "too_long",
          overBy: Math.round((measureHeight(value, fontSize, rect) - rect.h - 0.06) * 100) / 100,
          keepChars: Array.from(item.text).length,
          remedy: Array.from(item.text).length >= Array.from(value).length * 0.5 ? "compress" : "split_page",
          detail: `${fontSize}pt 下最多保留 ${Array.from(item.text).length}/${Array.from(value).length} 字，原文已存入演讲备注`,
        });
        moved.push(value);
      }
    }
    elements.push(item);
  };
  const shape = (id: string, rect: Rect, fill: string, round = false) => elements.push({
    type: "shape", id, shape: round ? "roundRect" : "rect", ...rect, fill, line: { color: fill, width: 0 },
  });
  shape("accent-rule", { x: geometry.marginX, y: geometry.ruleY, w: geometry.ruleWidth, h: geometry.ruleHeight }, accent);
  add("title", content.title, { x: geometry.marginX, y: geometry.titleY, w: geometry.contentWidth, h: geometry.titleHeight },
    typography.title, typography.titleMin, ink, true);
  add("takeaway", content.takeaway, { x: geometry.marginX, y: geometry.takeawayY, w: geometry.contentWidth, h: geometry.takeawayHeight },
    typography.takeaway, typography.takeawayMin, ink);
  const top = content.takeaway ? geometry.bodyTopWithTakeaway : geometry.bodyTop, bottom = geometry.bottom;
  const width = geometry.contentWidth;
  const body = content.bullets ?? [];
  const groups = content.groups ?? [];
  const media = content.imageIndex ?? imageIndex;
  const picture = (index: number) => elements.push({
    type: "image", id: "picture", x: geometry.mediaX, y: top, w: geometry.mediaWidth, h: bottom - top, imageIndex: index, fit: "contain",
  });
  if (content.layout === "table" && content.table) {
    const columns = content.table[0]!.length;
    const cellCapacity = Math.floor((width / columns - 0.18) * 72 / typography.small);
    const rows = content.table.map(row => row.map(cell => {
      const flat = singleLine(cell);
      if (Array.from(flat).length <= cellCapacity) return flat;
      // 表格单元格同样按分句压缩，并记录截断，避免「看起来放得下」。
      const compressed = compressText(flat, cellCapacity);
      capacity.truncated.push("table");
      capacity.issues.push({
        slot: "table", kind: "too_long", overBy: 0, keepChars: cellCapacity, remedy: "compress",
        detail: `单元格超过 ${cellCapacity} 字，已压缩并保留原文到备注`,
      });
      moved.push(flat);
      return compressed.text;
    }));
    elements.push({ id: "table", type: "table", x: geometry.marginX, y: top, w: width, h: bottom - top, rows, header: true, fontSize: typography.small });
  } else if (content.layout === "chart" && content.chart) {
    const { type, categories, series } = content.chart;
    elements.push({ id: "chart", type: "chart", x: geometry.marginX, y: top, w: width, h: bottom - top, chartType: type,
      categories: categories.map(singleLine), series: series.map(item => ({ ...item, name: singleLine(item.name) })) });
  } else if (content.layout === "kpi" && content.metrics?.length) {
    // 指标卡：等分列，大数字在上、标签在下、可选备注。数值宽度按列宽自适应缩字。
    const metrics = content.metrics.slice(0, 4);
    const columns = metrics.length, gap = geometry.gap;
    const w = (width - gap * (columns - 1)) / columns, h = bottom - top;
    metrics.forEach((metric, index) => {
      const x = geometry.marginX + index * (w + gap);
      shape(`kpi-${index}`, { x, y: top, w, h }, panel, geometry.panelShape === "roundRect");
      add(`kpi-value-${index}`, metric.value, { x: x + 0.18, y: top + 0.38, w: w - 0.36, h: 1.42 },
        Math.round(typography.title * 1.4), Math.round(typography.title * 0.9), accent, true);
      add(`kpi-label-${index}`, metric.label, { x: x + 0.18, y: top + 1.86, w: w - 0.36, h: 0.62 },
        typography.cardTitle, 13, panelInk, true);
      if (metric.note) add(`kpi-note-${index}`, metric.note, { x: x + 0.18, y: top + 2.52, w: w - 0.36, h: 0.86 },
        typography.cardItem - 3, 12, panelInk);
    });
  } else if (content.layout === "timeline" && content.steps?.length) {
    // 时间轴：一条水平主轴 + 等距节点，标题在轴上方、说明在轴下方。
    const steps = content.steps.slice(0, 6);
    const columns = steps.length, gap = geometry.gap * 0.6;
    const w = (width - gap * (columns - 1)) / columns;
    const axisY = top + (bottom - top) * 0.42;
    shape("timeline-axis", { x: geometry.marginX, y: axisY, w: width, h: 0.035 }, accent);
    steps.forEach((step, index) => {
      const x = geometry.marginX + index * (w + gap);
      const center = x + w / 2;
      shape(`timeline-node-${index}`, { x: center - 0.11, y: axisY - 0.095, w: 0.22, h: 0.22 }, accent, true);
      add(`timeline-index-${index}`, String(index + 1).padStart(2, "0"),
        { x, y: top, w, h: axisY - top - 0.42 }, typography.small + 3, typography.small, accent, true);
      add(`timeline-title-${index}`, step.title, { x, y: axisY - 0.62, w, h: 0.52 },
        typography.cardTitle, 13, ink, true);
      if (step.detail) add(`timeline-detail-${index}`, step.detail,
        { x, y: axisY + 0.28, w, h: Math.max(0.6, bottom - axisY - 0.32) }, typography.cardItem - 2, 12, ink);
    });
  } else if (content.layout === "quote" && content.quote) {
    // 引文页：左侧竖条 + 大字结论 + 出处，故意留白，不用面板。
    const blockWidth = Math.min(width, 10.6);
    shape("quote-bar", { x: geometry.marginX, y: top + 0.2, w: 0.1, h: Math.min(2.4, bottom - top - 0.4) }, accent);
    add("quote-text", content.quote.text, { x: geometry.marginX + 0.42, y: top + 0.2, w: blockWidth - 0.42, h: Math.min(3.2, bottom - top - 0.9) },
      Math.round(typography.title * 1.1), typography.takeaway, ink, true);
    if (content.quote.source) add("quote-source", `—— ${content.quote.source}`,
      { x: geometry.marginX + 0.42, y: bottom - 0.9, w: blockWidth - 0.42, h: 0.5 }, typography.small + 2, typography.small, ink);
  } else if (["cards", "comparison", "process"].includes(content.layout) && groups.length) {
    const columns = content.layout === "process" ? groups.length : 2;
    const gap = geometry.gap, rows = Math.ceil(groups.length / columns);
    const w = (width - gap * (columns - 1)) / columns;
    const h = (bottom - top - gap * (rows - 1)) / rows;
    groups.forEach((group, index) => {
      const x = geometry.marginX + (index % columns) * (w + gap);
      const y = top + Math.floor(index / columns) * (h + gap);
      const heading = content.layout === "process" ? `${index + 1}  ${group.title}` : group.title;
      shape(`panel-${index}`, { x, y, w, h }, panel, geometry.panelShape === "roundRect");
      add(`heading-${index}`, heading, { x: x + 0.22, y: y + 0.16, w: w - 0.44, h: 0.52 }, typography.cardTitle, 14, panelInk, true);
      const rowH = (h - 0.94) / group.items.length;
      group.items.forEach((value, row) => add(`item-${index}-${row}`, value,
        { x: x + 0.22, y: y + 0.78 + row * rowH, w: w - 0.44, h: rowH - 0.035 }, typography.cardItem, 13, panelInk));
    });
    // 两栏对比与两栏卡片版式名不同，但不能长得一模一样：
    // 加一条中缝，几何签名随之区分，避免「换名不换布局」。
    if (content.layout === "comparison" && columns === 2 && rows === 1) {
      const center = geometry.marginX + w + gap / 2;
      shape("comparison-divider", { x: center - 0.01, y: top + 0.1, w: 0.02, h: h - 0.2 }, accent);
    }
  } else {
    if (media !== undefined) picture(media);
    const columnWidth = media === undefined ? geometry.bulletWidth : geometry.bulletWidthWithMedia;
    const rows = Math.max(1, body.length);
    const available = bottom - top;
    // 行高上限（rowCap）是为了密度好看，不是容量真理：条目少、纵向还有余量时，
    // 按内容真实需要分配行高，比压字号或截字更保内容（约束内重排）。
    const fair = Math.min(geometry.rowCap, available / rows);
    const needed = body.reduce((max, value) => Math.max(max, measureHeight(value, typography.bodyMin, { w: columnWidth, h: available })), 0);
    const rowH = Math.min(available / rows, Math.max(fair, needed + 0.045));
    if (rowH > fair + 0.0001) {
      capacity.reflowed.push({ slot: "bullets", mode: "row_height", detail: `行高由 ${fair.toFixed(2)} 放宽到 ${rowH.toFixed(2)} 英寸以容纳正文` });
    }
    body.forEach((value, index) => {
      const y = top + index * rowH;
      shape(`marker-${index}`, { x: geometry.markerX, y: y + rowH / 2 - geometry.markerHeight / 2, w: geometry.markerWidth, h: geometry.markerHeight }, accent);
      add(`item-${index}`, value, { x: geometry.bulletX, y, w: columnWidth, h: rowH - 0.045 }, typography.body, typography.bodyMin);
    });
  }
  if (body.length && !elements.some(item => item.id === "item-0")) moved.push(...body);
  if (status) add("page-status", status, { x: geometry.marginX, y: 6.96, w: 2, h: 0.29 }, typography.small, typography.small, ink, true);
  if (moved.length) add("overflow-note", "补充内容见演讲备注", { x: 3.3, y: 6.96, w: 5.2, h: 0.29 }, typography.small, typography.small);
  add("page-number", String(content.page).padStart(2, "0"), { x: 12.1, y: 6.96, w: 0.46, h: 0.29 }, typography.small, 12, ink, true);
  validateElements(elements);
  capacity.ok = capacity.truncated.length === 0;
  const notes = xmlText([content.notes, moved.length ? `页面补充\n${moved.join("\n")}` : "", sourceNotes].filter(Boolean).join("\n\n"));
  return { slide: { title: xmlText(content.title), subtitle: xmlText(content.takeaway ?? ""), layout: "content", background: paper, lines: [], sourceIds, notes, elements }, overflow: moved.length > 0, capacity };
}

export function renderTemplateCover(title: string, subtitle: string, design: PresentationDesign, imageIndex?: number, theme: ThemeTokens = DEFAULT_THEME): Slide {
  const background = design.background ?? theme.colors.coverBackground;
  const color = presentationInk(background, design.text ?? theme.colors.ink ?? "FFFFFF");
  const fontFace = design.fontFace ?? theme.typography.fontFace;
  const accent = design.accent ?? theme.colors.coverAccent;
  const width = imageIndex === undefined ? 11.5 : 5.6;
  const coverTitle = imageIndex === undefined ? theme.typography.coverTitle : Math.round(theme.typography.coverTitle * (title.length > 42 ? 0.75 : 0.94));
  const elements: PresentationElement[] = [
    { id: "cover-rule", type: "shape", shape: "rect", x: 0.9, y: theme.cover.ruleY, w: theme.cover.ruleWidth, h: theme.cover.ruleHeight, fill: accent },
    { id: "cover-title", type: "text", x: 0.9, y: theme.cover.titleY, w: width, h: theme.cover.titleHeight, text: singleLine(title), style: { color, fontSize: coverTitle, bold: true, valign: "middle", fontFace } },
  ];
  if (subtitle) elements.push({ id: "cover-subtitle", type: "text", x: 0.9, y: theme.cover.subtitleY, w: width, h: theme.cover.subtitleHeight, text: singleLine(subtitle), style: { color, fontSize: theme.typography.takeaway - 2, fontFace } });
  if (imageIndex !== undefined) elements.push({ id: "cover-image", type: "image", x: 6.9, y: 0.75, w: 5.6, h: 6, imageIndex, fit: "contain" });
  return { layout: "cover", title: singleLine(title), subtitle: singleLine(subtitle), lines: [], notes: "", background, elements };
}

/** Reserve a column for explicit page assignments while keeping existing elements editable. */
export function placePresentationImages(plan: AiPresentation, placements: Array<{ page: number; imageIndex: number }>): AiPresentation {
  if (!placements.length) return plan;
  const byPage = new Map<number, number[]>();
  for (const { page, imageIndex } of placements) {
    if (page > plan.slides.length) throw new Error(`PPT 共 ${plan.slides.length} 页，无法在第 ${page} 页放置图片`);
    const items = byPage.get(page) ?? [];
    items.push(imageIndex);
    byPage.set(page, items);
  }
  return { ...plan, slides: plan.slides.map((slide, index) => {
    const images = byPage.get(index + 1);
    if (!images) return slide;
    const design = { ...plan.design, ...(slide.background ? { background: slide.background } : {}) };
    const existing = resolveElements(slide);
    const base = existing ? slide : slide.layout === "cover" || slide.layout === "section"
      ? { ...slide, ...renderTemplateCover(slide.title, slide.subtitle, design), notes: slide.notes, sourceIds: slide.sourceIds }
      : renderContentSlide({ page: index + 1, title: slide.title, takeaway: slide.subtitle, layout: "bullets", bullets: slide.lines },
        design, slide.sourceIds ?? [], slide.notes, undefined, slide.imageIndex).slide;
    const scale = 0.63;
    const elements: PresentationElement[] = (existing ?? base.elements!).map(element => {
      if (element.type === "connector") return element;
      const frame = { ...element, x: element.x * scale, w: element.w * scale };
      if (element.type !== "text") return frame;
      return { ...element, x: frame.x, w: frame.w, style: { ...element.style, fontSize: Math.max(12, Math.round((element.style?.fontSize ?? 18) * scale)) } };
    });
    const columns = images.length > 3 ? 2 : 1, rows = Math.ceil(images.length / columns);
    const x = 8.65, y = 1.12, width = 4.05, height = PAGE_HEIGHT - y - 0.72, gap = 0.12;
    const w = (width - gap * (columns - 1)) / columns, h = (height - gap * (rows - 1)) / rows;
    const ids = new Set(elements.map(element => element.id));
    images.forEach((imageIndex, image) => {
      let id = `page-photo-${imageIndex}`;
      while (ids.has(id)) id += "_";
      ids.add(id);
      elements.push({ type: "image", id, imageIndex, fit: "contain", x: x + (image % columns) * (w + gap),
        y: y + Math.floor(image / columns) * (h + gap), w, h });
    });
    validateElements(elements);
    return { ...base, box: undefined, elements };
  }) };
}
