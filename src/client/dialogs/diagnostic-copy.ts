import { APP_VERSION } from "../../shared/app-config";
import type { Diagnostic, RequestDiagnosticTrace, Task } from "../../shared/types";
import { statusLabels, terminalStatuses } from "../task-ui";

export const phaseLabels: Record<RequestDiagnosticTrace["phase"], string> = {
  prepare: "本地请求准备",
  upstream: "上游请求",
  response_body: "读取上游响应",
  parse_result: "解析产物",
  download_result: "下载产物",
  save_result: "检查与保存产物",
  service_restart: "本地服务重启",
};

export interface DiagnosticCopyOptions {
  prompt: boolean;
  mediaLinks: boolean;
  response: boolean;
}

const hidden = "[已隐藏]";
const secretKey = /authorization|api[-_]?key|access[-_]?key|token|secret|cookie|password|credential|signature|session[-_]?id/i;
const link = /(?:https?|oss):\/\/[^\s"'<>\\]+/gi;
const inlineMedia = /data:[a-z0-9.+\/-]+(?:;[^,\s]*)?,[^\s"'<>\\]+/gi;
const promptKey = /prompt|lyrics/i;

function token(value: unknown) {
  return typeof value === "string" && /^[\w.:-]{1,200}$/.test(value) && !/^sk-/i.test(value) ? value : undefined;
}

function line(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 200);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function diagnosticOutcome(trace: RequestDiagnosticTrace, terminal: boolean) {
  return trace.outcome === "pending" ? terminal ? "未记录结束" : "进行中" : trace.outcome === "failed" ? "失败" : "完成";
}

function upstreamIds(response: unknown) {
  const root = record(response);
  let embedded: Record<string, unknown> | undefined;
  if (typeof root?.message === "string" && root.message.length < 24_000) {
    try { embedded = record(JSON.parse(root.message)); } catch { /* 普通错误说明 */ }
  }
  const fields = [root, record(root?.error), record(root?.data), record(root?.output), embedded, record(embedded?.error)];
  return [...new Set(fields.flatMap((field) => [
    token(field?.request_id ?? field?.requestId), token(field?.task_id ?? field?.taskId),
  ].filter(Boolean)))];
}

function shareableUrl(value: string) {
  try {
    const url = new URL(value);
    if (!["https:", "http:", "oss:"].includes(url.protocol)) return hidden;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch { return hidden; }
}

function responseCopy(value: unknown, options: DiagnosticCopyOptions, privatePrompts: string[], depth = 0): unknown {
  if (depth > 12) return "[已省略]";
  if (typeof value === "string") {
    if (value.length > 24_000) return "[过长内容已省略]";
    if (/^\s*[\[{]/.test(value)) {
      try { return JSON.stringify(responseCopy(JSON.parse(value), options, privatePrompts, depth + 1)); }
      catch { /* 非 JSON 文本按下方规则处理 */ }
    }
    let result = value;
    if (!options.prompt) for (const prompt of privatePrompts) result = result.replaceAll(prompt, hidden);
    return result.replace(inlineMedia, hidden)
      .replace(link, (url) => options.mediaLinks ? shareableUrl(url) : hidden)
      .replace(/\b(?:Bearer|Basic)\s+[^\s"',;]+|\bsk-[\w-]{8,}/gi, hidden)
      .replace(/(["']?(?:authorization|[\w-]*(?:api[-_]?key|access[-_]?key|token|secret|credential|password|signature|cookie)[\w-]*)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;<>]+)/gi, `$1${hidden}`);
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => responseCopy(item, options, privatePrompts, depth + 1));
  const item = record(value);
  if (!item) return value;
  return Object.fromEntries(Object.entries(item).slice(0, 100).map(([key, entry]) => [
    key, secretKey.test(key) || /^headers$/i.test(key) || (!options.prompt && promptKey.test(key))
      ? hidden : responseCopy(entry, options, privatePrompts, depth + 1),
  ]));
}

function mediaLinks(task: Task, items: Diagnostic[]) {
  const urls = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== "string" || !/^(https?|oss):\/\//i.test(value)) return;
    const sanitized = shareableUrl(value);
    if (sanitized !== hidden) urls.add(sanitized);
  };
  function visit(value: unknown, mediaField = false) {
    if (typeof value === "string") { if (mediaField) add(value); return; }
    if (Array.isArray(value)) { value.forEach((item) => visit(item, mediaField)); return; }
    for (const [key, item] of Object.entries(record(value) ?? {})) {
      if (/headers/i.test(key) || secretKey.test(key) || promptKey.test(key)) continue;
      visit(item, /^(?:(?:first|last)_frame(?:_url)?|(?:reference_)?(?:image|video|audio)(?:s|_url|_urls)?)$/i.test(key) || (mediaField && key === "url"));
    }
  }
  task.inputParameters?.media.forEach((item) => add(item.url));
  items.forEach((item) => visit(item.request?.body));
  return [...urls];
}

export function formatDiagnosticCopy(task: Task, items: Diagnostic[] | null, options: DiagnosticCopyOptions) {
  const terminal = terminalStatuses.includes(task.status);
  const lines = [
    `ChatCanvas v${APP_VERSION} 请求诊断`,
    `本地任务 ID ${line(task.id)} · ${statusLabels[task.status]} · 执行 ${task.attemptCount} 次`,
    `渠道 ${line(task.channelName)} (${line(task.channelId)}) · 模型 ${line(task.model)}`,
    [`创建 ${line(task.createdAt)}`, task.startedAt && `开始 ${line(task.startedAt)}`, task.finishedAt && `结束 ${line(task.finishedAt)}`].filter(Boolean).join(" · "),
  ];
  if (token(task.errorCode)) lines.push(`任务错误 ${task.errorCode}`);
  if (token(task.upstreamTaskId)) lines.push(`渠道任务 ID ${task.upstreamTaskId}`);
  lines.push("");
  if (!items?.length) lines.push(items ? "暂无阶段记录" : "诊断记录未读取");
  for (const [index, item] of (items ?? []).entries()) {
    const { trace } = item;
    const ids = [...new Set([token(trace?.upstreamRequestId), ...upstreamIds(item.response)].filter(Boolean))];
    const phase = trace ? `${phaseLabels[trace.phase]} · ${diagnosticOutcome(trace, terminal)}` : item.request === null ? "上游轮询" : "上游请求";
    const status = item.httpStatus != null ? `HTTP ${item.httpStatus}`
      : trace?.outcome === "failed" && trace.phase === "upstream" ? "未收到 HTTP 响应" : undefined;
    lines.push(`${index + 1}. ${[phase, status, item.durationMs != null ? `${item.durationMs} ms` : undefined].filter(Boolean).join(" · ")}`);
    lines.push(`   ${[
      `开始 ${line(trace?.startedAt ?? item.createdAt)}`, trace?.responseAt && `响应头 ${line(trace.responseAt)}`,
      trace?.finishedAt && `结束 ${line(trace.finishedAt)}`, trace?.timeoutMs && `本地超时 ${trace.timeoutMs / 1000} 秒`,
    ].filter(Boolean).join(" · ")}`);
    if (ids.length) lines.push(`   渠道请求或任务 ID ${ids.join(" · ")}`);
    const errors = [token(trace?.error?.code), token(trace?.error?.causeCode)].filter(Boolean);
    if (errors.length) lines.push(`   错误 ${errors.join(" · ")}`);
    if (trace?.referenceImages) {
      const media = trace.referenceImages;
      lines.push(`   请求体 ${media.requestBytes} 字节（分流前 ${media.beforeBytes}） · ${media.images.length} 张图`);
      for (const image of media.images) {
        const transport = image.transport === "uploaded" ? "渠道图床" : image.transport === "inline" ? "内联" : "素材地址";
        lines.push(`     图 ${image.index} · ${[
          token(image.role), transport, image.width && image.height && `${image.width}×${image.height}`,
          image.fileBytes && `${image.fileBytes} 字节`, image.uploadFallback && "上传失败后改用内联",
        ].filter(Boolean).join(" · ")}`);
      }
    }
  }
  const prompts = [...new Set([task.prompt, task.inputParameters?.prompt, task.inputParameters?.negativePrompt].filter((value): value is string => Boolean(value)))];
  if (options.prompt && prompts.length) lines.push("", "提示词", ...prompts);
  if (options.mediaLinks) {
    const urls = mediaLinks(task, items ?? []);
    lines.push("", "素材地址（无查询参数）", ...(urls.length ? urls : ["暂无可复制的素材地址"]));
  }
  if (options.response) {
    lines.push("", "上游响应（已脱敏）");
    let remaining = 48_000;
    for (const [index, item] of (items ?? []).entries()) {
      if (item.response == null) continue;
      const response = JSON.stringify(responseCopy(item.response, options, prompts), null, 2);
      lines.push(`${index + 1}. ${response.length > remaining ? "[过长响应已省略]" : response}`);
      if (response.length <= remaining) remaining -= response.length;
    }
  }
  return lines.join("\n");
}
