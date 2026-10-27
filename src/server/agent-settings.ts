/**
 * Agent 的默认渠道 / 默认策略读取。
 *
 * 从 app.ts 抽出来是因为无限画布线程也要用同一套默认值；放在 app.ts 里会让
 * board 服务反过来 import app，形成环。
 */
import type { AppDatabase } from "./db.js";
import { AppError } from "./tasks.js";
import { isChatAdapter } from "../shared/types.js";
import { VIDEO_CONFIRM_POLICIES, type VideoConfirmPolicy } from "../shared/agent-types.js";
import { buildCapabilityAliases } from "./capabilities.js";

export interface AgentDefaults {
  videoConfirmPolicy: VideoConfirmPolicy;
  visionEnabled: boolean;
  defaultImageAlias: string;
  defaultVideoAlias: string;
  defaultMusicAlias: string;
  defaultSpeechAlias: string;
  defaultAudioAlias: string;
}

/**
 * 旧版只有一个 `agentDefaultAudioAlias`，音乐和语音共用一个值。
 * 新装或已迁移的配置读到空的新键时，把旧值按实际适配器归到对应的一类，
 * 避免升级后用户的默认模型「看起来丢了」。
 */
function legacyAudioDefault(db: AppDatabase, adapterType: "suno-music" | "gemini-tts") {
  const legacy = db.getSetting("agentDefaultAudioAlias") ?? "";
  if (!legacy) return "";
  const entry = buildCapabilityAliases(db.listChannels()).find((alias) => alias.alias === legacy);
  return entry?.adapterType === adapterType ? legacy : "";
}

/** 新建会话时的 Agent 默认值，存在 settings 表里，用户可在设置页改 */
export function readAgentDefaults(db: AppDatabase): AgentDefaults {
  const policy = db.getSetting("agentVideoConfirmPolicy");
  return {
    // 默认「自动续跑时才问」：用户明确开口要视频时不拦，链条自己往前跑时才拦一下（§13.2）
    videoConfirmPolicy: (VIDEO_CONFIRM_POLICIES as readonly string[]).includes(policy ?? "")
      ? (policy as VideoConfirmPolicy) : "auto_only",
    visionEnabled: db.getSetting("agentVisionEnabled") !== "0",
    // 空串 = 没设，大脑不点名时退回类目第一个（问题 5）。alias 是否还有效不在这里判断
    defaultImageAlias: db.getSetting("agentDefaultImageAlias") ?? "",
    defaultVideoAlias: db.getSetting("agentDefaultVideoAlias") ?? "",
    defaultMusicAlias: db.getSetting("agentDefaultMusicAlias") ?? legacyAudioDefault(db, "suno-music"),
    defaultSpeechAlias: db.getSetting("agentDefaultSpeechAlias") ?? legacyAudioDefault(db, "gemini-tts"),
    // 旧字段继续回传，老前端还能用；新前端不再读它
    defaultAudioAlias: db.getSetting("agentDefaultAudioAlias") ?? "",
  };
}

/**
 * 挑一个对话渠道当大脑。
 *
 * 用户没指定时取第一个启用的对话渠道——通常只配了一个，
 * 加个下拉反而多一步。一个都没有时直接报错，而不是等到第一次说话才失败。
 */
export function pickBrainChannel(db: AppDatabase, channelId?: string, model?: string): { channelId: string; model: string } {
  const brains = db.listChannels().filter((channel) => channel.enabled && isChatAdapter(channel.adapterType));
  if (!brains.length) {
    throw new AppError("BRAIN_UNAVAILABLE", "还没有配置对话模型渠道，请先到「渠道配置」添加一个对话模型（大脑）", 400);
  }
  const channel = channelId ? brains.find((item) => item.id === channelId) : brains[0];
  if (!channel) throw new AppError("BRAIN_UNAVAILABLE", "指定的对话渠道不存在或未启用", 400);
  const resolved = model && channel.models.includes(model) ? model : channel.models[0];
  if (!resolved) throw new AppError("BRAIN_UNAVAILABLE", `渠道「${channel.name}」还没有配置任何模型`, 400);
  return { channelId: channel.id, model: resolved };
}
