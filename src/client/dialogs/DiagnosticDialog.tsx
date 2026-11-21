import { useEffect, useState, type FormEvent } from "react";
import { Activity, X } from "lucide-react";
import { api } from "../api";
import { LoadingScreen, StatusBadge, formatTime, terminalStatuses } from "../task-ui";
import type { Diagnostic, RequestDiagnosticTrace, Task } from "../../shared/types";

const phaseLabels: Record<RequestDiagnosticTrace["phase"], string> = {
  prepare: "本地请求准备",
  upstream: "上游请求",
  response_body: "读取上游响应",
  parse_result: "解析产物",
  download_result: "下载产物",
  save_result: "检查与保存产物",
  service_restart: "本地服务重启",
};

function time(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function kib(bytes: number) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function DiagnosticDialog({ task, onClose, onVideoRecovered }: { task: Task; onClose: () => void; onVideoRecovered?: (task: Task) => void }) {
  const [currentTask, setCurrentTask] = useState(task);
  const [items, setItems] = useState<Diagnostic[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [recovered, setRecovered] = useState<Task | null>(null);
  const [remoteTaskId, setRemoteTaskId] = useState("");
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const observedTask = recovered?.id === task.id ? recovered : task;

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let latest = observedTask;
    setCurrentTask(observedTask);
    setItems(null);
    setLoadError("");
    async function refresh() {
      try {
        if (!terminalStatuses.includes(latest.status)) {
          latest = await api.task(task.id);
          if (!stopped) setCurrentTask(latest);
        }
        const entries = await api.diagnostics(task.id);
        if (stopped) return;
        setItems(entries);
        setLoadError("");
      } catch (error) {
        if (stopped) return;
        setLoadError(error instanceof Error ? error.message : "请求诊断读取失败");
      }
      if (!stopped && !terminalStatuses.includes(latest.status)) timer = window.setTimeout(() => void refresh(), 1800);
    }
    void refresh();
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [observedTask]);

  async function recoverVideo(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const remoteId = remoteTaskId.trim();
    if (!remoteId || recovering) return;
    setRecovering(true);
    setRecoveryError("");
    try {
      setRecovered(await api.recoverVideo(currentTask.id, remoteId));
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : "查询原任务失败");
    } finally {
      setRecovering(false);
    }
  }

  const terminal = terminalStatuses.includes(currentTask.status);
  useEffect(() => {
    if (recovered?.id === currentTask.id && currentTask.status === "succeeded") onVideoRecovered?.(currentTask);
  }, [currentTask, recovered, onVideoRecovered]);
  const seedream = currentTask.remoteMeta?.seedream;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal diagnostic-modal" role="dialog" aria-modal="true" aria-label="请求诊断">
      <div className="modal-header">
        <div><Activity size={18} /><h2>请求诊断</h2></div>
        <button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X size={18} /></button>
      </div>
      <div className="diagnostic-summary">
        <StatusBadge status={currentTask.status} /><span>{currentTask.model}</span><code title={currentTask.id}>{currentTask.id.slice(0, 8)}</code>
        <span>创建 {time(currentTask.createdAt)}</span>
        {currentTask.finishedAt ? <span>结束 {time(currentTask.finishedAt)}</span> : null}
        {seedream?.returnedModel ? <span>上游模型 {seedream.returnedModel}</span> : null}
        {seedream ? <span>参考图：{seedream.acceptedReferences ?? "未回传"}/{seedream.requestedReferences}</span> : null}
        {seedream?.generatedImages !== undefined ? <span>上游生成 {seedream.generatedImages} 张</span> : null}
        {seedream?.outputTokens !== undefined ? <span>输出 {seedream.outputTokens} tokens</span> : null}
        {seedream?.warning ? <p className="diagnostic-task-error" role="status">{seedream.warning}</p> : null}
        {currentTask.errorMessage ? <p className="diagnostic-task-error"><strong>{currentTask.errorCode || "任务失败"}</strong>{currentTask.errorMessage}</p> : null}
      </div>
      <div className="diagnostic-list">
        {currentTask.canRecoverVideo ? <form className="diagnostic-recovery" onSubmit={recoverVideo}>
          <label htmlFor={`remote-task-${currentTask.id}`}>找回已生成的视频</label>
          <p>从原渠道后台复制对应的任务 ID。只查询和保存原任务结果。</p>
          <div>
            <input id={`remote-task-${currentTask.id}`} aria-label="上游任务 ID" placeholder="上游任务 ID" value={remoteTaskId} maxLength={200}
              spellCheck={false} autoComplete="off" disabled={recovering} onChange={(event) => setRemoteTaskId(event.target.value)} />
            <button type="submit" className="secondary-button" disabled={!remoteTaskId.trim() || recovering}>{recovering ? "正在查询…" : "查询原任务"}</button>
          </div>
          {recoveryError ? <p className="diagnostic-task-error" role="alert">{recoveryError}</p> : null}
        </form> : null}
        {loadError ? <p className="diagnostic-task-error" role="alert">{loadError}</p> : null}
        {items === null && !loadError ? <LoadingScreen compact /> : items?.length ? items.map((item) => <DiagnosticEntry key={item.id} item={item} terminal={terminal} />)
          : !loadError ? <div className="table-empty"><Activity size={28} /><span>{terminal ? "暂无诊断记录" : "等待请求记录"}</span></div> : null}
      </div>
    </div>
  </div>;
}

function DiagnosticEntry({ item, terminal }: { item: Diagnostic; terminal: boolean }) {
  const { trace } = item;
  const compact = item.request === null && !trace;
  const outcome = trace?.outcome === "pending" ? terminal ? "未记录结束" : "进行中"
    : trace?.outcome === "failed" ? "失败" : "完成";
  return <article className={`diagnostic-entry${compact ? " compact" : ""}`}>
    <header>
      {trace ? <strong>{phaseLabels[trace.phase]} · {outcome}</strong> : null}
      {item.httpStatus != null ? <span>HTTP {item.httpStatus}</span>
        : trace?.outcome === "failed" && (trace.phase === "upstream" || trace.phase === "response_body") ? <span>未收到 HTTP 响应</span>
        : !trace ? <span>HTTP -</span> : null}
      {item.durationMs != null ? <span>{item.durationMs} ms</span> : null}
      {!trace ? <span>{formatTime(item.createdAt)}</span> : null}
    </header>
    {trace ? <div className="diagnostic-trace">
      <dl>
        <div><dt>开始</dt><dd>{time(trace.startedAt)}</dd></div>
        {trace.responseAt ? <div><dt>响应头</dt><dd>{time(trace.responseAt)}</dd></div> : null}
        {trace.finishedAt ? <div><dt>结束</dt><dd>{time(trace.finishedAt)}</dd></div> : null}
        {trace.timeoutMs ? <div><dt>本地超时设置</dt><dd>{trace.timeoutMs / 1000} 秒</dd></div> : null}
        {trace.upstreamRequestId ? <div><dt>渠道请求 ID</dt><dd><code>{trace.upstreamRequestId}</code></dd></div> : null}
      </dl>
      {trace.error ? <p className="diagnostic-task-error"><strong>{trace.error.code}</strong>{trace.error.message}
        {trace.error.causeCode ? <code>{trace.error.causeCode}</code> : null}</p> : null}
      {trace.referenceImages ? <div className="diagnostic-media">
        <div>请求体 {kib(trace.referenceImages.requestBytes)}{trace.referenceImages.beforeBytes !== trace.referenceImages.requestBytes
          ? `（分流前 ${kib(trace.referenceImages.beforeBytes)}）` : ""}</div>
        {trace.referenceImages.images.map((image) => <div key={image.index}>
          {image.role === "first_frame" ? "首帧" : image.role === "last_frame" ? "尾帧" : image.role === "image" ? "角色图" : `参考图 ${image.index}`}
          {" · "}{image.transport === "uploaded" ? "渠道图床" : image.transport === "inline" ? "内联" : "原素材地址"}
          {image.width && image.height ? ` · ${image.width}×${image.height}` : ""}
          {image.fileBytes ? ` · ${kib(image.fileBytes)}` : ""}
          {image.originalBytes && image.originalBytes !== image.fileBytes ? `（原图 ${kib(image.originalBytes)}）` : ""}
          {image.uploadFallback ? " · 上传失败后改用内联" : ""}
        </div>)}
      </div> : null}
    </div> : null}
    {compact ? <p className="diagnostic-compact">{pollSummary(item.response)}<small>中间轮询只保留状态摘要，完整响应见最后一次</small></p> : <>
      {item.request !== null ? <><h3>请求</h3><pre>{JSON.stringify(item.request, null, 2)}</pre></> : null}
      {item.response != null ? <><h3>响应</h3><pre>{JSON.stringify(item.response, null, 2)}</pre></> : null}
    </>}
  </article>;
}

function pollSummary(response: unknown) {
  if (!response || typeof response !== "object") return "轮询中";
  const record = response as Record<string, unknown>;
  const parts: string[] = [typeof record.status === "string" ? record.status : "进行中"];
  if (typeof record.progress === "number") parts.push(`${record.progress}%`);
  return `${typeof record.poll === "number" ? `第 ${record.poll} 次轮询 · ` : ""}${parts.join(" · ")}`;
}

