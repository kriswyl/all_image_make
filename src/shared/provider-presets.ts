import type { AdapterType, AuthType, Channel, ChannelInput } from "./types.js";
import { VECTORENGINE_KEY_ENV, VECTORENGINE_KEY_PLACEHOLDER } from "./app-config.js";

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
];

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "vectorengine",
    label: "向量引擎",
    baseUrl: "https://api.vectorengine.cn",
    keyHint: VECTORENGINE_KEY_PLACEHOLDER,
    units: [
      {
        id: "gpt",
        label: "gpt 生图",
        description: "OpenAI Images 协议，标准 gpt-image 系列",
        adapterType: "openai-images",
        authType: "bearer",
        channelName: "{provider}-gpt",
        secretEnv: VECTORENGINE_KEY_ENV,
        models: GPT_MODELS,
      },
      {
        id: "gpt-c",
        label: "gpt-c 生图",
        description: "OpenAI Images 协议，-c 系列独立计费与密钥",
        adapterType: "openai-images",
        authType: "bearer",
        channelName: "{provider}-gpt-c",
        secretEnv: "VECTORENGINE_GPT_C_API_KEY",
        models: GPT_C_MODELS,
      },
      {
        id: "gemini",
        label: "gemini 生图",
        description: "Gemini Content 协议，宽高比与出图尺寸控制",
        adapterType: "gemini-content",
        authType: "bearer",
        channelName: "{provider}-gemini",
        secretEnv: "VECTORENGINE_GEMINI_API_KEY",
        models: GEMINI_MODELS,
      },
    ],
  },
  {
    id: "tiantoken",
    label: "词元流墟",
    baseUrl: "https://api.tiantoken.com",
    units: [
      {
        id: "gpt",
        label: "gpt 生图",
        description: "OpenAI Images 协议，标准 gpt-image 系列",
        adapterType: "openai-images",
        authType: "bearer",
        channelName: "{provider}-gpt",
        secretEnv: "TIANTOKEN_GPT_API_KEY",
        models: GPT_MODELS,
      },
      {
        id: "gpt-c",
        label: "gpt-c 生图",
        description: "OpenAI Images 协议，-c 系列独立计费与密钥",
        adapterType: "openai-images",
        authType: "bearer",
        channelName: "{provider}-gpt-c",
        secretEnv: "TIANTOKEN_GPT_C_API_KEY",
        models: GPT_C_MODELS,
      },
      {
        id: "gemini",
        label: "gemini 生图",
        description: "Gemini Content 协议，宽高比与出图尺寸控制",
        adapterType: "gemini-content",
        authType: "bearer",
        channelName: "{provider}-gemini",
        secretEnv: "TIANTOKEN_GEMINI_API_KEY",
        models: GEMINI_MODELS,
      },
    ],
  },
];

export function findProviderPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

/** 适配器默认路径，与服务端 adapters.ts 的 defaultEndpoint 保持一致 */
export function adapterDefaultEndpoint(adapterType: AdapterType) {
  switch (adapterType) {
    case "openai-images": return { endpoint: "/v1/images/generations" };
    case "openai-chat-image": return { endpoint: "/v1/chat/completions" };
    case "gemini-content": return { endpoint: "/v1beta/models/{model}:generateContent" };
    default: return { endpoint: "/v1/images/generations" };
  }
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

