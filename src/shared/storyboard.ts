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

export interface StoryboardView {
  shots: StoryboardShot[];
  /** 当前渠道里有没有可用的生图 / 生视频模型，前端据此禁用按钮 */
  canGenerateImage: boolean;
  canGenerateVideo: boolean;
  maxBatch: number;
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
