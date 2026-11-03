import { randomUUID } from "node:crypto";
import type { AppDatabase } from "./db.js";
import { getWpsPreviewJobs, isWpsServiceRunning } from "./wps-preview.js";

/** Invoke only our installed add-in, against a short-lived copy validated by the preview manager. */
export async function renderWithLocalWps(db: AppDatabase, bytes: Buffer, signal?: AbortSignal): Promise<Buffer[]> {
  if (!await isWpsServiceRunning()) throw new Error("本机 WPS 渲染服务未启动");
  const manager = getWpsPreviewJobs(db); const pages: Buffer[] = [];
  let total = 1;
  for (let first = 1; first <= total; first += 20) {
    signal?.throwIfAborted();
    const job = await manager.createBytes(bytes, "review.pptx", first); total = job.total;
    const abort = new AbortController(); const stop = () => abort.abort(); signal?.addEventListener("abort", stop, { once: true });
    try {
      const info = { name: "ChatCanvasPreview", function: "RenderPreview", info: { id: job.id, secret: job.secret }, showToFront: false, jsPluginsXml: "" };
      let dispatchError: Error | undefined;
      const request = fetch("http://127.0.0.1:58890/transferEx/runParams", { method: "POST", body: JSON.stringify({ id: "", app: "wpp", data: Buffer.from(JSON.stringify(info)).toString("base64"), mode: "false", timeout: 90000 }), signal: abort.signal }).then(async (response) => {
        if (!response.ok) throw new Error(`WPS 调用失败：HTTP ${response.status}`);
        const result = JSON.parse(await response.text());
        let data = result.data; if (typeof data === "string") { try { data = JSON.parse(data); } catch { /* old WPS version */ } }
        if (data?.ok === false) throw new Error(`WPS ${data.stage || "渲染"}失败：${data.message || "未知错误"}`);
      }).catch((error) => { if (!abort.signal.aborted) dispatchError = error instanceof Error ? error : new Error("WPS 调用失败"); });
      const deadline = Date.now() + 90000;
      while (manager.diagnostics(job.id, job.secret).ready < job.last - job.first + 1) {
        signal?.throwIfAborted();
        if (dispatchError) throw dispatchError;
        if (Date.now() > deadline) throw new Error("WPS 未及时生成页面；请确认加载项已启用");
        await new Promise<void>((resolve) => { const timer = setTimeout(resolve, 300); const cancel = () => { clearTimeout(timer); resolve(); }; signal?.addEventListener("abort", cancel, { once: true }); setTimeout(() => signal?.removeEventListener("abort", cancel), 301).unref(); });
      }
      for (let page = job.first; page <= job.last; page++) pages.push(manager.page(job.id, job.secret, page));
      abort.abort(); await request;
    } finally { abort.abort(); signal?.removeEventListener("abort", stop); manager.close(job.id, job.secret); }
  }
  return pages;
}
