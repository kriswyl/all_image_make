import type { AdapterType } from "../shared/types";

export type ToastKind = "success" | "error";

export const adapterLabels: Record<AdapterType, string> = {
  "openai-images": "OpenAI Images",
  "openai-chat-image": "OpenAI Chat Image",
  "gemini-content": "Gemini Content",
  "generic-json": "Generic JSON",
};
