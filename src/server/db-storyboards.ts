import type { DatabaseSync } from "node:sqlite";
import type { AssetRepository, AssetRow } from "./db-assets.js";
import { now, stringArrayFromJson, type DbRow } from "./db-row.js";
import { isImageAsset, type Asset, type TaskStatus } from "../shared/types.js";
import {
  joinCharacterNames, parseCharacterNames,
  type StoryboardShot, type StoryboardShotKind, type StoryboardShotStatus, type StoryboardVideoMode,
} from "../shared/storyboard.js";
import { storyboardProjectDataSchema, type StoryboardProject, type StoryboardProjectData } from "../shared/storyboard-project.js";

export type ReplaceStoryboardShots = Array<{
  sourceText: string; prompt: string; kind: StoryboardShotKind; aspectRatio: string;
  character?: string; scene?: string;
  dialogue?: string; speaker?: string; shotSize?: string; cameraMove?: string;
  soundEffect?: string; durationSeconds?: number; videoPrompt?: string; voice?: string;
}>;

export type StoryboardSettings = {
  characters?: Array<{ name: string; prompt?: string }>;
  scenes?: Array<{ name: string; prompt?: string }>;
};

export type StoryboardShotPatch = Partial<Pick<StoryboardShot,
  | "prompt" | "sourceText" | "character" | "scene" | "kind" | "aspectRatio"
  | "dialogue" | "speaker" | "shotSize" | "cameraMove" | "soundEffect"
  | "durationSeconds" | "videoPrompt" | "voice" | "videoMode"
  | "firstFrameAssetId" | "lastFrameAssetId" | "referenceAssetIds" | "parentShotId"
  | "taskId" | "videoTaskId" | "voiceTaskId">>;

export type CreateStoryboardShotInput = {
  prompt?: string; character?: string; scene?: string; aspectRatio?: string;
  dialogue?: string; speaker?: string; shotSize?: string; cameraMove?: string;
  soundEffect?: string; durationSeconds?: number; videoPrompt?: string; voice?: string;
  videoMode?: StoryboardVideoMode; firstFrameAssetId?: string | null; lastFrameAssetId?: string | null;
  referenceAssetIds?: string[]; parentShotId?: string | null;
};

export type SaveStoryboardMigrationInput = {
  conversationId: string; boardId: string; templateId: string; version: number;
};

export class StoryboardRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly assets: Pick<AssetRepository, "getAsset" | "listAssets" | "assetView" | "assetFromRow">,
  ) {}

  normalizeStoryboardCharacterNames() {
    const rows = this.db.prepare(
      "SELECT conversation_id, character_name FROM conversation_shots WHERE character_name <> ''",
    ).all() as Array<{ conversation_id: string; character_name: string }>;
    const byConversation = new Map<string, string[]>();
    for (const row of rows) {
      const names = parseCharacterNames(row.character_name);
      if (names.length < 2) continue;
      byConversation.set(row.conversation_id, [
        ...(byConversation.get(row.conversation_id) ?? []), ...names,
      ]);
    }
    for (const [conversationId, names] of byConversation) {
      this.upsertStoryboardCharacters(conversationId, names);
    }
    // 拆开之后旧的「林小满、老陈」组合卡就没用了；现在设定栏会显示 0 镜的角色，
    // 不删掉会让用户看到两张永远没有镜头的重复卡。只清没绑图的，避免误删用户资产。
    this.db.prepare(`
      DELETE FROM conversation_characters
      WHERE asset_id IS NULL AND task_id IS NULL
        AND (instr(name, '、') > 0 OR instr(name, '，') > 0 OR instr(name, ',') > 0
          OR instr(name, '/') > 0 OR instr(name, '／') > 0
          OR instr(name, '+') > 0 OR instr(name, '&') > 0)
    `).run();
  }

  /**
   * 整表替换一个会话的分镜。
   *
   * 重新拆镜是「用户拿了一份新脚本」或「上一版拆得不对」——保留旧镜号只会让
   * 「第 7 镜」指到两张不同的画面上。已经生成的产物仍在生成历史里，不会丢。
   */
  replaceStoryboard(
    conversationId: string,
    shots: ReplaceStoryboardShots,
    settings: StoryboardSettings = {},
  ): StoryboardShot[] {
    const at = now();
    this.db.prepare("DELETE FROM conversation_shots WHERE conversation_id = ?").run(conversationId);
    // 重新拆镜会生成全新的 shot id；旧镜头的拖拽位置留着也没人再引用，顺手清掉
    this.db.prepare(
      "DELETE FROM conversation_graph_positions WHERE conversation_id = ? AND (node_id LIKE 'shot:%' OR node_id LIKE 'video:%' OR node_id LIKE 'voice:%')",
    ).run(conversationId);
    const insert = this.db.prepare(`
      INSERT INTO conversation_shots
      (id, conversation_id, shot_index, source_text, prompt, character_name, scene_name, kind, aspect_ratio,
       dialogue, speaker, shot_size, camera_move, sound_effect, duration_seconds, video_prompt, voice,
       task_id, video_task_id, voice_task_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
    `);
    for (const [position, shot] of shots.entries()) {
      insert.run(
        crypto.randomUUID(), conversationId, position + 1,
        shot.sourceText, shot.prompt, shot.character ?? "", shot.scene ?? "", shot.kind, shot.aspectRatio,
        shot.dialogue ?? "", shot.speaker ?? "", shot.shotSize ?? "", shot.cameraMove ?? "",
        shot.soundEffect ?? "", shot.durationSeconds ?? 5, shot.videoPrompt ?? "", shot.voice ?? "Kore",
        at, at,
      );
    }
    // 设定表里的名字和镜头里实际用到的名字取并集：模型偶尔会漏写一个设定，
    // 不能让那一镜变成「没有设定卡」的孤儿。
    this.upsertStoryboardCharacters(conversationId, [
      ...(settings.characters ?? []),
      ...shots.flatMap((shot) => parseCharacterNames(shot.character ?? "")).map((name) => ({ name })),
    ]);
    this.upsertStoryboardScenes(conversationId, [
      ...(settings.scenes ?? []),
      ...shots.map((shot) => shot.scene ?? "").filter(Boolean).map((name) => ({ name })),
    ]);
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, conversationId);
    return this.listStoryboardShots(conversationId);
  }

  /**
   * 把角色名补进 characters 表。`林小满、老陈` 会被拆成两个独立角色；
   * 同名角色已存在时只更新提示词（如果这次给了），不会清掉已绑定的设定图。
   */
  upsertStoryboardCharacters(conversationId: string, items: Array<string | { name: string; prompt?: string }>) {
    const seen = new Set<string>();
    const at = now();
    const insert = this.db.prepare(`
      INSERT INTO conversation_characters (id, conversation_id, name, prompt, asset_id, task_id, confirmed, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, NULL, 0, ?, ?)
      ON CONFLICT(conversation_id, name) DO UPDATE SET
        prompt = CASE WHEN excluded.prompt <> '' THEN excluded.prompt ELSE conversation_characters.prompt END,
        updated_at = excluded.updated_at
    `);
    for (const item of items) {
      const name = typeof item === "string" ? item : item.name;
      const prompt = typeof item === "string" ? "" : item.prompt?.trim() ?? "";
      for (const part of parseCharacterNames(name)) {
        if (seen.has(part)) continue;
        seen.add(part);
        insert.run(crypto.randomUUID(), conversationId, part, prompt, at, at);
      }
    }
  }

  upsertStoryboardScenes(conversationId: string, items: Array<string | { name: string; prompt?: string }>) {
    const seen = new Set<string>();
    const at = now();
    const insert = this.db.prepare(`
      INSERT INTO conversation_scenes (id, conversation_id, name, prompt, asset_id, task_id, confirmed, created_at, updated_at)
      VALUES (?, ?, ?, ?, NULL, NULL, 0, ?, ?)
      ON CONFLICT(conversation_id, name) DO UPDATE SET
        prompt = CASE WHEN excluded.prompt <> '' THEN excluded.prompt ELSE conversation_scenes.prompt END,
        updated_at = excluded.updated_at
    `);
    for (const item of items) {
      const name = (typeof item === "string" ? item : item.name).trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const prompt = typeof item === "string" ? "" : item.prompt?.trim() ?? "";
      insert.run(crypto.randomUUID(), conversationId, name, prompt, at, at);
    }
  }

  listStoryboardCharacters(conversationId: string): Array<{
    id: string; name: string; prompt: string; voice: string; assetId: string | null; taskId: string | null;
    confirmed: boolean; createdAt: string; updatedAt: string;
  }> {
    const rows = this.db.prepare(
      "SELECT * FROM conversation_characters WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC",
    ).all(conversationId) as DbRow[];
    return rows.map((row) => ({
      id: String(row.id), name: String(row.name), prompt: String(row.prompt ?? ""),
      voice: String(row.voice ?? ""),
      assetId: row.asset_id == null ? null : String(row.asset_id),
      taskId: row.task_id == null ? null : String(row.task_id),
      confirmed: Boolean(row.confirmed),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }));
  }

  listStoryboardScenes(conversationId: string): Array<{
    id: string; name: string; prompt: string; assetId: string | null; taskId: string | null;
    confirmed: boolean; createdAt: string; updatedAt: string;
  }> {
    const rows = this.db.prepare(
      "SELECT * FROM conversation_scenes WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC",
    ).all(conversationId) as DbRow[];
    return rows.map((row) => ({
      id: String(row.id), name: String(row.name), prompt: String(row.prompt ?? ""),
      assetId: row.asset_id == null ? null : String(row.asset_id),
      taskId: row.task_id == null ? null : String(row.task_id),
      confirmed: Boolean(row.confirmed),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    }));
  }

  getStoryboardCharacter(id: string): {
    id: string; conversationId: string; name: string; prompt: string; voice: string; assetId: string | null;
    taskId: string | null; confirmed: boolean;
  } | null {
    const row = this.db.prepare("SELECT * FROM conversation_characters WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) return null;
    return {
      id: String(row.id), conversationId: String(row.conversation_id), name: String(row.name),
      prompt: String(row.prompt ?? ""), voice: String(row.voice ?? ""),
      assetId: row.asset_id == null ? null : String(row.asset_id),
      taskId: row.task_id == null ? null : String(row.task_id), confirmed: Boolean(row.confirmed),
    };
  }

  getStoryboardScene(id: string): {
    id: string; conversationId: string; name: string; prompt: string; assetId: string | null;
    taskId: string | null; confirmed: boolean;
  } | null {
    const row = this.db.prepare("SELECT * FROM conversation_scenes WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) return null;
    return {
      id: String(row.id), conversationId: String(row.conversation_id), name: String(row.name),
      prompt: String(row.prompt ?? ""), assetId: row.asset_id == null ? null : String(row.asset_id),
      taskId: row.task_id == null ? null : String(row.task_id), confirmed: Boolean(row.confirmed),
    };
  }

  setStoryboardCharacterAsset(characterId: string, assetId: string | null) {
    // 换图后必须重新确认：旧图的确认不能顺延到新图
    this.db.prepare("UPDATE conversation_characters SET asset_id = ?, confirmed = 0, updated_at = ? WHERE id = ?")
      .run(assetId, now(), characterId);
  }

  setStoryboardSceneAsset(sceneId: string, assetId: string | null) {
    this.db.prepare("UPDATE conversation_scenes SET asset_id = ?, confirmed = 0, updated_at = ? WHERE id = ?")
      .run(assetId, now(), sceneId);
  }

  setStoryboardCharacterPrompt(characterId: string, prompt: string) {
    this.db.prepare("UPDATE conversation_characters SET prompt = ?, updated_at = ? WHERE id = ?")
      .run(prompt, now(), characterId);
  }

  setStoryboardCharacterVoice(characterId: string, voice: string) {
    this.db.prepare("UPDATE conversation_characters SET voice = ?, updated_at = ? WHERE id = ?")
      .run(voice, now(), characterId);
  }

  setStoryboardScenePrompt(sceneId: string, prompt: string) {
    this.db.prepare("UPDATE conversation_scenes SET prompt = ?, updated_at = ? WHERE id = ?")
      .run(prompt, now(), sceneId);
  }

  setStoryboardCharacterTask(characterId: string, taskId: string | null) {
    // 重生成时清掉手动绑定：否则「手动图优先」会让新生成的设定图永远显示不出来
    this.db.prepare("UPDATE conversation_characters SET task_id = ?, asset_id = NULL, confirmed = 0, updated_at = ? WHERE id = ?")
      .run(taskId, now(), characterId);
  }

  setStoryboardSceneTask(sceneId: string, taskId: string | null) {
    this.db.prepare("UPDATE conversation_scenes SET task_id = ?, asset_id = NULL, confirmed = 0, updated_at = ? WHERE id = ?")
      .run(taskId, now(), sceneId);
  }

  confirmStoryboardCharacter(characterId: string, confirmed: boolean) {
    this.db.prepare("UPDATE conversation_characters SET confirmed = ?, updated_at = ? WHERE id = ?")
      .run(confirmed ? 1 : 0, now(), characterId);
  }

  confirmStoryboardScene(sceneId: string, confirmed: boolean) {
    this.db.prepare("UPDATE conversation_scenes SET confirmed = ?, updated_at = ? WHERE id = ?")
      .run(confirmed ? 1 : 0, now(), sceneId);
  }

  /**
   * 分镜表视图：任务状态是**现在**从 tasks 表读出来的，不在分镜行里再存一份。
   *
   * 存一份就得处理「任务重启恢复」「后台轮询完成」「删除历史」三条写路径，
   * 而那三条都已经在维护 tasks 了；分镜只需要记住「最近一次挂在哪个 task 上」。
   */
  listStoryboardShots(conversationId: string): StoryboardShot[] {
    const rows = this.db.prepare(`
      SELECT s.*, t.status AS task_status, t.error_message AS task_error,
             vt.status AS video_task_status, vt.error_message AS video_task_error,
             nt.status AS voice_task_status, nt.error_message AS voice_task_error,
             (SELECT a.id FROM assets a WHERE a.task_id = s.task_id ORDER BY a.created_at ASC, a.rowid ASC LIMIT 1) AS result_asset_id,
             (SELECT a.id FROM assets a WHERE a.task_id = s.video_task_id ORDER BY a.created_at ASC, a.rowid ASC LIMIT 1) AS video_result_asset_id,
             (SELECT a.id FROM assets a WHERE a.task_id = s.voice_task_id ORDER BY a.created_at ASC, a.rowid ASC LIMIT 1) AS voice_result_asset_id
      FROM conversation_shots s
      LEFT JOIN tasks t ON t.id = s.task_id
      LEFT JOIN tasks vt ON vt.id = s.video_task_id
      LEFT JOIN tasks nt ON nt.id = s.voice_task_id
      WHERE s.conversation_id = ?
      ORDER BY s.shot_index ASC
    `).all(conversationId) as DbRow[];
    const resolve = (taskIdValue: unknown, statusValue: unknown, errorValue: unknown, assetIdValue: unknown) => {
      const id = taskIdValue == null ? null : String(taskIdValue);
      const taskStatus = statusValue == null ? null : String(statusValue) as TaskStatus;
      const assetId = assetIdValue == null ? null : String(assetIdValue);
      const assetRow = assetId ? this.assets.getAsset(assetId) : null;
      return {
        taskId: id,
        status: (id && taskStatus ? taskStatus : "planned") as StoryboardShotStatus,
        assetId: assetRow ? String(assetRow.id) : null,
        asset: assetRow ? this.assets.assetView(assetRow) : null,
        errorMessage: errorValue == null ? null : String(errorValue),
      };
    };
    const resolveImage = (value: unknown): { id: string | null; asset: Asset | null } => {
      const id = value == null ? null : String(value);
      if (!id) return { id: null, asset: null };
      const asset = this.assets.getAsset(id);
      return asset && isImageAsset(asset)
        ? { id: String(asset.id), asset: this.assets.assetView(asset) }
        : { id: null, asset: null };
    };
    return rows.map((row) => {
      const image = resolve(row.task_id, row.task_status, row.task_error, row.result_asset_id);
      const video = resolve(row.video_task_id, row.video_task_status, row.video_task_error, row.video_result_asset_id);
      const voice = resolve(row.voice_task_id, row.voice_task_status, row.voice_task_error, row.voice_result_asset_id);
      const firstFrame = resolveImage(row.first_frame_asset_id);
      const lastFrame = resolveImage(row.last_frame_asset_id);
      const referenceAssetIds: string[] = [];
      const referenceAssets: Asset[] = [];
      for (const id of stringArrayFromJson(row.reference_asset_ids)) {
        const resolved = resolveImage(id);
        if (!resolved.id || !resolved.asset) continue;
        referenceAssetIds.push(resolved.id);
        referenceAssets.push(resolved.asset);
      }
      return {
        id: String(row.id), conversationId: String(row.conversation_id),
        index: Number(row.shot_index),
        sourceText: String(row.source_text ?? ""), prompt: String(row.prompt ?? ""),
        character: String(row.character_name ?? ""),
        characters: parseCharacterNames(String(row.character_name ?? "")),
        scene: String(row.scene_name ?? ""),
        kind: String(row.kind) === "video" ? "video" as const : "image" as const,
        aspectRatio: String(row.aspect_ratio ?? ""),
        dialogue: String(row.dialogue ?? ""),
        speaker: String(row.speaker ?? ""),
        shotSize: String(row.shot_size ?? ""),
        cameraMove: String(row.camera_move ?? ""),
        soundEffect: String(row.sound_effect ?? ""),
        durationSeconds: Number(row.duration_seconds ?? 5),
        videoPrompt: String(row.video_prompt ?? ""),
        voice: String(row.voice ?? "Kore"),
        videoMode: (row.video_mode === "first-last-frame" || row.video_mode === "reference"
          ? row.video_mode : "first-frame") as StoryboardVideoMode,
        firstFrameAssetId: firstFrame.id, firstFrameAsset: firstFrame.asset,
        lastFrameAssetId: lastFrame.id, lastFrameAsset: lastFrame.asset,
        referenceAssetIds, referenceAssets,
        parentShotId: row.parent_shot_id == null ? null : String(row.parent_shot_id),
        taskId: image.taskId, status: image.status,
        assetId: image.assetId, asset: image.asset, errorMessage: image.errorMessage,
        videoTaskId: video.taskId, videoStatus: video.status,
        videoAssetId: video.assetId, videoAsset: video.asset, videoErrorMessage: video.errorMessage,
        voiceTaskId: voice.taskId, voiceStatus: voice.status,
        voiceAssetId: voice.assetId, voiceAsset: voice.asset, voiceErrorMessage: voice.errorMessage,
        createdAt: String(row.created_at), updatedAt: String(row.updated_at),
      };
    });
  }

  getStoryboardShot(id: string): StoryboardShot | null {
    const row = this.db.prepare("SELECT conversation_id FROM conversation_shots WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) return null;
    return this.listStoryboardShots(String(row.conversation_id)).find((shot) => shot.id === id) ?? null;
  }

  updateStoryboardShot(
    id: string,
    patch: StoryboardShotPatch,
  ): StoryboardShot | null {
    const fields: string[] = [];
    const values: Array<string | number | null> = [];
    const mapping: Record<string, string> = {
      prompt: "prompt", sourceText: "source_text", character: "character_name", scene: "scene_name",
      kind: "kind", aspectRatio: "aspect_ratio", taskId: "task_id",
      dialogue: "dialogue", speaker: "speaker", shotSize: "shot_size", cameraMove: "camera_move",
      soundEffect: "sound_effect", durationSeconds: "duration_seconds", videoPrompt: "video_prompt",
      voice: "voice", videoMode: "video_mode",
      firstFrameAssetId: "first_frame_asset_id", lastFrameAssetId: "last_frame_asset_id",
      referenceAssetIds: "reference_asset_ids", parentShotId: "parent_shot_id",
      videoTaskId: "video_task_id", voiceTaskId: "voice_task_id",
    };
    for (const [key, column] of Object.entries(mapping)) {
      if (!(key in patch)) continue;
      fields.push(`${column} = ?`);
      const value = (patch as Record<string, unknown>)[key];
      if (Array.isArray(value)) values.push(JSON.stringify(value));
      else values.push(typeof value === "number" ? value : (value ?? null) as string | null);
    }
    if (!fields.length) return this.getStoryboardShot(id);
    fields.push("updated_at = ?");
    values.push(now(), id);
    this.db.prepare(`UPDATE conversation_shots SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.getStoryboardShot(id);
  }

  hasStoryboard(conversationId: string): boolean {
    const row = this.db.prepare("SELECT 1 AS found FROM conversation_shots WHERE conversation_id = ? LIMIT 1")
      .get(conversationId) as DbRow | undefined;
    return Boolean(row);
  }

  countStoryboardShots(conversationId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM conversation_shots WHERE conversation_id = ?")
      .get(conversationId) as DbRow | undefined;
    return Number(row?.count ?? 0);
  }

  /** 镜头图里用户拖动过的节点坐标；没记录的节点继续走自动布局 */
  listStoryboardGraphPositions(conversationId: string): Record<string, { x: number; y: number }> {
    const rows = this.db.prepare(
      "SELECT node_id, x, y FROM conversation_graph_positions WHERE conversation_id = ?",
    ).all(conversationId) as DbRow[];
    const result: Record<string, { x: number; y: number }> = {};
    for (const row of rows) {
      result[String(row.node_id)] = { x: Number(row.x), y: Number(row.y) };
    }
    return result;
  }

  saveStoryboardGraphPositions(
    conversationId: string,
    positions: Array<{ id: string; x: number; y: number }>,
  ): void {
    if (!positions.length) return;
    const at = now();
    const upsert = this.db.prepare(`
      INSERT INTO conversation_graph_positions (conversation_id, node_id, x, y, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, node_id) DO UPDATE SET
        x = excluded.x, y = excluded.y, updated_at = excluded.updated_at
    `);
    this.db.exec("BEGIN");
    try {
      for (const position of positions) {
        upsert.run(conversationId, position.id, position.x, position.y, at);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, conversationId);
  }

  clearStoryboardGraphPositions(conversationId: string): number {
    const result = this.db.prepare(
      "DELETE FROM conversation_graph_positions WHERE conversation_id = ?",
    ).run(conversationId);
    return Number(result.changes ?? 0);
  }

  /** 分镜的角色参考设置。auto = 用第一个已完成的图片镜头，manual = 用指定产物，off = 不用 */
  getStoryboardReference(conversationId: string): { assetId: string | null; mode: "auto" | "manual" | "off" } {
    const row = this.db.prepare(
      "SELECT storyboard_reference_asset_id AS asset_id, storyboard_reference_mode AS mode FROM conversations WHERE id = ?",
    ).get(conversationId) as DbRow | undefined;
    const mode = row?.mode === "manual" || row?.mode === "off" ? row.mode : "auto";
    return { assetId: row?.asset_id == null ? null : String(row.asset_id), mode };
  }

  setStoryboardReference(conversationId: string, input: { assetId: string | null; mode: "auto" | "manual" | "off" }) {
    this.db.prepare(
      "UPDATE conversations SET storyboard_reference_asset_id = ?, storyboard_reference_mode = ?, updated_at = ? WHERE id = ?",
    ).run(input.mode === "manual" ? input.assetId : null, input.mode, now(), conversationId);
  }

  deleteStoryboard(conversationId: string): number {
    const result = this.db.prepare("DELETE FROM conversation_shots WHERE conversation_id = ?").run(conversationId);
    this.db.prepare("DELETE FROM conversation_characters WHERE conversation_id = ?").run(conversationId);
    this.db.prepare("DELETE FROM conversation_scenes WHERE conversation_id = ?").run(conversationId);
    this.db.prepare("DELETE FROM conversation_graph_positions WHERE conversation_id = ?").run(conversationId);
    return Number(result.changes ?? 0);
  }

  /**
   * 在末尾追加一镜。
   *
   * 默认沿用最后一镜的画幅，避免新镜头和其他镜头一个横一个竖；描述留空，
   * 由用户在面板里填——这里不替用户编画面，也不提交任何任务。
   */
  addStoryboardShot(conversationId: string, input: CreateStoryboardShotInput = {}): StoryboardShot {
    const last = this.db.prepare(
      "SELECT shot_index, aspect_ratio FROM conversation_shots WHERE conversation_id = ? ORDER BY shot_index DESC LIMIT 1",
    ).get(conversationId) as DbRow | undefined;
    const index = Number(last?.shot_index ?? 0) + 1;
    const aspectRatio = input.aspectRatio ?? (last?.aspect_ratio == null ? "" : String(last.aspect_ratio));
    const id = crypto.randomUUID();
    const at = now();
    this.db.prepare(`
      INSERT INTO conversation_shots
      (id, conversation_id, shot_index, source_text, prompt, character_name, scene_name, kind, aspect_ratio,
       dialogue, speaker, shot_size, camera_move, sound_effect, duration_seconds, video_prompt, voice,
       video_mode, first_frame_asset_id, last_frame_asset_id, reference_asset_ids, parent_shot_id,
       task_id, video_task_id, voice_task_id, created_at, updated_at)
      VALUES (?, ?, ?, '', ?, ?, ?, 'image', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
    `).run(
      id, conversationId, index, input.prompt ?? "", input.character ?? "", input.scene ?? "",
      aspectRatio, input.dialogue ?? "", input.speaker ?? "", input.shotSize ?? "", input.cameraMove ?? "",
      input.soundEffect ?? "", input.durationSeconds ?? 5, input.videoPrompt ?? "", input.voice ?? "Kore",
      input.videoMode ?? "first-frame", input.firstFrameAssetId ?? null, input.lastFrameAssetId ?? null,
      JSON.stringify(input.referenceAssetIds ?? []), input.parentShotId ?? null,
      at, at,
    );
    if (input.character) this.upsertStoryboardCharacters(conversationId, [input.character]);
    if (input.scene) this.upsertStoryboardScenes(conversationId, [input.scene]);
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, conversationId);
    return this.getStoryboardShot(id)!;
  }

  /**
   * 删除一镜，并把后面的镜号往前挪。
   *
   * 镜号是用户和大脑共同引用的坐标（「第 7 镜」），留着空洞会让「第 7 镜」
   * 指向一个已经不存在的位置；这里直接重排成连续的 1..N。
   */
  deleteStoryboardShot(shotId: string): { conversationId: string; index: number } | null {
    const row = this.db.prepare(
      "SELECT conversation_id, shot_index FROM conversation_shots WHERE id = ?",
    ).get(shotId) as DbRow | undefined;
    if (!row) return null;
    const conversationId = String(row.conversation_id);
    const index = Number(row.shot_index);
    const at = now();
    this.db.prepare("DELETE FROM conversation_shots WHERE id = ?").run(shotId);
    this.db.prepare(
      "DELETE FROM conversation_graph_positions WHERE conversation_id = ? AND node_id IN (?, ?, ?)",
    ).run(conversationId, `shot:${shotId}`, `video:${shotId}`, `voice:${shotId}`);
    this.db.prepare(
      "UPDATE conversation_shots SET parent_shot_id = NULL WHERE conversation_id = ? AND parent_shot_id = ?",
    ).run(conversationId, shotId);
    this.db.prepare(
      "UPDATE conversation_shots SET shot_index = shot_index - 1 WHERE conversation_id = ? AND shot_index > ?",
    ).run(conversationId, index);
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, conversationId);
    return { conversationId, index };
  }

  /**
   * 删除角色设定，并把它从所有镜头的角色标签里摘掉。
   *
   * 只删设定卡、不清理镜头的后果很具体：镜头仍然写着「小雨」，但左侧已经没有
   * 小雨的卡，生成时会被判成「角色还没有设定图」，整批卡住。
   */
  deleteStoryboardCharacter(characterId: string): { conversationId: string; name: string } | null {
    const row = this.db.prepare(
      "SELECT conversation_id, name FROM conversation_characters WHERE id = ?",
    ).get(characterId) as DbRow | undefined;
    if (!row) return null;
    const conversationId = String(row.conversation_id);
    const name = String(row.name);
    const at = now();
    this.db.prepare("DELETE FROM conversation_characters WHERE id = ?").run(characterId);
    this.db.prepare(
      "DELETE FROM conversation_graph_positions WHERE conversation_id = ? AND node_id = ?",
    ).run(conversationId, `character:${characterId}`);

    const shots = this.db.prepare(
      "SELECT id, character_name FROM conversation_shots WHERE conversation_id = ?",
    ).all(conversationId) as DbRow[];
    const update = this.db.prepare(
      "UPDATE conversation_shots SET character_name = ?, updated_at = ? WHERE id = ?",
    );
    for (const shot of shots) {
      const names = parseCharacterNames(String(shot.character_name ?? ""));
      if (!names.includes(name)) continue;
      update.run(joinCharacterNames(names.filter((item) => item !== name)), at, String(shot.id));
    }
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, conversationId);
    return { conversationId, name };
  }

  /** 删除场景设定；引用这个场景的镜头清空 scene_name（空镜仍然可以生成） */
  deleteStoryboardScene(sceneId: string): { conversationId: string; name: string } | null {
    const row = this.db.prepare(
      "SELECT conversation_id, name FROM conversation_scenes WHERE id = ?",
    ).get(sceneId) as DbRow | undefined;
    if (!row) return null;
    const conversationId = String(row.conversation_id);
    const name = String(row.name);
    const at = now();
    this.db.prepare("DELETE FROM conversation_scenes WHERE id = ?").run(sceneId);
    this.db.prepare(
      "DELETE FROM conversation_graph_positions WHERE conversation_id = ? AND node_id = ?",
    ).run(conversationId, `scene:${sceneId}`);
    this.db.prepare(
      "UPDATE conversation_shots SET scene_name = '', updated_at = ? WHERE conversation_id = ? AND scene_name = ?",
    ).run(at, conversationId, name);
    this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, conversationId);
    return { conversationId, name };
  }

  createStoryboardProject(id: string, conversationId: string, data: StoryboardProjectData): StoryboardProject {
    this.db.prepare("INSERT INTO storyboard_projects (id, conversation_id, revision, data_json, updated_at) VALUES (?, ?, 1, ?, ?)")
      .run(id, conversationId, JSON.stringify(data), now());
    return this.getStoryboardProject(id)!;
  }

  getStoryboardProjectConversationId(id: string): string | null {
    const row = this.db.prepare("SELECT conversation_id FROM storyboard_projects WHERE id = ?").get(id) as DbRow | undefined;
    return row ? String(row.conversation_id) : null;
  }

  getStoryboardProject(id: string): StoryboardProject | null {
    const row = this.db.prepare("SELECT * FROM storyboard_projects WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) return null;
    return { id: String(row.id), revision: Number(row.revision), data: storyboardProjectDataSchema.parse(JSON.parse(String(row.data_json))) };
  }

  updateStoryboardProject(id: string, revision: number, data: StoryboardProjectData): StoryboardProject | null {
    const result = this.db.prepare("UPDATE storyboard_projects SET data_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?")
      .run(JSON.stringify(data), now(), id, revision);
    return Number(result.changes) ? this.getStoryboardProject(id) : null;
  }

  assetHasStoryboardProjectReferences(assetId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM storyboard_projects p, json_each(p.data_json, '$.characters') c WHERE json_extract(c.value, '$.assetId') = ?
      UNION ALL SELECT 1 FROM storyboard_projects p, json_each(p.data_json, '$.scenes') s WHERE json_extract(s.value, '$.assetId') = ?
      UNION ALL SELECT 1 FROM storyboard_projects p, json_each(p.data_json, '$.characters') c, json_each(c.value, '$.variants') v WHERE json_extract(v.value, '$.assetId') = ?
      UNION ALL SELECT 1 FROM storyboard_projects p, json_each(p.data_json, '$.scenes') s, json_each(s.value, '$.variants') v WHERE json_extract(v.value, '$.assetId') = ?
      UNION ALL SELECT 1 FROM storyboard_projects p, json_each(p.data_json, '$.props') x WHERE json_extract(x.value, '$.assetId') = ?
      UNION ALL SELECT 1 FROM storyboard_projects p, json_each(p.data_json, '$.props') x, json_each(x.value, '$.variants') v WHERE json_extract(v.value, '$.assetId') = ? LIMIT 1`).get(assetId, assetId, assetId, assetId, assetId, assetId));
  }

  taskHasStoryboardProjectReferences(taskId: string): boolean {
    return this.assets.listAssets(taskId).some((asset) => this.assetHasStoryboardProjectReferences(asset.id));
  }

  listStoryboardConversationIds(): string[] {
    const rows = this.db.prepare(
      "SELECT DISTINCT conversation_id FROM conversation_shots ORDER BY conversation_id",
    ).all() as DbRow[];
    return rows.map((row) => String(row.conversation_id));
  }

  getStoryboardMigration(conversationId: string): {
    conversationId: string; boardId: string; templateId: string; version: number; createdAt: string;
  } | null {
    const row = this.db.prepare(
      "SELECT * FROM storyboard_migrations WHERE conversation_id = ?",
    ).get(conversationId) as DbRow | undefined;
    if (!row) return null;
    return {
      conversationId: String(row.conversation_id),
      boardId: String(row.board_id),
      templateId: String(row.template_id),
      version: Number(row.version ?? 1),
      createdAt: String(row.created_at),
    };
  }

  listStoryboardMigrations(): Array<{
    conversationId: string; boardId: string; templateId: string; version: number; createdAt: string;
  }> {
    const rows = this.db.prepare("SELECT * FROM storyboard_migrations ORDER BY created_at ASC").all() as DbRow[];
    return rows.map((row) => ({
      conversationId: String(row.conversation_id),
      boardId: String(row.board_id),
      templateId: String(row.template_id),
      version: Number(row.version ?? 1),
      createdAt: String(row.created_at),
    }));
  }

  saveStoryboardMigration(input: SaveStoryboardMigrationInput): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO storyboard_migrations
      (conversation_id, board_id, template_id, version, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.conversationId, input.boardId, input.templateId, input.version, now());
  }

  /**
   * 分镜生成出来的产物。
   *
   * 它们没有经过 Agent 的消息落库（分镜面板直接提交 runner），所以不在
   * `messages.asset_id` 那条线索上。但用户点「加画布」之后，画布要能找到它们——
   * 必须把这条来路补进 `buildView` 的素材集合。
   */
  listStoryboardAssets(conversationId: string): Array<{ asset: AssetRow; index: number; prompt: string }> {
    const rows = this.db.prepare(`
      SELECT assets.*, s.shot_index AS shot_index, s.prompt AS shot_prompt
      FROM conversation_shots s
      JOIN assets ON assets.task_id = s.task_id
      WHERE s.conversation_id = ?
      UNION ALL
      SELECT assets.*, s.shot_index AS shot_index, s.video_prompt AS shot_prompt
      FROM conversation_shots s
      JOIN assets ON assets.task_id = s.video_task_id
      WHERE s.conversation_id = ?
      UNION ALL
      SELECT assets.*, s.shot_index AS shot_index, s.dialogue AS shot_prompt
      FROM conversation_shots s
      JOIN assets ON assets.task_id = s.voice_task_id
      WHERE s.conversation_id = ?
      ORDER BY shot_index ASC, assets.created_at ASC
    `).all(conversationId, conversationId, conversationId) as DbRow[];
    return rows.map((row) => ({ asset: this.assets.assetFromRow(row), index: Number(row.shot_index), prompt: String(row.shot_prompt ?? "") }));
  }

  /** 角色 / 场景设定图（手动绑定的，或最近一次生成任务产出的） */
  listStoryboardSettingAssets(conversationId: string): Array<{ asset: AssetRow; label: string }> {
    const rows = this.db.prepare(`
      SELECT assets.*, '角色「' || c.name || '」' AS setting_label, 0 AS sort_group
      FROM conversation_characters c JOIN assets ON assets.id = c.asset_id
      WHERE c.conversation_id = ?
      UNION ALL
      SELECT assets.*, '角色「' || c.name || '」' AS setting_label, 0 AS sort_group
      FROM conversation_characters c JOIN assets ON assets.task_id = c.task_id
      WHERE c.conversation_id = ?
      UNION ALL
      SELECT assets.*, '场景「' || s.name || '」' AS setting_label, 1 AS sort_group
      FROM conversation_scenes s JOIN assets ON assets.id = s.asset_id
      WHERE s.conversation_id = ?
      UNION ALL
      SELECT assets.*, '场景「' || s.name || '」' AS setting_label, 1 AS sort_group
      FROM conversation_scenes s JOIN assets ON assets.task_id = s.task_id
      WHERE s.conversation_id = ?
      ORDER BY sort_group ASC, created_at ASC
    `).all(conversationId, conversationId, conversationId, conversationId) as DbRow[];
    const seen = new Set<string>();
    const result: Array<{ asset: AssetRow; label: string }> = [];
    for (const row of rows) {
      const id = String(row.id);
      if (seen.has(id)) continue;
      seen.add(id);
      result.push({ asset: this.assets.assetFromRow(row), label: String(row.setting_label ?? "设定图") });
    }
    return result;
  }
}
