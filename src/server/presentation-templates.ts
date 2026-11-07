import { z } from "zod";
import type { AiPresentation } from "./mind-document.js";
import { PAGE_HEIGHT, layoutIssues, resolveElements, validateElements, type PresentationDesign, type PresentationElement } from "./presentation-elements.js";
import { presentationInk, presentationPanel } from "./presentation-palette.js";
import { DEFAULT_THEME_ID, getTheme, type ThemeTokens } from "../shared/presentation-theme.js";

const DEFAULT_THEME = getTheme(DEFAULT_THEME_ID);

const line = z.string().trim().min(1).max(160);
export const slideContentSchema = z.object({
  page: z.number().int().positive(),
  title: z.string().trim().min(1).max(70),
  takeaway: z.string().trim().max(140).optional(),
  layout: z.enum(["bullets", "cards", "process", "comparison", "table", "chart", "image"]),
  bullets: z.array(line).max(6).optional(),
  groups: z.array(z.object({ title: z.string().trim().min(1).max(44), items: z.array(line).min(1).max(3) })).min(2).max(4).optional(),
  table: z.array(z.array(z.string().trim().max(80)).min(2).max(5)).min(2).max(7).optional(),
  chart: z.object({
    type: z.enum(["bar", "line", "pie"]),
    categories: z.array(z.string().trim().min(1).max(24)).min(2).max(8),
    series: z.array(z.object({ name: z.string().trim().min(1).max(32), values: z.array(z.number().finite()).min(2).max(8) })).min(1).max(3),
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
  const { layout, bullets, groups, table, chart, imageIndex } = content;
  if (imageIndex !== undefined && !images.includes(imageIndex)) return false;
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
): { slide: Slide; overflow: boolean } {
  const elements: PresentationElement[] = [];
  const moved: string[] = [];
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
    while (layoutIssues([item]).length && item.style!.fontSize! > min) item.style!.fontSize! -= 1;
    if (layoutIssues([item]).length) {
      moved.push(value);
      const chars = Array.from(item.text);
      let low = 0, high = chars.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        item.text = chars.slice(0, middle).join("").trimEnd() + "…";
        if (layoutIssues([item]).length) high = middle - 1;
        else low = middle;
      }
      item.text = chars.slice(0, low).join("").trimEnd() + "…";
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
      moved.push(flat);
      return Array.from(flat).slice(0, cellCapacity - 1).join("") + "…";
    }));
    elements.push({ id: "table", type: "table", x: geometry.marginX, y: top, w: width, h: bottom - top, rows, header: true, fontSize: typography.small });
  } else if (content.layout === "chart" && content.chart) {
    const { type, categories, series } = content.chart;
    elements.push({ id: "chart", type: "chart", x: geometry.marginX, y: top, w: width, h: bottom - top, chartType: type,
      categories: categories.map(singleLine), series: series.map(item => ({ ...item, name: singleLine(item.name) })) });
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
  } else {
    if (media !== undefined) picture(media);
    const rowH = Math.min(geometry.rowCap, (bottom - top) / Math.max(1, body.length));
    body.forEach((value, index) => {
      const y = top + index * rowH;
      shape(`marker-${index}`, { x: geometry.markerX, y: y + rowH / 2 - geometry.markerHeight / 2, w: geometry.markerWidth, h: geometry.markerHeight }, accent);
      add(`item-${index}`, value, { x: geometry.bulletX, y, w: media === undefined ? geometry.bulletWidth : geometry.bulletWidthWithMedia, h: rowH - 0.045 },
        typography.body, typography.bodyMin);
    });
  }
  if (body.length && !elements.some(item => item.id === "item-0")) moved.push(...body);
  if (status) add("page-status", status, { x: geometry.marginX, y: 6.96, w: 2, h: 0.29 }, typography.small, typography.small, ink, true);
  if (moved.length) add("overflow-note", "补充内容见演讲备注", { x: 3.3, y: 6.96, w: 5.2, h: 0.29 }, typography.small, typography.small);
  add("page-number", String(content.page).padStart(2, "0"), { x: 12.1, y: 6.96, w: 0.46, h: 0.29 }, typography.small, 12, ink, true);
  validateElements(elements);
  const notes = xmlText([content.notes, moved.length ? `页面补充\n${moved.join("\n")}` : "", sourceNotes].filter(Boolean).join("\n\n"));
  return { slide: { title: xmlText(content.title), subtitle: xmlText(content.takeaway ?? ""), layout: "content", background: paper, lines: [], sourceIds, notes, elements }, overflow: moved.length > 0 };
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
