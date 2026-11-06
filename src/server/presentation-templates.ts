import { z } from "zod";
import type { AiPresentation } from "./mind-document.js";
import { PAGE_HEIGHT, layoutIssues, resolveElements, validateElements, type PresentationDesign, type PresentationElement } from "./presentation-elements.js";
import { presentationInk, presentationPanel } from "./presentation-palette.js";

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
  status?: "精简页" | "待补全", imageIndex?: number,
): { slide: Slide; overflow: boolean } {
  const elements: PresentationElement[] = [];
  const moved: string[] = [];
  const paper = design.background ?? "F8FAFC", panel = presentationPanel(paper);
  const ink = presentationInk(paper, design.text), panelInk = presentationInk(panel, design.text);
  const accent = design.accent ?? "286D9C";
  const add = (id: string, value: string | undefined, rect: Rect, size: number, min: number, color = ink, bold = false) => {
    if (!value) return;
    const item: Text = { type: "text", id, ...rect, text: xmlText(value), style: { fontSize: size, color, bold, margin: 0, valign: "middle" } };
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
  shape("accent-rule", { x: 0.76, y: 0.45, w: 0.48, h: 0.055 }, accent);
  add("title", content.title, { x: 0.76, y: 0.62, w: 11.8, h: 1.08 }, 32, 20, ink, true);
  add("takeaway", content.takeaway, { x: 0.76, y: 1.76, w: 11.8, h: 0.76 }, 19, 15, ink);
  const top = content.takeaway ? 2.78 : 2.05, bottom = 6.78, width = 11.8;
  const body = content.bullets ?? [];
  const groups = content.groups ?? [];
  const media = content.imageIndex ?? imageIndex;
  const picture = (index: number) => elements.push({
    type: "image", id: "picture", x: 6.58, y: top, w: 5.98, h: bottom - top, imageIndex: index, fit: "contain",
  });
  if (content.layout === "table" && content.table) {
    const columns = content.table[0]!.length;
    const cellCapacity = Math.floor((width / columns - 0.18) * 72 / 13);
    const rows = content.table.map(row => row.map(cell => {
      const flat = singleLine(cell);
      if (Array.from(flat).length <= cellCapacity) return flat;
      moved.push(flat);
      return Array.from(flat).slice(0, cellCapacity - 1).join("") + "…";
    }));
    elements.push({ id: "table", type: "table", x: 0.76, y: top, w: width, h: bottom - top, rows, header: true, fontSize: 13 });
  } else if (content.layout === "chart" && content.chart) {
    const { type, categories, series } = content.chart;
    elements.push({ id: "chart", type: "chart", x: 0.76, y: top, w: width, h: bottom - top, chartType: type,
      categories: categories.map(singleLine), series: series.map(item => ({ ...item, name: singleLine(item.name) })) });
  } else if (["cards", "comparison", "process"].includes(content.layout) && groups.length) {
    const columns = content.layout === "process" ? groups.length : 2;
    const gap = 0.24, rows = Math.ceil(groups.length / columns);
    const w = (width - gap * (columns - 1)) / columns;
    const h = (bottom - top - gap * (rows - 1)) / rows;
    groups.forEach((group, index) => {
      const x = 0.76 + (index % columns) * (w + gap);
      const y = top + Math.floor(index / columns) * (h + gap);
      const heading = content.layout === "process" ? `${index + 1}  ${group.title}` : group.title;
      shape(`panel-${index}`, { x, y, w, h }, panel, true);
      add(`heading-${index}`, heading, { x: x + 0.22, y: y + 0.16, w: w - 0.44, h: 0.52 }, 20, 14, panelInk, true);
      const rowH = (h - 0.94) / group.items.length;
      group.items.forEach((value, row) => add(`item-${index}-${row}`, value,
        { x: x + 0.22, y: y + 0.78 + row * rowH, w: w - 0.44, h: rowH - 0.035 }, 17, 13, panelInk));
    });
  } else {
    if (media !== undefined) picture(media);
    const rowH = Math.min(1.15, (bottom - top) / Math.max(1, body.length));
    body.forEach((value, index) => {
      const y = top + index * rowH;
      shape(`marker-${index}`, { x: 0.81, y: y + rowH / 2 - 0.025, w: 0.12, h: 0.05 }, accent);
      add(`item-${index}`, value, { x: 1.06, y, w: media === undefined ? 11.5 : 5.13, h: rowH - 0.045 }, 21, 15);
    });
  }
  if (body.length && !elements.some(item => item.id === "item-0")) moved.push(...body);
  if (status) add("page-status", status, { x: 0.76, y: 6.96, w: 2, h: 0.29 }, 13, 13, ink, true);
  if (moved.length) add("overflow-note", "补充内容见演讲备注", { x: 3.3, y: 6.96, w: 5.2, h: 0.29 }, 13, 13);
  add("page-number", String(content.page).padStart(2, "0"), { x: 12.1, y: 6.96, w: 0.46, h: 0.29 }, 13, 12, ink, true);
  validateElements(elements);
  const notes = xmlText([content.notes, moved.length ? `页面补充\n${moved.join("\n")}` : "", sourceNotes].filter(Boolean).join("\n\n"));
  return { slide: { title: xmlText(content.title), subtitle: xmlText(content.takeaway ?? ""), layout: "content", background: paper, lines: [], sourceIds, notes, elements }, overflow: moved.length > 0 };
}

export function renderTemplateCover(title: string, subtitle: string, design: PresentationDesign, imageIndex?: number): Slide {
  const background = design.background ?? "142A43", color = presentationInk(background, design.text);
  const width = imageIndex === undefined ? 11.5 : 5.6;
  const elements: PresentationElement[] = [
    { id: "cover-rule", type: "shape", shape: "rect", x: 0.9, y: 1.52, w: 0.62, h: 0.06, fill: design.accent ?? "6EA9C7" },
    { id: "cover-title", type: "text", x: 0.9, y: 1.78, w: width, h: 2.08, text: singleLine(title), style: { color, fontSize: imageIndex === undefined ? 32 : title.length > 42 ? 24 : 30, bold: true, valign: "middle" } },
  ];
  if (subtitle) elements.push({ id: "cover-subtitle", type: "text", x: 0.9, y: 4.12, w: width, h: 1.75, text: singleLine(subtitle), style: { color, fontSize: 17 } });
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
