import { useEffect, useState } from "react";
import { api } from "../api";
import type { WorkflowRun } from "../../shared/workflow";
const labels = { queued:"待执行",running:"执行中",paused:"已暂停",completed:"已完成",failed:"失败",cancelled:"已取消" };
export function WorkflowProgress({ conversationId, runId, enabled, onToast }: {
  conversationId:string; runId:string; enabled:boolean; onToast?:(kind:"ok"|"error",text:string)=>void;
}) {
  const [run,setRun] = useState<WorkflowRun>();
  const [steps,setSteps] = useState(0);
  const [busy,setBusy] = useState(false);
  const [refresh,setRefresh] = useState(0);
  useEffect(() => {
    let active = true, timer:ReturnType<typeof setTimeout>|undefined, attempts = 0;
    const poll = async () => {
      try {
        const value = await api.workflow(conversationId,runId);
        if (!active) return;
        setRun(value); setSteps(value.steps.length);
        // The resume endpoint starts the turn before the runner has claimed the
        // workflow, so the first response can still say paused. Keep watching for
        // a bounded window instead of leaving the card stuck until a manual reload.
        const catchingUp = refresh > 0 && value.status === "paused" && attempts < 10;
        if (value.status === "running" || value.status === "queued" || catchingUp) {
          if (catchingUp) attempts += 1;
          timer=setTimeout(() => void poll(),1800);
        }
      } catch { /* Old tool cards have no workflow ledger. */ }
    };
    void poll();
    return () => { active=false; if (timer) clearTimeout(timer); };
  },[conversationId,runId,refresh]);
  const action = async (kind:"resume"|"cancel") => {
    if (busy) return;
    setBusy(true);
    try {
      const value=await api.workflowAction(conversationId,runId,kind);
      setRun(value); setRefresh(v=>v+1);
      onToast?.("ok",kind === "resume" ? "正在从原任务断点继续" : "已取消，已交付文件保留");
    } catch(error) { onToast?.("error",error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  };
  if (!run) return null;
  return <details className="presentation-file-report"><summary>工作流 · {labels[run.status]} · {steps} 个阶段产物</summary>
    <div className="presentation-file-report-details">
      <div>累计模型调用 {run.calls} 次 · {run.usageMissing ? "至少 " : ""}{run.tokens.toLocaleString()} tokens{run.usageMissing ? "（部分用量未知）" : ""}</div>
      {run.reason && run.status !== "completed" ? <div>{run.reason}</div> : null}
      <div className="tool-card-template-action">
        {run.status === "paused" || run.status === "failed" ? <button className="secondary-button compact" type="button" disabled={busy||!enabled} onClick={()=>void action("resume")}>继续原任务</button> : null}
        {!["completed","cancelled"].includes(run.status) ? <button className="secondary-button compact" type="button" disabled={busy} onClick={()=>void action("cancel")}>取消任务</button> : null}
      </div>
    </div>
  </details>;
}
