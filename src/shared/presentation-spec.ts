import { z } from "zod";

/**
 * 文档可靠性改造 · A 阶段的任务契约。
 *
 * 这是「用户要求的持久化表示」，不是结果报告：TemplateReport 描述一次生成
 * 的质量，PresentationSpec 描述这一份 PPT 必须满足什么，跨轮次、跨入口复用。
 */

export const evidenceSchema = z.object({
  sourceMessageId: z.string().min(1),
  text: z.string().min(1).max(500),
});
export type Evidence = z.infer<typeof evidenceSchema>;

const count = z.number().int().min(1).max(200);
const withEvidence = { evidence: evidenceSchema };

export const pageCountConstraintSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exact"), value: count, ...withEvidence }),
  z.object({ kind: z.literal("min"), value: count, ...withEvidence }),
  z.object({ kind: z.literal("max"), value: count, ...withEvidence }),
  z.object({ kind: z.literal("range"), min: count, max: count, ...withEvidence }),
]);
export type PageCountConstraint = z.infer<typeof pageCountConstraintSchema>;

/** Omit 对联合类型不分发，必须逐个成员去掉 evidence，否则 value/min/max 会丢。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type PageCountValue = DistributiveOmit<PageCountConstraint, "evidence">;

export const requiredContentSchema = z.object({
  id: z.string().min(1),
  evidence: evidenceSchema,
  description: z.string().min(1).max(500),
  placement: z.literal("visible"),
  sourceRefs: z.array(z.object({ fileId: z.string().min(1), sha256: z.string().min(1), nodeId: z.string().min(1) })),
  verification: z.enum(["deterministic", "semantic"]),
});
export type RequiredContent = z.infer<typeof requiredContentSchema>;

/**
 * 结构性要求（例如「必须保留三个案例」）。它不是页面上要逐字出现的文本，
 * 因此不能进 requiredContent —— 否则门禁永远匹配不到，产物会永久停在草稿。
 * 由页面职责计划（D1 deckPlan）核对。
 */
export const structureRequirementSchema = z.object({
  kind: z.literal("case_count"),
  value: z.number().int().min(1).max(20),
  evidence: evidenceSchema,
});
export type StructureRequirement = z.infer<typeof structureRequirementSchema>;

export const presentationSpecSchema = z.object({
  schemaVersion: z.literal(1),
  specId: z.string().min(1),
  revision: z.number().int().positive(),
  conversationId: z.string().min(1),
  familyId: z.string().optional(),
  lifecycle: z.enum(["prepared", "active", "completed"]),
  sources: z.array(z.object({ fileId: z.string().min(1), sha256: z.string().min(1) })),
  pageCount: pageCountConstraintSchema.optional(),
  /** 用户说的是总页数还是正文页数；解析后的目标一律按总页数计算 */
  pageCountBasis: z.enum(["total", "body"]),
  cover: z.enum(["include", "exclude"]),
  requiredContent: z.array(requiredContentSchema),
  /** 结构性要求不参与正文逐字匹配；旧数据缺省为空数组。 */
  structure: z.array(structureRequirementSchema).default([]),
  requiredAssets: z.array(z.object({ assetId: z.string().min(1), sha256: z.string().min(1), evidence: evidenceSchema })),
  styleRequest: evidenceSchema.optional(),
  visualPolicy: z.enum(["background", "before_publish"]),
  /** 契约来源：用户原话、系统默认估计或从旧断点恢复 */
  origin: z.enum(["user", "default", "legacy-derived"]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type PresentationSpec = z.infer<typeof presentationSpecSchema>;

export type PageCountIntent = {
  constraint: PageCountValue;
  basis: "total" | "body";
  evidenceText: string;
};

const CN_DIGITS = "零一二三四五六七八九";

/** 把中文数字串换成阿拉伯数字，仅处理「十/百」以内的常见页数写法。 */
function cnNumber(raw: string): number {
  const chars = raw.replace(/两/g, "二").replace(/〇/g, "零");
  let value = 0, pending = 0;
  for (const char of chars) {
    if (char === "百" || char === "十") {
      value += (pending || 1) * (char === "百" ? 100 : 10);
      pending = 0;
    } else pending = pending * 10 + CN_DIGITS.indexOf(char);
  }
  return value + pending;
}

/**
 * 从**单条用户消息**解析页数要求。
 *
 * 与 presentation-workflow.ts 的 templatePageCount 保持同样的干扰过滤规则，
 * 但返回结构化语义（exact/min/max/range）而不是单一数字，也不接受默认估计值。
 * 无法可靠判断时返回 undefined，由调用方沿用既有行为或追问，绝不猜测。
 */
export function parsePageCountIntent(text: string, sourceMessageId: string): (PageCountIntent & { evidence: Evidence }) | undefined {
  if (!text.trim()) return undefined;
  const normalized = text.normalize("NFKC")
    .replace(/张\s*幻灯片/g, "页")
    .replace(/[零〇一二两三四五六七八九十百]{1,8}(?=\s*(?:页|[至到–—~～-]\s*[\d零〇一二两三四五六七八九十百]+\s*页))/g, raw => String(cnNumber(raw)))
    .replace(/第\s*\d+\s*(?:[至到–—-]\s*第?\s*\d+\s*)?页/g, "")
    .replace(/(?:每(?:个|一)?|各)[^，。；;,\n]{0,16}?\d+\s*页/g, "")
    .replace(/(?:原文|原稿|原件|源文件|资料|附件|导图|文档)(?:里|中)?\s*(?:共有|一共|共|有|长|为|的)?\s*\d+\s*页/g, "");
  const matches = [...normalized.matchAll(/(至少|不超过|最多|控制在|做成|制作|生成|做|共|约|大约|一共)?\s*(\d+)(?:\s*(?:[–—~～-]|至|到)\s*(\d+))?\s*(?:页(?:\s*(以内|以下|以上|左右))?|slides?\b)/gi)];
  const match = matches.at(-1);
  if (!match) return undefined;
  const [, prefix, first, second, suffix] = match;
  const firstValue = Number(first);
  const secondValue = second ? Number(second) : undefined;
  // 「约 10 页 / 10 页左右」是软偏好，不能伪装成硬约束。
  if (prefix === "约" || prefix === "大约" || suffix === "左右") return undefined;
  // 「正文 10 页，另加封面」按正文页数记录，目标总页数在 resolve 时 +1。
  const basis: "total" | "body" = /正文\s*\d+\s*页|正文页\s*数/.test(normalized) ? "body" : "total";
  const evidenceText = match[0].trim();
  const evidence: Evidence = { sourceMessageId, text: evidenceText };
  let constraint: PageCountValue;
  if (secondValue !== undefined) {
    const low = Math.min(firstValue, secondValue), high = Math.max(firstValue, secondValue);
    if (high > 200) return undefined;
    constraint = low === high ? { kind: "exact", value: low } : { kind: "range", min: low, max: high };
  } else if (prefix === "至少" || suffix === "以上") {
    constraint = { kind: "min", value: firstValue };
  } else if (["不超过", "最多", "控制在"].includes(prefix ?? "") || suffix === "以内" || suffix === "以下") {
    constraint = { kind: "max", value: firstValue };
  } else {
    constraint = { kind: "exact", value: firstValue };
  }
  if ("value" in constraint && (constraint.value < 1 || constraint.value > 200)) return undefined;
  return { constraint, basis, evidenceText, evidence: { ...evidence, text: evidenceText } };
}

/** 把用户语义换算成总页数上限/下限；basis=body 时封面另计。 */
export function totalize(constraint: PageCountValue, basis: "total" | "body"): PageCountValue {
  if (basis === "total") return constraint;
  const extra = 1;
  if (constraint.kind === "range") return { kind: "range", min: Math.min(200, constraint.min + extra), max: Math.min(200, constraint.max + extra) };
  return { ...constraint, value: Math.min(200, constraint.value + extra) };
}

/** 显式页数超限必须报冲突，不能静默 clamp 到 200。 */
export function pageCountConflict(constraint: PageCountValue): string | undefined {
  const values = constraint.kind === "range" ? [constraint.min, constraint.max] : [constraint.value];
  if (values.some(value => value > 200)) return "用户要求的页数超过 200 页上限，请调整要求";
  if (constraint.kind === "range" && constraint.min > constraint.max) return "页数范围下限大于上限";
  return undefined;
}

/** 按约束把系统估计页数收敛到合法集合；estimate 只用于 min/max/range。 */
export function chooseTargetPages(constraint: PageCountValue, estimate: number): number {
  const bounded = Math.min(200, Math.max(1, Math.round(estimate)));
  if (constraint.kind === "exact") return constraint.value;
  if (constraint.kind === "min") return Math.max(constraint.value, bounded);
  if (constraint.kind === "max") return Math.min(constraint.value, bounded);
  return Math.min(constraint.max, Math.max(constraint.min, bounded));
}

export function pageCountSatisfies(constraint: PageCountValue, actual: number): boolean {
  if (constraint.kind === "exact") return actual === constraint.value;
  if (constraint.kind === "min") return actual >= constraint.value;
  if (constraint.kind === "max") return actual <= constraint.value;
  return actual >= constraint.min && actual <= constraint.max;
}

export function specFingerprint(spec: PresentationSpec): string {
  return JSON.stringify([spec.specId, spec.revision, spec.pageCount, spec.pageCountBasis, spec.cover,
    spec.requiredContent.map(item => item.id), spec.sources.map(item => [item.fileId, item.sha256])]);
}
