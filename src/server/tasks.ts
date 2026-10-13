import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { isVideoAdapter as isVideoAdapterType } from "../shared/types.js";
import type { GenerationInput, ReferenceImageInput, Task } from "../shared/types.js";
import type { AppDatabase, DbChannel, TaskRow } from "./db.js";
import {
  RemoteApiError,
  buildGenerationRequest,
  extractImageCandidates,
  extractVideoCandidates,
  requestForDiagnostic,
  sendPreparedRequest,
  type ImageCandidate,
  type VideoCandidate,
} from "./adapters.js";
import { joinEndpoint, redact, safeFetch, safeFileName } from "./security.js";
import type { KeyStore } from "./key-store.js";

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const VIDEO_POLL_INTERVAL_MS = 8000;
const VIDEO_MAX_POLLS = 100;

/** 上游与中转对“生成完成”的叫法不统一，逐个列出 */
const VIDEO_SUCCESS_STATUSES = ["succeeded", "success", "done", "completed", "complete", "finished", "ok"];
/**
 * 真正代表失败的终态。
 *
 * 这里刻意不含 `unknown`：中转在任务刚提交、上游还没回报时就会先回一个
 * `{ status: "unknown", progress: 0 }`，把它当成失败会误杀仍在生成的视频
 * （用户实际遇到：上游生成成功，应用却立刻报 REMOTE_TASK_FAILED）。
 * pending / queued / processing / running 同理，都属于“还没好”，继续轮询即可。
 */
const VIDEO_FAILURE_STATUSES = ["failed", "failure", "error", "canceled", "cancelled", "expired", "rejected", "timeout"];

/** 中转站对请求体的实际上限在 1~2MB 之间（实测 1MB 通过、2MB 被网关掐断），
 *  且超限时只回含糊的 502 / fetch failed。内联 base64 素材超过这个字符数就提前拦下。 */
const MAX_INLINE_MEDIA_CHARS = 1_400_000;

/** 轮询节奏可被环境变量覆盖，测试里用短间隔跑完整个提交流程 */
const VIDEO_POLL_DELAY_MS = (() => {
  const raw = Number(process.env.VIDEO_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : VIDEO_POLL_INTERVAL_MS;
})();

/** 视频任务的状态查询路径。提交路径在 adapters.ts，两处都要跟着官方文档改 */
export function videoPollEndpoint(adapterType: string, remoteTaskId: string) {
  if (adapterType === "wan-video") return `/api/v1/tasks/${remoteTaskId}`;
  if (adapterType === "seedance-video") return `/api/v3/contents/generations/tasks/${remoteTaskId}`;
  return `/v1/videos/${remoteTaskId}`;
}

interface StoredReferenceImage extends Omit<ReferenceImageInput, "base64"> {
  relativePath: string;
  byteSize: number;
}

interface StoredGenerationInput extends Omit<GenerationInput, "referenceImage" | "referenceImages"> {
  referenceImage?: StoredReferenceImage;
  referenceImages?: StoredReferenceImage[];
}

export interface ReferenceImageUpload {
  bytes: Buffer;
  mimeType: ReferenceImageInput["mimeType"];
  fileName: string;
}

export class TaskRunner {
  private readonly running = new Set<string>();

  constructor(private readonly db: AppDatabase, private readonly sessionKeys: KeyStore) {}

  async create(input: GenerationInput, uploads: ReferenceImageUpload[] = []): Promise<Task> {
    const channel = this.db.getChannel(input.channelId);
    if (!channel || !channel.enabled) throw new AppError("CHANNEL_NOT_FOUND", "渠道不存在或未启用", 404);
    if (!channel.models.includes(input.model)) throw new AppError("MODEL_NOT_FOUND", "该模型不在渠道模型列表中", 400);
    if (!input.prompt.trim()) throw new AppError("INVALID_INPUT", "提示词不能为空", 400);
    if (input.prompt.length > 20000) throw new AppError("INVALID_INPUT", "提示词不能超过 20000 个字符", 400);
    const rawSize = JSON.stringify(input.rawParameters ?? {}).length;
    if (rawSize > 65536) throw new AppError("INVALID_INPUT", "高级参数不能超过 64 KB", 400);
    const inlineMediaChars = inlineMediaSize(input);
    if (inlineMediaChars > MAX_INLINE_MEDIA_CHARS) {
      throw new AppError(
        "INVALID_INPUT",
        `内联图片合计约 ${(inlineMediaChars / 1024 / 1024).toFixed(1)}MB，超出中转站约 1.4MB 的请求体上限，请改用更小的图片或公网图片地址`,
        400,
      );
    }
    const id = crypto.randomUUID();
    const sources = uploads.length ? uploads : referenceInputs(input).map((image) => ({
      bytes: Buffer.from(image.base64, "base64"), mimeType: image.mimeType, fileName: image.fileName,
    }));
    const storedInput = await this.persistInputImages(id, input, sources);
    this.db.createTask({ id, channelId: channel.id, model: input.model, prompt: input.prompt, input: storedInput });
    queueMicrotask(() => void this.run(id));
    return this.db.getTaskView(id)!;
  }

  async run(taskId: string) {
    if (this.running.has(taskId)) return;
    this.running.add(taskId);
    try {
      const task = this.requireTask(taskId);
      const channel = this.requireChannel(task.channelId);
      const input = await this.hydrateInputImages(JSON.parse(task.inputJson) as StoredGenerationInput);
      const key = this.resolveKey(channel);
      this.db.updateTask(taskId, { status: "validating", startedAt: task.startedAt ?? new Date().toISOString(), errorCode: null, errorMessage: null });
      const prepared = buildGenerationRequest(channel, input, key);
      const effectiveBody = requestForDiagnostic(prepared).body ?? {};
      this.db.updateTask(taskId, { status: "submitting", effectiveJson: JSON.stringify(effectiveBody), attemptCount: task.attemptCount + 1 });
      const result = await this.sendWithDiagnostic(taskId, prepared);

      // Check if this is an async video generation (返回task_id需要轮询)
      const isVideoAdapter = isVideoAdapterType(channel.adapterType);
      const asyncTaskId = this.extractAsyncTaskId(result.payload);

      if (isVideoAdapter && asyncTaskId) {
        // 先记下上游 task id：进程重启后靠它接着轮询，而不是把任务判死
        this.db.updateTask(taskId, { remoteTaskId: asyncTaskId });
        await this.pollVideoTask(taskId, asyncTaskId, channel, key);
        return;
      }

      // Sync response: extract images immediately
      const images = extractImageCandidates(result.payload);
      if (images.length) {
        await this.saveImages(taskId, images, channel);
        this.db.updateTask(taskId, { status: "succeeded", progress: 100, finishedAt: new Date().toISOString() });
        return;
      }

      throw new AppError("RESPONSE_PARSE_FAILED", "响应中没有找到图片或视频", 502);
    } catch (error) {
      const current = this.db.getTaskRow(taskId);
      if (current?.status !== "cancelled") {
        const normalized = normalizeError(error);
        this.db.updateTask(taskId, { status: "failed", errorCode: normalized.code, errorMessage: normalized.message, finishedAt: new Date().toISOString() });
      }
    } finally {
      this.running.delete(taskId);
    }
  }

  cancel(taskId: string) {
    const task = this.requireTask(taskId);
    if (["succeeded", "failed", "cancelled", "expired"].includes(task.status)) return this.db.getTaskView(taskId)!;
    this.db.updateTask(taskId, { status: "cancelled", finishedAt: new Date().toISOString() });
    return this.db.getTaskView(taskId)!;
  }

  async retry(taskId: string) {
    const task = this.requireTask(taskId);
    const input = await this.hydrateInputImages(JSON.parse(task.inputJson) as StoredGenerationInput);
    return this.create(input);
  }

  /**
   * 进程重启时收拾残留的进行中任务。
   *
   * 已经拿到上游 task id 的视频任务可以直接接着轮询——参考图、请求体都在库里，
   * 上游通常还在跑，没有理由让用户白等一场。其余情况（还没提交出去、同步请求、
   * 渠道被删）没法跨重启恢复，只能标记失败。
   */
  async resume() {
    for (const task of this.db.listPendingTasks()) {
      const channel = task.remoteTaskId ? this.db.getChannel(task.channelId) : null;
      if (!channel || !isVideoAdapterType(channel.adapterType)) {
        this.markFailed(task.id, "SERVICE_RESTARTED", "服务已重启，请重新生成");
        continue;
      }
      // 不 await：多个任务并行恢复，任一失败都不能拖住启动
      void this.resumePolling(task.id, task.remoteTaskId!, channel);
    }
  }

  private async resumePolling(taskId: string, remoteTaskId: string, channel: DbChannel) {
    if (this.running.has(taskId)) return;
    this.running.add(taskId);
    try {
      await this.pollVideoTask(taskId, remoteTaskId, channel, this.resolveKey(channel), { immediate: true });
    } catch (error) {
      const current = this.db.getTaskRow(taskId);
      if (current && !["succeeded", "failed", "cancelled", "expired"].includes(current.status)) {
        const normalized = normalizeError(error);
        this.markFailed(taskId, normalized.code, normalized.message);
      }
    } finally {
      this.running.delete(taskId);
    }
  }

  private markFailed(taskId: string, code: string, message: string) {
    this.db.updateTask(taskId, { status: "failed", errorCode: code, errorMessage: message, finishedAt: new Date().toISOString() });
  }

  private async sendWithDiagnostic(taskId: string, prepared: ReturnType<typeof buildGenerationRequest>) {
    try {
      const result = await sendPreparedRequest(prepared);
      this.db.insertDiagnostic({ taskId, request: redact(requestForDiagnostic(prepared)), response: redact(truncatePayload(result.payload)), httpStatus: result.status, durationMs: result.durationMs });
      return result;
    } catch (error) {
      if (error instanceof RemoteApiError) {
        this.db.insertDiagnostic({ taskId, request: redact(requestForDiagnostic(prepared)), response: redact(truncatePayload(error.payload)), httpStatus: error.status });
      }
      throw error;
    }
  }

  private extractAsyncTaskId(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") return null;
    const record = payload as Record<string, unknown>;
    // Wan3.0: { task_id } 或 { output: { task_id } }
    if (typeof record.task_id === "string") return record.task_id;
    // Grok: { request_id }
    if (typeof record.request_id === "string") return record.request_id;
    // Seedance: { id }
    if (typeof record.id === "string") return record.id;
    if (record.output && typeof record.output === "object") {
      const output = record.output as Record<string, unknown>;
      if (typeof output.task_id === "string") return output.task_id;
      if (typeof output.id === "string") return output.id;
    }
    return null;
  }

  private async pollVideoTask(
    localTaskId: string,
    remoteTaskId: string,
    channel: DbChannel,
    key: string,
    options: { immediate?: boolean } = {},
  ) {
    this.db.updateTask(localTaskId, { status: "running", remoteTaskId });
    // 提交路径走 joinEndpoint（会吃掉 Base URL 的尾斜杠），轮询这里必须一致，
    // 否则 Base URL 填成 https://api.x.com/ 时会「提交成功、轮询 404」
    const url = joinEndpoint(channel.baseUrl, videoPollEndpoint(channel.adapterType, remoteTaskId));

    const headers: Record<string, string> = { Accept: "application/json" };
    if (channel.authType === "bearer") headers.Authorization = `Bearer ${key}`;
    else if (channel.authType === "x-api-key") headers[channel.authHeaderName || "x-api-key"] = key;

    // 一个视频任务最多轮询 100 次，每次都写完整响应能堆到几 MB。这里只让
    // 「最后一次」保留完整响应，之前的行等下一次轮询到来时按精简格式落库
    let pending: { index: number; payload: unknown; httpStatus: number; durationMs: number } | null = null;
    const flushPending = () => {
      if (!pending) return;
      this.db.insertDiagnostic({
        taskId: localTaskId,
        request: { url, method: "GET", polls: pending.index },
        response: redact(truncatePayload(pending.payload)),
        httpStatus: pending.httpStatus,
        durationMs: pending.durationMs,
      });
      pending = null;
    };

    try {
      for (let poll = 0; poll < VIDEO_MAX_POLLS; poll += 1) {
        const current = this.db.getTaskRow(localTaskId);
        if (current?.status === "cancelled") return;

        // 重启恢复时第一轮不再等：上游要是早没了，没必要再耗一个间隔
        if (poll > 0 || !options.immediate) {
          await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_DELAY_MS));
        }

        let response: Response;
        let payload: unknown;
        let durationMs: number;
        try {
          const startedAt = Date.now();
          response = await safeFetch(url, { method: "GET", headers }, { allowPrivateNetwork: channel.allowPrivateNetwork });
          durationMs = Date.now() - startedAt;
          // 网关出错时多半回的是 HTML，强行 json() 会抛 SyntaxError 掩盖真实状态码
          payload = await response.json().catch(() => null);
        } catch (error) {
          throw new AppError("VIDEO_POLL_FAILED", error instanceof Error ? error.message : "轮询视频状态失败", 502);
        }

        // 上一次轮询既然不是终点，就降级成一条状态摘要
        if (pending) {
          this.db.insertDiagnostic({
            taskId: localTaskId,
            request: null,
            response: {
              poll: pending.index,
              status: this.extractVideoStatus(pending.payload),
              progress: this.extractVideoProgress(pending.payload),
            },
            httpStatus: pending.httpStatus,
            durationMs: pending.durationMs,
          });
        }
        pending = { index: poll + 1, payload, httpStatus: response.status, durationMs };

        // 上游已经不认这个任务了，再轮询 100 次也没有结果
        if (response.status === 404) {
          throw new AppError("REMOTE_TASK_NOT_FOUND", "上游已找不到该任务，可能已过期或被清理", 502);
        }

        const status = this.extractVideoStatus(payload);
        const progress = this.extractVideoProgress(payload);
        if (progress !== null) this.db.updateTask(localTaskId, { progress });

        // 先判失败：只有明确的失败状态才算失败，unknown / pending / running 都继续轮询
        if (status && VIDEO_FAILURE_STATUSES.includes(status)) {
          const errorMsg = this.extractVideoError(payload);
          throw new AppError(
            "REMOTE_TASK_FAILED",
            errorMsg || `视频生成失败（状态 ${status}）：${JSON.stringify(payload).slice(0, 300)}`,
            502,
          );
        }

        const succeeded = Boolean(status && VIDEO_SUCCESS_STATUSES.includes(status));
        const videos = extractVideoCandidates(payload);
        // 状态说完成时收下全部候选；状态还停在 unknown / running 时，只认字段名带 video
        // 或地址本身是视频扩展名的候选——中转生成完经常不更新 status，只把 video 填上
        const readyVideos = succeeded ? videos : videos.filter((video) => video.strong);
        if (succeeded || readyVideos.length) {
          const chosen = readyVideos.length ? readyVideos : videos;
          if (chosen.length === 0) {
            throw new AppError(
              "RESPONSE_PARSE_FAILED",
              `视频生成完成但响应中没有找到视频 URL。原始响应：${JSON.stringify(payload).slice(0, 500)}`,
              502,
            );
          }
          // 下载失败时 saveVideos 会把视频链接带进报错，方便手动打开核对
          await this.saveVideos(localTaskId, chosen, channel);
          this.db.updateTask(localTaskId, { status: "succeeded", progress: 100, finishedAt: new Date().toISOString() });
          return;
        }

        // Still running, continue polling
      }

      throw new AppError("VIDEO_TIMEOUT", `视频生成超时（已轮询 ${VIDEO_MAX_POLLS} 次）`, 504);
    } finally {
      // 最后一条轮询（成功、失败、超时都一样）保留完整响应：排查时最有用的是它
      flushPending();
    }
  }

  /**
   * 各家字段名不同：Grok 用 status，万相用 output.task_status，
   * 部分中转还会把任务包在 data / result 里。顶层优先，找不到再看下一层。
   */
  private extractVideoStatus(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") return null;
    const record = payload as Record<string, unknown>;
    if (typeof record.status === "string") return record.status.toLowerCase();
    if (typeof record.task_status === "string") return record.task_status.toLowerCase();
    for (const key of ["output", "data", "result"]) {
      const nested = record[key];
      if (!nested || typeof nested !== "object") continue;
      const inner = nested as Record<string, unknown>;
      if (typeof inner.task_status === "string") return inner.task_status.toLowerCase();
      if (typeof inner.status === "string") return inner.status.toLowerCase();
    }
    return null;
  }

  private extractVideoProgress(payload: unknown): number | null {
    if (!payload || typeof payload !== "object") return null;
    const record = payload as Record<string, unknown>;
    if (typeof record.progress === "number") return Math.min(99, Math.max(0, record.progress));
    for (const key of ["output", "data", "result"]) {
      const nested = record[key];
      if (!nested || typeof nested !== "object") continue;
      const progress = (nested as Record<string, unknown>).progress;
      if (typeof progress === "number") return Math.min(99, Math.max(0, progress));
    }
    return null;
  }

  private extractVideoError(payload: unknown): string | null {
    if (!payload || typeof payload !== "object") return null;
    const record = payload as Record<string, unknown>;
    if (record.error && typeof record.error === "object") {
      const error = record.error as Record<string, unknown>;
      if (typeof error.message === "string") return error.message;
    }
    if (typeof record.error === "string") return record.error;
    // 万相把失败原因放在 output.message / output.code
    if (record.output && typeof record.output === "object") {
      const output = record.output as Record<string, unknown>;
      const parts = [output.code, output.message].filter((item) => typeof item === "string");
      if (parts.length) return parts.join(": ");
    }
    if (typeof record.message === "string") return record.message;
    return null;
  }

  private async saveVideos(taskId: string, videos: VideoCandidate[], channel: DbChannel) {
    // 目录在写盘和入库之间必须保持一致，取一次而不是每次读 getter
    const baseDir = this.db.assetsDir;
    let saved = 0;
    for (const video of videos.slice(0, 1)) {
      const bytes = await this.fetchVideoBytes(video.url, channel);
      if (bytes.length > MAX_VIDEO_BYTES) throw new AppError("ASSET_TOO_LARGE", "视频超过 200 MB 限制", 502);
      const extension = video.url.endsWith(".webm") ? "webm" : "mp4";
      const mimeType = extension === "webm" ? "video/webm" : "video/mp4";
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      const id = crypto.randomUUID();
      const fileName = safeFileName(`${taskId}-${saved + 1}.${extension}`);
      const absolutePath = path.join(baseDir, fileName);
      await fs.writeFile(absolutePath, bytes);
      this.db.insertAsset({
        id, taskId, fileName, mimeType, byteSize: bytes.length,
        relativePath: fileName, baseDir, sha256, duration: video.duration,
      });
      saved += 1;
    }
    if (!saved) throw new AppError("RESPONSE_PARSE_FAILED", "没有可保存的视频", 502);
  }

  private async fetchVideoBytes(url: string, channel: DbChannel): Promise<Buffer> {
    try {
      const response = await safeFetch(url, { method: "GET" }, { allowPrivateNetwork: channel.allowPrivateNetwork });
      if (!response.ok) {
        throw new AppError(
          "VIDEO_DOWNLOAD_FAILED",
          `下载视频失败：HTTP ${response.status}。视频链接：${url}`,
          502,
        );
      }
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "VIDEO_DOWNLOAD_FAILED",
        `下载视频失败：${error instanceof Error ? error.message : "未知错误"}。视频链接：${url}`,
        502,
      );
    }
  }


  private async saveImages(taskId: string, images: ImageCandidate[], channel: DbChannel) {
    const baseDir = this.db.assetsDir;
    let saved = 0;
    // 部分中转会把同一张图同时放在 base64 与 URL 等多个位置，按字节内容去重避免落盘重复图片
    const seenHashes = new Set<string>();
    for (const image of images.slice(0, 8)) {
      const resolved = await this.resolveImage(image, channel);
      if (resolved.bytes.length > MAX_IMAGE_BYTES) throw new AppError("ASSET_TOO_LARGE", "图片超过 30 MB 限制", 502);
      if (!resolved.mimeType.startsWith("image/")) throw new AppError("ASSET_INVALID", "响应内容不是图片", 502);
      const sha256 = crypto.createHash("sha256").update(resolved.bytes).digest("hex");
      if (seenHashes.has(sha256)) continue;
      seenHashes.add(sha256);
      const extension = extensionForMime(resolved.mimeType);
      const id = crypto.randomUUID();
      const fileName = safeFileName(`${taskId}-${saved + 1}.${extension}`);
      const absolutePath = path.join(baseDir, fileName);
      await fs.writeFile(absolutePath, resolved.bytes);
      this.db.insertAsset({
        id, taskId, fileName, mimeType: resolved.mimeType, byteSize: resolved.bytes.length,
        relativePath: fileName, baseDir, sha256,
      });
      saved += 1;
    }
    if (!saved) throw new AppError("RESPONSE_PARSE_FAILED", "没有可保存的图片", 502);
  }

  private async persistInputImages(taskId: string, input: GenerationInput, sources: ReferenceImageUpload[]): Promise<StoredGenerationInput> {
    if (!sources.length) return { ...input, referenceImage: undefined, referenceImages: undefined };
    if (sources.length > 8) throw new AppError("REFERENCE_IMAGE_LIMIT", "参考图最多上传 8 张", 400);
    for (const source of sources) {
      if (!source.bytes.length || source.bytes.length > MAX_REFERENCE_IMAGE_BYTES) {
        throw new AppError("REFERENCE_IMAGE_TOO_LARGE", "单张参考图不能超过 10 MB", 400);
      }
      if (!matchesImageSignature(source.bytes, source.mimeType)) {
        throw new AppError("REFERENCE_IMAGE_INVALID", "参考图格式与文件内容不匹配", 400);
      }
    }
    const storedImages: StoredReferenceImage[] = [];
    for (const [index, source] of sources.entries()) {
      const extension = extensionForMime(source.mimeType);
      const relativePath = safeFileName(`${taskId}-${index + 1}.${extension}`);
      const originalName = safeFileName(source.fileName);
      const stem = originalName.replace(/\.[^.]+$/, "").slice(0, 80) || `reference-${index + 1}`;
      await fs.writeFile(path.join(this.db.inputsDir, relativePath), source.bytes);
      storedImages.push({ fileName: `${stem}.${extension}`, mimeType: source.mimeType, relativePath, byteSize: source.bytes.length });
    }
    return { ...input, referenceImage: undefined, referenceImages: storedImages };
  }

  private async hydrateInputImages(input: StoredGenerationInput): Promise<GenerationInput> {
    const storedImages = input.referenceImages?.length ? input.referenceImages : input.referenceImage ? [input.referenceImage] : [];
    if (!storedImages.length) return { ...input, referenceImage: undefined, referenceImages: undefined };
    const hydratedImages: ReferenceImageInput[] = [];
    for (const image of storedImages) {
      const absolutePath = path.resolve(this.db.inputsDir, image.relativePath);
      if (!absolutePath.startsWith(path.resolve(this.db.inputsDir) + path.sep)) {
        throw new AppError("REFERENCE_IMAGE_INVALID", "参考图路径无效", 400);
      }
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(absolutePath);
      } catch {
        throw new AppError("REFERENCE_IMAGE_MISSING", "参考图文件不存在，请重新上传", 400);
      }
      if (!bytes.length || bytes.length > MAX_REFERENCE_IMAGE_BYTES || !matchesImageSignature(bytes, image.mimeType)) {
        throw new AppError("REFERENCE_IMAGE_INVALID", "参考图文件无效", 400);
      }
      hydratedImages.push({ base64: bytes.toString("base64"), mimeType: image.mimeType, fileName: image.fileName });
    }
    return { ...input, referenceImage: undefined, referenceImages: hydratedImages };
  }

  private async resolveImage(image: ImageCandidate, channel: DbChannel) {
    if (image.base64) {
      const clean = image.base64.replace(/^data:image\/[^;]+;base64,/, "").replace(/\s/g, "");
      return { bytes: Buffer.from(clean, "base64"), mimeType: image.mimeType ?? "image/png" };
    }
    if (!image.url) throw new AppError("ASSET_INVALID", "图片响应缺少 URL 或 Base64", 502);
    const response = await safeFetch(image.url, { method: "GET", headers: { Accept: "image/*" } }, { allowPrivateNetwork: channel.allowPrivateNetwork });
    if (!response.ok) throw new AppError("ASSET_DOWNLOAD_FAILED", `图片下载失败：HTTP ${response.status}`, 502);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_IMAGE_BYTES) throw new AppError("ASSET_TOO_LARGE", "图片超过 30 MB 限制", 502);
    const mimeType = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0];
    return { bytes: Buffer.from(await response.arrayBuffer()), mimeType };
  }

  private resolveKey(channel: DbChannel) {
    if (channel.authType === "none") return "";
    const key = this.sessionKeys.get(channel.id) || (channel.secretEnv ? process.env[channel.secretEnv] : "");
    if (!key) throw new AppError("CHANNEL_AUTH_FAILED", "该渠道没有可用的 API Key", 400);
    return key;
  }

  private requireTask(id: string): TaskRow {
    const task = this.db.getTaskRow(id);
    if (!task) throw new AppError("TASK_NOT_FOUND", "任务不存在", 404);
    return task;
  }

  private requireChannel(id: string): DbChannel {
    const channel = this.db.getChannel(id);
    if (!channel) throw new AppError("CHANNEL_NOT_FOUND", "渠道不存在", 404);
    return channel;
  }
}

function truncatePayload(payload: unknown) {
  const json = JSON.stringify(payload);
  if (json === undefined) return null;
  if (json.length <= 50000) return payload;
  return { truncated: true, preview: json.slice(0, 50000) };
}

function extensionForMime(mimeType: string) {
  if (mimeType.includes("jpeg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  return "png";
}

function referenceInputs(input: GenerationInput) {
  return input.referenceImages?.length ? input.referenceImages : input.referenceImage ? [input.referenceImage] : [];
}

/** 统计走内联 data URI 的视频素材字符数：公网/oss 地址不计入请求体，忽略 */
function inlineMediaSize(input: GenerationInput) {
  const media = [...(input.wanVideoMedia ?? []), ...(input.seedanceVideoMedia ?? [])];
  return media.reduce((total, item) => (item.url.startsWith("data:") ? total + item.url.length : total), 0);
}

function matchesImageSignature(bytes: Buffer, mimeType: ReferenceImageInput["mimeType"]) {
  if (mimeType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

export class AppError extends Error {
  constructor(public code: string, message: string, public status = 500, public details?: unknown) {
    super(message);
  }
}

export function normalizeError(error: unknown) {
  if (error instanceof AppError) return error;
  if (error instanceof RemoteApiError) return new AppError("REMOTE_REQUEST_FAILED", error.message, error.status, redact(error.payload));
  const message = error instanceof Error ? error.message : "未知错误";
  if (/timeout|aborted/i.test(message)) return new AppError("REQUEST_TIMEOUT", "请求超时", 504);
  return new AppError("INTERNAL_ERROR", message, 500);
}
