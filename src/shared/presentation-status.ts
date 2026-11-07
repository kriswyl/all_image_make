import type { PresentationVisualCheck, TemplateReport } from "./presentation-report.js";

/**
 * 质量状态与执行状态是两个维度，统一在这里投影给 UI：
 * 「任务执行完成」不代表「文件可作为成品使用」，更不代表「视觉检查已通过」。
 */
export type PresentationReadiness = "ready" | "draft" | "unknown";

export type PresentationStatusView = {
  readiness: PresentationReadiness;
  label: string;
  dimensions: { file: PresentationReadiness; visual: string; contract: boolean };
  coverage?: { required: number; satisfied: number; unknown: number };
  timeline: {
    draftReadyAt?: string; usableReadyAt?: string;
    requiredWorkCompletedAt?: string; optionalVisualCompletedAt?: string;
  };
};

const labels: Record<PresentationReadiness, string> = {
  ready: "可用成品",
  draft: "草稿 · 未满足契约",
  unknown: "未校验契约",
};

export function projectPresentationStatus(
  report: TemplateReport, visual?: PresentationVisualCheck,
): PresentationStatusView {
  const readiness: PresentationReadiness = report.readiness ?? "unknown";
  return {
    readiness,
    label: labels[readiness],
    dimensions: {
      file: readiness,
      visual: visual?.status ?? "unknown",
      contract: Boolean(report.contractValidation),
    },
    ...(report.visibleCoverage ? { coverage: report.visibleCoverage } : {}),
    timeline: {
      ...(report.draftReadyAt ? { draftReadyAt: report.draftReadyAt } : {}),
      ...(report.usableReadyAt ? { usableReadyAt: report.usableReadyAt } : {}),
      ...(report.requiredWorkCompletedAt ? { requiredWorkCompletedAt: report.requiredWorkCompletedAt } : {}),
      ...(report.optionalVisualCompletedAt ? { optionalVisualCompletedAt: report.optionalVisualCompletedAt } : {}),
    },
  };
}
