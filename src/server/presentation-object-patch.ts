/**
 * M2 第一刀：限定原位补丁。
 *
 * 只改本应用生成的「单个文本框 / 普通形状」的字号、颜色、位置、尺寸。
 * 表格、图表、图片、图标、连线都是复合或依赖对象，一律拒绝 —— 整页重做不等于改一个 shape。
 *
 * 硬约束：
 *  1. 目标必须能由 M1 的映射唯一定位；同名或缺失直接失败。
 *  2. 只允许目标页部件发生变化；其它部件哈希必须一致（ZIP 元数据不参与比较）。
 *  3. 补丁后必须能把改动同步回 plan，否则不允许继续声称旧 plan 有效。
 */
import JSZip from "jszip";
import { createHash } from "node:crypto";
import type { AiPresentation } from "./mind-document.js";
import type { PresentationElement } from "./presentation-elements.js";
import { buildObjectMap, resolveObjectBinding } from "./presentation-object-map.js";
import { packPresentationProject } from "./presentation-project.js";

export type ObjectPatch = {
  slide: number;
  elementId: string;
  /** 字号（pt） */
  fontSize?: number;
  /** 6 位十六进制，不带 # */
  color?: string;
  /** 英寸，整体替换位置与尺寸 */
  rect?: { x: number; y: number; w: number; h: number };
};

export type PatchReport = {
  applied: Array<{ slide: number; elementId: string; operations: string[] }>;
  rejected: Array<{ slide: number; elementId: string; reason: string }>;
  /** 与补丁前相比真正变了的部件；只应有目标页 */
  changedParts: string[];
  unchangedParts: number;
};

const EMU = 914400;
const PATCHABLE = new Set(["text", "shape"]);
const hex = (value: string) => /^[0-9A-Fa-f]{6}$/.test(value);

/** 解压后逐个部件算哈希：ZIP 时间戳、条目顺序、压缩结果都不参与。 */
async function partHashes(zip: JSZip): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const name of Object.keys(zip.files).sort()) {
    const entry = zip.files[name]!;
    if (entry.dir) continue;
    hashes.set(name, createHash("sha256").update(await entry.async("nodebuffer")).digest("hex"));
  }
  return hashes;
}

function replaced(xml: string, pattern: RegExp, value: string): { xml: string; changed: boolean } {
  if (!pattern.test(xml)) return { xml, changed: false };
  return { xml: xml.replace(pattern, value), changed: true };
}

/** 在单个形状块里改字号：只动已有的 rPr sz，不新增 run。 */
function patchFontSize(block: string, size: number): { block: string; changed: boolean } {
  let changed = false;
  const next = block.replace(/(<a:rPr\b[^>]*\bsz=")(\d+)(")/g, (_match, head: string, _old: string, tail: string) => {
    changed = true;
    return `${head}${Math.round(size * 100)}${tail}`;
  });
  return { block: next, changed };
}

/** 改文字颜色：只替换 rPr 里已有的 srgbClr，避免插入顺序不合 schema。 */
function patchTextColor(block: string, color: string): { block: string; changed: boolean } {
  let changed = false;
  const next = block.replace(/(<a:rPr\b[^>]*>)([\s\S]*?)(<\/a:rPr>)/g, (whole, head: string, body: string, tail: string) => {
    const filled = body.replace(/(<a:solidFill>\s*<a:srgbClr\b[^>]*\bval=")([0-9A-Fa-f]{6})(")/, (_m, before: string, _old: string, after: string) => {
      changed = true;
      return `${before}${color.toUpperCase()}${after}`;
    });
    return filled === body ? whole : `${head}${filled}${tail}`;
  });
  return { block: next, changed };
}

/** 改普通形状的填充色（不是文字颜色）。 */
function patchShapeFill(block: string, color: string): { block: string; changed: boolean } {
  const spPr = /(<p:spPr\b[^>]*>)([\s\S]*?)(<\/p:spPr>)/.exec(block);
  if (!spPr) return { block, changed: false };
  const body = spPr[2]!.replace(/(<a:solidFill>\s*<a:srgbClr\b[^>]*\bval=")([0-9A-Fa-f]{6})(")/, (_m, before: string, _old: string, after: string) => `${before}${color.toUpperCase()}${after}`);
  if (body === spPr[2]) return { block, changed: false };
  return { block: block.replace(spPr[0], `${spPr[1]}${body}${spPr[3]}`), changed: true };
}

function patchRect(block: string, rect: { x: number; y: number; w: number; h: number }): { block: string; changed: boolean } {
  const off = replaced(block, /(<a:off\b[^>]*\bx=")(-?\d+)("[^>]*\by=")(-?\d+)(")/, `$1${Math.round(rect.x * EMU)}$3${Math.round(rect.y * EMU)}$5`);
  const ext = replaced(off.xml, /(<a:ext\b[^>]*\bcx=")(\d+)("[^>]*\bcy=")(\d+)(")/, `$1${Math.round(rect.w * EMU)}$3${Math.round(rect.h * EMU)}$5`);
  return { block: ext.xml, changed: off.changed && ext.changed };
}

/** 找出承载该逻辑对象的唯一 `<p:sp>` 块。 */
function shapeBlock(xml: string, objectName: string): string | null {
  for (const match of xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)) {
    if (match[0].includes(`name="${objectName}"`)) return match[0];
  }
  return null;
}

function syncPlanElement(element: PresentationElement, patch: ObjectPatch): PresentationElement {
  if (element.type === "text") {
    const next = { ...element, ...(patch.rect ?? {}) };
    if (patch.fontSize !== undefined || patch.color !== undefined) {
      next.style = {
        ...element.style,
        ...(patch.fontSize !== undefined ? { fontSize: patch.fontSize } : {}),
        ...(patch.color !== undefined ? { color: patch.color.toUpperCase() } : {}),
      };
    }
    return next;
  }
  if (element.type === "shape") {
    return { ...element, ...(patch.rect ?? {}), ...(patch.color !== undefined ? { fill: patch.color.toUpperCase() } : {}) };
  }
  return { ...element, ...(patch.rect ?? {}) } as PresentationElement;
}

export async function patchPresentationObjects(
  bytes: Buffer, plan: AiPresentation, patches: ObjectPatch[],
  images: Array<{ title: string; data: string }> = [],
): Promise<{ bytes: Buffer; plan: AiPresentation; report: PatchReport }> {
  if (!patches.length) throw new Error("没有要应用的补丁");
  const map = await buildObjectMap(bytes, plan);
  const zip = await JSZip.loadAsync(bytes);
  const before = await partHashes(zip);
  const nextPlan = structuredClone(plan);
  const report: PatchReport = { applied: [], rejected: [], changedParts: [], unchangedParts: 0 };
  const touchedParts = new Set<string>();

  for (const patch of patches) {
    const reject = (reason: string) => report.rejected.push({ slide: patch.slide, elementId: patch.elementId, reason });
    const slide = nextPlan.slides[patch.slide - 1];
    if (!slide) { reject("页码不存在"); continue; }
    // 只有元素页能同步回 plan；box / lines 页没有稳定元素列表，补丁后无法保证 plan 有效。
    if (!slide.elements) { reject("这一页不是元素页（使用了 box 或 lines），补丁无法同步回可编辑源方案"); continue; }
    const element = slide.elements.find(item => item.id === patch.elementId);
    if (!element) { reject("计划里没有这个元素"); continue; }
    if (!PATCHABLE.has(element.type)) { reject(`${element.type} 是复合或依赖对象，原位补丁只支持文本框与普通形状`); continue; }
    if (patch.fontSize !== undefined && (element.type !== "text" || !(patch.fontSize > 0 && patch.fontSize <= 200))) { reject("字号补丁只适用于文本框，且须在 1–200pt 之间"); continue; }
    if (patch.color !== undefined && !hex(patch.color)) { reject("颜色必须是 6 位十六进制"); continue; }
    if (patch.rect && !["x", "y", "w", "h"].every(key => Number.isFinite((patch.rect as Record<string, number>)[key])) || patch.rect && (patch.rect.w <= 0 || patch.rect.h <= 0)) { reject("位置补丁必须给出有限的 x/y/w/h 英寸值"); continue; }

    let binding;
    try { binding = resolveObjectBinding(map, patch.slide, patch.elementId); }
    catch (error) { reject(error instanceof Error ? error.message : String(error)); continue; }
    if (binding.objects.length !== 1) { reject("该元素在页面上对应多个形状，无法只改一个"); continue; }

    const file = zip.file(binding.slidePart);
    if (!file) { reject("页面部件缺失"); continue; }
    const xml = await file.async("string");
    const block = shapeBlock(xml, binding.objects[0]!.objectName);
    if (!block) { reject("页面里找不到该对象的形状块"); continue; }

    let nextBlock = block;
    const operations: string[] = [];
    if (patch.fontSize !== undefined) {
      const result = patchFontSize(nextBlock, patch.fontSize);
      if (!result.changed) { reject("该文本框没有可改的字号属性"); continue; }
      nextBlock = result.block; operations.push("fontSize");
    }
    if (patch.color !== undefined) {
      const result = element.type === "text" ? patchTextColor(nextBlock, patch.color) : patchShapeFill(nextBlock, patch.color);
      if (!result.changed) { reject(element.type === "text" ? "该文本框没有可改的文字颜色" : "该形状没有可改的填充色"); continue; }
      nextBlock = result.block; operations.push("color");
    }
    if (patch.rect) {
      const result = patchRect(nextBlock, patch.rect);
      if (!result.changed) { reject("该形状没有可改的位置与尺寸"); continue; }
      nextBlock = result.block; operations.push("rect");
    }
    if (!operations.length) { reject("补丁没有给出任何可执行的修改"); continue; }

    zip.file(binding.slidePart, xml.replace(block, nextBlock));
    touchedParts.add(binding.slidePart);
    slide.elements = slide.elements.map(item => item.id === patch.elementId ? syncPlanElement(item, patch) : item);
    report.applied.push({ slide: patch.slide, elementId: patch.elementId, operations });
  }

  if (!report.applied.length) {
    return { bytes, plan, report };
  }

  // 部件差异：只允许目标页变化，其它部件必须逐字节一致。
  const after = await partHashes(zip);
  for (const [name, hash] of before) {
    if (after.get(name) !== hash) report.changedParts.push(name);
  }
  for (const name of after.keys()) if (!before.has(name)) report.changedParts.push(name);
  report.unchangedParts = [...before.keys()].filter(name => !report.changedParts.includes(name)).length;
  const illegal = report.changedParts.filter(name => !touchedParts.has(name));
  if (illegal.length) throw new Error(`补丁越界：${illegal.join("、")} 不应发生变化`);

  const packed = await packPresentationProject(
    await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), nextPlan, images,
  );
  return { bytes: packed, plan: nextPlan, report };
}
