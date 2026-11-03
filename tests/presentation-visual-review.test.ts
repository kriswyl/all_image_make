import { expect, it } from "vitest";
import { reviewRenderedPresentation } from "../src/server/presentation-visual-review";
import type { AiPresentation } from "../src/server/mind-document";

const plan: AiPresentation = { title: "标题", theme: "ink", slides: [{ layout: "content", title: "内容", subtitle: "", lines: ["原始事实", "支撑条件"], notes: "来源原文", sourceIds: ["s1.1"] }] };
it("检查实际截图并修正版式后重新渲染，保留原文及来源", async () => {
  let rendered = 0, calls = 0;
  const result = await reviewRenderedPresentation(plan, [], async () => { rendered++; return [Buffer.from("png")]; }, async (messages) => {
    expect(JSON.stringify(messages)).toContain("data:image/png;base64,");
    return { content: JSON.stringify(++calls === 1 ? { issues: ["层级不明显"], layout: "keypoint" } : { issues: [] }), truncated: false };
  });
  expect(rendered).toBe(2); expect(result.plan.slides[0]!.layout).toBe("keypoint");
  expect(result.plan.slides[0]!.lines).toEqual(plan.slides[0]!.lines);
  expect(result.plan.slides[0]!.sourceIds).toEqual(["s1.1"]);
  expect(result.summary).toContain("全部 1 页");
});
it("渲染失败不会声称检查通过", async () => {
  const result = await reviewRenderedPresentation(plan, [], async () => { throw new Error("未启用 WPS"); }, async () => { throw new Error("不应调用"); });
  expect(result.summary).toContain("未完成视觉检查"); expect(result.summary).toContain("未启用 WPS");
});
