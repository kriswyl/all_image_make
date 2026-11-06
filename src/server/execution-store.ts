import type { DatabaseSync } from "node:sqlite";
import type { ToolExecutionEvent, ExecutionState } from "./chat-tools/registry.js";

/** A journal shared by native tools and legacy media execution. Never stores prompt text or credentials. */
export class ExecutionStore {
  constructor(private readonly db:DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS capability_executions (
      operation_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      capability TEXT NOT NULL, version INTEGER NOT NULL, kind TEXT NOT NULL, input_hash TEXT NOT NULL,
      state TEXT NOT NULL, task_id TEXT, workflow_id TEXT, reason_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS capability_execution_conversation_idx ON capability_executions(conversation_id,created_at);`);
  }
  begin(event:ToolExecutionEvent,inputHash:string) {
    const at=new Date().toISOString();
    const result=this.db.prepare(`INSERT OR IGNORE INTO capability_executions(operation_id,conversation_id,capability,version,kind,input_hash,state,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'running',?,?)`).run(event.operationId,event.conversationId,event.tool,event.version,event.kind,inputHash,at,at);
    if(!result.changes)throw new Error("该操作已领取或已执行，请读取原操作结果");
  }
  finish(operationId:string,state:ExecutionState,refs:{taskId?:string;workflowId?:string;reasonCode?:string}={}) {
    this.db.prepare(`UPDATE capability_executions SET state=?,task_id=COALESCE(?,task_id),workflow_id=COALESCE(?,workflow_id),reason_code=?,updated_at=?
      WHERE operation_id=? AND state IN ('running','waiting_task','waiting_workflow','paused')`)
      .run(state,refs.taskId??null,refs.workflowId??null,refs.reasonCode??null,new Date().toISOString(),operationId);
  }
  settleTask(operationId:string,taskId:string,state:ExecutionState,reasonCode?:string) {
    this.finish(operationId,state,{taskId,reasonCode});
  }
  list(conversationId:string) {
    return this.db.prepare(`SELECT operation_id AS operationId,capability,version,kind,state,task_id AS taskId,workflow_id AS workflowId,
      reason_code AS reasonCode,created_at AS createdAt,updated_at AS updatedAt FROM capability_executions WHERE conversation_id=? ORDER BY rowid DESC LIMIT 100`).all(conversationId);
  }
  recoverInterrupted() {
    // Unknown local writes require reconciliation. Paid tasks are recovered by the existing TaskRunner.
    this.db.prepare("UPDATE capability_executions SET state='paused',reason_code='PROCESS_INTERRUPTED' WHERE state='running'").run();
  }
}
