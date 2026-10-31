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
import type { AdapterType, TaskKind } from "../shared/types.js";
import { channelKindOf } from "../shared/kinds.js";
import { isMidjourneyActionModel } from "../shared/midjourney.js";
import { OPENAI_SIZE_PRESETS } from "../shared/image-sizes.js";
import { CHANNEL_FIELD_SUPPORT } from "../shared/channel-fields.js";
import { VIDEO_CAPABILITIES, supportedVideoModes, videoModeLabel, type VideoAdapter } from "../shared/video-capabilities.js";
import type { DbChannel } from "./db.js";

export type CapabilityKind = TaskKind;

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
  // TTS 模型也带 gemini，必须排在 gemini 前面，否则会被当成生图
  { pattern: /tts/i, alias: "tts", kind: "audio" },
  { pattern: /gemini|imagen|nano-?banana/i, alias: "gemini" },
  { pattern: /grok/i, alias: "grok" },
  { pattern: /wan|万相|通义/i, alias: "wan" },
  { pattern: /kling|可灵/i, alias: "kling" },
  { pattern: /gpt-image|dall-?e|gpt-4o-image/i, alias: "gpt-image" },
  { pattern: /flux/i, alias: "flux" },
  { pattern: /midjourney|(^|[^a-z])mj([^a-z]|$)/i, alias: "mj" },
  { pattern: /stable-?diffusion|(^|[^a-z])sd[-_.\d]/i, alias: "sd", kind: "image" },
  { pattern: /qwen/i, alias: "qwen" },
  // 音乐渠道：模型名可能是 suno_damobi_music / suno_music，别名统一成 suno
  { pattern: /suno|music/i, alias: "suno", kind: "audio" },
];

/**
 * 模型 ID 里那段「版本 + 一个变体词」：`sd-2.5` → `2.5`，`sd-2.0-fast` → `2.0-fast`，
 * `gemini-3-pro-image` → `3-pro`。
 *
 * 别名要带上版本，否则同一个前缀下的几个模型会变成 `seedance-1` / `seedance-2` 这种
 * **按位置编号**的名字，和真实版本号对不上——用户按 `sd-2.5` 说，命中的却是 `sd-2.0`
 * （实测就是这么错的），而且喂给大脑的清单里只有别名、没有版本，它自己也分不出来。
 *
 * **只取一段，不能整段照抄**：别名是给大脑看的标识，不是模型 ID 的搬运——
 * 把真实模型 ID 原样写进清单，等于让它有机会把这个名字当真话说给用户
 * （`tests/agent.test.ts` 里那条不许泄漏模型 ID 的断言守着这件事）。
 * 尾巴 1–6 个字母就是要掐住「`gemini-3-pro-image` 只留 `3-pro`」。
 */
function versionTail(model: string) {
  const match = model.match(/\d+(?:\.\d+)*(?:-[a-z]{1,6})?(?![a-z])/i);
  return match ? match[0].toLowerCase() : "";
}

/** 认不出前缀就用模型 ID 本身当别名，去掉杂字符并截断 */
function aliasBaseFor(model: string, kind: CapabilityKind) {
  for (const { pattern, alias, kind: only } of ALIAS_PREFIXES) {
    if (only && only !== kind) continue;
    if (!pattern.test(model)) continue;
    // 前缀认出来了还要带上版本，`seedance` + `2.5` = `seedance-2.5`
    const tail = versionTail(model);
    return tail ? `${alias}-${tail}` : alias;
  }
  return model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "model";
}

/**
 * 各类适配器的能力摘要。
 *
 * **参数部分不手写**：尺寸、宽高比、负面词、时长、分辨率、模式全部从
 * `shared/channel-fields.ts` 的矩阵和 `VIDEO_CAPABILITIES` 派生。以前整行是手写字符串，
 * 矩阵改了这边忘改，就会出现「助手说的和代码做的不一致」——尺寸只剩三种那次就是这么来的。
 *
 * **尺寸一定要标出参数名**：以前 gemini 那行只写「尺寸=1K|2K|4K」，大脑于是去写
 * `size`——而 gemini 只认 `imageSize`，参数被静默丢弃、上游回 400。
 * 标上参数名，说的和做的才对得上。
 */
/**
 * 图像渠道的宽高比档位。
 *
 * 矩阵只说"支不支持 aspectRatio"，具体有哪些取值是渠道的取值域，放在这里；
 * 和 UI 的下拉不是一个东西（那是全量候选，这里是这个渠道真能接的）。
 */
const IMAGE_ASPECTS: Partial<Record<AdapterType, readonly string[]>> = {
  "gemini-content": ["1:1", "16:9", "9:16", "3:2", "2:3", "21:9"],
};

/** 参数之外、只能手写的部分（是不是吃图、结果形态这类） */
const IMAGE_NOTES: Partial<Record<AdapterType, string>> = {
  "openai-images": "图生图=✔  支持多张参考图",
  "openai-chat-image": "图生图=✔",
  "gemini-content": "图生图=✔",
  "generic-json": "图生图=✔",
  midjourney: "原生参数(--ar/--v/--no)  图生图=✔  结果=四宫格  支持 U/V/R 后续动作",
};

/** 同样只能手写：助手工具够不到、但工作台里存在的模式 */
const VIDEO_NOTES: Partial<Record<string, string>> = {
  "wan-video": "另有编辑/延长（仅视频工作台）",
};

/**
 * 图像渠道的能力摘要：参数部分从字段矩阵派生，叙述部分手写。
 *
 * 以前整行是手写字符串，矩阵改了这边忘了改，就会出现「助手说的和代码做的不一致」——
 * 尺寸只有三种那次就是这么来的。现在只有"支不支持"这一个事实源头。
 */
function imageTraits(adapterType: AdapterType): string {
  const support = CHANNEL_FIELD_SUPPORT[adapterType] ?? {};
  const parts: string[] = [];
  if (support.size) parts.push(`尺寸(size)=${OPENAI_SIZE_PRESETS.join("|")}，也可直接写「宽x高」`);
  if (support.imageSize) parts.push("尺寸(imageSize)=1K|2K|4K");
  const aspects = IMAGE_ASPECTS[adapterType];
  if (support.aspectRatio && aspects?.length) parts.push(`宽高比(aspectRatio)=${aspects.join("|")}`);
  if (support.negativePrompt === "param") parts.push("负面词(negative_prompt)");
  if (support.seed) parts.push("种子(seed)");
  const note = IMAGE_NOTES[adapterType];
  if (note) parts.push(note);
  return parts.join("  ");
}

/** 视频渠道的能力摘要：时长 / 分辨率 / 模式 / 画幅 / 音频都从 VIDEO_CAPABILITIES 来 */
function videoTraits(adapterType: AdapterType): string {
  const capability = VIDEO_CAPABILITIES[adapterType as VideoAdapter];
  if (!capability) return "视频生成";
  const parts: string[] = [];
  parts.push(capability.durations.fixed !== null
    ? `${capability.durations.fixed}s`
    : `${capability.durations.min}-${capability.durations.max}s`);
  parts.push(capability.resolutions.join("|"));
  const modes = supportedVideoModes(adapterType).map((mode) => videoModeLabel(mode, adapterType));
  if (modes.length) parts.push(`模式=${modes.join("|")}`);
  if (capability.aspectRatios.length) {
    const field = capability.ratioField === "ratio" ? "ratio" : "aspectRatio";
    parts.push(`画幅(${field})=${capability.aspectRatios.join("|")}`);
  }
  if (capability.supportsAudio) parts.push("音频=✔");
  if (capability.supportsPromptExtend) parts.push("提示词扩展=✔");
  parts.push(`参考图≤${capability.maxReferenceImages}`);
  const note = VIDEO_NOTES[adapterType];
  if (note) parts.push(note);
  return parts.join("  ");
}

const AUDIO_TRAITS: Record<string, string> = {
  "suno-music": "一次生成 2 首  灵感|自定义歌词|纯音乐  时长自动（约 2-5 分钟）",
  "gemini-tts": "配音/旁白  30 个预置音色  单人|双人对话  风格/语种可控  输出 24kHz WAV",
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
  if (kind === "video") return videoTraits(adapterType);
  if (kind === "audio") return AUDIO_TRAITS[adapterType] ?? "音乐生成";
  return imageTraits(adapterType) || "图片生成";
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
    const channelKind = channelKindOf(channel.adapterType);
    if (channelKind === "chat") continue;
    const kind: CapabilityKind = channelKind;
    for (const model of channel.models) {
      // 放大/变体/重绘必须先有 MJ 任务，不能作为普通生图模型交给大脑。
      // mj_edits 也不再展示：加参考图时 mj_imagine 会自动走 edits 接口，用户不需要单独选它。
      if (channel.adapterType === "midjourney"
        && (model === "mj_edits" || isMidjourneyActionModel(model))) continue;
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
  const audio = aliasesFor(aliases, "audio");
  const lines: string[] = [];
  for (const item of [...image, ...video, ...audio]) {
    const vision = item.kind === "image" ? `  视觉=${likelySupportsVision(item.adapterType) ? "✔" : "✘"}` : "";
    const label = item.kind === "video"
      ? "视频"
      : item.kind === "audio"
        ? (item.adapterType === "gemini-tts" ? "配音" : "音乐")
        : "图片";
    lines.push(`alias=${item.alias}  ${label}  ${item.traits}${vision}`);
  }
  if (!video.length) lines.push("（还没有配置视频渠道，用户要视频时如实说明）");
  if (!audio.length) lines.push("（还没有配置音乐渠道，用户要音乐时如实说明）");
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
 * 大脑和用户都可能把别名写成各种样子：`Gemini`、` gemini `、`seedance2.5`、
 * 甚至直接说真实模型 ID `sd-2.5`。所以分四档找，从紧到松：
 *
 * 1. 原样
 * 2. **忽略分隔符**——`seedance2.5` 要能命中 `seedance-2.5`（用户就是这么打字的）
 * 3. 去掉末尾序号后缀（老别名 seedance-1/2/3 还留在用户设置和旧记录里）
 * 4. 子串包含，最后连真实模型 ID 一起找
 */
function loose(value: string) {
  return value.toLowerCase().replace(/[\s\-_.]/g, "");
}

function matchAlias(candidates: CapabilityAlias[], normalized: string) {
  const looseWant = loose(normalized);
  return candidates.find((item) => item.alias === normalized)
    ?? candidates.find((item) => loose(item.alias) === looseWant)
    ?? candidates.find((item) => item.alias.replace(/-\d+$/, "") === normalized.replace(/-\d+$/, ""))
    ?? candidates.find((item) => loose(item.alias).includes(looseWant) || loose(item.model).includes(looseWant));
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
  // 数量/体积/请求体超限不是「模型不吃图」，只是这次发多了。
  // 把它当成 vision-unsupported 会永久拉黑一个明明能看图的模型——
  // view_images 一次可以附 8 张，这类报错会变得常见。
  if (/too\s*many|maximum|at\s*most|limit|too\s*large|payload|request\s+entity|size|最多|张数|数量|过大|超出|尺寸/i.test(message)) {
    return false;
  }
  return /image|vision|multimodal|content.*type|图片|视觉|不支持/i.test(message);
}
