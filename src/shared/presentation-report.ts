import { z } from "zod";

const page = z.number().int().min(1).max(200);
export const presentationIssueSchema = z.object({ page, detail: z.string().min(1).max(180) });
export const presentationReportSchema = z.object({
  draft: z.boolean(), resume: z.boolean(), reason: z.string().optional(),
  fallbackPages: z.array(page), pendingPages: z.array(page), overflowPages: z.array(page),
  sourceLimitedPages: z.array(page), notesLimitedPages: z.array(page),
  unplacedImages: z.number().int().nonnegative(), planningFallback: z.boolean(),
  audit: z.enum(["complete", "partial", "unavailable"]), issues: z.array(presentationIssueSchema),
  repairedPages: z.array(page).optional(),
  // A：任务契约的验证结果。均为可选，旧报告与历史文件保持可读。
  contractValidation: z.string().optional(),
  specRef: z.object({ specId: z.string(), specRevision: z.number().int().positive() }).optional(),
  readiness: z.enum(["ready", "draft"]).optional(),
  visibleCoverage: z.object({
    required: z.number().int().nonnegative(),
    satisfied: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  }).optional(),
  // C：本次任务的内容生成 / 内容审校 / 视觉检查页面集合，全部是原始页码。
  checkSets: z.object({
    contentPages: z.array(z.number().int().positive()),
    auditPages: z.array(z.number().int().positive()),
    visualPages: z.array(z.number().int().positive()),
    widened: z.boolean(),
    reason: z.string(),
  }).optional(),
  // D2：实际使用的主题令牌。写进报告才能核对「换了风格到底变了什么」。
  theme: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    /** 用户/模型要求的风格文本，与 id 一起记下来便于回溯 */
    requested: z.string().optional(),
  }).optional(),
  // D1：整稿页面职责与布局计划。repeatedRuns 只作提示，不阻断交付（§6.3 D3）。
  deckPlan: z.object({
    pages: z.array(z.object({
      page,
      role: z.string(),
      layout: z.string(),
      seriesId: z.string().optional(),
      /** 版式是否落在该职责的候选集合内；false 只报告。 */
      fitsRole: z.boolean(),
    })),
    repeatedRuns: z.array(z.object({
      start: page, end: page, layout: z.string(), roles: z.array(z.string()), pages: z.array(page),
    })),
    /** D1：职责分布与集中度提示。单一职责占比过高时，连续同构图规则会失效。 */
    roleDistribution: z.record(z.string(), z.number().int().nonnegative()).optional(),
    concentration: z.object({ role: z.string(), count: z.number().int().positive(), ratio: z.number() }).optional(),
  }).optional(),
  // C：§7.4 性能口径。视觉阶段记实际提交模型的页集合与调用/缓存，
  // WPS 记渲染次数与导出页数 —— 整稿加载要如实记录，不能宣称只处理一页。
  metrics: z.object({
    visual: z.object({
      pages: z.array(page),
      modelCalls: z.number().int().nonnegative(),
      cacheHits: z.number().int().nonnegative(),
      modelMs: z.number().int().nonnegative(),
    }),
    wps: z.object({
      renders: z.number().int().nonnegative(),
      exportedPages: z.number().int().nonnegative(),
      renderMs: z.number().int().nonnegative(),
    }),
  }).optional(),
  // 三个耗时口径分开记，避免把「能打开文件的草稿」算成可用成品。
  draftReadyAt: z.string().optional(),
  usableReadyAt: z.string().optional(),
  requiredWorkCompletedAt: z.string().optional(),
  optionalVisualCompletedAt: z.string().optional(),
  visualReview: z.object({
    status: z.enum(["complete", "partial", "unavailable"]), summary: z.string(),
    issues: z.array(presentationIssueSchema), revisedFileId: z.string().optional(),
  }).optional(),
});
export type TemplateReport = z.infer<typeof presentationReportSchema>;
/** C：视觉阶段实际提交的页面集合与模型/WPS 用量。 */
export type VisualStageMetrics = { pages: number[]; modelCalls: number; cacheHits: number; modelMs: number };
export type WpsStageMetrics = { renders: number; exportedPages: number; renderMs: number };
export type VisualReviewMetrics = VisualStageMetrics & { wps: WpsStageMetrics };
export type PresentationVisualCheck = {
  status: "queued" | "running" | "checked" | "unavailable";
  summary: string;
  issues?: Array<z.infer<typeof presentationIssueSchema>>;
};
export type PresentationVersionReport = { sha256: string; report: TemplateReport; visual: PresentationVisualCheck };
