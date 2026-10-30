/**
 * 无限画布模板：把对话里生成的结构实例化成真实节点。
 *
 * 模板本身只含节点 / 连线 / 分组和生成参数，不含素材。
 * 实例化时重新分配 node id、nX 引用、分组 id，并把坐标平移到目标位置。
 */
import crypto from "node:crypto";
import type { AppDatabase, BoardRecord } from "./db.js";
import { AppError } from "./tasks.js";
import { createBoard, getBoard } from "./board.js";
import {
  allocateNodeRef, boardGroups, BOARD_LIMITS, parseBoardDoc,
  type BoardDoc, type BoardGroup, type BoardNode,
} from "../shared/board.js";
import {
  type CanvasTemplate, type CanvasTemplateInput, type TemplateConfigInput,
} from "../shared/canvas-template.js";
import type { BoardView } from "../shared/board.js";

function now() {
  return new Date().toISOString();
}

function templateNodeId() {
  return `node-${crypto.randomUUID()}`;
}

function configNodeDefaults(config: TemplateConfigInput | undefined, title: string): Omit<BoardNode, "id" | "ref" | "x" | "y" | "width" | "height" | "createdAt" | "updatedAt"> & { type: "config" } {
  return {
    type: "config",
    title: title.slice(0, 80),
    mode: config?.mode ?? "image",
    prompt: config?.prompt ?? "",
    useUpstreamText: config?.useUpstreamText ?? true,
    count: config?.count ?? 1,
    status: "idle",
    ...(config?.model ? { model: config.model } : {}),
    ...(config?.size ? { size: config.size } : {}),
    ...(config?.imageSize ? { imageSize: config.imageSize } : {}),
    ...(config?.quality ? { quality: config.quality } : {}),
    ...(config?.negativePrompt ? { negativePrompt: config.negativePrompt } : {}),
    ...(config?.aspectRatio ? { aspectRatio: config.aspectRatio } : {}),
    ...(config?.seed === undefined ? {} : { seed: config.seed }),
    ...(config?.style ? { style: config.style } : {}),
    ...(config?.background ? { background: config.background } : {}),
    ...(config?.outputFormat ? { outputFormat: config.outputFormat } : {}),
    ...(config?.moderation ? { moderation: config.moderation } : {}),
    ...(config?.videoMode ? { videoMode: config.videoMode } : {}),
    ...(config?.durationSeconds ? { durationSeconds: config.durationSeconds } : {}),
    ...(config?.resolution ? { resolution: config.resolution } : {}),
    ...(config?.audio === undefined ? {} : { audio: config.audio }),
    ...(config?.promptExtend === undefined ? {} : { promptExtend: config.promptExtend }),
    ...(config?.watermark === undefined ? {} : { watermark: config.watermark }),
    ...(config?.audioKind ? { audioKind: config.audioKind } : {}),
    ...(config?.voice ? { voice: config.voice } : {}),
    ...(config?.ttsStyle ? { ttsStyle: config.ttsStyle } : {}),
    ...(config?.instrumental === undefined ? {} : { instrumental: config.instrumental }),
    ...(config?.musicTitle ? { musicTitle: config.musicTitle } : {}),
    ...(config?.musicTags ? { musicTags: config.musicTags } : {}),
    ...(config?.musicNegativeTags ? { musicNegativeTags: config.musicNegativeTags } : {}),
  } as never;
}

/** 把「临时 id」模板转成一份合法 BoardDoc；这是唯一创建模板文档的入口 */
export function templateInputToDoc(input: CanvasTemplateInput): BoardDoc {
  const at = now();
  const idByTemp = new Map<string, string>();
  const refByTemp = new Map<string, string>();
  let nextRef = 1;
  const nodes: BoardNode[] = [];
  for (const item of input.nodes) {
    if (idByTemp.has(item.tempId)) {
      throw new AppError("TEMPLATE_INVALID", `模板里的 tempId 重复：${item.tempId}`, 400);
    }
    const allocated = allocateNodeRef({ nodes, nextRef });
    nextRef = allocated.nextRef;
    const base = {
      id: templateNodeId(),
      ref: allocated.ref,
      x: item.x,
      y: item.y,
      createdAt: at,
      updatedAt: at,
      ...(item.storyboard ? { storyboard: item.storyboard } : {}),
    };
    let node: BoardNode;
    if (item.type === "text") {
      node = {
        ...base,
        type: "text",
        width: item.width ?? 300,
        height: item.height ?? 170,
        title: (item.title ?? "文本").slice(0, 80),
        text: item.text ?? "",
      };
    } else if (item.type === "image" || item.type === "video" || item.type === "audio") {
      const defaults = item.type === "image"
        ? { width: 280, height: 210, title: "图片占位" }
        : item.type === "video"
          ? { width: 320, height: 240, title: "视频占位" }
          : { width: 300, height: 110, title: "音频占位" };
      node = {
        ...base,
        type: item.type,
        width: item.width ?? defaults.width,
        height: item.height ?? defaults.height,
        title: (item.title ?? defaults.title).slice(0, 80),
        assetId: null,
        source: item.type === "audio" ? "generated" : "upload",
        status: "empty",
        ...(item.text ? { prompt: item.text } : {}),
      } as BoardNode;
    } else {
      node = {
        ...base,
        width: item.width ?? 330,
        height: item.height ?? 260,
        ...configNodeDefaults(item.config, item.title ?? "配置节点"),
      } as BoardNode;
    }
    nodes.push(node);
    idByTemp.set(item.tempId, node.id);
    refByTemp.set(item.tempId, node.ref);
  }

  const edges = (input.edges ?? []).map((edge) => {
    const source = idByTemp.get(edge.from);
    const target = idByTemp.get(edge.to);
    if (!source || !target) {
      throw new AppError(
        "TEMPLATE_INVALID",
        `连线 ${edge.from} → ${edge.to} 引用了不存在的节点`,
        400,
      );
    }
    return {
      id: `edge-${crypto.randomUUID()}`,
      source,
      target,
      kind: edge.kind ?? "input",
      ...(edge.role ? { role: edge.role } : {}),
    };
  });

  const groups: BoardGroup[] = [];
  for (const group of input.groups ?? []) {
    const nodeIds = group.nodeIds.map((tempId) => idByTemp.get(tempId)).filter((id): id is string => Boolean(id));
    if (nodeIds.length !== group.nodeIds.length) {
      throw new AppError("TEMPLATE_INVALID", `分组「${group.title}」里有不存在的节点`, 400);
    }
    groups.push({
      id: `group-${crypto.randomUUID()}`,
      title: group.title.slice(0, 80),
      nodeIds,
      collapsed: false,
    });
  }

  return parseBoardDoc({
    version: 1,
    nextRef,
    nodes,
    edges,
    groups,
  });
}

export function createCanvasTemplate(
  db: AppDatabase,
  input: CanvasTemplateInput,
  options: { source: CanvasTemplate["source"]; conversationId?: string | null } = { source: "agent" },
): CanvasTemplate {
  const doc = templateInputToDoc(input);
  return db.createCanvasTemplate({
    id: crypto.randomUUID(),
    name: input.name,
    description: input.description ?? "",
    source: options.source,
    conversationId: options.conversationId ?? null,
    doc,
  });
}

/**
 * 把一份模板实例化进已有文档。
 *
 * `target` 为空时表示新建板，从 (0,0) 开始；目标已有节点时放到右侧，
 * 不覆盖用户当前内容。
 */
function instantiateDoc(
  template: CanvasTemplate,
  target: BoardDoc | null,
  assetBindings: Map<string, string> = new Map(),
): { doc: BoardDoc; nodeCount: number } {
  const existing = target?.nodes ?? [];
  if (existing.length + template.doc.nodes.length > BOARD_LIMITS.maxNodes) {
    throw new AppError("BOARD_NODE_LIMIT", `模板放入后超过 ${BOARD_LIMITS.maxNodes} 个节点，请分几次导入`, 400);
  }
  const baseX = existing.length ? Math.max(...existing.map((node) => node.x + node.width)) + 240 : 0;
  const baseY = existing.length ? Math.min(...existing.map((node) => node.y)) : 0;
  const templateMinX = Math.min(...template.doc.nodes.map((node) => node.x));
  const templateMinY = Math.min(...template.doc.nodes.map((node) => node.y));
  const dx = baseX - templateMinX;
  const dy = baseY - templateMinY;

  const at = now();
  let nextRef = target?.nextRef ?? 1;
  const idMap = new Map<string, string>();
  const nodes: BoardNode[] = [];
  /**
   * 旧版分镜模板把角色 / 场景放在镜头左侧的同一段坐标里，导入后很容易和
   * 镜头区混在一起。模板来源是 storyboard 时，这里按标题重排成
   * 「角色一行、场景一行」，再整体平移到目标位置；用户自己设计的模板不动。
   */
  const referencePositions = new Map<string, { x: number; y: number }>();
  if (template.source === "storyboard") {
    const byPosition = (left: BoardNode, right: BoardNode) => left.y - right.y || left.x - right.x;
    const characters = template.doc.nodes
      .filter((node) => node.type === "image" && node.title.startsWith("角色 · "))
      .sort(byPosition);
    const scenes = template.doc.nodes
      .filter((node) => node.type === "image" && node.title.startsWith("场景 · "))
      .sort(byPosition);
    for (const [index, node] of characters.entries()) {
      referencePositions.set(node.id, { x: index * 340, y: -760 });
    }
    for (const [index, node] of scenes.entries()) {
      referencePositions.set(node.id, { x: index * 340, y: -420 });
    }
  }
  for (const node of template.doc.nodes) {
    const allocated = allocateNodeRef({ nodes: [...existing, ...nodes], nextRef });
    nextRef = allocated.nextRef;
    const id = templateNodeId();
    idMap.set(node.id, id);
    const reference = referencePositions.get(node.id);
    const base = {
      ...structuredClone(node),
      id,
      ref: allocated.ref,
      x: Math.round((reference?.x ?? node.x) + dx),
      y: Math.round((reference?.y ?? node.y) + dy),
      createdAt: at,
      updatedAt: at,
    } as BoardNode;
    if (base.type === "image" || base.type === "video" || base.type === "audio") {
      const assetId = assetBindings.get(node.id) ?? null;
      nodes.push({ ...base, assetId, source: assetId ? "library" : base.source, status: assetId ? "succeeded" : "empty", taskId: undefined, error: undefined } as BoardNode);
    } else if (base.type === "config") {
      nodes.push({ ...base, status: "idle", lastTaskId: undefined, error: undefined } as BoardNode);
    } else {
      nodes.push(base);
    }
  }
  const edges = template.doc.edges.map((edge) => ({
    ...edge,
    id: `edge-${crypto.randomUUID()}`,
    source: idMap.get(edge.source)!,
    target: idMap.get(edge.target)!,
  }));
  const groups: BoardGroup[] = boardGroups(template.doc).map((group) => ({
    ...group,
    id: `group-${crypto.randomUUID()}`,
    nodeIds: group.nodeIds.map((id) => idMap.get(id)!).filter(Boolean),
    collapsed: false,
  }));
  const doc = parseBoardDoc({
    version: 1,
    nextRef,
    nodes: [...existing, ...nodes],
    edges: [...(target?.edges ?? []), ...edges],
    groups: [...boardGroups(target ?? { groups: [] }), ...groups],
  });
  return { doc, nodeCount: nodes.length };
}

function requireTemplate(db: AppDatabase, id: string): CanvasTemplate {
  const template = db.getCanvasTemplate(id);
  if (!template) throw new AppError("TEMPLATE_NOT_FOUND", "模板不存在", 404);
  return template;
}

function validTemplateAssets(db: AppDatabase, template: CanvasTemplate): Map<string, string> {
  const bindings = db.getStoryboardTemplateAssets(template.id);
  for (const assetId of bindings.values()) {
    const asset = db.getAsset(assetId);
    if (!asset || !asset.mimeType.startsWith("image/")) throw new AppError("STORYBOARD_ASSET_MISSING", "分镜模板中的参考图已不存在，请回到分镜审阅重新选择并导入。", 409);
  }
  return bindings;
}

export function importTemplateIntoBoard(db: AppDatabase, boardId: string, templateId: string): {
  board: BoardView;
  addedNodes: number;
} {
  const record = db.getBoardRecord(boardId);
  if (!record) throw new AppError("BOARD_NOT_FOUND", "无限画布不存在", 404);
  const template = requireTemplate(db, templateId);
  const bindings = validTemplateAssets(db, template);
  const { doc, nodeCount } = instantiateDoc(template, record.doc, bindings);
  db.saveBoardSnapshot({
    boardId,
    previousDoc: record.doc,
    doc,
    version: record.version + 1,
    reason: `template:${template.name}`.slice(0, 200),
  });
  return { board: getBoard(db, boardId)!, addedNodes: nodeCount };
}

export function createBoardFromTemplate(db: AppDatabase, templateId: string, title?: string): BoardView {
  const template = requireTemplate(db, templateId);
  const bindings = validTemplateAssets(db, template);
  const created = createBoard(db, { title: title?.trim() || template.name });
  const record = db.getBoardRecord(created.id)!;
  const { doc } = instantiateDoc(template, null, bindings);
  db.saveBoardSnapshot({
    boardId: created.id,
    previousDoc: record.doc,
    doc,
    version: record.version + 1,
    reason: `template:${template.name}`.slice(0, 200),
  });
  return getBoard(db, created.id)!;
}

/**
 * 把当前对话的分镜表转成模板输入。
 *
 * 每镜两个节点：文本节点保留剧本 / 台词 / 景别等参考信息，配置节点放真正
 * 用于生成的 prompt。配置节点不拼上游文本，避免把「角色：」「台词：」这些
 * 标签一起送进生图模型。按场景分组，没场景时统一放「分镜」组。
 */
/** v2 起角色 / 场景设定图也会作为参考节点迁移进画布 */
export const STORYBOARD_MIGRATION_VERSION = 2;

export interface StoryboardMigrationResult {
  conversationId: string;
  title: string;
  boardId: string;
  templateId: string;
  nodeCount: number;
  version: number;
}

/**
 * 把一个会话里的旧分镜迁移成：
 * 1. 一份可重复使用的模板；
 * 2. 一块无限画布，带分镜图 / 视频 / 配音结果节点。
 *
 * 旧分镜表不删，迁移只读；每个会话有 storyboard_migrations 标记，重复调用不会
 * 再生成第二块板。
 */
export function migrateStoryboardConversation(
  db: AppDatabase,
  conversationId: string,
  options: { replaceExisting?: boolean } = {},
): StoryboardMigrationResult | null {
  const conversation = db.getConversation(conversationId);
  const shots = db.listStoryboardShots(conversationId);
  if (!conversation || !shots.length) return null;
  const existing = db.getStoryboardMigration(conversationId);
  if (existing) {
    if (existing.version >= STORYBOARD_MIGRATION_VERSION) return null;
    if (!options.replaceExisting) return null;
    // v1 的迁移画布没有角色 / 场景设定；用户确认升级后删除旧板重建
    db.deleteBoardCascade(existing.boardId);
  }

  let template = db.findCanvasTemplateByConversation(conversationId, "storyboard");
  const hasSettingNodes = Boolean(template?.doc.nodes.some((node) =>
    node.type === "image" && (node.title.startsWith("角色 · ") || node.title.startsWith("场景 · "))));
  if (!template || !hasSettingNodes) {
    const input = storyboardTemplateInput(db, conversationId);
    if (!input) return null;
    template = createCanvasTemplate(db, input, {
      source: "storyboard",
      conversationId,
    });
  }

  const board = createBoard(db, { title: `分镜 · ${conversation.title}`.slice(0, 80) });
  const record = db.getBoardRecord(board.id)!;
  const doc = structuredClone(template.doc);
  const configs = doc.nodes.filter((node) => node.type === "config");
  const edges = [...doc.edges];
  const groups = boardGroups(doc).map((group) => ({ ...group, nodeIds: [...group.nodeIds] }));
  const groupByTitle = new Map(groups.map((group) => [group.title, group]));
  let nextRef = doc.nextRef;
  const at = now();

  // 模板里的角色 / 场景占位，有设定图就绑上并建立素材链接；没有就留空占位
  const settingByTitle = new Map<string, { assetId: string | null }>();
  for (const item of db.listStoryboardCharacters(conversationId)) {
    settingByTitle.set(`角色 · ${item.name}`.slice(0, 80), { assetId: item.assetId });
  }
  for (const item of db.listStoryboardScenes(conversationId)) {
    settingByTitle.set(`场景 · ${item.name}`.slice(0, 80), { assetId: item.assetId });
  }
  for (const [index, node] of doc.nodes.entries()) {
    if (node.type !== "image") continue;
    const setting = settingByTitle.get(node.title);
    if (!setting?.assetId) continue;
    const asset = db.getAsset(setting.assetId);
    if (!asset || !asset.mimeType.startsWith("image/")) continue;
    doc.nodes[index] = {
      ...node,
      assetId: setting.assetId,
      source: "library",
      status: "succeeded",
    } as BoardNode;
    db.insertBoardAssetLink(board.id, setting.assetId, node.id);
  }
  const nodes: BoardNode[] = [...doc.nodes];

  const addMedia = (
    shotIndex: number,
    type: "image" | "video" | "audio",
    assetId: string | null | undefined,
    title: string,
    offset: number,
  ) => {
    if (!assetId) return null;
    const asset = db.getAsset(assetId);
    if (!asset) return null;
    const prefix = type === "image" ? "image/" : type === "video" ? "video/" : "audio/";
    if (!asset.mimeType.startsWith(prefix)) return null;
    const existingNode = nodes.find((node) => node.type === type && (node.title === title || (type === "audio" && node.title.startsWith(`第 ${shots[shotIndex]!.index} 镜 · `))));
    if (existingNode && (existingNode.type === "image" || existingNode.type === "video" || existingNode.type === "audio")) {
      const index = nodes.indexOf(existingNode);
      nodes[index] = { ...existingNode, assetId, source: "generated", status: "succeeded" } as BoardNode;
      db.insertBoardAssetLink(board.id, assetId, existingNode.id);
      return nodes[index];
    }
    const config = configs[shotIndex] ?? nodes.find((node) => node.title === `第 ${shots[shotIndex]!.index} 镜 · 分镜图`);
    if (!config) return null;
    const allocated = allocateNodeRef({ nodes: [...nodes], nextRef });
    nextRef = allocated.nextRef;
    const size = type === "image"
      ? { width: 280, height: 210 }
      : type === "video"
        ? { width: 320, height: 240 }
        : { width: 300, height: 110 };
    const node: BoardNode = {
      id: templateNodeId(),
      ref: allocated.ref,
      type,
      x: config.x + config.width + 140 + offset,
      y: config.y,
      ...size,
      title: title.slice(0, 80),
      createdAt: at,
      updatedAt: at,
      assetId,
      source: "generated",
      status: "succeeded",
      ...(type === "audio" ? {} : { prompt: shots[shotIndex]!.prompt }),
    } as BoardNode;
    nodes.push(node);
    if (config.type === "config") edges.push({
      id: `edge-${crypto.randomUUID()}`,
      source: config.id,
      target: node.id,
      kind: "result",
    });
    const scene = shots[shotIndex]!.scene.trim();
    const group = groupByTitle.get(`第 ${shots[shotIndex]!.index} 镜${scene ? ` · ${scene}` : ""}`.slice(0, 80))
      ?? groupByTitle.get(scene ? `场景 · ${scene}` : "分镜");
    if (group) group.nodeIds.push(node.id);
    db.insertBoardAssetLink(board.id, assetId, node.id);
    return node;
  };

  for (const [index, shot] of shots.entries()) {
    addMedia(index, "image", shot.assetId, `第 ${shot.index} 镜 · 分镜图`, 0);
    addMedia(index, "video", shot.videoAssetId, `第 ${shot.index} 镜 · 视频`, 340);
    addMedia(index, "audio", shot.voiceAssetId, `第 ${shot.index} 镜 · 配音`, 680);
  }

  try {
    const migratedDoc = parseBoardDoc({
      ...doc,
      nextRef,
      nodes,
      edges,
      groups,
    });
    db.saveBoardSnapshot({
      boardId: board.id,
      previousDoc: record.doc,
      doc: migratedDoc,
      version: record.version + 1,
      reason: `storyboard-migration:${conversation.title}`.slice(0, 200),
    });
    db.saveStoryboardMigration({
      conversationId,
      boardId: board.id,
      templateId: template.id,
      version: STORYBOARD_MIGRATION_VERSION,
    });
    // 升级 v1 时旧模板没有角色 / 场景节点；新模板落定后把旧模板清掉，避免模板库重复
    if (existing && existing.templateId !== template.id && existing.version < STORYBOARD_MIGRATION_VERSION) {
      db.deleteCanvasTemplate(existing.templateId);
    }
    return {
      conversationId,
      title: board.title,
      boardId: board.id,
      templateId: template.id,
      nodeCount: nodes.length,
      version: STORYBOARD_MIGRATION_VERSION,
    };
  } catch (error) {
    // 迁移失败时不要留下半块空板；旧分镜数据完全没动
    db.deleteBoardCascade(board.id);
    throw error;
  }
}

export function migrateAllStoryboards(
  db: AppDatabase,
  options: { replaceExisting?: boolean } = {},
): {
  migrated: StoryboardMigrationResult[];
  skipped: number;
  failed: Array<{ conversationId: string; message: string }>;
} {
  const migrated: StoryboardMigrationResult[] = [];
  const failed: Array<{ conversationId: string; message: string }> = [];
  let skipped = 0;
  for (const conversationId of db.listStoryboardConversationIds()) {
    const existing = db.getStoryboardMigration(conversationId);
    if (existing && existing.version >= STORYBOARD_MIGRATION_VERSION) { skipped += 1; continue; }
    if (existing && !options.replaceExisting) { skipped += 1; continue; }
    try {
      const result = migrateStoryboardConversation(db, conversationId, options);
      if (result) migrated.push(result);
      else skipped += 1;
    } catch (error) {
      failed.push({
        conversationId,
        message: error instanceof Error ? error.message : "迁移失败",
      });
    }
  }
  return { migrated, skipped, failed };
}

/** 迁移完成并确认画布可用后，删除旧分镜表数据；模板和迁移画布不受影响 */
export function cleanupMigratedStoryboards(db: AppDatabase): {
  cleaned: string[];
  skipped: number;
} {
  const cleaned: string[] = [];
  let skipped = 0;
  for (const migration of db.listStoryboardMigrations()) {
    if (migration.version < STORYBOARD_MIGRATION_VERSION) { skipped += 1; continue; }
    if (!db.getBoardRecord(migration.boardId)) { skipped += 1; continue; }
    if (!db.listStoryboardShots(migration.conversationId).length) { skipped += 1; continue; }
    db.deleteStoryboard(migration.conversationId);
    cleaned.push(migration.conversationId);
  }
  return { cleaned, skipped };
}

export interface StoryboardTemplateSetting {
  name: string;
  prompt?: string;
}

export interface StoryboardTemplateShot {
  id?: string;
  index: number;
  prompt: string;
  character?: string;
  characters?: string[];
  props?: string[];
  scene?: string;
  kind?: "image" | "video";
  sourceText?: string;
  dialogue?: string;
  speaker?: string;
  shotSize?: string;
  cameraMove?: string;
  videoPrompt?: string;
  soundEffect?: string;
}

/** 从分镜数据生成模板：角色 / 场景设定图占位 + 每镜文本 / 配置节点 + 参考连线 */
export function buildStoryboardTemplateInput(source: {
  name: string;
  description?: string;
  projectId?: string;
  characters?: StoryboardTemplateSetting[];
  scenes?: StoryboardTemplateSetting[];
  props?: StoryboardTemplateSetting[];
  shots: StoryboardTemplateShot[];
}): CanvasTemplateInput {
  const nodes: CanvasTemplateInput["nodes"] = [];
  const edges: NonNullable<CanvasTemplateInput["edges"]> = [];
  const shotGroups: NonNullable<CanvasTemplateInput["groups"]> = [];
  const characterGroups: string[] = [];
  const sceneGroups: string[] = [];
  const propGroups: string[] = [];
  const characterIds = new Map<string, string>();
  const sceneIds = new Map<string, string>();
  const propIds = new Map<string, string>();

  /**
   * 设定图单独放在镜头区上方，角色一行、场景一行：
   * - 角色行 y = -760；
   * - 场景行 y = -420；
   * - 镜头从 y = 0 开始。
   * 不再把角色和场景塞进镜头左侧的同一段坐标，导入后一眼能分清两类参考。
   */
  for (const [index, character] of (source.characters ?? []).entries()) {
    const name = character.name.trim();
    if (!name) continue;
    const tempId = `ch${index + 1}`;
    characterIds.set(name, tempId);
    characterGroups.push(tempId);
    nodes.push({
      tempId,
      type: "image",
      x: index * 340,
      y: -760,
      width: 280,
      height: 210,
      title: `角色 · ${name}`.slice(0, 80),
      text: `角色设定图：${name}。${character.prompt?.trim() || "保持人物外貌与服饰一致"}。同一人物的正面、侧面、背面全身三视图，统一服装、比例和光线，简洁背景，无文字。`,
    });
  }
  for (const [index, scene] of (source.scenes ?? []).entries()) {
    const name = scene.name.trim();
    if (!name) continue;
    const tempId = `sc${index + 1}`;
    sceneIds.set(name, tempId);
    sceneGroups.push(tempId);
    nodes.push({
      tempId,
      type: "image",
      x: index * 340,
      y: -420,
      width: 280,
      height: 210,
      title: `场景 · ${name}`.slice(0, 80),
      text: `场景设定图：${name}。${scene.prompt?.trim() || "清晰呈现空间布局"}。展示环境全貌、空间结构、光线与色调，保持场景细节一致，无人物，无文字。`,
    });
  }

  for (const [index, prop] of (source.props ?? []).entries()) {
    const name = prop.name.trim();
    if (!name) continue;
    const tempId = `prop${index + 1}`; propIds.set(name, tempId); propGroups.push(tempId);
    nodes.push({ tempId, type: "image", x: index * 340, y: -1100, width: 280, height: 210, title: `道具 · ${name}`.slice(0, 80), text: `道具设定图：${name}。${prop.prompt?.trim() || "清晰展示外形、材质和细节"}。简洁背景，单件物品，无文字。` });
  }

  for (const [index, shot] of source.shots.entries()) {
    const col = index % 3;
    const row = Math.floor(index / 3);
    const x = col * 1500;
    const y = row * 720;
    const storyboard = (role: "text" | "image" | "video" | "audio") => source.projectId && shot.id ? { projectId: source.projectId, shotId: shot.id, role } : undefined;
    const textId = `t${index + 1}`;
    const configId = `c${index + 1}`;
    const details = [
      `第 ${shot.index} 镜`,
      shot.character ? `角色：${shot.character}` : "",
      shot.scene ? `场景：${shot.scene}` : "",
      shot.props?.length ? `道具：${shot.props.join("、")}` : "",
      shot.shotSize ? `景别：${shot.shotSize}` : "",
      shot.cameraMove ? `运镜：${shot.cameraMove}` : "",
      shot.sourceText?.trim() ? `原文：${shot.sourceText.trim()}` : "",
      `画面：${shot.prompt}`,
      shot.dialogue?.trim() ? `台词${shot.speaker ? `（${shot.speaker}）` : ""}：${shot.dialogue}` : "",
      shot.videoPrompt?.trim() ? `视频：${shot.videoPrompt}` : "",
      shot.soundEffect?.trim() ? `声音：${shot.soundEffect}` : "",
    ].filter(Boolean).join("\n");
    nodes.push({
      tempId: textId,
      type: "text", storyboard: storyboard("text"),
      x,
      y,
      width: 320,
      height: 260,
      title: `第 ${shot.index} 镜`,
      text: details,
    });
    nodes.push({
      tempId: configId,
      type: "image", storyboard: storyboard("image"),
      x: x + 370,
      y,
      width: 280,
      height: 260,
      title: `第 ${shot.index} 镜 · 分镜图`,
      text: shot.prompt,
    });
    const videoId = `v${index + 1}`;
    const videoPrompt = shot.videoPrompt?.trim() || [
      shot.prompt,
      shot.cameraMove?.trim() ? `运镜：${shot.cameraMove.trim()}` : "",
      "基于首帧保持角色和场景一致，动作自然连贯。",
    ].filter(Boolean).join("；");
    nodes.push({
      tempId: videoId, type: "video", storyboard: storyboard("video"), x: x + 740, y, width: 320, height: 260,
      title: `第 ${shot.index} 镜 · 视频`, text: videoPrompt,
    });
    edges.push({ from: configId, to: videoId, kind: "input", role: "first-frame" });
    const audioIds: string[] = [];
    if (shot.dialogue?.trim()) {
      const audioId = `a${index + 1}`;
      audioIds.push(audioId);
      nodes.push({ tempId: audioId, type: "audio", storyboard: storyboard("audio"), x: x + 1100, y, width: 300, height: 160,
        title: `第 ${shot.index} 镜 · ${shot.speaker?.trim() || "配音"}`, text: shot.dialogue.trim() });
    }

    // 设定图作为参考图输入：角色按名字找，场景按名字找；每镜最多 8 张
    const charNames = shot.characters?.length
      ? shot.characters
      : (shot.character ?? "").split(/[、,，]/).map((name) => name.trim()).filter(Boolean);
    const inputIds = new Set<string>();
    for (const name of charNames) {
      const tempId = characterIds.get(name.trim());
      if (tempId) inputIds.add(tempId);
    }
    const sceneId = shot.scene ? sceneIds.get(shot.scene.trim()) : undefined;
    if (sceneId) inputIds.add(sceneId);
    for (const name of shot.props ?? []) { const tempId = propIds.get(name.trim()); if (tempId) inputIds.add(tempId); }
    if (inputIds.size > 8) throw new AppError("STORYBOARD_REFERENCE_LIMIT", `第 ${shot.index} 镜参考图超过 8 张，请减少角色、场景或道具。`, 400);
    for (const tempId of [...inputIds].slice(0, 8)) {
      edges.push({ from: tempId, to: configId, kind: "input", role: "reference" });
    }

    shotGroups.push({ title: `第 ${shot.index} 镜${shot.scene?.trim() ? ` · ${shot.scene.trim()}` : ""}`.slice(0, 80), nodeIds: [textId, configId, videoId, ...audioIds] });
  }

  const groups: NonNullable<CanvasTemplateInput["groups"]> = [];
  if (characterGroups.length) groups.push({ title: "角色设定", nodeIds: characterGroups });
  if (sceneGroups.length) groups.push({ title: "场景设定", nodeIds: sceneGroups });
  if (propGroups.length) groups.push({ title: "道具设定", nodeIds: propGroups });
  groups.push(...shotGroups);

  return {
    name: source.name.slice(0, 80),
    ...(source.description ? { description: source.description } : {}),
    nodes,
    edges,
    groups,
  };
}

export function storyboardTemplateInput(db: AppDatabase, conversationId: string, templateName?: string): CanvasTemplateInput | null {
  const conversation = db.getConversation(conversationId);
  if (!conversation) return null;
  const shots = db.listStoryboardShots(conversationId);
  if (!shots.length) return null;
  const characters = db.listStoryboardCharacters(conversationId)
    .map((item) => ({ name: item.name, prompt: item.prompt }));
  const scenes = db.listStoryboardScenes(conversationId)
    .map((item) => ({ name: item.name, prompt: item.prompt }));
  return buildStoryboardTemplateInput({
    name: templateName?.trim() || `${conversation.title} · 分镜`,
    description: `${shots.length} 个镜头，含角色 / 场景参考，按场景分组；导入后不会自动生成。`,
    characters,
    scenes,
    shots: shots.map((shot) => ({
      index: shot.index,
      prompt: shot.prompt,
      character: shot.character,
      characters: shot.characters,
      scene: shot.scene,
      kind: shot.kind === "video" ? "video" : "image",
      sourceText: shot.sourceText,
      dialogue: shot.dialogue,
      speaker: shot.speaker,
      shotSize: shot.shotSize,
      cameraMove: shot.cameraMove,
      videoPrompt: shot.videoPrompt,
      soundEffect: shot.soundEffect,
    })),
  });
}
