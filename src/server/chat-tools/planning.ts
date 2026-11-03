import { z } from "zod";
import type { ChatTool } from "./registry.js";

const planSchema = z.object({
  steps: z.array(z.object({
    task: z.string().trim().min(1).max(300),
    status: z.enum(["pending", "in_progress", "completed"]),
  })).min(1).max(30),
}).refine((plan) => plan.steps.filter((step) => step.status === "in_progress").length <= 1, "同时只能有一个进行中的步骤");

/** State is written as a normal tool result, so it survives reloads and remains visible to the user. */
export function createPlanTool(): ChatTool {
  return {
    displayName: "plan_update",
    spec: { type: "function", function: {
      name: "plan_update",
      description: "为复杂的多步骤任务创建或更新完整计划；每次传入所有步骤和当前状态。简单问题不必调用。完成前核对计划，未完成的步骤不能标记为完成。",
      parameters: { type: "object", properties: { steps: { type: "array", minItems: 1, maxItems: 30, items: { type: "object", properties: { task: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["task", "status"], additionalProperties: false } } }, required: ["steps"], additionalProperties: false },
    } },
    async run(raw) {
      try {
        const plan = planSchema.parse(JSON.parse(raw));
        const labels = { pending: "待处理", in_progress: "进行中", completed: "已完成" };
        return { ok: true, summary: plan.steps.map((step, index) => `${index + 1}. [${labels[step.status]}] ${step.task}`).join("\n") };
      } catch (error) {
        return { ok: false, summary: `计划参数无效：${error instanceof Error ? error.message : "请检查 JSON"}` };
      }
    },
  };
}
