/**
 * 风格模板（风格锚点）。
 *
 * 分镜和画布上每一镜的提示词都各写一遍风格，结果就是每镜都在重复同一串形容词
 * （「写实电影感、浅景深、安静治愈」），既单调又浪费字数。这里把「风格」抽成一份
 * 可复用的模板：镜头只写主体和构图，风格由模板统一拼在后面。
 *
 * 模板分内置和自定义两种；内置的不能删也不能改，自定义的随便改——
 * 内置那几条是按常见成片风格调过的，用户改坏了没有恢复入口就会很难受。
 */
export interface StylePreset {
  id: string;
  name: string;
  /** 一句话说明这个风格适合什么片 */
  description: string;
  /** 拼到每条提示词末尾的风格描述 */
  prompt: string;
  /** 负面词，选填；拼在提示词后面作为「不要出现」的约束 */
  negative: string;
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

export type StylePresetInput = Pick<StylePreset, "name" | "description" | "prompt" | "negative">;

export interface BuiltinStylePreset extends Omit<StylePreset, "builtin" | "createdAt" | "updatedAt"> {}

export const BUILTIN_STYLE_PRESETS: BuiltinStylePreset[] = [
  {
    id: "builtin-cinematic",
    name: "写实电影感",
    description: "剧情片、广告片常用；真实可信，光影克制",
    prompt: "35mm 电影镜头，浅景深，柔和侧逆光，低饱和冷调，细腻胶片颗粒，写实质感",
    negative: "文字、水印、塑料感、过度磨皮",
  },
  {
    id: "builtin-japanese",
    name: "日系清新",
    description: "生活流、治愈系短片",
    prompt: "自然光漫射，低对比清透色调，米白与青绿为主，轻微过曝，干净通透的生活感",
    negative: "文字、水印、浓重阴影、高饱和",
  },
  {
    id: "builtin-neon",
    name: "赛博霓虹",
    description: "夜戏、科幻、潮流广告",
    prompt: "夜景霓虹光源，青紫与洋红对比光，湿润地面反光，雨雾体积光，高对比暗调",
    negative: "文字、水印、日光、灰蒙蒙",
  },
  {
    id: "builtin-ink",
    name: "国风水墨",
    description: "古装、东方美学、意境片",
    prompt: "水墨渲染质感，大量留白，淡墨晕染，宣纸纹理，低饱和青灰",
    negative: "文字、水印、油画笔触、高饱和彩色",
  },
  {
    id: "builtin-pixar",
    name: "3D 卡通",
    description: "亲子、动画短片、轻喜剧",
    prompt: "3D 卡通渲染，圆润造型，柔和全局光，明快配色，细腻次表面散射",
    negative: "文字、水印、写实皮肤纹理、暗黑氛围",
  },
  {
    id: "builtin-bw",
    name: "黑白纪实",
    description: "纪录片、人物采访、严肃题材",
    prompt: "黑白摄影，高反差硬光，深阴影，明显颗粒感，纪实抓拍构图",
    negative: "文字、水印、彩色、柔光美颜",
  },
];

/** 正文末尾统一的收尾标点，避免拼完出现「。。。，」这种 */
function trimTail(text: string) {
  return text.trim().replace(/[，,。；;、\s]+$/, "");
}

/** 一条提示词去掉某段风格后缀（换风格时先剥掉旧的） */
export function stripStyleSuffix(prompt: string, suffix?: string) {
  const text = prompt.trim();
  const tail = trimTail(suffix ?? "");
  if (!tail) return text;
  const index = text.lastIndexOf(tail);
  if (index < 0) return text;
  return trimTail(text.slice(0, index));
}

/**
 * 把风格模板拼到提示词末尾。
 *
 * 先剥掉上一次拼进去的那段（调用方传进 previousSuffix），再拼新的——
 * 换风格时不会越拼越长，也不会残留两套互相打架的光影描述。
 */
export function applyStyleSuffix(prompt: string, preset: Pick<StylePreset, "prompt">, previousSuffix?: string) {
  const base = stripStyleSuffix(prompt, previousSuffix);
  const suffix = trimTail(preset.prompt);
  if (!suffix) return base;
  if (!base) return suffix;
  return `${base}，${suffix}`;
}

/** 负面词合并：模板里的负面词并到调用方已有的负面词后面 */
export function mergeStyleNegative(negative: string | undefined, preset: Pick<StylePreset, "negative">) {
  const parts = [negative ?? "", preset.negative].map((item) => item.trim()).filter(Boolean);
  return [...new Set(parts.join("，").split(/[，,]/).map((item) => item.trim()).filter(Boolean))].join("，");
}
