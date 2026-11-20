import type { AdapterType, AuthType, Channel, ChannelInput } from "./types.js";
import { defaultEndpointFor } from "./adapter-endpoints.js";
import { SUNO_DAMOBI_MODEL } from "./suno.js";
import { SEEDREAM_ADAPTER, SEEDREAM_MODELS } from "./seedream.js";

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
  /**
   * 这个单元自己的图床。中转站按模型系列分开配置时（视频站一套、生图站一套），
   * 合并成「一 key 全开」之后仍然各走各的图床，所以图床要能跟着单元走。
   * 缺省时回落到站点级 `uploadEndpoint`。
   */
  uploadEndpoint?: string;
  uploadHeaders?: Record<string, string>;
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
  /**
   * 一 key 模式：整站只填一个密钥，下面所有单元共用它。
   *
   * 中转站真正的形态是「一个账号一个密钥、全模型通用」，按单元分别要密钥只是
   * 「同一个站卖好几张卡」的特例。向导见到这个标记时只渲染一个输入框。
   */
  singleKey?: boolean;
  /** 一 key 模式下所有渠道共用的环境变量名（也解释成「同一条兜底密钥」） */
  sharedSecretEnv?: string;
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

const GPT_MODELS = ["gpt-image-2", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2.6-flare", "gpt-image-2.6-sunburst"];
const GPT_C_MODELS = ["gpt-image-2-c", "gpt-image-2.5-sunburst-c", "gpt-image-2.5-flare-c", "gpt-image-2.6-flare-c", "gpt-image-2.6-sunburst-c"];
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
const SUNO_MUSIC_MODELS = [SUNO_DAMOBI_MODEL];
/** 你给的列表里 3.8-flash 写了两次，按手册补成 3.8-flash-lite */
const GEMINI_TTS_MODELS = [
  "gemini-3.8-flash-tts",
  "gemini-3.8-flash-lite-tts",
  "gemini-3.1-flash-tts-preview",
];
const MIDJOURNEY_MODELS = ["mj_imagine", "mj_upscale", "mj_variation", "mj_reroll"];

/** 对话模型模板：实际可用性以渠道和所填密钥为准。 */
const CHAT_MODELS = [
  "deepseek-v4.1-flash-1017",
  "gemini-3.8-flash",
  "gpt-6.1-sol",
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
    id: "tiantoken-seedream",
    label: "词元流墟-豆包生图",
    baseUrl: "https://api.tiantoken.com",
    logo: "/logo-tiantoken.svg",
    units: [{
      id: "seedream",
      label: "豆包 Seedream 生图",
      description: "Seedream 5.5 / 5.0 Pro，支持多参考图",
      adapterType: SEEDREAM_ADAPTER,
      authType: "bearer",
      channelName: "{provider}",
      secretEnv: "TIANTOKEN_SEEDREAM_API_KEY",
      models: [...SEEDREAM_MODELS],
    }],
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
    // Seedance 的参考视频 / 参考音频与万相、可灵走同一座图床：
    // 本地文件提交时先传这里换公网地址，再进 Seedance 的 video_url / audio_url。
    uploadEndpoint: "https://imageproxy.zhongzhuan.chat/api/upload",
    uploadHeaders: { "New-Api-User": "1" },
    logo: "/logo-tiantoken.svg",
    units: [
      {
        id: "seedance-video",
        label: "seedance 视频",
        description: "豆包 Seedance，文生/首帧/首尾帧/参考图，参考模式支持视频与音频素材",
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
    id: "tiantoken-minimax-video",
    label: "词元流墟-MiniMax视频",
    baseUrl: "https://api.tiantoken.com",
    uploadEndpoint: "https://imageproxy.zhongzhuan.chat/api/upload",
    uploadHeaders: { "New-Api-User": "1" },
    logo: "/logo-tiantoken.svg",
    units: [
      {
        id: "minimax-video",
        label: "MiniMax 视频",
        description: "MiniMax H3，支持文生、首帧、首尾帧及图片、视频和音频参考",
        adapterType: "minimax-video",
        authType: "bearer",
        channelName: "{provider}",
        secretEnv: "TIANTOKEN_MINIMAX_VIDEO_API_KEY",
        models: ["MiniMax-H3"],
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
        description: "Suno v6 创作、翻唱、混音、音效，通常返回 2 个成品",
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
  if (id === ONE_KEY_PRESET.id) return ONE_KEY_PRESET;
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/** 一 key 模式下拉通全部模型的站点与密钥名 */
export const ONE_KEY_PRESET_ID = "tiantoken-onekey";
export const ONE_KEY_SECRET_ENV = "TIANTOKEN_API_KEY";

/**
 * 「一 Key 全开」：把上面对外售卖的各个模型组合并成一份配置。
 *
 * 中转站的实际形态是「一个账号一个密钥、所有模型通用」，按单元分别要密钥只是少数
 * 「同一个站卖好几张卡」的特例。这里把 12 个单元收进一个预设，向导只让填一次 Key，
 * 之后每类模型各建一个渠道（协议不同，渠道不能合）。
 *
 * 刻意**不**放进 `PROVIDER_PRESETS`：
 * ① 站点卡片是按单元分组的，塞进去会在每一组里各出现一次；
 * ② `MODEL_GROUPS` 由 `PROVIDER_PRESETS` 派生，放进去会让引导里的模型气泡全部翻倍。
 */
export const ONE_KEY_PRESET: ProviderPreset = {
  id: ONE_KEY_PRESET_ID,
  label: "词元流墟 · 一 Key 全开",
  baseUrl: "https://api.tiantoken.com",
  keyHint: "粘贴你的词元流墟 API Key（全模型通用）",
  logo: "/logo-tiantoken.svg",
  singleKey: true,
  sharedSecretEnv: ONE_KEY_SECRET_ENV,
  units: PROVIDER_PRESETS.flatMap((preset) => preset.units.map((unit) => ({
    ...unit,
    // 名字要能一眼认出是哪一类模型，否则列表里 12 行全叫「词元流墟」
    channelName: `词元流墟 · ${unit.label}`,
    secretEnv: ONE_KEY_SECRET_ENV,
    ...(preset.uploadEndpoint ? { uploadEndpoint: preset.uploadEndpoint } : {}),
    ...(preset.uploadHeaders ? { uploadHeaders: preset.uploadHeaders } : {}),
  }))),
};

/** 一 key 模式：同一把密钥铺给选中的每个单元 */
export function buildOneKeyDrafts(apiKey: string, unitIds?: readonly string[]): ChannelDraft[] {
  const wanted = unitIds ? new Set(unitIds) : null;
  return buildChannelDrafts(ONE_KEY_PRESET, ONE_KEY_PRESET.units
    .filter((unit) => !wanted || wanted.has(unit.id))
    .map((unit) => ({
      unitId: unit.id,
      models: [...unit.models],
      secretEnv: ONE_KEY_SECRET_ENV,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    })));
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
    const uploadEndpoint = unit.uploadEndpoint ?? preset.uploadEndpoint;
    const uploadHeaders = unit.uploadHeaders ?? preset.uploadHeaders;
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
        ...(uploadEndpoint ? { uploadEndpoint, uploadHeaders: uploadHeaders ?? {} } : {}),
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
 * 优先匹配同名渠道，同名的多个渠道优先选择站点与协议一致的；
 * 没有同名时，再按同站点同协议的模型交集匹配。
 */
export function findConflictChannels(draft: ChannelDraft, channels: Channel[]): Channel[] {
  const normalized = normalizeBaseUrl(draft.input.baseUrl);
  const sameEndpoint = channels.filter((channel) =>
    normalizeBaseUrl(channel.baseUrl) === normalized && channel.adapterType === draft.input.adapterType);
  const byName = channels.filter((channel) => channel.name.trim() === draft.name.trim());
  if (byName.length) return [...byName].sort((a, b) => Number(sameEndpoint.includes(b)) - Number(sameEndpoint.includes(a)));
  return sameEndpoint.filter((channel) => channel.models.some((model) => draft.input.models.includes(model)));
}

