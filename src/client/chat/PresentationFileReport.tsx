import { useEffect, useState } from "react";
import { api } from "../api";
import type { PresentationVersionReport, TemplateReport } from "../../shared/presentation-report";
import { projectPresentationStatus } from "../../shared/presentation-status";

type Action = { kind: "audit" | "visual" | "review" } | { kind: "page"; page: number };
const auditLabels = { complete: "已审校", partial: "部分审校", unavailable: "未审校" };

export function PresentationFileReport({ conversationId, fileId, initial, canUseModel, onToast }: {
  conversationId: string; fileId: string | null; initial: TemplateReport; canUseModel: boolean;
  onToast?: (kind: "ok" | "error", text: string) => void;
}) {
  const [version, setVersion] = useState<PresentationVersionReport>();
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState<Action>();
  const [statusMissing, setStatusMissing] = useState(false);
  useEffect(() => {
    if (!fileId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll(id: string) {
      try {
        const value = await api.presentationStatus(conversationId, id, controller.signal);
        if (controller.signal.aborted) return;
        setVersion(value);
        setStatusMissing(false);
        if (value.visual.status === "queued" || value.visual.status === "running") timer = setTimeout(() => { void poll(id); }, 1800);
      } catch {
        if (!controller.signal.aborted) setStatusMissing(true);
      }
    }
    void poll(fileId);
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [conversationId, fileId, refresh]);
  const report = version?.report ?? initial;
  const visual = version?.visual;
  const update = async (action: Action) => {
    if (!fileId || !version || busy) return;
    setBusy(action);
    try {
      await api.updatePresentation(conversationId, fileId, { sha256: version.sha256, ...action });
      setRefresh(value => value + 1);
      if (action.kind === "page") onToast?.("ok", "补做后的版本已添加到会话");
    } catch (error) {
      onToast?.("error", error instanceof Error ? error.message : "操作失败");
    } finally { setBusy(undefined); }
  };
  const status = projectPresentationStatus(report, visual ?? undefined);
  const rows: Array<[string, number[]]> = [
    ["精简页", report.fallbackPages], ["待补全页", report.pendingPages], ["部分文字移至备注", report.overflowPages],
    ["模型仅读取部分原文", report.sourceLimitedPages], ["原文备注达到长度上限", report.notesLimitedPages],
  ];
  return (
    <details className="presentation-file-report">
      <summary>
        {/* 只有经过契约门禁的文件才展示可用状态，历史文件保持原样 */}
        {report.readiness ? <span>{status.label}</span> : report.draft ? <span>草稿</span> : null}
        {report.fallbackPages.length ? <span>{report.fallbackPages.length} 页精简</span> : null}
        {report.pendingPages.length ? <span>{report.pendingPages.length} 页待补全</span> : null}
        <span>{auditLabels[report.audit]}</span>
        {visual ? <span>{visual.status === "checked" ? "WPS 已检查" : visual.status === "unavailable" ? "WPS 未检查" : "WPS 检查中"}</span> : null}
      </summary>
      <div className="presentation-file-report-details">
        {report.readiness ? <div>
          文件可用状态 · {status.label}；视觉检查 · {status.dimensions.visual === "checked" ? "已检查" : status.dimensions.visual === "unknown" ? "未校验" : "未完成"}
        </div> : null}
        {report.readiness && status.coverage ? <div>
          正文可见覆盖 · {status.coverage.satisfied}/{status.coverage.required}
          {status.coverage.unknown ? ` · ${status.coverage.unknown} 项待语义核验` : ""}
        </div> : null}
        {report.readiness && status.timeline.usableReadyAt ? <div>首次可用 · {new Date(status.timeline.usableReadyAt).toLocaleString()}</div> : null}
        {report.readiness && status.timeline.draftReadyAt ? <div>草稿产出 · {new Date(status.timeline.draftReadyAt).toLocaleString()}（不计入成品）</div> : null}
        {report.reason ? <p>{report.reason}</p> : null}
        {rows.map(([label, pages]) => pages.length ? <div key={label}>{label} · {pages.join("、")}</div> : null)}
        {report.unplacedImages ? <div>{report.unplacedImages} 张原图保存在可编辑项目中</div> : null}
        {report.planningFallback ? <div>全局策划使用了来源章节编排</div> : null}
        {report.issues.map(({ page, detail }, index) => <div key={index}>第 {page} 页 · {detail}</div>)}
        {report.repairedPages?.length ? <div>已按来源修正第 {report.repairedPages.join("、")} 页</div> : null}
        {report.visualReview ? <div>视觉审阅 · {report.visualReview.summary}</div> : null}
        {report.visualReview?.revisedFileId ? <div>修复版本已另存到会话，原文件保留</div> : null}
        {visual ? <div>{visual.summary}</div> : null}
        {visual?.issues?.map(({ page, detail }, index) => <div key={index}>第 {page} 页 · {detail}</div>)}
        {statusMissing ? <div>当前无法读取文件版本报告 <button className="secondary-button compact" type="button" onClick={() => setRefresh(value => value + 1)}>刷新</button></div> : null}
        {version ? <div className="tool-card-template-action">
          {!report.resume ? <button className="secondary-button compact" type="button" disabled={Boolean(busy) || !canUseModel} onClick={() => void update({ kind: "review" })}>
            {busy?.kind === "review" ? "正在视觉审校与修复" : "视觉审校并修复"}
          </button> : null}
          {!report.resume ? [...new Set([...report.fallbackPages, ...report.issues.map(issue => issue.page)])].map(page => <button key={page} className="secondary-button compact" type="button" disabled={Boolean(busy) || !canUseModel} onClick={() => void update({ kind: "page", page })}>
            {busy?.kind === "page" && busy.page === page ? `正在补做第 ${page} 页` : `补做第 ${page} 页`}
          </button>) : null}
          {report.audit !== "complete" && !report.resume ? <button className="secondary-button compact" type="button" disabled={Boolean(busy) || !canUseModel} onClick={() => void update({ kind: "audit" })}>
            {busy?.kind === "audit" ? "正在审校" : "补做内容审校"}
          </button> : null}
          {visual?.status === "unavailable" ? <button className="secondary-button compact" type="button" disabled={Boolean(busy)} onClick={() => void update({ kind: "visual" })}>重新检查 WPS</button> : null}
        </div> : null}
      </div>
    </details>
  );
}
