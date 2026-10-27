import type { DbChannel } from "./db.js";
import { RemoteApiError, applyAuth, defaultEndpoint } from "./adapters.js";
import { joinEndpoint, safeFetch } from "./security.js";

/**
 * Agent 的大脑调用。
 *
 * 这是一次**裸的 chat completions 请求**，不经过 TaskRunner，也不使用 GenerationInput——
 * adapters.ts 里的 buildGenerationRequest() 是为生图服务的参数映射器，把 chat 语义塞进去
 * 会污染它。所以这里单独走一条极简路径，只复用三样东西：applyAuth() 的鉴权、
 * safeFetch() 的 SSRF 防护与重定向限制、defaultEndpoint() 的路径表。
 */

/** OpenAI 兼容的多模态内容片段。看图改（AGENT_PLAN.md §11）用它把缩略图塞进上下文 */
export type BrainContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface BrainMessage {
  role: "system" | "user" | "assistant";
  content: string | BrainContentPart[];
}

/** 流式增量。推理模型会走 reasoning 通道，和正文分开，正好可以拿来显示「思考中」 */
export interface BrainDelta {
  content?: string;
  reasoning?: string;
}

export interface BrainUsage {
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}

export interface BrainResult {
  /** 正文。推理模型在 max_tokens 被耗尽时这里会是空串，配合 truncated 判断 */
  content: string;
  /** 推理过程全文，UI 上折叠显示；非推理模型为空串 */
  reasoning: string;
  finishReason: string | null;
  usage: BrainUsage | null;
  durationMs: number;
  /** 中转站忽略了 stream:true，实际走的是非流式解析 */
  usedFallback: boolean;
  /** finish_reason === "length"：输出被截断，正文可能不完整 */
  truncated: boolean;
}

export interface CallBrainOptions {
  channel: DbChannel;
  key: string;
  model: string;
  messages: BrainMessage[];
  maxTokens?: number;
  /**
   * 默认**不发送** temperature。
   * 推理模型（deepseek-v4-1-flash 等）对上采样参数的处理各不相同，有的直接报错，
   * 所以只在调用方明确要求时才带上。
   */
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onDelta?: (delta: BrainDelta) => void;
}

/**
 * 默认输出上限。实测推理模型会先花几十到几百个 token 推理再输出正文，
 * 上限给小了会只拿到满额 reasoning_tokens 和空 content（finish_reason: "length"）。
 */
export const BRAIN_DEFAULT_MAX_TOKENS = 16_384;
/** 推理模型在长上下文里可能把 16K 全用在思考上；空正文时再用这一档重试一次 */
export const BRAIN_RETRY_MAX_TOKENS = 32_768;

/**
 * 单次大脑调用的默认超时。推理模型长上下文 + 大输出实测会超过 2 分钟，
 * 给到 4 分钟；界面有停止按钮，不需要靠短超时兜底。
 */
export const BRAIN_DEFAULT_TIMEOUT_MS = 240_000;

export class BrainError extends Error {
  constructor(public code: string, message: string, public status?: number) {
    super(message);
  }
}

function buildRequestBody(options: CallBrainOptions) {
  return {
    model: options.model,
    messages: options.messages,
    stream: true,
    max_tokens: options.maxTokens ?? BRAIN_DEFAULT_MAX_TOKENS,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  };
}

/**
 * 拼出最终请求。单独导出是为了让诊断记录和单测能拿到脱敏前的结构。
 */
export function buildBrainRequest(options: CallBrainOptions) {
  const { channel, key } = options;
  if (channel.adapterType !== "openai-chat") {
    throw new BrainError("INVALID_CHANNEL", `渠道「${channel.name}」不是对话适配器，不能作为大脑`);
  }
  const endpoint = (channel.endpoint || defaultEndpoint(channel.adapterType)).replaceAll(
    "{model}",
    encodeURIComponent(options.model),
  );
  const headers: Record<string, string> = { Accept: "text/event-stream", "Content-Type": "application/json" };
  const url = applyAuth(joinEndpoint(channel.baseUrl, endpoint), headers, channel, key);
  return { url, headers, body: buildRequestBody(options), allowPrivateNetwork: channel.allowPrivateNetwork };
}

/** 从一段 SSE 文本里抽出 data 负载；返回 null 表示这段是注释、空行或不完整事件 */
function parseSseBlock(block: string): string | null {
  const dataLines = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (!dataLines.length) return null;
  return dataLines.join("\n");
}

function num(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * 大脑调用主入口。
 *
 * 中转站千差万别，这里对两件事做了兜底：
 * - 忽略 `stream: true` 直接返回普通 JSON 的站点（DeepSeek 官方和部分中转站会这样）
 * - SSE 分块边界不按 `\n\n` 落在网络包边界上的情况（用 buffer 累积后再切）
 */
export async function callBrain(options: CallBrainOptions): Promise<BrainResult> {
  const request = buildBrainRequest(options);
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? BRAIN_DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

  const response = await safeFetch(
    request.url,
    {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
    },
    { allowPrivateNetwork: request.allowPrivateNetwork },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let payload: unknown = { text: text.slice(0, 2000) };
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      // 保持纯文本形态，下面的 extractMessage 会兜底
    }
    throw new RemoteApiError(response.status, payload, extractBrainError(payload));
  }

  const contentType = response.headers.get("content-type") ?? "";
  // 站点忽略了 stream:true，按普通 JSON 响应处理
  if (!contentType.includes("text/event-stream")) {
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const message = pickMessage(payload);
    const content = typeof message.content === "string" ? message.content : "";
    const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
    const finishReason = pickFinishReason(payload);
    if (content && options.onDelta) options.onDelta({ content });
    return {
      content,
      reasoning,
      finishReason,
      usage: pickUsage(payload),
      durationMs: Date.now() - started,
      usedFallback: true,
      truncated: finishReason === "length",
    };
  }

  if (!response.body) throw new BrainError("EMPTY_RESPONSE", "大脑返回了空响应体");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let usage: BrainUsage | null = null;

  const consume = (block: string) => {
    const data = parseSseBlock(block);
    if (data === null || data === "[DONE]") return false;
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(data) as Record<string, unknown>;
    } catch {
      // 单个事件坏掉不该中断整条流
      return true;
    }
    const found = pickUsage(chunk);
    if (found) usage = found;
    const reason = pickFinishReason(chunk);
    if (reason) finishReason = reason;
    const delta = pickDelta(chunk);
    if (!delta) return true;
    const piece: BrainDelta = {};
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      piece.content = delta.content;
    }
    // 推理内容字段名各站不一：reasoning_content 是 DeepSeek 系，reasoning 是部分中转站的别名
    const reasoningPiece =
      typeof delta.reasoning_content === "string" ? delta.reasoning_content
        : typeof delta.reasoning === "string" ? delta.reasoning
          : "";
    if (reasoningPiece) {
      reasoning += reasoningPiece;
      piece.reasoning = reasoningPiece;
    }
    if (options.onDelta && (piece.content || piece.reasoning)) options.onDelta(piece);
    return true;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // 事件之间可能是 \n\n 也可能是 \r\n\r\n，统一后再切，避免跨包边界漏判
    buffer = buffer.replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      consume(block);
      boundary = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim()) consume(buffer);

  return {
    content,
    reasoning,
    finishReason,
    usage,
    durationMs: Date.now() - started,
    usedFallback: false,
    truncated: finishReason === "length",
  };
}

function pickMessage(payload: Record<string, unknown>): Record<string, unknown> {
  const choices = payload.choices;
  if (!Array.isArray(choices) || !choices.length) return {};
  const first = choices[0];
  if (!first || typeof first !== "object") return {};
  const message = (first as Record<string, unknown>).message;
  return message && typeof message === "object" ? (message as Record<string, unknown>) : {};
}

function pickDelta(payload: Record<string, unknown>): Record<string, unknown> | null {
  const choices = payload.choices;
  if (!Array.isArray(choices) || !choices.length) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const delta = (first as Record<string, unknown>).delta;
  return delta && typeof delta === "object" ? (delta as Record<string, unknown>) : null;
}

function pickFinishReason(payload: Record<string, unknown>): string | null {
  const choices = payload.choices;
  if (!Array.isArray(choices) || !choices.length) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const reason = (first as Record<string, unknown>).finish_reason;
  return typeof reason === "string" ? reason : null;
}

function pickUsage(payload: Record<string, unknown>): BrainUsage | null {
  const usage = payload.usage;
  if (!usage || typeof usage !== "object") return null;
  const record = usage as Record<string, unknown>;
  const completionDetails = record.completion_tokens_details;
  const reasoningTokens =
    completionDetails && typeof completionDetails === "object"
      ? num((completionDetails as Record<string, unknown>).reasoning_tokens)
      : 0;
  return {
    promptTokens: num(record.prompt_tokens),
    completionTokens: num(record.completion_tokens),
    reasoningTokens,
  };
}

function extractBrainError(payload: unknown) {
  if (!payload || typeof payload !== "object") return "大脑接口返回错误";
  const record = payload as Record<string, unknown>;
  if (typeof record.message === "string" && record.message) return record.message;
  const error = record.error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message) return message;
  }
  if (typeof record.text === "string" && record.text) return record.text.slice(0, 300);
  return "大脑接口返回错误";
}
