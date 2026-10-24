/**
 * 模型厂商的官方标识。
 *
 * 图标取自 `@lobehub/icons-static-svg`（各家的官方 mark），按需打包：只 import 用到的那几个，
 * 其余 900 多个不会进产物。用 `?url` 当图片引用而不是内联 SVG——这些 mark 大多是多色的，
 * 当图片用最省事，也不必为每个维护一遍 path 数据。
 *
 * 认不出厂商就返回 null：**宁可不显示，也不要挂一个错的牌子**——
 * 中转站的模型名五花八门，猜错了比留空更误导。
 */
import baichuanLogo from "@lobehub/icons-static-svg/icons/baichuan-color.svg?url";
import bytedanceLogo from "@lobehub/icons-static-svg/icons/bytedance-color.svg?url";
import chatglmLogo from "@lobehub/icons-static-svg/icons/chatglm-color.svg?url";
import claudeLogo from "@lobehub/icons-static-svg/icons/claude-color.svg?url";
import deepseekLogo from "@lobehub/icons-static-svg/icons/deepseek-color.svg?url";
import doubaoLogo from "@lobehub/icons-static-svg/icons/doubao-color.svg?url";
import fluxLogo from "@lobehub/icons-static-svg/icons/flux.svg?url";
import geminiLogo from "@lobehub/icons-static-svg/icons/gemini-color.svg?url";
import grokLogo from "@lobehub/icons-static-svg/icons/grok.svg?url";
import hunyuanLogo from "@lobehub/icons-static-svg/icons/hunyuan-color.svg?url";
import kimiLogo from "@lobehub/icons-static-svg/icons/kimi-color.svg?url";
import klingLogo from "@lobehub/icons-static-svg/icons/kling-color.svg?url";
import midjourneyLogo from "@lobehub/icons-static-svg/icons/midjourney.svg?url";
import minimaxLogo from "@lobehub/icons-static-svg/icons/minimax-color.svg?url";
import openaiLogo from "@lobehub/icons-static-svg/icons/openai.svg?url";
import qwenLogo from "@lobehub/icons-static-svg/icons/qwen-color.svg?url";
import stabilityLogo from "@lobehub/icons-static-svg/icons/stability-color.svg?url";
import stepfunLogo from "@lobehub/icons-static-svg/icons/stepfun-color.svg?url";
import sunoLogo from "@lobehub/icons-static-svg/icons/suno.svg?url";

/** 图片 / 视频 / 音乐 / 对话——同一个模型名在不同类目下可能不是一家（`sd-*` 视频里是 Seedance） */
export type ModelKind = import("../../shared/types").ChannelKind;

interface Brand {
  test: RegExp;
  /** 只在某一类目下才算这个牌子（`sd-*` 在视频里是 Seedance，在图片里才是 Stable Diffusion） */
  kind?: ModelKind;
  logo: string;
  name: string;
}

const BRANDS: Brand[] = [
  // 对话模型（大脑）：用户在下拉里一眼认出是哪家，比认字快
  { test: /deepseek/i, kind: "chat", logo: deepseekLogo, name: "DeepSeek" },
  { test: /glm|chatglm|zhipu|智谱/i, kind: "chat", logo: chatglmLogo, name: "智谱 GLM" },
  { test: /claude|anthropic|sonnet|opus|haiku/i, kind: "chat", logo: claudeLogo, name: "Anthropic Claude" },
  { test: /kimi|moonshot/i, kind: "chat", logo: kimiLogo, name: "Moonshot Kimi" },
  { test: /minimax|abab/i, kind: "chat", logo: minimaxLogo, name: "MiniMax" },
  { test: /step[-_]?\d|stepfun|阶跃/i, kind: "chat", logo: stepfunLogo, name: "阶跃星辰" },
  { test: /hunyuan|混元/i, kind: "chat", logo: hunyuanLogo, name: "腾讯混元" },
  { test: /baichuan|百川/i, kind: "chat", logo: baichuanLogo, name: "百川智能" },
  { test: /doubao|豆包/i, kind: "chat", logo: doubaoLogo, name: "豆包" },
  { test: /qwen|qwq|通义/i, kind: "chat", logo: qwenLogo, name: "通义千问" },
  { test: /gpt|chatgpt|^o[134](-|$)/i, kind: "chat", logo: openaiLogo, name: "OpenAI" },
  { test: /gemini/i, kind: "chat", logo: geminiLogo, name: "Google Gemini" },
  { test: /grok/i, kind: "chat", logo: grokLogo, name: "xAI Grok" },

  // 生成类
  { test: /gpt-image|dall-?e|gpt-4o-image|sora/i, logo: openaiLogo, name: "OpenAI" },
  { test: /gemini|imagen|nano-?banana/i, logo: geminiLogo, name: "Google Gemini" },
  { test: /grok/i, logo: grokLogo, name: "xAI Grok" },
  { test: /wan|qwen|通义|万相/i, logo: qwenLogo, name: "通义万相" },
  { test: /seedance|doubao|豆包/i, logo: bytedanceLogo, name: "字节 Seedance" },
  { test: /kling|可灵/i, logo: klingLogo, name: "快手可灵" },
  { test: /(^|[^a-z])sd[-_.\d]/i, kind: "video", logo: bytedanceLogo, name: "字节 Seedance" },
  { test: /flux/i, logo: fluxLogo, name: "Black Forest Labs FLUX" },
  { test: /midjourney|(^|[^a-z])mj([^a-z]|$)/i, logo: midjourneyLogo, name: "Midjourney" },
  { test: /stable-?diffusion|stability|sd-xl/i, logo: stabilityLogo, name: "Stability AI" },
  // 音乐渠道：模型名通常是 `suno_damobi_music` / `suno_music`
  { test: /suno/i, kind: "audio", logo: sunoLogo, name: "Suno" },
];

/** 模型 ID → 厂商。认不出返回 null */
export function modelBrand(model: string, kind: ModelKind) {
  for (const brand of BRANDS) {
    if (brand.kind && brand.kind !== kind) continue;
    if (brand.test.test(model)) return brand;
  }
  return null;
}

/**
 * 这些厂商的 mark 是单色的（`fill="currentColor"`，作为 img 引用时解析成黑色）。
 * 深色主题下要反色才看得见，所以单独标出来；彩色图标不能跟着反，否则会变成负片。
 */
const MONO_LOGO_FILES = new Set([openaiLogo, fluxLogo, grokLogo, midjourneyLogo, sunoLogo]);

export function ModelLogo({ model, kind, size = 20 }: { model: string; kind: ModelKind; size?: number }) {
  const brand = modelBrand(model, kind);
  if (!brand) return null;
  return (
    <img
      className={`model-logo ${MONO_LOGO_FILES.has(brand.logo) ? "is-mono" : ""}`}
      src={brand.logo}
      alt=""
      title={brand.name}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
    />
  );
}
