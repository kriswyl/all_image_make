import { z } from "zod";

export const CHAT_WEB_PROVIDERS = ["firecrawl", "tavily"] as const;
export type ChatWebProvider = (typeof CHAT_WEB_PROVIDERS)[number];
export const chatWebProviderLabels: Record<ChatWebProvider, string> = {
  firecrawl: "Firecrawl Keyless",
  tavily: "Tavily",
};

export interface ChatWebSettings {
  preferred: ChatWebProvider;
  fallback: boolean;
  hasTavilyKey: boolean;
}

export interface ChatWebSettingsPatch {
  preferred: ChatWebProvider;
  fallback: boolean;
  /** Omit to keep the stored key, or send an empty string to remove it. */
  tavilyKey?: string;
}

export function isChatWebTool(name: string): name is "web_search" | "read_web_page" {
  return name === "web_search" || name === "read_web_page";
}

/** Web tools and citation cards accept public web domains only. */
export function parseChatWebUrl(value: string): URL | null {
  if (value.length > 2048 || /[\r\n]/.test(value)) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/\.$/, "");
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port
      || !/\.[a-z][a-z0-9-]*$/i.test(host)
      || /\.(?:local|localhost|internal|lan|home|corp|test|invalid|onion|arpa)$/i.test(host)) return null;
    return url;
  } catch { return null; }
}

export const chatWebToolResultSchema = z.object({
  provider: z.enum(CHAT_WEB_PROVIDERS),
  attempts: z.array(z.object({ provider: z.enum(CHAT_WEB_PROVIDERS), error: z.string() })).max(2),
  sources: z.array(z.object({
    url: z.string().refine(url => Boolean(parseChatWebUrl(url))),
    title: z.string(),
    snippet: z.string().optional(),
  })).max(5),
  truncated: z.boolean().optional(),
});
export type ChatWebToolResult = z.infer<typeof chatWebToolResultSchema>;
