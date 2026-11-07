import { createHash } from "node:crypto";
import type { AiPresentation } from "./mind-document.js";
import { elementTexts } from "./presentation-elements.js";
import type { TemplateReport } from "../shared/presentation-report.js";
import {
  pageCountConflict, pageCountSatisfies, totalize, type PresentationSpec,
} from "../shared/presentation-spec.js";
import type { ContractValidation, PresentationSpecStore } from "./presentation-spec-store.js";

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
  /** 素材身份绑定：由生成入口记录 assetId → imageIndex，门禁据此核对「是不是这一张」。 */
  assetBindings?: Array<{ assetId: string; imageIndex: number }>;
};

export type ContractCheckResult = {
  validation: ContractValidation | null;
  /** 归属、范围等安全类失败必须阻止发布，不能以草稿绕过 */
  blocking: Array<{ code: string; detail: string }>;
};

const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[\p{P}\s]/gu, "");

/**
 * 页面上真正可见的文字；备注一律不计入。
 *
 * 元素页只认元素里实际渲染出来的文字：`slide.title` 是元数据，
 * 模型完全可能只填 title 而没把它画进任何元素里，把它算作可见等于放行「标题里有、页面上没有」。
 * 旧模板页（无 elements）的 title/lines 由渲染器逐字画出，才计入。
 */
export function visibleText(plan: AiPresentation): string {
  return normalize(plan.slides.flatMap(slide => {
    const elements = slide.elements ?? [];
    if (elements.length) return elementTexts(elements);
    return [slide.title, ...(slide.lines ?? [])];
  }).join("\n"));
}

/**
 * 结构要求在缺少职责计划时的确定性兜底：
 * 数页面上出现过的不同案例标签（案例 A / 案例 1 / 案例三…）。
 * 它只能证明「正文里确实有 N 个不同案例」，不能证明版式合适，
 * 因此返回 0 时仍记为未知，不谎报满足。
 */
export function countVisibleCaseLabels(plan: AiPresentation): number {
  const labels = new Set<string>();
  for (const match of visibleText(plan).matchAll(/案例([a-z0-9一二三四五六七八九十]{1,3})/g)) labels.add(match[1]!);
  return labels.size;
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
    const visible = visibleText(plan);
    for (const item of spec.requiredContent) {
      coverage.required += 1;
      if (item.verification === "semantic") {
        coverage.unknown += 1;
        failures.push({ code: "REQUIRED_UNKNOWN", detail: `必需内容「${item.description}」需要语义核验，未确认可见` });
      } else if (visible.includes(normalize(item.description))) coverage.satisfied += 1;
      else failures.push({ code: "REQUIRED_NOT_VISIBLE", detail: `必需内容「${item.description}」未出现在页面正文（备注不计入）` });
    }
    const placedImages = new Set(plan.slides.flatMap(slide =>
      (slide.elements ?? []).flatMap(element => element.type === "image" ? [element.imageIndex] : [])));
    const bindings = input.assetBindings ?? [];
    for (const asset of spec.requiredAssets) {
      coverage.required += 1;
      // 只有「这张素材就是用户指定的那张」才算满足：按 assetId 对回 imageIndex，
      // 不能拿「页面上有 N 张图」冒充指定素材已落位。
      const bound = bindings.filter(binding => binding.assetId === asset.assetId);
      if (bound.length && bound.every(binding => placedImages.has(binding.imageIndex))) coverage.satisfied += 1;
      else if (!bindings.length) failures.push({
        code: "REQUIRED_ASSET_UNVERIFIED",
        detail: `指定素材 ${asset.assetId} 缺少素材绑定记录，无法确认落位（不按图片数量推断）`,
      });
      else failures.push({ code: "REQUIRED_ASSET", detail: `指定素材 ${asset.assetId} 未落位到页面` });
    }
    // 结构要求（如「保留 N 个案例」）由页面职责计划核对，不参与正文逐字匹配。
    for (const requirement of spec.structure ?? []) {
      if (requirement.kind !== "case_count") continue;
      const deck = report?.deckPlan;
      coverage.required += 1;
      // 两条证据取其一即可：职责计划里的 case 页数，或正文里出现过的不同案例标签数。
      // 修改入口/旧产物可能没有职责计划，但正文证据同样能证明案例没丢。
      const roleCases = deck ? deck.pages.filter(page => page.role === "case").length : 0;
      const textCases = countVisibleCaseLabels(plan);
      const cases = Math.max(roleCases, textCases);
      if (cases >= requirement.value) coverage.satisfied += 1;
      else if (!deck && !textCases) {
        // 既没有职责计划、正文也没有可识别的案例标签：无法证明满足。
        // 「未验证」不能当成通过，否则「内容丢了」和「检查不了」在报告里长得一样。
        coverage.unknown += 1;
        failures.push({
          code: "STRUCTURE_UNVERIFIED",
          detail: `要求保留 ${requirement.value} 个案例，但既没有页面职责计划，正文里也没有可识别的案例标签`,
        });
      } else failures.push({
        code: "STRUCTURE_CASE_COUNT",
        detail: `要求保留 ${requirement.value} 个案例，职责计划里 ${roleCases} 个案例页、正文里 ${textCases} 个不同案例`,
      });
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
    // 精简页 / 待补全页由原报告的 DRAFT_THRESHOLD 自行判定，门禁不再二次升级：
    // 「单页精简仍可正常交付」是既有行为，不能因为引入契约就把它改判成草稿。
    // 它们影响的是「任务完成耗时」口径，而不是文件是否可用。
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
