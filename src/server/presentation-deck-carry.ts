import { createHash } from "node:crypto";
import type { AiPresentation } from "./mind-document.js";
import type { TemplateReport } from "../shared/presentation-report.js";
import {
  findRepeatedRuns, inferRole, layoutFitsRole, preferredLayouts, summarizeRoles,
  type PageRole, type SlideLayout,
} from "../shared/presentation-roles.js";

/**
 * 修改入口（doc_edit / 单页补做 / 视觉修复）没有重新生成整稿，
 * 因此没有新的报告。但丢弃原报告会让 `deckPlan`、精简页、待补全页全部消失，
 * 结构要求（如「保留 N 个案例」）就再也无法核对。
 *
 * 这里按「内容指纹相同则沿用原页职责，否则按标题推断」重建整稿计划，
 * 并只保留仍然存在的页计数。它是继承，不是重新生成，不制造新的质量结论。
 */
export function carryDeckReport(input: {
  plan: AiPresentation;
  /** 被修改文件的原报告；没有则返回 undefined，保持既有行为。 */
  parentReport?: TemplateReport;
  /** 原方案，用于按内容指纹把职责对回新页面。 */
  parentPlan?: AiPresentation;
  /** 本轮明确修改的页码；这些页不再算「待补全 / 精简」。 */
  touched?: number[];
}): TemplateReport | undefined {
  const { plan, parentReport } = input;
  if (!parentReport) return undefined;

  const signature = (slide: AiPresentation["slides"][number]) => createHash("sha256").update(JSON.stringify({
    title: slide.title, lines: slide.lines ?? [], elements: slide.elements ?? [],
    sourceIds: slide.sourceIds ?? [], imageIndex: slide.imageIndex,
  })).digest("hex");

  const previous = new Map<string, { role: PageRole; seriesId?: string; layout?: SlideLayout }>();
  const parentPages = parentReport.deckPlan?.pages ?? [];
  (input.parentPlan?.slides ?? []).forEach((slide, index) => {
    const entry = parentPages.find(page => page.page === index + 1);
    if (!entry) return;
    previous.set(signature(slide), {
      role: entry.role as PageRole,
      ...(entry.seriesId ? { seriesId: entry.seriesId } : {}),
      layout: entry.layout as SlideLayout,
    });
  });

  const total = plan.slides.length;
  const contentCount = Math.max(1, total);
  const pages = plan.slides.map((slide, index) => {
    const page = index + 1;
    const matched = previous.get(signature(slide));
    // 未改动的页沿用原职责；改过的页按新标题重新推断，避免把「改成对比结构」仍记成案例。
    const role = matched?.role ?? inferRole(slide.title, "", { index, contentCount });
    const layout = (slide.layout ?? "bullets") as SlideLayout;
    return {
      page, role, layout, fitsRole: layoutFitsRole(role, layout),
      ...(matched?.seriesId ? { seriesId: matched.seriesId } : {}),
    };
  });

  const summary = summarizeRoles(pages.map(item => ({
    page: item.page, role: item.role, layout: item.layout,
    preferred: preferredLayouts(item.role),
    ...(item.seriesId ? { seriesId: item.seriesId } : {}),
  })));

  const touched = new Set(input.touched ?? []);
  const keep = (pageNumbers: number[] | undefined) =>
    (pageNumbers ?? []).filter(page => page >= 1 && page <= total && !touched.has(page));

  return {
    ...parentReport,
    // 整稿内容变了，原内容审校结论不再代表当前文件。
    audit: "unavailable",
    issues: [],
    fallbackPages: keep(parentReport.fallbackPages),
    pendingPages: keep(parentReport.pendingPages),
    overflowPages: keep(parentReport.overflowPages),
    sourceLimitedPages: keep(parentReport.sourceLimitedPages),
    notesLimitedPages: keep(parentReport.notesLimitedPages),
    deckPlan: {
      pages,
      repeatedRuns: findRepeatedRuns(pages.map(item => ({
        page: item.page, role: item.role, layout: item.layout,
        preferred: preferredLayouts(item.role),
        ...(item.seriesId ? { seriesId: item.seriesId } : {}),
      }))),
      roleDistribution: summary.distribution,
      ...(summary.concentration ? { concentration: summary.concentration } : {}),
    },
  };
}
