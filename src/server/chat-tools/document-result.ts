import type { TemplateReport } from "../../shared/presentation-report.js";

/** 三个状态分开报：文件已产出 ≠ 任务已完成；草稿可以下载但不能宣布完成。 */
export type DocumentStatus = {
  fileProduced: boolean;
  downloadableDraft: boolean;
  taskCompleted: boolean;
  disposition: "ready" | "draft";
  reason?: string;
};
export type PendingVisualCheck = { candidateId: string; operationId: string };
export type ChatDocResult = {
  ok: boolean;
  summary: string;
  paused?: boolean;
  uiData?: {
    presentation?: TemplateReport;
    workflow?: { runId: string; calls: number; tokens: number; usageMissing: boolean };
    documentStatus?: DocumentStatus;
  };
  data?: {
    fileId: string; fileName: string; byteSize: number; sha256?: string; pendingDelete?: boolean;
    disposition?: "ready" | "draft"; draft?: boolean; taskCompleted?: boolean;
  };
  /** 候选等待后台视觉检查：不是工具失败，注册层据此记为 paused 并触发检查队列。 */
  pendingVisualCheck?: PendingVisualCheck;
};

type SavedDocumentLike = {
  id: string; name: string; byteSize: number;
  report?: TemplateReport;
  disposition: "ready" | "draft";
};

/** 唯一以「保存后的最终报告」为准的状态判定。 */
export function documentStatusOf(saved: SavedDocumentLike): DocumentStatus {
  const report = saved.report;
  const draft = saved.disposition === "draft" || Boolean(report?.draft) || Boolean(report?.resume);
  return {
    fileProduced: true,
    downloadableDraft: draft,
    taskCompleted: !draft,
    disposition: draft ? "draft" : "ready",
    ...(report?.reason ? { reason: report.reason } : {}),
  };
}

/** 生成、整页编辑、对象修改、补做与 legacy 入口共用同一个结果构造。 */
export function finalDocumentResult(
  saved: SavedDocumentLike,
  options: {
    headline: string;
    details?: string;
    sha256?: string;
    paused?: boolean;
    uiData?: Record<string, unknown>;
    pendingVisualCheck?: PendingVisualCheck;
  },
): ChatDocResult {
  const status = documentStatusOf(saved);
  const reason = status.reason ? ` 尚未满足：${status.reason}` : "";
  const state = status.downloadableDraft ? `；草稿可下载，任务未完成${reason}` : "；任务已完成";
  return {
    ok: true,
    ...(options.paused ? { paused: true } : {}),
    summary: `${options.headline}${options.details ? `。${options.details}` : ""}${state}`,
    uiData: {
      ...(saved.report ? { presentation: saved.report } : {}),
      documentStatus: status,
      ...options.uiData,
    },
    data: {
      fileId: saved.id, fileName: saved.name, byteSize: saved.byteSize,
      ...(options.sha256 ? { sha256: options.sha256 } : {}),
      disposition: status.disposition, draft: status.downloadableDraft, taskCompleted: status.taskCompleted,
    },
    ...(options.pendingVisualCheck ? { pendingVisualCheck: options.pendingVisualCheck } : {}),
  };
}
