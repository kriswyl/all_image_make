import { expect, it } from "vitest";
import JSZip from "jszip";
import { planPresentationWithAi } from "../src/server/ai-presentation";
import { renderAiPresentation, type MindDocument } from "../src/server/mind-document";
import { checkPresentation, paginatePresentation } from "../src/server/presentation-check";

const source: MindDocument = { format: "xmind", warnings: [], sheets: [{ title: "店铺运营", notes: "", children: [{ title: "物流", notes: "FBM 与 FBA 的区别", children: [{ title: "FBA", notes: "按平台仓储计费", children: [] }] }, { title: "营销", notes: "", children: [] }] }] };
function parts(messages: any[]) { return JSON.parse(messages[1].content.split("素材（JSON 数据）：\n")[1]); }
function response(items: any[], ids = items.map((item: any) => item.id)) {
  return { content: JSON.stringify({ title: "店铺运营入门", theme: "blue", slides: [{ layout: "content", title: items[0].text.slice(0, 50), subtitle: "", lines: ["内容整理"], notes: items.map((item: any) => item.text).join("\n").slice(0, 4000), sourceIds: ids }] }), truncated: false };
}

it("先规划全局结构并按策划顺序组织章节，同时保留全部来源", async () => {
  const doc: MindDocument = { format: "xmind", warnings: [], sheets: [{ title: "主题", notes: "", children: Array.from({ length: 25 }, (_, i) => ({ title: `节点${i}`, notes: "", children: [] })) }] };
  const prompts: string[] = [];
  const plan = await planPresentationWithAi(doc, "培训新人", async (messages) => {
    if (String(messages[0]!.content).includes("演示文稿总策划")) return { content: JSON.stringify({ title: "新人培训", audience: "新人", objective: "掌握流程", narrative: "先总体后细节", sections: [{ title: "后续", goal: "了解后续", batchIds: [2] }, { title: "基础", goal: "掌握基础", batchIds: [1] }] }), truncated: false };
    prompts.push(String(messages[1]!.content));
    return response(parts(messages));
  }, undefined, undefined, undefined, { globalPlan: true });
  expect(prompts[0]).toContain("原始批次编号：2");
  expect(prompts[1]).toContain("原始批次编号：1");
  expect(prompts[0]).toContain("先总体后细节");
  expect(plan.title).toBe("新人培训");
  expect(plan.slides.map((slide) => slide.notes).join("\n")).toContain("节点0");
});

it("全局策划遗漏或重复批次时会修正，仍无效则停止", async () => {
  let calls = 0;
  await expect(planPresentationWithAi(source, "转换", async () => {
    calls++;
    return { content: JSON.stringify({ title: "培训", audience: "新人", objective: "掌握", narrative: "主线", sections: [{ title: "章节", goal: "讲解", batchIds: [1, 1] }] }), truncated: false };
  }, undefined, undefined, undefined, { globalPlan: true })).rejects.toThrow(/遗漏、重复或越界/);
  expect(calls).toBe(2);
});

it("生成对比与重点页面并保持对比两组结构", async () => {
  const plan = paginatePresentation({ title: "比较", theme: "ink", slides: [
    { layout: "comparison", title: "方案对比", subtitle: "", lines: ["方案甲", "内容甲".repeat(12), "方案乙", "内容乙"], notes: "" },
    { layout: "keypoint", title: "主要结论", subtitle: "", lines: ["优先关注成本", "条件一"], notes: "" },
  ] });
  expect(plan.slides[0]!.lines).toHaveLength(4);
  const bytes = await renderAiPresentation(plan);
  await checkPresentation(bytes, plan);
  const ppt = await JSZip.loadAsync(bytes);
  const comparison = await ppt.file("ppt/slides/slide1.xml")!.async("string");
  expect(comparison).toContain("方案甲"); expect(comparison).toContain("方案乙");
  expect((comparison.match(/roundRect/g) ?? []).length).toBe(2);
});

it("分章节阅读所有节点，生成可编辑 PPT 和讲解备注", async () => {
  const prompts: string[] = [];
  const plan = await planPresentationWithAi(source, "面向新手，重点讲物流", async (messages) => { prompts.push(JSON.stringify(messages)); return response(parts(messages)); });
  expect(prompts).toHaveLength(1);
  expect(prompts.join("\n")).toContain("面向新手，重点讲物流");
  expect(prompts.join("\n")).toContain("按平台仓储计费");
  expect(plan.slides).toHaveLength(2);
  const ppt = await JSZip.loadAsync(await renderAiPresentation(plan));
  expect(await ppt.file("ppt/slides/slide2.xml")!.async("string")).toContain("内容整理");
  expect(await ppt.file("ppt/notesSlides/notesSlide2.xml")!.async("string")).toContain("按平台仓储计费");
});

it("即使模型把备注概括掉，仍把每个来源原文保存在页面备注中", async () => {
  const plan = await planPresentationWithAi(source, "转换", async (messages) => {
    const items = parts(messages);
    const result = response(items);
    const value = JSON.parse(result.content);
    value.slides[0].notes = "概括";
    return { content: JSON.stringify(value), truncated: false };
  });
  const allNotes = plan.slides.map((slide) => slide.notes).join("\n");
  expect(allNotes).toContain("FBM 与 FBA 的区别");
  expect(allNotes).toContain("按平台仓储计费");
  expect(allNotes).toContain("营销");
});

it("遗漏来源时要求模型修正，不能覆盖时不生成文件", async () => {
  let calls = 0;
  await expect(planPresentationWithAi(source, "转 PPT", async (messages) => {
    calls++;
    const items = parts(messages);
    return response(items, ["不存在的来源"]);
  })).rejects.toThrow(/不存在的来源 ID/);
  expect(calls).toBe(2);
});

it("遗漏来源修复成功后继续下一章节", async () => {
  let calls = 0; let repair = "";
  const plan = await planPresentationWithAi(source, "转 PPT", async (messages) => {
    calls++;
    const items = parts(messages);
    if (calls === 1) return response(items, [items[0].id]);
    if (messages.length > 2) repair = JSON.stringify(messages.at(-1));
    return response(items);
  });
  expect(repair).toContain("遗漏来源 ID");
  expect(plan.slides).toHaveLength(2);
});

it("超长备注分段处理，不把后续节点挤掉", async () => {
  const doc: MindDocument = { format: "xmind", warnings: [], sheets: [{ title: "主题", notes: "", children: [{ title: "章节", notes: "甲".repeat(7000), children: [{ title: "结尾节点", notes: "", children: [] }] }] }] };
  const seen: string[] = [];
  await planPresentationWithAi(doc, "转换", async (messages) => { const items = parts(messages); seen.push(...items.map((part: any) => part.text)); return response(items); });
  expect(seen.join("")).toContain("甲".repeat(1600));
  expect(seen.join("")).toContain("结尾节点");
});

it("报告分批处理进度并生成可编辑卡片和流程页面", async () => {
  const progress: string[] = [];
  let count = 0;
  const large: MindDocument = { format: "xmind", warnings: [], sheets: [{ title: "测试", notes: "", children: Array.from({ length: 25 }, (_, i) => ({ title: `主题${i}`, notes: "", children: [] })) }] };
  const plan = await planPresentationWithAi(large, "转换", async (messages) => {
    const items = parts(messages); const result = response(items); const value = JSON.parse(result.content);
    value.slides[0].layout = count++ % 2 ? "process" : "cards";
    value.slides[0].lines = ["第一步", "第二步", "第三步"];
    return { content: JSON.stringify(value), truncated: false };
  }, (message) => progress.push(message));
  expect(progress[0]).toContain("第 1/2 批");
  expect(progress.at(-1)).toContain("合成可编辑 PPT");
  const ppt = await JSZip.loadAsync(await renderAiPresentation(plan));
  for (const page of [2, 3]) {
    const xml = await ppt.file(`ppt/slides/slide${page}.xml`)!.async("string");
    expect(xml).toContain("第一步");
    expect(xml).toContain("roundRect");
    expect((xml.match(/<p:sp>/g) ?? []).length).toBeGreaterThan(5);
  }
});

it("内容页只有演讲备注时要求重做", async () => {
  let calls = 0;
  await expect(planPresentationWithAi(source, "转换", async (messages) => {
    calls++;
    const result = response(parts(messages)); const value = JSON.parse(result.content);
    value.slides[0].lines = [];
    return { content: JSON.stringify(value), truncated: false };
  })).rejects.toThrow(/必须有可见正文/);
  expect(calls).toBe(2);
});

it("分批处理中断后，相同材料和要求可复用已验证的批次", async () => {
  const large: MindDocument = { format: "xmind", warnings: [], sheets: [{ title: "测试", notes: "", children: Array.from({ length: 25 }, (_, i) => ({ title: `主题${i}`, notes: "", children: [] })) }] };
  const store = new Map<string, string>();
  const cache = { scope: "channel/model", get: (key: string) => store.get(key) ?? null, set: (key: string, value: string) => { store.set(key, value); } };
  let calls = 0;
  await expect(planPresentationWithAi(large, "完整转换", async (messages) => {
    calls++;
    if (calls > 1) throw new Error("连接中断");
    return response(parts(messages));
  }, undefined, cache)).rejects.toThrow("连接中断");
  expect(store.size).toBe(1);
  calls = 0;
  const progress: string[] = [];
  const plan = await planPresentationWithAi(large, "完整转换", async (messages) => { calls++; return response(parts(messages)); }, (message) => progress.push(message), cache);
  expect(calls).toBe(1);
  expect(plan.slides).toHaveLength(3);
  expect(progress.join("\n")).toContain("已恢复第 1/2 批");
  calls = 0;
  await planPresentationWithAi(large, "重点讲后半部分", async (messages) => { calls++; return response(parts(messages)); }, undefined, cache);
  expect(calls).toBe(2);
});

it("内容审校指出遗漏后修正，复查通过才缓存", async () => {
  let plans = 0; let reviews = 0;
  const stored = new Map<string, string>();
  const cache = { scope: "test", get: (key: string) => stored.get(key) ?? null, set: (key: string, value: string) => { stored.set(key, value); } };
  const plan = await planPresentationWithAi(source, "完整转换", async (messages) => { plans++; return response(parts(messages)); }, undefined, cache, async () => {
    reviews++;
    return { content: JSON.stringify({ issues: reviews === 1 ? ["物流计费条件未体现"] : [] }), truncated: false };
  });
  expect(plan.slides.length).toBeGreaterThan(1);
  expect(plans).toBe(2);
  expect(reviews).toBe(2);
  expect(stored.size).toBe(1);
});

it("内容反复未通过审校时不写入断点缓存", async () => {
  const stored = new Map<string, string>();
  const cache = { scope: "test", get: (key: string) => stored.get(key) ?? null, set: (key: string, value: string) => { stored.set(key, value); } };
  await expect(planPresentationWithAi(source, "完整转换", async (messages) => response(parts(messages)), undefined, cache, async () => ({ content: JSON.stringify({ issues: ["遗漏限定条件"] }), truncated: false }))).rejects.toThrow(/内容审校仍有问题/);
  expect(stored.size).toBe(0);
});
