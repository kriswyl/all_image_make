export const DEFAULT_IMAGE_REFERENCE_LIMIT = 8;

const imageReferenceFamilies = [
  { adapter: "openai-images", max: 16, models: [
    "gpt-image-2", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare",
    "gpt-image-2.6-sunburst", "gpt-image-2.6-flare",
  ] },
  { adapter: "gemini-content", max: 14, models: [
    "gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-3-pro-image", "gemini-nano-banana-2.1",
  ] },
] as const;

/** Capacity for requests before the target model is known. */
export const MAX_IMAGE_GENERATION_REFERENCES = Math.max(
  DEFAULT_IMAGE_REFERENCE_LIMIT, ...imageReferenceFamilies.map((family) => family.max),
);

export function imageReferenceLimit(adapter?: string, model = "", operation: "reference" | "mask" = "reference") {
  if (adapter === "midjourney" || operation === "mask") return { max: 1, source: "operation" } as const;
  const id = model.trim().toLowerCase();
  const normalized = adapter === "openai-images" ? id.replace(/-c$/, "") : id.replace(/-preview$/, "");
  const family = imageReferenceFamilies.find((item) => item.adapter === adapter
    && item.models.some((name) => normalized === name || (adapter === "openai-images"
      && normalized.startsWith(name + "-") && /^\d{4}-\d{2}-\d{2}$/.test(normalized.slice(name.length + 1)))));
  if (family) return { max: family.max, source: id === normalized ? "official" : "channel-alias" } as const;
  return { max: DEFAULT_IMAGE_REFERENCE_LIMIT, source: "default" } as const;
}

export function imageReferenceCountError(adapter: string | undefined, model: string, count: number) {
  const { max, source } = imageReferenceLimit(adapter, model);
  if (count > max) {
    const scope = source === "default" ? "应用默认" : adapter === "midjourney" ? "当前 Midjourney 入口" : (model || "当前模型");
    return `${scope}最多使用 ${max} 张参考图，当前 ${count} 张`;
  }
}
