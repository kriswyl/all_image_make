import { expect, it, vi } from "vitest";
import { ChatToolRegistry } from "../src/server/chat-tools/registry";
import { createPlanTool } from "../src/server/chat-tools/planning";

it("注册表提供工具描述，拒绝重复注册", () => {
  const registry = new ChatToolRegistry();
  registry.register(createPlanTool());
  expect(registry.specs().map((spec) => spec.function.name)).toEqual(["plan_update"]);
  expect(registry.get("missing")).toBeUndefined();
  expect(() => registry.register(createPlanTool())).toThrow(/重复注册/);
});

it("公共执行器在副作用前落实策略，审计错误不重放已完成操作", async () => {
  const run=vi.fn(async()=>({ ok:true,summary:"完成" }));
  const before=vi.fn<()=>void>(()=>{ throw new Error("资源版本冲突"); });
  const registry=new ChatToolRegistry({ before,after:()=>{ throw new Error("审计不可用"); } });
  registry.register({ ...createPlanTool(),version:2,kind:"workflow",run });
  const context={ conversationId:"c",operationId:"op",signal:new AbortController().signal };
  expect(await registry.execute("plan_update","{}",context)).toMatchObject({ ok:false,execution:{ state:"failed",version:2 } });
  expect(run).not.toHaveBeenCalled();
  before.mockImplementation(()=>undefined);
  expect(await registry.execute("plan_update","{}",context)).toMatchObject({ ok:true,execution:{ state:"completed",operationId:"op" } });
  expect(run).toHaveBeenCalledTimes(1);
  const stop=new AbortController();stop.abort();
  await expect(registry.execute("plan_update","{}",{ ...context,signal:stop.signal })).rejects.toThrow();
  expect(run).toHaveBeenCalledTimes(1);
  expect(registry.manifest()[0]).toMatchObject({ version:2,kind:"workflow" });
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
