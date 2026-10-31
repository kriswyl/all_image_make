/**
 * 渠道字段矩阵：每个渠道到底认哪些生成参数、以什么形式承载。
 *
 * 设置面板能填的字段比渠道能接的多得多——Gemini 不吃负面提示词、可灵不认识
 * `ratio`、Midjourney 的画幅要写进提示词（`--ar`）。以前这些差异散落在
 * `adapters.ts` 的各个分支里，用户填了没生效也看不出来；这里把它们集中成一张表，
 * 生成前就能告诉用户「这几个参数会被忽略」。
 *
 * `carrier` 的含义：
 * - `param`：作为请求体里的独立字段发出去；
 * - `prompt`：拼进提示词文本（MJ 的 `--ar` / `--no`）；
 * - 表里没有的字段 = 该渠道不支持。
 */
import type { AdapterType } from "./types.js";

export type GenerationField =
  | "negativePrompt" | "aspectRatio" | "ratio" | "duration" | "resolution" | "audio"
  | "seed" | "watermark" | "promptExtend"
  | "size" | "imageSize" | "quality" | "style" | "background" | "outputFormat" | "moderation"
  | "count";

export type FieldCarrier = "param" | "prompt";

export const FIELD_LABELS: Record<GenerationField, string> = {
  negativePrompt: "负面提示词",
  aspectRatio: "画幅比例",
  ratio: "画幅比例",
  duration: "时长",
  resolution: "分辨率",
  audio: "生成音频",
  seed: "随机种子",
  watermark: "水印",
  promptExtend: "提示词扩写",
  size: "尺寸",
  imageSize: "输出尺寸",
  quality: "质量",
  style: "风格",
  background: "背景",
  outputFormat: "输出格式",
  moderation: "审核级别",
  count: "生成数量",
};

export const CHANNEL_FIELD_SUPPORT: Partial<Record<AdapterType, Partial<Record<GenerationField, FieldCarrier>>>> = {
  "openai-images": {
    size: "param", quality: "param", style: "param", background: "param",
    outputFormat: "param", moderation: "param", negativePrompt: "param", count: "param",
  },
  "openai-chat-image": {
    size: "param", quality: "param", style: "param", background: "param",
    outputFormat: "param", moderation: "param", negativePrompt: "param", count: "param",
  },
  "generic-json": {
    size: "param", quality: "param", style: "param", background: "param",
    outputFormat: "param", moderation: "param", negativePrompt: "param", count: "param",
  },
  // Gemini 只认 imageSize 和宽高比，没有负面词字段
  "gemini-content": { imageSize: "param", aspectRatio: "param" },
  // MJ 的画幅和排除内容都写在提示词里
  midjourney: { aspectRatio: "prompt", negativePrompt: "prompt" },
  "wan-video": {
    ratio: "param", duration: "param", resolution: "param",
    audio: "param", seed: "param", watermark: "param", promptExtend: "param",
  },
  "seedance-video": {
    ratio: "param", duration: "param", resolution: "param",
    audio: "param", seed: "param", watermark: "param",
  },
  "kling-video": { aspectRatio: "param", duration: "param", resolution: "param", audio: "param", watermark: "param" },
  "grok-video": { aspectRatio: "param", duration: "param", resolution: "param" },
};

/** 画幅在渠道里可能叫 aspectRatio（16:9）也可能叫 ratio（万相/Seedance 的原生写法） */
const ASPECT_FIELDS: GenerationField[] = ["aspectRatio", "ratio"];

function cleanRatio(value?: string) {
  const text = value?.trim().replace(/：/g, ":").replace(/\s+/g, "");
  return !text || text === "auto" ? undefined : text;
}

/**
 * 把画幅统一成目标渠道认的那一个字段。
 *
 * 用户在画布上填的是「画幅比例」这一个概念，渠道却分成两派：万相 / Seedance 认
 * `ratio`，可灵 / Grok / Gemini / MJ 认 `aspectRatio`。以前填错一边就等于没填，
 * 现在直接转过去——只有两派都认不了的取值（比如可灵收到 `adaptive`）才会被丢掉。
 */
export function normalizeAspectFields(
  adapterType: AdapterType,
  values: { aspectRatio?: string; ratio?: string },
): { aspectRatio?: string; ratio?: string } {
  const support = CHANNEL_FIELD_SUPPORT[adapterType] ?? {};
  const aspectRatio = cleanRatio(values.aspectRatio);
  const ratio = cleanRatio(values.ratio);
  const wantsRatio = support.ratio !== undefined && support.aspectRatio === undefined;
  const wantsAspect = support.aspectRatio !== undefined && support.ratio === undefined;

  if (wantsRatio && !ratio && aspectRatio) return { aspectRatio, ratio: aspectRatio };
  if (wantsAspect && !aspectRatio && ratio) {
    // adaptive 是万相 / Seedance 的「自适应」，可灵这类没有这个档位，交给渠道默认
    return { aspectRatio: ratio === "adaptive" ? undefined : ratio, ratio };
  }
  return { aspectRatio, ratio };
}

/** 未显式设置的值不算「会被忽略」：空串、undefined、false 都不提示 */
function meaningful(value: unknown) {
  return value !== undefined && value !== null && value !== "" && value !== false;
}

/**
 * 列出这次生成里「设了但当前渠道不认」的字段。
 *
 * `promptExtend` 默认就是 true，几乎每个视频节点都带着它；扩写本身是软行为，
 * 每次都提示只会变成噪音，所以默认不报（需要时传 includeSoft）。
 */
export function unsupportedFields(
  adapterType: AdapterType,
  values: Partial<Record<GenerationField, unknown>>,
  options: { includeSoft?: boolean } = {},
): Array<{ field: GenerationField; label: string }> {
  const support = CHANNEL_FIELD_SUPPORT[adapterType];
  if (!support) return [];
  // 画幅两个字段能互转，只要渠道认其中一种就不算被忽略
  const supportsAspect = ASPECT_FIELDS.some((field) => support[field] !== undefined);
  return (Object.keys(FIELD_LABELS) as GenerationField[])
    .filter((field) => supportsAspect && ASPECT_FIELDS.includes(field) ? false : support[field] === undefined)
    .filter((field) => options.includeSoft || field !== "promptExtend")
    .filter((field) => meaningful(values[field]))
    .map((field) => ({ field, label: FIELD_LABELS[field] }));
}

/** 同一类参数的中文名可能重复（aspectRatio / ratio 都叫画幅比例），去重后给提示用 */
export function unsupportedLabels(
  adapterType: AdapterType,
  values: Partial<Record<GenerationField, unknown>>,
  options: { includeSoft?: boolean } = {},
) {
  return [...new Set(unsupportedFields(adapterType, values, options).map((item) => item.label))];
}
