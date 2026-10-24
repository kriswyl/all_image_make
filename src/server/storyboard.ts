/**
 * 分镜执行：设定图（角色 / 场景）→ 分镜图。
 *
 * 为什么要分两步：一镜一镜从零生成，人物和场景都会漂。先把「林昭长什么样」
 * 「实验室长什么样」各生成一张、让用户确认，再把它们作为参考图带进每一镜，
 * 人物和空间才有稳定的锚点。
 */
import type { AppDatabase, AssetRow } from "./db.js";
import { AppError, type ReferenceImageUpload, type TaskRunner } from "./tasks.js";
import { buildCapabilityAliases, resolveAlias } from "./capabilities.js";
import { VIDEO_DEFAULTS } from "./agent-tools.js";
import { prepareImageBytes, REFERENCE_PROFILE } from "./vision.js";
import { isImageAsset, type Asset, type GenerationInput } from "../shared/types.js";
import {
  MAX_STORYBOARD_BATCH, STORYBOARD_CHARACTER_PREFIX, shotNeedsCharacterReference, storyboardShotMissing,
  type StoryboardCharacter, type StoryboardReference, type StoryboardScene, type StoryboardSettingStatus,
  type StoryboardShot, type StoryboardView,
} from "../shared/storyboard.js";

export interface StoryboardGenerateResult {
  submitted: number;
  failures: Array<{ shotId: string; index: number; error: string }>;
  shots: StoryboardShot[];
  /** 老分镜（没有角色/场景标签）用的全局参考；按设定图参考时是 null */
  referenceAssetId: string | null;
  /** 这一批实际用了哪些角色 / 场景设定图 */
  characterReferences: Array<{ character: string; assetId: string }>;
  sceneReferences: Array<{ scene: string; assetId: string }>;
  note?: string;
}

export interface StoryboardSettingsResult {
  submitted: number;
  failures: Array<{ id: string; name: string; kind: "character" | "scene"; error: string }>;
  view: StoryboardView;
}

interface SettingRow {
  id: string;
  conversationId: string;
  name: string;
  prompt: string;
  assetId: string | null;
  taskId: string | null;
  confirmed: boolean;
}

interface ResolvedSetting {
  row: SettingRow;
  asset: AssetRow | null;
  assetView: Asset | null;
  source: "manual" | "generated" | "none";
  status: StoryboardSettingStatus;
  confirmed: boolean;
}

function settingTask(db: AppDatabase, taskId: string | null) {
  return taskId ? db.getTaskView(taskId) : null;
}

/**
 * 设定图从哪来：手动选的图优先；否则看最近一次生成任务的结果。
 * 任务还在跑时 asset 为 null，但 status 会让前端显示「生成中」。
 */
function resolveSetting(db: AppDatabase, row: SettingRow): ResolvedSetting {
  const manual = row.assetId ? db.getAsset(row.assetId) : null;
  const task = settingTask(db, row.taskId);
  const generated = task?.assets?.[0] ?? null;
  const asset = manual && isImageAsset(manual)
    ? manual
    : generated ? db.getAsset(generated.id) : null;
  const source: ResolvedSetting["source"] = manual && isImageAsset(manual)
    ? "manual"
    : asset ? "generated" : "none";
  const status: StoryboardSettingStatus = asset
    ? "succeeded"
    : task ? task.status : "none";
  return {
    row,
    asset: asset && isImageAsset(asset) ? asset : null,
    assetView: asset && isImageAsset(asset) ? db.assetView(asset) : null,
    source,
    status,
    // 图被删/换过之后旧确认不能继续生效
    confirmed: Boolean(row.confirmed && asset),
  };
}

function characterRows(db: AppDatabase, conversationId: string): SettingRow[] {
  return db.listStoryboardCharacters(conversationId).map((row) => ({
    id: row.id, conversationId, name: row.name, prompt: row.prompt,
    assetId: row.assetId, taskId: row.taskId, confirmed: row.confirmed,
  }));
}

function sceneRows(db: AppDatabase, conversationId: string): SettingRow[] {
  return db.listStoryboardScenes(conversationId).map((row) => ({
    id: row.id, conversationId, name: row.name, prompt: row.prompt,
    assetId: row.assetId, taskId: row.taskId, confirmed: row.confirmed,
  }));
}

function charactersView(db: AppDatabase, conversationId: string, shots: StoryboardShot[]): StoryboardCharacter[] {
  return characterRows(db, conversationId).map((row) => {
    const resolved = resolveSetting(db, row);
    return {
      id: row.id, name: row.name, prompt: row.prompt,
      assetId: row.assetId, asset: resolved.assetView, source: resolved.source,
      taskId: row.taskId, status: resolved.status, confirmed: resolved.confirmed,
      shotCount: shots.filter((shot) => shot.characters.includes(row.name)).length,
    };
  });
}

function scenesView(db: AppDatabase, conversationId: string, shots: StoryboardShot[]): StoryboardScene[] {
  return sceneRows(db, conversationId).map((row) => {
    const resolved = resolveSetting(db, row);
    return {
      id: row.id, name: row.name, prompt: row.prompt,
      assetId: row.assetId, asset: resolved.assetView, source: resolved.source,
      taskId: row.taskId, status: resolved.status, confirmed: resolved.confirmed,
      shotCount: shots.filter((shot) => shot.scene === row.name).length,
    };
  });
}

interface ResolvedReference {
  asset: AssetRow | null;
  mode: "auto" | "manual" | "off";
}

/** 老分镜（没有角色/场景标签）的全局参考 */
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

export function buildStoryboardView(db: AppDatabase, conversationId: string): StoryboardView {
  const aliases = buildCapabilityAliases(db.listChannels());
  /*
   * 分镜暂时只做图片：老数据里标成 video 的镜头也按图片读。
   * 不改数据库里的 kind，以后要恢复视频时不用做数据迁移。
   */
  const shots = db.listStoryboardShots(conversationId)
    .map((shot) => ({ ...shot, kind: "image" as const }));
  return {
    shots,
    canGenerateImage: Boolean(resolveAlias(aliases, undefined, "image", db.getSetting("agentDefaultImageAlias") ?? undefined)),
    canGenerateVideo: Boolean(resolveAlias(aliases, undefined, "video", db.getSetting("agentDefaultVideoAlias") ?? undefined)),
    maxBatch: MAX_STORYBOARD_BATCH,
    reference: referenceView(db, resolveReference(db, conversationId, shots), shots),
    characters: charactersView(db, conversationId, shots),
    scenes: scenesView(db, conversationId, shots),
  };
}

// ── 设定图 ─────────────────────────────────────────────────────────────────

function characterSettingPrompt(name: string, prompt: string) {
  const detail = prompt.trim();
  return [
    `角色设定图：${name}。`,
    detail ? `${detail}。` : "",
    "单人角色设定图，正面半身像，清晰完整地展示脸型、五官、发型、肤色、年龄和服装，",
    "干净纯色背景，均匀柔光，写实电影质感，不要文字，不要多余人物。",
  ].join("");
}

function sceneSettingPrompt(name: string, prompt: string) {
  const detail = prompt.trim();
  return [
    `场景设定图：${name}。`,
    detail ? `${detail}。` : "",
    "无人空镜，广角建立镜头，完整展示空间布局、主要陈设、光线方向和整体色调，",
    "写实电影质感，不要人物，不要文字。",
  ].join("");
}

/**
 * 生成角色 / 场景设定图。
 *
 * 只提交、不等待；结果由 `buildStoryboardView` 从任务表实时解析出来。
 * 一次最多 8 张，和分镜批次同一个上限。
 */
export async function generateStoryboardSettings(input: {
  db: AppDatabase;
  runner: TaskRunner;
  conversationId: string;
  characterIds: string[];
  sceneIds: string[];
  /** 用户在面板里选中的生图模型 alias；不传就回到默认生图模型 */
  alias?: string;
}): Promise<StoryboardSettingsResult> {
  const { db, runner, conversationId } = input;
  const characterIds = [...new Set(input.characterIds)];
  const sceneIds = [...new Set(input.sceneIds)];
  const total = characterIds.length + sceneIds.length;
  if (!total) throw new AppError("STORYBOARD_SETTING_EMPTY", "没有选中任何设定图", 400);
  if (total > MAX_STORYBOARD_BATCH) {
    throw new AppError("STORYBOARD_SETTING_TOO_LARGE", `一次最多生成 ${MAX_STORYBOARD_BATCH} 张设定图`, 400);
  }

  const aliases = buildCapabilityAliases(db.listChannels());
  const resolution = resolveAlias(aliases, input.alias, "image", db.getSetting("agentDefaultImageAlias") ?? undefined);
  if (!resolution) throw new AppError("NO_IMAGE_CHANNEL", "还没有可用的生图渠道", 400);
  const channel = db.getChannel(resolution.channelId);
  if (!channel || !channel.enabled) throw new AppError("CHANNEL_NOT_FOUND", "解析到的生图渠道不存在或未启用", 404);

  const failures: StoryboardSettingsResult["failures"] = [];
  let submitted = 0;

  async function submit(kind: "character" | "scene", id: string, name: string, prompt: string) {
    try {
      const created = await runner.create({
        channelId: channel!.id,
        model: resolution!.model,
        prompt,
        count: 1,
        aspectRatio: kind === "character" ? "1:1" : "16:9",
      });
      if (kind === "character") db.setStoryboardCharacterTask(id, created.id);
      else db.setStoryboardSceneTask(id, created.id);
      submitted += 1;
    } catch (error) {
      failures.push({ id, name, kind, error: error instanceof Error ? error.message : "提交失败" });
    }
  }

  await Promise.all([
    ...characterIds.map(async (id) => {
      const row = db.getStoryboardCharacter(id);
      if (!row || row.conversationId !== conversationId) {
        failures.push({ id, name: id, kind: "character", error: "角色不存在" });
        return;
      }
      await submit("character", id, row.name, characterSettingPrompt(row.name, row.prompt));
    }),
    ...sceneIds.map(async (id) => {
      const row = db.getStoryboardScene(id);
      if (!row || row.conversationId !== conversationId) {
        failures.push({ id, name: id, kind: "scene", error: "场景不存在" });
        return;
      }
      await submit("scene", id, row.name, sceneSettingPrompt(row.name, row.prompt));
    }),
  ]);

  return { submitted, failures, view: buildStoryboardView(db, conversationId) };
}

// ── 分镜图 ─────────────────────────────────────────────────────────────────

function referencePrefix(characters: Array<{ name: string }>, scene?: { name: string }): string {
  if (!characters.length && !scene) return "";
  const labels: string[] = [];
  characters.forEach((character, index) => labels.push(`参考图 ${index + 1} 是角色「${character.name}」`));
  if (scene) labels.push(`参考图 ${labels.length + 1} 是场景「${scene.name}」`);
  const constraints = [
    characters.length ? "严格保持参考图中对应人物的脸型、五官、发型、肤色、服装完全一致" : "",
    scene ? "保持参考场景的空间布局、主要陈设、光线方向和色调一致" : "",
    "只改变机位、姿态与构图",
  ].filter(Boolean).join("；");
  return `${labels.join("；")}。${constraints}：\n`;
}

/**
 * 提交选中的分镜。
 *
 * 有角色/场景标签时走「设定图」路线：每一镜把相关角色和场景的设定图一起发出去。
 * 缺设定图或未确认的镜头会明确失败并带镜号，不会悄悄在没有参考的情况下生成。
 */
export async function generateStoryboardShots(input: {
  db: AppDatabase;
  runner: TaskRunner;
  conversationId: string;
  shotIds: string[];
  /** 用户在面板里选中的生图模型 alias；不传就回到默认生图模型 */
  alias?: string;
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
  // 分镜暂时只出图片；库里历史 video 镜头也按图片提交，不动原数据
  const selected = (shots as StoryboardShot[]).map((shot) => ({ ...shot, kind: "image" as const }));
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
  const sceneReferences: StoryboardGenerateResult["sceneReferences"] = [];
  let note: string | undefined;
  let referenceAssetId: string | null = null;

  const characterSettings = new Map(
    characterRows(db, conversationId).map((row) => [row.name, resolveSetting(db, row)]),
  );
  const sceneSettings = new Map(
    sceneRows(db, conversationId).map((row) => [row.name, resolveSetting(db, row)]),
  );
  const hasTags = all.some((shot) => shot.characters.length > 0 || Boolean(shot.scene));

  const uploadCache = new Map<string, ReferenceImageUpload[]>();
  async function uploadsFor(asset: AssetRow): Promise<ReferenceImageUpload[]> {
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

  async function submitShot(
    shot: StoryboardShot,
    uploads: ReferenceImageUpload[],
    promptPrefix: string,
  ): Promise<{ ok: true; taskId: string } | { ok: false; error: string }> {
    try {
      const resolution = resolveAlias(aliases, input.alias, shot.kind, defaults[shot.kind]);
      if (!resolution) return { ok: false, error: shot.kind === "video" ? "没有可用的视频渠道" : "没有可用的生图渠道" };
      const channel = db.getChannel(resolution.channelId);
      if (!channel || !channel.enabled) return { ok: false, error: "解析到的渠道不存在或未启用" };

      const generation: GenerationInput = shot.kind === "video"
        ? videoInput(shot, channel.id, resolution.model, channel.adapterType)
        : {
          channelId: channel.id,
          model: resolution.model,
          prompt: `${promptPrefix}${shot.prompt}`,
          count: 1,
          ...(shot.aspectRatio ? { aspectRatio: shot.aspectRatio } : {}),
        };

      const created = await runner.create(generation, shot.kind === "image" ? uploads : []);
      db.updateStoryboardShot(shot.id, { taskId: created.id });
      return { ok: true, taskId: created.id };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "提交失败" };
    }
  }

  if (hasTags) {
    // ── 设定图路线：角色 + 场景一起带 ──────────────────────────────────────
    const jobs: Array<Promise<void>> = [];
    for (const shot of selected) {
      if (shot.kind !== "image") {
        jobs.push(submitShot(shot, [], "").then((outcome) => {
          if (!outcome.ok) failures.push({ shotId: shot.id, index: shot.index, error: outcome.error });
        }));
        continue;
      }

      const requiredCharacters = shot.characters;
      const requiredScene = shot.scene.trim();
      const problems: string[] = [];
      for (const name of requiredCharacters) {
        const setting = characterSettings.get(name);
        if (!setting?.asset) problems.push(`角色「${name}」还没有设定图`);
        else if (!setting.confirmed) problems.push(`角色「${name}」的设定图还没确认`);
      }
      if (requiredScene) {
        const setting = sceneSettings.get(requiredScene);
        if (!setting?.asset) problems.push(`场景「${requiredScene}」还没有设定图`);
        else if (!setting.confirmed) problems.push(`场景「${requiredScene}」的设定图还没确认`);
      }
      if (problems.length) {
        failures.push({ shotId: shot.id, index: shot.index, error: problems.join("；") });
        continue;
      }

      const characterAssets = requiredCharacters.map((name) => characterSettings.get(name)!.asset!);
      const sceneAsset = requiredScene ? sceneSettings.get(requiredScene)!.asset! : null;
      const uploads: ReferenceImageUpload[] = [];
      const seen = new Set<string>();
      for (const asset of [...characterAssets, ...(sceneAsset ? [sceneAsset] : [])]) {
        if (seen.has(asset.id)) continue;
        seen.add(asset.id);
        uploads.push(...await uploadsFor(asset));
      }
      if (!uploads.length) {
        failures.push({ shotId: shot.id, index: shot.index, error: "设定图读取失败，无法作为参考" });
        continue;
      }

      for (const [index, name] of requiredCharacters.entries()) {
        if (!characterReferences.some((item) => item.character === name)) {
          characterReferences.push({ character: name, assetId: characterAssets[index]!.id });
        }
      }
      if (requiredScene && !sceneReferences.some((item) => item.scene === requiredScene)) {
        sceneReferences.push({ scene: requiredScene, assetId: sceneAsset!.id });
      }

      const prefix = referencePrefix(
        requiredCharacters.map((name) => ({ name })),
        requiredScene ? { name: requiredScene } : undefined,
      );
      jobs.push(submitShot(shot, uploads, prefix).then((outcome) => {
        if (!outcome.ok) failures.push({ shotId: shot.id, index: shot.index, error: outcome.error });
      }));
    }
    await Promise.all(jobs);
  } else {
    // ── 老分镜：沿用全局参考 ─────────────────────────────────────────────────
    const resolved = resolveReference(db, conversationId, all);
    let reference = resolved.asset;
    const imageShots = selected.filter((shot) => shot.kind === "image").sort((left, right) => left.index - right.index);
    let baseShotId: string | null = null;
    if (!reference && resolved.mode === "auto" && imageShots.length >= 2) {
      const base = imageShots.find(shotNeedsCharacterReference) ?? imageShots[0]!;
      const submittedBase = await submitShot(base, [], "");
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
    const uploads = reference ? await uploadsFor(reference) : [];
    if (reference && !uploads.length) {
      reference = null;
      note = "角色参考图读取失败，本次未使用参考图。";
    }
    referenceAssetId = reference?.id ?? null;
    await Promise.all(selected
      .filter((shot) => shot.id !== baseShotId)
      .map(async (shot) => {
        const prefix = uploads.length && shotNeedsCharacterReference(shot) ? STORYBOARD_CHARACTER_PREFIX : "";
        const outcome = await submitShot(shot, prefix ? uploads : [], prefix);
        if (!outcome.ok) failures.push({ shotId: shot.id, index: shot.index, error: outcome.error });
      }));
  }

  return {
    submitted: selected.length - failures.length,
    failures: failures.sort((left, right) => left.index - right.index),
    shots: db.listStoryboardShots(conversationId),
    referenceAssetId,
    characterReferences,
    sceneReferences,
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
