/**
 * 「先选模型」用的目录。
 *
 * 不是另起一份真相：全部从 `PROVIDER_PRESETS` 派生。模板里删掉/调整了哪个单元，
 * 新手引导跟着变，不需要两处维护。一个单元就是一个**配置组**——选了其中任意一个
 * 模型，就会生成一个渠道配置，单独填 Key。
 */
import {
  buildChannelDrafts, findConflictChannels, type ChannelUnitPreset, type ProviderPreset,
  PROVIDER_PRESETS,
} from "./provider-presets.js";
import { channelKindOf } from "./kinds.js";
import type { Channel } from "./types.js";

export type ModelGroupKind = "image" | "video" | "audio" | "chat";

export interface ModelGroup {
  /** `${presetId}:${unitId}`，选择状态和 React key 都用它 */
  key: string;
  preset: ProviderPreset;
  unit: ChannelUnitPreset;
  kind: ModelGroupKind;
}

function kindOf(unit: ChannelUnitPreset): ModelGroupKind {
  return channelKindOf(unit.adapterType);
}

export const MODEL_GROUPS: ModelGroup[] = PROVIDER_PRESETS.flatMap((preset) => preset.units.map((unit) => ({
  key: `${preset.id}:${unit.id}`,
  preset,
  unit,
  kind: kindOf(unit),
})));

export const MODEL_GROUP_SECTIONS: Array<{ kind: ModelGroupKind; label: string; hint: string }> = [
  { kind: "image", label: "生图", hint: "画图、改图、图生图" },
  { kind: "video", label: "视频", hint: "文生视频、首尾帧、参考生视频" },
  { kind: "audio", label: "音乐", hint: "灵感描述、自定义歌词、纯音乐" },
  { kind: "chat", label: "对话", hint: "对话工作区的大脑，不出图" },
];

/** 推荐组合：新用户不知道选什么时，一键选一组覆盖三种用途的常用模型 */
export const RECOMMENDED_MODELS: Record<string, string> = {
  // 生图推荐 -c 系列：独立计费与密钥，出图更稳，也不会和标准 gpt 渠道混用
  "tiantoken-gpt-c:gpt-c": "gpt-image-2.5-sunburst-c",
  "tiantoken-wan-video:wan-video": "wan3.0-video",
  "tiantoken-kling-video:kling-video": "kling-3.0",
  "tiantoken-suno:suno-music": "suno_damobi_music",
  "tiantoken-chat:chat": "deepseek-v4-1-flash",
};

export function findModelGroup(key: string) {
  return MODEL_GROUPS.find((group) => group.key === key);
}

export function groupsForKind(kind: ModelGroupKind) {
  return MODEL_GROUPS.filter((group) => group.kind === kind);
}

/**
 * 每一类里 spotlight 推荐的那颗气泡。
 *
 * 优先用 `RECOMMENDED_MODELS`；模板变化导致推荐项不存在时，退到该类的第一个模型，
 * 引导不会因为某个模型下架而变成一颗都圈不中。
 */
export function recommendedModelFor(kind: ModelGroupKind): { group: ModelGroup; model: string } | undefined {
  for (const group of groupsForKind(kind)) {
    const model = RECOMMENDED_MODELS[group.key];
    if (model && group.unit.models.includes(model)) return { group, model };
  }
  const first = groupsForKind(kind).find((group) => group.unit.models.length);
  return first ? { group: first, model: first.unit.models[0]! } : undefined;
}

/** 某一组选中若干模型后，会生成的那份渠道草稿（冲突检测、保存都用它） */
export function draftForGroup(
  group: ModelGroup,
  models: string[],
  secretEnv: string,
  apiKey?: string,
) {
  return buildChannelDrafts(group.preset, [{
    unitId: group.unit.id,
    models,
    secretEnv,
    ...(apiKey ? { apiKey } : {}),
  }])[0];
}

/** 同站点同协议、且模型有交集的已有渠道 → 这次保存会覆盖它 */
export function duplicateFor(
  draft: ReturnType<typeof draftForGroup>,
  channels: Channel[],
) {
  if (!draft) return undefined;
  return findConflictChannels(draft, channels)[0];
}
