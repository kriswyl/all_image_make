import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DEFAULT_IMAGE_SIZE, MAX_MASK_IMAGE_BYTES, MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES, normalizeImageSize } from "../shared/types.js";
import type { GenerationInput, MaskImageInput, ReferenceImageInput, Task } from "../shared/types.js";
import type { AppDatabase, DbChannel, TaskRow } from "./db.js";
import {
  RemoteApiError,
  applyAuth,
  buildGenerationRequest,
  extractAudioCandidates,
  extractImageCandidates,
  requestForDiagnostic,
  sendPreparedRequest,
  type ImageCandidate,
} from "./adapters.js";
import {
  asyncProviderSpec,
  extractAsyncTaskId,
  type AsyncProviderSpec,
  type AsyncResult,
} from "./async-providers.js";
import { joinEndpoint, redact, safeFetch, safeFileName } from "./security.js";
import { detectImageMime, writeThumbnail } from "./vision.js";
import type { KeyStore } from "./key-store.js";

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
// 参考图的张数和体积都住在 shared/types.ts（前端校验、上传出口、这里三处共用一份）
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const VIDEO_POLL_INTERVAL_MS = 8000;
const VIDEO_MAX_POLLS = 100;

/** 中转站对请求体的实际上限在 1~2MB 之间（实测 1MB 通过、2MB 被网关掐断），
 *  且超限时只回含糊的 502 / fetch failed。内联 base64 素材超过这个字符数就提前拦下。 */
const MAX_INLINE_MEDIA_CHARS = 1_400_000;

/** 轮询节奏可被环境变量覆盖，测试里用短间隔跑完整个提交流程 */
const VIDEO_POLL_DELAY_MS = (() => {
  const raw = Number(process.env.VIDEO_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : VIDEO_POLL_INTERVAL_MS;
})();

/**
 * gemini-content 要求 `generationConfig.imageConfig.imageSize` 必填，缺了上游直接 400
 * （`Unsupported resolution: check the imageSize parameter`）。这里补上默认值。
 *
 * **为什么补在这一层而不是适配器或 Agent 工具里**：适配器是无 db 的纯函数，拿不到设置；
 * 而 Agent 工具只是 `POST /api/generations` 的一个调用方——生图工作台走的是同一条路，
 * 有完全一样的毛病。补在 `create()` 里，Agent、工作台、重试、崩溃恢复一次全修好。
 *
 * 请求方明确写了的原样发出去（上游不认就让补救重试去兜），只有**我们自己补的**才洗干净：
 * 落库的是设置表里那个字符串，可能是手写的脏值。
 *
 * @param defaultSize 设置里的 `geminiImageSize`；空/非法就退回 DEFAULT_IMAGE_SIZE
 */
export function resolveImageSize(
  adapterType: string,
  requested: string | undefined,
  defaultSize?: string | null,
): string | undefined {
  if (requested) return requested;
  if (adapterType !== "gemini-content") return undefined;
  return normalizeImageSize(defaultSize) ?? DEFAULT_IMAGE_SIZE;
}


interface StoredReferenceImage extends Omit<ReferenceImageInput, "base64"> {
  relativePath: string;
  byteSize: number;
}

interface StoredMaskImage {
  fileName: string;
  mimeType: "image/png";
  relativePath: string;
  byteSize: number;
}

interface StoredGenerationInput extends Omit<GenerationInput, "referenceImage" | "referenceImages" | "maskImage"> {
  referenceImage?: StoredReferenceImage;
  referenceImages?: StoredReferenceImage[];
  maskImage?: StoredMaskImage;
}

export interface ReferenceImageUpload {
  bytes: Buffer;
  mimeType: ReferenceImageInput["mimeType"];
  fileName: string;
}

/** 局部重绘蒙版的上传形态：和参考图一样按字节进、按相对路径落盘 */
export interface MaskImageUpload {
  bytes: Buffer;
  mimeType: "image/png";
  fileName: string;
}

/** 任务的终态。Agent 的 `waitFor` 和续跑都盯着这一份 */
export const TERMINAL_TASK_STATUSES = ["succeeded", "failed", "cancelled", "expired"] as const;

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

export interface TaskEvent {
  kind: "progress" | "finished";
  task: Task;
}

export type TaskListener = (event: TaskEvent) => void;

export class TaskRunner {
  private readonly running = new Set<string>();
  /**
   * 任务事件订阅者。
   *
   * 只加这一个出口、不改动已有的写库流程：生成历史页照旧靠轮询，
   * Agent 用它等图片任务结束、把视频进度推给对话界面。
   */
  private readonly listeners = new Set<TaskListener>();

  constructor(private readonly db: AppDatabase, private readonly sessionKeys: KeyStore) {}

  onTaskEvent(listener: TaskListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emitEvent(event: TaskEvent) {
    for (const listener of this.listeners) {
      // 订阅者自己的异常不能反过来把任务跑挂
      try {
        listener(event);
      } catch {
        // 忽略
      }
    }
  }

  /** 写库 + 广播，所有状态变更都从这里走，事件就不会漏 */
  private updateTask(taskId: string, patch: Parameters<AppDatabase["updateTask"]>[1]) {
    this.db.updateTask(taskId, patch);
    const task = this.db.getTaskView(taskId);
    if (task) this.emitEvent({ kind: isTerminalStatus(task.status) ? "finished" : "progress", task });
  }

  /**
   * 等一个任务进入终态。
   *
   * 图片生成是同步请求，Agent 直接等完再回话最省事：拿到真实产物后大脑才能说
   * 「画好了」，画布指针也才能在同一轮内挪过去（§10.1）。视频不能这么等，
   * 那条路走 `create()` + `async: true`，靠完成事件续跑（§12.2）。
   */
  async waitFor(taskId: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<Task> {
    const { timeoutMs = 15 * 60_000, signal } = options;
    const current = this.db.getTaskView(taskId);
    if (!current) throw new AppError("TASK_NOT_FOUND", "任务不存在", 404);
    if (isTerminalStatus(current.status)) return current;

    return new Promise<Task>((resolve, reject) => {
      const cleanup = () => {
        this.listeners.delete(onEvent);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onEvent = (event: TaskEvent) => {
        if (event.task.id !== taskId || event.kind !== "finished") return;
        cleanup();
        resolve(event.task);
      };
      const onAbort = () => {
        cleanup();
        reject(new AppError("TASK_ABORTED", "已取消等待", 499));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new AppError("TASK_WAIT_TIMEOUT", "等待生成结果超时", 504));
      }, timeoutMs);
      this.listeners.add(onEvent);
      signal?.addEventListener("abort", onAbort, { once: true });
      // 订阅之前任务可能已经结束，事件早就发过了，必须再查一次
      const settled = this.db.getTaskView(taskId);
      if (settled && isTerminalStatus(settled.status)) {
        cleanup();
        resolve(settled);
      }
    });
  }

  async create(input: GenerationInput, uploads: ReferenceImageUpload[] = [], maskUpload?: MaskImageUpload, libraryScope: "public" | "conversation" = "public", ownerConversationId?: string): Promise<Task> {
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
    // 补默认值要早于落库：落进 tasks.input 的那份才是重试 / 崩溃恢复会重放的
    input.imageSize = resolveImageSize(channel.adapterType, input.imageSize, this.db.getSetting("geminiImageSize"));
    const id = crypto.randomUUID();
    const sources = uploads.length ? uploads : referenceInputs(input).map((image) => ({
      bytes: Buffer.from(image.base64, "base64"), mimeType: image.mimeType, fileName: image.fileName,
    }));
    /**
     * 蒙版可以来自 multipart 上传，也可以来自重试时 hydrate 回 base64 的 `input.maskImage`。
     * 校验放在落盘之前：非法蒙版不该留下已经写好的参考图文件。
     */
    const maskSource: MaskImageUpload | undefined = maskUpload ?? (input.maskImage ? {
      bytes: Buffer.from(input.maskImage.base64, "base64"),
      mimeType: "image/png",
      fileName: input.maskImage.fileName,
    } : undefined);
    if (maskSource) {
      if (channel.adapterType !== "openai-images") {
        throw new AppError("MASK_UNSUPPORTED_ADAPTER", "局部重绘只支持 OpenAI Images 协议的渠道（gpt / gpt-c 生图）", 400);
      }
      if (!sources.length) {
        throw new AppError("MASK_REQUIRES_REFERENCE_IMAGE", "局部重绘需要先添加 1 张参考图作为底图", 400);
      }
      if (sources.length !== 1) {
        throw new AppError("MASK_REFERENCE_COUNT", `局部重绘只支持 1 张参考图（当前 ${sources.length} 张）`, 400);
      }
      if (!maskSource.bytes.length || maskSource.bytes.length > MAX_MASK_IMAGE_BYTES || !matchesImageSignature(maskSource.bytes, "image/png")) {
        throw new AppError("MASK_INVALID", "蒙版必须是有效的 PNG 图片，且不能超过 4 MB（透明区域表示要重绘的部分）", 400);
      }
    }
    const storedInput = await this.persistInputImages(id, input, sources, maskSource);
    this.db.createTask({ id, channelId: channel.id, model: input.model, prompt: input.prompt, input: storedInput, libraryScope, ownerConversationId });
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
      this.updateTask(taskId, { status: "validating", startedAt: task.startedAt ?? new Date().toISOString(), errorCode: null, errorMessage: null });
      const prepared = buildGenerationRequest(channel, input, key);
      const effectiveBody = requestForDiagnostic(prepared).body ?? {};
      this.updateTask(taskId, { status: "submitting", effectiveJson: JSON.stringify(effectiveBody), attemptCount: task.attemptCount + 1 });
      const result = await this.sendWithDiagnostic(taskId, prepared);

      // 用户在请求飞行中点了停止：结果不再落库，也不要把它改回 succeeded
      if (this.db.getTaskRow(taskId)?.status === "cancelled") return;

      // 异步厂商（视频 / 音乐）：提交响应里拿远端 id，交给统一的轮询器
      const spec = asyncProviderSpec(channel.adapterType);
      const asyncTaskId = spec ? (spec.extractTaskId?.(result.payload) ?? extractAsyncTaskId(result.payload)) : null;

      if (spec && asyncTaskId) {
        // 先记下上游 task id：进程重启后靠它接着轮询，而不是把任务判死
        this.updateTask(taskId, { remoteTaskId: asyncTaskId });
        await this.pollAsyncTask(taskId, asyncTaskId, channel, key, spec);
        return;
      }

      // 同步音频：Gemini TTS 把 WAV 以 base64 内联在 generateContent 响应里
      const audioCandidates = extractAudioCandidates(result.payload);
      if (audioCandidates.length) {
        await this.saveAudios(taskId, audioCandidates.map((audio, index) => ({
          ...audio,
          kind: "audio" as const,
          title: audio.title ?? speechTitle(input.prompt, index),
        })), channel);
        this.updateTask(taskId, { status: "succeeded", progress: 100, finishedAt: new Date().toISOString() });
        return;
      }

      // Sync response: extract images immediately
      const images = extractImageCandidates(result.payload);
      if (images.length) {
        await this.saveImages(taskId, images, channel);
        this.updateTask(taskId, { status: "succeeded", progress: 100, finishedAt: new Date().toISOString() });
        return;
      }

      throw new AppError("RESPONSE_PARSE_FAILED", "响应中没有找到可保存的产物", 502);
    } catch (error) {
      /**
       * 收尾写库本身也可能失败：应用退出或测试清理会先关数据库，而任务还在飞。
       * 这时没有可写的任务记录，静默结束即可，不能让一个已经失败的任务再抛一次未捕获异常。
       */
      try {
        const current = this.db.getTaskRow(taskId);
        if (current && current.status !== "cancelled") {
          const normalized = normalizeError(error);
          this.updateTask(taskId, { status: "failed", errorCode: normalized.code, errorMessage: normalized.message, finishedAt: new Date().toISOString() });
        }
      } catch {
        // 数据库已关闭，任务记录不再可写
      }
    } finally {
      this.running.delete(taskId);
    }
  }

  cancel(taskId: string) {
    const task = this.requireTask(taskId);
    if (["succeeded", "failed", "cancelled", "expired"].includes(task.status)) return this.db.getTaskView(taskId)!;
    this.updateTask(taskId, { status: "cancelled", finishedAt: new Date().toISOString() });
    return this.db.getTaskView(taskId)!;
  }

  async retry(taskId: string) {
    const task = this.requireTask(taskId);
    const input = await this.hydrateInputImages(JSON.parse(task.inputJson) as StoredGenerationInput);
    const privateTask = task.libraryScope === "conversation" || (task.libraryScope === "legacy" && this.db.taskHasConversationReferences(task.id));
    return this.create(input, [], undefined, privateTask ? "conversation" : "public", task.ownerConversationId ?? undefined);
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
      const spec = channel ? asyncProviderSpec(channel.adapterType) : null;
      if (!channel || !spec) {
        this.markFailed(task.id, "SERVICE_RESTARTED", "服务已重启，请重新生成");
        continue;
      }
      // 不 await：多个任务并行恢复，任一失败都不能拖住启动
      void this.resumePolling(task.id, task.remoteTaskId!, channel, spec);
    }
  }

  private async resumePolling(taskId: string, remoteTaskId: string, channel: DbChannel, spec: AsyncProviderSpec) {
    if (this.running.has(taskId)) return;
    this.running.add(taskId);
    try {
      await this.pollAsyncTask(taskId, remoteTaskId, channel, this.resolveKey(channel), spec, { immediate: true });
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
    this.updateTask(taskId, { status: "failed", errorCode: code, errorMessage: message, finishedAt: new Date().toISOString() });
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

  private async pollAsyncTask(
    localTaskId: string,
    remoteTaskId: string,
    channel: DbChannel,
    key: string,
    spec: AsyncProviderSpec,
    options: { immediate?: boolean } = {},
  ) {
    this.updateTask(localTaskId, { status: "running", remoteTaskId });
    // 提交路径走 joinEndpoint（会吃掉 Base URL 的尾斜杠），轮询这里必须一致，
    // 否则 Base URL 填成 https://api.x.com/ 时会「提交成功、轮询 404」
    const url = joinEndpoint(channel.baseUrl, spec.pollPath(remoteTaskId));

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

    const maxPolls = spec.maxPolls ?? VIDEO_MAX_POLLS;
    const delayMs = spec.pollIntervalMs ?? VIDEO_POLL_DELAY_MS;

    try {
      for (let poll = 0; poll < maxPolls; poll += 1) {
        const current = this.db.getTaskRow(localTaskId);
        if (current?.status === "cancelled") return;

        // 重启恢复时第一轮不再等：上游要是早没了，没必要再耗一个间隔
        if (poll > 0 || !options.immediate) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
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
          throw new AppError("VIDEO_POLL_FAILED", error instanceof Error ? error.message : "轮询任务状态失败", 502);
        }

        // 上一次轮询既然不是终点，就降级成一条状态摘要
        if (pending) {
          const summary = spec.extractStatus(pending.payload);
          this.db.insertDiagnostic({
            taskId: localTaskId,
            request: null,
            response: {
              poll: pending.index,
              status: summary.status,
              progress: summary.progress,
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

        const status = spec.extractStatus(payload);
        if (status.progress !== null) this.updateTask(localTaskId, { progress: status.progress });
        if (status.meta) this.updateTask(localTaskId, { remoteMeta: JSON.stringify(status.meta) });

        // 先判失败：只有明确的失败状态才算失败，unknown / pending / running 都继续轮询
        if (status.status && spec.failureStatuses.includes(status.status)) {
          throw new AppError(
            "REMOTE_TASK_FAILED",
            status.error || `生成失败（状态 ${status.status}）：${JSON.stringify(payload).slice(0, 300)}`,
            502,
          );
        }

        const succeeded = Boolean(status.status && spec.successStatuses.includes(status.status));
        const results = spec.extractResults(payload);
        // 状态说完成时收下全部候选；状态还停在 unknown / running 时，只认强候选
        // ——中转生成完经常不更新 status，只把结果字段填上
        const ready = succeeded ? results : results.filter((item) => item.strong);
        if (succeeded || ready.length) {
          const chosen = ready.length ? ready : results;
          if (chosen.length === 0) {
            throw new AppError(
              "RESPONSE_PARSE_FAILED",
              `生成完成但响应中没有找到可保存的产物。原始响应：${JSON.stringify(payload).slice(0, 500)}`,
              502,
            );
          }
          // 下载失败时会把产物链接带进报错，方便手动打开核对
          await this.saveResults(localTaskId, chosen, channel);
          this.updateTask(localTaskId, { status: "succeeded", progress: 100, finishedAt: new Date().toISOString() });
          return;
        }

        // Still running, continue polling
      }

      throw new AppError("VIDEO_TIMEOUT", `生成超时（已轮询 ${maxPolls} 次）`, 504);
    } finally {
      // 最后一条轮询（成功、失败、超时都一样）保留完整响应：排查时最有用的是它
      flushPending();
    }
  }

  /**
   * 按产物类型落盘。
   *
   * 视频走 `saveVideos`，音乐/配音走 `saveAudios`。把分派放在这里，
   * 轮询器不用知道「视频怎么下载、音频怎么下载」。
   */
  private async saveResults(taskId: string, results: AsyncResult[], channel: DbChannel) {
    const videos = results.filter((item) => item.kind === "video");
    const audios = results.filter((item) => item.kind === "audio");
    const images = results.filter((item) => item.kind === "image");
    if (videos.length) await this.saveVideos(taskId, videos, channel);
    if (audios.length) await this.saveAudios(taskId, audios, channel);
    if (images.length) await this.saveImages(taskId, images.map((item) => ({ url: item.url, mimeType: item.mimeType })), channel);
    if (!videos.length && !audios.length && !images.length) {
      throw new AppError("RESPONSE_PARSE_FAILED", "暂不支持保存这种产物", 502);
    }
  }

  private async saveVideos(taskId: string, videos: AsyncResult[], channel: DbChannel) {
    // 目录在写盘和入库之间必须保持一致，取一次而不是每次读 getter
    const baseDir = this.db.assetsDir;
    let saved = 0;
    // 一次可能返回多个结果（n>1，或上游把同一段视频放在多个字段里）；全部保存，
    // 由展示层决定主产物，别再像以前那样只看第一个。
    for (const video of videos.slice(0, 8)) {
      const { bytes, contentType } = await this.fetchAssetBytes(video.url, channel, "视频");
      if (bytes.length > MAX_VIDEO_BYTES) throw new AppError("ASSET_TOO_LARGE", "视频超过 200 MB 限制", 502);
      const mimeType = video.mimeType ?? (contentType.startsWith("video/") ? contentType : undefined)
        ?? (video.url.toLowerCase().includes(".webm") ? "video/webm" : "video/mp4");
      const extension = videoExtensionForMime(mimeType);
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

  /**
   * 音乐一次返回多首（Suno 通常是 2 首），每首带一张封面。
   * 封面写进现有的 `thumb_path`，不再单独建一条图片 asset——否则历史里会多出
   * 一张「不是用户要的图」，删除/清空时也不好解释。
   */
  private async saveAudios(taskId: string, audios: AsyncResult[], channel: DbChannel) {
    const baseDir = this.db.assetsDir;
    let saved = 0;
    for (const audio of audios.slice(0, 8)) {
      const { bytes, contentType } = await this.fetchAssetBytes(audio.url, channel, "音频");
      if (bytes.length > MAX_AUDIO_BYTES) throw new AppError("ASSET_TOO_LARGE", "音频超过 100 MB 限制", 502);
      const mimeType = audio.mimeType ?? (contentType.startsWith("audio/") ? contentType : undefined)
        ?? (audio.url.toLowerCase().includes(".wav") ? "audio/wav"
          : audio.url.toLowerCase().includes(".mp3") ? "audio/mpeg"
            : "audio/mp4");
      // 第二道闸：图片 inlineData 被误判成音频时，宁可跳过也不写一条 .m4a 的图片
      if (!mimeType.startsWith("audio/")) continue;
      const extension = audioExtensionForMime(mimeType);
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      const id = crypto.randomUUID();
      const fileName = safeFileName(`${taskId}-${saved + 1}.${extension}`);
      const absolutePath = path.join(baseDir, fileName);
      await fs.writeFile(absolutePath, bytes);

      // 封面失败不影响音频本身：缩略图接口会 404，前端回落到通用音乐图标
      let thumbPath: string | null = null;
      if (audio.coverUrl) {
        try {
          const cover = await this.fetchAssetBytes(audio.coverUrl, channel, "音频封面", "image/*");
          if (cover.contentType.startsWith("image/") || !cover.contentType) {
            thumbPath = await writeThumbnail(this.db, id, cover.bytes);
          }
        } catch {
          // 封面是装饰，丢了不影响听歌
        }
      }

      const duration = audio.duration ?? (mimeType.includes("wav") ? wavDurationSeconds(bytes) : undefined);
      this.db.insertAsset({
        id, taskId, fileName, mimeType, byteSize: bytes.length,
        relativePath: fileName, baseDir, sha256, duration, thumbPath,
        title: audio.title,
        lyrics: audio.lyrics,
        tags: audio.tags,
        remoteClipId: audio.remoteClipId,
      });
      saved += 1;
    }
    if (!saved) throw new AppError("RESPONSE_PARSE_FAILED", "没有可保存的音频", 502);
  }

  private async fetchAssetBytes(
    url: string,
    channel: DbChannel,
    label: string,
    accept = "*/*",
  ): Promise<{ bytes: Buffer; contentType: string }> {
    try {
      // Gemini TTS 把音频内联成 data URI；不把它当网络地址去 fetch
      if (url.startsWith("data:")) {
        const match = url.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
        if (!match) throw new AppError("ASSET_DOWNLOAD_FAILED", `${label}的 data URI 格式不合法`, 502);
        const contentType = match[1] ?? "";
        const bytes = match[2]
          ? Buffer.from(match[3] ?? "", "base64")
          : Buffer.from(decodeURIComponent(match[3] ?? ""), "utf8");
        return { bytes, contentType };
      }
      const headers = this.assetDownloadHeaders(url, channel, accept);
      const response = await safeFetch(url, { method: "GET", headers }, { allowPrivateNetwork: channel.allowPrivateNetwork });
      if (!response.ok) {
        throw new AppError(
          "ASSET_DOWNLOAD_FAILED",
          `下载${label}失败：HTTP ${response.status}。地址：${url}`,
          502,
        );
      }
      return {
        bytes: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") ?? "",
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "ASSET_DOWNLOAD_FAILED",
        `下载${label}失败：${error instanceof Error ? error.message : "未知错误"}。地址：${url}`,
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
      /*
       * 以字节头为准。Gemini 的 inlineData 经常把 JPEG 标成 image/png，
       * 之前按声明存成 .png 后，再把这张图当参考图发出去就会被
       * 「参考图格式与文件内容不匹配」拦住——整批分镜全挂。
       */
      const mimeType = detectImageMime(resolved.bytes) ?? resolved.mimeType;
      if (!mimeType.startsWith("image/")) throw new AppError("ASSET_INVALID", "响应内容不是图片", 502);
      const sha256 = crypto.createHash("sha256").update(resolved.bytes).digest("hex");
      if (seenHashes.has(sha256)) continue;
      seenHashes.add(sha256);
      const extension = extensionForMime(mimeType);
      const id = crypto.randomUUID();
      const fileName = safeFileName(`${taskId}-${saved + 1}.${extension}`);
      const absolutePath = path.join(baseDir, fileName);
      await fs.writeFile(absolutePath, resolved.bytes);
      // 缩略图在这里就生成好（§11.4）：Agent 续跑时马上要拿它喂大脑和画布徽章，
      // 「用的时候再缩」会让每一轮都白等一次解码。失败不抛异常，静默留空
      const thumbPath = await writeThumbnail(this.db, id, resolved.bytes);
      this.db.insertAsset({
        id, taskId, fileName, mimeType, byteSize: resolved.bytes.length,
        relativePath: fileName, baseDir, sha256, thumbPath,
      });
      saved += 1;
    }
    if (!saved) throw new AppError("RESPONSE_PARSE_FAILED", "没有可保存的图片", 502);
  }

  private async persistInputImages(
    taskId: string,
    input: GenerationInput,
    sources: ReferenceImageUpload[],
    maskSource?: MaskImageUpload,
  ): Promise<StoredGenerationInput> {
    if (!sources.length && !maskSource) {
      return { ...input, referenceImage: undefined, referenceImages: undefined, maskImage: undefined };
    }
    // 上限取常量而不是写死 8：画布（最多 MAX_CANVAS_IMAGES 张）整组都会走到这里，
    // 两处写死两个 8 的话，改一处就会出现「前端让选 12 张、这里按 8 张拒收」
    if (sources.length > MAX_REFERENCE_IMAGES) {
      throw new AppError("REFERENCE_IMAGE_LIMIT", `参考图最多上传 ${MAX_REFERENCE_IMAGES} 张`, 400);
    }
    for (const source of sources) {
      if (!source.bytes.length || source.bytes.length > MAX_REFERENCE_IMAGE_BYTES) {
        throw new AppError("REFERENCE_IMAGE_TOO_LARGE", "单张参考图不能超过 10 MB", 400);
      }
      if (!matchesImageSignature(source.bytes, source.mimeType)) {
        throw new AppError("REFERENCE_IMAGE_INVALID", "参考图格式与文件内容不匹配", 400);
      }
    }
    // 蒙版也要在写第一张参考图之前验完，否则一张坏蒙版会留下孤儿参考图文件
    if (maskSource && (!maskSource.bytes.length || maskSource.bytes.length > MAX_MASK_IMAGE_BYTES || !matchesImageSignature(maskSource.bytes, "image/png"))) {
      throw new AppError("MASK_INVALID", "蒙版必须是有效的 PNG 图片，且不能超过 4 MB（透明区域表示要重绘的部分）", 400);
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
    let storedMask: StoredMaskImage | undefined;
    if (maskSource) {
      // 固定用 taskId-mask.png，和参考图的 taskId-1.png 不会撞名
      const relativePath = safeFileName(`${taskId}-mask.png`);
      await fs.writeFile(path.join(this.db.inputsDir, relativePath), maskSource.bytes);
      const originalName = safeFileName(maskSource.fileName) || "mask.png";
      storedMask = {
        fileName: originalName.toLowerCase().endsWith(".png") ? originalName : `${originalName}.png`,
        mimeType: "image/png",
        relativePath,
        byteSize: maskSource.bytes.length,
      };
    }
    return {
      ...input,
      referenceImage: undefined,
      referenceImages: storedImages.length ? storedImages : undefined,
      maskImage: storedMask,
    };
  }

  private async hydrateInputImages(input: StoredGenerationInput): Promise<GenerationInput> {
    const storedImages = input.referenceImages?.length ? input.referenceImages : input.referenceImage ? [input.referenceImage] : [];
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
    let hydratedMask: MaskImageInput | undefined;
    if (input.maskImage) {
      const absolutePath = path.resolve(this.db.inputsDir, input.maskImage.relativePath);
      if (!absolutePath.startsWith(path.resolve(this.db.inputsDir) + path.sep)) {
        throw new AppError("MASK_INVALID", "蒙版路径无效", 400);
      }
      let bytes: Buffer;
      try {
        bytes = await fs.readFile(absolutePath);
      } catch {
        throw new AppError("MASK_IMAGE_MISSING", "蒙版文件不存在，请重新绘制", 400);
      }
      if (!bytes.length || bytes.length > MAX_MASK_IMAGE_BYTES || !matchesImageSignature(bytes, "image/png")) {
        throw new AppError("MASK_INVALID", "蒙版文件无效或超过 4 MB，请重新绘制", 400);
      }
      hydratedMask = { base64: bytes.toString("base64"), mimeType: "image/png", fileName: input.maskImage.fileName };
    }
    return {
      ...input,
      referenceImage: undefined,
      referenceImages: hydratedImages.length ? hydratedImages : undefined,
      maskImage: hydratedMask,
    };
  }

  /**
   * 下载产物用的请求头。
   *
   * 中转站自带的资产地址（形如 `https://gateway.example/v1/images/assets/<uuid>`）通常要带 key
   * 才肯给图，不带就是 403——用户看到的现象正是「响应体里明明有 url，却一直拿不到图片」。
   * 但 key **只能发给渠道自己那台主机**：产物地址也可能是公开的 OSS / CDN，
   * 往那儿带 Authorization 等于把密钥送给第三方。
   *
   * `query` 鉴权不在这里重放：那个类型要把 key 拼进 URL，而我们只是去取一个别人给的地址，
   * 拼错了反而会把地址弄坏。这类网关的资产地址一般本来就是公开的。
   */
  private assetDownloadHeaders(url: string, channel: DbChannel, accept: string): Record<string, string> {
    // 部分 CDN（Suno 的封面就是）对无 UA 的请求回 403，浏览器却能打开
    const headers: Record<string, string> = { Accept: accept, "User-Agent": "Mozilla/5.0" };
    if (channel.authType === "none" || channel.authType === "query") return headers;
    let host = "";
    let channelHost = "";
    try {
      host = new URL(url).host;
      channelHost = new URL(channel.baseUrl).host;
    } catch {
      return headers;
    }
    if (!host || host !== channelHost) return headers;
    const key = this.sessionKeys.get(channel.id) || (channel.secretEnv ? process.env[channel.secretEnv] : "");
    if (!key) return headers;
    applyAuth(url, headers, channel, key);
    return headers;
  }

  private async resolveImage(image: ImageCandidate, channel: DbChannel) {
    if (image.base64) {
      const clean = image.base64.replace(/^data:image\/[^;]+;base64,/, "").replace(/\s/g, "");
      return { bytes: Buffer.from(clean, "base64"), mimeType: image.mimeType ?? "image/png" };
    }
    if (!image.url) throw new AppError("ASSET_INVALID", "图片响应缺少 URL 或 Base64", 502);
    const headers = this.assetDownloadHeaders(image.url, channel, "image/*");
    const response = await safeFetch(image.url, { method: "GET", headers }, { allowPrivateNetwork: channel.allowPrivateNetwork });
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

export function extensionForMime(mimeType: string) {
  if (mimeType.includes("jpeg")) return "jpg";
  if (mimeType.includes("webp")) return "webp";
  if (mimeType.includes("gif")) return "gif";
  return "png";
}

export function videoExtensionForMime(mimeType: string) {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("quicktime")) return "mov";
  if (mimeType.includes("x-matroska")) return "mkv";
  return "mp4";
}

/** TTS 没有歌名，用正文第一行的前几十个字当标题，历史里才分得清 */
function speechTitle(prompt: string, index: number) {
  const line = prompt.replace(/\s+/g, " ").trim();
  if (!line) return `语音 ${index + 1}`;
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

/**
 * 从 PCM WAV 头里算时长。
 * Gemini TTS 固定 24kHz / 16bit / mono，但它不返回值；历史列表需要时长。
 */
export function wavDurationSeconds(bytes: Buffer): number | undefined {
  if (bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return undefined;
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (id === "fmt " && size >= 16 && dataStart + 16 <= bytes.length) {
      byteRate = bytes.readUInt32LE(dataStart + 8);
    }
    if (id === "data" && byteRate > 0) {
      const available = Math.min(size, bytes.length - dataStart);
      return Math.round((available / byteRate) * 100) / 100;
    }
    offset = dataStart + size + (size % 2);
  }
  return undefined;
}

export function audioExtensionForMime(mimeType: string) {
  if (mimeType.includes("mpeg")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("flac")) return "flac";
  if (mimeType.includes("aac")) return "aac";
  // audio/mp4、audio/x-m4a、audio/m4a 都落到这里
  return "m4a";
}

function referenceInputs(input: GenerationInput) {
  return input.referenceImages?.length ? input.referenceImages : input.referenceImage ? [input.referenceImage] : [];
}

/** 统计走内联 data URI 的视频素材字符数：公网/oss 地址不计入请求体，忽略 */
function inlineMediaSize(input: GenerationInput) {
  const media = [...(input.wanVideoMedia ?? []), ...(input.seedanceVideoMedia ?? []), ...(input.klingVideoMedia ?? [])];
  return media.reduce((total, item) => (item.url.startsWith("data:") ? total + item.url.length : total), 0);
}

export function matchesImageSignature(bytes: Buffer, mimeType: ReferenceImageInput["mimeType"]) {
  return detectImageMime(bytes) === mimeType;
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
