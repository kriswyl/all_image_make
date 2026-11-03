import { expect, it } from "vitest";
import { ChatToolRegistry } from "../src/server/chat-tools/registry";
import { createPlanTool } from "../src/server/chat-tools/planning";

it("注册表提供工具描述，拒绝重复注册", () => {
  const registry = new ChatToolRegistry();
  registry.register(createPlanTool());
  expect(registry.specs().map((spec) => spec.function.name)).toEqual(["plan_update"]);
  expect(registry.get("missing")).toBeUndefined();
  expect(() => registry.register(createPlanTool())).toThrow(/重复注册/);
});

it("计划校验状态并返回可恢复的完整计划", async () => {
  const tool = createPlanTool();
  const result = await tool.run(JSON.stringify({ steps: [
    { task: "读取资料", status: "completed" },
    { task: "整理内容", status: "in_progress" },
    { task: "检查产物", status: "pending" },
  ] }));
  expect(result.ok).toBe(true);
  expect(result.summary).toContain("[已完成] 读取资料");
  expect(result.summary).toContain("[待处理] 检查产物");
  const invalid = await tool.run(JSON.stringify({ steps: [{ task: "一", status: "in_progress" }, { task: "二", status: "in_progress" }] }));
  expect(invalid.ok).toBe(false);
});
