import { DEFAULT_IMAGE_REQUEST_TIMEOUT_MS, type GenerationInput } from "../../shared/types";
import { SEEDREAM_ADAPTER, SEEDREAM_DEFAULT_WATERMARK, seedreamSize } from "../../shared/seedream";

export type ImageDraft = {
  size: string; imageSize: string; aspectRatio: string; quality: string; count: string;
  negativePrompt: string; background: string; outputFormat: string; moderation: string; style: string; responseFormat: string;
  temperature: string; topP: string; topK: string; maxOutputTokens: string; seed: string; responseModalities: string;
  midjourneyVersion: string; timeoutSeconds: string; raw: string;
  seedreamTier: string; seedreamCustomSize: string; seedreamRatio: string; seedreamWatermark: string;
};
export const defaultImageDraft: ImageDraft = { size: "", imageSize: "", aspectRatio: "", quality: "", count: "1", negativePrompt: "", background: "", outputFormat: "", moderation: "", style: "", responseFormat: "", temperature: "", topP: "", topK: "", maxOutputTokens: "", seed: "", responseModalities: "IMAGE", midjourneyVersion: "", timeoutSeconds: String(DEFAULT_IMAGE_REQUEST_TIMEOUT_MS / 1000), raw: "{}", seedreamTier: "2K", seedreamCustomSize: "", seedreamRatio: "", seedreamWatermark: String(SEEDREAM_DEFAULT_WATERMARK) };

/** Only send fields the selected image adapter understands. */
export function imageGenerationParameters(adapter: string, draft: ImageDraft): Partial<GenerationInput> {
  const openai = ["openai-images", "openai-chat-image", "generic-json"].includes(adapter);
  const gemini = adapter === "gemini-content";
  const mj = adapter === "midjourney";
  const number = (value: string, label: string, min: number, max: number, integer = false): number | undefined => {
    if (!value.trim()) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error(`${label}须为 ${min} 到 ${max} 之间${integer ? "的整数" : "的数字"}`);
    return n;
  };
  const timeoutMs = number(draft.timeoutSeconds, "超时时间", 10, 1800, true);
  if (adapter === SEEDREAM_ADAPTER) {
    if (draft.seedreamTier === "custom" && !draft.seedreamCustomSize.trim()) throw new Error("请填写自定义宽×高");
    return {
      size: seedreamSize(draft.seedreamTier === "custom" ? { size: draft.seedreamCustomSize }
        : { imageSize: draft.seedreamTier, aspectRatio: draft.seedreamRatio }),
      watermark: draft.seedreamWatermark === "true",
      count: number(draft.count, "生成数量", 1, 8, true) ?? 1,
      timeoutMs: timeoutMs === undefined ? undefined : timeoutMs * 1000,
    };
  }
  let rawParameters: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(draft.raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    rawParameters = parsed as Record<string, unknown>;
  } catch { throw new Error("高级参数必须是 JSON 对象"); }
  if (openai && draft.size.trim() && !/^\d+\s*[xX×]\s*\d+$/.test(draft.size.trim())) throw new Error("尺寸请填写宽x高，例如 1536x1024");
  if (JSON.stringify(rawParameters).length > 65536) throw new Error("高级参数不能超过 64 KB");
  return {
    ...(openai ? {
      size: draft.size.trim().replace(/\s/g, "").replace(/[X×]/g, "x") || undefined, quality: draft.quality || undefined,
      count: number(draft.count, "生成数量", 1, 8, true) ?? 1,
      negativePrompt: draft.negativePrompt.trim() || undefined,
      background: (draft.background || undefined) as GenerationInput["background"],
      outputFormat: (draft.outputFormat || undefined) as GenerationInput["outputFormat"],
      moderation: (draft.moderation || undefined) as GenerationInput["moderation"],
      style: (draft.style || undefined) as GenerationInput["style"],
      responseFormat: (draft.responseFormat || undefined) as GenerationInput["responseFormat"],
    } : {}),
    ...(gemini ? {
      imageSize: draft.imageSize || undefined, aspectRatio: draft.aspectRatio.trim() || undefined,
      temperature: number(draft.temperature, "温度", 0, 2), topP: number(draft.topP, "Top P", 0, 1),
      topK: number(draft.topK, "Top K", 1, 100, true), maxOutputTokens: number(draft.maxOutputTokens, "最大输出 Token", 1, 32768, true),
      seed: number(draft.seed, "随机种子", 0, 2147483647, true), responseModalities: draft.responseModalities === "TEXT,IMAGE" ? ["TEXT", "IMAGE"] as Array<"TEXT" | "IMAGE"> : ["IMAGE"] as Array<"TEXT" | "IMAGE">,
    } : {}),
    ...(mj ? { aspectRatio: draft.aspectRatio.trim() || undefined, negativePrompt: draft.negativePrompt.trim() || undefined, midjourneyVersion: draft.midjourneyVersion.trim() || undefined } : {}),
    timeoutMs: timeoutMs === undefined ? undefined : timeoutMs * 1000, rawParameters,
  };
}
