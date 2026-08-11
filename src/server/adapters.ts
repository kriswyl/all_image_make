import type { DbChannel } from "./db.js";
import type { GenerationInput } from "../shared/types.js";
import { assertEndpoint, joinEndpoint, redactHeaders, safeFetch } from "./security.js";

export interface PreparedRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  allowPrivateNetwork: boolean;
}

export interface ImageCandidate {
  url?: string;
  base64?: string;
  mimeType?: string;
}

export class RemoteApiError extends Error {
  constructor(public status: number, public payload: unknown, message = "中转接口返回错误") {
    super(message);
  }
}

function compact<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ""));
}

function openAiImageParameters(input: GenerationInput) {
  return compact({
    negative_prompt: input.negativePrompt,
    size: input.size,
    n: input.count,
    quality: input.quality,
    output_format: input.outputFormat,
    background: input.background,
    output_compression: input.outputCompression,
    moderation: input.moderation,
    style: input.style,
    response_format: input.responseFormat,
    stream: input.stream,
    partial_images: input.partialImages,
    user: input.user,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function geminiGenerationConfig(input: GenerationInput, raw: Record<string, unknown>) {
  const rawConfig = isRecord(raw.generationConfig) ? raw.generationConfig : {};
  const rawImageConfig = isRecord(rawConfig.imageConfig) ? rawConfig.imageConfig : {};
  const { imageConfig: _rawImageConfig, ...rawConfigWithoutImage } = rawConfig;
  const imageConfig = compact({
    aspectRatio: input.aspectRatio,
    imageSize: input.imageSize,
    ...rawImageConfig,
  });
  return {
    ...compact({
      candidateCount: input.count,
      temperature: input.temperature,
      topP: input.topP,
      topK: input.topK,
      maxOutputTokens: input.maxOutputTokens,
      responseModalities: input.responseModalities ?? ["IMAGE"],
      seed: input.seed,
    }),
    ...(Object.keys(imageConfig).length ? { imageConfig } : {}),
    ...rawConfigWithoutImage,
  };
}

export function defaultEndpoint(adapterType: DbChannel["adapterType"]) {
  switch (adapterType) {
    case "openai-images": return "/v1/images/generations";
    case "openai-chat-image": return "/v1/chat/completions";
    case "gemini-content": return "/v1beta/models/{model}:generateContent";
    case "midjourney-task": return "/mj/submit/imagine";
    default: return "/v1/images/generations";
  }
}

export function defaultStatusEndpoint(adapterType: DbChannel["adapterType"]) {
  return adapterType === "midjourney-task" ? "/mj/task/{taskId}/fetch" : "";
}

function applyAuth(url: string, headers: Record<string, string>, channel: DbChannel, key: string) {
  if (channel.authType === "none") return url;
  if (!key) throw new Error("该渠道尚未配置 API Key");
  if (channel.authType === "bearer") headers.Authorization = `Bearer ${key}`;
  if (channel.authType === "x-api-key") headers[ channel.authHeaderName || "x-api-key" ] = key;
  if (channel.authType === "custom-header") headers[channel.authHeaderName || "x-api-key"] = key;
  if (channel.authType === "query") {
    const parsed = new URL(url);
    parsed.searchParams.set(channel.authHeaderName || "key", key);
    return parsed.toString();
  }
  return url;
}

export function buildGenerationRequest(channel: DbChannel, input: GenerationInput, key: string): PreparedRequest {
  let endpoint = channel.endpoint || defaultEndpoint(channel.adapterType);
  endpoint = endpoint.replaceAll("{model}", encodeURIComponent(input.model));
  assertEndpoint(endpoint);
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  let body: Record<string, unknown>;
  const raw = input.rawParameters ?? {};

  if (channel.adapterType === "openai-chat-image") {
    body = {
      model: input.model,
      messages: [{ role: "user", content: input.prompt }],
      ...openAiImageParameters(input),
      ...raw,
    };
  } else if (channel.adapterType === "gemini-content") {
    const text = input.negativePrompt ? `${input.prompt}\n\nNegative prompt: ${input.negativePrompt}` : input.prompt;
    const { generationConfig: _rawGenerationConfig, ...rawBody } = raw;
    body = {
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: geminiGenerationConfig(input, raw),
      ...rawBody,
    };
  } else if (channel.adapterType === "midjourney-task") {
    body = compact({
      model: input.model,
      prompt: input.prompt,
      negative_prompt: input.negativePrompt,
      size: input.size,
      aspect_ratio: input.aspectRatio,
      version: input.mjVersion,
      process_mode: input.processMode,
      stylize: input.stylize,
      chaos: input.chaos,
      weirdness: input.weirdness,
      seed: input.seed,
      ...raw,
    });
  } else {
    body = compact({
      model: input.model,
      prompt: input.prompt,
      ...openAiImageParameters(input),
      ...raw,
    });
  }

  let url = joinEndpoint(channel.baseUrl, endpoint);
  url = applyAuth(url, headers, channel, key);
  return { url, method: "POST", headers, body, allowPrivateNetwork: channel.allowPrivateNetwork };
}

export function buildStatusRequest(channel: DbChannel, remoteTaskId: string, key: string): PreparedRequest {
  let endpoint = channel.statusEndpoint || defaultStatusEndpoint(channel.adapterType);
  endpoint = endpoint.replaceAll("{taskId}", encodeURIComponent(remoteTaskId));
  assertEndpoint(endpoint);
  const headers: Record<string, string> = { Accept: "application/json" };
  let url = joinEndpoint(channel.baseUrl, endpoint);
  url = applyAuth(url, headers, channel, key);
  return { url, method: "GET", headers, allowPrivateNetwork: channel.allowPrivateNetwork };
}

export function buildConnectionTestRequest(channel: DbChannel, key: string): PreparedRequest {
  const endpoint = channel.adapterType === "gemini-content" ? "/v1beta/models" : channel.adapterType.startsWith("openai-") ? "/v1/models" : "/";
  const headers: Record<string, string> = { Accept: "application/json" };
  let url = joinEndpoint(channel.baseUrl, endpoint);
  url = applyAuth(url, headers, channel, key);
  return { url, method: "GET", headers, allowPrivateNetwork: channel.allowPrivateNetwork };
}

export function requestForDiagnostic(request: PreparedRequest) {
  const parsed = new URL(request.url);
  for (const key of ["key", "api_key", "token"]) if (parsed.searchParams.has(key)) parsed.searchParams.set(key, "[REDACTED]");
  return {
    url: parsed.toString(),
    method: request.method,
    headers: redactHeaders(request.headers),
    body: request.body ?? null,
  };
}

export async function sendPreparedRequest(request: PreparedRequest) {
  const started = Date.now();
  const response = await safeFetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body ? JSON.stringify(request.body) : undefined,
  }, { allowPrivateNetwork: request.allowPrivateNetwork });
  const contentType = response.headers.get("content-type") ?? "";
  let payload: unknown;
  if (contentType.startsWith("image/")) {
    payload = { directImage: Buffer.from(await response.arrayBuffer()).toString("base64"), mimeType: contentType.split(";")[0] };
  } else {
    const text = await response.text();
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { text: text.slice(0, 50000) }; }
  }
  const durationMs = Date.now() - started;
  if (!response.ok) throw new RemoteApiError(response.status, payload, extractErrorMessage(payload));
  return { payload, status: response.status, durationMs };
}

function extractErrorMessage(payload: unknown) {
  if (!payload || typeof payload !== "object") return "中转接口返回错误";
  const record = payload as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (record.error && typeof record.error === "object" && typeof (record.error as Record<string, unknown>).message === "string") {
    return String((record.error as Record<string, unknown>).message);
  }
  return "中转接口返回错误";
}

function looksLikeBase64(value: string) {
  return value.length > 128 && /^[A-Za-z0-9+/=_\r\n-]+$/.test(value);
}

function addCandidate(target: ImageCandidate[], seen: Set<string>, candidate: ImageCandidate) {
  const identity = candidate.url ?? candidate.base64?.slice(0, 80);
  if (!identity || seen.has(identity)) return;
  seen.add(identity);
  target.push(candidate);
}

export function extractImageCandidates(payload: unknown): ImageCandidate[] {
  const candidates: ImageCandidate[] = [];
  const seen = new Set<string>();

  const walk = (value: unknown, parentKey = "", depth = 0, mimeType?: string) => {
    if (depth > 8 || value == null) return;
    if (typeof value === "string") {
      if (/^https?:\/\//i.test(value) && /url|image|output|result/i.test(parentKey)) addCandidate(candidates, seen, { url: value });
      if (/^data:image\//i.test(value)) {
        const match = value.match(/^data:(image\/[^;]+);base64,(.+)$/s);
        if (match) addCandidate(candidates, seen, { mimeType: match[1], base64: match[2] });
      } else if (looksLikeBase64(value) && /b64|base64|data|image/i.test(parentKey)) {
        addCandidate(candidates, seen, { base64: value, mimeType });
      }
      const markdown = value.match(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/i);
      if (markdown) addCandidate(candidates, seen, { url: markdown[1] });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, parentKey, depth + 1, mimeType));
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const nextMime = typeof record.mimeType === "string" ? record.mimeType : typeof record.mime_type === "string" ? record.mime_type : mimeType;
    if (typeof record.b64_json === "string") addCandidate(candidates, seen, { base64: record.b64_json, mimeType: nextMime });
    if (typeof record.url === "string" && (/image|output|result|data/i.test(parentKey) || Object.keys(record).length <= 4)) {
      addCandidate(candidates, seen, { url: record.url });
    }
    if (record.image_url && typeof record.image_url === "object" && typeof (record.image_url as Record<string, unknown>).url === "string") {
      addCandidate(candidates, seen, { url: String((record.image_url as Record<string, unknown>).url) });
    }
    for (const [key, item] of Object.entries(record)) walk(item, key, depth + 1, nextMime);
  };

  walk(payload);
  return candidates;
}

export function extractRemoteTaskId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["taskId", "task_id", "id", "result"]) {
    if (typeof record[key] === "string" || typeof record[key] === "number") return String(record[key]);
  }
  if (record.data && typeof record.data === "object") return extractRemoteTaskId(record.data);
  return null;
}

export function readRemoteState(payload: unknown): { status: "running" | "succeeded" | "failed" | "cancelled"; progress: number | null; message?: string } {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const nested = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : record;
  const rawStatus = String(nested.status ?? nested.state ?? nested.task_status ?? "running").toLowerCase();
  let status: "running" | "succeeded" | "failed" | "cancelled" = "running";
  if (/success|succeeded|done|finished|completed/.test(rawStatus)) status = "succeeded";
  if (/fail|error/.test(rawStatus)) status = "failed";
  if (/cancel/.test(rawStatus)) status = "cancelled";
  const rawProgress = nested.progress ?? nested.percentage;
  const parsed = typeof rawProgress === "number" ? rawProgress : typeof rawProgress === "string" ? Number(rawProgress.replace("%", "")) : NaN;
  const progress = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed <= 1 ? parsed * 100 : parsed)) : null;
  const message = typeof nested.message === "string" ? nested.message : typeof nested.failReason === "string" ? nested.failReason : undefined;
  return { status, progress, message };
}
