import type { AdapterType } from "../shared/types";

export type ToastKind = "success" | "error";

export const adapterLabels: Record<AdapterType, string> = {
  "openai-images": "OpenAI Images",
  "openai-chat-image": "OpenAI Chat Image",
  "gemini-content": "Gemini Content",
  "generic-json": "Generic JSON",
  "wan-video": "万相视频",
  "grok-video": "Grok 视频",
  "seedance-video": "Seedance 视频",
  "openai-chat": "对话模型（大脑）",
};
