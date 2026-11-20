import { z } from "zod";
import { parseChatWebUrl, type ChatWebProvider } from "../../shared/chat-web.js";

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const SEARCH_LIMIT = 5;
const excerpt = z.object({
  url: z.string(), title: z.string().optional(), description: z.string().optional(), content: z.string().optional(),
});
const firecrawlSearch = z.object({ success: z.literal(true), data: z.object({ web: z.array(z.unknown()).default([]) }) });
const firecrawlPage = z.object({
  success: z.literal(true),
  data: z.object({ markdown: z.string().optional(), metadata: z.object({
    url: z.string().optional(), sourceURL: z.string().optional(), title: z.string().optional(), statusCode: z.number().optional(),
  }).optional() }),
});
const tavilySearch = z.object({ results: z.array(z.unknown()) });
const tavilyPage = z.object({ results: z.array(z.object({ url: z.string(), raw_content: z.string() })) });

export interface WebSource { url: string; title: string; snippet?: string }
export interface WebPage { source: WebSource; content: string }
export interface WebProvider {
  id: ChatWebProvider;
  search(query: string, signal: AbortSignal): Promise<WebSource[]>;
  read(url: string, signal: AbortSignal): Promise<WebPage>;
}

class ProviderError extends Error {}

function httpError(status: number): string {
  if (status === 429) return "达到请求频率或用量上限（HTTP 429）";
  if ([402, 432, 433].includes(status)) return `额度不足或达到套餐上限（HTTP ${status}）`;
  if (status === 401) return "服务鉴权失败（HTTP 401）";
  if (status === 403) return "服务拒绝访问（HTTP 403）";
  if ([408, 504].includes(status)) return `服务响应超时（HTTP ${status}）`;
  return `服务请求失败（HTTP ${status}）`;
}

async function post<T>(url: string, body: object, schema: z.ZodType<T>, signal: AbortSignal, key?: string): Promise<T> {
  signal.throwIfAborted();
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST", redirect: "error", signal: AbortSignal.any([signal, timeout]),
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new ProviderError(httpError(response.status));
    }
    const reader = response.body?.getReader();
    if (!reader) throw new ProviderError("服务返回空响应");
    const decoder = new TextDecoder();
    let bytes = 0;
    let json = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        throw new ProviderError("服务响应超过大小上限");
      }
      json += decoder.decode(value, { stream: true });
    }
    const parsed = schema.safeParse(JSON.parse(json + decoder.decode()));
    if (!parsed.success) throw new ProviderError("服务未返回可用的结果");
    return parsed.data;
  } catch (error) {
    signal.throwIfAborted();
    if (timeout.aborted) throw new ProviderError("连接服务或读取响应超时");
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(error instanceof SyntaxError ? "服务返回的响应格式无效" : "无法连接或读取服务响应");
  }
}

function makeSource(value: string, title?: string, snippet?: string): WebSource | null {
  const url = parseChatWebUrl(value);
  if (!url) return null;
  const text = snippet?.replace(/\s+/g, " ").trim().slice(0, 500);
  return { url: url.href, title: title?.replace(/\s+/g, " ").trim().slice(0, 200) || url.hostname, ...(text ? { snippet: text } : {}) };
}

function searchSources(rows: unknown[]): WebSource[] {
  const sources = new Map<string, WebSource>();
  for (const row of rows) {
    const { data } = excerpt.safeParse(row);
    if (!data) continue;
    const item = makeSource(data.url, data.title, data.description ?? data.content);
    if (item && !sources.has(item.url)) sources.set(item.url, item);
    if (sources.size >= SEARCH_LIMIT) break;
  }
  if (rows.length && !sources.size) throw new ProviderError("搜索结果中没有可用的公开链接");
  return [...sources.values()];
}

function page(content: string | undefined, url: string, title?: string): WebPage {
  const source = makeSource(url, title);
  if (!source || !content?.trim()) throw new ProviderError("未读取到网页正文");
  return { source, content: content.trim() };
}

export const firecrawlWeb: WebProvider = {
  id: "firecrawl",
  async search(query, signal) {
    const result = await post("https://api.firecrawl.dev/v2/search", { query, limit: SEARCH_LIMIT, sources: ["web"], timeout: 10_000 }, firecrawlSearch, signal);
    return searchSources(result.data.web);
  },
  async read(url, signal) {
    const { data } = await post("https://api.firecrawl.dev/v2/scrape", {
      url, formats: ["markdown"], onlyMainContent: true, timeout: 10_000,
    }, firecrawlPage, signal);
    const status = data.metadata?.statusCode;
    if (status && (status < 200 || status >= 300)) throw new ProviderError(`目标网页返回 HTTP ${status}`);
    return page(data.markdown, data.metadata?.url ?? data.metadata?.sourceURL ?? url, data.metadata?.title);
  },
};

export function tavilyWeb(key: string): WebProvider {
  return {
    id: "tavily",
    async search(query, signal) {
      const result = await post("https://api.tavily.com/search", {
        query, search_depth: "basic", max_results: SEARCH_LIMIT, include_answer: false, include_raw_content: false,
      }, tavilySearch, signal, key);
      return searchSources(result.results);
    },
    async read(url, signal) {
      const result = await post("https://api.tavily.com/extract", {
        urls: [url], extract_depth: "basic", format: "markdown", timeout: 10,
      }, tavilyPage, signal, key);
      const article = result.results[0];
      return page(article?.raw_content, article?.url ?? url);
    },
  };
}
