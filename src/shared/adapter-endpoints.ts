import type { AdapterType } from "./types.js";

/**
 * 适配器的默认提交路径。
 *
 * 以前这份映射在 `server/adapters.ts` 和 `shared/provider-presets.ts` 各写了一遍，
 * 加一个渠道要同步两处。轮询路径已经收进 `server/async-providers.ts`，
 * 提交路径也收在这里，渠道向导和服务端请求构造共用一份。
 */
export function defaultEndpointFor(adapterType: AdapterType): string {
  switch (adapterType) {
    case "openai-images": return "/v1/images/generations";
    case "openai-chat-image": return "/v1/chat/completions";
    case "openai-chat": return "/v1/chat/completions";
    case "gemini-content": return "/v1beta/models/{model}:generateContent";
    case "gemini-tts": return "/v1beta/models/{model}:generateContent";
    case "midjourney": return "/mj/submit/imagine";
    case "wan-video": return "/api/v1/services/aigc/video-generation/video-synthesis";
    case "grok-video": return "/v1/videos/generations";
    case "seedance-video": return "/api/v3/contents/generations/tasks";
    case "kling-video": return "/text-to-video/{model}";
    case "suno-music": return "/api/queue/makeAiMusic";
    default: return "/v1/images/generations";
  }
}
