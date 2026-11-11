import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { CANDIDATE_OPERATION_PREFIX, type CandidateMeta, type PendingPublish } from "../shared/document-publish.js";
import type { PresentationVersionReport, PresentationVisualCheck, TemplateReport } from "../shared/presentation-report.js";
import type { PresentationSpecStore } from "./presentation-spec-store.js";
import { now, parseJson, type DbRow } from "./db-row.js";

export interface StoredDocument {
  id: string;
  conversationId: string;
  fileName: string;
  content: string;
  charCount: number;
  createdAt: string;
}

export type CreateCandidateRecord = {
  conversationId: string; fileName: string; byteSize: number; baseDir: string;
  operationId: string; meta: CandidateMeta;
};

export type PendingVisualPublishRecord = { candidateId: string; conversationId: string; operationId: string; payload: PendingPublish };

export type PublishCandidateRecord = {
  conversationId: string; candidateId: string; operationId: string;
  familyId?: string; parentId?: string;
  presentation?: { sha256: string; report: TemplateReport };
  log: { candidateSha256: string; targetName: string; validationId: string | null; disposition: "ready" | "draft" };
};

/** 旧文档绑定原目录及版本家族，目录设置改动后仍可读取。 */
export function initializeLegacyWorkspace(db: DatabaseSync, defaultDocumentsDir: string) {
  db.prepare("UPDATE workspace_documents SET base_dir = ? WHERE base_dir IS NULL OR base_dir = ''").run(defaultDocumentsDir);
  const rows = db.prepare("SELECT id, conversation_id, file_name FROM workspace_documents WHERE family_id IS NULL OR family_id = ''").all() as DbRow[];
  if (!rows.length) return;
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const base = String(row.file_name)
      .replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-(?:\d+-)?/, "")
      .replace(/^草稿-/, "")
      .replace(/(?:-修改版)+(?=\.[^.]+$)/i, "")
      .replace(/\.[^.]+$/, "");
    const key = `${row.conversation_id}::${base || row.id}`;
    const entries = groups.get(key) ?? [];
    entries.push(String(row.id));
    groups.set(key, entries);
  }
  const update = db.prepare("UPDATE workspace_documents SET family_id = ? WHERE id = ?");
  for (const [key, ids] of groups) {
    if (ids.length < 2) continue;
    const family = `legacy-${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
    for (const id of ids) update.run(family, id);
  }
}

export class DocumentRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly getDocumentsDir: () => string,
    private readonly specs: Pick<PresentationSpecStore, "hasActiveFamilyRef">,
  ) {}

  private get currentDocumentsDir() {
    return this.getDocumentsDir();
  }

  getPresentationBatch(conversationId: string, key: string): string | null {
    const row = this.db.prepare("SELECT content FROM presentation_batch_cache WHERE conversation_id = ? AND cache_key = ?").get(conversationId, key) as DbRow | undefined;
    return row ? String(row.content) : null;
  }

  addPresentationVersion(fileId: string, sha256: string, report: TemplateReport) {
    const visual: PresentationVisualCheck = { status: "queued", summary: "等待本机 WPS 检查" };
    this.db.prepare("INSERT OR IGNORE INTO presentation_versions (file_id, sha256, report, visual, visual_state) VALUES (?, ?, ?, ?, ?)").run(fileId, sha256, JSON.stringify(report), JSON.stringify(visual), visual.status);
  }

  getPresentationVersion(conversationId: string, fileId: string): PresentationVersionReport | null {
    const row = this.db.prepare("SELECT v.sha256, v.report, v.visual FROM presentation_versions v JOIN workspace_documents f ON f.id = v.file_id WHERE f.conversation_id = ? AND v.file_id = ?").get(conversationId, fileId) as DbRow | undefined;
    return row ? { sha256: String(row.sha256), report: JSON.parse(String(row.report)), visual: JSON.parse(String(row.visual)) } : null;
  }

  updatePresentationAudit(fileId: string, sha256: string, report: TemplateReport) {
    return Number(this.db.prepare("UPDATE presentation_versions SET report = ? WHERE file_id = ? AND sha256 = ?").run(JSON.stringify(report), fileId, sha256).changes) > 0;
  }

  queuePresentationCheck(fileId: string, from: "unavailable" | "running") {
    const visual: PresentationVisualCheck = { status: "queued", summary: "等待本机 WPS 检查" };
    this.db.prepare("UPDATE presentation_versions SET visual = ?, visual_state = ?, lease = NULL WHERE file_id = ? AND visual_state = ?").run(JSON.stringify(visual), visual.status, fileId, from);
  }

  claimPresentationCheck(lease: string) {
    const visual: PresentationVisualCheck = { status: "running", summary: "WPS 正在检查已交付的文件" };
    const row = this.db.prepare(`UPDATE presentation_versions SET visual = ?, visual_state = ?, lease = ?
      WHERE file_id = (SELECT file_id FROM presentation_versions WHERE visual_state = 'queued' ORDER BY rowid LIMIT 1)
      RETURNING file_id, sha256, (SELECT conversation_id FROM workspace_documents WHERE id = file_id) AS conversation_id`)
      .get(JSON.stringify(visual), visual.status, lease) as DbRow | undefined;
    return row ? { fileId: String(row.file_id), sha256: String(row.sha256), conversationId: String(row.conversation_id) } : null;
  }

  finishPresentationCheck(fileId: string, lease: string, visual: PresentationVisualCheck) {
    this.db.prepare("UPDATE presentation_versions SET visual = ?, visual_state = ?, lease = NULL WHERE file_id = ? AND lease = ?")
      .run(JSON.stringify(visual), visual.status, fileId, lease);
  }

  recoverPresentationChecks() {
    const rows = this.db.prepare("SELECT file_id FROM presentation_versions WHERE visual_state = 'running'").all() as DbRow[];
    for (const row of rows) this.queuePresentationCheck(String(row.file_id), "running");
  }

  getPresentationResume(conversationId: string): import("./presentation-execution.js").PresentationResume | null {
    const row = this.db.prepare("SELECT payload FROM presentation_resumes WHERE conversation_id = ?").get(conversationId) as DbRow | undefined;
    return row ? JSON.parse(String(row.payload)) : null;
  }

  savePresentationResume(conversationId: string, resume: import("./presentation-execution.js").PresentationResume) {
    this.db.prepare("INSERT OR REPLACE INTO presentation_resumes (conversation_id, payload) VALUES (?, ?)").run(conversationId, JSON.stringify(resume));
  }

  clearPresentationResume(conversationId: string) {
    this.db.prepare("DELETE FROM presentation_resumes WHERE conversation_id = ?").run(conversationId);
  }

  savePresentationBatch(conversationId: string, key: string, content: string): void {
    if (content.length > 200_000) throw new Error("PPT 规划结果过大，无法保存断点");
    this.db.prepare("INSERT OR REPLACE INTO presentation_batch_cache (conversation_id, cache_key, content, created_at) VALUES (?, ?, ?, ?)").run(conversationId, key, content, now());
    this.db.prepare("DELETE FROM presentation_batch_cache WHERE conversation_id = ? AND rowid NOT IN (SELECT rowid FROM presentation_batch_cache WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1600)").run(conversationId, conversationId);
  }

  // ── 脚本文档与分镜表 ──────────────────────────────────────────────────────

  addConversationDocument(conversationId: string, fileName: string, content: string): StoredDocument {
    const id = crypto.randomUUID();
    const at = now();
    this.db.prepare(`
      INSERT INTO conversation_documents (id, conversation_id, file_name, content, char_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, conversationId, fileName, content, content.length, at);
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, conversationId);
    return { id, conversationId, fileName, content, charCount: content.length, createdAt: at };
  }

  addBinaryConversationDocument(conversationId: string, fileName: string, content: string, bytes: Buffer): StoredDocument {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const document = this.addConversationDocument(conversationId, fileName, content);
      this.db.prepare("INSERT INTO conversation_document_files (document_id, data) VALUES (?, ?)").run(document.id, bytes);
      this.db.exec("COMMIT");
      return document;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  getConversationDocumentFile(documentId: string): Buffer | null {
    const row = this.db.prepare("SELECT data FROM conversation_document_files WHERE document_id = ?").get(documentId) as DbRow | undefined;
    return row?.data ? Buffer.from(row.data as unknown as Uint8Array) : null;
  }

  getConversationDocumentPlan(documentId: string): string | null {
    const row = this.db.prepare("SELECT plan_json FROM conversation_document_plans WHERE document_id = ?").get(documentId) as DbRow | undefined;
    return row ? String(row.plan_json) : null;
  }

  setConversationDocumentPlan(documentId: string, plan: string): void {
    this.db.prepare("INSERT INTO conversation_document_plans (document_id, plan_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(document_id) DO UPDATE SET plan_json = excluded.plan_json, updated_at = excluded.updated_at").run(documentId, plan, now());
  }

  addDocumentOutput(documentId: string, fileName: string, data: Buffer): string {
    const id = crypto.randomUUID();
    this.db.prepare("INSERT INTO conversation_document_outputs (id, document_id, file_name, data, created_at) VALUES (?, ?, ?, ?, ?)").run(id, documentId, fileName, data, now());
    return id;
  }

  getDocumentOutput(id: string): { documentId: string; fileName: string; data: Buffer } | null {
    const row = this.db.prepare("SELECT document_id, file_name, data FROM conversation_document_outputs WHERE id = ?").get(id) as DbRow | undefined;
    return row ? { documentId: String(row.document_id), fileName: String(row.file_name), data: Buffer.from(row.data as unknown as Uint8Array) } : null;
  }

  addWorkspaceDocument(conversationId: string, fileName: string, byteSize: number, operationId?: string, presentation?: { sha256: string; report: TemplateReport }, baseDir = this.currentDocumentsDir, lineage?: { familyId?: string; parentId?: string }): { id: string; name: string; byteSize: number; createdAt: string; baseDir: string; familyId: string; version: number } {
    const id = crypto.randomUUID(); const createdAt = now();
    const familyId = lineage?.familyId ?? id;
    let version = 1;
    if (lineage?.parentId) {
      const row = this.db.prepare("SELECT MAX(version) AS version FROM workspace_documents WHERE conversation_id = ? AND family_id = ?").get(conversationId, familyId) as DbRow | undefined;
      version = Number(row?.version ?? 0) + 1;
    }
    if (presentation) this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO workspace_documents (id, conversation_id, file_name, byte_size, created_at, operation_id, base_dir, family_id, parent_id, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, conversationId, fileName, byteSize, createdAt, operationId ?? null, baseDir, familyId, lineage?.parentId ?? null, version);
      if (presentation) {
        this.addPresentationVersion(id, presentation.sha256, presentation.report);
        this.db.exec("COMMIT");
      }
    } catch (error) {
      if (presentation) this.db.exec("ROLLBACK");
      throw error;
    }
    return { id, name: fileName, byteSize, createdAt, baseDir, familyId, version };
  }

  /** B：普通列表、下载、文件卡和 family 历史默认只暴露 published；候选需显式 include。 */
  listWorkspaceDocuments(conversationId: string, options: { includeCandidates?: boolean } = {}): Array<{ id: string; name: string; byteSize: number; createdAt: string; baseDir: string; familyId: string; version: number; state: "candidate" | "published" }> {
    const stateFilter = options.includeCandidates ? "" : "AND state = 'published'";
    const rows = this.db.prepare(`SELECT id, file_name, byte_size, created_at, base_dir, family_id, version, state FROM workspace_documents WHERE conversation_id = ? AND archived = 0 ${stateFilter} ORDER BY created_at DESC, rowid DESC`).all(conversationId) as DbRow[];
    return rows.map((row) => ({
      id: String(row.id), name: String(row.file_name), byteSize: Number(row.byte_size), createdAt: String(row.created_at),
      baseDir: row.base_dir == null || row.base_dir === "" ? this.currentDocumentsDir : String(row.base_dir),
      familyId: row.family_id == null || row.family_id === "" ? String(row.id) : String(row.family_id),
      version: Number(row.version ?? 1),
      state: row.state === "candidate" ? "candidate" as const : "published" as const,
    }));
  }

  getWorkspaceDocument(conversationId: string, fileId: string) {
    return this.listWorkspaceDocuments(conversationId).find((item) => item.id === fileId) ?? null;
  }

  /** 内部读取（发布前校验、重启对账）用；调用方必须自行验证运行归属。 */
  getAnyWorkspaceDocument(conversationId: string, fileId: string) {
    return this.listWorkspaceDocuments(conversationId, { includeCandidates: true }).find((item) => item.id === fileId) ?? null;
  }

  /** 旧的 operationId 幂等查询不得把 candidate 当作成功结果。 */
  getWorkspaceDocumentByOperation(conversationId: string, operationId: string) {
    const row = this.db.prepare("SELECT id, file_name, byte_size, created_at, base_dir, family_id, version FROM workspace_documents WHERE conversation_id = ? AND operation_id = ? AND state = 'published'").get(conversationId, operationId) as DbRow | undefined;
    return row ? {
      id: String(row.id), name: String(row.file_name), byteSize: Number(row.byte_size), createdAt: String(row.created_at),
      baseDir: row.base_dir == null || row.base_dir === "" ? this.currentDocumentsDir : String(row.base_dir),
      familyId: row.family_id == null || row.family_id === "" ? String(row.id) : String(row.family_id),
      version: Number(row.version ?? 1),
    } : null;
  }

  // ── B：候选产物与统一发布 ────────────────────────────────────────────────
  addCandidateDocument(input: CreateCandidateRecord) {
    const id = crypto.randomUUID(); const createdAt = now();
    this.db.prepare(`INSERT INTO workspace_documents
      (id, conversation_id, file_name, byte_size, created_at, operation_id, base_dir, family_id, parent_id, version, state, candidate_meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, 'candidate', ?)`)
      .run(id, input.conversationId, input.fileName, input.byteSize, createdAt,
        `${CANDIDATE_OPERATION_PREFIX}${input.operationId}`, input.baseDir, id, JSON.stringify(input.meta));
    return { id, name: input.fileName, byteSize: input.byteSize, createdAt, baseDir: input.baseDir, familyId: id, version: 1 };
  }

  getCandidateByOperation(conversationId: string, operationId: string) {
    const row = this.db.prepare("SELECT id, file_name, base_dir, candidate_meta FROM workspace_documents WHERE conversation_id = ? AND operation_id = ? AND state = 'candidate'")
      .get(conversationId, `${CANDIDATE_OPERATION_PREFIX}${operationId}`) as DbRow | undefined;
    return row ? { id: String(row.id), name: String(row.file_name), baseDir: String(row.base_dir ?? ""), meta: parseJson<CandidateMeta | null>(row.candidate_meta, null) } : null;
  }

  getCandidateById(conversationId: string, candidateId: string) {
    const row = this.db.prepare("SELECT id, file_name, base_dir, candidate_meta FROM workspace_documents WHERE conversation_id = ? AND id = ? AND state = 'candidate'")
      .get(conversationId, candidateId) as DbRow | undefined;
    return row ? { id: String(row.id), name: String(row.file_name), baseDir: String(row.base_dir ?? ""), meta: parseJson<CandidateMeta | null>(row.candidate_meta, null) } : null;
  }

  listCandidateDocuments(): Array<{ id: string; conversationId: string; name: string; baseDir: string; meta: CandidateMeta | null }> {
    const rows = this.db.prepare("SELECT id, conversation_id, file_name, base_dir, candidate_meta FROM workspace_documents WHERE state = 'candidate'").all() as DbRow[];
    return rows.map(row => ({
      id: String(row.id), conversationId: String(row.conversation_id), name: String(row.file_name),
      baseDir: String(row.base_dir ?? ""), meta: parseJson<CandidateMeta | null>(row.candidate_meta, null),
    }));
  }

  deleteCandidateDocument(candidateId: string) {
    return Number(this.db.prepare("DELETE FROM workspace_documents WHERE id = ? AND state = 'candidate'").run(candidateId).changes) > 0;
  }

  /** 只更新候选登记里的元数据，不改文件字节；用于记录「等待视觉检查」。 */
  saveCandidateMeta(conversationId: string, candidateId: string, meta: CandidateMeta) {
    return Number(this.db.prepare("UPDATE workspace_documents SET candidate_meta = ? WHERE id = ? AND conversation_id = ? AND state = 'candidate'")
      .run(JSON.stringify(meta), candidateId, conversationId).changes) > 0;
  }

  /** 让候选进入已有的 WPS 检查队列；检查完成后由发布层发布同一候选。 */
  queueCandidateVisualCheck(fileId: string, sha256: string, report: TemplateReport) {
    const visual: PresentationVisualCheck = { status: "queued", summary: "候选等待本机 WPS 渲染检查" };
    this.db.prepare(`INSERT OR IGNORE INTO presentation_versions (file_id, sha256, report, visual, visual_state)
      VALUES (?, ?, ?, ?, 'queued')`).run(fileId, sha256, JSON.stringify(report), JSON.stringify(visual));
    // 中断在 running / 已检查过但仍在等待发布时，重新排队，保证重启后能继续。
    this.db.prepare(`UPDATE presentation_versions SET sha256 = ?, report = ?, visual = ?, visual_state = 'queued', lease = NULL
      WHERE file_id = ? AND visual_state != 'queued'`).run(sha256, JSON.stringify(report), JSON.stringify(visual), fileId);
  }

  savePendingVisualPublish(input: PendingVisualPublishRecord) {
    this.db.prepare(`INSERT OR REPLACE INTO pending_visual_publishes
      (candidate_id, conversation_id, operation_id, payload, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(input.candidateId, input.conversationId, input.operationId, JSON.stringify(input.payload), now());
  }

  listPendingVisualPublishes(): Array<{ candidateId: string; conversationId: string; operationId: string; payload: PendingPublish }> {
    const rows = this.db.prepare("SELECT candidate_id, conversation_id, operation_id, payload FROM pending_visual_publishes").all() as DbRow[];
    return rows.map(row => ({
      candidateId: String(row.candidate_id), conversationId: String(row.conversation_id),
      operationId: String(row.operation_id), payload: parseJson<PendingPublish>(row.payload, {} as PendingPublish),
    }));
  }

  deletePendingVisualPublish(candidateId: string) {
    return Number(this.db.prepare("DELETE FROM pending_visual_publishes WHERE candidate_id = ?").run(candidateId).changes) > 0;
  }

  getPublishLog(conversationId: string, operationId: string) {
    const row = this.db.prepare("SELECT * FROM document_publish_log WHERE conversation_id = ? AND operation_id = ?").get(conversationId, operationId) as DbRow | undefined;
    return row ? {
      id: String(row.id), candidateId: String(row.candidate_id), candidateSha256: String(row.candidate_sha256),
      targetName: String(row.target_name), publishedId: row.published_id == null ? null : String(row.published_id),
      validationId: row.validation_id == null ? null : String(row.validation_id),
      disposition: String(row.disposition) as "ready" | "draft", createdAt: String(row.created_at),
    } : null;
  }

  /** publish 是唯一把 state 改为 published 的入口；正式版本号在此分配。 */
  publishCandidateDocument(input: PublishCandidateRecord) {
    const familyId = input.familyId ?? input.candidateId;
    const versionRow = input.parentId
      ? this.db.prepare("SELECT MAX(version) AS version FROM workspace_documents WHERE conversation_id = ? AND family_id = ? AND state = 'published'").get(input.conversationId, familyId) as DbRow | undefined
      : undefined;
    const version = input.parentId ? Number(versionRow?.version ?? 0) + 1 : 1;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db.prepare(`UPDATE workspace_documents
        SET state = 'published', operation_id = ?, family_id = ?, parent_id = ?, version = ?, candidate_meta = NULL
        WHERE id = ? AND conversation_id = ? AND state = 'candidate'`)
        .run(input.operationId, familyId, input.parentId ?? null, version, input.candidateId, input.conversationId);
      if (Number(changed.changes) !== 1) throw new Error("候选已被发布或已失效，不能重复增加版本");
      if (input.presentation) this.addPresentationVersion(input.candidateId, input.presentation.sha256, input.presentation.report);
      this.db.prepare(`INSERT INTO document_publish_log
        (id, conversation_id, operation_id, candidate_id, candidate_sha256, target_name, published_id, validation_id, disposition, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(crypto.randomUUID(), input.conversationId, input.operationId, input.candidateId,
          input.log.candidateSha256, input.log.targetName, input.candidateId,
          input.log.validationId, input.log.disposition, now());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { fileId: input.candidateId, familyId, version };
  }

  /**
   * Keep a bounded history for a document family. The newest `keep` versions (and
   * the root file) survive; older generated intermediates are removed from disk.
   * Returns the removed file paths so callers can report what was cleaned.
   */
  pruneWorkspaceFamily(conversationId: string, familyId: string, keep = 3): string[] {
    // A：运行、暂停、等待任务/确认或待视觉检查的 family 是活跃基线，不能被固定 keep=3 删掉。
    if (this.specs?.hasActiveFamilyRef(familyId)) return [];
    // 更精确的一层：断点仍指向这一族时必须整族保留，不能只靠引用登记是否被调用过。
    const resume = this.getPresentationResume(conversationId);
    if (resume && familyId === `ppt-run:${resume.operationId.split(":draft:")[0]}`) return [];
    // B：候选不参与正式版本清理，它们由 TTL / 重启对账单独处理。
    const rows = this.db.prepare("SELECT id, file_name, base_dir FROM workspace_documents WHERE conversation_id = ? AND family_id = ? AND archived = 0 AND state = 'published' ORDER BY version DESC, created_at DESC, rowid DESC").all(conversationId, familyId) as DbRow[];
    const retained = new Set(rows.slice(0, Math.max(1, keep)).map((row) => String(row.id)));
    const root = rows[rows.length - 1];
    if (root) retained.add(String(root.id));
    const removed: string[] = [];
    for (const row of rows) {
      const id = String(row.id);
      if (retained.has(id)) continue;
      const baseDir = path.resolve(row.base_dir == null || row.base_dir === "" ? this.currentDocumentsDir : String(row.base_dir));
      const file = path.resolve(baseDir, conversationId, String(row.file_name));
      if (path.dirname(path.dirname(file)).toLowerCase() !== baseDir.toLowerCase()) continue;
      try { fs.rmSync(file, { force: true }); } catch { /* A missing file is already clean. */ }
      this.db.prepare("DELETE FROM workspace_documents WHERE conversation_id = ? AND id = ?").run(conversationId, id);
      removed.push(file);
    }
    return removed;
  }

  /** Manual cleanup for workspaces created before automatic pruning existed. */
  cleanupWorkspaceVersions(keep = 3): number {
    const families = this.db.prepare("SELECT DISTINCT conversation_id, family_id FROM workspace_documents WHERE family_id IS NOT NULL AND family_id != '' AND archived = 0 AND state = 'published'").all() as DbRow[];
    let removed = 0;
    for (const row of families) {
      if (row.family_id == null || row.family_id === "") continue;
      removed += this.pruneWorkspaceFamily(String(row.conversation_id), String(row.family_id), keep).length;
    }
    return removed;
  }

  deleteWorkspaceDocument(conversationId: string, fileId: string): void {
    this.db.prepare("DELETE FROM workspace_documents WHERE conversation_id = ? AND id = ?").run(conversationId, fileId);
  }

  listConversationDocuments(conversationId: string): StoredDocument[] {
    const rows = this.db.prepare(
      "SELECT * FROM conversation_documents WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC",
    ).all(conversationId) as DbRow[];
    return rows.map((row) => ({
      id: String(row.id), conversationId: String(row.conversation_id), fileName: String(row.file_name),
      content: String(row.content), charCount: Number(row.char_count), createdAt: String(row.created_at),
    }));
  }

  getConversationDocument(id: string): StoredDocument | null {
    const row = this.db.prepare("SELECT * FROM conversation_documents WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) return null;
    return {
      id: String(row.id), conversationId: String(row.conversation_id), fileName: String(row.file_name),
      content: String(row.content), charCount: Number(row.char_count), createdAt: String(row.created_at),
    };
  }
}
