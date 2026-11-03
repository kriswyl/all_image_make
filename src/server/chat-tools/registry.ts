import type { BrainToolSpec } from "../brain.js";
import type { AgentToolName } from "../../shared/agent-types.js";

/** Domain-neutral outcome; uiData is explicitly selected for the user-facing card. */
export interface ChatToolResult {
  ok: boolean;
  summary: string;
  data?: Record<string, unknown>;
  uiData?: Record<string, unknown>;
}

/** A tool owns its public schema and execution policy; the runtime knows no domain-specific names. */
export interface ChatTool {
  spec: BrainToolSpec;
  displayName: AgentToolName;
  deduplicate?: boolean;
  hideResult?: boolean;
  run(raw: string, report?: (message: string) => void, operationId?: string): Promise<ChatToolResult>;
}

export class ChatToolRegistry {
  private readonly tools = new Map<string, ChatTool>();

  register(tool: ChatTool): void {
    const name = tool.spec.function.name;
    if (this.tools.has(name)) throw new Error(`重复注册工具：${name}`);
    this.tools.set(name, tool);
  }

  specs(): BrainToolSpec[] { return [...this.tools.values()].map((tool) => tool.spec); }
  get(name: string): ChatTool | undefined { return this.tools.get(name); }
}
