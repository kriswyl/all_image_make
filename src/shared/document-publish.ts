import type { TemplateReport } from "./presentation-report.js";

/**
 * B 阶段的候选 / 发布契约。
 *
 * 设计要点（对应 docs/document-reliability-development.md §5.3）：
 * - 候选是工作流产物，不进入用户文件版本链；publish 是唯一把 state 改为 published 的入口。
 * - 创建候选与正式发布使用不同幂等键（候选 operation_id 带 `candidate:` 前缀）。
 * - validationId 由可信检查器持久化，不接受模型自报 passed；null 仅用于无任务契约的普通文档。
 * - 质量状态与 ExecutionState 是两个维度，report 绑定文件 sha256 而不是「会话最新结果」。
 */

export type VisualPolicy = "background" | "before_publish";

/** before_publish 下候选等待检查时保存的发布意图：检查完成后用它发布同一份候选。 */
export type PendingPublish = {
  operationId: string;
  candidateSha256: string;
  specId?: string;
  specRevision?: number;
  baseline?: { fileId: string; sha256: string };
  validationId: string | null;
  disposition: "ready" | "draft";
  report?: TemplateReport;
  lineage?: { familyId?: string; parentId?: string };
  visualPolicy: VisualPolicy;
  expectedOwner?: string;
  createdAt: string;
  reason: string;
};

export type CandidateVisualCheck = {
  status: "waiting" | "complete" | "unavailable";
  source?: "visual-review" | "wps-render";
  summary?: string;
  blocking?: string[];
  updatedAt: string;
};

export type CandidateMeta = {
  operationId: string;
  owner: string;
  sha256: string;
  specId?: string;
  specRevision?: number;
  baseline?: { fileId: string; sha256: string };
  lease?: string;
  /** 有这份意图的候选是「等待检查」，不是普通过期候选。 */
  pendingPublish?: PendingPublish;
  visualCheck?: CandidateVisualCheck;
  updatedAt: string;
  expiresAt: string;
};

export type PublishInput = {
  conversationId: string;
  operationId: string;
  candidateId: string;
  expectedCandidateSha256: string;
  specId?: string;
  specRevision?: number;
  baseline?: { fileId: string; sha256: string };
  /** null 仅用于无任务契约的普通文档；有契约时必须指向 presentation_validations 里的结果。 */
  validationId: string | null;
  disposition: "ready" | "draft";
  report?: TemplateReport;
  lineage?: { familyId?: string; parentId?: string };
  visualPolicy?: VisualPolicy;
  /** before_publish 策略下必须给出已完成且无阻塞问题的检查结论。 */
  visualReview?: { status: "complete" | "running" | "unavailable"; blocking?: string[] };
  expectedOwner?: string;
  signal?: AbortSignal;
};

export type PublishResult = {
  fileId: string;
  familyId: string;
  version: number;
  sha256: string;
  disposition: "ready" | "draft";
  report: TemplateReport | null;
};

export const CANDIDATE_TTL_MS = 24 * 60 * 60 * 1000;
export const CANDIDATE_OPERATION_PREFIX = "candidate:";
