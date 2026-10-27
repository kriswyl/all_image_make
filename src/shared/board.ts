/**
 * 无限画布（独立自由画布）的共享契约。
 *
 * 这份文件同时被浏览器、Express 服务端和 Agent 工具使用，所以只放**纯数据**：
 * 类型、zod schema、限制、排序 / 校验函数。不 import 数据库、fs、React。
 *
 * 设计约束见 FREE_CANVAS_PLAN.md：
 * - 节点只引用 `assetId`，不存 URL / base64；
 * - 连线分 `input`（上游喂给配置节点）和 `result`（配置节点产出的结果）；
 * - 配置节点只聚合**直接上游**，不做递归；
 * - 节点 `ref`（n1、n2…）稳定不变，Agent 和用户都靠它指代节点。
 */
import { z } from "zod";
import { IMAGE_SIZE_VALUES } from "./types.js";
import type { ConversationVideoMode } from "./video-capabilities.js";

export const BOARD_DOC_VERSION = 1;

export const BOARD_LIMITS = {
  /** 一块无限画布最多多少节点 */
  maxNodes: 200,
  /** 一块无限画布最多多少连线 */
  maxEdges: 400,
  /** 文档 JSON 上限（字节） */
  maxDocBytes: 2 * 1024 * 1024,
  /** 单个文本节点上限 */
  maxTextChars: 20_000,
  /** 节点标题上限 */
  maxTitleChars: 80,
  /** 历史快照上限 */
  maxHistory: 50,
  /** 配置节点最多带几张参考图（和现有 MAX_REFERENCE_IMAGES 对齐） */
  maxUpstreamImages: 8,
  /** Agent 一次最多提交多少条 op */
  maxOpsPerBatch: 20,
  /** 配置节点一次最多生成几张 */
  maxCount: 8,
  /** 节点尺寸范围 */
  minNodeWidth: 120,
  maxNodeWidth: 2_000,
  minNodeHeight: 60,
  maxNodeHeight: 2_000,
  /** 一块无限画布最多多少个分组 */
  maxGroups: 100,
} as const;

export const BOARD_NODE_TYPES = ["text", "image", "video", "audio", "config"] as const;
export type BoardNodeType = (typeof BOARD_NODE_TYPES)[number];

export const BOARD_NODE_STATUSES = ["idle", "empty", "loading", "succeeded", "failed", "cancelled"] as const;
export type BoardNodeStatus = (typeof BOARD_NODE_STATUSES)[number];

export const BOARD_EDGE_KINDS = ["input", "result"] as const;
export type BoardEdgeKind = (typeof BOARD_EDGE_KINDS)[number];

export const BOARD_EDGE_ROLES = ["text", "reference", "first-frame", "last-frame"] as const;
export type BoardEdgeRole = (typeof BOARD_EDGE_ROLES)[number];

export const BOARD_MODES = ["image", "video", "text", "audio"] as const;
export type BoardMode = (typeof BOARD_MODES)[number];

export const BOARD_AUDIO_KINDS = ["speech", "music"] as const;
export type BoardAudioKind = (typeof BOARD_AUDIO_KINDS)[number];

/**
 * 无限画布视频配置的可选模式。和对话里的 generate_video 共用一套英文词；
 * 配置节点不填 = 按上游连线的角色自动判断。
 */
export const BOARD_VIDEO_MODES = [
  "text-to-video", "first-frame", "first-last-frame", "reference",
] as const satisfies readonly ConversationVideoMode[];
export type BoardVideoMode = (typeof BOARD_VIDEO_MODES)[number];

export const BOARD_IMAGE_SOURCES = ["upload", "generated", "library"] as const;
export type BoardImageSource = (typeof BOARD_IMAGE_SOURCES)[number];

export const BOARD_VIDEO_SOURCES = ["upload", "generated"] as const;
export type BoardVideoSource = (typeof BOARD_VIDEO_SOURCES)[number];

export const BOARD_AUDIO_SOURCES = ["upload", "generated"] as const;
export type BoardAudioSource = (typeof BOARD_AUDIO_SOURCES)[number];

const titleSchema = z.string().max(BOARD_LIMITS.maxTitleChars);
const timestampSchema = z.string().min(1).max(40);
const nodeIdSchema = z.string().min(1).max(80);
const nodeRefSchema = z.string().regex(/^n[1-9]\d*$/, "节点引用必须是 n1、n2 这种形式");
const assetIdSchema = z.string().min(1).max(80);

/**
 * 图片 / 视频 / 音频节点现在也能「就地生成」：节点自己带提示词和参数，
 * 生成结果回填到同一个节点，不需要再拖一个配置节点 + 结果节点。
 *
 * 这些字段全部可选，老文档读进来不会多出默认值；生成时才按节点类型挑对应的那份。
 */
const generationParamShape = {
  prompt: z.string().max(BOARD_LIMITS.maxTextChars).optional(),
  /** 是否把左侧直接上游的文本拼进提示词；媒体节点不填按 true 处理 */
  useUpstreamText: z.boolean().optional(),
  model: z.string().max(200).optional(),
  channelId: z.string().max(80).optional(),
  size: z.string().max(60).optional(),
  imageSize: z.enum(IMAGE_SIZE_VALUES).optional(),
  quality: z.string().max(40).optional(),
  negativePrompt: z.string().max(2_000).optional(),
  aspectRatio: z.string().max(20).optional(),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
  style: z.enum(["auto", "vivid", "natural"]).optional(),
  background: z.enum(["auto", "opaque", "transparent"]).optional(),
  outputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
  moderation: z.enum(["auto", "low"]).optional(),
  videoMode: z.enum(["text-to-video", "first-frame", "first-last-frame", "reference"]).optional(),
  durationSeconds: z.number().int().min(1).max(30).optional(),
  resolution: z.string().max(20).optional(),
  audio: z.boolean().optional(),
  promptExtend: z.boolean().optional(),
  watermark: z.boolean().optional(),
  audioKind: z.enum(["speech", "music"]).optional(),
  voice: z.string().max(40).optional(),
  ttsStyle: z.string().max(200).optional(),
  instrumental: z.boolean().optional(),
  musicTitle: z.string().max(80).optional(),
  musicTags: z.string().max(1_000).optional(),
  musicNegativeTags: z.string().max(1_000).optional(),
} as const;

const baseNodeShape = {
  id: nodeIdSchema,
  ref: nodeRefSchema,
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().min(BOARD_LIMITS.minNodeWidth).max(BOARD_LIMITS.maxNodeWidth),
  height: z.number().finite().min(BOARD_LIMITS.minNodeHeight).max(BOARD_LIMITS.maxNodeHeight),
  title: titleSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

export const textNodeSchema = z.object({
  ...baseNodeShape,
  type: z.literal("text"),
  text: z.string().max(BOARD_LIMITS.maxTextChars).default(""),
  fontSize: z.number().int().min(10).max(48).optional(),
});

export const imageNodeSchema = z.object({
  ...baseNodeShape,
  type: z.literal("image"),
  assetId: assetIdSchema.nullable(),
  source: z.enum(BOARD_IMAGE_SOURCES).default("upload"),
  status: z.enum(BOARD_NODE_STATUSES).default("empty"),
  taskId: z.string().max(80).nullable().optional(),
  ...generationParamShape,
  naturalWidth: z.number().int().positive().optional(),
  naturalHeight: z.number().int().positive().optional(),
  error: z.string().max(2_000).optional(),
});

export const videoNodeSchema = z.object({
  ...baseNodeShape,
  type: z.literal("video"),
  assetId: assetIdSchema.nullable(),
  source: z.enum(BOARD_VIDEO_SOURCES).default("upload"),
  status: z.enum(BOARD_NODE_STATUSES).default("empty"),
  taskId: z.string().max(80).nullable().optional(),
  ...generationParamShape,
  duration: z.number().finite().nonnegative().optional(),
  error: z.string().max(2_000).optional(),
});

export const audioNodeSchema = z.object({
  ...baseNodeShape,
  type: z.literal("audio"),
  assetId: assetIdSchema.nullable(),
  source: z.enum(BOARD_AUDIO_SOURCES).default("generated"),
  status: z.enum(BOARD_NODE_STATUSES).default("empty"),
  taskId: z.string().max(80).nullable().optional(),
  ...generationParamShape,
  duration: z.number().finite().nonnegative().optional(),
  error: z.string().max(2_000).optional(),
});

export const configNodeSchema = z.object({
  ...baseNodeShape,
  type: z.literal("config"),
  mode: z.enum(BOARD_MODES).default("image"),
  prompt: z.string().max(BOARD_LIMITS.maxTextChars).default(""),
  useUpstreamText: z.boolean().default(true),
  model: z.string().max(200).optional(),
  channelId: z.string().max(80).optional(),
  size: z.string().max(60).optional(),
  /** gemini 系渠道只认 imageSize（1K / 2K / 4K） */
  imageSize: z.enum(IMAGE_SIZE_VALUES).optional(),
  quality: z.string().max(40).optional(),
  negativePrompt: z.string().max(2_000).optional(),
  aspectRatio: z.string().max(20).optional(),
  seed: z.number().int().min(0).max(2_147_483_647).optional(),
  style: z.enum(["auto", "vivid", "natural"]).optional(),
  background: z.enum(["auto", "opaque", "transparent"]).optional(),
  outputFormat: z.enum(["png", "jpeg", "webp"]).optional(),
  moderation: z.enum(["auto", "low"]).optional(),
  count: z.number().int().min(1).max(BOARD_LIMITS.maxCount).default(1),
  /** 不填 = 按上游图片的 first-frame / last-frame / reference 角色自动判断 */
  videoMode: z.enum(BOARD_VIDEO_MODES).optional(),
  durationSeconds: z.number().int().min(1).max(30).optional(),
  resolution: z.string().max(20).optional(),
  audio: z.boolean().optional(),
  promptExtend: z.boolean().optional(),
  watermark: z.boolean().optional(),
  /** 音频模式的细分：配音或音乐；不填按配音处理 */
  audioKind: z.enum(BOARD_AUDIO_KINDS).optional(),
  voice: z.string().max(40).optional(),
  ttsStyle: z.string().max(200).optional(),
  instrumental: z.boolean().optional(),
  musicTitle: z.string().max(80).optional(),
  musicTags: z.string().max(1_000).optional(),
  musicNegativeTags: z.string().max(1_000).optional(),
  status: z.enum(BOARD_NODE_STATUSES).default("idle"),
  lastTaskId: z.string().max(80).nullable().optional(),
  error: z.string().max(2_000).optional(),
});

export const boardNodeSchema = z.discriminatedUnion("type", [
  textNodeSchema,
  imageNodeSchema,
  videoNodeSchema,
  audioNodeSchema,
  configNodeSchema,
]);

export const boardEdgeSchema = z.object({
  id: z.string().min(1).max(120),
  source: nodeIdSchema,
  target: nodeIdSchema,
  kind: z.enum(BOARD_EDGE_KINDS),
  role: z.enum(BOARD_EDGE_ROLES).optional(),
});

/**
 * 画布分组：只是一组节点 id，不改变节点本身。
 * 折叠状态存在组上，所以撤销 / 导出会一起带走。
 */
export const boardGroupSchema = z.object({
  id: z.string().min(1).max(80),
  title: titleSchema,
  nodeIds: z.array(nodeIdSchema).min(1).max(BOARD_LIMITS.maxNodes),
  collapsed: z.boolean().default(false),
});

export const boardDocSchema = z.object({
  version: z.literal(BOARD_DOC_VERSION),
  nextRef: z.number().int().min(1),
  nodes: z.array(boardNodeSchema).max(BOARD_LIMITS.maxNodes),
  edges: z.array(boardEdgeSchema).max(BOARD_LIMITS.maxEdges),
  // 老文档没有 groups；读出来后由 parseBoardDoc 归一成空数组
  groups: z.array(boardGroupSchema).max(BOARD_LIMITS.maxGroups).optional(),
});

export type BoardGroup = z.infer<typeof boardGroupSchema>;
export type TextBoardNode = z.infer<typeof textNodeSchema>;
export type ImageBoardNode = z.infer<typeof imageNodeSchema>;
export type VideoBoardNode = z.infer<typeof videoNodeSchema>;
export type AudioBoardNode = z.infer<typeof audioNodeSchema>;
export type ConfigBoardNode = z.infer<typeof configNodeSchema>;
export type BoardNode = z.infer<typeof boardNodeSchema>;
export type BoardEdge = z.infer<typeof boardEdgeSchema>;
export type BoardDoc = z.infer<typeof boardDocSchema>;

/** 能直接接收输入连线并自己生成结果的节点：配置节点，或图片 / 视频 / 音频节点 */
export type BoardGeneratorNode = ConfigBoardNode | ImageBoardNode | VideoBoardNode | AudioBoardNode;

export function isGeneratorNode(node: BoardNode): node is BoardGeneratorNode {
  return node.type === "config" || node.type === "image" || node.type === "video" || node.type === "audio";
}

/** 图片 / 视频 / 音频节点各自只允许一种输出；配置节点看 mode */
export function generatorModeOf(node: BoardGeneratorNode): BoardMode {
  return node.type === "config" ? node.mode : node.type;
}

/** 媒体节点从哪来：上传还是生成。配置节点没有这个概念，返回 generate */
export function nodeSourceOf(node: BoardGeneratorNode): "upload" | "generated" | "library" {
  if (node.type === "config") return "generated";
  return node.source;
}

/** 画布视口；和文档分开放，平移缩放不产生历史版本 */
export interface BoardViewport {
  x: number;
  y: number;
  scale: number;
}

export const DEFAULT_BOARD_VIEWPORT: BoardViewport = { x: 0, y: 0, scale: 1 };

/** 浮动 Agent 的 UI 状态，按无限画布保存；P2 才真正使用 */
export interface BoardAgentUiState {
  x: number;
  y: number;
  width: number;
  height: number;
  collapsed: boolean;
  /** 收起成气泡时的独立位置；没有就按面板右上角推算 */
  bubbleX?: number;
  bubbleY?: number;
}

export interface BoardUiState {
  agent?: BoardAgentUiState;
}

export interface BoardSummary {
  id: string;
  title: string;
  nodeCount: number;
  edgeCount: number;
  updatedAt: string;
  threadId: string;
}

export interface BoardView {
  id: string;
  title: string;
  doc: BoardDoc;
  viewport: BoardViewport;
  selection: string[];
  uiState: BoardUiState;
  version: number;
  threadId: string;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Agent 修改画布时只推变化部分。
 *
 * `baseVersion` 是客户端应该已经持有的版本；对不上就说明客户端有未保存 /
 * 未收到的修改，调用方应回退到整份 reload，而不是硬套增量。
 */
export interface BoardDelta {
  boardId: string;
  baseVersion: number;
  version: number;
  nextRef: number;
  nodes: BoardNode[];
  edges: BoardEdge[];
  groups: BoardGroup[];
  removedNodeIds: string[];
  removedEdgeIds: string[];
  removedGroupIds: string[];
}

/** 把增量合并进本地文档；排序保持不变，新增项追加到末尾 */
export function applyBoardDeltaToDoc(doc: BoardDoc, delta: BoardDelta): BoardDoc {
  const removedNodes = new Set(delta.removedNodeIds);
  const removedEdges = new Set(delta.removedEdgeIds);
  const removedGroups = new Set(delta.removedGroupIds);
  const incomingNodes = new Map(delta.nodes.map((node) => [node.id, node]));
  const incomingEdges = new Map(delta.edges.map((edge) => [edge.id, edge]));
  const incomingGroups = new Map(delta.groups.map((group) => [group.id, group]));

  const nodes = doc.nodes
    .filter((node) => !removedNodes.has(node.id))
    .map((node) => incomingNodes.get(node.id) ?? node);
  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const node of delta.nodes) if (!nodeIds.has(node.id)) nodes.push(node);

  const edges = doc.edges
    .filter((edge) => !removedEdges.has(edge.id))
    .map((edge) => incomingEdges.get(edge.id) ?? edge);
  const edgeIds = new Set(edges.map((edge) => edge.id));
  for (const edge of delta.edges) if (!edgeIds.has(edge.id)) edges.push(edge);

  const groups = boardGroups(doc)
    .filter((group) => !removedGroups.has(group.id))
    .map((group) => incomingGroups.get(group.id) ?? group);
  const groupIds = new Set(groups.map((group) => group.id));
  for (const group of delta.groups) if (!groupIds.has(group.id)) groups.push(group);

  return { ...doc, nextRef: delta.nextRef, nodes, edges, groups };
}

export class BoardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardValidationError";
  }
}

export function createEmptyBoardDoc(): BoardDoc {
  return { version: BOARD_DOC_VERSION, nextRef: 1, nodes: [], edges: [], groups: [] };
}

/** 统一读分组，避免每个调用点都写 `doc.groups ?? []` */
export function boardGroups(doc: Pick<BoardDoc, "groups">): BoardGroup[] {
  return doc.groups ?? [];
}

/** 给新节点分配一个稳定的短引用；调用方负责把返回的 nextRef 写回文档 */
export function allocateNodeRef(doc: Pick<BoardDoc, "nodes" | "nextRef">): { ref: string; nextRef: number } {
  let maxRef = 0;
  for (const node of doc.nodes) {
    const value = Number(node.ref.slice(1));
    if (Number.isFinite(value)) maxRef = Math.max(maxRef, value);
  }
  const next = Math.max(doc.nextRef, maxRef + 1);
  return { ref: `n${next}`, nextRef: next + 1 };
}

export function boardDocJson(doc: BoardDoc): string {
  return JSON.stringify(doc);
}

export function boardDocByteSize(doc: BoardDoc): number {
  return new TextEncoder().encode(boardDocJson(doc)).length;
}

/** 文档里所有被节点引用的素材 id，按出现顺序去重 */
export function boardDocAssetIds(doc: BoardDoc): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const node of doc.nodes) {
    if ((node.type !== "image" && node.type !== "video" && node.type !== "audio") || !node.assetId) continue;
    if (seen.has(node.assetId)) continue;
    seen.add(node.assetId);
    ids.push(node.assetId);
  }
  return ids;
}

/** 当前文档里用到的最大的 nX；给 nextRef 归一和测试用 */
export function maxNodeRef(doc: Pick<BoardDoc, "nodes">): number {
  let max = 0;
  for (const node of doc.nodes) {
    const value = Number(node.ref.slice(1));
    if (Number.isFinite(value)) max = Math.max(max, value);
  }
  return max;
}

/**
 * 直接上游的排序：先上后下、从左到右。
 *
 * 这是配置节点拼提示词和排参考图的唯一顺序。刻意不按连线创建顺序：
 * 用户看到的是画布上的位置，排序必须和眼睛看到的一致。
 */
function compareNodePosition(left: BoardNode, right: BoardNode): number {
  if (left.y !== right.y) return left.y - right.y;
  if (left.x !== right.x) return left.x - right.x;
  return left.ref.localeCompare(right.ref, undefined, { numeric: true });
}

export function directUpstream(doc: Pick<BoardDoc, "nodes" | "edges">, configNodeId: string): BoardNode[] {
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const result: BoardNode[] = [];
  for (const edge of doc.edges) {
    if (edge.kind !== "input" || edge.target !== configNodeId) continue;
    const node = byId.get(edge.source);
    if (node) result.push(node);
  }
  return result.sort(compareNodePosition);
}

export interface BoardInputLink {
  edge: BoardEdge;
  node: BoardNode;
}

/** 配置节点的直接上游，同时保留连线的 role（视频模式靠它区分首帧 / 尾帧 / 参考图） */
export function directInputLinks(doc: Pick<BoardDoc, "nodes" | "edges">, configNodeId: string): BoardInputLink[] {
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const links: BoardInputLink[] = [];
  for (const edge of doc.edges) {
    if (edge.kind !== "input" || edge.target !== configNodeId) continue;
    const node = byId.get(edge.source);
    if (node) links.push({ edge, node });
  }
  return links.sort((left, right) => compareNodePosition(left.node, right.node));
}

export function directUpstreamText(doc: Pick<BoardDoc, "nodes" | "edges">, configNodeId: string): TextBoardNode[] {
  return directUpstream(doc, configNodeId).filter((node): node is TextBoardNode => node.type === "text");
}

export function directUpstreamImages(doc: Pick<BoardDoc, "nodes" | "edges">, configNodeId: string): ImageBoardNode[] {
  return directUpstream(doc, configNodeId)
    .filter((node): node is ImageBoardNode => node.type === "image" && Boolean(node.assetId))
    .slice(0, BOARD_LIMITS.maxUpstreamImages);
}

/**
 * 拼配置节点的最终提示词。
 *
 * 只做字符串拼接，不查渠道、不截断：超长由调用方拒绝，而不是悄悄砍掉半句。
 * 返回空串表示没有可发的提示词。
 */
export function composeConfigPrompt(
  doc: Pick<BoardDoc, "nodes" | "edges">,
  node: Pick<BoardGeneratorNode, "id" | "prompt" | "useUpstreamText">,
): string {
  const own = (node.prompt ?? "").trim();
  if (node.useUpstreamText === false) return own;
  const upstream = directUpstreamText(doc, node.id).map((item) => item.text.trim()).filter(Boolean);
  return [own, ...upstream].filter(Boolean).join("\n\n");
}

/** zod 的错误压成一句能直接给用户 / 大脑看的中文 */
function zodMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "无限画布文档格式不正确";
  const path = issue.path.length ? `（${issue.path.join(".")}）` : "";
  return `无限画布文档格式不正确${path}：${issue.message}`;
}

/** 校验失败抛 BoardValidationError；调用方负责映射成 400 */
export function assertBoardDocValid(doc: BoardDoc): void {
  const nodeIds = new Set<string>();
  const refs = new Set<string>();
  for (const node of doc.nodes) {
    if (nodeIds.has(node.id)) throw new BoardValidationError(`节点 id 重复：${node.id}`);
    if (refs.has(node.ref)) throw new BoardValidationError(`节点引用重复：${node.ref}`);
    nodeIds.add(node.id);
    refs.add(node.ref);
    if (node.type === "config" && node.count > BOARD_LIMITS.maxCount) {
      throw new BoardValidationError(`配置节点「${node.title || node.ref}」一次最多生成 ${BOARD_LIMITS.maxCount} 张`);
    }
  }

  if (doc.nextRef <= maxNodeRef(doc)) {
    throw new BoardValidationError("nextRef 必须大于已用的最大节点引用");
  }

  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const groupIds = new Set<string>();
  const groupedNodeIds = new Set<string>();
  for (const group of doc.groups ?? []) {
    if (groupIds.has(group.id)) throw new BoardValidationError(`分组 id 重复：${group.id}`);
    groupIds.add(group.id);
    for (const nodeId of group.nodeIds) {
      if (!byId.has(nodeId)) throw new BoardValidationError(`分组「${group.title || group.id}」里的节点不存在：${nodeId}`);
      if (groupedNodeIds.has(nodeId)) throw new BoardValidationError(`节点被放进了多个分组：${byId.get(nodeId)!.ref}`);
      groupedNodeIds.add(nodeId);
    }
  }

  const edgeKeys = new Set<string>();
  const adjacency = new Map<string, string[]>();
  const addAdjacency = (from: string, to: string) => {
    const bucket = adjacency.get(from);
    if (bucket) bucket.push(to);
    else adjacency.set(from, [to]);
  };

  for (const edge of doc.edges) {
    const key = `${edge.kind}:${edge.source}->${edge.target}`;
    if (edgeKeys.has(key)) throw new BoardValidationError(`连线重复：${edge.source} → ${edge.target}`);
    edgeKeys.add(key);
    if (edge.source === edge.target) throw new BoardValidationError("节点不能连到自己");
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source) throw new BoardValidationError(`连线起点不存在：${edge.source}`);
    if (!target) throw new BoardValidationError(`连线终点不存在：${edge.target}`);

    if (edge.kind === "input") {
      if (!isGeneratorNode(target)) {
        throw new BoardValidationError("输入连线只能连到配置 / 图片 / 视频 / 音频节点");
      }
      if (source.type === "config") throw new BoardValidationError("配置节点不能作为另一个生成节点的输入");
      if (edge.role === "text" && source.type !== "text") throw new BoardValidationError("文本输入必须来自文本节点");
      if (edge.role && edge.role !== "text" && source.type !== "image" && source.type !== "video") {
        throw new BoardValidationError("图片输入必须来自图片或视频节点");
      }
      // 音频节点只吃文本；把图片连给它没有意义，直接拒绝而不是生成时静默丢掉
      if (target.type === "audio" && source.type !== "text") {
        throw new BoardValidationError("音频节点只接受文本输入");
      }
    } else {
      if (source.type !== "config") throw new BoardValidationError("结果连线必须从配置节点出发");
      if (target.type !== "image" && target.type !== "video" && target.type !== "audio" && target.type !== "text") {
        throw new BoardValidationError("结果连线只能指向文本、图片、视频或音频节点");
      }
      if (edge.role) throw new BoardValidationError("结果连线不能带输入角色");
    }
    addAdjacency(edge.source, edge.target);
  }

  // 任何环都拒绝：result 边回接 input 同样会形成反馈回路
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): void => {
    const current = state.get(id) ?? 0;
    if (current === 1) throw new BoardValidationError("连线上存在环，请检查节点关系");
    if (current === 2) return;
    state.set(id, 1);
    for (const next of adjacency.get(id) ?? []) visit(next);
    state.set(id, 2);
  };
  for (const node of doc.nodes) visit(node.id);
}

/**
 * 把数据库 / API 里的未知值变成合法文档。
 *
 * - zod 补齐默认值；
 * - nextRef 小于已用最大引用时自动抬高（老文档 / 外部导入的宽容处理）；
 * - 内容限制和连线合法性仍然硬校验。
 */
export function parseBoardDoc(value: unknown): BoardDoc {
  const parsed = boardDocSchema.safeParse(value);
  if (!parsed.success) throw new BoardValidationError(zodMessage(parsed.error));
  const doc: BoardDoc = {
    ...parsed.data,
    groups: parsed.data.groups ?? [],
    nextRef: Math.max(parsed.data.nextRef, maxNodeRef(parsed.data) + 1),
  };
  assertBoardDocValid(doc);
  if (boardDocByteSize(doc) > BOARD_LIMITS.maxDocBytes) {
    throw new BoardValidationError(`无限画布文档超过 ${(BOARD_LIMITS.maxDocBytes / 1024 / 1024).toFixed(0)} MB，请删减节点或提示词`);
  }
  return doc;
}

/** 给客户端 / 测试用：判断一个值是不是合法文档，不抛异常 */
export function isBoardDoc(value: unknown): value is BoardDoc {
  try {
    parseBoardDoc(value);
    return true;
  } catch {
    return false;
  }
}

export const BOARD_EXPORT_FORMAT = "chatcanvas-board";

export interface BoardExportFile {
  format: typeof BOARD_EXPORT_FORMAT;
  version: 1;
  title: string;
  exportedAt: string;
  doc: BoardDoc;
}

export function createBoardExport(title: string, doc: BoardDoc): BoardExportFile {
  return {
    format: BOARD_EXPORT_FORMAT,
    version: 1,
    title: title.slice(0, BOARD_LIMITS.maxTitleChars),
    exportedAt: new Date().toISOString(),
    doc,
  };
}

/**
 * 导入只认导出格式，也宽容接受一份裸文档（用户手写 / 老版本）。
 * 素材是否还存在由服务端处理：能连上就复用，连不上把节点清空并在返回值里说明。
 */
export function parseBoardExport(value: unknown): { title: string; doc: BoardDoc } {
  if (!value || typeof value !== "object") throw new BoardValidationError("这个文件不是无限画布导出文件");
  const record = value as Record<string, unknown>;
  const exported = record.format === BOARD_EXPORT_FORMAT;
  const rawDoc = exported ? record.doc : value;
  const doc = parseBoardDoc(rawDoc);
  const rawTitle = exported && typeof record.title === "string" ? record.title.trim() : "";
  return {
    title: (rawTitle || "导入的无限画布").slice(0, BOARD_LIMITS.maxTitleChars),
    doc,
  };
}

/** 视口存的是用户上次看到的位置；坏值一律退回默认，不让一块板打不开 */
export function parseBoardViewport(value: unknown): BoardViewport {
  if (!value || typeof value !== "object") return { ...DEFAULT_BOARD_VIEWPORT };
  const record = value as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  const scale = Number(record.scale);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    scale: Number.isFinite(scale) ? Math.min(3, Math.max(0.05, scale)) : 1,
  };
}

export function parseBoardSelection(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && Boolean(item)))].slice(0, 50);
}

export function parseBoardUiState(value: unknown): BoardUiState {
  if (!value || typeof value !== "object") return {};
  const agent = (value as Record<string, unknown>).agent;
  if (!agent || typeof agent !== "object") return {};
  const record = agent as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  const width = Number(record.width);
  const height = Number(record.height);
  if (![x, y, width, height].every(Number.isFinite)) return {};
  const bubbleX = Number(record.bubbleX);
  const bubbleY = Number(record.bubbleY);
  return {
    agent: {
      x,
      y,
      width: Math.max(280, width),
      height: Math.max(320, height),
      collapsed: Boolean(record.collapsed),
      ...(Number.isFinite(bubbleX) && record.bubbleX !== undefined && record.bubbleX !== null
        ? { bubbleX }
        : {}),
      ...(Number.isFinite(bubbleY) && record.bubbleY !== undefined && record.bubbleY !== null
        ? { bubbleY }
        : {}),
    },
  };
}
