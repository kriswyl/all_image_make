import { z } from "zod";
import { optimizePromptSchema, runAgentTool, setCanvasSchema, type ToolContext } from "../agent-tools.js";
import type { BrainToolSpec } from "../brain.js";
import type { ChatTool } from "./registry.js";

/**
 * 不生成媒体的两个创作工具。
 *
 * 统一入口下如果完全不提供它们，用户说「把这张设为画布」「帮我润色这段提示词」
 * 就只能得到一句「我看不到画布」——能力其实一直在，只是没挂到原生注册表上。
 */
const nativeUtilitySpecs = {
  set_canvas: {
    type: "function",
    function: {
      name: "set_canvas",
      description: "只在用户明确要求「把这张设为画布 / 设为参考」时调用。assetRefs 是本会话图片 ID；会整组替换当前画布。不生成任何图片。",
      parameters: z.toJSONSchema(setCanvasSchema),
    },
  },
  optimize_prompt: {
    type: "function",
    function: {
      name: "optimize_prompt",
      description: "只改写提示词，不生成图片或视频。用户明确要求润色、扩写、整理画面描述时调用；把原文放在 prompt，target 填 image 或 video。",
      parameters: z.toJSONSchema(optimizePromptSchema),
    },
  },
} satisfies Record<string, BrainToolSpec>;

const schemas = {
  set_canvas: setCanvasSchema,
  optimize_prompt: optimizePromptSchema,
};

export function createNativeUtilityTool(name: keyof typeof schemas, context: () => ToolContext): ChatTool {
  return {
    spec: nativeUtilitySpecs[name],
    displayName: name,
    group: "utility",
    run: async (raw) => {
      let value: unknown;
      try { value = JSON.parse(raw); } catch { return { ok: false, summary: "参数不是有效 JSON" }; }
      const parsed = schemas[name].safeParse(value);
      if (!parsed.success) {
        const issue = parsed.error.issues[0]!;
        return { ok: false, summary: `参数无效（${issue.path.join(".") || "args"}）：${issue.message}` };
      }
      const { result } = await runAgentTool(name, parsed.data as Record<string, unknown>, context());
      return {
        ok: result.ok,
        summary: result.summary,
        ...(result.data ? { data: result.data } : {}),
        ...(result.data ? { uiData: result.data } : {}),
      };
    },
  };
}
