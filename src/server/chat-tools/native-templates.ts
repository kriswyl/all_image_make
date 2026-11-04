import { z } from "zod";
import { BOARD_LIMITS } from "../../shared/board.js";
import { canvasTemplateInputSchema, templateNodeSchema } from "../../shared/canvas-template.js";
import { createStoryboardTemplateSchema, runAgentTool, type ToolContext } from "../agent-tools.js";
import type { BrainToolSpec } from "../brain.js";
import type { ChatTool } from "./registry.js";

const schemas = {
  create_canvas_template: canvasTemplateInputSchema.extend({
    nodes: z.array(templateNodeSchema.omit({ storyboard: true }).strict()).min(1).max(BOARD_LIMITS.maxNodes),
  }).strict(),
  create_storyboard_template: createStoryboardTemplateSchema.strict(),
};

const nativeTemplateSpecs = {
  create_canvas_template: {
    type: "function",
    function: {
      name: "create_canvas_template",
      description: "用户明确要求保存可导入无限画布的工作流或布局模板时调用。用临时节点 ID 连接节点和分组。只保存模板，由用户选择目标画布后导入。",
      parameters: z.toJSONSchema(schemas.create_canvas_template, { io: "input" }),
    },
  },
  create_storyboard_template: {
    type: "function",
    function: {
      name: "create_storyboard_template",
      description: "按确认过的创作方向生成可审阅的无限画布分镜模板。先询问尚未明确的用途、时长或镜数、画幅、风格、节奏和参考素材。已给出的信息直接写入 brief。生成模板后请用户审阅、选择镜头并导入画布。",
      parameters: z.toJSONSchema(schemas.create_storyboard_template, { io: "input" }),
    },
  },
} satisfies Record<string, BrainToolSpec>;

export function createNativeTemplateTool(name: keyof typeof schemas, context: () => ToolContext): ChatTool {
  return {
    spec: nativeTemplateSpecs[name], displayName: name, group: "templates", deduplicate: true,
    run: async raw => {
      let args: unknown;
      try { args = JSON.parse(raw); } catch { return { ok: false, summary: "模板参数不是有效 JSON" }; }
      const parsed = schemas[name].safeParse(args);
      if (!parsed.success) {
        const issue = parsed.error.issues[0]!;
        return { ok: false, summary: `模板参数无效（${issue.path.join(".") || "模板"}）：${issue.message}` };
      }
      const { result } = await runAgentTool(name, parsed.data, context());
      return { ok: result.ok, summary: result.summary, data: result.data, uiData: result.data };
    },
  };
}
