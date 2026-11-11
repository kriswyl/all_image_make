import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { z } from "zod";
import { type AppDatabase } from "../db.js";
import type { KeyStore } from "../key-store.js";
import { AppError } from "../tasks.js";
import { safeFileName } from "../security.js";
import { callBrain } from "../brain.js";
import { storyboardProjectDataSchema } from "../../shared/storyboard-project.js";
import { resolveStoryboardSelection } from "../storyboard-selection.js";
import { composeShotImagePrompt, composeShotVideoPrompt } from "../canvas-template.js";
import { buildDraftContent, buildDraftMeta, type DraftShot } from "../jianying-draft.js";
import { saveBoard } from "../board.js";
import { buildStoryboardTemplateInput, createCanvasTemplate } from "../canvas-template.js";
import { ok, fail, asyncHandler, routeParam } from "./http.js";
import type { Express } from "express";

export function registerStoryboardRoutes(app: Express, db: AppDatabase, sessionKeys: KeyStore) {
  app.get("/api/storyboard-projects/:id", (req, res) => {
    const project = db.getStoryboardProject(routeParam(req.params.id));
    if (!project) return res.status(404).json(fail("STORYBOARD_NOT_FOUND", "该分镜没有可编辑的审阅数据"));
    res.json(ok(project));
  });

  app.post("/api/storyboard-projects/:id/split", asyncHandler(async (req, res) => {
    const input = z.object({ revision: z.number().int().positive(), shotId: z.string().min(1).max(80) }).parse(req.body);
    const id = routeParam(req.params.id);
    const project = db.getStoryboardProject(id);
    if (!project) throw new AppError("STORYBOARD_NOT_FOUND", "分镜不存在", 404);
    if (project.revision !== input.revision) throw new AppError("STORYBOARD_CONFLICT", "分镜已更改，请重新加载", 409);
    const shot = project.data.shots.find((item) => item.id === input.shotId);
    if (!shot) throw new AppError("STORYBOARD_SHOT_NOT_FOUND", "镜头不存在", 404);
    const conversationId = db.getStoryboardProjectConversationId(id);
    const conversation = conversationId ? db.getConversation(conversationId) : null;
    const channel = conversation ? db.getChannel(conversation.brainChannelId) : null;
    if (!conversation || !channel?.enabled || channel.adapterType !== "openai-chat") throw new AppError("NO_CHAT_CHANNEL", "原对话模型不可用，请先配置对话渠道", 400);
    const key = sessionKeys.get(channel.id) || (channel.secretEnv ? process.env[channel.secretEnv] ?? "" : "");
    const response = await callBrain({ channel, key, model: conversation.brainModel, timeoutMs: 120000, messages: [
      { role: "system", content: "你是分镜师。把给定的一个镜头拆为 2 个连续镜头，只返回 JSON 对象 {shots:[{prompt,videoPrompt,dialogue,sourceText,shotSize,cameraMove}]}。prompt 写静态首帧，videoPrompt 写动作和运镜。保留剧情、人物、道具和时空，绝不虚构台词；原台词按顺序分配，不要重复。不得改变原文原意。只输出 JSON。" },
      { role: "user", content: JSON.stringify({ brief: project.data.brief, shot }) },
    ] });
    if (db.getStoryboardProject(id)?.revision !== input.revision) throw new AppError("STORYBOARD_CONFLICT", "分镜在生成建议时已更改，请重新加载", 409);
    const clean = response.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let parsed: unknown;
    try { parsed = JSON.parse(clean); } catch { throw new AppError("STORYBOARD_SPLIT_INVALID", "模型没有返回有效的分镜建议，请重试", 502); }
    const schema = z.object({ shots: z.array(z.object({ prompt: z.string().trim().min(1).max(2000), videoPrompt: z.string().max(2000).default(""), dialogue: z.string().max(1000).default(""), sourceText: z.string().max(3000).default(""), shotSize: z.string().max(40).default(""), cameraMove: z.string().max(80).default("") })).length(2) });
    const parsedResult = schema.safeParse(parsed);
    if (!parsedResult.success) throw new AppError("STORYBOARD_SPLIT_INVALID", "模型返回的拆分建议不完整，请重试", 502);
    res.json(ok({ shots: parsedResult.data.shots }));
  }));

  app.get("/api/storyboard-projects/:id/preview", (req, res) => {
    const project = db.getStoryboardProject(routeParam(req.params.id));
    if (!project) return res.status(404).json(fail("STORYBOARD_NOT_FOUND", "分镜不存在"));
    const boards = db.listBoardRecords().flatMap((board) => {
      const nodes = board.doc.nodes.filter((node) => node.storyboard?.projectId === project.id);
      if (!nodes.length) return [];
      const shots = project.data.shots.map((shot) => {
        const getAsset = (role: "image" | "video" | "audio") => {
          const node = [...nodes].reverse().find((item) => item.storyboard?.shotId === shot.id && item.storyboard.role === role && (item.type === "image" || item.type === "video" || item.type === "audio"));
          if (!node || (node.type !== "image" && node.type !== "video" && node.type !== "audio") || !node.assetId) return null;
          const asset = db.getAsset(node.assetId);
          return asset ? db.assetView(asset) : null;
        };
        return { shotId: shot.id, image: getAsset("image"), video: getAsset("video"), audio: getAsset("audio") };
      });
      return [{ id: board.id, title: board.title, shots }];
    });
    res.json(ok(boards));
  });

  /**
   * 导出剪映草稿：把这一组分镜的成片按镜头顺序写成一份 6.x 草稿。
   *
   * 素材复制进草稿目录（剪映官方做法），目标目录由用户选——通常是
   * `%LOCALAPPDATA%\JianyingPro\User Data\Projects\com.lveditor.draft`。
   * 没有画面的镜头会被跳过，返回值里带 skipped，前端要如实告诉用户。
   */
  app.post("/api/storyboard-projects/:id/draft", asyncHandler(async (req, res) => {
    const input = z.object({
      boardId: z.string().min(1).max(80),
      targetDir: z.string().trim().min(1).max(1000),
      name: z.string().trim().max(80).optional(),
    }).parse(req.body);
    const project = db.getStoryboardProject(routeParam(req.params.id));
    if (!project) throw new AppError("STORYBOARD_NOT_FOUND", "分镜不存在", 404);
    const board = db.getBoardRecord(input.boardId);
    if (!board) throw new AppError("BOARD_NOT_FOUND", "画布不存在", 404);

    const linked = board.doc.nodes.filter((node) => node.storyboard?.projectId === project.id);
    const pickNode = (shotId: string, role: "image" | "video" | "audio") => {
      const node = [...linked].reverse().find((item) => item.storyboard?.shotId === shotId
        && item.storyboard.role === role
        && (item.type === "image" || item.type === "video" || item.type === "audio"));
      if (!node) return null;
      return node.type === "image" || node.type === "video" || node.type === "audio" ? node : null;
    };

    // 草稿文件夹名要留在剪映里给人看，不能用 safeFileName——它只留 ASCII，
    // 「安静的力量」会被洗成「____________」，所以在剪映里根本认不出是哪个草稿。
    const draftName = (input.name ?? `${project.data.name || "成片"}-剪映草稿`)
      .replace(/[\/:*?"<>|\u0000-\u001f]/g, "")
      .replace(/^\.+/, "")
      .trim()
      .slice(0, 60) || "剪映草稿";

    const hasAnyClip = project.data.shots.some((shot) => Boolean((pickNode(shot.id, "video") ?? pickNode(shot.id, "image"))?.assetId));
    if (!hasAnyClip) throw new AppError("DRAFT_EMPTY", "这组分镜在画布上还没有任何已生成的画面", 400);

    const draftDir = path.join(input.targetDir, draftName);
    const materialsDir = path.join(draftDir, "materials");
    await fs.promises.mkdir(materialsDir, { recursive: true });

    const copyMaterial = async (assetId: string, index: number): Promise<{ path: string; name: string; bytes: number; durationUs: number } | null> => {
      const row = db.getAsset(assetId);
      if (!row) return null;
      const source = path.join(row.baseDir, row.relativePath);
      if (!fs.existsSync(source)) return null;
      const fileName = `${String(index).padStart(3, "0")}-${safeFileName(row.fileName) || path.basename(row.relativePath)}`;
      const target = path.join(materialsDir, fileName);
      await fs.promises.copyFile(source, target);
      return { path: target, name: fileName, bytes: row.byteSize, durationUs: Math.round((row.duration ?? 0) * 1_000_000) };
    };

    const shots: DraftShot[] = [];
    let skipped = 0;
    let materialBytes = 0;
    for (const [index, shot] of project.data.shots.entries()) {
      const videoNode = pickNode(shot.id, "video");
      const imageNode = pickNode(shot.id, "image");
      const audioNode = pickNode(shot.id, "audio");
      const clipNode = videoNode ?? imageNode;
      if (!clipNode?.assetId) { skipped += 1; continue; }
      const clip = await copyMaterial(clipNode.assetId, index + 1);
      if (!clip) { skipped += 1; continue; }
      materialBytes += clip.bytes;
      const audio = audioNode?.assetId ? await copyMaterial(audioNode.assetId, index + 1) : null;
      if (audio) materialBytes += audio.bytes;

      const wanted = Math.max(0.4, shot.duration ?? 3);
      const available = clip.durationUs > 0 ? clip.durationUs / 1_000_000 : wanted;
      const durationUs = Math.round(Math.min(wanted, available) * 1_000_000);
      shots.push({
        clipKind: clipNode.type === "video" ? "video" : "photo",
        clip: { path: clip.path, name: clip.name, durationUs: clip.durationUs },
        ...(audio ? { audio: { path: audio.path, name: audio.name, durationUs: audio.durationUs } } : {}),
        durationUs,
      });
    }

    if (!shots.length) throw new AppError("DRAFT_EMPTY", "这组分镜在画布上还没有任何已生成的画面", 400);

    const ratio = project.data.brief?.aspectRatio ?? "";
    const matched = /^(\d{1,2})\s*[:：]\s*(\d{1,2})$/.exec(ratio.trim());
    const [width, height] = matched
      ? (Number(matched[1]) >= Number(matched[2])
        ? [1920, Math.round(1920 * Number(matched[2]) / Number(matched[1]))]
        : [Math.round(1920 * Number(matched[1]) / Number(matched[2])), 1920])
      : [1920, 1080];

    const { content, durationUs } = buildDraftContent({ name: draftName, width, height: height - (height % 2), shots });
    const draftId = crypto.randomUUID().toUpperCase();
    const meta = buildDraftMeta({ draftId, name: draftName, draftDir, rootDir: input.targetDir, durationUs, materialBytes });
    await fs.promises.writeFile(path.join(draftDir, "draft_content.json"), JSON.stringify(content, null, 2), "utf8");
    await fs.promises.writeFile(path.join(draftDir, "draft_meta_info.json"), JSON.stringify(meta, null, 2), "utf8");

    res.json(ok({ path: draftDir, clips: shots.length, skipped, durationSeconds: durationUs / 1_000_000 }));
  }));

  /**
   * 把分镜的改动同步到已经导入的画布节点。
   *
   * 分镜和画布是两份快照：审阅里改了景别 / 运镜 / 提示词，画布上那份不会自己变。
   * 这里按 storyboard 元数据把每镜重新拼一遍（和导入时用的是同一套拼装规则），
   * 逐块保存；哪块在别处刚改过就跳过，不硬盖。
   */
  app.post("/api/storyboard-projects/:id/sync-canvas", (req, res) => {
    const project = db.getStoryboardProject(routeParam(req.params.id));
    if (!project) throw new AppError("STORYBOARD_NOT_FOUND", "分镜不存在", 404);
    const at = new Date().toISOString();
    let boards = 0;
    let nodes = 0;
    const conflicts: string[] = [];

    for (const record of db.listBoardRecords()) {
      const doc = structuredClone(record.doc);
      let changed = false;
      for (const node of doc.nodes) {
        const meta = node.storyboard;
        if (!meta || meta.projectId !== project.id) continue;
        if (meta.role !== "image" && meta.role !== "video") continue;
        if (!("prompt" in node)) continue;
        const shot = project.data.shots.find((item) => item.id === meta.shotId);
        if (!shot) continue;
        const next = meta.role === "image" ? composeShotImagePrompt(shot) : composeShotVideoPrompt(shot);
        if (node.prompt === next) continue;
        node.prompt = next;
        node.updatedAt = at;
        changed = true;
        nodes += 1;
      }
      if (!changed) continue;
      try {
        saveBoard(db, record.id, { doc, baseVersion: record.version, reason: "sync_storyboard" });
        boards += 1;
      } catch (error) {
        // 这一块刚被别处改过：跳过它，其它块照常同步
        if (error instanceof AppError && error.code === "BOARD_VERSION_CONFLICT") { conflicts.push(record.title); continue; }
        throw error;
      }
    }

    res.json(ok({ boards, nodes, conflicts }));
  });

  app.put("/api/storyboard-projects/:id", (req, res) => {
    const input = z.object({ revision: z.number().int().positive(), data: storyboardProjectDataSchema }).parse(req.body);
    const id = routeParam(req.params.id);
    for (const item of [...input.data.characters, ...input.data.scenes, ...input.data.props].flatMap((entry) => [entry, ...entry.variants])) {
      if (!item.assetId) continue;
      const asset = db.getAsset(item.assetId);
      const task = asset && db.getTaskRow(asset.taskId);
      const publicAsset = task?.libraryScope === "public" || (task?.libraryScope === "legacy" && db.listLibraryTaskViews().some((entry) => entry.id === task.id));
      if (!asset || !asset.mimeType.startsWith("image/") || !publicAsset) throw new AppError("STORYBOARD_ASSET_INVALID", `「${item.name}」的参考图不存在或不属于公共素材库`, 400);
    }
    if (!db.getStoryboardProject(id)) return res.status(404).json(fail("STORYBOARD_NOT_FOUND", "分镜不存在"));
    const project = db.updateStoryboardProject(id, input.revision, input.data);
    if (!project) return res.status(409).json(fail("STORYBOARD_CONFLICT", "分镜已在其他窗口修改，请重新加载后再保存"));
    res.json(ok(project));
  });

  app.post("/api/storyboard-projects/:id/templates", (req, res) => {
    const input = z.object({ revision: z.number().int().positive(), shotIds: z.array(z.string().min(1).max(80)).min(1).max(30) }).parse(req.body);
    const project = db.getStoryboardProject(routeParam(req.params.id));
    if (!project) return res.status(404).json(fail("STORYBOARD_NOT_FOUND", "分镜不存在"));
    if (project.revision !== input.revision) return res.status(409).json(fail("STORYBOARD_CONFLICT", "分镜已更改，请重新加载"));
    const ids = new Set(input.shotIds);
    if (ids.size !== input.shotIds.length || input.shotIds.some((id) => !project.data.shots.some((shot) => shot.id === id))) {
      return res.status(400).json(fail("STORYBOARD_SHOTS_INVALID", "所选镜头不存在或重复"));
    }
    const { shots, characters, scenes, props } = resolveStoryboardSelection(project.data, ids);
    const template = createCanvasTemplate(db, buildStoryboardTemplateInput({
      name: project.data.name, projectId: project.id, description: `选择的 ${shots.length} 个镜头；导入后不会自动生成。`, shots, characters, scenes, props,
    }), { source: "storyboard" });
    const bindings = [...characters.map((item) => ({ title: `角色 · ${item.name}`.slice(0, 80), assetId: item.assetId })),
      ...scenes.map((item) => ({ title: `场景 · ${item.name}`.slice(0, 80), assetId: item.assetId })),
      ...props.map((item) => ({ title: `道具 · ${item.name}`.slice(0, 80), assetId: item.assetId }))];
    db.setStoryboardTemplateAssets(template.id, bindings.flatMap((binding) => {
      const node = template.doc.nodes.find((item) => item.type === "image" && item.title === binding.title);
      return node && binding.assetId ? [{ nodeId: node.id, assetId: binding.assetId }] : [];
    }));
    res.status(201).json(ok(template));
  });
}
