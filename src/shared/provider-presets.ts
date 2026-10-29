import type { AdapterType, AuthType, Channel, ChannelInput } from "./types.js";
import { defaultEndpointFor } from "./adapter-endpoints.js";

/**
 * 服务商预设：一个站点下若干「渠道单元」。
 * 中转站通常按模型系列分别售卖密钥，所以 gpt、gpt-c、gemini 各自是一个单元，
 * 拥有独立的环境变量与 API Key；单元与渠道一一对应。
 */
export interface ChannelUnitPreset {
  id: string;
  label: string;
  description: string;
  adapterType: AdapterType;
  authType: AuthType;
  /** 留空使用适配器默认路径 */
  endpoint?: string;
  /** 渠道名模板，{provider} 会替换为站点名 */
  channelName: string;
  /** 该单元默认的密钥环境变量名 */
  secretEnv: string;
  models: string[];
}

export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
  keyHint?: string;
  uploadEndpoint?: string;
  uploadHeaders?: Record<string, string>;
  /** 站点品牌图标（public/ 下的路径）；没有就退回通用 Server 图标 */
  logo?: string;
  units: ChannelUnitPreset[];
}

export interface UnitSelection {
  unitId: string;
  models: string[];
  secretEnv: string;
  apiKey?: string;
}

export interface ChannelDraft {
  unitId: string;
  name: string;
  input: ChannelInput;
}

const GPT_MODELS = ["gpt-image-2", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare"];
const GPT_C_MODELS = ["gpt-image-2-c", "gpt-image-2.5-sunburst-c", "gpt-image-2.5-flare-c"];
const GEMINI_MODELS = [
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-image-preview",
  "gemini-3.1-flash-lite-image",
  "gemini-3-pro-image-preview",
  "gemini-3-pro-image",
  "gemini-nano-banana-2.1",
  "gemini-nano-banana-2.1-preview",
];
const GROK_VIDEO_MODELS = ["grok-imagine-video", "grok-imagine-video-1.5-preview", "grok-imagine-video-1.5"];
const WAN_VIDEO_MODELS = ["wan3.0-video"];
const SEEDANCE_VIDEO_MODELS = ["sd-2.5", "sd-2.0", "sd-2.0-fast", "sd-2.0-mini"];
const KLING_VIDEO_MODELS = ["kling-3.0", "kling-3.0-turbo", "kling-3.0-omni"];
const SUNO_MUSIC_MODELS = ["suno_damobi_music"];
/** 你给的列表里 3.8-flash 写了两次，按手册补成 3.8-flash-lite */
const GEMINI_TTS_MODELS = [
  "gemini-3.8-flash-tts",
  "gemini-3.8-flash-lite-tts",
  "gemini-3.1-flash-tts-preview",
];
const MIDJOURNEY_MODELS = ["mj_imagine", "mj_upscale", "mj_variation", "mj_reroll"];

/**
 * 对话（大脑）模型候选。
 * 挑选标准：指令跟随稳、JSON 输出不跑偏、支持视觉（看图改要用），
 * 并且尽量避开纯推理模型——它们每次调用都有几秒的推理开销，Agent 一轮要调好几次。
 * 实测 deepseek-v4-1-flash 三项都满足，所以排在第一个。
 */
const CHAT_MODELS = [
  "deepseek-v4-1-flash",
  "deepseek-v4-pro",
  "glm-5.3",
  "qwen3.8-max",
  "grok-4.7",
  "gpt-5.6-sol",
  "claude-sonnet-5-5",
];

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "tiantoken-gpt",
    label: "词元流墟-gpt生图",
    baseUrl: "https://api.tiantoken.com",
    logo: "/logo-tiantoken.svg",
    units: [
      {
        id: "gpt",
        label: "gpt 生图",
        description: "OpenAI Images 协议，标准 gpt-image 系列",
        adapterType: "openai-images",
        authType: "bearer",
        channelName: "{provider}",
        secretEnv: "TIANTOKEN_GPT_API_KEY",
        models: GPT_MODELS,
      },
    ],
  },
  {
    id: "tiantoken-gpt-c",
    label: "词元流墟-gpt-c生图",
    baseUrl: "https://api.tiantoken.com",
    logo: "/logo-tiantoken.svg",
    units: [
      {
        id: "gpt-c",
        label: "gpt-c 生图",
        description: "OpenAI Images 协议，-c 系列独立计费与密钥",
        adapterType: "openai-images",
        authType: "bearer",
        channelName: "{provider}",
        secretEnv: "TIANTOKEN_GPT_C_API_KEY",
        models: GPT_C_MODELS,
      },
    ],
  },
  {
    id: "tiantoken-gemini",
    label: "词元流墟-gemini生图",
    baseUrl: "https://api.tiantoken.com",
    logo: "/logo-tiantoken.svg",
    units: [
      {
        id: "gemini",
        label: "gemini 生图",
        description: "Gemini Content 协议，宽高比与出图尺寸控制",
        adapterType: "gemini-content",
        authType: "bearer",
        channelName: "{provider}",
        secretEnv: "TIANTOKEN_GEMINI_API_KEY",
        models: GEMINI_MODELS,
      },
    ],
  },
  {
    id: "tiantoken-midjourney",
    label: "词元流墟-Midjourney",
    baseUrl: "https://api.tiantoken.com",
    logo: "/logo-tiantoken.svg",
    units: [
      {
        id: "midjourney",
        label: "Midjourney 生图",
        description: "mj_imagine 文生图（加参考图自动走图生图），支持 U/V/R 后续动作",
        adapterType: "midjourney",
        authType: "bearer",
        channelName: "{provider}",
        secretEnv: "TIANTOKEN_MIDJOURNEY_API_KEY",
        models: MIDJOURNEY_MODELS,
      },
    ],
  },
  {
    id: "tiantoken-wan-video",
    label: "词元流墟-万相视频",
    baseUrl: "https://api.tiantoken.com",
    uploadEndpoint: "https://imageproxy.zhongzhuan.chat/api/upload",
    uploadHeaders: { "New-Api-User": "1" },
    logo: "/logo-tiantoken.svg",
    units: [
      {
        id: "wan-video",
        label: "万相视频",
        description: "万相 3.0，七种生成方式，首尾帧与参考素材",
        adapterType: "wan-video",
        authType: "bearer",
        channelName: "{provider}",
        secretEnv: "TIANTOKEN_WAN_VIDEO_API_KEY",
        models: WAN_VIDEO_MODELS,
      },
    ],
  },
  {
    id: "tiantoken-grok-video",
    label: "词元流墟-grok视频",
    baseUrl: "https://api.tiantoken.com",
    logo: "/logo-tiantoken.svg",
    units: [
      {
        id: "grok-video",
        label: "grok 视频",
        description: "Grok Imagine，1 到 15 秒，支持参考图",
        adapterType: "grok-video",
        authType: "bearer",
        channelName: "{provider}",
        secretEnv: "TIANTOKEN_GROK_VIDEO_API_KEY",
        models: GROK_VIDEO_MODELS,
      },
    ],
  },
  {
    id: "tiantoken-seedance",
    label: "词元流墟-seedance视频",
    baseUrl: "https://api.tiantoken.com",
    logo: "/logo-tiantoken.svg",
    units: [
      {
        id: "seedance-video",
        label: "seedance 视频",
        description: "豆包 Seedance，文生/首帧/首尾帧/参考图",
        adapterType: "seedance-video",
        authType: "bearer",
        channelName: "{provider}",
        secretEnv: "TIANTOKEN_SEEDANCE_VIDEO_API_KEY",
        models: SEEDANCE_VIDEO_MODELS,
      },
    ],
  },
  {
    id: "tiantoken-kling-video",
    label: "词元流墟-可灵视频",
    baseUrl: "https://api.tiantoken.com",
    uploadEndpoint: "https://imageproxy.zhongzhuan.chat/api/upload",
    uploadHeaders: { "New-Api-User": "1" },
    logo: "/logo-tiantoken.svg",
    units: [
      {
        id: "kling-video",
        label: "可灵视频",
        description: "Kling 3.0 / Turbo / Omni，文生、首帧、首尾帧、参考图、运动控制",
        adapterType: "kling-video",
        authType: "bearer",
        channelName: "{provider}",
        secretEnv: "TIANTOKEN_KLING_VIDEO_API_KEY",
        models: KLING_VIDEO_MODELS,
      },
    ],
  },
  {
    id: "tiantoken-suno",
    label: "词元流墟-音乐",
    baseUrl: "https://api.tiantoken.com",
    logo: "/logo-tiantoken.svg",
    units: [
      {
        id: "suno-music",
        label: "Suno 音乐",
        description: "一次生成 2 首：灵感描述、自定义歌词、纯音乐",
        adapterType: "suno-music",
        authType: "bearer",
        channelName: "{provider}",
        secretEnv: "TIANTOKEN_SUNO_API_KEY",
        models: SUNO_MUSIC_MODELS,
      },
    ],
  },
  {
    id: "tiantoken-gemini-tts",
    label: "词元流墟-语音",
    baseUrl: "https://api.tiantoken.com",
    logo: "/logo-tiantoken.svg",
    units: [
      {
        id: "gemini-tts",
        label: "Gemini 语音",
        description: "配音 / 旁白：30 个预置音色，支持单人与双人对话、风格控制，输出 24kHz WAV",
        adapterType: "gemini-tts",
        authType: "bearer",
        channelName: "{provider}",
        secretEnv: "TIANTOKEN_GEMINI_TTS_API_KEY",
        models: GEMINI_TTS_MODELS,
      },
    ],
  },
  {
    id: "tiantoken-chat",
    label: "词元流墟-对话模型",
    baseUrl: "https://api.tiantoken.com",
    logo: "/logo-tiantoken.svg",
    units: [
      {
        id: "chat",
        label: "对话模型",
        description: "chat completions 协议，用作对话工作区的大脑（不出图）",
        adapterType: "openai-chat",
        authType: "bearer",
        channelName: "{provider}",
        secretEnv: "TIANTOKEN_CHAT_API_KEY",
        models: CHAT_MODELS,
      },
    ],
  },
];

export function findProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/** 适配器默认路径：和服务端共用 `adapter-endpoints.ts`，不再各写一份 */
export function adapterDefaultEndpoint(adapterType: AdapterType) {
  return { endpoint: defaultEndpointFor(adapterType) };
}

export function channelNameFor(preset: ProviderPreset, unit: ChannelUnitPreset) {
  return unit.channelName.replace("{provider}", preset.label);
}

/** 每个选中单元生成一个渠道草稿，密钥按单元独立携带 */
export function buildChannelDrafts(preset: ProviderPreset, selections: UnitSelection[]): ChannelDraft[] {
  const drafts: ChannelDraft[] = [];
  for (const selection of selections) {
    const unit = preset.units.find((item) => item.id === selection.unitId);
    if (!unit) continue;
    const models = selection.models.filter(Boolean);
    if (!models.length) continue;
    const defaults = adapterDefaultEndpoint(unit.adapterType);
    const name = channelNameFor(preset, unit);
    drafts.push({
      unitId: unit.id,
      name,
      input: {
        name,
        baseUrl: preset.baseUrl,
        adapterType: unit.adapterType,
        authType: unit.authType,
        authHeaderName: "",
        secretEnv: selection.secretEnv || unit.secretEnv,
        endpoint: unit.endpoint ?? defaults.endpoint,
        ...(preset.uploadEndpoint ? { uploadEndpoint: preset.uploadEndpoint, uploadHeaders: preset.uploadHeaders ?? {} } : {}),
        models,
        allowPrivateNetwork: false,
        enabled: true,
        ...(selection.apiKey ? { apiKey: selection.apiKey } : {}),
      },
    });
  }
  return drafts;
}

export function normalizeBaseUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url.trim().replace(/\/+$/, "");
  }
}

/**
 * 冲突检测：先按渠道名精确匹配（重复运行向导时更新自身），
 * 再按模型交集匹配。同站点同协议但模型不重叠的单元（gpt 与 gpt-c）因此不会互相误判。
 */
export function findConflictChannels(draft: ChannelDraft, channels: Channel[]): Channel[] {
  const normalized = normalizeBaseUrl(draft.input.baseUrl);
  const sameEndpoint = channels.filter((channel) =>
    normalizeBaseUrl(channel.baseUrl) === normalized && channel.adapterType === draft.input.adapterType);
  const byName = sameEndpoint.filter((channel) => channel.name === draft.name);
  if (byName.length) return byName;
  return sameEndpoint.filter((channel) => channel.models.some((model) => draft.input.models.includes(model)));
}

