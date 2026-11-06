import type { BrainContentPart, BrainToolSpec } from "../brain.js";
import type { AgentToolName, ConfirmPreview } from "../../shared/agent-types.js";
import type { TaskKind } from "../../shared/types.js";

export interface PreparedToolConfirmation {
  args: Record<string, unknown>;
  preview: ConfirmPreview;
  target: { kind: TaskKind; channelId: string; channelVersion: string; model: string };
}

/**
 * 能力组：决定这一轮先给模型看哪些工具。
 *
 * 组是**暴露策略**，不是权限；服务端仍会用完整 schema 校验。
 * 模型需要当前没有的组时调用 capability_search，下一轮再注入。
 */
export const CHAT_TOOL_GROUPS = ["core", "docs", "image", "video", "audio", "templates", "utility"] as const;
export type ChatToolGroup = (typeof CHAT_TOOL_GROUPS)[number];
export type ExecutionKind = "sync" | "task" | "workflow";
export type ExecutionState = "completed" | "failed" | "paused" | "cancelled" | "awaiting_confirmation" | "waiting_task" | "waiting_workflow" | "waiting_dependency" | "unknown_submit" | "cancel_requested";
export interface ToolExecutionContext {
  operationId: string;
  conversationId: string;
  signal: AbortSignal;
  report?: (text: string) => void;
}
export interface ToolExecutionEvent {
  tool: string; version: number; kind: ExecutionKind; operationId: string; conversationId: string;
}
export interface ToolExecutionHooks {
  /** Policy hooks run before any side effect. Rejection prevents execution. */
  before?(event: ToolExecutionEvent, raw: string): void | Promise<void>;
  /** Observers must never turn a completed side effect into an execution retry. */
  after?(event: ToolExecutionEvent, result: ChatToolResult): void | Promise<void>;
}

/** Domain-neutral outcome; uiData is explicitly selected for the user-facing card. */
export interface ChatToolResult {
  ok: boolean;
  paused?: boolean;
  summary: string;
  data?: Record<string, unknown>;
  uiData?: Record<string, unknown>;
  imageContext?: BrainContentPart[];
  execution?: { state: ExecutionState; operationId: string; version: number; reasonCode?: string };
}

/** A tool owns its public schema and execution policy; the runtime knows no domain-specific names. */
export interface ChatTool {
  spec: BrainToolSpec;
  displayName: AgentToolName;
  group?: ChatToolGroup;
  version?: number;
  kind?: ExecutionKind;
  resources?: "conversation" | "canvas";
  confirmation?: "none" | "policy";
  /** Reuse the capability's schema here when validation can be shared with the executor. */
  validate?(raw: string): void;
  /** 能力目录里的一句话；缺省用 spec.description 的前 80 字 */
  summary?: string;
  deduplicate?: boolean;
  hideResult?: boolean;
  prepareConfirmation?(raw: string): PreparedToolConfirmation | { error: string };
  run(raw: string, report?: (message: string) => void, operationId?: string): Promise<ChatToolResult>;
}

export class ChatToolRegistry {
  private readonly tools = new Map<string, ChatTool>();
  constructor(private readonly hooks: ToolExecutionHooks = {}) {}

  register(tool: ChatTool): void {
    const name = tool.spec.function.name;
    if (this.tools.has(name)) throw new Error(`重复注册工具：${name}`);
    if (!Number.isSafeInteger(tool.version ?? 1) || (tool.version ?? 1) < 1) throw new Error("能力版本必须是正整数");
    this.tools.set(name, tool);
  }

  all(): ChatTool[] { return [...this.tools.values()]; }
  /** 不传 groups 就是全量；传了按组过滤，core 永远保留 */
  specs(groups?: ReadonlySet<ChatToolGroup>): BrainToolSpec[] {
    return this.all()
      .filter((tool) => !groups || (tool.group ?? "core") === "core" || groups.has(tool.group ?? "core"))
      .map((tool) => tool.spec);
  }
  get(name: string): ChatTool | undefined { return this.tools.get(name); }

  manifest() {
    return this.all().map(tool => ({ name: tool.spec.function.name, version: tool.version ?? 1,
      kind: tool.kind ?? (tool.prepareConfirmation ? "task" : "sync"),
      group: tool.group ?? "core", resources: tool.resources ?? "conversation",
      confirmation: tool.confirmation ?? (tool.prepareConfirmation ? "policy" : "none") }));
  }

  async execute(name: string, raw: string, context: ToolExecutionContext): Promise<ChatToolResult> {
    const tool = this.get(name);
    if (!tool) return { ok: false, summary: `未知工具：${name}` };
    const event: ToolExecutionEvent = { tool: name, version: tool.version ?? 1,
      kind: tool.kind ?? (tool.prepareConfirmation ? "task" : "sync"), operationId: context.operationId, conversationId: context.conversationId };
    context.signal.throwIfAborted();
    let result: ChatToolResult;
    let tracked = false;
    try {
      tool.validate?.(raw);
      await this.hooks.before?.(event, raw);
      tracked = true;
      context.signal.throwIfAborted();
      // Confirmation tools are dispatched through the durable confirmation/TaskRunner path.
      if (tool.prepareConfirmation) result = { ok: false, summary: "需要先准备确认请求", execution: { state: "awaiting_confirmation", operationId: context.operationId, version: event.version } };
      else result = await tool.run(raw, context.report, context.operationId);
    } catch (error) {
      if (context.signal.aborted) throw error;
      result = { ok: false, summary: error instanceof Error ? error.message : "工具执行失败" };
    }
    result = { ...result, execution: result.execution ?? { state: result.paused ? "paused" : result.ok ? "completed" : "failed", operationId: context.operationId, version: event.version } };
    if(tracked) try { await this.hooks.after?.(event, result); } catch { /* An audit failure cannot replay a paid or completed operation. */ }
    return result;
  }
}
