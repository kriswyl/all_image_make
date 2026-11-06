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
  visualReview: z.object({
    status: z.enum(["complete", "partial", "unavailable"]), summary: z.string(),
    issues: z.array(presentationIssueSchema), revisedFileId: z.string().optional(),
  }).optional(),
});
export type TemplateReport = z.infer<typeof presentationReportSchema>;
export type PresentationVisualCheck = {
  status: "queued" | "running" | "checked" | "unavailable";
  summary: string;
  issues?: Array<z.infer<typeof presentationIssueSchema>>;
};
export type PresentationVersionReport = { sha256: string; report: TemplateReport; visual: PresentationVisualCheck };
