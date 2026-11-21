import { defaultEndpointFor } from "./adapter-endpoints.js";
import type { AdapterType } from "./types.js";

export function videoReferenceImagePolicy(adapter: string, model: string) {
  const common = { minEdge: 1, maxEdge: Infinity, maxAspectRatio: Infinity, maxFileBytes: 30_000_000, preserveGif: true, opaquePng: false };
  if (adapter === "minimax-video" && /^minimax-h3(?:-|$)/i.test(model)) {
    return { ...common, minEdge: 256, maxEdge: 5760, maxAspectRatio: 2.5, preferredBodyBytes: 1024 * 1024, preserveGif: false };
  }
  const inline = { ...common, preferredBodyBytes: 2 * 1024 * 1024 };
  if (adapter === "seedance-video") return { ...inline, minEdge: 300, maxEdge: 6000, maxAspectRatio: 2.5 };
  if (adapter === "wan-video" && /^wan3\.0(?:[-.]|$)/i.test(model)) {
    return { ...inline, minEdge: 240, maxEdge: 8000, maxAspectRatio: 8, maxFileBytes: 20_000_000, preserveGif: false, opaquePng: true };
  }
  if (adapter === "wan-video" || adapter === "kling-video" || adapter === "grok-video") return inline;
}

/** 仅对确认过图片 URL 协议的渠道启用，其他渠道可以继续用内联。 */
export function supportsVideoReferenceImageUpload(channel: {
  adapterType: AdapterType; baseUrl: string; endpoint?: string; uploadEndpoint?: string;
}, model: string): boolean {
  const verifiedAdapter = channel.adapterType === "seedance-video" || (channel.adapterType === "minimax-video" && /^minimax-h3$/i.test(model));
  if (!channel.uploadEndpoint?.trim() || !verifiedAdapter) return false;
  try {
    const base = new URL(channel.baseUrl);
    return base.origin === "https://api.tiantoken.com" && !base.search && !base.hash && !base.username && !base.password && /^\/*$/.test(base.pathname) &&
      (channel.endpoint || defaultEndpointFor(channel.adapterType)).replace(/\/$/, "") === defaultEndpointFor(channel.adapterType);
  } catch {
    return false;
  }
}
