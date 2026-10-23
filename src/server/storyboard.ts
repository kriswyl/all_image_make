/**
 * 分镜执行：把「分镜表里的镜头」提交成真正的生成任务。
 *
 * 和 Agent 的批量生图刻意分开：
 * - 分镜批次由用户在面板上确认后触发，不受 `MAX_ROUNDS` / 一轮对话生命周期限制；
 * - 提交后不等结果，任务完成状态由 `listStoryboardShots` 从 tasks 表实时读出来；
 * - 每镜独立失败，一镜报错不带走整批。
 */
import type { AppDatabase } from "./db.js";
import { AppError, type TaskRunner } from "./tasks.js";
import { buildCapabilityAliases, resolveAlias } from "./capabilities.js";
import { VIDEO_DEFAULTS } from "./agent-tools.js";
import type { GenerationInput } from "../shared/types.js";
import {
  MAX_STORYBOARD_BATCH, storyboardShotMissing,
  type StoryboardShot, type StoryboardView,
} from "../shared/storyboard.js";

export interface StoryboardGenerateResult {
  submitted: number;
  failures: Array<{ shotId: string; index: number; error: string }>;
  shots: StoryboardShot[];
}

export function buildStoryboardView(db: AppDatabase, conversationId: string): StoryboardView {
  const aliases = buildCapabilityAliases(db.listChannels());
  return {
    shots: db.listStoryboardShots(conversationId),
    canGenerateImage: Boolean(resolveAlias(aliases, undefined, "image", db.getSetting("agentDefaultImageAlias") ?? undefined)),
    canGenerateVideo: Boolean(resolveAlias(aliases, undefined, "video", db.getSetting("agentDefaultVideoAlias") ?? undefined)),
    maxBatch: MAX_STORYBOARD_BATCH,
  };
}

/**
 * 提交选中的镜头。
 *
 * 调用方负责「用户确认过」这件事：这里只做参数和渠道校验，不再弹确认。
 * 一次最多 8 镜，和对话批量生图同一个理由——别让中转站把并发的 20 路当攻击。
 */
export async function generateStoryboardShots(input: {
  db: AppDatabase;
  runner: TaskRunner;
  conversationId: string;
  shotIds: string[];
}): Promise<StoryboardGenerateResult> {
  const { db, runner, conversationId } = input;
  const ids = [...new Set(input.shotIds)];
  if (!ids.length) throw new AppError("STORYBOARD_EMPTY", "没有选中任何镜头", 400);
  if (ids.length > MAX_STORYBOARD_BATCH) {
    throw new AppError("STORYBOARD_BATCH_TOO_LARGE", `一次最多提交 ${MAX_STORYBOARD_BATCH} 个镜头`, 400);
  }

  const all = db.listStoryboardShots(conversationId);
  const shots = ids.map((id) => all.find((shot) => shot.id === id));
  if (shots.some((shot) => !shot)) {
    throw new AppError("STORYBOARD_SHOT_NOT_FOUND", "有镜头不属于这个会话，可能已经被重新拆分", 404);
  }
  const selected = shots as StoryboardShot[];
  const missing = selected.find((shot) => storyboardShotMissing(shot));
  if (missing) {
    throw new AppError("STORYBOARD_SHOT_INCOMPLETE", `第 ${missing.index} 镜${storyboardShotMissing(missing)}，请先补全`, 400);
  }

  const aliases = buildCapabilityAliases(db.listChannels());
  const defaults = {
    image: db.getSetting("agentDefaultImageAlias") ?? undefined,
    video: db.getSetting("agentDefaultVideoAlias") ?? undefined,
  };

  const failures: StoryboardGenerateResult["failures"] = [];
  await Promise.all(selected.map(async (shot) => {
    try {
      const resolution = resolveAlias(aliases, undefined, shot.kind, defaults[shot.kind]);
      if (!resolution) {
        failures.push({ shotId: shot.id, index: shot.index, error: shot.kind === "video" ? "没有可用的视频渠道" : "没有可用的生图渠道" });
        return;
      }
      const channel = db.getChannel(resolution.channelId);
      if (!channel || !channel.enabled) {
        failures.push({ shotId: shot.id, index: shot.index, error: "解析到的渠道不存在或未启用" });
        return;
      }

      const generation: GenerationInput = shot.kind === "video"
        ? videoInput(shot, channel.id, resolution.model, channel.adapterType)
        : {
          channelId: channel.id,
          model: resolution.model,
          prompt: shot.prompt,
          count: 1,
          ...(shot.aspectRatio ? { aspectRatio: shot.aspectRatio } : {}),
        };

      const created = await runner.create(generation);
      db.updateStoryboardShot(shot.id, { taskId: created.id });
    } catch (error) {
      failures.push({
        shotId: shot.id, index: shot.index,
        error: error instanceof Error ? error.message : "提交失败",
      });
    }
  }));

  // 失败也照常返回最新视图：成功的镜头已经在跑了，不能让一次失败把整批回滚
  return {
    submitted: selected.length - failures.length,
    failures: failures.sort((left, right) => left.index - right.index),
    shots: db.listStoryboardShots(conversationId),
  };
}

function videoInput(shot: StoryboardShot, channelId: string, model: string, adapterType: string): GenerationInput {
  const defaults = VIDEO_DEFAULTS[adapterType] ?? { duration: 5, resolution: "720p", audio: false };
  const base: GenerationInput = {
    channelId, model,
    prompt: shot.prompt,
    duration: defaults.duration,
    resolution: defaults.resolution,
    audio: defaults.audio,
    promptExtend: true,
    ...(shot.aspectRatio ? { aspectRatio: shot.aspectRatio } : {}),
  };
  if (adapterType === "wan-video") return { ...base, wanVideoMode: "text-to-video", ratio: shot.aspectRatio || "16:9" };
  if (adapterType === "seedance-video") return { ...base, seedanceVideoMode: "text-to-video", ratio: "adaptive" };
  if (adapterType === "kling-video") return { ...base, klingVideoMode: "text-to-video", aspectRatio: shot.aspectRatio || "16:9" };
  return base;
}
