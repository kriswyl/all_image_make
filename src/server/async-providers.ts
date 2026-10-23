import type { AdapterType } from "../shared/types.js";
import { extractVideoCandidates } from "./adapters.js";

/**
 * 异步任务厂商的唯一描述表。
 *
 * 万相 / Grok / Seedance / 可灵 / Suno 的提交请求各家不同，但**提交之后**的
 * 轮询流程是同一件事：查状态、看进度、拿结果、下载。以前这套流程写死在
 * `TaskRunner.pollVideoTask()` 里，且只认视频；接第二种异步产物时只能复制一份，
 * 诊断、404、重启恢复这些坑会跟着复制两遍。
 *
 * 从这里开始，异步厂商只填这份表；`TaskRunner` 只写一份轮询器。
 */
export interface AsyncStatus {
  /** 已经归一成小写的状态词；认不出来是 null（继续轮询） */
  status: string | null;
  /** 0–99 的进度；没有就是 null */
  progress: number | null;
  /** 上游给的失败原因，原样交给用户 */
  error: string | null;
  /** 要落进任务、再给前端渲染的附加信息（目前是 MJ 的按钮） */
  meta?: Record<string, unknown>;
}

export interface AsyncResult {
  kind: "image" | "video" | "audio";
  url: string;
  duration?: number;
  mimeType?: string;
  /** 音频封面；视频/图片不用 */
  coverUrl?: string;
  /** 音乐标题 / 歌词 / 曲风 / Suno custom_id；视频/图片不用 */
  title?: string;
  lyrics?: string;
  tags?: string;
  remoteClipId?: string;
  /**
   * 字段名/扩展名本身就足以断定「这是成品」。
   * 中转生成完却不更新 status 时，只有强候选能单独作为完成依据。
   */
  strong?: boolean;
}

export interface AsyncProviderSpec {
  pollPath(remoteTaskId: string): string;
  /** 不填时用共享的 `extractAsyncTaskId` */
  extractTaskId?(payload: unknown): string | null;
  extractStatus(payload: unknown): AsyncStatus;
  extractResults(payload: unknown): AsyncResult[];
  successStatuses: readonly string[];
  failureStatuses: readonly string[];
  pollIntervalMs?: number;
  maxPolls?: number;
}

/** 上游与中转对“生成完成”的叫法不统一，逐个列出 */
export const ASYNC_SUCCESS_STATUSES = [
  "succeeded", "success", "done", "completed", "complete", "finished", "ok",
];
/**
 * 真正代表失败的终态。
 *
 * 刻意不含 `unknown`：中转在任务刚提交、上游还没回报时就会先回
 * `{ status: "unknown", progress: 0 }`，把它当失败会误杀仍在生成的任务。
 * `fail` 是 Suno 的写法；`FAILURE` 归一后也是 `failure`。
 */
/** MJ 文档建议 3~5 秒轮询；测试沿用 VIDEO_POLL_INTERVAL_MS 的压缩值 */
const MJ_POLL_INTERVAL_MS = (() => {
  const raw = Number(process.env.MJ_POLL_INTERVAL_MS ?? process.env.VIDEO_POLL_INTERVAL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 4_000;
})();

export const ASYNC_FAILURE_STATUSES = [
  "failed", "failure", "fail", "error", "canceled", "cancelled", "expired", "rejected", "timeout",
];

/**
 * 从提交响应里找远端任务 id。
 *
 * 各家形状：
 * - Wan3.0 `{ task_id }` 或 `{ output: { task_id } }`
 * - Grok `{ request_id }`
 * - Seedance `{ id }`
 * - Suno `{ data: [id1, id2] }`（一次两首，取第一首当主任务；结果里会带全部歌曲）
 */
export function extractAsyncTaskId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.task_id === "string") return record.task_id;
  if (typeof record.request_id === "string") return record.request_id;
  if (typeof record.id === "string") return record.id;
  if (typeof record.data === "string") return record.data;
  if (Array.isArray(record.data)) {
    const first = record.data.find((item) => typeof item === "string" || typeof item === "number");
    if (typeof first === "string" || typeof first === "number") return String(first);
  }
  if (record.output && typeof record.output === "object") {
    const output = record.output as Record<string, unknown>;
    if (typeof output.task_id === "string") return output.task_id;
    if (typeof output.id === "string") return output.id;
  }
  if (record.data && typeof record.data === "object") {
    const data = record.data as Record<string, unknown>;
    if (typeof data.task_id === "string") return data.task_id;
    if (typeof data.id === "string") return data.id;
  }
  return null;
}

/**
 * 各家字段名不同：Grok 用 status，万相用 output.task_status，
 * 部分中转还会把任务包在 data / result 里。顶层优先，找不到再看下一层。
 */
export function extractProviderStatus(payload: unknown): AsyncStatus {
  return {
    status: extractStatusWord(payload),
    progress: extractProgress(payload),
    error: extractProviderError(payload),
  };
}

function extractStatusWord(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.status === "string") return record.status.toLowerCase();
  if (typeof record.task_status === "string") return record.task_status.toLowerCase();
  for (const key of ["output", "data", "result"]) {
    const nested = record[key];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
    const inner = nested as Record<string, unknown>;
    if (typeof inner.task_status === "string") return inner.task_status.toLowerCase();
    if (typeof inner.status === "string") return inner.status.toLowerCase();
  }
  return null;
}

function extractProgress(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const read = (value: unknown) => typeof value === "number" ? Math.min(99, Math.max(0, value)) : null;
  const direct = read(record.progress);
  if (direct !== null) return direct;
  for (const key of ["output", "data", "result"]) {
    const nested = record[key];
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) continue;
    const progress = read((nested as Record<string, unknown>).progress);
    if (progress !== null) return progress;
  }
  return null;
}

function extractProviderError(payload: unknown): string | null {
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

function videoSpec(pollPath: (remoteTaskId: string) => string): AsyncProviderSpec {
  return {
    pollPath,
    extractStatus: extractProviderStatus,
    extractResults: (payload) => extractVideoCandidates(payload).map((video) => ({
      kind: "video",
      url: video.url,
      duration: video.duration,
      strong: video.strong,
    })),
    successStatuses: ASYNC_SUCCESS_STATUSES,
    failureStatuses: ASYNC_FAILURE_STATUSES,
  };
}

/**
 * Suno 的状态是数字：1 排队、2 生成中、3 成功、4 失败。
 * 结果在 `data.extend`（JSON 字符串数组，一次两首）和 `data.fileInfo`（主歌曲）里。
 */
function sunoStatus(payload: unknown): AsyncStatus {
  const data = payload && typeof payload === "object"
    ? (payload as Record<string, unknown>).data
    : null;
  const record = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  const raw = record.status;
  const mapped = typeof raw === "number"
    ? ({ 1: "queued", 2: "running", 3: "success", 4: "fail" } as Record<number, string>)[raw] ?? null
    : typeof raw === "string" ? raw.toLowerCase() : null;
  const progress = typeof record.progress === "number"
    ? Math.min(99, Math.max(0, record.progress))
    : null;
  const error = typeof record.errormsg === "string" && record.errormsg.trim()
    ? record.errormsg.trim()
    : null;
  return { status: mapped, progress, error };
}

function sunoTracks(data: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = data.extend;
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
  }
  if (Array.isArray(parsed)) return parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).tracks)) {
    return ((parsed as Record<string, unknown>).tracks as unknown[])
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object");
  }
  return [];
}

function sunoResults(payload: unknown): AsyncResult[] {
  const data = payload && typeof payload === "object"
    ? (payload as Record<string, unknown>).data
    : null;
  const record = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
  const fileInfo = record.fileInfo && typeof record.fileInfo === "object" && !Array.isArray(record.fileInfo)
    ? record.fileInfo as Record<string, unknown>
    : {};
  const results: AsyncResult[] = [];
  const seen = new Set<string>();
  const push = (
    url: unknown,
    title: unknown,
    duration: unknown,
    coverUrl: unknown,
    lyrics: unknown,
    tags: unknown,
    remoteClipId: unknown,
    strong: boolean,
  ) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url) || url.includes("/api/forbidden") || seen.has(url)) return;
    seen.add(url);
    results.push({
      kind: "audio",
      url,
      ...(typeof duration === "number" ? { duration } : {}),
      ...(typeof coverUrl === "string" && coverUrl ? { coverUrl } : {}),
      ...(typeof title === "string" && title ? { title } : {}),
      ...(typeof lyrics === "string" && lyrics.trim() && lyrics.trim() !== "[Instrumental]"
        ? { lyrics }
        : {}),
      ...(typeof tags === "string" && tags.trim() ? { tags } : {}),
      ...(typeof remoteClipId === "string" && remoteClipId ? { remoteClipId } : {}),
      strong,
    });
  };

  for (const track of sunoTracks(record)) {
    const metadata = track.metadata && typeof track.metadata === "object" && !Array.isArray(track.metadata)
      ? track.metadata as Record<string, unknown>
      : {};
    const status = typeof track.status === "string" ? track.status.toLowerCase() : "";
    push(
      track.audio_url,
      track.title,
      metadata.duration,
      track.image_url ?? track.image_large_url,
      // Suno 把最终歌词放在 metadata.prompt（灵感模式是系统生成的，自定义模式是用户写的）
      metadata.prompt,
      metadata.tags,
      track.id,
      status === "complete",
    );
  }

  // 没有 extend（或格式变了）时退回主歌曲；成功状态下同样会走到这里
  push(fileInfo.mp3Url, record.taskName, fileInfo.duration, fileInfo.bigUrl ?? fileInfo.cosUrl, null, null, null, false);
  return results;
}

export const ASYNC_PROVIDER_SPECS: Partial<Record<AdapterType, AsyncProviderSpec>> = {
  "wan-video": videoSpec((id) => `/api/v1/tasks/${id}`),
  "grok-video": videoSpec((id) => `/v1/videos/${id}`),
  "seedance-video": videoSpec((id) => `/api/v3/contents/generations/tasks/${id}`),
  "kling-video": {
    // 可灵的响应里 request_id 是请求追踪号，data.id 才是任务 id；不能走通用提取
    extractTaskId: (payload) => {
      const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const data = record.data && typeof record.data === "object" && !Array.isArray(record.data)
        ? record.data as Record<string, unknown>
        : null;
      return data && typeof data.id === "string" ? data.id : null;
    },
    pollPath: (id) => `/tasks?task_ids=${encodeURIComponent(id)}`,
    extractStatus: (payload) => {
      const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const data = Array.isArray(record.data) ? record.data[0] : record.data;
      const task = data && typeof data === "object" ? data as Record<string, unknown> : {};
      const status = typeof task.status === "string" ? task.status.toLowerCase() : null;
      const error = status === "failed" && typeof task.message === "string" && task.message
        ? task.message
        : null;
      return { status, progress: null, error };
    },
    extractResults: (payload) => {
      const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const data = Array.isArray(record.data) ? record.data[0] : record.data;
      const task = data && typeof data === "object" ? data as Record<string, unknown> : {};
      const outputs = Array.isArray(task.outputs) ? task.outputs : [];
      const results: AsyncResult[] = [];
      const seen = new Set<string>();
      for (const item of outputs) {
        if (!item || typeof item !== "object") continue;
        const output = item as Record<string, unknown>;
        if (typeof output.url !== "string" || !/^https?:\/\//i.test(output.url) || seen.has(output.url)) continue;
        seen.add(output.url);
        const duration = Number(output.duration);
        results.push({
          kind: "video",
          url: output.url,
          ...(Number.isFinite(duration) ? { duration } : {}),
          strong: true,
        });
      }
      return results;
    },
    successStatuses: ["succeeded"],
    failureStatuses: ["failed"],
    pollIntervalMs: 10_000,
    maxPolls: 120,
  },
  midjourney: {
    // 提交响应是 { code: 1, result: "179..." }；result 才是任务 id
    extractTaskId: (payload) => {
      const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      if (typeof record.result === "string" && record.result) return record.result;
      const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : {};
      return typeof data.result === "string" ? data.result : null;
    },
    pollPath: (id) => `/mj/task/${encodeURIComponent(id)}/fetch`,
    extractStatus: (payload) => {
      const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      const status = typeof record.status === "string" ? record.status.toLowerCase() : null;
      const progressText = typeof record.progress === "string" ? record.progress : "";
      const progressNumber = Number(progressText.replace("%", ""));
      const progress = Number.isFinite(progressNumber)
        ? Math.min(99, Math.max(0, Math.round(progressNumber)))
        : null;
      const failReason = typeof record.failReason === "string" ? record.failReason.trim() : "";
      const buttons = Array.isArray(record.buttons) ? record.buttons : undefined;
      return {
        status,
        progress,
        error: status === "failure" ? (failReason || "Midjourney 生成失败") : null,
        meta: {
          midjourney: {
            ...(typeof record.action === "string" ? { action: record.action } : {}),
            ...(typeof record.promptEn === "string" && record.promptEn ? { promptEn: record.promptEn } : {}),
            ...(typeof record.description === "string" ? { description: record.description } : {}),
            ...(buttons?.length ? { buttons } : {}),
          },
        },
      };
    },
    extractResults: (payload) => {
      const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
      return typeof record.imageUrl === "string" && record.imageUrl
        ? [{ kind: "image", url: record.imageUrl, strong: true }]
        : [];
    },
    successStatuses: ["success"],
    failureStatuses: ["failure"],
    pollIntervalMs: MJ_POLL_INTERVAL_MS,
    maxPolls: 150,
  },
  "suno-music": {
    pollPath: (id) => `/api/midjourney/drawInfo4?id=${encodeURIComponent(id)}`,
    extractStatus: sunoStatus,
    extractResults: sunoResults,
    successStatuses: ["success"],
    failureStatuses: ["fail", "failure", "failed"],
    maxPolls: 120,
  },
};

export function asyncProviderSpec(adapterType: string): AsyncProviderSpec | null {
  return ASYNC_PROVIDER_SPECS[adapterType as AdapterType] ?? null;
}
