import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AppDatabase } from "../db.js";
import { type AiPresentation, type MindDocument } from "../mind-document.js";
import type { TemplateReport, VisualReviewMetrics } from "../../shared/presentation-report.js";
import { checkPresentationContract, type RequirementVerdict } from "../presentation-contract-check.js";
import { createCandidateDocument, markPendingPublish, publishDocument, PublishPending } from "../document-publish.js";
import { resolveContractSpec, type SpecBinding } from "../presentation-contract-resolution.js";
import { type CheckSets } from "../../shared/change-scope.js";

const MAX_FILE = 20 * 1024 * 1024;

/** Accept the file IDs models commonly shorten from doc_read / doc_list output. */
export function resolveDocumentId(db: AppDatabase, conversationId: string, id: string) {
  if (db.getWorkspaceDocument(conversationId, id)) return id;
  const upload = db.getConversationDocument(id);
  if (upload?.conversationId === conversationId) return id;
  const ids = [...new Set([
    ...db.listWorkspaceDocuments(conversationId).map(item => item.id),
    ...db.listConversationDocuments(conversationId).map(item => item.id),
  ])];
  const matches = ids.filter(item => item.startsWith(id));
  return matches.length === 1 ? matches[0]! : id;
}

export function readWorkspaceFile(db: AppDatabase, conversationId: string, fileId: string) {
  const entry = db.getWorkspaceDocument(conversationId, fileId); if (!entry) throw new Error("文件不存在或不属于当前会话");
  const root = path.resolve((entry as { baseDir?: string }).baseDir || db.documentsDir);
  const dir = path.resolve(root, conversationId); const full = path.join(dir, entry.name);
  const stat = fs.lstatSync(full);
  if (path.dirname(full).toLowerCase() !== dir.toLowerCase() || stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE) throw new Error("文件路径不安全或文件超过大小限制");
  return { ...entry, bytes: fs.readFileSync(full), full };
}
export type ContractCheckContext = {
  plan: AiPresentation;
  baselinePlan?: AiPresentation;
  targets?: number[];
  expectedSpecId?: string;
  expectedSpecRevision?: number;
  /** B：用户明确要求「检查完成再交付」时传 before_publish，默认走 Spec 的策略。 */
  visualPolicy?: "background" | "before_publish";
  /** A：本次执行绑定的契约版本；缺省时才回退到「会话当前活动契约」。 */
  specRef?: SpecBinding;
  /**
   * 素材身份绑定：assetId → imageIndex + 图片字节哈希。
   * cover 表示这张图是封面；门禁据此核对「是不是用户指定的那张、哈希是否一致」。
   */
  assetBindings?: Array<{ assetId: string; imageIndex: number; sha256: string; cover?: boolean }>;
  /** 内容审校等可信核验给出的语义结论，门禁按哈希 + revision + 要求 ID 绑定。 */
  requirementVerifications?: RequirementVerdict[];
  visualReview?: { status: "complete" | "running" | "unavailable"; blocking?: string[] };
  /** C：由服务端推导的三个检查集合，写进报告供性能验收核对。 */
  checkSets?: CheckSets;
  /** C：视觉阶段实际用量（模型调用页数、缓存命中、WPS 导出页数与耗时）。 */
  visualMetrics?: VisualReviewMetrics;
};

export function saveWorkspaceDocument(db: AppDatabase, conversationId: string, name: string, ext: string, bytes: Buffer, operationId?: string, report?: TemplateReport, lineage?: { familyId?: string; parentId?: string }, contract?: ContractCheckContext) {
  // B：正式发布幂等。getByOperation 只认 published，晚到结果不会把候选误当成成功产物。
  if (operationId) {
    const previous = db.getWorkspaceDocumentByOperation(conversationId, operationId);
    if (previous) {
      const stored = readWorkspaceFile(db, conversationId, previous.id);
      if (report) db.addPresentationVersion(previous.id, createHash("sha256").update(stored.bytes).digest("hex"), report);
      // 幂等重放也必须返回磁盘上的最终报告，调用方不能拿检查前的报告宣布完成。
      const storedReport = db.getPresentationVersion(conversationId, previous.id)?.report ?? report;
      return {
        ...previous,
        ...(storedReport ? { report: storedReport } : {}),
        disposition: (storedReport && !storedReport.draft ? "ready" : "draft") as "ready" | "draft",
      };
    }
  }
  if (bytes.length > MAX_FILE) throw new Error("单个文件不能超过 20 MB");
  // 候选仍计入磁盘容量配额，防止用隐藏状态绕过限制。
  const allFiles = db.listWorkspaceDocuments(conversationId, { includeCandidates: true });
  if (allFiles.length >= 200 || allFiles.reduce((sum, file) => sum + file.byteSize, 0) + bytes.length > 200 * 1024 * 1024) throw new Error("会话文档数量或总容量已达上限");

  // 唯一必经的契约解析入口：显式绑定失效会直接抛错，绝不降级成「无契约」；
  // 只有真正没有绑定的旧文件才允许按会话 active 走兼容路径。
  const resolved = contract && ext === "pptx"
    ? resolveContractSpec(db, conversationId, {
      specRef: contract.specRef,
      expectedSpecId: contract.expectedSpecId, expectedSpecRevision: contract.expectedSpecRevision,
    })
    : null;
  const spec = resolved?.spec ?? null;
  // 1. 创建候选：只属于工作流产物，不进入用户文件版本链。
  const created = createCandidateDocument(db, {
    conversationId, name, ext, bytes, operationId,
    owner: operationId ?? "ad-hoc",
    ...(spec ? { specId: spec.specId, specRevision: spec.revision } : {}),
  });

  // 2. 统一硬检查（A 门禁），结果持久化成 validationId 供 publish 复核。
  let effectiveReport = report;
  let validationId: string | null = null;
  let validationOk = true;
  if (contract && ext === "pptx" && spec) {
    const checked = checkPresentationContract(db.specs, {
      conversationId, spec, plan: contract.plan, bytes, report,
      baselinePlan: contract.baselinePlan, targets: contract.targets,
      expectedSpecId: contract.expectedSpecId, expectedSpecRevision: contract.expectedSpecRevision,
      assetBindings: contract.assetBindings,
      requirementVerifications: contract.requirementVerifications,
    });
    if (checked.blocking.length) throw new Error(`文档契约校验未通过：${checked.blocking.map(item => item.detail).join("；")}`);
    if (checked.validation) {
      const validation = checked.validation;
      validationId = validation.validationId;
      validationOk = validation.ok;
      const failures = validation.failures.map(item => item.detail).join("；");
      const base: TemplateReport = report ?? {
        draft: false, resume: false, fallbackPages: [], pendingPages: [], overflowPages: [],
        sourceLimitedPages: [], notesLimitedPages: [], unplacedImages: 0,
        planningFallback: false, audit: "unavailable", issues: [],
      };
      const at = new Date().toISOString();
      effectiveReport = {
        ...base,
        draft: !validation.ok, resume: !validation.ok, ...(failures ? { reason: failures } : {}),
        contractValidation: validation.validationId,
        specRef: { specId: spec.specId, specRevision: spec.revision },
        readiness: validation.readiness, visibleCoverage: validation.visibleCoverage,
        ...(contract.checkSets ? { checkSets: {
          contentPages: contract.checkSets.contentPages, auditPages: contract.checkSets.auditPages,
          visualPages: contract.checkSets.visualPages, widened: contract.checkSets.widened,
          reason: contract.checkSets.reason,
        } } : {}),
        ...(contract.visualMetrics ? { metrics: {
          visual: {
            pages: contract.visualMetrics.pages, modelCalls: contract.visualMetrics.modelCalls,
            cacheHits: contract.visualMetrics.cacheHits, modelMs: contract.visualMetrics.modelMs,
          },
          wps: contract.visualMetrics.wps,
        } } : {}),
        ...(validation.ok
          ? { usableReadyAt: at, requiredWorkCompletedAt: at }
          : { draftReadyAt: at }),
      };
    }
  }

  // 3. publish 是唯一把 state 改为 published 的入口；失败的必需约束只走显式 draft 分支。
  const publishInput = {
    conversationId,
    operationId: created.operationId,
    candidateId: created.id,
    expectedCandidateSha256: created.sha256,
    ...(spec ? { specId: spec.specId, specRevision: spec.revision } : {}),
    validationId,
    disposition: (validationOk ? "ready" : "draft") as "ready" | "draft",
    // 策略以 Spec 为准；未传时不能再默认「直接发布」。
    ...((contract?.visualPolicy ?? spec?.visualPolicy) ? { visualPolicy: (contract?.visualPolicy ?? spec!.visualPolicy) } : {}),
    ...(contract?.visualReview ? { visualReview: contract.visualReview } : {}),
    ...(effectiveReport ? { report: effectiveReport } : {}),
    lineage,
  };
  let published;
  try {
    published = publishDocument(db, publishInput);
  } catch (error) {
    if (error instanceof PublishPending) {
      // 等待不是失败：把发布意图持久化下来，检查完成后发布同一候选。
      markPendingPublish(db, publishInput, error.message);
    }
    throw error;
  }
  if (contract && ext === "pptx" && spec) db.specs.bindFamilyOnly(spec.specId, published.familyId);
  const saved = db.getWorkspaceDocument(conversationId, published.fileId);
  if (!saved) throw new Error("发布后找不到正式文件");
  // 把门禁算出的最终报告和处置结果一起返回：
  // 否则调用方会拿「检查前的报告」去宣布完成，而数据库里其实是草稿。
  return {
    ...saved,
    ...(effectiveReport ? { report: effectiveReport } : {}),
    disposition: (validationOk ? "ready" : "draft") as "ready" | "draft",
  };
}
export function documentSource(db: AppDatabase, conversationId: string, rawId: string): { name: string; bytes?: Buffer; mind?: MindDocument } {
  const id = resolveDocumentId(db, conversationId, rawId);
  const item = db.getWorkspaceDocument(conversationId, id);
  if (item) return readWorkspaceFile(db, conversationId, id);
  const doc = db.getConversationDocument(id);
  if (!doc || doc.conversationId !== conversationId) throw new Error("文件不存在或不属于当前会话");
  if (/\.(txt|md|markdown|csv|json)$/i.test(doc.fileName)) return { name: doc.fileName, bytes: Buffer.from(doc.content, "utf8") };
  if (/\.(pptx|docx|xlsx|pdf)$/i.test(doc.fileName)) {
    const bytes = db.getConversationDocumentFile(id);
    if (!bytes) throw new Error("附件原文件不可用，请重新上传");
    return { name: doc.fileName, bytes };
  }
  if (!/\.xmind$/i.test(doc.fileName)) throw new Error("暂不支持该文件格式");
  const original = db.getConversationDocumentFile(id);
  if (original) return { name: doc.fileName, bytes: original };
  const mind = JSON.parse(doc.content) as MindDocument;
  if (mind.format !== "xmind") throw new Error("导图内容无效");
  return { name: doc.fileName, mind };
}
