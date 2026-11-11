import { z } from "zod";
import { boardApplySchema, boardGenerateSchema, boardReadSchema } from "../../shared/board-ops.js";

const nodeRef = z.string().regex(/^n[1-9]\d*$/);

export const BOARD_TOOL_SCHEMAS = {
  board_read: boardReadSchema,
  board_apply: boardApplySchema,
  board_generate: boardGenerateSchema,
  board_generate_batch: z.object({
    nodeRefs: z.array(nodeRef).min(1).max(10).refine((refs) => new Set(refs).size === refs.length, "节点不能重复"),
    expectedBoardVersion: z.number().int().positive().optional(),
  }),
  board_check: z.object({ nodeRefs: z.array(nodeRef).min(1).max(20) }),
  board_storyboard_update: z.object({
    expectedBoardVersion: z.number().int().positive().optional(),
    nodeRef,
    revision: z.number().int().positive(),
    patch: z.object({
      prompt: z.string().trim().min(1).max(2000).optional(),
      videoPrompt: z.string().max(2000).optional(),
      dialogue: z.string().max(1000).optional(),
      sourceText: z.string().max(3000).optional(),
      speaker: z.string().max(120).optional(),
      scene: z.string().max(80).optional(),
      character: z.string().max(120).optional(),
      props: z.string().max(200).optional(),
      characterVersions: z.record(z.string().max(80), z.string().max(80)).optional(),
      sceneVersionId: z.string().max(80).optional(),
      propVersions: z.record(z.string().max(80), z.string().max(80)).optional(),
      cameraMove: z.string().max(80).optional(),
      shotSize: z.string().max(40).optional(),
      duration: z.number().min(0.5).max(120).optional(),
    }).refine((patch) => Object.keys(patch).length > 0, "修改不能为空"),
  }),
  board_storyboard: z.object({ nodeRefs: z.array(nodeRef).max(20).optional() }),
  board_assets: z.object({ query: z.string().max(200).default(""), kind: z.enum(["all", "image", "video", "audio"]).default("all") }),
  board_versions: z.object({ nodeRef }),
  board_extract_frame: z.object({ nodeRef, targetRef: nodeRef.optional() }),
  board_view_images: z.object({
    nodeRefs: z.array(nodeRef).max(8).default([]),
    assetIds: z.array(z.string().min(1).max(80)).max(8).default([]),
  }).refine((input) => {
    const count = input.nodeRefs.length + input.assetIds.length;
    return count > 0 && count <= 8;
  }, "一次选择 1 至 8 张图片"),
} as const;

export type BoardToolInput<Name extends keyof typeof BOARD_TOOL_SCHEMAS> = z.output<(typeof BOARD_TOOL_SCHEMAS)[Name]>;
