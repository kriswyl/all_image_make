import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, X } from "lucide-react";
import { api } from "../api";
import { openExternal } from "../external";
import { assertWpsPreviewResult } from "./wps-result";
import { waitForWpsFiles } from "./wps-wait";

type Job = Awaited<ReturnType<typeof api.createWpsPreview>>;
function runWps(addonUrl: string, job: Job, signal: AbortSignal): Promise<{ status: number; message?: string; msg?: string; response?: unknown }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("已关闭预览")); return; }
    const frame = document.createElement("iframe");
    const origin = new URL(addonUrl).origin;
    const requestId = crypto.randomUUID();
    const cleanup = () => { window.clearTimeout(timer); window.removeEventListener("message", receive); signal.removeEventListener("abort", abort); frame.remove(); };
    const abort = () => { cleanup(); reject(new Error("已关闭预览")); };
    const receive = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.contentWindow || event.data?.channel !== "chatcanvas-wps-preview" || event.data?.requestId !== requestId) return;
      cleanup(); resolve(event.data.result);
    };
    const timer = window.setTimeout(() => { cleanup(); reject(new Error("WPS 没有及时响应，请检查加载项和 WPS 状态")); }, 120000);
    window.addEventListener("message", receive);
    signal.addEventListener("abort", abort, { once: true });
    frame.style.display = "none";
    frame.onload = () => frame.contentWindow?.postMessage({ channel: "chatcanvas-wps-preview", action: "render", requestId, id: job.id, secret: job.secret }, origin);
    frame.src = new URL("runner.html", addonUrl).href;
    document.body.appendChild(frame);
  });
}

export function WpsPreview({ conversationId, fileId, name, onClose }: { conversationId: string; fileId: string; name: string; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [images, setImages] = useState<Array<{ page: number; url: string }>>([]);
  const jobRef = useRef<Job | null>(null);
  const urls = useRef<string[]>([]);
  const alive = useRef(true);
  const active = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); if (typeof URL.revokeObjectURL === "function") urls.current.forEach((url) => URL.revokeObjectURL(url)); const current = jobRef.current; if (current) void api.closeWpsPreview(current.id, current.secret).catch(() => {}); }; }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); active.current?.abort(); onClose(); } };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  const addonUrl = new URL(api.assetUrl("/wps-addon/"), window.location.href).href;
  async function enable() {
    setBusy(true); setNotice(""); setError("");
    try {
      await openExternal(new URL("setup.html", addonUrl).href);
      if (alive.current) setNotice("已打开 WPS 加载项设置页面。启用后返回这里；如果需要重启 WPS，请先保存正在编辑的文件。");
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "无法启用 WPS 加载项"); }
    finally { if (alive.current) setBusy(false); }
  }
  async function render(first: number) {
    setBusy(true); setNotice("正在准备只读预览…"); setError("");
    const controller = new AbortController(); active.current = controller;
    let created: Job | null = null;
    try {
      const status = await api.wpsPreviewStatus();
      if (!status.serviceAvailable) throw new Error("WPS 预览服务尚未启动。请先点击“启用 WPS 加载项”，按照浏览器和 WPS 的提示完成设置，再返回预览。");
      created = await api.createWpsPreview(conversationId, fileId, first);
      setNotice(`WPS 正在渲染第 ${created.first}–${created.last} 页…`);
      const rpcController = new AbortController(), pollController = new AbortController();
      const stop = () => { rpcController.abort(); pollController.abort(); };
      controller.signal.addEventListener("abort", stop, { once: true });
      try {
        const poll = waitForWpsFiles(() => api.wpsPreviewDiagnostics(created!.id, created!.secret), pollController.signal, (ready, total) => { if (alive.current) setNotice(`WPS 正在渲染第 ${created!.first}–${created!.last} 页，已完成 ${ready}/${total} 页…`); });
        const rpc = runWps(addonUrl, created, rpcController.signal).then((result) => { assertWpsPreviewResult(result, created!.first, created!.last); }).catch(async (cause) => {
          if (controller.signal.aborted || rpcController.signal.aborted) throw cause;
          const finished = await Promise.race([poll.then(() => true), new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 3000))]);
          if (!finished) throw cause;
        });
        await Promise.race([rpc, poll]);
      } finally { stop(); controller.signal.removeEventListener("abort", stop); }
      const next: Array<{ page: number; url: string }> = [];
      for (let page = created.first; page <= created.last; page++) {
        let blob: Blob | undefined;
        for (let attempt = 0; attempt < 5; attempt++) {
          try { blob = await api.wpsPreviewPage(created.id, created.secret, page); break; }
          catch { if (attempt < 4) await new Promise((resolve) => window.setTimeout(resolve, 400)); }
        }
        if (!blob) {
          const diagnostics = await api.wpsPreviewDiagnostics(created.id, created.secret).catch(() => null);
          throw new Error(`WPS 未生成第 ${page} 页预览图片。${diagnostics?.files.length ? `已发现：${diagnostics.files.join("、")}` : "没有发现导出的页面文件。"}`);
        }
        const url = URL.createObjectURL(blob); urls.current.push(url); next.push({ page, url });
      }
      if (!alive.current) { void api.closeWpsPreview(created.id, created.secret).catch(() => {}); return; }
      const oldJob = jobRef.current;
      const oldUrls = images.map((image) => image.url);
      setImages(next); setJob(created); jobRef.current = created;
      oldUrls.forEach((url) => { URL.revokeObjectURL(url); urls.current = urls.current.filter((item) => item !== url); });
      if (oldJob) void api.closeWpsPreview(oldJob.id, oldJob.secret).catch(() => {});
      setNotice(`已渲染第 ${created.first}–${created.last} 页，共 ${created.total} 页。`);
    } catch (cause) {
      if (created) void api.closeWpsPreview(created.id, created.secret).catch(() => {});
      if (alive.current) { setNotice(""); setError(cause instanceof Error ? cause.message : "WPS 预览失败"); }
    } finally { if (active.current === controller) active.current = null; if (alive.current) setBusy(false); }
  }
  return createPortal(<div className="mind-preview-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) { active.current?.abort(); onClose(); } }}><section className="mind-preview-dialog wps-preview-dialog" role="dialog" aria-modal="true" aria-label="WPS PPT 预览">
    <header><div><strong>WPS 逐页预览（测试版）</strong><small>{name} · 通过本机 WPS 只读渲染临时副本</small></div><button className="icon-button" type="button" aria-label="关闭" onClick={() => { active.current?.abort(); onClose(); }}><X size={18} /></button></header>
    <main>{error ? <p role="alert" className="story-review-error">{error}</p> : null}{notice ? <p role="status" className="mind-preview-hint">{busy ? <LoaderCircle className="spin" size={14} /> : null} {notice}</p> : null}{!images.length ? <p className="mind-preview-hint">首次使用请先启用加载项；完成后开始预览。预览仅使用应用生成文件的临时副本。</p> : <div className="wps-preview-pages">{images.map((image) => <figure key={image.page}><figcaption>第 {image.page} 页</figcaption><img src={image.url} alt={`第 ${image.page} 页`} /></figure>)}</div>}</main>
    <footer><button type="button" className="secondary-button" onClick={() => void enable()} disabled={busy}>启用 WPS 加载项</button>{job && job.first > 1 ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void render(Math.max(1, job.first - 20))}>上一批</button> : null}{job && job.last < job.total ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void render(job.last + 1)}>下一批</button> : null}<button type="button" className="primary-button" disabled={busy} onClick={() => void render(job?.first ?? 1)}>{busy ? <LoaderCircle className="spin" size={15} /> : null}{images.length ? "重新预览" : "开始预览"}</button></footer>
  </section></div>, document.body);
}
