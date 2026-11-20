/**
 * OpenAI Images 渠道的常用尺寸预设。
 *
 * 工作台（生成页）和无限画布检查器共用这一份，避免两边列表慢慢漂移。
 * 只是「建议值」：上游实际接受哪些尺寸取决于模型和渠道，所以两边都允许手填。
 */
export const OPENAI_SIZE_GROUPS = [
  { label: "方形", sizes: ["1024x1024", "2048x2048"] },
  { label: "横向", sizes: ["1280x720", "1536x1024", "1600x1200", "2048x1152", "3840x2160"] },
  { label: "纵向", sizes: ["720x1280", "1024x1536", "1200x1600", "1152x2048", "2160x3840"] },
] as const;

/** 拍平后的预设，给 `<datalist>` 这种不支持分组的地方用 */
export const OPENAI_SIZE_PRESETS: readonly string[] = OPENAI_SIZE_GROUPS.flatMap((group) => [...group.sizes]);
import { CHANNEL_FIELD_SUPPORT, isGptImage2Model } from "./channel-fields.js";
import type { AdapterType } from "./types.js";
import { SEEDREAM_ADAPTER, seedreamSize } from "./seedream.js";


const GPT_IMAGE_RATIOS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "9:21"]);

interface ImageDimensions {
  size?: string;
  aspectRatio?: string;
  imageSize?: string;
}

/** Convert the Agent's generic image fields once the target model is resolved. */
export function normalizeAgentImageDimensions(adapter: AdapterType, model: string, dimensions: ImageDimensions): ImageDimensions {
  if (adapter === SEEDREAM_ADAPTER) return { size: seedreamSize(dimensions) };
  if (!CHANNEL_FIELD_SUPPORT[adapter]?.size || !isGptImage2Model(model) || dimensions.size
    || (!dimensions.aspectRatio && !dimensions.imageSize)) return dimensions;
  const ratio = dimensions.aspectRatio?.replace(/\s/g, "") || "1:1";
  if (!GPT_IMAGE_RATIOS.has(ratio)) return dimensions;
  const reduced = ratio === "21:9" ? "7:3" : ratio === "9:21" ? "3:7" : ratio;
  const [width, height] = reduced.split(":").map(Number) as [number, number];
  const longEdge = dimensions.imageSize === "4K" ? 3840 : dimensions.imageSize === "2K" ? 2048
    : dimensions.imageSize === "1K" || ratio === "1:1" ? 1024 : 1536;
  const factor = Math.floor(longEdge / (Math.max(width, height) * 16)) * 16;
  return { size: `${width * factor}x${height * factor}` };
}
