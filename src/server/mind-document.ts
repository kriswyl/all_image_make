import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import pptxgen from "pptxgenjs";
import { z } from "zod";
import { AppError } from "./tasks.js";
import { presentationInk } from "./presentation-palette.js";
import { designSchema, elementSchema, slideBoxSchema, resolveElements, validateElements, renderElements, MAX_SLIDES, MAX_LEGACY_LINES, type PresentationElement, type ElementSlide } from "./presentation-elements.js";

export type DocumentNode = { title: string; notes: string; children: DocumentNode[]; id?: string; image?: string; imageDescription?: string };
export type MindDocument = { format: "xmind"; sheets: DocumentNode[]; warnings: string[]; relationships?: Array<{ from: string; to: string; title: string; fromTitle: string; toTitle: string }> };
export type SlidePlan = { title: string; lines: string[]; notes: string; layout?: AiPresentation["slides"][number]["layout"]; subtitle?: string; background?: string; elements?: PresentationElement[]; box?: ElementSlide["box"] };
const LIMIT = 4_000_000;
function list(value: unknown): any[] { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function scalar(value: unknown): string { if (typeof value === "string" || typeof value === "number") return String(value); if (value && typeof value === "object") return scalar((value as any)["#text"]); return ""; }
function node(input: any, depth: number, count: { value: number }, xml: boolean): DocumentNode {
  if (depth > 30 || ++count.value > 1500) throw new AppError("DOCUMENT_TOO_COMPLEX", "思维导图超过节点或层级限制", 400);
  const title = scalar(input?.title).trim() || "未命名主题";
  const notes = xml ? scalar(input?.notes?.plain).trim() : scalar(input?.notes?.plain?.content ?? input?.notes?.plain).trim();
  // XMind 的子节点分好几组：attached（常规）、detached（游离主题）、summary（概要）。
  // 概要里的内容是真实内容——只读 attached 会整棵子树丢掉（曾把 275 个节点读成 22 个）。
  const children = xml
    ? [
        ...list(input?.children?.topics).flatMap((group) => list(group?.topic)),
        ...list(input?.children?.summaries).flatMap((group) => list(group?.summary ?? group?.topic)),
      ]
    : ["attached", "detached", "summary", "callout"].flatMap((key) => list((input?.children ?? {})[key]));
  const id = scalar(input?.id ?? input?.['@_id']);
  const image = scalar(input?.image?.src ?? input?.image?.['@_src'] ?? input?.['xhtml:img']?.['@_xlink:href']);
  return { title, notes, children: children.map((child) => node(child, depth + 1, count, xml)), ...(id ? { id } : {}), ...(image ? { image } : {}) };
}
export async function parseXmind(bytes: Buffer): Promise<MindDocument> {
  let zip: JSZip;
  try { zip = await JSZip.loadAsync(bytes); } catch { throw new AppError("DOCUMENT_INVALID", "无法读取 XMind 文件，请检查文件是否损坏", 400); }
  const entries = Object.values(zip.files);
  if (entries.length > 3000) throw new AppError("DOCUMENT_TOO_COMPLEX", "文件包含过多内容", 400);
  const file = zip.file("content.json") ?? zip.file("content.xml");
  if (!file) throw new AppError("DOCUMENT_UNSUPPORTED", "未找到 XMind 内容；请使用 XMind 格式文件", 400);
  const compressed = (file as any)._data;
  if (!Number.isFinite(compressed?.uncompressedSize) || compressed.uncompressedSize > LIMIT) throw new AppError("DOCUMENT_TOO_LARGE", "思维导图内容过大", 400);
  let value: any;
  try { const content = await file.async("string"); value = file.name.endsWith(".json") ? JSON.parse(content) : new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", processEntities: false }).parse(content); }
  catch { throw new AppError("DOCUMENT_INVALID", "思维导图内容无法解析", 400); }
  const xml = file.name.endsWith(".xml");
  const rawSheets = xml ? list(value?.['xmap-content']?.sheet) : list(value);
  const count = { value: 0 };
  const sheets = rawSheets.map((sheet) => sheet?.rootTopic ?? sheet?.topic).filter(Boolean).map((root) => node(root, 0, count, xml));
  if (!sheets.length) throw new AppError("DOCUMENT_EMPTY", "没有找到思维导图主题", 400);
  const warnings = ["原有布局、标记和附件不导出；关联关系按文字说明重组，图片支持情况以转换结果为准。"];
  const features = { images: false, attachments: false, relationships: false };
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (!item || typeof item !== "object") continue;
    if (Array.isArray(item)) { for (const child of item) pending.push(child); continue; }
    for (const [key, child] of Object.entries(item)) {
      const name = key.toLowerCase().replace(/^@_/, "");
      if ((name === "image" || name === "xhtml:img" || name === "img") && child) features.images = true;
      if ((name === "relationships" || name === "relationship") && child && (!Array.isArray(child) || child.length > 0)) features.relationships = true;
      if ((name === "attachment" || name === "attachments") && child) features.attachments = true;
      if ((name === "href" || name === "xlink:href") && typeof child === "string" && /^(?:xap:)?attachments\//i.test(child)) features.attachments = true;
      if (child && typeof child === "object") pending.push(child);
    }
  }
  for (const entry of entries) {
    if (!entry.dir && /^(?:attachments|resources)\//i.test(entry.name)) {
      if (/\.(?:png|jpe?g|gif|webp|svg|bmp)$/i.test(entry.name)) features.images = true;
      else features.attachments = true;
    }
  }
  const relationships: NonNullable<MindDocument['relationships']> = [];
  let unresolved = false;
  rawSheets.forEach((sheet, index) => {
    const ids = new Map<string, string>();
    const walk = (item: DocumentNode) => { if (item.id) ids.set(item.id, item.title); item.children.forEach(walk); };
    if (sheets[index]) walk(sheets[index]!);
    const entries = xml ? list(sheet?.relationships?.relationship) : list(sheet?.relationships);
    for (const rel of entries) {
      const from = scalar(rel?.end1Id ?? rel?.['@_end1']); const to = scalar(rel?.end2Id ?? rel?.['@_end2']);
      const fromTitle = ids.get(from), toTitle = ids.get(to);
      if (!fromTitle || !toTitle) { unresolved = true; continue; }
      relationships.push({ from, to, fromTitle, toTitle, title: scalar(rel?.title).trim() });
    }
  });
  if (features.images) warnings.push("检测到图片；部分图片可能无法读取或导出。");
  if (features.attachments) warnings.push("检测到附件；当前不会读取或导出附件。");
  if (features.relationships && unresolved) warnings.push("检测到主题间关系线，部分端点无法解析，未导出。");
  return { format: "xmind", sheets, warnings, ...(relationships.length ? { relationships } : {}) };
}

/** Extract only explicitly referenced local raster images; never follow external links. */
export type MindImage = { title: string; data: string; sourceId: string };
export async function extractMindImages(bytes: Buffer, mind: MindDocument): Promise<{ images: MindImage[]; skipped: number }> {
  const refs: Array<{ title: string; src: string; sourceId: string }> = [];
  const visit = (node: DocumentNode, sourceId: string) => { if (node.image) refs.push({ title: node.title, src: node.image, sourceId }); node.children.forEach((child, index) => visit(child, `${sourceId}-${index + 1}`)); };
  mind.sheets.forEach((root, index) => visit(root, `s${index + 1}`));
  if (!refs.length) return { images: [], skipped: 0 };
  const zip = await JSZip.loadAsync(bytes);
  const images: MindImage[] = [];
  let skipped = 0, total = 0;
  for (const ref of refs) {
    const name = ref.src.replace(/^xap:/i, "");
    if (!/^(?:resources|attachments)\/[a-zA-Z0-9_./ -]+$/.test(name) || name.split("/").includes("..") || images.length >= 30) { skipped++; continue; }
    const entry = zip.file(name); const length = (entry as any)?._data?.uncompressedSize;
    if (!entry || !Number.isSafeInteger(length) || length <= 0 || length > 5 * 1024 * 1024 || total + length > 20 * 1024 * 1024) { skipped++; continue; }
    const data = await entry.async("nodebuffer");
    const png = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    if (!png && !jpeg) { skipped++; continue; }
    total += data.length;
    images.push({ title: ref.title, sourceId: ref.sourceId, data: `image/${png ? "png" : "jpeg"};base64,${data.toString("base64")}` });
  }
  return { images, skipped };
}
export function planMindSlides(doc: MindDocument): SlidePlan[] {
  const slides: SlidePlan[] = [];
  const wrap = (line: string) => line.replace(/\s*\n\s*/g, " ").match(/.{1,45}/gu) ?? [""];
  for (const root of doc.sheets) {
    slides.push({ title: root.title, lines: [], notes: root.notes });
    for (const section of root.children) {
      const lines: string[] = [];
      const notes: string[] = [];
      const walk = (item: DocumentNode, depth: number) => {
        lines.push(...wrap(`${depth > 0 ? `${"  ".repeat(Math.min(depth, 4))}· ` : ""}${item.title}`));
        if (item.notes) notes.push(`${item.title}：${item.notes}`);
        item.children.forEach((child) => walk(child, depth + 1));
      };
      section.children.forEach((child) => walk(child, 0));
      const chunks = lines.length ? Array.from({ length: Math.ceil(lines.length / 7) }, (_, i) => lines.slice(i * 7, i * 7 + 7)) : [[]];
      chunks.forEach((chunk, index) => slides.push({ title: `${section.title}${index ? `（${index + 1}）` : ""}`, lines: chunk, notes: [section.notes, ...notes].filter(Boolean).join("\n") }));
    }
  }
  if (slides.length > 200) throw new AppError("DOCUMENT_TOO_COMPLEX", "转换结果超过 200 页，请精简导图", 400);
  return slides;
}
export async function renderMindPptx(slides: SlidePlan[], images: Array<{ title: string; data: string }> = []): Promise<Buffer> {
  // Adapt saved legacy plans without truncating their visible text. Both entry points now share one renderer.
  for (const slide of slides) if (slide.elements || slide.box) resolveElements(slide);
  return renderAiPresentation({ title: slides[0]?.title.slice(0, 80) || "演示文稿", theme: "ink", slides: slides.map((item, index) => ({
    ...item, layout: item.layout ?? (index === 0 && !item.lines.length ? "cover" : "content"), title: item.title.slice(0, 70), subtitle: item.subtitle ?? "", lines: [],
    ...(item.elements || item.box ? {} : { elements: [
      { id: "title", type: "text" as const, x: 0.8, y: index === 0 && !item.lines.length ? 2.4 : 0.55, w: 11.7, h: 1.2, text: item.title, style: { fontSize: index === 0 && !item.lines.length ? 34 : 28, bold: true, color: "243443" } },
      ...item.lines.map((line, i) => ({ id: `body-${i}`, type: "text" as const, x: 0.9, y: 1.95 + i * (4.8 / Math.max(1, item.lines.length)), w: 11.5, h: 4.6 / Math.max(1, item.lines.length), text: line || " ", style: { fontSize: 18 } })),
    ], background: "FAFAF8" }),
  })) }, images);
}


/** AI 提出的内容方案，字段受限以保证每页可读且可编辑。 */
export const aiPresentationSchema = z.object({
  title: z.string().trim().min(1).max(80),
  theme: z.enum(["ink", "blue"]).default("ink"),
  slides: z.array(z.object({
    layout: z.enum(["cover", "section", "content", "columns", "cards", "process", "comparison", "keypoint", "illustrated", "image"]).default("content"),
    title: z.string().trim().min(1).max(70),
    subtitle: z.string().trim().max(140).default(""),
    lines: z.array(z.string().trim().min(1).max(70)).max(MAX_LEGACY_LINES).default([]),
    notes: z.string().max(60000).default(""),
    imageIndex: z.number().int().min(0).optional(),
    sourceIds: z.array(z.string()).optional(),
    elements: z.array(elementSchema).min(1).max(160).optional(),
    box: slideBoxSchema.optional(),
    background: z.string().regex(/^[0-9a-fA-F]{6}$/).optional(),
  })).min(1).max(MAX_SLIDES),
  design: designSchema.optional(),
});
export type AiPresentation = z.infer<typeof aiPresentationSchema>;

/** 生成原生文本框，不将内容压成不可编辑的整页图片。 */
export async function renderAiPresentation(plan: AiPresentation, images: Array<{ title: string; data: string }> = []): Promise<Buffer> {
  plan = aiPresentationSchema.parse(plan);
  const ppt = new (pptxgen as unknown as { new(): InstanceType<typeof import("pptxgenjs").default> })();
  ppt.layout = "LAYOUT_WIDE"; ppt.author = "ChatCanvas"; ppt.subject = plan.title;
  const dark = plan.theme === "blue" ? "142A43" : "1C232B";
  const accent = plan.design?.accent ?? (plan.theme === "blue" ? "286D9C" : "2A716B");
  const font = plan.design?.fontFace ?? "Microsoft YaHei";
  plan.slides.forEach((item, index) => {
    const slide = ppt.addSlide();
    const isDark = item.layout === "cover" || item.layout === "section";
    const elements = resolveElements(item);
    slide.background = { color: item.background ?? (isDark && !elements ? dark : plan.design?.background ?? "FAFAF8") };
    if (elements) {
      validateElements(elements, images.length);
      renderElements(ppt, slide, elements, images, { text: dark, accent, ...plan.design, background: slide.background.color });
    } else if (isDark) {
      slide.addText(item.title, { x: 0.9, y: 2.2, w: 11.4, h: 1.35, fontFace: font, fontSize: item.layout === "cover" ? 36 : 32, bold: true, color: "FFFFFF", valign: "middle", margin: 0, fit: "shrink" });
      if (item.subtitle) slide.addText(item.subtitle, { x: 0.92, y: 3.85, w: 11.45, h: 1.0, fontFace: font, fontSize: item.subtitle.length > 45 ? 16 : 20, color: "D1DEE1", margin: 0, valign: "top", fit: "shrink" });
    } else if (item.layout === "illustrated") {
      const image = item.imageIndex === undefined ? undefined : images[item.imageIndex];
      if (!image) throw new Error("PPT 图片素材缺失");
      slide.addText(item.title, { x: 0.8, y: 0.45, w: 11.7, h: 0.9, fontFace: font, fontSize: 26, bold: true, color: dark, margin: 0, fit: "shrink" });
      if (item.subtitle) slide.addText(item.subtitle, { x: 0.8, y: 1.45, w: 11.7, h: 0.55, fontFace: font, fontSize: 17, color: accent, margin: 0, fit: "shrink" });
      const y = item.subtitle ? 2.25 : 1.7;
      item.lines.forEach((line, i) => slide.addText(line, { x: 0.9, y: y + i * 1.05, w: 5.25, h: 0.9, fontFace: font, fontSize: 18, color: dark, margin: 0, fit: "shrink", valign: "middle" }));
      slide.addImage({ data: image.data, x: 6.6, y, w: 5.75, h: 4.5, sizing: { type: "contain", w: 5.75, h: 4.5 } });
    } else if (item.layout === "image") {
      const image = item.imageIndex === undefined ? undefined : images[item.imageIndex];
      if (!image) throw new Error("PPT 图片素材缺失");
      slide.addText(item.title, { x: 0.8, y: 0.45, w: 11.7, h: 0.8, fontFace: font, fontSize: 26, bold: true, color: dark, margin: 0, fit: "shrink" });
      slide.addImage({ data: image.data, x: 0.8, y: 1.45, w: 11.7, h: 5.3, sizing: { type: "contain", w: 11.7, h: 5.3 } });
    } else {
      slide.addText(item.title, { x: 0.8, y: 0.55, w: 11.7, h: 1.15, fontFace: font, fontSize: item.title.length > 36 ? 24 : 29, bold: true, color: dark, margin: 0, valign: "middle", fit: "shrink" });
      if (item.subtitle) slide.addText(item.subtitle, { x: 0.82, y: 1.8, w: 11.2, h: 0.55, fontFace: font, fontSize: 17, color: accent, margin: 0, valign: "middle", fit: "shrink" });
      const top = item.subtitle ? 2.55 : 1.95;
      if (item.layout === "comparison") {
        const groups = [item.lines.slice(0, Math.ceil(item.lines.length / 2)), item.lines.slice(Math.ceil(item.lines.length / 2))];
        groups.forEach((lines, group) => {
          const x = 0.9 + group * 5.85;
          slide.addShape(ppt.ShapeType.roundRect, { x, y: top, w: 5.6, h: 4.2, rectRadius: 0.12, line: { color: "DFE8E7", width: 1 }, fill: { color: group ? "F0F6F5" : "FFFFFF" } });
          lines.forEach((line, i) => slide.addText(line, { x: x + 0.3, y: top + 0.32 + i * 1.05, w: 5, h: 0.78, fontFace: font, fontSize: i === 0 ? 20 : 17, bold: i === 0, color: i === 0 ? accent : "313C45", margin: 0, valign: "middle", fit: "shrink" }));
        });
      } else if (item.layout === "keypoint") {
        item.lines.forEach((line, i) => slide.addText(line, { x: 1.15, y: top + i * 0.95, w: 10.9, h: 0.8, fontFace: font, fontSize: i === 0 ? 27 : 19, bold: i === 0, color: i === 0 ? accent : "313C45", margin: 0, valign: "middle", fit: "shrink" }));
      } else if (item.layout === "cards" || item.layout === "process") {
        const columns = item.layout === "cards" ? 2 : 3;
        const gap = 0.22;
        const width = (11.45 - gap * (columns - 1)) / columns;
        const rowCount = Math.ceil(item.lines.length / columns);
        const height = Math.min(1.55, (6.75 - top - gap * Math.max(0, rowCount - 1)) / Math.max(1, rowCount));
        item.lines.forEach((line, i) => {
          const x = 0.9 + (i % columns) * (width + gap);
          const y = top + Math.floor(i / columns) * (height + gap);
          slide.addShape(ppt.ShapeType.roundRect, { x, y, w: width, h: height, rectRadius: 0.12, line: { color: "DFE8E7", width: 1 }, fill: { color: "FFFFFF" } });
          slide.addText(String(i + 1).padStart(2, "0"), { x: x + 0.22, y: y + 0.19, w: 0.45, h: 0.27, fontFace: font, fontSize: 12, bold: true, color: accent, margin: 0 });
          slide.addText(line, { x: x + 0.22, y: y + 0.56, w: width - 0.44, h: height - 0.7, fontFace: font, fontSize: 18, color: "313C45", margin: 0, valign: "middle", fit: "shrink", breakLine: false });
        });
      } else {
        const groups = item.layout === "columns" ? [item.lines.slice(0, Math.ceil(item.lines.length / 2)), item.lines.slice(Math.ceil(item.lines.length / 2))] : [item.lines];
        groups.forEach((lines, group) => lines.forEach((line, i) => {
          slide.addText(line, { x: item.layout === "columns" ? 0.9 + group * 6 : 0.95, y: top + i * 0.72, w: item.layout === "columns" ? 5.45 : 11.2, h: 0.58, fontFace: font, fontSize: 20, color: "313C45", margin: 0, valign: "middle", fit: "shrink" });
        }));
      }
    }
    const customPageNumber = elements?.some(element => {
      if (element.id === "page-number") return true;
      if (element.type !== "text" || element.x + element.w < 11.5 || element.y + element.h < 6.9) return false;
      const number = /^(?:第\s*)?(\d{1,3})(?:\s*(?:[/／]\s*\d{1,3}|页))?$/.exec(element.text.trim());
      return Number(number?.[1]) === index + 1;
    });
    if (!customPageNumber) {
      slide.addText(String(index + 1).padStart(2, "0"), { x: 12.05, y: 7.05, w: 0.45, h: 0.2, fontFace: font, fontSize: 10,
        color: presentationInk(slide.background.color ?? "FFFFFF", isDark ? "B7C5CC" : "7B8588"), align: "right", margin: 0 });
    }
    if (item.notes) slide.addNotes(item.notes);
  });
  return Buffer.from(await ppt.write({ outputType: "nodebuffer" }) as Buffer);
}
