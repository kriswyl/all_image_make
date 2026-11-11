import type { AgentStreamEvent, Conversation, ToolResult } from "../../shared/agent-types.js";
import type { CapabilityAlias } from "../capabilities.js";
import type { AppDatabase } from "../db.js";
import type { KeyStore } from "../key-store.js";
import { AppError, type TaskRunner } from "../tasks.js";

export const MEDIA_TASK_TIMEOUT_MS = 300_000;

export interface ToolContext {
  db: AppDatabase;
  runner: TaskRunner;
  operationId?: string;
  strictSubmission?: boolean;
  backgroundMedia?: boolean;
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
  /** 本轮到此为止，等任务完成事件再续跑（§12.2） */
  terminal: boolean;
  /** 新产出的图片，Agent 据此挪动画布指针（§10.1 规则 1） */
  producedAssetId?: string;
}

export function okResult(summary: string, extra: Partial<ToolResult> = {}): ToolOutcome {
  return { result: { ok: true, summary, ...extra }, terminal: Boolean(extra.async) };
}

export function failResult(summary: string, error: string): ToolOutcome {
  return { result: { ok: false, summary, error }, terminal: false };
}

/** 把异常翻译成大脑能读懂的一句话，而不是让它看到堆栈 */
export function describeError(error: unknown) {
  if (error instanceof AppError) return `${error.message}（${error.code}）`;
  return error instanceof Error ? error.message : "未知错误";
}
