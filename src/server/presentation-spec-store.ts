import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  presentationSpecSchema, type PageCountValue, type PresentationSpec,
} from "../shared/presentation-spec.js";

type DbRow = Record<string, string | number | null>;
const now = () => new Date().toISOString();

export type ContractValidation = {
  validationId: string;
  specId: string;
  specRevision: number;
  fileSha256: string;
  ok: boolean;
  readiness: "ready" | "draft";
  failures: Array<{ code: string; detail: string }>;
  visibleCoverage: { required: number; satisfied: number; unknown: number };
  createdAt: string;
};

/** 语义必需内容的核验结论；unverified 不是通过，只是明确记下「还缺什么证据」。 */
export type RequirementVerification = {
  id: string;
  specId: string;
  specRevision: number;
  requiredId: string;
  fileSha256: string;
  status: "satisfied" | "missing" | "unverified";
  /** verbatim / case-evidence / content-audit / manual / none */
  method: string;
  evidence: string;
  sourceRef: string;
  createdAt: string;
};

export type FamilyRef = {
  familyId: string;
  conversationId: string;
  owner: string;
  kind: "running" | "paused" | "waiting_task" | "waiting_dependency" | "confirmation" | "visual_check";
};

/**
 * A 阶段的契约存储。只负责 Spec/revision/门禁结果/家族活跃引用，
 * 不复制 workflow_runs、workspace_documents 或 execution 的职能。
 */
export class PresentationSpecStore {
  constructor(private readonly db: DatabaseSync) {}

  private parse(row: DbRow): PresentationSpec {
    return presentationSpecSchema.parse(JSON.parse(String(row.payload)));
  }

  create(input: {
    conversationId: string;
    pageCount?: PresentationSpec["pageCount"];
    pageCountBasis?: PresentationSpec["pageCountBasis"];
    cover?: PresentationSpec["cover"];
    sources?: PresentationSpec["sources"];
    requiredContent?: PresentationSpec["requiredContent"];
    structure?: PresentationSpec["structure"];
    styleRequest?: PresentationSpec["styleRequest"];
    visualPolicy?: PresentationSpec["visualPolicy"];
    origin?: PresentationSpec["origin"];
    sourceMessageId?: string;
    reason?: string;
  }): PresentationSpec {
    const timestamp = now();
    const spec: PresentationSpec = {
      schemaVersion: 1,
      specId: randomUUID(),
      revision: 1,
      conversationId: input.conversationId,
      lifecycle: "prepared",
      sources: input.sources ?? [],
      ...(input.pageCount ? { pageCount: input.pageCount } : {}),
      pageCountBasis: input.pageCountBasis ?? "total",
      cover: input.cover ?? "include",
      requiredContent: input.requiredContent ?? [],
      structure: input.structure ?? [],
      requiredAssets: [],
      ...(input.styleRequest ? { styleRequest: input.styleRequest } : {}),
      visualPolicy: input.visualPolicy ?? "background",
      origin: input.origin ?? "user",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO presentation_specs (spec_id, conversation_id, current_revision, lifecycle, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(spec.specId, spec.conversationId, spec.revision, spec.lifecycle, timestamp, timestamp);
      this.appendRevision(spec, input.reason ?? "创建任务契约", input.sourceMessageId ?? "");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return spec;
  }

  private appendRevision(spec: PresentationSpec, reason: string, sourceMessageId: string) {
    this.db.prepare("INSERT INTO presentation_spec_revisions (spec_id, revision, payload, reason, source_message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(spec.specId, spec.revision, JSON.stringify(spec), reason, sourceMessageId, now());
  }

  /** 追加不可变 revision；旧执行绑定的是旧 revision，不会被热改。 */
  update(specId: string, patch: Partial<Pick<PresentationSpec,
    "pageCount" | "pageCountBasis" | "cover" | "requiredContent" | "structure" | "requiredAssets" | "styleRequest" | "visualPolicy" | "lifecycle" | "familyId" | "sources" | "origin">>,
    reason: string, sourceMessageId = ""): PresentationSpec {
    const current = this.get(specId);
    if (!current) throw new Error("任务契约不存在");
    const next: PresentationSpec = {
      ...current, ...patch, revision: current.revision + 1, updatedAt: now(),
    };
    presentationSpecSchema.parse(next);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE presentation_specs SET current_revision = ?, lifecycle = ?, family_id = COALESCE(?, family_id), updated_at = ? WHERE spec_id = ?")
        .run(next.revision, next.lifecycle, next.familyId ?? null, next.updatedAt, specId);
      this.appendRevision(next, reason, sourceMessageId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return next;
  }

  get(specId: string): PresentationSpec | null {
    const row = this.db.prepare("SELECT r.payload FROM presentation_spec_revisions r JOIN presentation_specs s ON s.spec_id = r.spec_id AND s.current_revision = r.revision WHERE r.spec_id = ?").get(specId) as DbRow | undefined;
    return row ? this.parse(row) : null;
  }

  atRevision(specId: string, revision: number): PresentationSpec | null {
    const row = this.db.prepare("SELECT payload FROM presentation_spec_revisions WHERE spec_id = ? AND revision = ?").get(specId, revision) as DbRow | undefined;
    return row ? this.parse(row) : null;
  }

  /**
   * 归属校验：specId 是模型可以传入的参数，UUID 难猜不能代替权限。
   * 所有以 specId 为入口的读取/写入/生命周期操作都必须先过这一层。
   */
  requireOwned(conversationId: string, specId: string): PresentationSpec {
    const spec = this.get(specId);
    if (!spec) throw new Error("任务契约不存在");
    if (spec.conversationId !== conversationId) throw new Error("任务契约不属于当前会话");
    return spec;
  }

  /** 带归属校验的读取：越权返回 null，不泄露是否存在。 */
  ownedRevision(conversationId: string, specId: string, revision: number): PresentationSpec | null {
    const spec = this.atRevision(specId, revision);
    return spec && spec.conversationId === conversationId ? spec : null;
  }

  /** 生产路径统一走带归属校验的更新。 */
  updateOwned(
    conversationId: string, specId: string,
    patch: Partial<Pick<PresentationSpec,
      "pageCount" | "pageCountBasis" | "cover" | "requiredContent" | "structure" | "requiredAssets" | "styleRequest" | "visualPolicy" | "lifecycle" | "familyId" | "sources" | "origin">>,
    reason: string, sourceMessageId = "",
  ): PresentationSpec {
    this.requireOwned(conversationId, specId);
    return this.update(specId, patch, reason, sourceMessageId);
  }

  /** 生产路径统一走带归属校验的生命周期变更。 */
  setLifecycleOwned(conversationId: string, specId: string, lifecycle: PresentationSpec["lifecycle"]) {
    this.requireOwned(conversationId, specId);
    return this.setLifecycle(specId, lifecycle);
  }

  /** 「先定要求、下一轮开始」要找的唯一 prepared 任务；多个目标时不猜。 */
  listPrepared(conversationId: string): PresentationSpec[] {
    const rows = this.db.prepare("SELECT r.payload FROM presentation_spec_revisions r JOIN presentation_specs s ON s.spec_id = r.spec_id AND s.current_revision = r.revision WHERE s.conversation_id = ? AND s.lifecycle IN ('prepared','active') ORDER BY s.updated_at DESC").all(conversationId) as DbRow[];
    return rows.map(row => this.parse(row));
  }

  /** 当前正在执行的契约；门禁在保存前用它，不猜「最后一个」。 */
  findActive(conversationId: string): PresentationSpec | null {
    return this.listPrepared(conversationId).find(spec => spec.lifecycle === "active") ?? null;
  }

  findByFamily(conversationId: string, familyId: string): PresentationSpec | null {
    const row = this.db.prepare("SELECT r.payload FROM presentation_spec_revisions r JOIN presentation_specs s ON s.spec_id = r.spec_id AND s.current_revision = r.revision WHERE s.conversation_id = ? AND s.family_id = ? ORDER BY s.updated_at DESC LIMIT 1").get(conversationId, familyId) as DbRow | undefined;
    return row ? this.parse(row) : null;
  }

  bindFamily(specId: string, familyId: string, reason = "首次发布绑定文件家族") {
    return this.update(specId, { familyId, lifecycle: "active" }, reason);
  }

  /** 首次发布只登记归属，不追加 revision：生成中的任务仍绑定原 revision。 */
  bindFamilyOnly(specId: string, familyId: string) {
    this.db.prepare("UPDATE presentation_specs SET family_id = ?, lifecycle = 'active', updated_at = ? WHERE spec_id = ? AND family_id IS NULL")
      .run(familyId, now(), specId);
  }

  setLifecycle(specId: string, lifecycle: PresentationSpec["lifecycle"]) {
    return this.update(specId, { lifecycle }, `任务状态：${lifecycle}`);
  }

  /** 门禁结果必须持久化，B 的 publish 用 validationId 复核，不接受模型自报通过。 */
  saveValidation(record: Omit<ContractValidation, "validationId" | "createdAt">): ContractValidation {
    const saved: ContractValidation = { ...record, validationId: randomUUID(), createdAt: now() };
    this.db.prepare("INSERT INTO presentation_validations (validation_id, spec_id, spec_revision, file_sha256, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(saved.validationId, saved.specId, saved.specRevision, saved.fileSha256, JSON.stringify(saved), saved.createdAt);
    return saved;
  }

  /**
   * 语义必需内容的核验结论。绑定候选哈希 + Spec revision + 要求 ID，
   * 因此文件字节一变旧结论就查不到；可信的 AI 审校/人工核验可据此解除 unknown。
   */
  saveRequirementVerification(record: Omit<RequirementVerification, "id" | "createdAt">): RequirementVerification {
    const saved: RequirementVerification = { ...record, id: randomUUID(), createdAt: now() };
    this.db.prepare(`INSERT INTO presentation_requirement_verifications
      (id, spec_id, spec_revision, required_id, file_sha256, status, method, evidence, source_ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(saved.id, saved.specId, saved.specRevision, saved.requiredId, saved.fileSha256,
        saved.status, saved.method, saved.evidence, saved.sourceRef, saved.createdAt);
    return saved;
  }

  listRequirementVerifications(specId: string, specRevision: number, fileSha256: string): RequirementVerification[] {
    const rows = this.db.prepare(`SELECT id, spec_id, spec_revision, required_id, file_sha256,
      status, method, evidence, source_ref, created_at FROM presentation_requirement_verifications
      WHERE spec_id = ? AND spec_revision = ? AND file_sha256 = ? ORDER BY rowid`).all(specId, specRevision, fileSha256) as DbRow[];
    return rows.map(row => ({
      id: String(row.id), specId: String(row.spec_id), specRevision: Number(row.spec_revision),
      requiredId: String(row.required_id), fileSha256: String(row.file_sha256),
      status: String(row.status) as RequirementVerification["status"],
      method: String(row.method), evidence: String(row.evidence),
      sourceRef: String(row.source_ref ?? ""), createdAt: String(row.created_at),
    }));
  }

  getValidation(validationId: string): ContractValidation | null {
    const row = this.db.prepare("SELECT payload FROM presentation_validations WHERE validation_id = ?").get(validationId) as DbRow | undefined;
    return row ? JSON.parse(String(row.payload)) as ContractValidation : null;
  }

  /** 活跃引用保护：pruneWorkspaceFamily 不能删掉正在使用的基线。 */
  registerFamilyRef(ref: FamilyRef) {
    this.db.prepare("INSERT OR REPLACE INTO presentation_family_refs (family_id, conversation_id, owner, kind, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(ref.familyId, ref.conversationId, ref.owner, ref.kind, now());
  }

  releaseFamilyRef(owner: string) {
    this.db.prepare("DELETE FROM presentation_family_refs WHERE owner = ?").run(owner);
  }

  /**
   * 清理「暂停保护」但已经没有断点的家族引用。
   * 引用是粗粒度开关（命中就整族不清理），残留会让磁盘永远清不下去。
   */
  releaseOrphanPausedRefs(): number {
    const result = this.db.prepare(
      "DELETE FROM presentation_family_refs WHERE kind = 'paused' AND conversation_id NOT IN (SELECT conversation_id FROM presentation_resumes)",
    ).run();
    return Number(result.changes ?? 0);
  }

  hasActiveFamilyRef(familyId: string): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM presentation_family_refs WHERE family_id = ?").get(familyId) as DbRow | undefined;
    return Number(row?.total ?? 0) > 0;
  }
}

/** 供 workflow 缓存键使用：契约变化必须让旧页面缓存失效。 */
export function specCacheKey(spec: PresentationSpec | null): string {
  if (!spec) return "no-spec";
  return `spec:${spec.specId}:${spec.revision}:${spec.pageCount ? JSON.stringify(spec.pageCount as PageCountValue) : "none"}`;
}
