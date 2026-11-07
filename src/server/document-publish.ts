import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AppDatabase } from "./db.js";
import { safeName, workspaceDir } from "./workspace-paths.js";
import {
  CANDIDATE_TTL_MS,
  type CandidateMeta, type PublishInput, type PublishResult,
} from "../shared/document-publish.js";

/**
 * B 阶段统一发布层。docs/document-reliability-development.md §5.3：
 * - 候选是工作流产物，默认对用户隐藏；publish 是唯一把 state 改为 published 的入口。
 * - 文件系统与 SQLite 不是同一个原子事务：发布日志 + 重启对账负责补齐登记或清理孤儿。
 * - validationId 指向可信检查器保存的结果，模型自报 passed 无效。
 */

/** 安全 / 归属 / 原文件保护类失败，不允许用显式 draft 分支绕过。 */
const BLOCKING_FAILURES = new Set(["SPEC_OWNERSHIP", "SPEC_REVISION", "SCOPE_VIOLATION", "REQUIRED_ASSET", "UNPLACED_IMAGES"]);

export class PublishPending extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishPending";
  }
}

export type CandidateInput = {
  conversationId: string;
  name: string;
  ext: string;
  bytes: Buffer;
  operationId?: string;
  owner?: string;
  specId?: string;
  specRevision?: number;
  baseline?: { fileId: string; sha256: string };
  /** 执行中的租约：有租约的候选不按 TTL 自动清理。 */
  lease?: string;
  ttlMs?: number;
};

export type CreatedCandidate = {
  id: string;
  operationId: string;
  sha256: string;
  full: string;
  meta: CandidateMeta;
};

function nowIso() {
  return new Date().toISOString();
}

function sha256Of(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 创建候选：先原子写文件，再登记 state='candidate'。失败时清掉文件，不留半份产物。 */
export function createCandidateDocument(db: AppDatabase, input: CandidateInput): CreatedCandidate {
  const sha256 = sha256Of(input.bytes);
  const operationId = input.operationId ?? `auto:${randomUUID()}`;
  // 创建候选也有自己的幂等键：同操作同字节直接复用；字节变了则旧候选与其检查结果一并作废。
  const existing = input.operationId ? db.getCandidateByOperation(input.conversationId, input.operationId) : null;
  if (existing) {
    const existingRoot = path.resolve(existing.baseDir || db.documentsDir);
    const existingFull = path.join(path.resolve(existingRoot, input.conversationId), existing.name);
    if (existing.meta?.sha256 === sha256 && fs.existsSync(existingFull)) {
      return { id: existing.id, operationId, sha256, full: existingFull, meta: existing.meta };
    }
    fs.rmSync(existingFull, { force: true });
    db.deleteCandidateDocument(existing.id);
  }
  const dir = workspaceDir(db, input.conversationId);
  const safe = safeName(input.name, input.ext);
  const stamp = nowIso().replace(/[:.]/g, "-");
  const createdAt = nowIso();
  const meta: CandidateMeta = {
    operationId,
    owner: input.owner ?? operationId,
    sha256,
    ...(input.specId ? { specId: input.specId } : {}),
    ...(input.specRevision !== undefined ? { specRevision: input.specRevision } : {}),
    ...(input.baseline ? { baseline: input.baseline } : {}),
    ...(input.lease ? { lease: input.lease } : {}),
    updatedAt: createdAt,
    expiresAt: new Date(Date.now() + (input.ttlMs ?? CANDIDATE_TTL_MS)).toISOString(),
  };
  for (let i = 0; i < 1000; i++) {
    const fileName = `${stamp}-${i ? `${i}-` : ""}${safe}`;
    const full = path.join(dir, fileName);
    try {
      // 直接用 wx 原子创建：目标已存在就失败，不会覆盖或写出半文件。
      // 不再创建 `.pending-` 临时文件 —— 正常保存路径零删除操作，
      // 避免高频删除触发宿主环境的安全守卫，导致保存被中断、本轮无产物。
      fs.writeFileSync(full, input.bytes, { flag: "wx" });
      try {
        const saved = db.addCandidateDocument({
          conversationId: input.conversationId, fileName, byteSize: input.bytes.length,
          baseDir: path.dirname(dir), operationId, meta,
        });
        return { id: saved.id, operationId, sha256, full, meta };
      } catch (error) {
        fs.rmSync(full, { force: true });
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
  throw new Error("无法创建候选文件，请稍后重试");
}

/** 读取候选磁盘字节，同时做与 readWorkspaceFile 相同的路径安全校验。 */
function readCandidateBytes(db: AppDatabase, conversationId: string, candidate: { name: string; baseDir: string }): Buffer {
  const root = path.resolve(candidate.baseDir || db.documentsDir);
  const dir = path.resolve(root, conversationId);
  const full = path.join(dir, candidate.name);
  if (path.dirname(full).toLowerCase() !== dir.toLowerCase()) throw new Error("候选文件路径越界");
  const stat = fs.lstatSync(full);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("候选文件不安全");
  return fs.readFileSync(full);
}

/** publish：唯一把 state 改为 published 的入口。返回前复核输入、检查结果、执行所有权与取消状态。 */
export function publishDocument(db: AppDatabase, input: PublishInput): PublishResult {
  input.signal?.throwIfAborted();

  // 1. 正式发布幂等：同一 operationId 只产生一个文件版本，晚到结果不刷版本。
  const log = db.getPublishLog(input.conversationId, input.operationId);
  if (log?.publishedId) {
    const file = db.getWorkspaceDocument(input.conversationId, log.publishedId);
    if (file) {
      const version = db.getPresentationVersion(input.conversationId, file.id)?.report ?? null;
      return {
        fileId: file.id, familyId: file.familyId, version: file.version,
        sha256: log.candidateSha256, disposition: log.disposition, report: version,
      };
    }
  }

  // 2. 候选必须存在且仍属于本次会话。
  const candidate = db.getCandidateById(input.conversationId, input.candidateId);
  if (!candidate || !candidate.meta) throw new Error("候选不存在或已被发布");
  const meta = candidate.meta;
  if (meta.operationId !== input.operationId) throw new Error("候选的幂等键与本次发布不一致");

  // 3. 候选变更后旧检查全部作废：磁盘字节、期望哈希、候选登记三者必须一致。
  const bytes = readCandidateBytes(db, input.conversationId, candidate);
  const sha256 = sha256Of(bytes);
  if (sha256 !== input.expectedCandidateSha256 || sha256 !== meta.sha256) {
    throw new Error("候选内容已变化，旧的检查结果不能用于发布");
  }

  // 4. 执行所有权与契约归属。
  if (input.expectedOwner && input.expectedOwner !== meta.owner) throw new Error("候选不属于当前执行，拒绝发布");
  if (input.specId && meta.specId !== input.specId) throw new Error("候选绑定的任务契约与本次发布不一致");
  if (input.specRevision !== undefined && meta.specRevision !== input.specRevision) throw new Error("候选绑定的契约版本与本次发布不一致");
  if (input.baseline && (meta.baseline?.fileId !== input.baseline.fileId || meta.baseline?.sha256 !== input.baseline.sha256)) {
    throw new Error("基线文件与创建候选时登记的不一致");
  }

  // 5. 可信检查结果。有契约却没有 validationId 一律拒绝；安全类失败不允许 draft 绕过。
  if (input.validationId) {
    const validation = db.specs.getValidation(input.validationId);
    if (!validation) throw new Error("找不到可信检查结果，拒绝发布");
    if (validation.fileSha256 !== sha256) throw new Error("检查结果绑定的不是这份候选字节");
    if (input.specId && validation.specId !== input.specId) throw new Error("检查结果属于另一份任务契约");
    if (input.specRevision !== undefined && validation.specRevision !== input.specRevision) throw new Error("检查结果属于另一个契约版本");
    const blocking = validation.failures.filter(item => BLOCKING_FAILURES.has(item.code));
    if (blocking.length) throw new Error(`安全或归属检查未通过，不能以草稿绕过：${blocking.map(item => item.detail).join("；")}`);
    if (!validation.ok && input.disposition === "ready") throw new Error("必需约束未通过，不能发布为可用成品");
  } else if (input.specId) {
    throw new Error("有任务契约的发布必须提供可信检查结果");
  }

  // 6. 视觉策略：before_publish 下未完成检查只能等待，未检查不得标成已验证成品。
  if (input.visualPolicy === "before_publish") {
    const review = input.visualReview;
    if (review?.status !== "complete" || review.blocking?.length) {
      throw new PublishPending("视觉检查尚未完成，候选等待检查；可交付明确标注未检查的草稿");
    }
  }
  input.signal?.throwIfAborted();

  const published = db.publishCandidateDocument({
    conversationId: input.conversationId,
    candidateId: input.candidateId,
    operationId: input.operationId,
    familyId: input.lineage?.familyId,
    parentId: input.lineage?.parentId,
    ...(input.report ? { presentation: { sha256, report: input.report } } : {}),
    log: {
      candidateSha256: sha256, targetName: candidate.name,
      validationId: input.validationId, disposition: input.disposition,
    },
  });
  return {
    fileId: published.fileId, familyId: published.familyId, version: published.version,
    sha256, disposition: input.disposition, report: input.report ?? null,
  };
}

export type ReconcileResult = { removedOrphans: string[]; staleLogs: string[] };

/**
 * 重启对账：核对候选登记与磁盘字节，清理未发布孤儿；不重新生成、不重复增加版本。
 * 发布日志里指向的正式文件若已被外部删除，只登记为待核对，不擅自重建。
 */
export function reconcileCandidates(db: AppDatabase): ReconcileResult {
  const result: ReconcileResult = { removedOrphans: [], staleLogs: [] };
  for (const candidate of db.listCandidateDocuments()) {
    const root = path.resolve(candidate.baseDir || db.documentsDir);
    const full = path.join(path.resolve(root, candidate.conversationId), candidate.name);
    if (!fs.existsSync(full)) {
      if (db.deleteCandidateDocument(candidate.id)) result.removedOrphans.push(candidate.id);
      continue;
    }
    // 发布已完成但登记残留（例如旧版本中断在 COMMIT 前后）时，不重复增加版本，只清掉候选标记。
    const log = candidate.meta ? db.getPublishLog(candidate.conversationId, candidate.meta.operationId) : null;
    if (log?.publishedId && log.publishedId !== candidate.id && db.getWorkspaceDocument(candidate.conversationId, log.publishedId)) {
      if (db.deleteCandidateDocument(candidate.id)) result.removedOrphans.push(candidate.id);
    }
  }
  return result;
}

/** TTL 清理：只删已终止、无租约、过期的候选；有 lease 或家族活跃引用的产物保留。 */
export function cleanupExpiredCandidates(db: AppDatabase, at = Date.now()): string[] {
  const removed: string[] = [];
  for (const candidate of db.listCandidateDocuments()) {
    const meta = candidate.meta;
    if (!meta) continue;
    if (meta.lease) continue;
    if (Date.parse(meta.expiresAt) > at) continue;
    if (db.specs?.hasActiveFamilyRef(candidate.id)) continue;
    const root = path.resolve(candidate.baseDir || db.documentsDir);
    const full = path.join(path.resolve(root, candidate.conversationId), candidate.name);
    try { fs.rmSync(full, { force: true }); } catch { /* 文件已不存在 */ }
    if (db.deleteCandidateDocument(candidate.id)) removed.push(candidate.id);
  }
  return removed;
}
