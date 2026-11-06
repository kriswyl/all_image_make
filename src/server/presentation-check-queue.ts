import { createHash, randomUUID } from "node:crypto";
import { Jimp } from "jimp";
import type { PresentationVisualCheck } from "../shared/presentation-report.js";
import { readWorkspaceFile } from "./chat-tools/documents.js";
import type { AppDatabase } from "./db.js";
import { readPresentationProject } from "./presentation-project.js";
import { renderWithLocalWps } from "./wps-auto-render.js";

const PAGE_LIMIT = 20;

/** One local WPS job at a time. The lease prevents an interrupted job from updating a newer check. */
export class PresentationCheckQueue {
  private running = false;
  private requested = false;
  private readonly stop = new AbortController();

  constructor(private readonly db: AppDatabase) {}

  recover() {
    this.db.recoverPresentationChecks();
    this.kick();
  }

  dispose() { this.stop.abort(); }

  kick() {
    if (this.stop.signal.aborted) return;
    if (this.running) { this.requested = true; return; }
    this.running = true;
    void this.drain().catch(error => {
      if (!this.stop.signal.aborted) console.warn("PPT 检查队列中断", error);
    }).finally(() => {
      this.running = false;
      if (this.requested) { this.requested = false; this.kick(); }
    });
  }

  private async drain() {
    while (!this.stop.signal.aborted) {
      const lease = randomUUID();
      const job = this.db.claimPresentationCheck(lease);
      if (!job) return;
      const signal = AbortSignal.any([this.stop.signal, AbortSignal.timeout(45_000)]);
      let result: PresentationVisualCheck;
      try {
        const file = readWorkspaceFile(this.db, job.conversationId, job.fileId);
        const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
        if (hash(file.bytes) !== job.sha256) throw new Error("已交付文件在外部发生变化");
        const project = await readPresentationProject(file.bytes);
        if (!project) throw new Error("无法读取此版本的页面");
        const total = project.plan.slides.length;
        signal.throwIfAborted();
        const pages = await renderWithLocalWps(this.db, file.bytes, signal, PAGE_LIMIT);
        signal.throwIfAborted();
        if (pages.length !== Math.min(total, PAGE_LIMIT)) throw new Error("WPS 返回的页数不完整");
        const issues: NonNullable<PresentationVisualCheck["issues"]> = [];
        for (const [index, bytes] of pages.entries()) {
          const image = await Jimp.read(bytes);
          image.resize({ w: 64, h: 36 });
          const pixels = image.bitmap.data;
          if (pixels.every((channel, i) => channel === pixels[i % 4])) {
            issues.push({ page: index + 1, detail: "WPS 渲染结果为单色，请打开预览确认页面内容" });
          }
          signal.throwIfAborted();
        }
        if (hash(readWorkspaceFile(this.db, job.conversationId, job.fileId).bytes) !== job.sha256) throw new Error("检查期间文件发生变化");
        result = { status: "checked", summary: `WPS 已核验 ${pages.length}/${total} 页的渲染完整性`, issues };
      } catch (error) {
        if (this.stop.signal.aborted) return;
        const reason = signal.aborted ? "WPS 检查超时" : error instanceof Error ? error.message.slice(0, 120) : "本机 WPS 暂不可用";
        result = { status: "unavailable", summary: `未检查 · ${reason}` };
      }
      if (!this.stop.signal.aborted) this.db.finishPresentationCheck(job.fileId, lease, result);
    }
  }
}
