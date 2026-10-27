/**
 * Agent 工具集（AGENT_PLAN.md §8）。
 *
 * 每个工具 = 一份 zod schema（校验大脑的输出）+ 一个 execute（干活）。
 * schema 单独放在这里而不是写进系统提示词，是因为提示词只做「解释」，
 * 真正的把关必须由代码完成——大脑把 `duration` 写成 `"5秒"` 时应该报错重试，
 * 而不是把脏参数透传给上游。
 *
 * **这套工具执行的还是 `TaskRunner`**，和生图 / 视频工作台是同一条路：
 * 产物照常进 tasks / assets 表，照常出现在生成历史页，照常支持诊断。
 * adapters.ts、security.ts、key-store.ts 一行都不用改。
 */
import { z } from "zod";
import { IMAGE_SIZE_VALUES, MAX_CANVAS_IMAGES, MAX_REFERENCE_IMAGES } from "../shared/types.js";
import type { GenerationInput, WanVideoMode, SeedanceVideoMode, KlingMediaType, VideoMediaType } from "../shared/types.js";
import type {
  AgentStreamEvent, AskArgs, Conversation, ConversationVideoRole, GenerateImageArgs,
  GenerateMusicArgs, GenerateSpeechArgs, GenerateVideoArgs, EditImageArgs, OptimizePromptArgs,
  ReplyArgs, SetCanvasArgs, ToolResult,
} from "../shared/agent-types.js";
import { assetRef } from "../shared/agent-types.js";
import {
  supportedVideoModes, VIDEO_CAPABILITIES, VIDEO_DEFAULTS, videoModeLabel,
  type ConversationVideoMode, type VideoAdapter,
} from "../shared/video-capabilities.js";
import type { AppDatabase, AssetRow, BoardRecord } from "./db.js";
import type { TaskRunner, ReferenceImageUpload } from "./tasks.js";
import { AppError } from "./tasks.js";
import type { CapabilityAlias } from "./capabilities.js";
import { describeAliasChoice, resolveAlias } from "./capabilities.js";
import { midjourneyUsableButtons } from "../shared/midjourney.js";
import { auditParameters, isParameterRejection, planParameterSalvage } from "./diagnose.js";
import { callBrain, type BrainMessage } from "./brain.js";
import { prepareImageBytes, VIDEO_FRAME_PROFILE, REFERENCE_PROFILE, videoInlineProfile } from "./vision.js";
import { TTS_DEFAULT_VOICE, TTS_VOICES } from "../shared/tts.js";
import {
  boardApplySchema, boardGenerateSchema, boardReadSchema,
  type BoardApplyArgs, type BoardGenerateArgs, type BoardReadArgs,
} from "../shared/board-ops.js";
import { applyBoardOps, describeBoard } from "./board-agent.js";
import { buildBoardDelta, generateBoardConfig } from "./board.js";
import { buildStoryboardTemplateInput, createCanvasTemplate, storyboardTemplateInput } from "./canvas-template.js";
import { canvasTemplateInputSchema, type CanvasTemplateInput } from "../shared/canvas-template.js";
import type { KeyStore } from "./key-store.js";

/** §16：`extraReferences` 上限和现有 MAX_REFERENCE_IMAGES 对齐 */
export const MAX_EXTRA_REFERENCES = 8;
/** 图片任务单次等待上限。图片是同步请求，正常几十秒；超过就该报错而不是一直挂着 */
export const IMAGE_TASK_TIMEOUT_MS = 300_000;
/** 等任务进入终态时再多给一点余量，让 TaskRunner 自己的超时先触发 */
export const IMAGE_WAIT_TIMEOUT_MS = IMAGE_TASK_TIMEOUT_MS + 60_000;

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
  characters: z.array(z.object({
    name: nonEmpty(40),
    prompt: z.string().trim().max(300).optional(),
  })).max(12).optional(),
  scenes: z.array(z.object({
    name: nonEmpty(80),
    prompt: z.string().trim().max(300).optional(),
  })).max(12).optional(),
  shots: z.array(z.object({
    prompt: nonEmpty(600),
    character: z.string().trim().max(120).optional(),
    scene: z.string().trim().max(80).optional(),
    dialogue: z.string().trim().max(1000).optional(),
    speaker: z.string().trim().max(120).optional(),
    shotSize: z.string().trim().max(20).optional(),
    cameraMove: z.string().trim().max(20).optional(),
  })).min(1).max(30),
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
  board_read: boardReadSchema,
  board_apply: boardApplySchema,
  board_generate: boardGenerateSchema,
  ask: askSchema,
  reply: replySchema,
} as const;

export interface ToolContext {
  db: AppDatabase;
  runner: TaskRunner;
  sessionKeys: KeyStore;
  conversation: Conversation;
  aliases: CapabilityAlias[];
  /**
   * 用户在设置里挑的默认生图 / 生视频模型（需求.md 问题 5），存的是 alias。
   * 大脑没点名（或点了个不存在的名字）时用它们，而不是碰运气取类目里第一个。
   */
  defaultAliases: { image?: string; video?: string; music?: string; speech?: string };
  /**
   * 「原话直发」时用户那句话的**原文**，没开就是 null。
   *
   * 为什么不让模型自己遵守提示词里那条规则：它有时听有时不听，用户看到的就是
   * 「这个开关有时候不生效」。这里由服务端**直接替换**掉 prompt 参数，模型怎么写都不影响结果。
   */
  verbatimPrompt: string | null;
  /**
   * 用户这一条消息附带的图片（已解析成 assetId，按顺序）。
   *
   * 工具默认优先用它们：用户说「把这张图的背景换掉」时，指的就是这几张，
   * 而不是画布第一张。跨轮续跑 / 确认后执行时是空数组——
   * 那种时候参数里必须已经落着具体的 `imageRefs`。
   */
  turnAttachmentIds: string[];
  emit: (event: AgentStreamEvent) => void;
  signal?: AbortSignal;
}

export interface ToolOutcome {
  result: ToolResult;
  /** 本轮到此为止，等任务完成事件再续跑（§12.2，目前只有视频会走这条） */
  terminal: boolean;
  /** 新产出的图片，Agent 据此挪动画布指针（§10.1 规则 1） */
  producedAssetId?: string;
}

function okResult(summary: string, extra: Partial<ToolResult> = {}): ToolOutcome {
  return { result: { ok: true, summary, ...extra }, terminal: Boolean(extra.async) };
}

function failResult(summary: string, error: string): ToolOutcome {
  return { result: { ok: false, summary, error }, terminal: false };
}

/** 把异常翻译成大脑能读懂的一句话，而不是让它看到堆栈 */
function describeError(error: unknown) {
  if (error instanceof AppError) return `${error.message}（${error.code}）`;
  return error instanceof Error ? error.message : "未知错误";
}

/** 会话里的产物引用解析：`#a3f1` / `a3f1` / 完整 id / `last` */
export function resolveAssetRef(
  db: AppDatabase,
  conversationId: string,
  ref: string,
): { asset: AssetRow; round: number } | null {
  const entries = db.listConversationAssets(conversationId);
  if (!entries.length) return null;
  const normalized = ref.trim().toLowerCase().replace(/^#/, "");
  if (!normalized || ["last", "current", "最新", "当前"].includes(normalized)) {
    // 分镜产物是追加在消息产物后面的，不能直接拿数组最后一项当「最新」；
    // 按产物自己的创建时间取，才不依赖两类记录的拼接顺序
    const last = entries.reduce((newest, entry) => entry.asset.createdAt >= newest.asset.createdAt ? entry : newest);
    return { asset: last.asset, round: last.round };
  }
  const exact = entries.find((entry) => entry.asset.id.toLowerCase() === normalized);
  if (exact) return { asset: exact.asset, round: exact.round };
  // 前缀匹配可能命中多个（4 位十六进制的碰撞概率很低，但真发生时取最后一个）
  const prefixed = entries.filter((entry) => entry.asset.id.toLowerCase().startsWith(normalized));
  const hit = prefixed[prefixed.length - 1];
  return hit ? { asset: hit.asset, round: hit.round } : null;
}

/**
 * 当前画布那一组图，有序（`[0]` 是主图）。
 *
 * 走 `db.canvasImages` 而不是自己 map：它顺手滤掉被删掉的产物和非图片，
 * 所有取画布的地方都用同一份过滤，才不会有人漏掉某一处。
 */
function canvasImages(db: AppDatabase, conversation: Conversation): AssetRow[] {
  return db.canvasImages(conversation);
}

/**
 * 解析一组**显式**图片引用，保持顺序、不做去重。
 *
 * 位置本身就是语义（first-last-frame 的第 1 张是首帧、第 2 张是尾帧），
 * 所以这里不能像 `resolveCanvasRefs` 那样去重、也不能静默跳过解析不出来的那张——
 * 少一张就会把「两张首尾帧」变成「一张首帧」，用户花了钱却拿到另一个东西。
 */
export function resolveImageRefs(
  db: AppDatabase,
  conversationId: string,
  refs: string[],
): { assets: AssetRow[]; error?: string } {
  const assets: AssetRow[] = [];
  const problems: string[] = [];
  for (const ref of refs) {
    const found = resolveAssetRef(db, conversationId, ref);
    if (!found) { problems.push(`找不到 ${ref}`); continue; }
    if (!found.asset.mimeType.startsWith("image/")) { problems.push(`${ref} 不是图片`); continue; }
    assets.push(found.asset);
  }
  return problems.length
    ? { assets, error: `${problems.join("；")}。请用画布或会话里的图片编号（#xxxx）重新指定` }
    : { assets };
}

/** 本条消息附带的图（已经是 assetId）。找不到/不是图片都算硬错误 */
function attachmentAssets(db: AppDatabase, ids: string[]): { assets: AssetRow[]; error?: string } {
  const assets: AssetRow[] = [];
  for (const id of ids) {
    const asset = db.getAsset(id);
    if (!asset) return { assets, error: `本条消息附带的图片 ${assetRef(id)} 已经不在了，请让用户重新发一次` };
    if (!asset.mimeType.startsWith("image/")) continue;
    assets.push(asset);
  }
  return { assets };
}

/**
 * 「这次到底用哪几张图」的统一兜底。
 *
 * 顺序是用户意图的优先级：
 * 1. 大脑显式写了 `imageRefs` —— 它已经按指令选好了；
 * 2. 本条消息附带的图 —— 用户说「这张/这几张」指的就是它们；
 * 3. 画布只有一张 —— 没有歧义，直接用；
 * 4. 画布多于一张 —— **不再默认主图/整组**，返回错误让大脑先 view_images 或 ask。
 */
function selectedImageAssets(
  db: AppDatabase,
  conversation: Conversation,
  explicitRefs: string[] | undefined,
  turnAttachmentIds: string[],
): { assets: AssetRow[]; source: "refs" | "attachments" | "canvas" | "none"; error?: string } {
  if (explicitRefs?.length) {
    const resolved = resolveImageRefs(db, conversation.id, explicitRefs);
    return resolved.error
      ? { assets: [], source: "refs", error: resolved.error }
      : { assets: resolved.assets, source: "refs" };
  }
  if (turnAttachmentIds.length) {
    const resolved = attachmentAssets(db, turnAttachmentIds);
    return resolved.error
      ? { assets: [], source: "attachments", error: resolved.error }
      : { assets: resolved.assets, source: "attachments" };
  }
  const canvas = canvasImages(db, conversation);
  if (canvas.length === 1) return { assets: canvas, source: "canvas" };
  if (canvas.length > 1) {
    return {
      assets: [],
      source: "none",
      error: `画布上有 ${canvas.length} 张图，不能默认挑一张。请先用 view_images 看清画面，再用 imageRefs 指定要用哪几张；拿不准就先 ask 用户`,
    };
  }
  return { assets: [], source: "none" };
}

export interface VideoSelection {
  mode: ConversationVideoMode;
  assets: AssetRow[];
  roles: ConversationVideoRole[];
  notes: string[];
}

const VIDEO_MODE_ORDER: ConversationVideoMode[] = ["text-to-video", "first-frame", "first-last-frame", "reference"];

function supportedModes(adapterType: string, model?: string): ConversationVideoMode[] {
  return supportedVideoModes(adapterType, model);
}

function modeListLabel(adapterType: string, model?: string) {
  return supportedModes(adapterType, model).map((mode) => `${mode}（${videoModeLabel(mode, adapterType)}）`).join("、");
}

/**
 * 把 `generate_video` 的参数解析成「哪种模式 + 哪几张图 + 谁是首帧/尾帧/参考图」。
 *
 * 这是执行器和确认卡共用的**唯一**判断入口：卡片上写的必须就是真正提交的那份，
 * 否则用户点了「用这两张做首尾帧」，实际跑的却是别的组合。
 */
export function resolveVideoSelection(
  db: AppDatabase,
  conversation: Conversation,
  args: GenerateVideoArgs,
  adapterType: string,
  turnAttachmentIds: string[],
  model?: string,
): { selection?: VideoSelection; error?: string } {
  const supported = supportedModes(adapterType, model);
  const requested = typeof args.mode === "string" ? args.mode.trim() : "";
  const requestedMode = requested ? requested as ConversationVideoMode : undefined;
  if (requestedMode && !VIDEO_MODE_ORDER.includes(requestedMode)) {
    return { error: `视频模式 ${requested} 对话里不支持。可用的是：${modeListLabel(adapterType, model)}` };
  }
  if (requestedMode && !supported.includes(requestedMode)) {
    return { error: `这个视频模型不支持 ${videoModeLabel(requestedMode, adapterType)}。它支持：${modeListLabel(adapterType, model)}` };
  }
  // 明确说「文生视频」时不需要图：画布上有几张都不该拦住一句纯文字的视频
  if (requestedMode === "text-to-video" || args.imageFrom === "none") {
    if (args.imageRefs?.length) {
      return { error: "文生视频不带图片，不能同时指定 imageRefs；要带图请用 first-frame / first-last-frame / reference" };
    }
    return { selection: { mode: "text-to-video", assets: [], roles: [], notes: [] } };
  }
  const explicitMode: Exclude<ConversationVideoMode, "text-to-video"> | undefined =
    requestedMode as Exclude<ConversationVideoMode, "text-to-video"> | undefined;

  let assets: AssetRow[] = [];
  if (args.imageRefs?.length) {
    const resolved = resolveImageRefs(db, conversation.id, args.imageRefs);
    if (resolved.error) return { error: resolved.error };
    assets = resolved.assets;
  } else if (turnAttachmentIds.length) {
    const resolved = attachmentAssets(db, turnAttachmentIds);
    if (resolved.error) return { error: resolved.error };
    assets = resolved.assets;
  } else {
    const canvas = canvasImages(db, conversation);
    if (canvas.length === 1) {
      // 只有一张时不存在选错的问题
      assets = canvas;
    } else if (canvas.length > 1 && args.imageFrom === "current") {
      return {
        error: `画布上有 ${canvas.length} 张图，不能默认挑一张。请先用 view_images 看清画面，再用 imageRefs 指定；拿不准就先 ask 用户`,
      };
    }
    // 没点名、也没明确要当前画布 → 当成纯文生视频，不要擅自把画布塞进去
  }

  let mode: ConversationVideoMode | undefined = explicitMode;
  if (!mode) {
    if (!assets.length) mode = "text-to-video";
    // Grok 只有图生/文生两种，多张图就是参考图，不存在「首尾帧 vs 参考」的歧义
    else if (adapterType === "grok-video") mode = "reference";
    else if (assets.length === 1) mode = "first-frame";
    else {
      return {
        error: `这次要用 ${assets.length} 张图，但没说要哪种方式。首尾帧生视频和参考生视频都说得通，`
          + "请先用 ask 问用户（给出「首尾帧」「参考图」两个选项），再在 mode 里写清 first-last-frame 或 reference。",
      };
    }
  }
  if (!mode) return { error: "没有确定视频模式，请先问用户" };

  if (mode === "text-to-video") {
    if (assets.length) {
      return { error: "文生视频不带图片；要带图请用 first-frame / first-last-frame / reference" };
    }
    return { selection: { mode, assets: [], roles: [], notes: [] } };
  }

  if (!assets.length) {
    return { error: `${videoModeLabel(mode, adapterType)}需要先用 imageRefs 指定图片（或用 view_images 看清画布后指定）` };
  }
  const cap = Math.min(MAX_REFERENCE_IMAGES, VIDEO_CAPABILITIES[adapterType as VideoAdapter]?.maxReferenceImages ?? MAX_REFERENCE_IMAGES);
  if (assets.length > cap) {
    return { error: `${videoModeLabel(mode, adapterType)}最多用 ${cap} 张图，这次给了 ${assets.length} 张` };
  }
  if (mode === "first-frame" && assets.length !== 1) {
    return { error: `首帧生视频只接受 1 张图（这次 ${assets.length} 张）。两张请用 first-last-frame，多张参考请用 reference` };
  }
  if (mode === "first-last-frame") {
    if (assets.length !== 2) return { error: `首尾帧生视频必须正好 2 张图（先首帧、后尾帧），这次 ${assets.length} 张` };
    if (assets[0]!.id === assets[1]!.id) return { error: "首帧和尾帧不能是同一张图，请让用户换一张或改用参考生视频" };
  }

  const notes: string[] = [];
  if (mode === "reference") {
    // 参考图重复没有意义，去重能省体积；首尾帧不能去重（位置有语义，上面已单独拦）
    const unique: AssetRow[] = [];
    for (const asset of assets) {
      if (unique.some((item) => item.id === asset.id)) { notes.push(`${assetRef(asset.id)} 重复，已去重`); continue; }
      unique.push(asset);
    }
    assets = unique;
  }
  const roles: ConversationVideoRole[] = mode === "first-frame"
    ? ["first_frame"]
    : mode === "first-last-frame"
      ? ["first_frame", "last_frame"]
      : assets.map(() => "reference_image");
  const unused = Math.max(0, canvasImages(db, conversation).length - new Set(assets.map((asset) => asset.id)).size);
  if (unused > 0) notes.push(`画布上另外 ${unused} 张没有发给视频模型`);
  return { selection: { mode, assets, roles, notes } };
}

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
export { VIDEO_DEFAULTS };

async function generateVideo(ctx: ToolContext, args: GenerateVideoArgs): Promise<ToolOutcome> {
  const resolution = resolveAlias(ctx.aliases, args.modelHint, "video", ctx.defaultAliases.video);
  if (!resolution) return failResult("还没有可用的视频渠道，请先到「渠道配置」添加", "NO_VIDEO_CHANNEL");
  const channel = ctx.db.getChannel(resolution.channelId);
  if (!channel) return failResult("解析到的视频渠道不存在", "CHANNEL_NOT_FOUND");

  const resolved = resolveVideoSelection(
    ctx.db, ctx.conversation, args, channel.adapterType, ctx.turnAttachmentIds, resolution.model,
  );
  if (!resolved.selection) return failResult(resolved.error ?? "这次视频用哪几张图没定下来", "VIDEO_SELECTION_INVALID");
  const selection = resolved.selection;
  const defaults = VIDEO_DEFAULTS[channel.adapterType] ?? { duration: 5, resolution: "720p", audio: false };
  const input: GenerationInput = {
    channelId: channel.id,
    model: resolution.model,
    prompt: ctx.verbatimPrompt ?? args.prompt,
    duration: args.duration ?? defaults.duration,
    resolution: args.resolution ?? defaults.resolution,
    audio: args.audio ?? defaults.audio,
    // §8 规则 4：视频默认开提示词扩展，渠道自带的扩展比大脑自己改写更划算
    promptExtend: args.promptExtend ?? true,
  };
  const uploads: ReferenceImageUpload[] = [];

  if (selection.assets.length) {
    // 多张图一起发时要按张数均分请求体预算，否则第二张就容易撞 1.4MB 的内联上限
    const profile = videoInlineProfile(selection.assets.length);
    const prepared: Array<{ bytes: Buffer; mimeType: "image/png" | "image/jpeg" | "image/webp"; fileName: string }> = [];
    for (const [index, asset] of selection.assets.entries()) {
      const encoded = await prepareImageBytes(ctx.db, asset, profile);
      if (!encoded) {
        return failResult(
          `${assetRef(asset.id)} 读取失败，无法作为${selection.roles[index] === "first_frame" ? "首帧" : selection.roles[index] === "last_frame" ? "尾帧" : "参考图"}`,
          "REFERENCE_IMAGE_MISSING",
        );
      }
      prepared.push(encoded);
    }

    if (channel.adapterType === "grok-video") {
      // Grok 的请求体只吃 reference_images，没有首帧/尾帧的角色概念
      for (const item of prepared) {
        uploads.push({ bytes: item.bytes, mimeType: item.mimeType, fileName: item.fileName });
      }
    } else {
      const media = prepared.map((item, index) => {
        const dataUri = `data:${item.mimeType};base64,${item.bytes.toString("base64")}`;
        return { role: selection.roles[index]!, url: dataUri };
      });
      if (channel.adapterType === "seedance-video") {
        input.seedanceVideoMedia = media.map((item) => ({ type: "image_url", url: item.url, role: item.role }));
        input.seedanceVideoMode = selection.mode as SeedanceVideoMode;
        // Seedance 的首帧/首尾帧只接受自适应比例（见 VIDEO_HANDOFF.md）
        if (selection.mode === "first-frame" || selection.mode === "first-last-frame") input.ratio = "adaptive";
      } else if (channel.adapterType === "kling-video") {
        input.klingVideoMedia = media.map((item) => ({ type: item.role as KlingMediaType, url: item.url }));
        input.klingVideoMode = selection.mode;
        input.aspectRatio = input.aspectRatio ?? "16:9";
      } else {
        input.wanVideoMedia = media.map((item) => ({ type: item.role as VideoMediaType, url: item.url }));
        input.wanVideoMode = selection.mode as WanVideoMode;
      }
    }
  } else if (channel.adapterType === "wan-video") {
    input.wanVideoMode = "text-to-video";
  } else if (channel.adapterType === "seedance-video") {
    input.seedanceVideoMode = "text-to-video";
  } else if (channel.adapterType === "kling-video") {
    input.klingVideoMode = "text-to-video";
    input.aspectRatio = input.aspectRatio ?? "16:9";
  }

  input.timeoutMs = IMAGE_TASK_TIMEOUT_MS;
  try {
    const created = await ctx.runner.create(input, uploads);
    ctx.emit({ type: "progress", taskId: created.id, status: created.status, progress: created.progress });
    const choice = describeAliasChoice(resolution);
    const imagePart = selection.assets.length
      ? `${videoModeLabel(selection.mode, channel.adapterType)}，${selection.assets
        .map((asset, index) => `${assetRef(asset.id)}（${roleLabel(selection.roles[index]!)}）`)
        .join("、")}`
      : "纯文生视频";
    const summary = [
      `已提交视频任务 ${created.id.slice(0, 8)}，模型 ${resolution.model}（${resolution.alias}）${choice ? `，${choice}` : ""}，`,
      `${input.duration} 秒 ${input.resolution}，`,
      imagePart,
      selection.notes.length ? `（${selection.notes.join("；")}）` : "",
      "。视频要几分钟，完成后我会接着处理。",
    ].join("");
    return okResult(summary, {
      async: true,
      taskId: created.id,
      data: {
        model: resolution.model, alias: resolution.alias,
        usedFallback: resolution.usedFallback, ...(choice ? { aliasNote: choice } : {}),
        videoMode: selection.mode,
        videoInputs: selection.assets.map((asset, index) => ({ assetId: asset.id, role: selection.roles[index] })),
      },
    });
  } catch (error) {
    return failResult(`提交视频失败：${describeError(error)}`, "VIDEO_SUBMIT_FAILED");
  }
}

async function generateMusic(ctx: ToolContext, args: GenerateMusicArgs): Promise<ToolOutcome> {
  let resolution = resolveAlias(ctx.aliases, args.modelHint, "audio", ctx.defaultAliases.music);
  if (!resolution) return failResult("还没有可用的音乐渠道，请先到「渠道配置」添加", "NO_MUSIC_CHANNEL");
  let channel = ctx.db.getChannel(resolution.channelId);
  // audio 类里现在同时有 Suno 和 TTS：默认音频模型若被设成配音，音乐工具退回第一个 Suno
  if (channel && channel.adapterType !== "suno-music") {
    const suno = ctx.aliases.find((item) => item.adapterType === "suno-music");
    if (suno) {
      resolution = { ...suno, usedFallback: true, source: "fallback" };
      channel = ctx.db.getChannel(suno.channelId);
    }
  }
  if (!channel) return failResult("解析到的音乐渠道不存在", "CHANNEL_NOT_FOUND");
  if (channel.adapterType !== "suno-music") {
    return failResult("audio 类里没有音乐渠道，不能写歌；配旁白请用 generate_speech", "MUSIC_CHANNEL_MISMATCH");
  }

  const mode = args.mode
    ?? (args.sourceAssetRefs?.length
      ? (args.sourceAssetRefs.length >= 2 ? "mashup" : "cover")
      : args.tags?.trim() || args.title?.trim() ? "custom" : "inspiration");
  const prompt = (ctx.verbatimPrompt ?? args.prompt ?? "").trim();
  const instrumental = mode === "sound" ? true : args.instrumental ?? false;

  if (mode !== "sound" && mode !== "mashup" && !prompt) {
    return failResult("这个音乐模式需要 prompt。请让用户描述风格、歌词或翻唱方向", "MUSIC_PROMPT_REQUIRED");
  }
  if (mode === "inspiration" && prompt.length > 500) {
    return failResult("灵感描述最多 500 字，请压缩后再提交", "MUSIC_PROMPT_TOO_LONG");
  }
  if (mode === "custom" && !args.tags?.trim()) {
    return failResult("自定义歌词模式需要曲风（tags）。请先用 ask 问用户想要什么曲风，或改成灵感模式", "MUSIC_TAGS_REQUIRED");
  }
  if (mode === "sound" && !args.tags?.trim()) {
    return failResult("音效模式需要标题或标签来描述音效内容", "MUSIC_SOUND_TAGS_REQUIRED");
  }

  // 翻唱 / 混音要引用本会话里带 Suno custom_id 的歌
  const sourceAssets: AssetRow[] = [];
  for (const ref of args.sourceAssetRefs ?? []) {
    const resolved = resolveAssetRef(ctx.db, ctx.conversation.id, ref);
    if (!resolved) return failResult(`找不到歌曲 ${ref}，请用本会话里出现过的产物编号`, "MUSIC_SOURCE_NOT_FOUND");
    if (!resolved.asset.mimeType.startsWith("audio/") || !resolved.asset.remoteClipId) {
      return failResult(`${ref} 不是带 Suno ID 的音乐产物，不能用它翻唱或混音`, "MUSIC_SOURCE_INVALID");
    }
    sourceAssets.push(resolved.asset);
  }
  if (mode === "cover" && sourceAssets.length !== 1) {
    return failResult("翻唱需要正好 1 首源歌曲（sourceAssetRefs 给 1 个）", "MUSIC_COVER_SOURCE_REQUIRED");
  }
  if (mode === "mashup") {
    if (sourceAssets.length !== 2) {
      return failResult("混音需要正好 2 首源歌曲（sourceAssetRefs 给 2 个）", "MUSIC_MASHUP_SOURCE_REQUIRED");
    }
    if (sourceAssets[0]!.remoteClipId === sourceAssets[1]!.remoteClipId) {
      return failResult("混音的两首歌不能是同一首", "MUSIC_MASHUP_SAME_SOURCE");
    }
  }

  const input: GenerationInput = {
    channelId: channel.id,
    model: resolution.model,
    prompt,
    musicMode: mode,
    musicInstrumental: instrumental,
    musicVersion: args.version,
    ...(["custom", "mashup", "sound"].includes(mode) ? {
      musicTitle: args.title?.trim() || undefined,
    } : {}),
    ...(["custom", "sound"].includes(mode) ? {
      musicTags: args.tags?.trim(),
      musicNegativeTags: args.negativeTags?.trim() || undefined,
    } : {}),
    ...(mode === "cover" ? { musicCoverClipId: sourceAssets[0]!.remoteClipId! } : {}),
    ...(mode === "mashup" ? { musicMashupClipIds: sourceAssets.map((asset) => asset.remoteClipId!) } : {}),
    ...(mode === "sound" ? {
      musicSoundConfigs: {
        tempo: args.tempo ?? 99,
        key: args.key?.trim() || "C",
        loop: args.loop ?? false,
      },
    } : {}),
    timeoutMs: 900_000,
  };

  try {
    const created = await ctx.runner.create(input);
    ctx.emit({ type: "progress", taskId: created.id, status: created.status, progress: created.progress });
    const choice = describeAliasChoice(resolution);
    const modeLabel: Record<string, string> = {
      inspiration: instrumental ? "纯音乐" : "灵感描述",
      custom: "自定义歌词",
      cover: "翻唱",
      mashup: "混音",
      sound: "音效",
      playlist: "歌单风格",
      sample: "取样",
    };
    const sourcePart = sourceAssets.length
      ? `，源歌曲 ${sourceAssets.map((asset) => assetRef(asset.id)).join(" + ")}`
      : "";
    const summary = [
      `已提交音乐任务 ${created.id.slice(0, 8)}，模型 ${resolution.model}（${resolution.alias}）${choice ? `，${choice}` : ""}，`,
      `${modeLabel[mode] ?? mode}${args.title?.trim() ? `《${args.title.trim()}》` : ""}${sourcePart}。`,
      "一次会生成 2 首，完成后我会接着处理。",
    ].join("");
    return okResult(summary, {
      async: true,
      taskId: created.id,
      data: {
        model: resolution.model, alias: resolution.alias,
        usedFallback: resolution.usedFallback, ...(choice ? { aliasNote: choice } : {}),
        musicMode: mode,
        ...(args.title?.trim() ? { musicTitle: args.title.trim() } : {}),
        ...(args.tags?.trim() ? { musicTags: args.tags.trim() } : {}),
        musicInstrumental: instrumental,
        ...(sourceAssets.length ? { musicSourceAssetIds: sourceAssets.map((asset) => asset.id) } : {}),
      },
    });
  } catch (error) {
    return failResult(`提交音乐失败：${describeError(error)}`, "MUSIC_SUBMIT_FAILED");
  }
}

/**
 * 配音走的是异步任务表里的同步路径：TTS 一次请求就回 WAV。
 * 它和音乐同属 audio 类，但适配器不同；这里只挑 gemini-tts 的别名，
 * 不会把 Suno 渠道误当成配音渠道。
 */
async function generateSpeech(ctx: ToolContext, args: GenerateSpeechArgs): Promise<ToolOutcome> {
  const ttsAliases = ctx.aliases.filter((item) => item.adapterType === "gemini-tts");
  if (!ttsAliases.length) {
    return failResult("还没有可用的语音渠道，请先到「模型设置」添加「词元流墟-语音」", "NO_SPEECH_CHANNEL");
  }
  const hint = args.modelHint?.trim();
  const requested = hint ? ctx.aliases.find((item) => item.alias === hint) : undefined;
  if (requested && requested.adapterType !== "gemini-tts") {
    return failResult(`${hint} 是音乐渠道，不能朗读文本；配音请用语音渠道的 alias`, "SPEECH_CHANNEL_MISMATCH");
  }
  const resolution = requested ?? ttsAliases.find((item) => item.alias === ctx.defaultAliases.speech) ?? ttsAliases[0]!;
  const channel = ctx.db.getChannel(resolution.channelId);
  if (!channel) return failResult("解析到的语音渠道不存在", "CHANNEL_NOT_FOUND");

  const normalizeVoice = (value: string | undefined, fallback: string) => {
    const input = value?.trim();
    if (!input) return fallback;
    const match = TTS_VOICES.find((voice) => voice.toLowerCase() === input.toLowerCase());
    return match ?? null;
  };
  const voice = normalizeVoice(args.voice, TTS_DEFAULT_VOICE);
  if (!voice) return failResult(`音色「${args.voice}」不存在。可用音色：${TTS_VOICES.join("、")}`, "TTS_VOICE_INVALID");
  const second = args.secondVoice?.trim() ? normalizeVoice(args.secondVoice, TTS_DEFAULT_VOICE) : null;
  if (args.secondVoice?.trim() && !second) {
    return failResult(`第二个音色「${args.secondVoice}」不存在。可用音色：${TTS_VOICES.join("、")}`, "TTS_VOICE_INVALID");
  }
  const text = args.text.trim();
  if (!text) return failResult("配音正文不能为空", "SPEECH_TEXT_REQUIRED");
  if (second && !(/A\s*[：:]/.test(text) && /B\s*[：:]/.test(text))) {
    return failResult("双人对话正文需要用「A：」「B：」标出两段台词", "SPEECH_SPEAKERS_REQUIRED");
  }

  const input: GenerationInput = {
    channelId: channel.id,
    model: resolution.model,
    prompt: text,
    ttsVoice: voice,
    ttsStyle: args.style?.trim() || undefined,
    ttsLanguage: args.language?.trim() || undefined,
    ...(second ? {
      ttsSpeakers: [
        { speaker: "A", voice },
        { speaker: "B", voice: second },
      ],
    } : {}),
    timeoutMs: 300_000,
  };

  try {
    const created = await ctx.runner.create(input);
    ctx.emit({ type: "progress", taskId: created.id, status: created.status, progress: created.progress });
    const task = await ctx.runner.waitFor(created.id, { timeoutMs: 360_000, signal: ctx.signal });
    const asset = task.assets.find((item) => item.mimeType.startsWith("audio/"));
    if (task.status !== "succeeded" || !asset) {
      return failResult(
        `配音失败：${task.errorMessage || task.errorCode || "没有生成音频"}`,
        task.errorCode ?? "SPEECH_FAILED",
      );
    }
    const duration = asset.duration ? `，${asset.duration.toFixed(1)} 秒` : "";
    return okResult(
      `配音完成${duration}，已保存 ${assetRef(asset.id)}。`,
      {
        taskId: task.id,
        assetId: asset.id,
        mimeType: asset.mimeType,
        data: {
          model: resolution.model,
          alias: resolution.alias,
          voice,
          ...(second ? { secondVoice: second } : {}),
          ...(args.style?.trim() ? { style: args.style.trim() } : {}),
          ...(args.language?.trim() ? { language: args.language.trim() } : {}),
        },
      },
    );
  } catch (error) {
    return failResult(`生成配音失败：${describeError(error)}`, "SPEECH_FAILED");
  }
}

/** 卡片和工具结果里统一的人话角色名 */
export function roleLabel(role: ConversationVideoRole) {
  if (role === "first_frame") return "首帧";
  if (role === "last_frame") return "尾帧";
  return "参考图";
}

async function generateImage(
  ctx: ToolContext,
  args: GenerateImageArgs & Partial<EditImageArgs>,
  isEdit: boolean,
): Promise<ToolOutcome> {
  const resolution = resolveAlias(ctx.aliases, args.modelHint, "image", ctx.defaultAliases.image);
  if (!resolution) return failResult("还没有可用的生图渠道，请先到「渠道配置」添加", "NO_IMAGE_CHANNEL");
  const channel = ctx.db.getChannel(resolution.channelId);
  if (!channel) return failResult("解析到的生图渠道不存在", "CHANNEL_NOT_FOUND");

  if (!isEdit && args.fromScratch === true && args.imageRefs?.length) {
    return failResult("fromScratch 表示完全不参考任何图，不能同时指定 imageRefs；二选一", "INVALID_ARGS");
  }

  const uploads: ReferenceImageUpload[] = [];
  const notes: string[] = [];

  /**
   * 用哪几张图：显式 `imageRefs` → 本条消息附带的图 → 画布只有一张。
   *
   * 画布多于一张又没指定时**不再默认整组/主图**：那正是「改一张却动了两张」
   * 和「用户附了图却改了主图」的来源。让它失败并提示先 view_images / ask，
   * 多花一轮大脑调用，但不会花错一次生成的钱。
   */
  const selected = selectedImageAssets(ctx.db, ctx.conversation, args.imageRefs, ctx.turnAttachmentIds);
  if (isEdit && selected.error) return failResult(selected.error, "IMAGE_SELECTION_INVALID");
  if (!isEdit && args.fromScratch !== true && selected.error) {
    return failResult(selected.error, "IMAGE_SELECTION_INVALID");
  }

  const references: AssetRow[] = [];
  if (isEdit) references.push(...selected.assets);
  else if (args.fromScratch !== true) references.push(...selected.assets);
  if (isEdit && !references.length) {
    return failResult("现在没有可改的图。请先用 generate_image 画一张，或让用户上传/指定一张图", "NO_CANVAS");
  }
  // 显式选中的图必须全部可用：少一张就是在改另一组图
  const requiredCount = references.length;

  const extraRefs = isEdit ? args.extraReferences ?? [] : [];
  for (const ref of extraRefs.slice(0, MAX_EXTRA_REFERENCES)) {
    const found = resolveAssetRef(ctx.db, ctx.conversation.id, ref);
    if (!found) { notes.push(`额外参考图 ${ref} 找不到，已跳过`); continue; }
    if (!found.asset.mimeType.startsWith("image/")) { notes.push(`${ref} 不是图片，已跳过`); continue; }
    // 去重要在限额**之前**判：大脑把已经选中的那张又写进 extraReferences 是常有的事
    if (references.some((item) => item.id === found.asset.id)) continue;
    if (references.length >= MAX_REFERENCE_IMAGES) {
      notes.push(`参考图已满 ${MAX_REFERENCE_IMAGES} 张，${ref} 已跳过`);
      continue;
    }
    references.push(found.asset);
  }

  if (channel.adapterType === "midjourney" && references.length > 1) {
    notes.push("Midjourney 图生图只使用第 1 张参考图");
  }
  for (const [index, reference] of references.entries()) {
    const prepared = await prepareImageBytes(ctx.db, reference, REFERENCE_PROFILE);
    if (!prepared) {
      // 选中/画布里的图坏了就硬失败；额外参考图坏了可以跳过，它本来只是补充
      if (index < requiredCount) {
        return failResult(`${assetRef(reference.id)} 读取失败，没法按你选的这组图生成；可以换一张或重新上传`, "REFERENCE_IMAGE_MISSING");
      }
      notes.push(`额外参考图 ${assetRef(reference.id)} 读取失败，已跳过`);
      continue;
    }
    uploads.push({ bytes: prepared.bytes, mimeType: prepared.mimeType, fileName: prepared.fileName });
  }

  /**
   * 参数核对的基准：**补默认值之前**请求方真正写的值。
   *
   * 必须在这里取快照——`TaskRunner.create()` 会往 `input.imageSize` 里补默认值，
   * 之后再回头看「用户当初要了什么」就分不清「他要的」和「我们补的」，
   * 而这两者恰恰是参数核对面板要区分开的东西。
   */
  const requested: Record<string, unknown> = {
    size: args.size,
    aspectRatio: args.aspectRatio,
    imageSize: args.imageSize,
  };

  const input: GenerationInput = {
    channelId: channel.id,
    model: resolution.model,
    // 原话直发时用用户的原话，不用大脑改写过的版本
    prompt: ctx.verbatimPrompt ?? args.prompt,
    size: args.size,
    aspectRatio: args.aspectRatio,
    imageSize: args.imageSize,
    count: args.count ?? 1,
    timeoutMs: IMAGE_TASK_TIMEOUT_MS,
  };

  /**
   * 最多两趟：正常一趟，外加至多一次参数补救（需求.md 问题 1 的「自动补救重试」）。
   *
   * 补救会**真的再发一次请求**，也就是可能再计一次费，所以三处一起收紧：
   * 只有上游明确因参数拒绝（`isParameterRejection`）、有安全的兜底值可补
   * （`planParameterSalvage`）、且只补一次。
   */
  let salvageNote = "";
  for (let attempt = 0; ; attempt += 1) {
    let taskId: string;
    try {
      const created = await ctx.runner.create(input, uploads);
      taskId = created.id;
      ctx.emit({ type: "progress", taskId, status: created.status, progress: created.progress });
    } catch (error) {
      return failResult(`提交失败：${describeError(error)}`, "SUBMIT_FAILED");
    }

    // 图片是同步请求，直接等完再回话：拿到真实产物后大脑才能说「画好了」，
    // 画布指针也才能在这一轮内挪到新图上（§10.1）
    let task;
    try {
      task = await ctx.runner.waitFor(taskId, { timeoutMs: IMAGE_WAIT_TIMEOUT_MS, signal: ctx.signal });
    } catch (error) {
      // 用户按了停止：请求早就发出去了，钱已经花了，上游会照常画完并落进生成历史。
      // 这时候说「生成失败」是错的——用户会重新生成一遍，白花第二笔。
      if (error instanceof AppError && error.code === "TASK_ABORTED") {
        return {
          result: {
            ok: false,
            error: "TASK_ABORTED",
            taskId,
            summary: "用户叫停了等待。这张图还在后台生成，画完会出现在「生成历史」里，不用重新生成",
          },
          terminal: false,
        };
      }
      return { result: { ok: false, summary: `等待生成结果失败：${describeError(error)}`, error: "TASK_WAIT_FAILED", taskId }, terminal: false };
    }
    ctx.emit({ type: "progress", taskId, status: task.status, progress: task.progress });

    // 参数核对用的是任务自己的 effectiveParameters——那是发送前就落库的脱敏请求体，
    // 所以「请求时写的」和「真正出网的」都拿得到，也不用新增任何采集
    const parameterNotes = auditParameters(channel.adapterType, requested, task.effectiveParameters);

    if (task.status === "succeeded" && task.assets.length) {
      const first = task.assets[0];
      const choice = describeAliasChoice(resolution);
      const summary = [
        `${isEdit ? "改图" : "生图"}完成，产物 ${assetRef(first.id)}（${task.model}${choice ? `，${choice}` : ""}）`,
        task.assets.length > 1 ? `，共 ${task.assets.length} 张` : "",
        "，已放进素材库（不会自动占用画布）。",
        salvageNote ? `${salvageNote}。` : "",
        notes.length ? `注意：${notes.join("；")}` : "",
      ].join("");
      // MJ 的四宫格结果带 U/V/R 按钮；塞进卡片 data，用户能在对话里直接继续操作
      const midjourneyButtons = midjourneyUsableButtons(task.remoteMeta?.midjourney?.buttons ?? []);
      return {
        result: {
          ok: true,
          summary,
          taskId,
          assetId: first.id,
          // 卡片靠它决定缩略图怎么渲染：图片走 <img>，视频走 <video>（需求.md 问题 3）
          mimeType: first.mimeType,
          data: {
            model: task.model,
            alias: resolution.alias,
            count: task.assets.length,
            usedFallback: resolution.usedFallback,
            ...(choice ? { aliasNote: choice } : {}),
            parameterNotes,
            ...(midjourneyButtons.length ? { midjourneyButtons, midjourneyTaskId: task.id } : {}),
          },
        },
        terminal: false,
        producedAssetId: first.id,
      };
    }

    const failure = task.errorMessage ?? task.errorCode ?? "上游没有返回结果";
    const salvage = attempt === 0 && isParameterRejection(task.errorCode, task.errorMessage)
      ? planParameterSalvage(channel.adapterType, task.effectiveParameters, ctx.db.getSetting("geminiImageSize"))
      : null;
    if (salvage) {
      salvageNote = salvage.note;
      Object.assign(input, salvage.patch);
      continue;
    }

    return {
      result: {
        ok: false,
        summary: `生成失败：${failure}${salvageNote ? `（${salvageNote}）` : ""}`,
        error: task.errorCode ?? "TASK_FAILED",
        taskId,
        data: { parameterNotes },
      },
      terminal: false,
    };
  }
}

/**
 * 把一串产物引用解析成画布 id 列表（纯函数：不碰网络、不写库，好单测）。
 *
 * 只做三件事：逐个解析、**去重保序**、把解析不出来的写进 `notes` 让人看得见。
 * 上限由 schema 挡在前面（超过 `MAX_CANVAS_IMAGES` 的调用根本进不来），
 * 这里再截一次是防着画布已经有几张、又被 append 的场景。
 */
export function resolveCanvasRefs(
  db: AppDatabase,
  conversationId: string,
  refs: string[],
  cap: number = MAX_CANVAS_IMAGES,
): { ids: string[]; notes: string[] } {
  const ids: string[] = [];
  const notes: string[] = [];
  for (const ref of refs) {
    if (ids.length >= cap) { notes.push(`画布最多 ${cap} 张，${ref} 已跳过`); continue; }
    const found = resolveAssetRef(db, conversationId, ref);
    if (!found) { notes.push(`找不到产物 ${ref}，已跳过`); continue; }
    if (!found.asset.mimeType.startsWith("image/")) { notes.push(`${ref} 是视频，不能作为画布，已跳过`); continue; }
    if (ids.includes(found.asset.id)) continue;
    ids.push(found.asset.id);
  }
  return { ids, notes };
}

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
    const input = buildStoryboardTemplateInput({
      name: args.title?.trim() || `${ctx.conversation.title} · 分镜`,
      description: `${args.shots.length} 个镜头，含角色 / 场景参考；导入无限画布后不会自动生成。`,
      characters: args.characters?.map((item) => ({ name: item.name, prompt: item.prompt })),
      scenes: args.scenes?.map((item) => ({ name: item.name, prompt: item.prompt })),
      shots: args.shots.map((shot, index) => ({
        index: index + 1,
        prompt: shot.prompt,
        character: shot.character,
        scene: shot.scene,
        kind: "image",
        dialogue: shot.dialogue,
        speaker: shot.speaker,
        shotSize: shot.shotSize,
        cameraMove: shot.cameraMove,
      })),
    });
    const template = createCanvasTemplate(ctx.db, input, {
      source: "storyboard",
      conversationId: ctx.conversation.id,
    });
    const groupCount = template.doc.groups?.length ?? 0;
    return okResult(
      `已生成分镜模板「${template.name}」：${args.shots.length} 镜、${template.doc.nodes.length} 个节点${groupCount ? `、${groupCount} 个分组` : ""}。点「导入无限画布」选择目标板；不会自动生成。`,
      {
        data: {
          templateId: template.id,
          templateName: template.name,
          templateDescription: template.description,
          templateNodeCount: template.doc.nodes.length,
          templateGroupCount: groupCount,
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
const BOARD_TOOL_NAMES = new Set(["board_read", "board_apply", "board_generate"]);

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
        ...(result.task ? { taskId: result.task.id } : {}),
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
  // 无限画布线程只开放 board_* 和纯文本工具，避免大脑把对话 / 分镜工具用错地方
  if (ctx.conversation.kind === "board"
    && !BOARD_TOOL_NAMES.has(name)
    && name !== "ask"
    && name !== "reply") {
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
    // ask / reply 由 Agent 循环直接处理（它们只需要生成一段文本，没有副作用）
    case "ask": return okResult((parsed.data as AskArgs).question);
    case "reply": return okResult((parsed.data as ReplyArgs).text);
    default: return failResult(`不认识工具 ${name}`, "UNKNOWN_TOOL");
  }
}
