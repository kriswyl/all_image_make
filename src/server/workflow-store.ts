import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { WorkflowRun, WorkflowStatus, WorkflowStep } from "../shared/workflow.js";

/** Durable, domain-neutral workflow ledger. Stage payloads remain in the capability's artifact store. */
export class WorkflowStore {
  private readonly owner = randomUUID();
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      capability TEXT NOT NULL, version INTEGER NOT NULL, input_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL, owner TEXT, reason TEXT, calls INTEGER NOT NULL DEFAULT 0,
      tokens INTEGER NOT NULL DEFAULT 0, usage_missing INTEGER NOT NULL DEFAULT 0,
      artifact_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS workflow_runs_conversation_idx ON workflow_runs(conversation_id, updated_at);
      CREATE TABLE IF NOT EXISTS workflow_steps (
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE, id TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL, artifact_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL, PRIMARY KEY(run_id,id));`);
  }
  private read(row: Record<string, unknown>): WorkflowRun {
    return { id: String(row.id), conversationId: String(row.conversation_id), capability: String(row.capability),
      version: Number(row.version), inputFingerprint: String(row.input_fingerprint), status: row.status as WorkflowStatus,
      reason: row.reason === null ? null : String(row.reason), calls: Number(row.calls), tokens: Number(row.tokens),
      usageMissing: Boolean(row.usage_missing), artifactId: row.artifact_id === null ? null : String(row.artifact_id),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
  }
  get(conversationId: string, id: string): WorkflowRun | null {
    const row = this.db.prepare("SELECT * FROM workflow_runs WHERE id=? AND conversation_id=?").get(id, conversationId);
    return row ? this.read(row) : null;
  }
  list(conversationId: string): WorkflowRun[] {
    return this.db.prepare("SELECT * FROM workflow_runs WHERE conversation_id=? ORDER BY updated_at DESC LIMIT 50").all(conversationId).map(row => this.read(row));
  }
  steps(conversationId: string, id: string): WorkflowStep[] {
    if (!this.get(conversationId, id)) return [];
    return this.db.prepare("SELECT * FROM workflow_steps WHERE run_id=? ORDER BY updated_at, id").all(id).map(row => ({
      id: String(row.id), status: "completed", attempts: Number(row.attempts), artifactHash: String(row.artifact_hash), updatedAt: String(row.updated_at),
    }));
  }
  begin(input: { id: string; conversationId: string; capability: string; version: number; inputFingerprint: string }) {
    const at = new Date().toISOString();
    this.db.prepare(`INSERT OR IGNORE INTO workflow_runs(id,conversation_id,capability,version,input_fingerprint,status,created_at,updated_at)
      VALUES(?,?,?,?,?,'queued',?,?)`).run(input.id,input.conversationId,input.capability,input.version,input.inputFingerprint,at,at);
    const previous = this.get(input.conversationId,input.id);
    if (!previous || previous.capability !== input.capability || previous.version !== input.version || previous.inputFingerprint !== input.inputFingerprint) throw new Error("工作流输入或能力版本已变化");
    if (previous.status === "completed" || previous.status === "cancelled") throw new Error("工作流已经结束，不能重复执行");
    const result = this.db.prepare(`UPDATE workflow_runs SET status='running',owner=?,reason=NULL,updated_at=?
      WHERE id=? AND conversation_id=? AND (status IN ('queued','paused','failed') OR (status='running' AND owner=?))`)
      .run(this.owner,at,input.id,input.conversationId,this.owner);
    if (!result.changes) throw new Error("工作流已由另一个执行器领取");
  }
  checkpoint(conversationId: string, id: string, usage: { calls: number; tokens: number; usageMissing: boolean }) {
    const result = this.db.prepare(`UPDATE workflow_runs SET calls=MAX(calls,?),tokens=MAX(tokens,?),usage_missing=MAX(usage_missing,?),updated_at=?
      WHERE id=? AND conversation_id=? AND owner=? AND status='running'`)
      .run(usage.calls,usage.tokens,Number(usage.usageMissing),new Date().toISOString(),id,conversationId,this.owner);
    if (!result.changes) throw new Error("工作流已停止，不能继续写入检查点");
  }
  step(conversationId: string, id: string, key: string, payload: string) {
    const hash = createHash("sha256").update(payload).digest("hex");
    this.db.prepare(`INSERT INTO workflow_steps(run_id,id,status,attempts,artifact_hash,updated_at)
      SELECT ?,?,'completed',1,?,? WHERE EXISTS(SELECT 1 FROM workflow_runs WHERE id=? AND conversation_id=? AND owner=? AND status='running')
      ON CONFLICT(run_id,id) DO UPDATE SET attempts=workflow_steps.attempts+1,artifact_hash=excluded.artifact_hash,updated_at=excluded.updated_at`)
      .run(id,key,hash,new Date().toISOString(),id,conversationId,this.owner);
  }
  finish(conversationId: string, id: string, status: "paused" | "completed" | "failed", reason?: string, artifactId?: string) {
    return Boolean(this.db.prepare(`UPDATE workflow_runs SET status=?,reason=?,artifact_id=COALESCE(?,artifact_id),owner=NULL,updated_at=?
      WHERE id=? AND conversation_id=? AND owner=? AND status='running'`)
      .run(status,reason?.slice(0,500) ?? null,artifactId ?? null,new Date().toISOString(),id,conversationId,this.owner).changes);
  }
  cancel(conversationId: string, id: string) {
    return Boolean(this.db.prepare(`UPDATE workflow_runs SET status='cancelled',reason='用户取消',owner=NULL,updated_at=?
      WHERE id=? AND conversation_id=? AND status IN ('queued','running','paused','failed')`).run(new Date().toISOString(),id,conversationId).changes);
  }
  /** Called by the single desktop backend at startup, after the previous process has exited. */
  recoverInterrupted() {
    this.db.prepare("UPDATE workflow_runs SET status='paused',owner=NULL,reason='应用中断，已保留阶段产物' WHERE status='running'").run();
  }
  releaseOwned() {
    this.db.prepare("UPDATE workflow_runs SET status='paused',owner=NULL,reason='应用停止，已保留阶段产物' WHERE status='running' AND owner=?").run(this.owner);
  }
}
