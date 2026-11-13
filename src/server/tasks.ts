import crypto from "node:crypto";
import { DEFAULT_IMAGE_SIZE, normalizeImageSize } from "../shared/types.js";
import type { GenerationInput, Task } from "../shared/types.js";
import type { SunoTaskMeta } from "../shared/suno.js";
import type { AppDatabase, DbChannel } from "./db.js";
import type { TaskPatch, TaskRow } from "./db-tasks.js";
import {
  RemoteApiError,
  applyAuth,
  buildGenerationRequest,
  requestForDiagnostic,
  sendPreparedRequest,
} from "./adapters.js";
import {
  asyncProviderSpec,
  extractAsyncTaskId,
  nextPollDelay,
  readRetryAfter,
  sunoRemoteIds,
  type AsyncProviderSpec,
  type AsyncResult,
} from "./async-providers.js";
import { joinEndpoint, redact, safeFetch } from "./security.js";
import type { KeyStore } from "./key-store.js";
import { AppError } from "./app-error.js";
import { uploadReferenceMedia, type ReferenceMediaUpload, type ReferenceVideoUpload } from "./reference-video.js";
import { TaskInputFiles, type MaskImageUpload, type ReferenceImageUpload, type StoredGenerationInput } from "./task-input-files.js";
import { TaskOutputFiles } from "./task-output-files.js";

export type { MaskImageUpload, ReferenceImageUpload } from "./task-input-files.js";
export { audioExtension, audioExtensionForMime, extensionForMime, matchesImageSignature, videoExtensionForMime, wavDurationSeconds } from "./task-media.js";

export { AppError } from "./app-error.js";

/** 应用侧 15 MiB 字符预算，base64 约放大 4/3，原始素材约 11.25 MiB；不是上游硬限制。 */
const MAX_INLINE_MEDIA_CHARS = 15 * 1024 * 1024;

/** 轮询节奏可被环境变量覆盖，测试里用短间隔跑完整个提交流程 */
const POLL_DELAY_OVERRIDE_MS = (() => {
  const raw = Number(process.env.VIDEO_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.max(1, raw) : undefined;
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

type TaskRunnerStore = Pick<AppDatabase,
  | "assetsDir" | "inputsDir" | "thumbsDir" | "getChannel" | "getSetting"
  | "createTask" | "getTaskRow" | "getTaskView" | "updateTask" | "listPendingTasks"
  | "taskHasConversationReferences" | "insertAsset" | "insertDiagnostic"
>;

export class TaskRunner {
  private readonly running = new Set<string>();
  /**
   * 任务事件订阅者。
   *
   * 只加这一个出口、不改动已有的写库流程：生成历史页照旧靠轮询，
   * Agent 用它等图片任务结束、把视频进度推给对话界面。
   */
  private readonly listeners = new Set<TaskListener>();

  private readonly inputFiles: TaskInputFiles;
  private readonly outputFiles: TaskOutputFiles;

  constructor(private readonly db: TaskRunnerStore, private readonly sessionKeys: KeyStore) {
    this.inputFiles = new TaskInputFiles(db.inputsDir);
    this.outputFiles = new TaskOutputFiles(db, sessionKeys);
  }

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
  private updateTask(taskId: string, patch: TaskPatch) {
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

  async create({ referenceVideoUpload, referenceVideoUploads, referenceAudioUpload, referenceAudioUploads, ...input }: GenerationInput & {
    referenceVideoUpload?: ReferenceVideoUpload;
    /** 多段参考视频（Seedance）；单段入参仍然接受，画布与脚本还在用 */
    referenceVideoUploads?: ReferenceVideoUpload[];
    /** Seedance 参考音频；与参考视频一样，提交前才上传换 URL。 */
    referenceAudioUpload?: ReferenceMediaUpload;
    referenceAudioUploads?: ReferenceMediaUpload[];
  }, uploads: ReferenceImageUpload[] = [], maskUpload?: MaskImageUpload, libraryScope: "public" | "conversation" = "public", ownerConversationId?: string, agentOperationId?: string): Promise<Task> {
    const channel = this.db.getChannel(input.channelId);
    if (!channel || !channel.enabled) throw new AppError("CHANNEL_NOT_FOUND", "渠道不存在或未启用", 404);
    if (!channel.models.includes(input.model)) throw new AppError("MODEL_NOT_FOUND", "该模型不在渠道模型列表中", 400);
    const musicPromptOptional = channel.adapterType === "suno-music" && (input.musicMode === "sound" || input.musicMode === "mashup");
    if (!input.prompt.trim() && !musicPromptOptional) throw new AppError("INVALID_INPUT", "提示词不能为空", 400);
    if (input.prompt.length > 20000) throw new AppError("INVALID_INPUT", "提示词不能超过 20000 个字符", 400);
    const rawSize = JSON.stringify(input.rawParameters ?? {}).length;
    if (rawSize > 65536) throw new AppError("INVALID_INPUT", "高级参数不能超过 64 KB", 400);
    const inlineMediaChars = inlineMediaSize(input);
    if (inlineMediaChars > MAX_INLINE_MEDIA_CHARS) {
      throw new AppError(
        "INVALID_INPUT",
        `内联素材合计约 ${(inlineMediaChars / 1024 / 1024).toFixed(1)} MB，超出 15 MB 预算，请使用更小的素材或公网地址`,
        400,
      );
    }
    // 补默认值要早于落库：落进 tasks.input 的那份才是重试 / 崩溃恢复会重放的
    input.imageSize = resolveImageSize(channel.adapterType, input.imageSize, this.db.getSetting("geminiImageSize"));
    const id = crypto.randomUUID();
    const stored = await this.inputFiles.persist(id, input, channel, {
      images: uploads, mask: maskUpload,
      videos: [...(referenceVideoUpload ? [referenceVideoUpload] : []), ...(referenceVideoUploads ?? [])],
      audios: [...(referenceAudioUpload ? [referenceAudioUpload] : []), ...(referenceAudioUploads ?? [])],
    });
    try {
      this.db.createTask({ id, channelId: channel.id, model: input.model, prompt: input.prompt, input: stored.input, libraryScope, ownerConversationId, agentOperationId });
    } catch (error) {
      await stored.rollback();
      throw error;
    }
    queueMicrotask(() => void this.run(id));
    return this.db.getTaskView(id)!;
  }

  async run(taskId: string) {
    if (this.running.has(taskId)) return;
    this.running.add(taskId);
    try {
      const task = this.requireTask(taskId);
      const channel = this.requireChannel(task.channelId);
      const stored = JSON.parse(task.inputJson) as StoredGenerationInput;
      const { input, videos: storedVideos, audios: storedAudios } = await this.inputFiles.restore(stored);
      const current = this.db.getTaskRow(taskId);
      if (!current || current.status === "cancelled") return;
      const key = this.resolveKey(channel);
      this.updateTask(taskId, { status: "validating", startedAt: task.startedAt ?? new Date().toISOString(), errorCode: null, errorMessage: null });
      for (const stored of storedVideos) {
        const file = await this.inputFiles.readReferenceVideo(stored);
        const url = await uploadReferenceMedia(channel, this.sessionKeys, file, "video");
        if (this.db.getTaskRow(taskId)?.status !== "validating") return;
        if (channel.adapterType === "kling-video") {
          input.klingVideoMedia = [...(input.klingVideoMedia ?? []), { type: "video", url }];
        } else if (channel.adapterType === "wan-video") {
          input.wanVideoMedia = [...(input.wanVideoMedia ?? []), { type: "reference_video", url }];
        } else if (channel.adapterType === "seedance-video") {
          input.seedanceVideoMedia = [...(input.seedanceVideoMedia ?? []), { type: "video_url", url, role: "reference_video" }];
        } else {
          throw new AppError("REFERENCE_VIDEO_UNSUPPORTED", "当前渠道不支持此参考视频", 400);
        }
      }
      for (const stored of storedAudios) {
        const file = await this.inputFiles.readReferenceAudio(stored);
        const url = await uploadReferenceMedia(channel, this.sessionKeys, file, "audio");
        if (this.db.getTaskRow(taskId)?.status !== "validating") return;
        if (channel.adapterType !== "seedance-video") {
          throw new AppError("REFERENCE_AUDIO_UNSUPPORTED", "当前渠道不支持参考音频", 400);
        }
        input.seedanceVideoMedia = [...(input.seedanceVideoMedia ?? []), { type: "audio_url", url, role: "reference_audio" }];
      }
      const prepared = buildGenerationRequest(channel, input, key);
      const effectiveBody = requestForDiagnostic(prepared).body ?? {};
      this.updateTask(taskId, { status: "submitting", effectiveJson: JSON.stringify(effectiveBody), attemptCount: task.attemptCount + 1 });
      const result = await this.sendWithDiagnostic(taskId, prepared).catch(error => {
        const hasExternalVideo = !stored.referenceVideo && (input.wanVideoMedia?.some(item => item.type === "reference_video") || input.klingVideoMedia?.some(item => item.type === "video") || input.seedanceVideoMedia?.some(item => item.type === "video_url"));
        if (hasExternalVideo && error instanceof RemoteApiError && /expired|过期/i.test(error.message)) {
          throw new AppError("REFERENCE_VIDEO_URL_EXPIRED", "参考视频链接已过期，请在视频生成页重新选择原视频或填写新链接", 400);
        }
        const transportInterrupted = error instanceof TypeError || error instanceof Error && /^(TimeoutError|AbortError)$/.test(error.name);
        if ((task.agentOperationId || channel.adapterType === "suno-music") && transportInterrupted) {
          throw new AppError("SUBMISSION_UNKNOWN", "生成请求在返回结果前断开，上游可能已接收，请先到渠道核对任务", 409);
        }
        throw error;
      });

      // 用户在请求飞行中点了停止：结果不再落库，也不要把它改回 succeeded
      if (this.db.getTaskRow(taskId)?.status !== "submitting") return;

      // 异步厂商（视频 / 音乐）：提交响应里拿远端 id，交给统一的轮询器
      const spec = asyncProviderSpec(channel.adapterType);
      const sunoIds = channel.adapterType === "suno-music" ? sunoRemoteIds(result.payload) : [];
      const asyncTaskId = sunoIds[0] ?? (spec ? (spec.extractTaskId?.(result.payload) ?? extractAsyncTaskId(result.payload)) : null);

      if (spec && asyncTaskId) {
        // 先记下上游 task id：进程重启后靠它接着轮询，而不是把任务判死
        this.updateTask(taskId, {
          remoteTaskId: asyncTaskId,
          ...(sunoIds.length ? { remoteMeta: JSON.stringify({ suno: { remoteIds: sunoIds } }) } : {}),
        });
        await this.pollAsyncTask(taskId, asyncTaskId, channel, key, spec);
        return;
      }

      if (channel.adapterType === "suno-music") {
        throw new AppError("SUBMISSION_UNKNOWN", "渠道未返回可查询的任务 ID，请先核对渠道记录", 409);
      }
      await this.outputFiles.saveSynchronous(taskId, result.payload, channel, input.prompt);
      this.updateTask(taskId, { status: "succeeded", progress: 100, finishedAt: new Date().toISOString() });
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
    if (task.errorCode === "SUBMISSION_UNKNOWN") throw new AppError("SUBMISSION_UNKNOWN", "上游可能已接收该任务，请先到渠道核对提交结果", 409);
    if (!isTerminalStatus(task.status)) throw new AppError("TASK_IN_FLIGHT", "任务正在处理，请等待结果", 409);
    if (task.errorCode === "VIDEO_TIMEOUT") return this.continuePolling(taskId);
    const stored = JSON.parse(task.inputJson) as StoredGenerationInput;
    const { input, videos: storedVideos, audios: storedAudios } = await this.inputFiles.restore(stored);
    const referenceVideoUploads = [];
    for (const file of storedVideos) referenceVideoUploads.push(await this.inputFiles.readReferenceVideo(file));
    const referenceAudioUploads = [];
    for (const file of storedAudios) referenceAudioUploads.push(await this.inputFiles.readReferenceAudio(file));
    const privateTask = task.libraryScope === "conversation" || (task.libraryScope === "legacy" && this.db.taskHasConversationReferences(task.id));
    return this.create({ ...input, referenceVideoUploads, referenceAudioUploads }, [], undefined, privateTask ? "conversation" : "public", task.ownerConversationId ?? undefined);
  }

  continuePolling(taskId: string): Task {
    const task = this.requireTask(taskId);
    if (task.remoteTaskId && (task.status === "running" || task.status === "succeeded")) return this.db.getTaskView(taskId)!;
    if (!task.remoteTaskId || task.errorCode !== "VIDEO_TIMEOUT") {
      throw new AppError("TASK_NOT_RESUMABLE", "该任务无法继续查询", 409);
    }
    const channel = this.requireChannel(task.channelId);
    const spec = asyncProviderSpec(channel.adapterType);
    if (!spec) throw new AppError("CHANNEL_UNSUPPORTED", "当前渠道不能查询该任务", 400);
    const key = this.resolveKey(channel);
    void this.resumePolling(taskId, task.remoteTaskId, channel, spec, key);
    return this.db.getTaskView(taskId)!;
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
        if ((task.agentOperationId || task.channelAdapterType === "suno-music") && task.status === "submitting") {
          this.markFailed(task.id, "SUBMISSION_UNKNOWN", "服务重启时未能核实上游提交结果，请先到渠道核对任务");
        } else {
          this.markFailed(task.id, "SERVICE_RESTARTED", "服务已重启，请重新生成");
        }
        continue;
      }
      // 不 await：多个任务并行恢复，任一失败都不能拖住启动
      void this.resumePolling(task.id, task.remoteTaskId!, channel, spec);
    }
  }

  private async resumePolling(taskId: string, remoteTaskId: string, channel: DbChannel, spec: AsyncProviderSpec, key?: string) {
    if (this.running.has(taskId)) return;
    this.running.add(taskId);
    try {
      await this.pollAsyncTask(taskId, remoteTaskId, channel, key ?? this.resolveKey(channel), spec, { immediate: true });
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
    this.updateTask(localTaskId, { status: "running", remoteTaskId, errorCode: null, errorMessage: null, finishedAt: null });
    if (channel.adapterType === "suno-music") {
      await this.pollSunoBatch(localTaskId, remoteTaskId, channel, key, spec, options.immediate);
      return;
    }
    // 提交路径走 joinEndpoint（会吃掉 Base URL 的尾斜杠），轮询这里必须一致，
    // 否则 Base URL 填成 https://api.x.com/ 时会「提交成功、轮询 404」
    const url = joinEndpoint(channel.baseUrl, spec.pollPath(remoteTaskId));

    const headers: Record<string, string> = { Accept: "application/json" };
    if (channel.authType === "bearer") headers.Authorization = `Bearer ${key}`;
    else if (channel.authType === "x-api-key") headers[channel.authHeaderName || "x-api-key"] = key;

    // 只为最近一次查询保留完整响应，较早的查询写状态摘要。
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

    const deadline = Date.now() + spec.polling.windowMs;
    const initialDelay = POLL_DELAY_OVERRIDE_MS ?? spec.polling.initialMs;
    const resumeDelay = (this.db.getTaskRow(localTaskId)?.remotePollAfter ?? 0) - Date.now();
    let delayMs = Math.max(resumeDelay, options.immediate ? 0 : initialDelay);
    let temporaryFailures = 0;

    try {
      for (let poll = 0; Date.now() < deadline; poll += 1) {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, deadline - Date.now())));
        if (this.db.getTaskRow(localTaskId)?.status !== "running") return;
        if (Date.now() >= deadline) break;

        let response: Response;
        let payload: unknown;
        const startedAt = Date.now();
        try {
          const signal = AbortSignal.timeout(Math.max(1, Math.min(30_000, deadline - startedAt)));
          response = await safeFetch(url, { method: "GET", headers, signal }, { allowPrivateNetwork: channel.allowPrivateNetwork });
          // 网关出错时多半回的是 HTML，强行 json() 会抛 SyntaxError 掩盖真实状态码
          payload = await response.json().catch(() => null);
        } catch (error) {
          if (error instanceof TypeError || error instanceof Error && /^(TimeoutError|AbortError)$/.test(error.name)) {
            temporaryFailures += 1;
            delayMs = Math.min(60_000, initialDelay * 2 ** Math.min(temporaryFailures, 5));
            continue;
          }
          throw new AppError("VIDEO_POLL_FAILED", error instanceof Error ? error.message : "轮询任务状态失败", 502);
        }
        if (this.db.getTaskRow(localTaskId)?.status !== "running") return;

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
        pending = { index: poll + 1, payload, httpStatus: response.status, durationMs: Date.now() - startedAt };

        if (response.status === 404) {
          throw new AppError("REMOTE_TASK_NOT_FOUND", "上游已找不到该任务，可能已过期或被清理", 502);
        }
        if (response.status === 429 || response.status === 408 || response.status >= 500) {
          temporaryFailures += 1;
          const retryAfter = readRetryAfter(response.headers.get("retry-after"));
          if (retryAfter > 0) this.db.updateTask(localTaskId, { remotePollAfter: Date.now() + retryAfter });
          delayMs = Math.max(retryAfter, Math.min(60_000, initialDelay * 2 ** Math.min(temporaryFailures, 5)));
          continue;
        }
        if (!response.ok) throw new AppError("VIDEO_POLL_FAILED", `查询任务失败（HTTP ${response.status}）`, 502);
        temporaryFailures = 0;

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
          await this.outputFiles.saveResults(localTaskId, chosen, channel);
          if (this.db.getTaskRow(localTaskId)?.status !== "running") return;
          this.updateTask(localTaskId, { status: "succeeded", progress: 100, finishedAt: new Date().toISOString() });
          return;
        }

        delayMs = POLL_DELAY_OVERRIDE_MS ?? nextPollDelay(spec.polling, status);
      }

      throw new AppError("VIDEO_TIMEOUT", "已暂停查询，上游任务可能仍在运行。可继续查询原任务。", 504);
    } finally {
      // 最后一条轮询（成功、失败、超时都一样）保留完整响应：排查时最有用的是它
      flushPending();
    }
  }

  private async pollSunoBatch(taskId: string, primaryId: string, channel: DbChannel, key: string, spec: AsyncProviderSpec, immediate = false) {
    const meta: SunoTaskMeta = this.db.getTaskView(taskId)?.remoteMeta?.suno ?? {};
    const ids = meta.remoteIds?.length ? meta.remoteIds : [primaryId];
    const expected = 2;
    const headers = { Accept: "application/json", "New-Api-User": "1" };
    const deadline = Date.now() + spec.polling.windowMs;
    const interval = POLL_DELAY_OVERRIDE_MS ?? spec.polling.runningMs;
    const finished = new Set<string>();
    const failures = new Map<string, string>();
    const candidates = new Map<string, AsyncResult>();
    const running = () => this.db.getTaskRow(taskId)?.status === "running";
    let delay = Math.max(immediate ? 0 : (POLL_DELAY_OVERRIDE_MS ?? spec.polling.initialMs), (this.db.getTaskRow(taskId)?.remotePollAfter ?? 0) - Date.now());
    let legacyPartial = false;

    while (Date.now() < deadline) {
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, Math.min(delay, deadline - Date.now())));
      if (!running() || Date.now() >= deadline) break;
      delay = interval;
      for (const id of ids) {
        if (finished.has(id) || !running() || Date.now() >= deadline) continue;
        const requestHeaders: Record<string, string> = { ...headers };
        const url = applyAuth(joinEndpoint(channel.baseUrl, spec.pollPath(id)), requestHeaders, channel, key);
        const startedAt = Date.now();
        try {
          const response = await safeFetch(url, {
            method: "GET", headers: requestHeaders,
            signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - startedAt))),
          }, { allowPrivateNetwork: channel.allowPrivateNetwork });
          if (!running()) return;
          if (response.status === 429 || response.status === 408 || response.status >= 500) {
            const retryAfter = readRetryAfter(response.headers.get("retry-after"));
            delay = Math.max(delay, retryAfter);
            if (retryAfter) {
              this.db.updateTask(taskId, { remotePollAfter: Date.now() + retryAfter });
              break;
            }
            continue;
          }
          const payload = await response.json().catch(() => null);
          if (!running()) return;
          const status = spec.extractStatus(payload);
          if (!response.ok || (status.status && spec.failureStatuses.includes(status.status))) {
            failures.set(id, status.error || `歌曲任务查询失败（HTTP ${response.status}）`);
            finished.add(id);
          } else {
            for (const item of spec.extractResults(payload)) {
              const duplicate = [...candidates].find(([, existing]) => existing.url === item.url && (!existing.remoteClipId || !item.remoteClipId));
              if (!duplicate || item.remoteClipId && !duplicate[1].remoteClipId) {
                if (duplicate) candidates.delete(duplicate[0]);
                candidates.set(item.remoteClipId ?? item.url, item);
              }
            }
            if (status.progress !== null) {
              const current = this.db.getTaskRow(taskId)?.progress ?? 0;
              if (status.progress > current) this.updateTask(taskId, { progress: status.progress });
            }
            if (status.status && spec.successStatuses.includes(status.status)) {
              // 批次可能先返回主歌曲；另一首还在 streaming 时继续查。
              if (ids.length > 1 || candidates.size >= expected) finished.add(id);
            }
          }
          if (finished.has(id) || candidates.size >= expected) {
            this.db.insertDiagnostic({
              taskId, request: { remoteTaskId: id, method: "GET" },
              response: redact(truncatePayload(payload)), httpStatus: response.status, durationMs: Date.now() - startedAt,
            });
          }
        } catch (error) {
          if (!(error instanceof TypeError) && !(error instanceof Error && /^(TimeoutError|AbortError)$/.test(error.name))) throw error;
        }
        if (candidates.size >= expected) break;
      }
      if (candidates.size >= expected || finished.size === ids.length) break;
      // 历史单 ID 任务只能查询原结果，给第二首一次补齐机会。
      if (ids.length === 1 && candidates.size === 1) {
        if (legacyPartial) break;
        legacyPartial = true;
      }
    }

    if (!running()) return;
    const existingAssets = this.db.getTaskView(taskId)?.assets ?? [];
    const existing = new Set(existingAssets.map(asset => asset.remoteClipId).filter(Boolean));
    const tracks = new Map((meta.tracks ?? []).map(item => [item.clipId, item]));
    let saved = existingAssets.length;
    let downloadError: unknown;
    for (const item of candidates.values()) {
      if (!running()) return;
      if (saved >= expected) break;
      if (item.remoteClipId && existing.has(item.remoteClipId)) continue;
      try {
        await this.outputFiles.saveResults(taskId, [item], channel, saved);
        if (item.remoteClipId && item.suno) tracks.set(item.remoteClipId, { ...item.suno, clipId: item.remoteClipId });
        if (item.remoteClipId) existing.add(item.remoteClipId);
        saved += 1;
      } catch (error) { downloadError = error; }
    }
    if (!running()) return;
    const timedOut = Date.now() >= deadline && finished.size < ids.length && candidates.size < expected;
    const warning = saved > 0 && saved < expected
      ? `本批已保存 ${saved} 首。另一首${timedOut ? "尚未完成" : downloadError ? "下载失败" : "未返回成品"}。`
      : undefined;
    this.updateTask(taskId, { remoteMeta: JSON.stringify({ suno: { remoteIds: ids, tracks: [...tracks.values()], warning } }) });
    if (timedOut) throw new AppError("VIDEO_TIMEOUT", "已暂停查询，可继续查询原任务。", 504);
    if (!saved) {
      if (downloadError) throw downloadError;
      throw new AppError("REMOTE_TASK_FAILED", failures.values().next().value || "没有返回已完成的音频", 502);
    }
    this.updateTask(taskId, { status: "succeeded", progress: 100, finishedAt: new Date().toISOString() });
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

/** 统计走内联 data URI 的视频素材字符数：公网/oss 地址不计入请求体，忽略 */
function inlineMediaSize(input: GenerationInput) {
  const media = [...(input.wanVideoMedia ?? []), ...(input.seedanceVideoMedia ?? []), ...(input.klingVideoMedia ?? [])];
  return media.reduce((total, item) => (item.url.startsWith("data:") ? total + item.url.length : total), 0);
}

export function normalizeError(error: unknown) {
  if (error instanceof AppError) return error;
  if (error instanceof RemoteApiError) return new AppError("REMOTE_REQUEST_FAILED", error.message, error.status, redact(error.payload));
  const message = error instanceof Error ? error.message : "未知错误";
  if (/timeout|aborted/i.test(message)) return new AppError("REQUEST_TIMEOUT", "请求超时", 504);
  return new AppError("INTERNAL_ERROR", message, 500);
}
