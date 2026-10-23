/**
 * 分镜执行：把「分镜表里的镜头」提交成真正的生成任务。
 *
 * 和 Agent 的批量生图刻意分开：
 * - 分镜批次由用户在面板上确认后触发，不受 `MAX_ROUNDS` / 一轮对话生命周期限制；
 * - 提交后不等结果，任务完成状态由 `listStoryboardShots` 从 tasks 表实时读出来；
 * - 每镜独立失败，一镜报错不带走整批。
 */
import type { AppDatabase, AssetRow } from "./db.js";
import { AppError, type ReferenceImageUpload, type TaskRunner } from "./tasks.js";
import { buildCapabilityAliases, resolveAlias } from "./capabilities.js";
import { VIDEO_DEFAULTS } from "./agent-tools.js";
import { prepareImageBytes, REFERENCE_PROFILE } from "./vision.js";
import { isImageAsset, type GenerationInput } from "../shared/types.js";
import {
  MAX_STORYBOARD_BATCH, STORYBOARD_CHARACTER_PREFIX, shotNeedsCharacterReference, storyboardShotMissing,
  type StoryboardReference, type StoryboardShot, type StoryboardView,
} from "../shared/storyboard.js";

export interface StoryboardGenerateResult {
  submitted: number;
  failures: Array<{ shotId: string; index: number; error: string }>;
  shots: StoryboardShot[];
  /** 这次用了哪张角色参考；null 表示没用（off、没图、或基准镜头失败） */
  referenceAssetId: string | null;
  /** 自动基准 / 参考图读取失败之类，需要让用户知道的一句话 */
  note?: string;
}

interface ResolvedReference {
  asset: AssetRow | null;
  mode: "auto" | "manual" | "off";
}

/**
 * 这次该用哪张角色参考。
 *
 * auto 选**镜号最小且已经有结果**的图片镜头——它通常是用户先验收过的那张；
 * 不按「最后生成」选，是因为重跑某一镜会让参考悄悄漂移。
 */
function resolveReference(db: AppDatabase, conversationId: string, shots: StoryboardShot[]): ResolvedReference {
  const setting = db.getStoryboardReference(conversationId);
  if (setting.mode === "off") return { asset: null, mode: "off" };
  if (setting.mode === "manual" && setting.assetId) {
    const asset = db.getAsset(setting.assetId);
    if (asset && isImageAsset(asset)) return { asset, mode: "manual" };
    // 指定的图被删了：退回 auto，而不是让整批在无参考的情况下悄悄跑
  }
  // 优先用有人物的镜头：第一镜经常是空镜/环境，拿它当「角色参考」等于参考了一盏灯
  const withAsset = shots
    .filter((shot) => shot.kind === "image" && shot.assetId)
    .sort((left, right) => left.index - right.index);
  const first = withAsset.find(shotNeedsCharacterReference) ?? withAsset[0];
  const asset = first?.assetId ? db.getAsset(first.assetId) : null;
  return { asset: asset && isImageAsset(asset) ? asset : null, mode: "auto" };
}

function referenceView(db: AppDatabase, reference: ResolvedReference, shots: StoryboardShot[]): StoryboardReference {
  const shot = reference.asset ? shots.find((item) => item.assetId === reference.asset!.id) : undefined;
  return {
    mode: reference.mode,
    asset: reference.asset ? db.assetView(reference.asset) : null,
    shotIndex: shot?.index ?? null,
  };
}

export function buildStoryboardView(db: AppDatabase, conversationId: string): StoryboardView {
  const aliases = buildCapabilityAliases(db.listChannels());
  const shots = db.listStoryboardShots(conversationId);
  return {
    shots,
    canGenerateImage: Boolean(resolveAlias(aliases, undefined, "image", db.getSetting("agentDefaultImageAlias") ?? undefined)),
    canGenerateVideo: Boolean(resolveAlias(aliases, undefined, "video", db.getSetting("agentDefaultVideoAlias") ?? undefined)),
    maxBatch: MAX_STORYBOARD_BATCH,
    reference: referenceView(db, resolveReference(db, conversationId, shots), shots),
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

  /** 提交一镜；成功与否都只影响这一镜 */
  async function submitShot(shot: StoryboardShot, uploads: ReferenceImageUpload[]): Promise<{ ok: true; taskId: string } | { ok: false; error: string }> {
    try {
      const resolution = resolveAlias(aliases, undefined, shot.kind, defaults[shot.kind]);
      if (!resolution) return { ok: false, error: shot.kind === "video" ? "没有可用的视频渠道" : "没有可用的生图渠道" };
      const channel = db.getChannel(resolution.channelId);
      if (!channel || !channel.enabled) return { ok: false, error: "解析到的渠道不存在或未启用" };

      // 只给有人物的镜头带角色参考；空镜/字幕/道具特写带了反而会多画出一个人
      const withReference = shot.kind === "image" && uploads.length > 0 && shotNeedsCharacterReference(shot);
      const generation: GenerationInput = shot.kind === "video"
        ? videoInput(shot, channel.id, resolution.model, channel.adapterType)
        : {
          channelId: channel.id,
          model: resolution.model,
          prompt: withReference ? `${STORYBOARD_CHARACTER_PREFIX}${shot.prompt}` : shot.prompt,
          count: 1,
          ...(shot.aspectRatio ? { aspectRatio: shot.aspectRatio } : {}),
        };

      const created = await runner.create(generation, withReference ? uploads : []);
      db.updateStoryboardShot(shot.id, { taskId: created.id });
      return { ok: true, taskId: created.id };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "提交失败" };
    }
  }

  const resolved = resolveReference(db, conversationId, all);
  let reference = resolved.asset;
  let note: string | undefined;
  const imageShots = selected.filter((shot) => shot.kind === "image").sort((left, right) => left.index - right.index);
  let baseShotId: string | null = null;

  /*
   * 还没有任何可用的角色参考、这一批又要出两张以上图片时，先生成镜号最小的一张，
   * 等它落盘，再拿它当其余镜头的参考。这就是对话批量里「同一人物」的做法：
   * 否则 8 张图会各自从零开始画，人物当然对不上。
   *
   * 用户指定了参考、或已经有完成镜头时不会走这里，直接并行提交。
   */
  if (!reference && resolved.mode === "auto" && imageShots.length >= 2) {
    // 同样优先拿有人物的镜头当基准：第一镜是空镜时，先画环境没有意义
    const base = imageShots.find(shotNeedsCharacterReference) ?? imageShots[0]!;
    const submittedBase = await submitShot(base, []);
    baseShotId = base.id;
    if (submittedBase.ok) {
      try {
        const task = await runner.waitFor(submittedBase.taskId, { timeoutMs: 180_000 });
        const asset = task.status === "succeeded" ? task.assets[0] : undefined;
        if (asset) reference = db.getAsset(asset.id);
      } catch {
        note = "角色基准镜头没有在 3 分钟内完成，其余镜头将不使用参考图。";
      }
      if (!reference) note = note ?? "角色基准镜头没有产出可用图片，其余镜头将不使用参考图。";
    } else {
      failures.push({ shotId: base.id, index: base.index, error: submittedBase.error });
      note = "角色基准镜头提交失败，其余镜头将不使用参考图。";
    }
  }

  let uploads: ReferenceImageUpload[] = [];
  if (reference) {
    const prepared = await prepareImageBytes(db, reference, REFERENCE_PROFILE);
    if (prepared) {
      uploads = [{ bytes: prepared.bytes, mimeType: prepared.mimeType, fileName: prepared.fileName }];
    } else {
      reference = null;
      note = "角色参考图读取失败，本次未使用参考图。";
    }
  }

  await Promise.all(selected
    .filter((shot) => shot.id !== baseShotId)
    .map(async (shot) => {
      const outcome = await submitShot(shot, uploads);
      if (!outcome.ok) failures.push({ shotId: shot.id, index: shot.index, error: outcome.error });
    }));

  // 失败也照常返回最新视图：成功的镜头已经在跑了，不能让一次失败把整批回滚
  return {
    submitted: selected.length - failures.length,
    failures: failures.sort((left, right) => left.index - right.index),
    shots: db.listStoryboardShots(conversationId),
    referenceAssetId: reference?.id ?? null,
    ...(note ? { note } : {}),
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
