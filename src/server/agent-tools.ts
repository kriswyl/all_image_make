/** 工具参数校验与执行入口。各类生成工具通过 TaskRunner 提交任务。 */
import { z } from "zod";
import { assetRef } from "../shared/agent-types.js";
import type {
  AskArgs, EditImageArgs, GenerateImageArgs, GenerateMusicArgs, GenerateSpeechArgs,
  GenerateVideoArgs, OptimizePromptArgs, ReplyArgs, SetCanvasArgs,
} from "../shared/agent-types.js";
import type { BoardApplyArgs, BoardGenerateArgs, BoardReadArgs } from "../shared/board-ops.js";
import { canvasTemplateInputSchema, type CanvasTemplateInput } from "../shared/canvas-template.js";
import { imageOutputFormatSchema } from "../shared/image-formats.js";
import { storyboardProjectDataSchema } from "../shared/storyboard-project.js";
import { applyStyleSuffix } from "../shared/style-presets.js";
import { IMAGE_SIZE_VALUES, MAX_CANVAS_IMAGES, MAX_REFERENCE_IMAGES } from "../shared/types.js";
import { resolveCanvasRefs } from "./agent-tools/assets.js";
import { BOARD_TOOL_SCHEMAS, type BoardToolInput } from "./agent-tools/board-schema.js";
import {
  boardApplyTool, boardAssetsTool, boardCheckTool, boardExtractFrameTool, boardGenerateBatchTool,
  boardGenerateTool, boardReadTool, boardStoryboardTool, boardStoryboardUpdateTool, boardVersionsTool,
} from "./agent-tools/board.js";
import { generateMusic, generateSpeech } from "./agent-tools/audio.js";
import { generateImage, MAX_EXTRA_REFERENCES } from "./agent-tools/image.js";
import { describeError, failResult, okResult, type ToolContext, type ToolOutcome } from "./agent-tools/shared.js";
import { generateVideo } from "./agent-tools/video.js";
import { callBrain, type BrainMessage } from "./brain.js";
import { buildStoryboardTemplateInput, createCanvasTemplate } from "./canvas-template.js";

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
  ...BOARD_TOOL_SCHEMAS,
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
    && !Object.hasOwn(BOARD_TOOL_SCHEMAS, name)
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
    case "board_generate_batch": return boardGenerateBatchTool(ctx, parsed.data as BoardToolInput<"board_generate_batch">);
    case "board_storyboard_update": return boardStoryboardUpdateTool(ctx, parsed.data as BoardToolInput<"board_storyboard_update">);
    case "board_storyboard": return boardStoryboardTool(ctx, parsed.data as BoardToolInput<"board_storyboard">);
    case "board_check": return boardCheckTool(ctx, parsed.data as BoardToolInput<"board_check">);
    case "board_assets": return boardAssetsTool(ctx, parsed.data as BoardToolInput<"board_assets">);
    case "board_versions": return boardVersionsTool(ctx, parsed.data as BoardToolInput<"board_versions">);
    case "board_extract_frame": return boardExtractFrameTool(ctx, parsed.data as BoardToolInput<"board_extract_frame">);
    case "board_view_images": return failResult("看图工具必须单独调用", "BOARD_VISION_BATCHED");
    // ask / reply 由 Agent 循环直接处理（它们只需要生成一段文本，没有副作用）
    case "ask": return okResult((parsed.data as AskArgs).question);
    case "reply": return okResult((parsed.data as ReplyArgs).text);
    default: return failResult(`不认识工具 ${name}`, "UNKNOWN_TOOL");
  }
}
