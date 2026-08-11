import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { GenerationInput, ReferenceImageInput, Task } from "../shared/types.js";
import type { AppDatabase, DbChannel, TaskRow } from "./db.js";
import {
  RemoteApiError,
  buildGenerationRequest,
  buildStatusRequest,
  extractImageCandidates,
  extractRemoteTaskId,
  readRemoteState,
  requestForDiagnostic,
  sendPreparedRequest,
  type ImageCandidate,
} from "./adapters.js";
import { redact, safeFetch, safeFileName } from "./security.js";

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;

interface StoredReferenceImage extends Omit<ReferenceImageInput, "base64"> {
  relativePath: string;
  byteSize: number;
}

interface StoredGenerationInput extends Omit<GenerationInput, "referenceImage"> {
  referenceImage?: StoredReferenceImage;
}

export class TaskRunner {
  private readonly running = new Set<string>();

  constructor(private readonly db: AppDatabase, private readonly sessionKeys: Map<string, string>) {}

  async create(input: GenerationInput): Promise<Task> {
    const channel = this.db.getChannel(input.channelId);
    if (!channel || !channel.enabled) throw new AppError("CHANNEL_NOT_FOUND", "渠道不存在或未启用", 404);
    if (!channel.models.includes(input.model)) throw new AppError("MODEL_NOT_FOUND", "该模型不在渠道模型列表中", 400);
    if (!input.prompt.trim()) throw new AppError("INVALID_INPUT", "提示词不能为空", 400);
    if (input.prompt.length > 20000) throw new AppError("INVALID_INPUT", "提示词不能超过 20000 个字符", 400);
    const rawSize = JSON.stringify(input.rawParameters ?? {}).length;
    if (rawSize > 65536) throw new AppError("INVALID_INPUT", "高级参数不能超过 64 KB", 400);
    const id = crypto.randomUUID();
    const storedInput = await this.persistInputImage(id, input);
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
      const input = await this.hydrateInputImage(JSON.parse(task.inputJson) as StoredGenerationInput);
      const key = this.resolveKey(channel);
      this.db.updateTask(taskId, { status: "validating", startedAt: task.startedAt ?? new Date().toISOString(), errorCode: null, errorMessage: null });
      const prepared = buildGenerationRequest(channel, input, key);
      const effectiveBody = requestForDiagnostic(prepared).body ?? {};
      this.db.updateTask(taskId, { status: "submitting", effectiveJson: JSON.stringify(effectiveBody), attemptCount: task.attemptCount + 1 });
      const result = await this.sendWithDiagnostic(taskId, prepared);
      const images = extractImageCandidates(result.payload);
      if (images.length) {
        await this.saveImages(taskId, images, channel);
        this.db.updateTask(taskId, { status: "succeeded", progress: 100, finishedAt: new Date().toISOString() });
        return;
      }

      const remoteTaskId = extractRemoteTaskId(result.payload);
      if (channel.adapterType === "midjourney-task" && remoteTaskId) {
        this.db.updateTask(taskId, { status: "running", remoteTaskId, progress: 0 });
        await this.poll(taskId, channel, remoteTaskId, key);
        return;
      }
      throw new AppError("RESPONSE_PARSE_FAILED", "响应中没有找到图片或异步任务 ID", 502);
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

  async poll(taskId: string, channel: DbChannel, remoteTaskId: string, key: string) {
    const started = Date.now();
    const intervals = [2000, 3000, 5000, 8000, 10000];
    let attempt = 0;
    while (Date.now() - started < 10 * 60 * 1000) {
      const current = this.requireTask(taskId);
      if (current.status === "cancelled") return;
      await sleep(intervals[Math.min(attempt, intervals.length - 1)]);
      const prepared = buildStatusRequest(channel, remoteTaskId, key);
      const result = await this.sendWithDiagnostic(taskId, prepared);
      const state = readRemoteState(result.payload);
      const images = extractImageCandidates(result.payload);
      if (images.length && state.status !== "failed") {
        await this.saveImages(taskId, images, channel);
        this.db.updateTask(taskId, { status: "succeeded", progress: 100, finishedAt: new Date().toISOString() });
        return;
      }
      if (state.status === "failed") throw new AppError("REMOTE_TASK_FAILED", state.message ?? "远程任务失败", 502);
      if (state.status === "cancelled") {
        this.db.updateTask(taskId, { status: "cancelled", finishedAt: new Date().toISOString() });
        return;
      }
      this.db.updateTask(taskId, { status: "running", progress: state.progress });
      attempt += 1;
    }
    this.db.updateTask(taskId, { status: "expired", errorCode: "REMOTE_TASK_EXPIRED", errorMessage: "异步任务等待超时", finishedAt: new Date().toISOString() });
  }

  cancel(taskId: string) {
    const task = this.requireTask(taskId);
    if (["succeeded", "failed", "cancelled", "expired"].includes(task.status)) return this.db.getTaskView(taskId)!;
    this.db.updateTask(taskId, { status: "cancelled", finishedAt: new Date().toISOString() });
    return this.db.getTaskView(taskId)!;
  }

  async retry(taskId: string) {
    const task = this.requireTask(taskId);
    const input = await this.hydrateInputImage(JSON.parse(task.inputJson) as StoredGenerationInput);
    return this.create(input);
  }

  resume() {
    for (const task of this.db.listPendingTasks()) {
      const channel = this.db.getChannel(task.channelId);
      if (!channel || !task.remoteTaskId) continue;
      let key: string;
      try { key = this.resolveKey(channel); }
      catch (error) {
        const normalized = normalizeError(error);
        this.db.updateTask(task.id, { status: "failed", errorCode: normalized.code, errorMessage: normalized.message, finishedAt: new Date().toISOString() });
        continue;
      }
      this.running.add(task.id);
      void this.poll(task.id, channel, task.remoteTaskId, key)
        .catch((error) => {
          const normalized = normalizeError(error);
          this.db.updateTask(task.id, { status: "failed", errorCode: normalized.code, errorMessage: normalized.message, finishedAt: new Date().toISOString() });
        })
        .finally(() => this.running.delete(task.id));
    }
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

  private async saveImages(taskId: string, images: ImageCandidate[], channel: DbChannel) {
    let saved = 0;
    for (const image of images.slice(0, 8)) {
      const resolved = await this.resolveImage(image, channel);
      if (resolved.bytes.length > MAX_IMAGE_BYTES) throw new AppError("ASSET_TOO_LARGE", "图片超过 30 MB 限制", 502);
      if (!resolved.mimeType.startsWith("image/")) throw new AppError("ASSET_INVALID", "响应内容不是图片", 502);
      const extension = extensionForMime(resolved.mimeType);
      const id = crypto.randomUUID();
      const fileName = safeFileName(`${taskId}-${saved + 1}.${extension}`);
      const absolutePath = path.join(this.db.assetsDir, fileName);
      await fs.writeFile(absolutePath, resolved.bytes);
      this.db.insertAsset({
        id, taskId, fileName, mimeType: resolved.mimeType, byteSize: resolved.bytes.length,
        relativePath: fileName, sha256: crypto.createHash("sha256").update(resolved.bytes).digest("hex"),
      });
      saved += 1;
    }
    if (!saved) throw new AppError("RESPONSE_PARSE_FAILED", "没有可保存的图片", 502);
  }

  private async persistInputImage(taskId: string, input: GenerationInput): Promise<StoredGenerationInput> {
    if (!input.referenceImage) return { ...input, referenceImage: undefined };
    const bytes = Buffer.from(input.referenceImage.base64, "base64");
    if (!bytes.length || bytes.length > MAX_REFERENCE_IMAGE_BYTES) {
      throw new AppError("REFERENCE_IMAGE_TOO_LARGE", "参考图不能超过 10 MB", 400);
    }
    if (!matchesImageSignature(bytes, input.referenceImage.mimeType)) {
      throw new AppError("REFERENCE_IMAGE_INVALID", "参考图格式与文件内容不匹配", 400);
    }
    const extension = extensionForMime(input.referenceImage.mimeType);
    const relativePath = safeFileName(`${taskId}.${extension}`);
    const originalName = safeFileName(input.referenceImage.fileName);
    const stem = originalName.replace(/\.[^.]+$/, "").slice(0, 80) || "reference";
    await fs.writeFile(path.join(this.db.inputsDir, relativePath), bytes);
    return {
      ...input,
      referenceImage: {
        fileName: `${stem}.${extension}`,
        mimeType: input.referenceImage.mimeType,
        relativePath,
        byteSize: bytes.length,
      },
    };
  }

  private async hydrateInputImage(input: StoredGenerationInput): Promise<GenerationInput> {
    if (!input.referenceImage) return { ...input, referenceImage: undefined };
    const absolutePath = path.resolve(this.db.inputsDir, input.referenceImage.relativePath);
    if (!absolutePath.startsWith(path.resolve(this.db.inputsDir) + path.sep)) {
      throw new AppError("REFERENCE_IMAGE_INVALID", "参考图路径无效", 400);
    }
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(absolutePath);
    } catch {
      throw new AppError("REFERENCE_IMAGE_MISSING", "参考图文件不存在，请重新上传", 400);
    }
    if (!bytes.length || bytes.length > MAX_REFERENCE_IMAGE_BYTES || !matchesImageSignature(bytes, input.referenceImage.mimeType)) {
      throw new AppError("REFERENCE_IMAGE_INVALID", "参考图文件无效", 400);
    }
    return {
      ...input,
      referenceImage: {
        base64: bytes.toString("base64"),
        mimeType: input.referenceImage.mimeType,
        fileName: input.referenceImage.fileName,
      },
    };
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

function matchesImageSignature(bytes: Buffer, mimeType: ReferenceImageInput["mimeType"]) {
  if (mimeType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
