export const SEEDREAM_ADAPTER = "seedream-image";
export const SEEDREAM_MODELS = ["doubao-seedream-5-5", "doubao-seedream-5-0-pro-260628"] as const;
const modelLabels: Readonly<Record<string, string>> = {
  [SEEDREAM_MODELS[0]]: "豆包 Seedream 5.5",
  "doubao-seedream-5-5-261028": "豆包 Seedream 5.5",
  [SEEDREAM_MODELS[1]]: "豆包 Seedream 5.0 Pro",
};
export function seedreamModelLabel(model: string): string | undefined {
  return Object.hasOwn(modelLabels, model) ? modelLabels[model] : undefined;
}
export const SEEDREAM_REFERENCE_LIMIT = 10;
export const SEEDREAM_SIZES = ["1K", "1.5K", "2K"] as const;
export const SEEDREAM_DEFAULT_SIZE = "2K";
export const SEEDREAM_DEFAULT_WATERMARK = false;
export const SEEDREAM_MIN_PIXELS = 921600;
export const SEEDREAM_MAX_PIXELS = 4624220;

const pixelsByRatio = {
  "1:1": ["1024x1024", "1536x1536", "2048x2048"],
  "4:3": ["1152x864", "1792x1344", "2368x1776"],
  "3:4": ["864x1152", "1344x1792", "1776x2368"],
  "16:9": ["1424x800", "2048x1152", "2816x1584"],
  "9:16": ["800x1424", "1152x2048", "1584x2816"],
  "3:2": ["1248x832", "1872x1248", "2496x1664"],
  "2:3": ["832x1248", "1248x1872", "1664x2496"],
  "21:9": ["1568x672", "2352x1008", "3136x1344"],
} as const;
type SeedreamRatio = keyof typeof pixelsByRatio;
export const SEEDREAM_RATIOS = Object.keys(pixelsByRatio) as SeedreamRatio[];
export const SEEDREAM_SIZE_HINT = "自定义尺寸总像素须为 921,600–4,624,220，宽高比须在 1:16–16:1 之间";

export function seedreamSize(values: { size?: string; imageSize?: string; aspectRatio?: string }): string {
  const explicit = values.size?.trim().toUpperCase().replace(/\s/g, "").replace(/×/g, "X");
  if (explicit && explicit !== "AUTO" && !SEEDREAM_SIZES.some(value => value === explicit)) {
    const match = /^(\d+)X(\d+)$/.exec(explicit);
    if (!match) throw new Error("豆包生图尺寸请填写宽×高，或选择 1K、1.5K、2K");
    const width = Number(match[1]);
    const height = Number(match[2]);
    const area = width * height;
    if (!Number.isSafeInteger(area) || area < SEEDREAM_MIN_PIXELS || area > SEEDREAM_MAX_PIXELS || width > height * 16 || height > width * 16) {
      throw new Error(SEEDREAM_SIZE_HINT);
    }
    return `${width}x${height}`;
  }
  const requested = explicit && explicit !== "AUTO" ? explicit : values.imageSize?.trim().toUpperCase();
  const tier = !requested || requested === "AUTO" ? SEEDREAM_DEFAULT_SIZE : requested;
  const index = SEEDREAM_SIZES.findIndex(value => value === tier);
  if (index < 0) throw new Error("豆包生图支持 1K、1.5K、2K 清晰度");
  const ratio = values.aspectRatio?.trim().toLowerCase().replace(/\s/g, "").replace(/：/g, ":");
  if (!ratio || ratio === "auto" || ratio === "adaptive") return tier;
  if (!Object.hasOwn(pixelsByRatio, ratio)) throw new Error("请使用豆包生图提供的画幅比例，其他比例可填写自定义宽×高");
  return pixelsByRatio[ratio as SeedreamRatio][index]!;
}

export interface SeedreamTaskMeta {
  returnedModel?: string;
  requestedReferences: number;
  acceptedReferences?: number;
  generatedImages?: number;
  outputTokens?: number;
  warning?: string;
}
