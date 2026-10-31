/**
 * 无限画布 Agent 的批量操作协议。
 *
 * 一次 `board_apply` 最多 20 条，服务端在文档副本上按顺序执行；任意一条失败整批回滚。
 * 这样模型不用为「建两个节点、连三条线」拆成五轮，也不会留下半成品。
 *
 * 这里只定义协议，不执行；执行在 `src/server/board.ts`，工具在 `agent-tools.ts`。
 */
import { z } from "zod";
import { BOARD_AUDIO_KINDS, BOARD_LIMITS, BOARD_VIDEO_MODES } from "./board.js";
import { IMAGE_SIZE_VALUES } from "./types.js";

export const BOARD_OPS_PER_BATCH = 20;

export const boardNodeRefSchema = z.string().regex(/^n[1-9]\d*$/, "节点引用必须是 n1、n2 这种形式");
export const boardTempIdSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/, "tempId 只能用字母开头的短标识");

const generationPatchShape = {
  prompt: z.string().max(BOARD_LIMITS.maxTextChars).optional(),
  useUpstreamText: z.boolean().optional(),
  model: z.string().max(200).optional(),
  channelId: z.string().max(80).optional(),
  size: z.string().max(60).optional(),
  imageSize: z.enum(IMAGE_SIZE_VALUES).optional(),
  quality: z.string().max(40).optional(),
  negativePrompt: z.string().max(2_000).optional(),
  aspectRatio: z.string().max(20).optional(),
  /** 万相 / Seedance 认的是 `ratio`，可灵和 Grok 认 `aspectRatio` */
  ratio: z.string().max(20).optional(),
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
} as const;

const configPatchSchema = z.object({
  mode: z.enum(["image", "video", "text", "audio"]).optional(),
  ...generationPatchShape,
});

const nodePatchSchema = z.object({
  title: z.string().max(BOARD_LIMITS.maxTitleChars).optional(),
  mode: z.enum(["image", "video", "text", "audio"]).optional(),
  text: z.string().max(BOARD_LIMITS.maxTextChars).optional(),
  fontSize: z.number().int().min(10).max(48).optional(),
  ...generationPatchShape,
  x: z.number().finite().optional(),
  y: z.number().finite().optional(),
  width: z.number().finite().min(BOARD_LIMITS.minNodeWidth).max(BOARD_LIMITS.maxNodeWidth).optional(),
  height: z.number().finite().min(BOARD_LIMITS.minNodeHeight).max(BOARD_LIMITS.maxNodeHeight).optional(),
});

export const boardOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_node"),
    tempId: boardTempIdSchema,
    type: z.enum(["text", "image", "video", "audio", "config"]),
    x: z.number().finite(),
    y: z.number().finite(),
    title: z.string().max(BOARD_LIMITS.maxTitleChars).optional(),
    text: z.string().max(BOARD_LIMITS.maxTextChars).optional(),
    config: configPatchSchema.optional(),
    assetRef: z.string().max(80).optional(),
    width: z.number().finite().min(BOARD_LIMITS.minNodeWidth).max(BOARD_LIMITS.maxNodeWidth).optional(),
    height: z.number().finite().min(BOARD_LIMITS.minNodeHeight).max(BOARD_LIMITS.maxNodeHeight).optional(),
  }),
  z.object({
    op: z.literal("update_node"),
    nodeRef: boardNodeRefSchema,
    patch: nodePatchSchema,
  }),
  z.object({ op: z.literal("set_asset"), nodeRef: boardNodeRefSchema, assetId: z.string().min(1).max(80) }),
  z.object({
    op: z.literal("connect"),
    from: z.string().min(1).max(80),
    to: z.string().min(1).max(80),
    kind: z.enum(["input", "result"]).optional(),
    role: z.enum(["text", "reference", "first-frame", "last-frame"]).optional(),
  }),
  z.object({
    op: z.literal("disconnect"),
    from: z.string().min(1).max(80),
    to: z.string().min(1).max(80),
    kind: z.enum(["input", "result"]).optional(),
  }),
  z.object({
    op: z.literal("move_node"),
    nodeRef: boardNodeRefSchema,
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  /**
   * 批量排版：把一组节点排成一列 / 一行 / 网格，坐标由服务端按节点真实宽高计算。
   * 想让「分镜图单独一列」时用这个，而不是连着写十几条 move_node 自己算坐标。
   */
  z.object({
    op: z.literal("arrange"),
    nodeRefs: z.array(z.string().min(1).max(80)).min(1).max(BOARD_LIMITS.maxNodes),
    axis: z.enum(["x", "y"]).default("y"),
    origin: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
    gap: z.number().finite().min(0).max(2000).optional(),
    columns: z.number().int().min(1).max(20).optional(),
    /** 顺带把这批节点归到一个分组里；同名分组已存在时合并 */
    group: z.string().trim().min(1).max(BOARD_LIMITS.maxTitleChars).optional(),
  }),
  z.object({
    op: z.literal("delete_node"),
    nodeRef: boardNodeRefSchema,
  }),
]);

export const boardApplySchema = z.object({
  expectedBoardVersion: z.number().int().positive().optional(),
  ops: z.array(boardOpSchema).min(1).max(BOARD_OPS_PER_BATCH),
});

export type BoardConfigPatch = z.infer<typeof configPatchSchema>;
export type BoardNodePatch = z.infer<typeof nodePatchSchema>;
export type BoardOp = z.infer<typeof boardOpSchema>;
export type BoardApplyArgs = z.infer<typeof boardApplySchema>;

export const boardReadSchema = z.object({
  scope: z.enum(["selection", "viewport", "all"]).optional(),
  depth: z.coerce.number().int().min(0).max(1).optional(),
  nodeRefs: z.array(boardNodeRefSchema).max(20).optional(),
  limit: z.coerce.number().int().min(1).max(60).optional(),
});

export const boardGenerateSchema = z.object({
  expectedBoardVersion: z.number().int().positive().optional(),
  nodeRef: boardNodeRefSchema,
  overrides: z.object({
    prompt: z.string().max(BOARD_LIMITS.maxTextChars).optional(),
    model: z.string().max(80).optional(),
    size: z.string().max(60).optional(),
    imageSize: z.enum(IMAGE_SIZE_VALUES).optional(),
    quality: z.string().max(40).optional(),
    count: z.number().int().min(1).max(BOARD_LIMITS.maxCount).optional(),
    videoMode: z.enum(BOARD_VIDEO_MODES).optional(),
    durationSeconds: z.number().int().min(1).max(30).optional(),
    resolution: z.string().max(20).optional(),
    aspectRatio: z.string().max(20).optional(),
    ratio: z.string().max(20).optional(),
    audio: z.boolean().optional(),
    audioKind: z.enum(BOARD_AUDIO_KINDS).optional(),
    voice: z.string().max(40).optional(),
    ttsStyle: z.string().max(200).optional(),
    instrumental: z.boolean().optional(),
  }).optional(),
});

export type BoardReadArgs = z.infer<typeof boardReadSchema>;
export type BoardGenerateArgs = z.infer<typeof boardGenerateSchema>;
