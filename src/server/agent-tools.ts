/** 工具参数校验与执行入口。各类生成工具通过 TaskRunner 提交任务。 */
import { z } from "zod";
import { assetRef } from "../shared/agent-types.js";
import type {
  AskArgs, EditImageArgs, GenerateImageArgs, GenerateMusicArgs, GenerateSpeechArgs,
  GenerateVideoArgs, OptimizePromptArgs, ReplyArgs, SetCanvasArgs,
} from "../shared/agent-types.js";
import {
  boardApplySchema, boardGenerateSchema, boardReadSchema,
  type BoardApplyArgs, type BoardGenerateArgs, type BoardReadArgs,
} from "../shared/board-ops.js";
import { canvasTemplateInputSchema, type CanvasTemplateInput } from "../shared/canvas-template.js";
import { imageOutputFormatSchema } from "../shared/image-formats.js";
import { storyboardProjectDataSchema } from "../shared/storyboard-project.js";
import { applyStyleSuffix } from "../shared/style-presets.js";
import { IMAGE_SIZE_VALUES, MAX_CANVAS_IMAGES, MAX_REFERENCE_IMAGES } from "../shared/types.js";
import { resolveCanvasRefs } from "./agent-tools/assets.js";
import { generateMusic, generateSpeech } from "./agent-tools/audio.js";
import { generateImage, MAX_EXTRA_REFERENCES } from "./agent-tools/image.js";
import { describeError, failResult, okResult, type ToolContext, type ToolOutcome } from "./agent-tools/shared.js";
import { generateVideo } from "./agent-tools/video.js";
import { applyBoardOps, describeBoard } from "./board-agent.js";
import { describeBoardStoryboards, inspectBoardGeneration } from "./board-assistant.js";
import { requestBoardFrame } from "./board-frame-broker.js";
import { generateBoardConfig } from "./board-generation.js";
import { buildBoardDelta } from "./board.js";
import { callBrain, type BrainMessage } from "./brain.js";
import { buildStoryboardTemplateInput, createCanvasTemplate } from "./canvas-template.js";
import type { BoardRecord } from "./db.js";

export { resolveAssetRef, resolveCanvasRefs, resolveImageRefs } from "./agent-tools/assets.js";
export { prepareMusicInput, prepareSpeechInput } from "./agent-tools/audio.js";
export { IMAGE_TASK_TIMEOUT_MS, IMAGE_WAIT_TIMEOUT_MS, MAX_EXTRA_REFERENCES } from "./agent-tools/image.js";
export type { ToolContext, ToolOutcome } from "./agent-tools/shared.js";
export { resolveVideoSelection, roleLabel, type VideoSelection } from "./agent-tools/video.js";
export { VIDEO_DEFAULTS } from "../shared/video-capabilities.js";

const nonEmpty = (max: number) => z.string().trim().min(1).max(max);

export const generateImageSchema = z.object({
  prompt: nonEmpty(20000),
  modelHint: z.string().trim().max(80).optional(),
  size: z.string().trim().max(60).optional(),
  aspectRatio: z.string().trim().max(20).optional(),
  // gemini 系站点只认 `imageSize`，OpenAI 系只认 `size`；两个都留着，由适配器各取所需。
  // 这里用 enum 而不是自由字符串：值和上游一样大小写敏感，写错等于没写。
  imageSize: z.enum(IMAGE_SIZE_VALUES).optional(),
  count: z.coerce.number().int().min(1).max(8).optional(),
  fromScratch: z.coerce.boolean().optional(),
  outputFormat: imageOutputFormatSchema.optional()
    .describe("输出格式。gif/svg 需要上游模型支持；gif 可用 frame_count / frame_duration_ms 控制帧数与每帧时长，是否多帧最终由模型决定，不要凭后缀判断动没动，需用 view_images 查看帧数和抽样帧。"),
  imageRefs: z.array(z.string().trim().min(1).max(80)).max(MAX_REFERENCE_IMAGES).optional(),
});

export const editImageSchema = z.object({
  prompt: nonEmpty(20000),
  modelHint: z.string().trim().max(80).optional(),
  imageRefs: z.array(z.string().trim().min(1).max(80)).max(MAX_REFERENCE_IMAGES).optional(),
  extraReferences: z.array(z.string().trim().min(1).max(80)).max(MAX_EXTRA_REFERENCES).optional(),
  // 改图照样能定输出尺寸：改完的画面未必沿用原图的形状
  aspectRatio: z.string().trim().max(20).optional(),
  imageSize: z.enum(IMAGE_SIZE_VALUES).optional(),
  outputFormat: imageOutputFormatSchema.optional()
    .describe("输出格式。gif/svg 需要上游模型支持；gif 可用 frame_count / frame_duration_ms 控制帧数与每帧时长，是否多帧最终由模型决定，不要凭后缀判断动没动，需用 view_images 查看帧数和抽样帧。"),
});

export const viewImagesSchema = z.object({
  // 不填 = 看整组当前画布。看图不生成、不花钱，所以上限就是画布上限
  assetRefs: z.array(z.string().trim().min(1).max(80)).max(MAX_CANVAS_IMAGES).optional(),
});

export const setCanvasSchema = z.object({
  // 老用法：一次一张。新的 assetRefs 能一次设一组（上限和画布上限同一个数）
  assetRef: z.string().trim().min(1).max(80).optional(),
  assetRefs: z.array(z.string().trim().min(1).max(80)).max(MAX_CANVAS_IMAGES).optional(),
}).refine((args) => Boolean(args.assetRef || args.assetRefs?.length), {
  message: "assetRef 或 assetRefs 至少要给一个",
});

export const optimizePromptSchema = z.object({
  prompt: nonEmpty(20000),
  target: z.enum(["image", "video"]),
});

export const generateVideoSchema = z.object({
  prompt: nonEmpty(20000),
  modelHint: z.string().trim().max(80).optional(),
  /*
   * `.catch(undefined)` 是给大脑兜底的：提示词里列了合法值，但它偶尔还是会自己发明一个
   * （「image-to-video」这类）。校验整轮失败的话，代价是重新问一次大脑、用户多等一个来回，
   * 而 mode 本来就有「按画布自动判断」的默认路径——丢掉这个字段即可，不必让整次调用失败。
   * 最终用的是哪个 mode，确认卡和结果里都会照实写出来。
   */
  mode: z.enum(["text-to-video", "first-frame", "first-last-frame", "reference", "video-edit", "video-extend"]).optional().catch(undefined),
  duration: z.coerce.number().int().min(1).max(30).optional(),
  resolution: z.string().trim().max(10).optional(),
  audio: z.coerce.boolean().optional(),
  promptExtend: z.coerce.boolean().optional(),
  imageRefs: z.array(z.string().trim().min(1).max(80)).max(MAX_REFERENCE_IMAGES).optional(),
  imageFrom: z.enum(["current", "none"]).optional(),
});

export const generateMusicSchema = z.object({
  prompt: z.string().trim().max(5000).optional(),
  mode: z.enum(["inspiration", "custom", "cover", "mashup", "sound", "playlist", "sample"]).optional().catch(undefined),
  title: z.string().trim().max(80).optional(),
  tags: z.string().trim().max(1000).optional(),
  negativeTags: z.string().trim().max(1000).optional(),
  instrumental: z.coerce.boolean().optional(),
  sourceAssetRefs: z.array(z.string().trim().min(1).max(80)).max(2).optional(),
  tempo: z.coerce.number().int().min(20).max(300).optional(),
  key: z.string().trim().max(10).optional(),
  loop: z.coerce.boolean().optional(),
  modelHint: z.string().trim().max(80).optional(),
  version: z.string().trim().max(40).optional(),
});

export const generateSpeechSchema = z.object({
  text: nonEmpty(20000),
  voice: z.string().trim().max(40).optional(),
  style: z.string().trim().max(200).optional(),
  language: z.string().trim().max(20).optional(),
  secondVoice: z.string().trim().max(40).optional(),
  modelHint: z.string().trim().max(80).optional(),
});

/** 新流程用的精简分镜模板：不写旧分镜表，直接生成无限画布模板 */
export const createStoryboardTemplateSchema = z.object({
  title: z.string().trim().max(80).optional(),
  /** 风格模板：按名字或 id 找内置/自定义；找不到就当成一句自由风格描述用 */
  style: z.string().trim().max(200).optional(),
  brief: z.object({ contentType: z.string().max(80).optional(), duration: z.string().max(80).optional(), aspectRatio: z.string().max(40).optional(), style: z.string().max(300).optional(), density: z.string().max(80).optional(), fidelity: z.string().max(200).optional() }).optional(),
  characters: z.array(z.object({
    name: nonEmpty(40),
    prompt: z.string().trim().max(300).optional(),
  })).max(12).optional(),
  scenes: z.array(z.object({
    name: nonEmpty(80),
    prompt: z.string().trim().max(300).optional(),
  })).max(12).optional(),
  props: z.array(z.object({ name: nonEmpty(80), prompt: z.string().trim().max(300).optional() })).max(12).optional(),
  shots: z.array(z.object({
    prompt: nonEmpty(600),
    character: z.string().trim().max(120).optional(),
    scene: z.string().trim().max(80).optional(),
    props: z.string().trim().max(200).optional(),
    dialogue: z.string().trim().max(1000).optional(),
    speaker: z.string().trim().max(120).optional(),
    shotSize: z.string().trim().max(20).optional(),
    cameraMove: z.string().trim().max(20).optional(),
    sourceText: z.string().trim().max(1000).optional(),
    videoPrompt: z.string().trim().max(600).optional(),
    soundEffect: z.string().trim().max(300).optional(),
  })).min(1).max(60),
});

export const askSchema = z.object({
  question: nonEmpty(2000),
  options: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
});

export const replySchema = z.object({
  text: nonEmpty(8000),
});

export const TOOL_SCHEMAS = {
  generate_image: generateImageSchema,
  edit_image: editImageSchema,
  view_images: viewImagesSchema,
  set_canvas: setCanvasSchema,
  optimize_prompt: optimizePromptSchema,
  generate_video: generateVideoSchema,
  generate_music: generateMusicSchema,
  generate_speech: generateSpeechSchema,
  create_storyboard_template: createStoryboardTemplateSchema,
  create_canvas_template: canvasTemplateInputSchema,
  doc_list: z.never(), doc_delete: z.never(), doc_read: z.never(), doc_search: z.never(), doc_create: z.never(), doc_edit: z.never(), doc_convert: z.never(), plan_update: z.never(),
  // 保留旧名称以识别历史调用；在执行入口统一返回模式引导，不再运行旧导出器。
  document_read: z.never(),
  document_make_pptx: z.never(),
  board_read: boardReadSchema,
  board_apply: boardApplySchema,
  board_generate: boardGenerateSchema,
  board_generate_batch: z.object({ nodeRefs: z.array(z.string().regex(/^n[1-9]\d*$/)).min(1).max(10).refine((refs) => new Set(refs).size === refs.length, "节点不能重复"), expectedBoardVersion: z.number().int().positive().optional() }),
  board_check: z.object({ nodeRefs: z.array(z.string().regex(/^n[1-9]\d*$/)).min(1).max(20) }),
  board_storyboard_update: z.object({ expectedBoardVersion: z.number().int().positive().optional(), nodeRef: z.string().regex(/^n[1-9]\d*$/), revision: z.number().int().positive(), patch: z.object({ prompt: z.string().trim().min(1).max(2000).optional(), videoPrompt: z.string().max(2000).optional(), dialogue: z.string().max(1000).optional(), sourceText: z.string().max(3000).optional(), speaker: z.string().max(120).optional(), scene: z.string().max(80).optional(), character: z.string().max(120).optional(), props: z.string().max(200).optional(), characterVersions: z.record(z.string().max(80), z.string().max(80)).optional(), sceneVersionId: z.string().max(80).optional(), propVersions: z.record(z.string().max(80), z.string().max(80)).optional(), cameraMove: z.string().max(80).optional(), shotSize: z.string().max(40).optional(), duration: z.number().min(0.5).max(120).optional() }).refine((patch) => Object.keys(patch).length > 0, "修改不能为空") }),
  board_storyboard: z.object({ nodeRefs: z.array(z.string().regex(/^n[1-9]\d*$/)).max(20).optional() }),
  board_assets: z.object({ query: z.string().max(200).default(""), kind: z.enum(["all", "image", "video", "audio"]).default("all") }),
  board_versions: z.object({ nodeRef: z.string().regex(/^n[1-9]\d*$/) }),
  board_extract_frame: z.object({ nodeRef: z.string().regex(/^n[1-9]\d*$/), targetRef: z.string().regex(/^n[1-9]\d*$/).optional() }),
  board_view_images: z.object({ nodeRefs: z.array(z.string().regex(/^n[1-9]\d*$/)).max(8).default([]), assetIds: z.array(z.string().min(1).max(80)).max(8).default([]) }).refine((input) => input.nodeRefs.length + input.assetIds.length > 0 && input.nodeRefs.length + input.assetIds.length <= 8, "一次选择 1 至 8 张图片"),
  ask: askSchema,
  reply: replySchema,
} as const;

/**
 * §8 的 `optimize_prompt`：**只返回文本，不直接生成**。
 *
 * 走一次独立的大脑调用而不是主循环，因为这里的输出格式完全不同
 * （一个 `{"prompt": "..."}`，不是工具计划），塞进主循环会让 JSON 协议变复杂。
 */
async function optimizePrompt(ctx: ToolContext, args: OptimizePromptArgs): Promise<ToolOutcome> {
  // 开了原话直发还来优化，就是和用户的要求对着干——直接说清，别白花一次大脑调用
  if (ctx.verbatimPrompt) {
    return failResult("这个会话开着「原话直发」，提示词要逐字用用户的原话，不做优化", "VERBATIM_PROMPT");
  }
  const conversation = ctx.conversation;
  const channel = ctx.db.getChannel(conversation.brainChannelId);
  if (!channel || !channel.enabled) return failResult("大脑渠道不可用，无法优化提示词", "BRAIN_UNAVAILABLE");
  const key = ctx.sessionKeys.get(channel.id) || (channel.secretEnv ? process.env[channel.secretEnv] ?? "" : "");
  if (!key && channel.authType !== "none") return failResult("大脑渠道没有可用密钥", "CHANNEL_AUTH_FAILED");

  const target = args.target === "video" ? "视频" : "图片";
  const messages: BrainMessage[] = [
    {
      role: "system",
      content: [
        `你是提示词工程师。把用户给的${target}提示词重写成一段具体、可直接使用的提示词。`,
        "补全主体、构图、光线、材质、镜头语言、风格等要素；保留用户的原意和所有具体设定。",
        target === "视频" ? "视频提示词要写清运动方式和镜头运动。" : "",
        "只输出一个 JSON 对象，不要输出解释文字、不要包 markdown 代码块。",
        '输出格式：{"prompt": "重写后的提示词"}',
      ].filter(Boolean).join("\n"),
    },
    { role: "user", content: args.prompt },
  ];
  try {
    const result = await callBrain({ channel, key, model: conversation.brainModel, messages, signal: ctx.signal });
    // 优化提示词也是一次真花钱的大脑调用，账本里不能漏
    if (result.usage) ctx.db.recordBrainCall(conversation.id, result.usage);
    const parsed = parseLooseJson(result.content) as { prompt?: unknown } | null;
    const optimized = typeof parsed?.prompt === "string" && parsed.prompt.trim() ? parsed.prompt.trim() : result.content.trim();
    if (!optimized) return failResult("优化提示词没有返回内容", "EMPTY_RESPONSE");
    return okResult(`优化后的提示词：${optimized}`, { data: { prompt: optimized, target: args.target } });
  } catch (error) {
    return failResult(`优化提示词失败：${describeError(error)}`, "OPTIMIZE_FAILED");
  }
}

/** 剥掉 markdown 代码块、再退化成「取第一个花括号块」，和 plan 解析同一套宽容度 */
function parseLooseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  for (const candidate of [trimmed, sliceFirstObject(trimmed)]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // 换下一个候选
    }
  }
  return null;
}

function sliceFirstObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/** 扫一遍括号和字符串状态，返回扫描终点还差几个 `}`、有没有停在半个字符串里 */
function scanState(text: string, start: number, end: number) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < end; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
  }
  return { depth, inString };
}

/**
 * 给被截断的输出「缝」一个能用的对象。
 *
 * 推理模型偶尔在 JSON 还没写完就撞上 max_tokens，`sliceFirstObject` 要求括号平衡，
 * 所以这种输出它一律救不回来。这里的做法是：从末尾往前退到上一个逗号，
 * 每次把没写完的字符串补上引号、把没关上的括号补上，试着解析，
 * 第一个能解析成功的就是答案——丢掉的是尾巴上那半个参数，保住的是整个计划。
 *
 * 只在重试也没救回来时用作兜底：宁可让默认参数补上缺口，也别让一整轮白跑。
 * 返回 null 表示连 `{` 都没有，或者本来就是完整的（那是 `parseLooseJson` 的事）。
 */
export function repairTruncatedObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  const whole = scanState(text, start, text.length);
  if (!whole.inString && whole.depth <= 0) return null;

  const cuts: number[] = [text.length];
  for (let at = text.lastIndexOf(","); at > start; at = text.lastIndexOf(",", at - 1)) cuts.push(at);

  for (const cut of cuts) {
    const state = scanState(text, start, cut);
    if (state.depth <= 0) continue;
    const body = text.slice(start, cut) + (state.inString ? '"' : "");
    const candidate = body + "}".repeat(state.depth);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // 退到上一个逗号再试
    }
  }
  return null;
}

export { parseLooseJson, sliceFirstObject };

function setCanvas(ctx: ToolContext, args: SetCanvasArgs): ToolOutcome {
  const refs = args.assetRefs?.length ? args.assetRefs : args.assetRef ? [args.assetRef] : [];
  const { ids, notes } = resolveCanvasRefs(ctx.db, ctx.conversation.id, refs);
  // 一张都没解析出来就硬失败，别让大脑把画布清空——它多半是抄错了 ref，让回灌的错误提示纠正它
  if (!ids.length) {
    return failResult(`找不到产物 ${refs.join("、")}，可用的产物见「历史结果」那一段`, "ASSET_NOT_FOUND");
  }
  ctx.db.updateConversation(ctx.conversation.id, { canvasAssetIds: ids });
  const summary = ids.length === 1
    ? `已把当前画布切到 ${assetRef(ids[0]!)}。`
    : `已把当前画布设为 ${ids.map((id) => assetRef(id)).join("、")}（共 ${ids.length} 张，第 1 张是主图）。`;
  return okResult(notes.length ? `${summary}注意：${notes.join("；")}` : summary, {
    // 卡片上的缩略图只装得下主图一张；整组的信息走 data（那是"只给前端渲染"的字段）
    assetId: ids[0]!,
    data: { canvasAssetIds: ids },
  });
}

/**
 * 生成一块可反复导入无限画布的模板。
 *
 * 只落模板，不创建无限画布、不提交生成；用户点卡片上的「导入无限画布」才实例化。
 */
function createCanvasTemplateTool(ctx: ToolContext, args: CanvasTemplateInput): ToolOutcome {
  try {
    const template = createCanvasTemplate(ctx.db, args, {
      source: "agent",
      conversationId: ctx.conversation.id,
    });
    const groupCount = template.doc.groups?.length ?? 0;
    return okResult(
      `已生成模板「${template.name}」：${template.doc.nodes.length} 个节点${groupCount ? `、${groupCount} 个分组` : ""}。点「导入无限画布」选择目标板。`,
      {
        data: {
          templateId: template.id,
          templateName: template.name,
          templateDescription: template.description,
          templateNodeCount: template.doc.nodes.length,
          templateGroupCount: groupCount,
        },
      },
    );
  } catch (error) {
    return failResult(`生成模板失败：${describeError(error)}`, "TEMPLATE_CREATE_FAILED");
  }
}

/** 新流程：拆镜 → 直接生成无限画布模板（含角色 / 场景参考），不写旧分镜表 */
function createStoryboardTemplateTool(
  ctx: ToolContext,
  args: z.infer<typeof createStoryboardTemplateSchema>,
): ToolOutcome {
  try {
    const uniqueSettings = (items: Array<{ name: string; prompt?: string }> = []) =>
      [...new Map(items.map((item) => [item.name.trim(), { name: item.name.trim(), prompt: item.prompt ?? "" }])).values()];
    const styleName = args.style?.trim() ?? "";
    const preset = styleName ? ctx.db.findStylePreset(styleName) : null;
    // 找不到模板时把用户这句话当风格用：总比悄悄丢掉好
    const styleSuffix = preset?.prompt ?? (preset || !styleName ? "" : styleName);
    const withStyle = (text: string) => styleSuffix ? applyStyleSuffix(text, { prompt: styleSuffix }) : text;

    const data = storyboardProjectDataSchema.parse({
      name: args.title?.trim() || `${ctx.conversation.title} · 分镜`,
      brief: { ...(args.brief ?? {}), ...(styleName && !(args.brief?.style ?? "").trim() ? { style: preset?.name ?? styleName } : {}) },
      characters: uniqueSettings(args.characters),
      scenes: uniqueSettings(args.scenes),
      props: uniqueSettings(args.props),
      shots: args.shots.map((shot) => ({
        ...shot,
        prompt: withStyle(shot.prompt),
        ...(shot.videoPrompt?.trim() ? { videoPrompt: withStyle(shot.videoPrompt) } : {}),
        id: crypto.randomUUID(),
      })),
    });
    const input = buildStoryboardTemplateInput({
      name: data.name,
      description: `${data.shots.length} 个镜头${data.shots.length > 30 ? "（模板为前 30 镜，请在分镜审阅中分批导入）" : ""}，含角色 / 场景参考；导入后不会自动生成。`,
      characters: data.characters, scenes: data.scenes, props: data.props,
      shots: data.shots.slice(0, 30).map((shot, index) => ({ ...shot, props: shot.props.split(/[、,，]/).map((name) => name.trim()).filter(Boolean), index: index + 1, kind: "image" as const })),
    });
    const template = createCanvasTemplate(ctx.db, input, { source: "storyboard", conversationId: ctx.conversation.id });
    ctx.db.createStoryboardProject(template.id, ctx.conversation.id, data);
    const groupCount = template.doc.groups?.length ?? 0;
    return okResult(
      `已生成分镜「${template.name}」：${args.shots.length} 镜${styleSuffix ? `，已套用风格「${preset?.name ?? styleSuffix}」` : ""}。请先审阅、修改或选择镜头，再导入无限画布；不会自动生成。`,
      {
        data: {
          templateId: template.id,
          templateName: template.name,
          templateDescription: template.description,
          templateNodeCount: template.doc.nodes.length,
          templateGroupCount: groupCount,
          storyboardProjectId: template.id,
          storyboardCount: args.shots.length,
          storyboardCharacters: args.characters?.map((item) => item.name) ?? [],
          storyboardScenes: args.scenes?.map((item) => item.name) ?? [],
        },
      },
    );
  } catch (error) {
    return failResult(`生成分镜模板失败：${describeError(error)}`, "STORYBOARD_TEMPLATE_FAILED");
  }
}

/** 工具统一入口：先校验参数，再分发。参数不合法的错误会回灌给大脑让它重试 */
const BOARD_TOOL_NAMES = new Set(["board_read", "board_apply", "board_generate", "board_generate_batch", "board_check", "board_storyboard", "board_storyboard_update", "board_assets", "board_versions", "board_view_images", "board_extract_frame"]);

function boardForTool(ctx: ToolContext): BoardRecord | null {
  if (ctx.conversation.kind !== "board" || !ctx.conversation.boardId) return null;
  return ctx.db.getBoardRecord(ctx.conversation.boardId);
}

function boardReadTool(ctx: ToolContext, args: BoardReadArgs): ToolOutcome {
  const board = boardForTool(ctx);
  if (!board) return failResult("board_read 只能在无限画布线程里使用", "BOARD_ONLY");
  const text = describeBoard(board, args);
  return okResult(text, {
    data: {
      boardId: board.id,
      nodeCount: board.doc.nodes.length,
      edgeCount: board.doc.edges.length,
    },
  });
}

function boardApplyTool(ctx: ToolContext, args: BoardApplyArgs): ToolOutcome {
  const board = boardForTool(ctx);
  if (!board) return failResult("board_apply 只能在无限画布线程里使用", "BOARD_ONLY");
  try {
    if (args.expectedBoardVersion && board.version !== args.expectedBoardVersion) return failResult("画布在确认后发生变化，请重新检查并确认操作。", "BOARD_VERSION_CONFLICT");
    const result = applyBoardOps(ctx.db, board.id, args.ops);
    ctx.emit({
      type: "board",
      boardId: board.id,
      version: result.board.version,
      reason: "agent:apply",
      delta: buildBoardDelta(board.id, board.doc, result.board.doc, board.version, result.board.version),
    });
    return okResult(result.summary, { data: result.data });
  } catch (error) {
    return failResult(describeError(error), "BOARD_APPLY_FAILED");
  }
}

async function boardGenerateTool(ctx: ToolContext, args: BoardGenerateArgs): Promise<ToolOutcome> {
  const board = boardForTool(ctx);
  if (!board) return failResult("board_generate 只能在无限画布线程里使用", "BOARD_ONLY");
  const target = board.doc.nodes.find((node) => node.ref === args.nodeRef);
  if (!target || target.type === "text") {
    return failResult(`节点 ${args.nodeRef} 不能生成：请指定配置 / 图片 / 视频 / 音频节点`, "BOARD_CONFIG_NOT_FOUND");
  }
  try {
    if (args.expectedBoardVersion && board.version !== args.expectedBoardVersion) return failResult("画布在确认后发生变化，请重新检查并确认生成。", "BOARD_VERSION_CONFLICT");
    const check = inspectBoardGeneration(ctx.db, board, ctx.aliases, ctx.defaultAliases, [args.nodeRef], args.overrides)[0];
    if (check?.errors.length) return failResult(`生成前检查未通过：${check.errors.join("；")}`, "BOARD_PREFLIGHT_FAILED");
    const result = await generateBoardConfig({
      db: ctx.db,
      runner: ctx.runner,
      keys: ctx.sessionKeys,
      boardId: board.id,
      nodeId: target.id,
      ...(args.overrides ? { overrides: args.overrides } : {}),
    });
    const resultNodes = result.board.doc.nodes.filter((node) => result.resultNodeIds.includes(node.id));
    const refs = resultNodes.map((node) => node.ref);
    const unit = result.kind === "video" ? "个视频"
      : result.kind === "text" ? "段文本"
        : result.kind === "audio" ? "个音频"
          : "张图";
    ctx.emit({
      type: "board",
      boardId: board.id,
      version: result.board.version,
      reason: "agent:generate",
      delta: buildBoardDelta(board.id, board.doc, result.board.doc, board.version, result.board.version),
    });
    const summary = result.task
      ? `已提交：${args.nodeRef} 生成 ${refs.length} ${unit}，结果节点 ${refs.join("、")}；taskId=${result.task.id}。结果会由画布回填。`
      : `已生成：${args.nodeRef} 的 ${refs.length} 段文本已写入结果节点 ${refs.join("、")}。`;
    return okResult(
      summary,
      {
        ...(result.task ? { taskId: result.task.id, async: true } : {}),
        data: {
          nodeRef: args.nodeRef,
          ...(result.task ? { taskId: result.task.id } : {}),
          kind: result.kind,
          resultRefs: refs,
          resultNodeIds: result.resultNodeIds,
          modelAlias: result.modelAlias,
          referenceCount: result.referenceCount,
        },
      },
    );
  } catch (error) {
    return failResult(describeError(error), "BOARD_GENERATE_FAILED");
  }
}

export async function runAgentTool(
  name: keyof typeof TOOL_SCHEMAS,
  rawArgs: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  // 在参数解析前拦截，历史计划、批量调用和确认后重放都不能绕过。
  if (name === "document_read" || name === "document_make_pptx") {
    return failResult(
      "创作助手的旧 PPT 工具已停用。请在当前对话输入框的模式菜单中切换到「普通聊天」，再发送制作、转换或修改 PPT 的要求；已上传的文件会保留，无需重新上传。请直接向用户说明，不要重试旧工具或声称已生成、修改文件。",
      "PPT_CHAT_MODE_REQUIRED",
    );
  }
  // 无限画布线程只开放 board_* 和纯文本工具，避免大脑把对话 / 分镜工具用错地方
  if (ctx.conversation.kind === "board"
    && !BOARD_TOOL_NAMES.has(name)
    && name !== "ask"
    && name !== "reply"
    && name !== "create_storyboard_template") {
    return failResult(
      `无限画布线程只能使用 board_read / board_apply / board_generate / ask / reply，不能调用 ${name}`,
      "BOARD_TOOL_ONLY",
    );
  }

  const schema = TOOL_SCHEMAS[name];
  const parsed = schema.safeParse(rawArgs);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "args"}: ${issue.message}`)
      .slice(0, 5)
      .join("；");
    return failResult(`工具 ${name} 的参数不合法（${detail}），请修正后重新输出一个 JSON 对象`, "INVALID_ARGS");
  }

  switch (name) {
    case "generate_image": return generateImage(ctx, parsed.data as GenerateImageArgs, false);
    case "edit_image": return generateImage(ctx, parsed.data as GenerateImageArgs & EditImageArgs, true);
    case "view_images":
      // 正常路径由 Agent 主循环直接处理（它得把缩略图塞进下一轮大脑上下文）。
      // 走到这里只可能是大脑把 view_images 放进了 calls 批量。
      return failResult("view_images 必须单独调用，不能放进 calls 批量里", "VIEW_IMAGES_BATCHED");
    case "set_canvas": return setCanvas(ctx, parsed.data as SetCanvasArgs);
    case "optimize_prompt": return optimizePrompt(ctx, parsed.data as OptimizePromptArgs);
    case "generate_video": return generateVideo(ctx, parsed.data as GenerateVideoArgs);
    case "generate_music": return generateMusic(ctx, parsed.data as GenerateMusicArgs);
    case "generate_speech": return generateSpeech(ctx, parsed.data as GenerateSpeechArgs);
    case "create_storyboard_template": return createStoryboardTemplateTool(ctx, parsed.data as z.infer<typeof createStoryboardTemplateSchema>);
    case "create_canvas_template": return createCanvasTemplateTool(ctx, parsed.data as CanvasTemplateInput);
    case "board_read": return boardReadTool(ctx, parsed.data as BoardReadArgs);
    case "board_apply": return boardApplyTool(ctx, parsed.data as BoardApplyArgs);
    case "board_generate": return boardGenerateTool(ctx, parsed.data as BoardGenerateArgs);
    case "board_generate_batch": {
      const board = boardForTool(ctx); if (!board) return failResult("画布不存在", "BOARD_ONLY");
      const input = parsed.data as z.infer<typeof TOOL_SCHEMAS.board_generate_batch>;
      if (input.expectedBoardVersion && input.expectedBoardVersion !== board.version) return failResult("画布在确认后发生变化，请重新检查并确认", "BOARD_VERSION_CONFLICT");
      const checks = inspectBoardGeneration(ctx.db, board, ctx.aliases, ctx.defaultAliases, input.nodeRefs);
      const blocked = checks.filter((item) => item.errors.length || item.kind === "text");
      if (blocked.length) return failResult(`批量生成前检查未通过：${blocked.map((item) => `${item.ref} ${item.errors.join("、") || "不支持文本节点批量生成"}`).join("；")}`, "BOARD_PREFLIGHT_FAILED");
      const tasks: Array<{ ref: string; id: string }> = []; const failures: string[] = [];
      let expectedVersion = board.version;
      for (const ref of input.nodeRefs) {
        if (ctx.signal?.aborted) { failures.push("用户中止后续提交；已提交任务仍在后台执行"); break; }
        const before = ctx.db.getBoardRecord(board.id);
        if (!before || before.version !== expectedVersion) { failures.push("画布在批量提交期间变化，已停止提交剩余节点"); break; }
        const node = before.doc.nodes.find((item) => item.ref === ref);
        if (!node) { failures.push(`${ref} 不存在`); break; }
        try {
          const result = await generateBoardConfig({ db: ctx.db, runner: ctx.runner, keys: ctx.sessionKeys, boardId: board.id, nodeId: node.id });
          expectedVersion = result.board.version;
          ctx.emit({ type: "board", boardId: board.id, version: result.board.version, reason: "agent:batch-generate", delta: buildBoardDelta(board.id, before.doc, result.board.doc, before.version, result.board.version) });
          if (result.task) { tasks.push({ ref, id: result.task.id }); ctx.emit({ type: "board_batch_progress", text: `已提交 ${tasks.length}/${input.nodeRefs.length} 个任务，最新节点 ${ref}` }); }
        } catch (error) { failures.push(`${ref} 提交失败：${describeError(error)}`); break; }
      }
      const completed = await Promise.all(tasks.map(async (task) => {
        try { const result = await ctx.runner.waitFor(task.id, { timeoutMs: 15 * 60_000, signal: ctx.signal }); ctx.emit({ type: "board_batch_progress", text: `${task.ref} ${result.status === "succeeded" ? "已完成" : "失败或停止"}，其余任务继续` }); return `${task.ref}：${result.status === "succeeded" ? "已完成" : `失败或停止（${result.errorMessage || result.status}）`}`; }
        catch (error) { return `${task.ref}：${ctx.signal?.aborted ? "已停止等待，任务可能仍在后台执行" : describeError(error)}`; }
      }));
      const summary = [`批量提交 ${tasks.length}/${input.nodeRefs.length} 个任务。`, ...completed, ...failures].join("\n");
      if (!tasks.length && failures.length) return failResult(summary, "BOARD_BATCH_FAILED");
      return okResult(summary, { data: { taskIds: tasks.map((item) => item.id) } });
    }
    case "board_storyboard_update": {
      const board = boardForTool(ctx); if (!board) return failResult("画布不存在", "BOARD_ONLY");
      const input = parsed.data as z.infer<typeof TOOL_SCHEMAS.board_storyboard_update>;
      if (input.expectedBoardVersion && input.expectedBoardVersion !== board.version) return failResult("画布在确认后发生变化，请重新检查分镜", "BOARD_VERSION_CONFLICT");
      const node = board.doc.nodes.find((item) => item.ref === input.nodeRef);
      if (!node?.storyboard) return failResult("该节点没有关联的分镜项目", "STORYBOARD_NOT_FOUND");
      const project = ctx.db.getStoryboardProject(node.storyboard.projectId);
      if (!project || project.revision !== input.revision) return failResult("分镜不存在或已改变，请重新读取", "STORYBOARD_CONFLICT");
      const shotIndex = project.data.shots.findIndex((shot) => shot.id === node.storyboard!.shotId);
      if (shotIndex < 0) return failResult("项目中的镜头不存在", "STORYBOARD_NOT_FOUND");
      const previous = project.data.shots[shotIndex]!;
      const next = { ...previous, ...input.patch };
      if (input.patch.scene !== undefined && input.patch.scene !== previous.scene && input.patch.sceneVersionId === undefined) next.sceneVersionId = "";
      if (input.patch.character !== undefined && input.patch.characterVersions === undefined) { const names = new Set(next.character.split(/[、,，]/).map((name) => name.trim())); next.characterVersions = Object.fromEntries(Object.entries(next.characterVersions).filter(([name]) => names.has(name))); }
      if (input.patch.props !== undefined && input.patch.propVersions === undefined) { const names = new Set(next.props.split(/[、,，]/).map((name) => name.trim())); next.propVersions = Object.fromEntries(Object.entries(next.propVersions).filter(([name]) => names.has(name))); }
      const scene = project.data.scenes.find((item) => item.name === next.scene);
      if (next.sceneVersionId && !scene?.variants.some((item) => item.id === next.sceneVersionId)) return failResult("场景版本不存在，请先读取对应的版本 ID", "STORYBOARD_VARIANT_MISSING");
      for (const [key, values, text] of [["characterVersions", project.data.characters, next.character], ["propVersions", project.data.props, next.props]] as const) {
        const names = new Set(text.split(/[、,，]/).map((name) => name.trim()).filter(Boolean));
        for (const [name, id] of Object.entries(next[key])) if (id && (!names.has(name) || !values.find((item) => item.name === name)?.variants.some((item) => item.id === id))) return failResult(`「${name}」的版本不存在或不在该镜头中`, "STORYBOARD_VARIANT_MISSING");
      }
      const data = storyboardProjectDataSchema.parse({ ...project.data, shots: project.data.shots.map((shot, index) => index === shotIndex ? next : shot) });
      if (!ctx.db.updateStoryboardProject(project.id, project.revision, data)) return failResult("分镜已改变，请重新读取", "STORYBOARD_CONFLICT");
      return okResult(`已更新分镜项目「${project.data.name}」第 ${shotIndex + 1} 镜。当前画布是导入快照，尚未改变；需要重新导入或单独修改画布。`);
    }
    case "board_storyboard": {
      const board = boardForTool(ctx); if (!board) return failResult("画布不存在", "BOARD_ONLY");
      return okResult(describeBoardStoryboards(ctx.db, board, (parsed.data as { nodeRefs?: string[] }).nodeRefs));
    }
    case "board_check": {
      const board = boardForTool(ctx); if (!board) return failResult("画布不存在", "BOARD_ONLY");
      const checks = inspectBoardGeneration(ctx.db, board, ctx.aliases, ctx.defaultAliases, (parsed.data as { nodeRefs: string[] }).nodeRefs);
      return okResult(checks.map((item) => `${item.ref} ${item.kind} 模型：${item.model}；${item.errors.length ? `不能生成：${item.errors.join("、")}` : "基础检查通过"}${item.warnings.length ? `；注意：${item.warnings.join("、")}` : ""}`).join("\n") + "\n此检查不提交任务，实际能力仍以渠道响应为准。", { data: { checks } });
    }
    case "board_assets": {
      const input = parsed.data as { query: string; kind: "all" | "image" | "video" | "audio" };
      const records = ctx.db.listLibraryTaskViews({ limit: 20, offset: 0, query: input.query, kind: input.kind, mode: "assets" });
      const assets = records.flatMap((task) => task.assets).filter((asset) => input.kind === "all" || asset.mimeType.startsWith(`${input.kind}/`)).slice(0, 20);
      return okResult(assets.length ? assets.map((asset) => `素材ID=${asset.id} 类型=${asset.mimeType} 名称=${asset.title || asset.fileName}`).join("\n") : "公共素材库没有匹配的素材。", { data: { count: assets.length } });
    }
    case "board_versions": {
      const board = boardForTool(ctx); if (!board) return failResult("画布不存在", "BOARD_ONLY");
      const ref = (parsed.data as { nodeRef: string }).nodeRef;
      const node = board.doc.nodes.find((item) => item.ref === ref);
      if (!node || (node.type !== "image" && node.type !== "video" && node.type !== "audio")) return failResult("请选择素材节点", "BOARD_NODE_NOT_FOUND");
      const rows = ctx.db.listBoardTasksByBoard(board.id).filter((row) => row.resultNodeId === node.id).reverse().slice(0, 20);
      const versions = rows.flatMap((row) => { const task = ctx.db.getTaskView(row.taskId); if (!task || task.status !== "succeeded") return []; const siblings = ctx.db.listBoardTasksByTask(row.taskId).filter((entry) => entry.boardId === board.id); const index = siblings.findIndex((entry) => entry.resultNodeId === node.id); const asset = task.assets.filter((entry) => entry.mimeType.startsWith(`${node.type}/`))[index]; return asset ? [{ taskId: task.id, assetId: asset.id, model: task.model, prompt: task.prompt, finishedAt: task.finishedAt }] : []; });
      return okResult(versions.length ? versions.map((item) => `素材ID=${item.assetId} 模型=${item.model} 时间=${item.finishedAt ?? "未知"} 提示词=${item.prompt.slice(0, 150)}`).join("\n") : `${ref} 没有可用的生成版本。`, { data: { versions } });
    }
    case "board_extract_frame": {
      const board = boardForTool(ctx); if (!board) return failResult("画布不存在", "BOARD_ONLY");
      const input = parsed.data as z.infer<typeof TOOL_SCHEMAS.board_extract_frame>;
      const video = board.doc.nodes.find((item) => item.ref === input.nodeRef);
      if (!video || video.type !== "video" || !video.assetId || !ctx.db.getAsset(video.assetId)) return failResult("所选视频节点没有可用视频", "BOARD_VIDEO_MISSING");
      if (input.targetRef) {
        const target = board.doc.nodes.find((item) => item.ref === input.targetRef);
        if (!target || (target.type !== "video" && !(target.type === "config" && target.mode === "video"))) return failResult("目标不是视频生成节点", "BOARD_TARGET_INVALID");
        if (target.videoMode && target.videoMode !== "first-frame") return failResult("目标当前不是首帧模式，请先调整视频方式", "BOARD_VIDEO_MODE_CONFLICT");
        if (board.doc.edges.some((edge) => edge.target === target.id && edge.kind === "input" && board.doc.nodes.some((item) => item.id === edge.source && item.type === "image"))) return failResult("目标已有图片输入，请先明确移除原图片连线后再提取连接", "BOARD_FIRST_FRAME_EXISTS");
      }
      const request = requestBoardFrame(board.id, ctx.signal);
      ctx.emit({ type: "board_frame_request", boardId: board.id, requestId: request.requestId, videoAssetId: video.assetId });
      try {
        const assetId = await request.promise;
        const asset = ctx.db.getAsset(assetId);
        if (!asset || !asset.mimeType.startsWith("image/") || !ctx.db.findBoardAssetRefs(assetId).some((item) => item.boardId === board.id)) return failResult("提取结果不是当前画布的图片", "FRAME_INVALID");
        const before = ctx.db.getBoardRecord(board.id); if (!before) return failResult("画布不存在", "BOARD_ONLY");
        const source = before.doc.nodes.find((item) => item.id === video.id);
        if (!source || source.type !== "video" || source.assetId !== video.assetId) return failResult("提取期间视频发生变化，请重新操作", "BOARD_VERSION_CONFLICT");
        if (input.targetRef) {
          const target = before.doc.nodes.find((item) => item.ref === input.targetRef);
          if (!target || (target.type !== "video" && !(target.type === "config" && target.mode === "video")) || (target.videoMode && target.videoMode !== "first-frame") || before.doc.edges.some((edge) => edge.target === target.id && edge.kind === "input" && before.doc.nodes.some((item) => item.id === edge.source && item.type === "image"))) return failResult("提取期间目标或首帧连线发生变化，请重新检查", "BOARD_VERSION_CONFLICT");
        }
        const ops: BoardApplyArgs["ops"] = [{ op: "add_node", tempId: "frame", type: "image", x: source.x + source.width + 100, y: source.y, title: `${source.title || source.ref} · 尾帧`.slice(0, 80), assetRef: assetId }];
        if (input.targetRef) ops.push({ op: "connect", from: "frame", to: input.targetRef, kind: "input", role: "first-frame" });
        const result = applyBoardOps(ctx.db, board.id, ops);
        ctx.emit({ type: "board", boardId: board.id, version: result.board.version, reason: "agent:frame", delta: buildBoardDelta(board.id, before.doc, result.board.doc, before.version, result.board.version) });
        return okResult(`已提取 ${input.nodeRef} 的视频尾帧为 ${result.data.created[0]?.ref ?? "图片节点"}${input.targetRef ? `，并连接到 ${input.targetRef} 的首帧` : "，可用于下一镜的首帧"}。`);
      } catch (error) { return failResult(describeError(error), "FRAME_EXTRACTION_FAILED"); }
    }
    case "board_view_images": return failResult("看图工具必须单独调用", "BOARD_VISION_BATCHED");
    // ask / reply 由 Agent 循环直接处理（它们只需要生成一段文本，没有副作用）
    case "ask": return okResult((parsed.data as AskArgs).question);
    case "reply": return okResult((parsed.data as ReplyArgs).text);
    default: return failResult(`不认识工具 ${name}`, "UNKNOWN_TOOL");
  }
}
