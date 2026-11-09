/**
 * M1：导出后对象映射。
 *
 * 只看 OOXML 里的 cNvPr 名称，不查 pptxgenjs 的私有数组，也不假设数字 shapeId 连续。
 * 用途是把「逻辑元素 id」对到「这一页里真正存在的形状」，为 M2 的原位补丁提供唯一命中；
 * 找不到、同名多份、子对象不完整，一律拒绝，不按相似度猜。
 */
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import type { AiPresentation } from "./mind-document.js";
import { resolveElements, type PresentationElement } from "./presentation-elements.js";
import { contentFingerprint } from "./presentation-project.js";

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, processEntities: false });

export type PptObjectBinding = {
  logicalElementId: string;
  /** 1 起的页码，与 plan.slides 下标 +1 一致 */
  slide: number;
  slidePart: string;
  objects: Array<{ shapeId: string; objectName: string; role: string }>;
  /** 该对象依赖的其它部件（图片/图表）；整页依赖闭包属于 M2，这里先留空 */
  relatedParts: string[];
};

export type ObjectMapIssue = {
  slidePart: string;
  objectName: string;
  detail: string;
};

export type PptObjectMap = {
  /** 与内嵌 plan 的 fingerprint 同口径（只算 ppt/ 部件） */
  fingerprint: string;
  bindings: PptObjectBinding[];
  issues: ObjectMapIssue[];
};

const asArray = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** 按 presentation.xml 的 sldIdLst 顺序解析页部件，不靠 slideN 的数字顺序。 */
async function slideParts(zip: JSZip): Promise<string[]> {
  const pres = zip.file("ppt/presentation.xml"), rels = zip.file("ppt/_rels/presentation.xml.rels");
  if (pres && rels) {
    const relMap = new Map<string, string>();
    for (const rel of asArray(parser.parse(await rels.async("string"))?.Relationships?.Relationship as Array<Record<string, string>> | undefined)) {
      const id = rel["@_Id"], target = rel["@_Target"];
      if (typeof id === "string" && typeof target === "string") relMap.set(id, target.replace(/^\/?ppt\//, ""));
    }
    const list = asArray(parser.parse(await pres.async("string"))?.["p:presentation"]?.["p:sldIdLst"]?.["p:sldId"] as Array<Record<string, string>> | undefined);
    const ordered = list.map(node => relMap.get(String(node["@_r:id"] ?? ""))).filter((target): target is string => Boolean(target))
      .map(target => `ppt/${target.replace(/^\.\.\//, "")}`);
    if (ordered.length) return ordered;
  }
  return Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)![1]) - Number(b.match(/(\d+)\.xml$/)![1]));
}

type NamedShape = { shapeId: string; name: string };

/** 从页面 XML 里取出所有带名字的对象；没有名字的（如背景装饰）不参与定位。 */
function namedShapes(xml: string): NamedShape[] {
  return [...xml.matchAll(/<p:cNvPr\b[^>]*>/g)].map(([tag]) => ({
    shapeId: (/\bid="(\d+)"/.exec(tag)?.[1] ?? ""),
    name: (/\bname="([^"]*)"/.exec(tag)?.[1] ?? ""),
  })).filter(shape => shape.shapeId && shape.name);
}

/**
 * 每种逻辑元素导出后应有的子对象名。
 * `exact` 为 true 时名字必须完全一致；连线只要求「至少一段」，段数由路由决定。
 */
export function expectedObjectNames(element: PresentationElement): { names: string[]; exact: boolean } {
  if (element.type !== "icon" && element.type !== "connector") return { names: [element.id], exact: true };
  if (element.type === "connector") return { names: [`${element.id}-segment-`], exact: false };
  if (element.icon === "target" || element.icon === "info") {
    return { names: [`${element.id}-ring`, `${element.id}-${element.icon === "target" ? "dot" : "glyph"}`], exact: true };
  }
  const strokes = element.icon === "trend" ? 3 : element.icon === "check" ? 2 : 1;
  return { names: Array.from({ length: strokes }, (_, index) => `${element.id}-stroke-${index}`), exact: true };
}

/** 一个逻辑元素最多能对应多少个子对象；用于发现「多出来的同名形状」。 */
function roleOf(element: PresentationElement, objectName: string): string {
  if (objectName === element.id) return element.type;
  return objectName.slice(element.id.length + 1) || element.type;
}

export async function buildObjectMap(bytes: Buffer, plan: AiPresentation, options: { expectedFingerprint?: string } = {}): Promise<PptObjectMap> {
  if (bytes.length > 20 * 1024 * 1024) throw new Error("PPT 文件超过 20 MB");
  const zip = await JSZip.loadAsync(bytes);
  if (!zip.file("ppt/presentation.xml")) throw new Error("不是有效的 PPTX 文件");
  const fingerprint = await contentFingerprint(zip);
  // 映射绑定文件指纹：文件被外部改过，旧映射立即失效，不能继续用来改对象。
  if (options.expectedFingerprint && options.expectedFingerprint !== fingerprint) {
    throw new Error("PPT 已在外部修改，对象映射已过期；请重新读取文件后再定位对象");
  }

  const parts = await slideParts(zip);
  const bindings: PptObjectBinding[] = [];
  const issues: ObjectMapIssue[] = [];

  for (const [index, part] of parts.entries()) {
    const slide = plan.slides[index];
    if (!slide) { issues.push({ slidePart: part, objectName: "", detail: "计划里没有这一页，无法建立映射" }); continue; }
    const file = zip.file(part);
    if (!file) { issues.push({ slidePart: part, objectName: "", detail: "页面部件缺失" }); continue; }
    const shapes = namedShapes(await file.async("string"));
    const counts = new Map<string, number>();
    for (const shape of shapes) counts.set(shape.name, (counts.get(shape.name) ?? 0) + 1);

    for (const element of resolveElements(slide) ?? []) {
      const { names, exact } = expectedObjectNames(element);
      const present = exact
        ? names.map(name => ({ name, matches: shapes.filter(shape => shape.name === name) }))
        : [{ name: names[0]!, matches: shapes.filter(shape => shape.name.startsWith(names[0]!)) }];
      // 同名多份：无法判断该改哪一个，直接拒绝。
      const duplicated = present.flatMap(item => item.matches).filter(shape => (counts.get(shape.name) ?? 0) > 1);
      if (duplicated.length) {
        issues.push({ slidePart: part, objectName: duplicated[0]!.name, detail: `同名对象出现 ${counts.get(duplicated[0]!.name)} 次，拒绝按名称定位` });
        continue;
      }
      const missing = present.filter(item => item.matches.length === 0).map(item => item.name);
      if (missing.length) {
        issues.push({
          slidePart: part, objectName: missing[0]!,
          detail: exact ? `缺少子对象 ${missing.join("、")}，拒绝原位修改` : `连线没有任何分段，无法定位`,
        });
        continue;
      }
      // 连线标签是可选子对象，但「有标签却找不到」同样算不完整。
      if (element.type === "connector" && element.label) {
        const label = shapes.filter(shape => shape.name === `${element.id}-label`);
        if (label.length !== 1) {
          issues.push({ slidePart: part, objectName: `${element.id}-label`, detail: "连线有标签但导出后找不到唯一标签对象" });
          continue;
        }
      }
      const objects = present.flatMap(item => item.matches).map(shape => ({ shapeId: shape.shapeId, objectName: shape.name, role: roleOf(element, shape.name) }));
      if (element.type === "connector" && element.label) {
        const label = shapes.find(shape => shape.name === `${element.id}-label`)!;
        objects.push({ shapeId: label.shapeId, objectName: label.name, role: "label" });
      }
      bindings.push({ logicalElementId: element.id, slide: index + 1, slidePart: part, objects, relatedParts: [] });
    }
  }

  return { fingerprint, bindings, issues };
}

/**
 * 定位一个逻辑元素。零个或多个候选都不猜：直接说明是缺失还是有歧义。
 */
export function resolveObjectBinding(map: PptObjectMap, slide: number, logicalElementId: string): PptObjectBinding {
  const candidates = map.bindings.filter(binding => binding.slide === slide && binding.logicalElementId === logicalElementId);
  const ambiguous = map.issues.filter(issue => issue.objectName.startsWith(logicalElementId) && issue.detail.includes("同名对象"));
  if (ambiguous.length) throw new Error(`第 ${slide} 页 ${logicalElementId} 存在同名对象，不能原位修改：${ambiguous[0]!.detail}`);
  if (!candidates.length) {
    const reason = map.issues.find(issue => issue.objectName.startsWith(logicalElementId));
    throw new Error(`第 ${slide} 页找不到 ${logicalElementId} 的完整对象${reason ? `：${reason.detail}` : ""}`);
  }
  if (candidates.length > 1) throw new Error(`第 ${slide} 页 ${logicalElementId} 命中 ${candidates.length} 份对象，拒绝猜测`);
  return candidates[0]!;
}
