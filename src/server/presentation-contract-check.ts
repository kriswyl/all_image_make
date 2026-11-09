import { createHash } from "node:crypto";
import type { AiPresentation } from "./mind-document.js";
import { elementTexts } from "./presentation-elements.js";
import type { TemplateReport } from "../shared/presentation-report.js";
import {
  pageCountConflict, pageCountSatisfies, totalize, type PresentationSpec, type RequiredContent,
} from "../shared/presentation-spec.js";
import type { ContractValidation, PresentationSpecStore, RequirementVerification } from "./presentation-spec-store.js";

/** 外部可信核验（AI 内容审校 / 人工确认）提交给门禁的结论。 */
export type RequirementVerdict = {
  requiredId: string;
  status: "satisfied" | "missing";
  evidence: string;
  sourceRef?: string;
  verifiedBy: "content-audit" | "manual";
};

export type ContractCheckInput = {
  conversationId: string;
  spec: PresentationSpec | null;
  plan: AiPresentation;
  bytes: Buffer;
  report?: TemplateReport;
  /** 修改类任务的基线方案；用于检查未授权页面是否被改动 */
  baselinePlan?: AiPresentation;
  targets?: number[];
  expectedSpecId?: string;
  expectedSpecRevision?: number;
  /**
   * 素材身份绑定：assetId → imageIndex + 图片字节哈希。
   * 封面素材带 cover:true；门禁据此核对「是不是用户指定的那张、内容是否一致」。
   */
  assetBindings?: Array<{ assetId: string; imageIndex: number; sha256: string; cover?: boolean }>;
  /** 由内容审校等可信核验方产生的语义结论；门禁会先落到「哈希 + revision + 要求 ID」上。 */
  requirementVerifications?: RequirementVerdict[];
};

export type ContractCheckResult = {
  validation: ContractValidation | null;
  /** 归属、范围等安全类失败必须阻止发布，不能以草稿绕过 */
  blocking: Array<{ code: string; detail: string }>;
};

const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\p{P}\s]/gu, "");
type Slide = AiPresentation["slides"][number];

/** 单页真正可见的文字；备注一律不计入。 */
function slideVisibleText(slide: Slide): string {
  const elements = slide.elements ?? [];
  return (elements.length ? elementTexts(elements) : [slide.title, ...(slide.lines ?? [])]).join("\n");
}

/**
 * 页面上真正可见的文字；备注一律不计入。
 *
 * 元素页只认元素里实际渲染出来的文字：`slide.title` 是元数据，
 * 模型完全可能只填 title 而没把它画进任何元素里，把它算作可见等于放行「标题里有、页面上没有」。
 * 旧模板页（无 elements）的 title/lines 由渲染器逐字画出，才计入。
 */
export function visibleText(plan: AiPresentation): string {
  return normalize(plan.slides.map(slideVisibleText).join("\n"));
}

/**
 * 结构要求在缺少职责计划时的确定性兜底：
 * 数页面上出现过的不同案例标签（案例 A / 案例 1 / 案例三…）。
 * 它只能证明「正文里确实有 N 个不同标签」，不能证明案例内容或来源还在，
 * 因此不能单独用来判定结构要求通过。
 */
export function countVisibleCaseLabels(plan: AiPresentation): number {
  const labels = new Set<string>();
  for (const match of visibleText(plan).matchAll(/案例([a-z0-9一二三四五六七八九十]{1,3})/g)) labels.add(match[1]!);
  return labels.size;
}

/** 来源关联：正文页带 sourceIds，或备注里有成段的「来源原文」。 */
function sourceRefOf(slide: Slide): string {
  const ids = slide.sourceIds ?? [];
  if (ids.length) return ids.join(",");
  const notes = slide.notes ?? "";
  const at = notes.indexOf("来源原文");
  if (at >= 0 && notes.slice(at + 4).trim().length >= 20) return "notes";
  return "";
}

export type CaseEvidence = {
  /** 同时具备「实际正文 + 来源关联」的不同案例数 */
  count: number;
  /** 正文里出现过的不同案例标签数（仅用于报告，不足以证明内容保留） */
  labels: number;
  pages: Array<{ page: number; label: string; excerpt: string; sourceRef: string }>;
};

/**
 * 「案例保留」的证据只能来自成品方案本身：
 * - 角色标签（role: case）是规划，不是证据；
 * - 「案例 A/B/C」这样的编号只是标记，正文里必须有实质内容；
 * - 该页还必须能关联到来源（sourceIds 或来源原文备注）。
 */
export function collectCaseEvidence(plan: AiPresentation): CaseEvidence {
  const pages: CaseEvidence["pages"] = [];
  const seen = new Set<string>();
  const labels = new Set<string>();
  plan.slides.forEach((slide, index) => {
    const text = slideVisibleText(slide);
    const sourceRef = sourceRefOf(slide);
    for (const match of text.matchAll(/案例\s*([A-Za-z0-9一二三四五六七八九十]{1,3})/g)) {
      const label = normalize(match[1]!);
      labels.add(label);
      // 去掉标签和标点后仍要有实质正文，只有「案例 A」这样的空壳不算内容。
      const body = normalize(text.replace(/案例\s*([A-Za-z0-9一二三四五六七八九十]{1,3})/g, ""));
      if (body.length < 12 || !sourceRef || seen.has(label)) continue;
      seen.add(label);
      pages.push({ page: index + 1, label, excerpt: text.replace(/\s+/g, " ").slice(0, 160), sourceRef });
    }
  });
  return { count: pages.length, labels: labels.size, pages };
}

/** 从「保留三个案例的结论」这类描述里取数量，取不到时按 1 处理。 */
function requiredCaseCount(description: string): number {
  const cn: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const digit = /(\d+)\s*个?\s*案例/.exec(description);
  if (digit) return Math.min(20, Math.max(1, Number(digit[1])));
  const chinese = /([一二两三四五六七八九十])\s*个?\s*案例/.exec(description);
  return chinese ? cn[chinese[1]!] ?? 1 : 1;
}

/**
 * 语义要求的确定性证据评估。**不是通用逐字匹配**：
 * - 只有「保留一句原话」这种短且明确的条目才允许按逐字 + 来源核验；
 * - 「案例 / 结论」类要求必须有正文 + 来源的案例证据；
 * - 其余情况返回 null，交给可信核验结果（内容审校 / 人工）解除未知。
 */
function evaluateSemantic(
  item: RequiredContent, plan: AiPresentation, caseEvidence: CaseEvidence,
): Pick<RequirementVerification, "status" | "method" | "evidence" | "sourceRef"> | null {
  const key = normalize(item.description);
  const isConclusion = /案例|结论|总结|分析|归纳/.test(item.description);
  if (!isConclusion && key.length >= 2 && key.length <= 80) {
    for (const slide of plan.slides) {
      const text = slideVisibleText(slide);
      if (!normalize(text).includes(key)) continue;
      const sourceRef = sourceRefOf(slide);
      if (!sourceRef) continue;
      return { status: "satisfied", method: "verbatim", evidence: item.description, sourceRef };
    }
  }
  if (isConclusion) {
    const needed = requiredCaseCount(item.description);
    if (caseEvidence.count >= needed) {
      return {
        status: "satisfied", method: "case-evidence",
        evidence: caseEvidence.pages.slice(0, needed).map(page => `第${page.page}页：${page.excerpt}`).join(" | ").slice(0, 400),
        sourceRef: caseEvidence.pages.slice(0, needed).map(page => page.sourceRef).join(" | ").slice(0, 300),
      };
    }
  }
  return null;
}

function slideSignature(plan: AiPresentation, index: number): string {
  const slide = plan.slides[index];
  if (!slide) return "";
  return createHash("sha256").update(JSON.stringify({
    title: slide.title, lines: slide.lines ?? [], elements: slide.elements ?? [],
    sourceIds: slide.sourceIds ?? [], imageIndex: slide.imageIndex,
  })).digest("hex");
}

/**
 * A 阶段统一门禁：制作、doc_edit、单页补做、视觉修复在保存前都调用。
 * 没有契约时只做兼容性的草稿判定，不改变既有产物行为。
 */
export function checkPresentationContract(
  store: PresentationSpecStore, input: ContractCheckInput,
): ContractCheckResult {
  const { spec, plan, report } = input;
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const failures: Array<{ code: string; detail: string }> = [];
  const blocking: Array<{ code: string; detail: string }> = [];
  const coverage = { required: 0, satisfied: 0, unknown: 0 };

  if (spec) {
    if (input.expectedSpecId && input.expectedSpecId !== spec.specId) {
      blocking.push({ code: "SPEC_OWNERSHIP", detail: "文件绑定的任务契约与本次执行不一致" });
    }
    if (input.expectedSpecRevision && input.expectedSpecRevision !== spec.revision) {
      blocking.push({ code: "SPEC_REVISION", detail: "任务契约已更新，旧执行不能继续发布" });
    }
    if (spec.pageCount) {
      const constraint = totalize(spec.pageCount, spec.pageCountBasis);
      const conflict = pageCountConflict(constraint);
      if (conflict) failures.push({ code: "PAGE_COUNT_CONFLICT", detail: conflict });
      else if (!pageCountSatisfies(constraint, plan.slides.length)) {
        failures.push({ code: "PAGE_COUNT", detail: `要求 ${JSON.stringify(constraint)} 总页数，实际 ${plan.slides.length} 页` });
      }
    }

    // 外部可信核验先落库：结论绑定文件哈希 + 契约 revision + 要求 ID。
    for (const verdict of input.requirementVerifications ?? []) {
      if (!spec.requiredContent.some(item => item.id === verdict.requiredId)) continue;
      store.saveRequirementVerification({
        specId: spec.specId, specRevision: spec.revision, requiredId: verdict.requiredId,
        fileSha256: sha256, status: verdict.status, method: verdict.verifiedBy,
        evidence: verdict.evidence.slice(0, 400), sourceRef: verdict.sourceRef ?? "",
      });
    }
    const verifications = new Map<string, RequirementVerification>();
    for (const record of store.listRequirementVerifications(spec.specId, spec.revision, sha256)) {
      // 同一要求可重复核验，取最后一条；satisfied 优先保留，避免晚到的失败结论覆盖已通过证据。
      const previous = verifications.get(record.requiredId);
      if (!previous || record.status === "satisfied" || previous.status !== "satisfied") verifications.set(record.requiredId, record);
    }
    const visible = visibleText(plan);
    const caseEvidence = collectCaseEvidence(plan);
    for (const item of spec.requiredContent) {
      coverage.required += 1;
      if (item.verification === "semantic") {
        const stored = verifications.get(item.id);
        if (stored?.status === "satisfied" && stored.evidence && stored.sourceRef) {
          coverage.satisfied += 1;
          continue;
        }
        const evaluated = evaluateSemantic(item, plan, caseEvidence);
        if (evaluated) {
          store.saveRequirementVerification({
            specId: spec.specId, specRevision: spec.revision, requiredId: item.id, fileSha256: sha256,
            status: evaluated.status, method: evaluated.method, evidence: evaluated.evidence, sourceRef: evaluated.sourceRef,
          });
          coverage.satisfied += 1;
          continue;
        }
        store.saveRequirementVerification({
          specId: spec.specId, specRevision: spec.revision, requiredId: item.id, fileSha256: sha256,
          status: "unverified", method: stored?.method ?? "none",
          evidence: stored?.evidence ?? "", sourceRef: "",
        });
        coverage.unknown += 1;
        failures.push({
          code: "REQUIRED_UNKNOWN",
          detail: `必需内容「${item.description}」需要正文证据 + 来源关联的核验结果；当前缺少可采信结论（内容审校或人工确认后可解除）`,
        });
      } else if (visible.includes(normalize(item.description))) coverage.satisfied += 1;
      else failures.push({ code: "REQUIRED_NOT_VISIBLE", detail: `必需内容「${item.description}」未出现在页面正文（备注不计入）` });
    }

    const placedImages = new Set(plan.slides.flatMap(slide =>
      (slide.elements ?? []).flatMap(element => element.type === "image" ? [element.imageIndex] : [])));
    const bindings = input.assetBindings ?? [];
    for (const asset of spec.requiredAssets) {
      coverage.required += 1;
      // 只有「这张素材就是用户指定的那张、且哈希一致、且确实落在页面上」才算满足。
      const bound = bindings.filter(binding => binding.assetId === asset.assetId);
      const identified = bound.filter(binding => binding.sha256 === asset.sha256);
      if (identified.length && identified.every(binding => placedImages.has(binding.imageIndex))) coverage.satisfied += 1;
      else if (!bound.length) failures.push({
        code: "REQUIRED_ASSET_UNVERIFIED",
        detail: `指定素材 ${asset.assetId} 缺少素材绑定记录，无法确认落位（不按图片数量推断）`,
      });
      else if (!identified.length) failures.push({
        code: "REQUIRED_ASSET_IDENTITY",
        detail: `指定素材 ${asset.assetId} 的图片内容哈希与契约不一致，不能冒充原图`,
      });
      else failures.push({ code: "REQUIRED_ASSET", detail: `指定素材 ${asset.assetId} 未落位到页面` });
    }

    // 结构要求：角色标签与案例编号都只是线索，必须由实际正文 + 来源证据满足。
    for (const requirement of spec.structure ?? []) {
      if (requirement.kind !== "case_count") continue;
      const roleCases = report?.deckPlan?.pages.filter(page => page.role === "case").length ?? 0;
      coverage.required += 1;
      if (caseEvidence.count >= requirement.value) coverage.satisfied += 1;
      else if (!report?.deckPlan && caseEvidence.labels === 0) {
        coverage.unknown += 1;
        failures.push({
          code: "STRUCTURE_UNVERIFIED",
          detail: `要求保留 ${requirement.value} 个案例，但没有职责计划，正文里也没有可识别的案例`,
        });
      } else if (caseEvidence.count === 0) {
        coverage.unknown += 1;
        failures.push({
          code: "STRUCTURE_CASE_UNVERIFIED",
          detail: `要求保留 ${requirement.value} 个案例；职责计划标注 ${roleCases} 页、正文出现 ${caseEvidence.labels} 个案例标签，但没有任何一页同时具备案例正文与来源关联`,
        });
      } else {
        failures.push({
          code: "STRUCTURE_CASE_COUNT",
          detail: `要求保留 ${requirement.value} 个案例，只有 ${caseEvidence.count} 个案例具备「正文 + 来源」证据（职责计划标注 ${roleCases} 页、标签 ${caseEvidence.labels} 个）`,
        });
      }
    }
    if (spec.requiredAssets.length && report?.unplacedImages) {
      failures.push({ code: "UNPLACED_IMAGES", detail: `报告显示还有 ${report.unplacedImages} 张指定图片未落位` });
    }
  }

  if (input.baselinePlan) {
    const targets = new Set(input.targets ?? []);
    const changed = input.baselinePlan.slides.flatMap((_, index) =>
      targets.has(index + 1) ? [] :
        slideSignature(input.baselinePlan!, index) === slideSignature(plan, index) ? [] : [index + 1]);
    if (changed.length) blocking.push({ code: "SCOPE_VIOLATION", detail: `未授权页面发生变化：${changed.join("、")}` });
  }

  if (report) {
    if (report.draft) failures.push({ code: "DRAFT", detail: "报告已标记为草稿" });
  }

  const ok = failures.length === 0 && blocking.length === 0;
  const validation: ContractValidation | null = spec
    ? store.saveValidation({
      specId: spec.specId, specRevision: spec.revision, fileSha256: sha256,
      ok, readiness: ok ? "ready" : "draft",
      failures: [...blocking, ...failures], visibleCoverage: coverage,
    })
    : null;
  return { validation, blocking };
}
