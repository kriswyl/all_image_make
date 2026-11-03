import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import type { AiPresentation } from "./mind-document.js";

/** Conservative layout preflight: wrap long lines and split crowded slides before rendering. */
export function paginatePresentation(plan: AiPresentation): AiPresentation {
  const slides: AiPresentation["slides"] = [];
  for (const slide of plan.slides) {
    if (slide.layout === "cover" || slide.layout === "section") { slides.push(slide); continue; }
    // Keep paired comparison groups intact; splitting individual lines would mix the two sides.
    if (slide.layout === "comparison") { slides.push(slide); continue; }
    const maxChars = slide.layout === "process" ? 18 : slide.layout === "cards" || slide.layout === "columns" ? 26 : 42;
    const lines = slide.lines.flatMap((line) => {
      const chars = Array.from(line);
      const chunks: string[] = [];
      for (let offset = 0; offset < chars.length; offset += maxChars) chunks.push(chars.slice(offset, offset + maxChars).join(""));
      return chunks;
    });
    const perPage = slide.layout === "keypoint" ? 5 : 6;
    for (let offset = 0; offset < lines.length; offset += perPage) {
      const page = Math.floor(offset / perPage);
      const suffix = page ? `（${page + 1}）` : "";
      slides.push({ ...slide, title: `${slide.title.slice(0, 70 - suffix.length)}${suffix}`, lines: lines.slice(offset, offset + perPage), notes: page ? "" : slide.notes });
    }
  }
  if (slides.length > 200) throw new Error("排版后超过 200 页，请分章节转换；没有生成文件。");
  return { ...plan, slides };
}

/** Inspect the generated PPTX, rather than assuming serialization preserved the planned content. */
export async function checkPresentation(bytes: Buffer, plan: AiPresentation): Promise<void> {
  let archive: JSZip;
  try { archive = await JSZip.loadAsync(bytes); } catch { throw new Error("生成的 PPT 文件无法打开"); }
  const slides = Object.keys(archive.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  if (slides.length !== plan.slides.length) throw new Error("生成的 PPT 页数与方案不一致");
  const parser = new XMLParser({ ignoreAttributes: false, processEntities: true, parseTagValue: false });
  for (const [index, slide] of plan.slides.entries()) {
    const file = archive.file(`ppt/slides/slide${index + 1}.xml`);
    if (!file) throw new Error(`第 ${index + 1} 页缺失`);
    let data: unknown;
    try { data = parser.parse(await file.async("string")); } catch { throw new Error(`第 ${index + 1} 页内容损坏`); }
    const text: string[] = []; const pending: unknown[] = [data];
    while (pending.length) {
      const item = pending.pop();
      if (!item || typeof item !== "object") continue;
      if (Array.isArray(item)) { for (const value of item) pending.push(value); continue; }
      for (const [key, value] of Object.entries(item)) {
        if (key === "a:t" && (typeof value === "string" || typeof value === "number")) text.push(String(value));
        else if (value && typeof value === "object") pending.push(value);
        if (key === "a:xfrm" && value && typeof value === "object" && !Array.isArray(value)) {
          const transform = value as Record<string, unknown>;
          const offset = transform["a:off"] as Record<string, unknown> | undefined;
          const extent = transform["a:ext"] as Record<string, unknown> | undefined;
          if (offset && extent && !("a:chOff" in transform)) {
            const [x, y, width, height] = [offset["@_x"], offset["@_y"], extent["@_cx"], extent["@_cy"]].map(Number);
            if (![x, y, width, height].every(Number.isFinite) || x! < 0 || y! < 0 || width! <= 0 || height! <= 0 || x! + width! > 12_192_050 || y! + height! > 6_858_050) throw new Error(`第 ${index + 1} 页有元素超出页面边界`);
          }
        }
      }
    }
    for (const expected of [slide.title, ...(slide.subtitle ? [slide.subtitle] : []), ...slide.lines]) {
      if (!text.includes(expected)) throw new Error(`第 ${index + 1} 页缺少计划中的文字`);
    }
    if (slide.notes) {
      const notes = archive.file(`ppt/notesSlides/notesSlide${index + 1}.xml`);
      if (!notes || !(await notes.async("string")).includes("来源原文") && slide.notes.includes("来源原文")) throw new Error(`第 ${index + 1} 页缺少来源备注`);
    }
  }
}
