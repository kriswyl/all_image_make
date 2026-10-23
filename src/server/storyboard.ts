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
  type StoryboardCharacter, type StoryboardReference, type StoryboardShot, type StoryboardView,
} from "../shared/storyboard.js";

export interface StoryboardGenerateResult {
  submitted: number;
  failures: Array<{ shotId: string; index: number; error: string }>;
  shots: StoryboardShot[];
  /** 老分镜（没有角色标签）用的全局参考；按角色参考时是 null */
  referenceAssetId: string | null;
  /** 按角色拆分的参考：这一批每个角色实际用了哪张图 */
  characterReferences: Array<{ character: string; assetId: string }>;
  /** 自动基准 / 参考图读取失败之类，需要让用户知道的一句话 */
  note?: string;
}

interface ResolvedReference {
  asset: AssetRow | null;
  mode: "auto" | "manual" | "off";
}

interface ResolvedCharacter extends StoryboardCharacter {
  /** 生成时真正要读字节的那一行；前端视图只拿 asset */
  row: AssetRow | null;
}

/**
 * 老分镜（没有角色标签）的全局参考。
 *
 * auto 选**镜号最小且已经有结果的人物镜头**——空镜常是第一镜，拿它当角色参考
 * 等于参考了一盏灯。指定图被删了也退回 auto，而不是让整批在无参考下悄悄跑。
 */
function resolveReference(db: AppDatabase, conversationId: string, shots: StoryboardShot[]): ResolvedReference {
  const setting = db.getStoryboardReference(conversationId);
  if (setting.mode === "off") return { asset: null, mode: "off" };
  if (setting.mode === "manual" && setting.assetId) {
    const asset = db.getAsset(setting.assetId);
    if (asset && isImageAsset(asset)) return { asset, mode: "manual" };
  }
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

/**
 * 每个角色各自的参考图：手动绑定的优先，否则用该角色第一个已完成的镜头。
 * 一个全局参考做不到这件事——它会把少女和助手都画成同一个男人。
 */
function resolveCharacters(db: AppDatabase, conversationId: string, shots: StoryboardShot[]): ResolvedCharacter[] {
  return db.listStoryboardCharacters(conversationId).map((character) => {
    const characterShots = shots.filter((shot) => shot.character === character.name);
    const manual = character.assetId ? db.getAsset(character.assetId) : null;
    if (manual && isImageAsset(manual)) {
      return {
        id: character.id, name: character.name, assetId: character.assetId,
        asset: db.assetView(manual), row: manual, mode: "manual", shotCount: characterShots.length,
      };
    }
    const firstShot = characterShots
      .filter((shot) => shot.kind === "image" && shot.assetId)
      .sort((left, right) => left.index - right.index)[0];
    const auto = firstShot?.assetId ? db.getAsset(firstShot.assetId) : null;
    return {
      id: character.id, name: character.name, assetId: character.assetId,
      asset: auto && isImageAsset(auto) ? db.assetView(auto) : null,
      row: auto && isImageAsset(auto) ? auto : null,
      mode: auto && isImageAsset(auto) ? "auto" : "none",
      shotCount: characterShots.length,
    };
  });
}

export function buildStoryboardView(db: AppDatabase, conversationId: string): StoryboardView {
  const aliases = buildCapabilityAliases(db.listChannels());
  const shots = db.listStoryboardShots(conversationId);
  const characters: StoryboardCharacter[] = resolveCharacters(db, conversationId, shots)
    .filter((character) => character.shotCount > 0)
    .map(({ row: _row, ...character }) => character);
  return {
    shots,
    canGenerateImage: Boolean(resolveAlias(aliases, undefined, "image", db.getSetting("agentDefaultImageAlias") ?? undefined)),
    canGenerateVideo: Boolean(resolveAlias(aliases, undefined, "video", db.getSetting("agentDefaultVideoAlias") ?? undefined)),
    maxBatch: MAX_STORYBOARD_BATCH,
    reference: referenceView(db, resolveReference(db, conversationId, shots), shots),
    characters,
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
  const characterReferences: StoryboardGenerateResult["characterReferences"] = [];
  const baseShotIds = new Set<string>();
  let note: string | undefined;

  /** 提交一镜；成功与否都只影响这一镜 */
  async function submitShot(
    shot: StoryboardShot,
    uploads: ReferenceImageUpload[],
    allowReference: boolean,
  ): Promise<{ ok: true; taskId: string } | { ok: false; error: string }> {
    try {
      const resolution = resolveAlias(aliases, undefined, shot.kind, defaults[shot.kind]);
      if (!resolution) return { ok: false, error: shot.kind === "video" ? "没有可用的视频渠道" : "没有可用的生图渠道" };
      const channel = db.getChannel(resolution.channelId);
      if (!channel || !channel.enabled) return { ok: false, error: "解析到的渠道不存在或未启用" };

      // 只给有人物的镜头带角色参考；空镜/字幕/道具特写带了反而会多画出一个人
      const withReference = shot.kind === "image" && allowReference && uploads.length > 0;
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

  const uploadCache = new Map<string, ReferenceImageUpload[]>();
  async function uploadsFor(asset: AssetRow | null): Promise<ReferenceImageUpload[]> {
    if (!asset) return [];
    const cached = uploadCache.get(asset.id);
    if (cached) return cached;
    const prepared = await prepareImageBytes(db, asset, REFERENCE_PROFILE);
    if (!prepared) return [];
    const uploads: ReferenceImageUpload[] = [{
      bytes: prepared.bytes, mimeType: prepared.mimeType, fileName: prepared.fileName,
    }];
    uploadCache.set(asset.id, uploads);
    return uploads;
  }

  /** 生成基准镜头并等它落盘；成功返回产物，失败返回 null（失败原因已经记进 failures） */
  async function generateBase(
    shot: StoryboardShot,
    label: string,
  ): Promise<{ asset: AssetRow | null }> {
    const submittedBase = await submitShot(shot, [], false);
    baseShotIds.add(shot.id);
    if (!submittedBase.ok) {
      failures.push({ shotId: shot.id, index: shot.index, error: submittedBase.error });
      note = `${label}提交失败，其余镜头将不使用参考图。`;
      return { asset: null };
    }
    try {
      const task = await runner.waitFor(submittedBase.taskId, { timeoutMs: 180_000 });
      const asset = task.status === "succeeded" ? task.assets[0] : undefined;
      const row = asset ? db.getAsset(asset.id) : null;
      if (row && isImageAsset(row)) return { asset: row };
      note = note ?? `${label}没有产出可用图片，其余镜头将不使用参考图。`;
      return { asset: null };
    } catch {
      note = note ?? `${label}没有在 3 分钟内完成，其余镜头将不使用参考图。`;
      return { asset: null };
    }
  }

  const hasCharacterTags = all.some((shot) => Boolean(shot.character.trim()));
  let referenceAssetId: string | null = null;
  const pending: Array<{ shot: StoryboardShot; uploads: ReferenceImageUpload[]; allowReference: boolean }> = [];

  if (!hasCharacterTags) {
    // ── 老分镜：沿用全局参考 ────────────────────────────────────────────────
    const resolved = resolveReference(db, conversationId, all);
    let reference = resolved.asset;
    const imageShots = selected.filter((shot) => shot.kind === "image").sort((left, right) => left.index - right.index);
    if (!reference && resolved.mode === "auto" && imageShots.length >= 2) {
      const base = imageShots.find(shotNeedsCharacterReference) ?? imageShots[0]!;
      reference = (await generateBase(base, "角色基准镜头")).asset;
    }
    const uploads = await uploadsFor(reference);
    if (reference && !uploads.length) {
      reference = null;
      note = "角色参考图读取失败，本次未使用参考图。";
    }
    referenceAssetId = reference?.id ?? null;
    for (const shot of selected) {
      if (baseShotIds.has(shot.id)) continue;
      pending.push({ shot, uploads, allowReference: shotNeedsCharacterReference(shot) });
    }
  } else {
    // ── 有角色标签：每个角色用自己的参考 ────────────────────────────────────
    const characters = resolveCharacters(db, conversationId, all);
    const groups = new Map<string, StoryboardShot[]>();
    for (const shot of selected) {
      if (shot.kind !== "image") continue;
      const name = shot.character.trim();
      if (!name) continue;
      groups.set(name, [...(groups.get(name) ?? []), shot]);
    }

    // 每个角色单独建基准。角色之间串行，避免同时挂 3 个 3 分钟的等待；
    // 一角色通常只需要一次基准生成，之后整批可以并行。
    for (const [name, group] of groups) {
      const ordered = [...group].sort((left, right) => left.index - right.index);
      const character = characters.find((item) => item.name === name);
      let reference = character?.row ?? null;
      let uploads = await uploadsFor(reference);
      if (reference && !uploads.length) {
        note = `角色「${name}」的参考图读取失败，这一组不使用参考图。`;
        reference = null;
      }

      if (!reference && ordered.length >= 2) {
        reference = (await generateBase(ordered[0]!, `角色「${name}」的基准镜头`)).asset;
        uploads = await uploadsFor(reference);
        if (reference && !uploads.length) {
          note = `角色「${name}」的基准图读取失败，这一组不使用参考图。`;
          reference = null;
        }
      }
      if (reference) characterReferences.push({ character: name, assetId: reference.id });

      for (const shot of ordered) {
        if (baseShotIds.has(shot.id)) continue;
        pending.push({ shot, uploads, allowReference: Boolean(reference) });
      }
    }

    // 空镜 / 道具 / 字幕：不带参考
    for (const shot of selected) {
      if (shot.kind !== "image" || shot.character.trim()) continue;
      pending.push({ shot, uploads: [], allowReference: false });
    }
  }

  // 视频镜头不使用角色参考（尾帧串镜在后续计划里）
  for (const shot of selected) {
    if (shot.kind !== "video" || baseShotIds.has(shot.id)) continue;
    pending.push({ shot, uploads: [], allowReference: false });
  }

  await Promise.all(pending.map(async ({ shot, uploads, allowReference }) => {
    const outcome = await submitShot(shot, uploads, allowReference);
    if (!outcome.ok) failures.push({ shotId: shot.id, index: shot.index, error: outcome.error });
  }));

  // 失败也照常返回最新视图：成功的镜头已经在跑了，不能让一次失败把整批回滚
  return {
    submitted: selected.length - failures.length,
    failures: failures.sort((left, right) => left.index - right.index),
    shots: db.listStoryboardShots(conversationId),
    referenceAssetId,
    characterReferences,
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
