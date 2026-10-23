/**
 * 会话内分镜表（脚本 → 镜头）。
 *
 * 这一份是服务端落库、前端渲染、大脑回放共用的形状。分镜**不是**生成任务：
 * 一个镜头只有在用户点「生成」之后才有 `taskId`，此前都只是计划。
 * 状态因此是「计划」加上任务本身的终态/中间态，不另造一套状态机。
 */
import type { Asset, TaskStatus } from "./types.js";

export const STORYBOARD_SHOT_KINDS = ["image", "video"] as const;
export type StoryboardShotKind = (typeof STORYBOARD_SHOT_KINDS)[number];

/** 一个会话最多拆多少镜。再多就不像「一篇脚本」，更像误把整本小说传进来了 */
export const MAX_STORYBOARD_SHOTS = 60;
/** 一次「生成选中」最多提交几个。和对话批量生图的上限保持一致，别让中转站当攻击 */
export const MAX_STORYBOARD_BATCH = 8;
/** 单个脚本文档最多收多少字。超过就明确拒绝，而不是悄悄截断后拆出一份缺头少尾的分镜 */
export const MAX_SCRIPT_CHARS = 60_000;
/** 一次上传的脚本文档总字数上限（通常只有一篇，留点余量给「正文 + 设定」两份） */
export const MAX_SCRIPT_TOTAL_CHARS = 90_000;
/** 本地文件大小上限，先挡住明显不是文本的东西 */
export const MAX_SCRIPT_FILE_BYTES = 2 * 1024 * 1024;

/** 分镜里允许的画幅。空串 = 不指定，交给渠道/模型默认 */
export const STORYBOARD_ASPECT_RATIOS = ["", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;

export type StoryboardShotStatus = "planned" | TaskStatus;

export interface StoryboardShot {
  id: string;
  conversationId: string;
  /** 镜号，从 1 开始。用户在对话里说「第 7 镜」指的就是它 */
  index: number;
  /** 剧本里的原文（模型拆镜时保留，用来核对有没有漏段） */
  sourceText: string;
  /** 真正发给渠道的画面描述 */
  prompt: string;
  /** 这一镜的出场角色名；空串 = 空镜 / 道具 / 字幕，不带角色参考 */
  character: string;
  kind: StoryboardShotKind;
  aspectRatio: string;
  taskId: string | null;
  status: StoryboardShotStatus;
  assetId: string | null;
  /** 结果产物；失败或还没生成时为 null */
  asset: Asset | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export type StoryboardReferenceMode = "auto" | "manual" | "off";

/** 角色参考的三种来源；auto 指「第一个已完成的图片镜头」 */
export interface StoryboardReference {
  mode: StoryboardReferenceMode;
  asset: Asset | null;
  /** 这个参考来自第几镜；手动指定或未设置时为 null */
  shotIndex: number | null;
}

/** 一个角色在分镜里的出场统计和参考图 */
export interface StoryboardCharacter {
  id: string;
  name: string;
  /** 用户手动绑定的参考图；null = 自动用该角色第一个已完成的镜头 */
  assetId: string | null;
  /** 解析后的参考图（手动优先，其次该角色第一个已完成镜头） */
  asset: Asset | null;
  mode: "manual" | "auto" | "none";
  shotCount: number;
}

export interface StoryboardView {
  shots: StoryboardShot[];
  /** 当前渠道里有没有可用的生图 / 生视频模型，前端据此禁用按钮 */
  canGenerateImage: boolean;
  canGenerateVideo: boolean;
  maxBatch: number;
  /** 老分镜（没有角色标签）才用的全局参考 */
  reference: StoryboardReference;
  /** 按角色拆分的参考图；有角色标签时生成逻辑优先用这一份 */
  characters: StoryboardCharacter[];
}

/**
 * 带参考图时加在画面描述前面的约束。
 *
 * 参考图本身只能告诉模型「长什么样」，不会告诉它「哪些地方必须保持不变」——
 * 不写这句，模型经常只借一点配色，脸和服装还是各画各的。
 */
export const STORYBOARD_CHARACTER_PREFIX =
  "以参考图中的同一位人物为准，严格保持脸型、五官、发型、肤色、体型、服装和整体画风完全一致，只改变场景、姿态与构图：\n";

/**
 * 这一镜大概会出现人物吗？
 *
 * 角色参考只该用在有人物的镜头上：把一张人脸塞进「空无一人的走廊」或
 * 「片尾黑底字幕」，模型会硬生生多画一个人出来。关键词只是粗筛——
 * 它决定「要不要带参考图」，不决定用户能不能手动指定。
 */
export const STORYBOARD_PERSON_HINT =
  /人物|男人|女人|男孩|女孩|少年|少女|男子|女子|男性|女性|老人|孩子|主角|角色|助手|(?<!其)他|她|脸|面部|五官|近景|特写|半身|全身|肖像|背影|侧影|剪影/;

export function shotNeedsCharacterReference(shot: Pick<StoryboardShot, "prompt" | "sourceText">): boolean {
  return STORYBOARD_PERSON_HINT.test(`${shot.prompt}\n${shot.sourceText}`);
}

export function storyboardKindLabel(kind: StoryboardShotKind): string {
  return kind === "video" ? "视频" : "图片";
}

/** 缺什么就不能生成；返回 null 表示这一镜可以提交 */
export function storyboardShotMissing(shot: Pick<StoryboardShot, "prompt">): string | null {
  const prompt = shot.prompt.trim();
  if (!prompt) return "缺画面描述";
  if (prompt.length < 6) return "画面描述太短";
  return null;
}

export function normalizeStoryboardAspect(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return (STORYBOARD_ASPECT_RATIOS as readonly string[]).includes(trimmed) ? trimmed : "";
}

export function isStoryboardShotKind(value: unknown): value is StoryboardShotKind {
  return value === "image" || value === "video";
}

/** 任务还没结束：前端据此决定要不要继续轮询 */
export function isStoryboardShotActive(status: StoryboardShotStatus): boolean {
  return status === "queued" || status === "validating" || status === "submitting" || status === "running";
}
