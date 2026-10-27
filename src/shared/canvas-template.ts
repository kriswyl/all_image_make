/**
 * 无限画布模板的共享协议。
 *
 * 模板不是一张图片，而是一组「待实例化的节点 / 连线 / 分组」：
 * - 节点用临时 id（t1、c1…）互相引用，实例化时再换成真实 id / nX；
 * - 模板不携带 assetId，图片节点只是占位；
 * - 生成参数仍然用配置节点的字段，导入后用户可以直接点生成。
 *
 * 对话里由 Agent 生成模板，也可以由分镜表自动转成模板。
 */
import { z } from "zod";
import {
  BOARD_AUDIO_KINDS, BOARD_EDGE_ROLES, BOARD_LIMITS, BOARD_VIDEO_MODES,
  type BoardDoc,
} from "./board.js";
import { IMAGE_SIZE_VALUES } from "./types.js";

export const CANVAS_TEMPLATE_FORMAT = "chatcanvas-template";

export const templateConfigSchema = z.object({
  mode: z.enum(["image", "video", "text", "audio"]).optional(),
  prompt: z.string().max(BOARD_LIMITS.maxTextChars).optional(),
  useUpstreamText: z.boolean().optional(),
  model: z.string().max(200).optional(),
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
  count: z.number().int().min(1).max(BOARD_LIMITS.maxCount).optional(),
  videoMode: z.enum(BOARD_VIDEO_MODES).optional(),
  durationSeconds: z.number().int().min(1).max(30).optional(),
  resolution: z.string().max(20).optional(),
  audio: z.boolean().optional(),
  promptExtend: z.boolean().optional(),
  watermark: z.boolean().optional(),
  audioKind: z.enum(BOARD_AUDIO_KINDS).optional(),
  voice: z.string().max(40).optional(),
  ttsStyle: z.string().max(200).optional(),
  instrumental: z.boolean().optional(),
  musicTitle: z.string().max(80).optional(),
  musicTags: z.string().max(1_000).optional(),
  musicNegativeTags: z.string().max(1_000).optional(),
});

export const templateNodeSchema = z.object({
  tempId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/, "tempId 只能用字母开头的短标识"),
  type: z.enum(["text", "image", "video", "audio", "config"]),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().min(BOARD_LIMITS.minNodeWidth).max(BOARD_LIMITS.maxNodeWidth).optional(),
  height: z.number().finite().min(BOARD_LIMITS.minNodeHeight).max(BOARD_LIMITS.maxNodeHeight).optional(),
  title: z.string().max(BOARD_LIMITS.maxTitleChars).optional(),
  text: z.string().max(BOARD_LIMITS.maxTextChars).optional(),
  config: templateConfigSchema.optional(),
});

export const templateEdgeSchema = z.object({
  from: z.string().min(1).max(40),
  to: z.string().min(1).max(40),
  kind: z.enum(["input", "result"]).optional(),
  role: z.enum(BOARD_EDGE_ROLES).optional(),
});

export const templateGroupSchema = z.object({
  title: z.string().max(BOARD_LIMITS.maxTitleChars),
  nodeIds: z.array(z.string().min(1).max(40)).min(1).max(BOARD_LIMITS.maxNodes),
});

export const canvasTemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  nodes: z.array(templateNodeSchema).min(1).max(BOARD_LIMITS.maxNodes),
  edges: z.array(templateEdgeSchema).max(BOARD_LIMITS.maxEdges).optional(),
  groups: z.array(templateGroupSchema).max(BOARD_LIMITS.maxGroups).optional(),
});

export type CanvasTemplateInput = z.infer<typeof canvasTemplateInputSchema>;
export type TemplateNodeInput = z.infer<typeof templateNodeSchema>;
export type TemplateConfigInput = z.infer<typeof templateConfigSchema>;

/** 模板在数据库里的形态：doc 已经是一份可校验的 BoardDoc（assetId 全为空） */
export interface CanvasTemplate {
  id: string;
  name: string;
  description: string;
  source: "agent" | "storyboard" | "import";
  doc: BoardDoc;
  createdAt: string;
}

export interface CanvasTemplateSummary {
  id: string;
  name: string;
  description: string;
  source: CanvasTemplate["source"];
  nodeCount: number;
  groupCount: number;
  createdAt: string;
}
