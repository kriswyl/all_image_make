import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import net from "node:net";
import JSZip from "jszip";
import type { AppDatabase } from "./db.js";
import { readWorkspaceFile } from "./chat-tools/documents.js";
import { AppError } from "./tasks.js";

type PreviewJob = { id: string; secret: string; dir: string; source: string; first: number; last: number; total: number; expires: number };
const MAX_AGE = 10 * 60_000;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const managers = new WeakMap<AppDatabase, WpsPreviewJobs>();
export function getWpsPreviewJobs(db: AppDatabase) { let manager = managers.get(db); if (!manager) { manager = new WpsPreviewJobs(db); managers.set(db, manager); } return manager; }

export function isWpsServiceRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: 58890 });
    let settled = false;
    const done = (value: boolean) => { if (settled) return; settled = true; socket.destroy(); resolve(value); };
    socket.setTimeout(600); socket.once("connect", () => done(true)); socket.once("error", () => done(false)); socket.once("timeout", () => done(false));
  });
}

/** Short-lived capabilities let the add-in render only a server-created copy of a specific PPTX. */
export class WpsPreviewJobs {
  private jobs = new Map<string, PreviewJob>();
  constructor(private readonly db: AppDatabase) {}
  async create(conversationId: string, fileId: string, first: number) {
    this.cleanupExpired();
    if (this.jobs.size >= 4) throw new AppError("WPS_PREVIEW_BUSY", "当前预览任务过多，请先关闭其他预览", 429);
    let file: ReturnType<typeof readWorkspaceFile>;
    try { file = readWorkspaceFile(this.db, conversationId, fileId); } catch { throw new AppError("WPS_PREVIEW_NOT_FOUND", "文件不存在或不属于当前会话", 404); }
    return this.createBytes(file.bytes, file.name, first);
  }
  async createBytes(bytes: Buffer, name: string, first: number) {
    this.cleanupExpired();
    if (this.jobs.size >= 4) throw new AppError("WPS_PREVIEW_BUSY", "当前预览任务过多", 429);
    const file = { bytes, name };
    if (!/\.pptx$/i.test(file.name)) throw new AppError("WPS_PREVIEW_INVALID", "WPS 预览目前仅支持会话中生成的 PPTX", 400);
    let zip: JSZip;
    try { zip = await JSZip.loadAsync(file.bytes); } catch { throw new AppError("WPS_PREVIEW_INVALID", "PPTX 无法读取", 400); }
    const entries = Object.keys(zip.files);
    if (entries.length > 10000 || entries.some((name) => /(?:^|\/)vbaProject\.bin$/i.test(name))) throw new AppError("WPS_PREVIEW_INVALID", "PPTX 包含不支持的内容", 400);
    let uncompressed = 0;
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
      if (!Number.isSafeInteger(size) || size! < 0 || size! > 32 * 1024 * 1024) throw new AppError("WPS_PREVIEW_INVALID", "PPTX 内容过大或无法验证", 400);
      uncompressed += size!;
      if (uncompressed > 100 * 1024 * 1024) throw new AppError("WPS_PREVIEW_INVALID", "PPTX 解压后的内容过大", 400);
    }
    for (const name of entries.filter((entry) => entry.endsWith(".rels"))) {
      const entry = zip.file(name)!;
      const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
      if (!Number.isFinite(size) || size! > 1_000_000) throw new AppError("WPS_PREVIEW_INVALID", "PPTX 关系数据过大", 400);
      if (/\bTargetMode\s*=/i.test(await entry.async("string"))) throw new AppError("WPS_PREVIEW_INVALID", "PPTX 包含外部链接或特殊关系，不能自动预览", 400);
    }
    const slideNumbers = entries.map((name) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(name)).filter(Boolean).map((match) => Number(match![1])).sort((a, b) => a - b);
    if (!slideNumbers.length || slideNumbers.length > 200 || slideNumbers.some((number, index) => number !== index + 1)) throw new AppError("WPS_PREVIEW_INVALID", "PPTX 页数无效或超过 200 页", 400);
    if (!Number.isInteger(first) || first < 1 || first > slideNumbers.length) throw new AppError("WPS_PREVIEW_INVALID", "预览页码超出范围", 400);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatcanvas-wps-preview-"));
    const job: PreviewJob = { id: randomUUID(), secret: randomBytes(32).toString("hex"), dir, source: path.join(dir, "source.pptx"), first, last: Math.min(first + 19, slideNumbers.length), total: slideNumbers.length, expires: Date.now() + MAX_AGE };
    try { fs.writeFileSync(job.source, file.bytes, { flag: "wx" }); } catch (error) { fs.rmSync(dir, { recursive: true, force: true }); throw error; }
    this.jobs.set(job.id, job);
    const timer = setTimeout(() => { if (this.jobs.get(job.id) === job) this.remove(job); }, MAX_AGE);
    timer.unref();
    return { id: job.id, secret: job.secret, first: job.first, last: job.last, total: job.total };
  }
  private get(id: string, secret: string): PreviewJob {
    const job = this.jobs.get(id);
    if (!job || job.expires < Date.now() || !/^[a-f0-9]{64}$/.test(secret)) throw new AppError("WPS_PREVIEW_NOT_FOUND", "预览任务不存在或已过期", 404);
    if (!timingSafeEqual(Buffer.from(secret, "hex"), Buffer.from(job.secret, "hex"))) throw new AppError("WPS_PREVIEW_NOT_FOUND", "预览任务不存在或已过期", 404);
    return job;
  }
  claim(id: string, secret: string) {
    const job = this.get(id, secret);
    return { source: job.source, dir: job.dir, first: job.first, last: job.last, total: job.total };
  }
  private validatedPage(job: PreviewJob, number: number): string {
    if (!Number.isInteger(number) || number < job.first || number > job.last) throw new AppError("WPS_PREVIEW_INVALID", "预览页码超出范围", 400);
    const base = `page-${String(number).padStart(3, "0")}`;
    const file = [`.png`, `.PNG`, ""].map((suffix) => path.join(job.dir, `${base}${suffix}`)).find((candidate) => fs.existsSync(candidate));
    if (!file) throw new AppError("WPS_PREVIEW_NOT_FOUND", `WPS 未生成第 ${number} 页的图片`, 404);
    if (fs.lstatSync(job.dir).isSymbolicLink()) throw new AppError("WPS_PREVIEW_INVALID", "预览目录无效", 400);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 8 * 1024 * 1024 || stat.size < 45) throw new AppError("WPS_PREVIEW_INVALID", "预览图片尚未完成或无效", 400);
    const header = Buffer.alloc(24), tail = Buffer.alloc(12);
    const fd = fs.openSync(file, "r");
    try { fs.readSync(fd, header, 0, 24, 0); fs.readSync(fd, tail, 0, 12, stat.size - 12); } finally { fs.closeSync(fd); }
    const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
    if (!header.subarray(0, 8).equals(PNG_SIGNATURE) || header.readUInt32BE(8) !== 13 || header.toString("ascii", 12, 16) !== "IHDR" || !width || !height || width > 4096 || height > 4096 || tail.toString("hex") !== "0000000049454e44ae426082") throw new AppError("WPS_PREVIEW_INVALID", "预览图片尚未完成或无效", 400);
    return file;
  }
  page(id: string, secret: string, number: number): Buffer {
    return fs.readFileSync(this.validatedPage(this.get(id, secret), number));
  }
  diagnostics(id: string, secret: string) {
    const job = this.get(id, secret);
    if (fs.lstatSync(job.dir).isSymbolicLink()) throw new AppError("WPS_PREVIEW_INVALID", "预览目录无效", 400);
    const files = fs.readdirSync(job.dir).filter((name) => /^page-\d{3}(?:\.png)?$/i.test(name)).slice(0, 20);
    let ready = 0;
    for (let page = job.first; page <= job.last; page++) { try { this.validatedPage(job, page); ready++; } catch { /* Page is still being written. */ } }
    return { files, ready, total: job.last - job.first + 1, first: job.first, last: job.last };
  }
  close(id: string, secret: string) { const job = this.get(id, secret); this.remove(job); }
  private remove(job: PreviewJob) {
    this.jobs.delete(job.id);
    const root = path.resolve(os.tmpdir()); const dir = path.resolve(job.dir);
    if (path.dirname(dir).toLowerCase() !== root.toLowerCase() || !path.basename(dir).startsWith("chatcanvas-wps-preview-")) return;
    try { if (!fs.lstatSync(dir).isSymbolicLink()) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Already removed. */ }
  }
  private cleanupExpired() { for (const job of this.jobs.values()) if (job.expires < Date.now()) this.remove(job); }
}
