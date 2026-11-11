import { createHash, randomUUID } from "node:crypto";
import { Jimp } from "jimp";
import type { PresentationVisualCheck } from "../shared/presentation-report.js";
import { readWorkspaceFile } from "./chat-tools/document-workspace.js";
import type { AppDatabase } from "./db.js";
import { readPresentationProject } from "./presentation-project.js";
import { renderWithLocalWps } from "./wps-auto-render.js";
import { completePendingVisualCheck, readCandidateBytes, reconcilePendingVisualChecks } from "./document-publish.js";

const PAGE_LIMIT = 20;

/** 正式文件与「等待发布的候选」都从磁盘读自己的字节，候选不允许被当成不存在。 */
function readCheckBytes(db: AppDatabase, conversationId: string, fileId: string): Buffer {
  try {
    return readWorkspaceFile(db, conversationId, fileId).bytes;
  } catch (error) {
    const candidate = db.getCandidateById(conversationId, fileId);
    if (!candidate) throw error;
    return readCandidateBytes(db, conversationId, candidate);
  }
}

/** One local WPS job at a time. The lease prevents an interrupted job from updating a newer check. */
export class PresentationCheckQueue {
  private running = false;
  private requested = false;
  private readonly stop = new AbortController();

  constructor(private readonly db: AppDatabase) {}

  recover() {
    this.db.recoverPresentationChecks();
    // 等待视觉发布的候选在重启后重新排队；已发布的清掉登记。
    reconcilePendingVisualChecks(this.db);
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
      const issues: NonNullable<PresentationVisualCheck["issues"]> = [];
      try {
        const bytes = readCheckBytes(this.db, job.conversationId, job.fileId);
        const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
        if (hash(bytes) !== job.sha256) throw new Error("已交付文件在外部发生变化");
        const project = await readPresentationProject(bytes);
        if (!project) throw new Error("无法读取此版本的页面");
        const total = project.plan.slides.length;
        signal.throwIfAborted();
        const pages = await renderWithLocalWps(this.db, bytes, signal, PAGE_LIMIT);
        signal.throwIfAborted();
        if (pages.length !== Math.min(total, PAGE_LIMIT)) throw new Error("WPS 返回的页数不完整");
        for (const [index, pageBytes] of pages.entries()) {
          const image = await Jimp.read(pageBytes);
          image.resize({ w: 64, h: 36 });
          const pixels = image.bitmap.data;
          if (pixels.every((channel, i) => channel === pixels[i % 4])) {
            issues.push({ page: index + 1, detail: "WPS 渲染结果为单色，请打开预览确认页面内容" });
          }
          signal.throwIfAborted();
        }
        if (hash(readCheckBytes(this.db, job.conversationId, job.fileId)) !== job.sha256) throw new Error("检查期间文件发生变化");
        result = { status: "checked", summary: `WPS 已核验 ${pages.length}/${total} 页的渲染完整性`, issues };
      } catch (error) {
        if (this.stop.signal.aborted) return;
        const reason = signal.aborted ? "WPS 检查超时" : error instanceof Error ? error.message.slice(0, 120) : "本机 WPS 暂不可用";
        result = { status: "unavailable", summary: `未检查 · ${reason}` };
      }
      if (!this.stop.signal.aborted) {
        this.db.finishPresentationCheck(job.fileId, lease, result);
        // 渲染检查完成即尝试发布等待中的同一候选；重复回调由发布日志与候选 state 保证只发一次。
        const pending = this.db.listPendingVisualPublishes()
          .find(item => item.candidateId === job.fileId && item.conversationId === job.conversationId);
        if (pending) {
          try {
            completePendingVisualCheck(this.db, {
              conversationId: job.conversationId, candidateId: job.fileId,
              status: result.status === "checked" && !issues.length ? "complete" : "unavailable",
              source: "wps-render", summary: result.summary,
              blocking: issues.map(issue => `第 ${issue.page} 页：${issue.detail}`),
            });
          } catch (error) {
            if (!this.stop.signal.aborted) console.warn("等待中的候选发布失败", error);
          }
        }
      }
    }
  }
}
