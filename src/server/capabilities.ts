/**
 * 能力清单与别名解析（AGENT_PLAN.md §6）。
 *
 * 大脑**只能**填 alias，真实 channelId 和模型 ID 由这里解析。
 * 让 LLM 直接输出 `channelId` 它一定会编——中转站的模型 ID 五花八门
 * （`gpt-image-2`、`wan3.0-video`），模型没有理由记得住。
 *
 * 这份清单会进系统提示词，所以它**绝不能**包含 baseUrl、密钥、channelId。
 * `tests/agent.test.ts` 里有一条会失败的断言守着这件事。
 */
import type { AdapterType } from "../shared/types.js";
import { isChatAdapter, isVideoAdapter } from "../shared/types.js";
import type { DbChannel } from "./db.js";

export type CapabilityKind = "image" | "video";

export interface CapabilityAlias {
  /** 大脑看到的唯一标识，例如 `gemini`、`wan`、`gpt-image-2` */
  alias: string;
  kind: CapabilityKind;
  /** 解析目标。只在服务端流转，不会出现在喂给大脑的文本里 */
  channelId: string;
  channelName: string;
  model: string;
  adapterType: AdapterType;
  /** 一行能力摘要 */
  traits: string;
}

/**
 * 模型 ID → 语义前缀。顺序有意义：先匹配到的赢，
 * 所以 `gpt-image` 排在更通用的规则前面。
 *
 * `kind` 用来消歧：同一个写法在不同类目下指的不是一个东西——视频渠道里
 * `sd-2.5` 是 Seedance，图片渠道里 `sd-xl` 才是 Stable Diffusion。
 * 带上 kind 才不会把前者的别名起成 `sd`（那会误导大脑去选错误的模型）。
 */
const ALIAS_PREFIXES: Array<{ pattern: RegExp; alias: string; kind?: CapabilityKind }> = [
  { pattern: /seedance/i, alias: "seedance" },
  // 视频类目下的 sd-* 一律视为 Seedance（实测中转站就是拿 sd-2.5 指 Seedance）
  { pattern: /(^|[^a-z])sd[-_.\d]/i, alias: "seedance", kind: "video" },
  { pattern: /gemini|imagen|nano-?banana/i, alias: "gemini" },
  { pattern: /grok/i, alias: "grok" },
  { pattern: /wan|万相|通义/i, alias: "wan" },
  { pattern: /gpt-image|dall-?e|gpt-4o-image/i, alias: "gpt-image" },
  { pattern: /flux/i, alias: "flux" },
  { pattern: /midjourney|(^|[^a-z])mj([^a-z]|$)/i, alias: "mj" },
  { pattern: /stable-?diffusion|(^|[^a-z])sd[-_.\d]/i, alias: "sd", kind: "image" },
  { pattern: /qwen/i, alias: "qwen" },
];

/** 认不出前缀就用模型 ID 本身当别名，去掉杂字符并截断 */
function aliasBaseFor(model: string, kind: CapabilityKind) {
  for (const { pattern, alias, kind: only } of ALIAS_PREFIXES) {
    if (only && only !== kind) continue;
    if (pattern.test(model)) return alias;
  }
  return model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "model";
}

/**
 * 各类适配器的能力摘要。
 *
 * 这些是**代码里真实支持的参数**，不是抄来的宣传词：
 * 尺寸选项来自 `App.tsx` 的参数面板，模式列表来自 `types.ts` 的 `WanVideoMode`。
 * 大脑据此决定要不要 `ask` 追问尺寸，写错了会引导它问出这个渠道答不上的问题。
 *
 * **尺寸一定要标出参数名**：以前 gemini 那行只写「尺寸=1K|2K|4K」，大脑于是去写
 * `size`——而 gemini 只认 `imageSize`，参数被静默丢弃、上游回 400
 * （需求.md 问题 1 的现场）。标上参数名，说的和做的才对得上。
 */
const IMAGE_TRAITS: Record<string, string> = {
  "openai-images": "尺寸(size)=1024x1024|1536x1024|1024x1536  图生图=✔  支持多张参考图",
  "openai-chat-image": "尺寸(size)=1024x1024|1536x1024|1024x1536  图生图=✔",
  "gemini-content": "宽高比(aspectRatio)=1:1|16:9|9:16|3:2|2:3|21:9  尺寸(imageSize)=1K|2K|4K  图生图=✔",
  "generic-json": "尺寸(size)=1024x1024  图生图=✔",
};

const VIDEO_TRAITS: Record<string, string> = {
  "wan-video": "2-30s  480P|720P|1080P  模式=文生|首帧|首尾帧|参考|编辑|延长  音频=✔  提示词扩展=✔",
  "seedance-video": "4-30s  480p|720p|1080p  模式=文生|首帧|首尾帧|参考  音频=✔",
  "grok-video": "1-15s  480p|720p|1080p  模式=文生|图生  参考图≤7",
};

/**
 * 该适配器是否**大概率**支持看图。
 *
 * 只用来给清单加个提示，真正的判定是 §11.5 的自愈机制：
 * 直接发图，被拒了才记进 `visionUnsupported`。静态表靠不住——同一个
 * `openai-chat-image` 在不同中转站背后可能是完全不同的模型。
 */
export function likelySupportsVision(adapterType: AdapterType) {
  return adapterType === "gemini-content";
}

function traitsFor(adapterType: AdapterType, kind: CapabilityKind) {
  const table = kind === "video" ? VIDEO_TRAITS : IMAGE_TRAITS;
  return table[adapterType] ?? (kind === "video" ? "视频生成" : "图片生成");
}

/**
 * 从真实渠道生成别名表。
 *
 * 同一类目下有多个模型时加序号后缀（`gpt-image-1` / `gpt-image-2`），
 * 保证每个 alias 都能唯一解析回一个 `channelId + model`。
 */
export function buildCapabilityAliases(channels: DbChannel[]): CapabilityAlias[] {
  const entries: Array<Omit<CapabilityAlias, "alias">> = [];
  for (const channel of channels) {
    if (!channel.enabled) continue;
    // 对话渠道是大脑自己，不是可选的能力
    if (isChatAdapter(channel.adapterType)) continue;
    const kind: CapabilityKind = isVideoAdapter(channel.adapterType) ? "video" : "image";
    for (const model of channel.models) {
      entries.push({
        kind, channelId: channel.id, channelName: channel.name, model,
        adapterType: channel.adapterType, traits: traitsFor(channel.adapterType, kind),
      });
    }
  }

  const grouped = new Map<string, Array<Omit<CapabilityAlias, "alias">>>();
  for (const entry of entries) {
    const key = `${entry.kind}:${aliasBaseFor(entry.model, entry.kind)}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(entry);
    else grouped.set(key, [entry]);
  }

  const aliases: CapabilityAlias[] = [];
  for (const [key, bucket] of grouped) {
    const base = key.slice(key.indexOf(":") + 1);
    bucket.forEach((entry, index) => {
      aliases.push({ ...entry, alias: bucket.length === 1 ? base : `${base}-${index + 1}` });
    });
  }
  return aliases;
}

export function aliasesFor(aliases: CapabilityAlias[], kind: CapabilityKind) {
  return aliases.filter((item) => item.kind === kind);
}

/** §6.3：每个 alias 一行，只给大脑做决策必需的信息 */
export function buildCapabilityManifest(aliases: CapabilityAlias[]): string {
  if (!aliases.length) return "（当前没有可用的生成渠道，请先到「渠道配置」添加）";
  const image = aliasesFor(aliases, "image");
  const video = aliasesFor(aliases, "video");
  const lines: string[] = [];
  for (const item of [...image, ...video]) {
    const vision = item.kind === "image" ? `  视觉=${likelySupportsVision(item.adapterType) ? "✔" : "✘"}` : "";
    lines.push(`alias=${item.alias}  ${item.kind === "video" ? "视频" : "图片"}  ${item.traits}${vision}`);
  }
  if (!video.length) lines.push("（还没有配置视频渠道，用户要视频时如实说明）");
  return lines.join("\n");
}

/** 这次是靠什么挑中的模型，用来决定「要不要跟用户解释一句」 */
export type AliasSource = "hint" | "default" | "fallback";

export interface AliasResolution {
  alias: string;
  channelId: string;
  model: string;
  /** 大脑给的 hint 没命中，退到了默认模型或类目第一个——§15 要求把这件事告诉用户 */
  usedFallback: boolean;
  /** hint=大脑指定的 / default=用户在设置里挑的 / fallback=类目里第一个 */
  source: AliasSource;
  /** 设置里存了默认 alias，但它已经不在当前能力表里（渠道被停用或删掉了） */
  staleDefault?: string;
}

/**
 * 大脑可能给出 `Gemini`、` gemini `、`gemini-3-pro-image` 这类变体，
 * 所以先精确匹配，再退化到「去掉序号后缀」匹配，最后才是「包含」匹配。
 */
function matchAlias(candidates: CapabilityAlias[], normalized: string) {
  return candidates.find((item) => item.alias === normalized)
    ?? candidates.find((item) => item.alias.replace(/-\d+$/, "") === normalized.replace(/-\d+$/, ""))
    ?? candidates.find((item) => item.alias.includes(normalized) || item.model.toLowerCase().includes(normalized));
}

/**
 * alias → `{channelId, model}`。优先级 **大脑指定的 → 你设的默认 → 类目第一个**。
 *
 * 中间的「你设的默认」是需求.md 问题 5：以前大脑不说模型时就碰运气取第一个，
 * 用户没法控制「默认用哪个」。默认值存的是 alias 而不是 channelId——alias 表是按
 * **启用中**的渠道现算的，所以渠道一停用，存着的 alias 就解析不到了。这不是错误，
 * 是正常情况：这时退回第一个，并把它记进 `staleDefault` 让调用方**如实说出来**，
 * 而不是装作「本来就是第一个」。
 */
export function resolveAlias(
  aliases: CapabilityAlias[],
  hint: string | undefined,
  kind: CapabilityKind,
  preferred?: string | null,
): AliasResolution | null {
  const candidates = aliasesFor(aliases, kind);
  if (!candidates.length) return null;

  const normalized = hint?.trim().toLowerCase();
  const hit = normalized ? matchAlias(candidates, normalized) : undefined;
  if (hit) {
    return { alias: hit.alias, channelId: hit.channelId, model: hit.model, usedFallback: false, source: "hint" };
  }

  const wanted = preferred?.trim();
  if (wanted) {
    const chosen = matchAlias(candidates, wanted.toLowerCase());
    if (chosen) {
      return { alias: chosen.alias, channelId: chosen.channelId, model: chosen.model, usedFallback: true, source: "default" };
    }
  }

  const fallback = candidates[0];
  return {
    alias: fallback.alias, channelId: fallback.channelId, model: fallback.model,
    usedFallback: true, source: "fallback",
    ...(wanted ? { staleDefault: wanted } : {}),
  };
}

/**
 * 一句话说明「为什么用了这个模型」，`null` 表示是大脑自己点名的、没什么可解释的。
 *
 * 成功卡片的文案也走这里，避免「卡片说的」和「真正用的」两套说法。
 */
export function describeAliasChoice(resolution: AliasResolution): string | null {
  if (resolution.source === "hint") return null;
  if (resolution.source === "default") return `按你设的默认模型用了 ${resolution.alias}`;
  return resolution.staleDefault
    ? `你设的默认模型 ${resolution.staleDefault} 已经不可用了，退回 ${resolution.alias}`
    : `没认出模型名，用了 ${resolution.alias}`;
}

export function findAlias(aliases: CapabilityAlias[], channelId: string, model: string) {
  return aliases.find((item) => item.channelId === channelId && item.model === model) ?? null;
}

/**
 * `{channelId}::{model}` 形式的模型指纹。
 *
 * 用在 `settings.visionUnsupported` 里（§11.5）：记的是「哪个渠道的哪个模型
 * 不接受图片」，换渠道或换模型后要重新试一次，所以不能用 alias——alias 会
 * 随着渠道增删改名。
 */
export function modelFingerprint(channelId: string, model: string) {
  return `${channelId}::${model}`;
}

/** §11.5 的自愈名单，存在 settings 表里 */
export function readVisionUnsupported(db: { getSetting(key: string): string | null }): string[] {
  const raw = db.getSetting("visionUnsupported");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function markVisionUnsupported(
  db: { getSetting(key: string): string | null; setSetting(key: string, value: string): void },
  channelId: string,
  model: string,
) {
  const current = readVisionUnsupported(db);
  const fingerprint = modelFingerprint(channelId, model);
  if (current.includes(fingerprint)) return false;
  db.setSetting("visionUnsupported", JSON.stringify([...current, fingerprint]));
  return true;
}

/** 判断一次大脑报错是不是「这个模型不吃图」，据此决定要不要拉黑视觉 */
export function looksLikeVisionRejection(status: number | undefined, message: string) {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  return /image|vision|multimodal|content.*type|图片|视觉|不支持/i.test(message);
}
