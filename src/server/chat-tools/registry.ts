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

/** Domain-neutral outcome; uiData is explicitly selected for the user-facing card. */
export interface ChatToolResult {
  ok: boolean;
  paused?: boolean;
  summary: string;
  data?: Record<string, unknown>;
  uiData?: Record<string, unknown>;
  imageContext?: BrainContentPart[];
}

/** A tool owns its public schema and execution policy; the runtime knows no domain-specific names. */
export interface ChatTool {
  spec: BrainToolSpec;
  displayName: AgentToolName;
  group?: ChatToolGroup;
  /** 能力目录里的一句话；缺省用 spec.description 的前 80 字 */
  summary?: string;
  deduplicate?: boolean;
  hideResult?: boolean;
  prepareConfirmation?(raw: string): PreparedToolConfirmation | { error: string };
  run(raw: string, report?: (message: string) => void, operationId?: string): Promise<ChatToolResult>;
}

export class ChatToolRegistry {
  private readonly tools = new Map<string, ChatTool>();

  register(tool: ChatTool): void {
    const name = tool.spec.function.name;
    if (this.tools.has(name)) throw new Error(`重复注册工具：${name}`);
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
}
