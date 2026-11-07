import { expect, it } from "vitest";
import { reviewRenderedPresentation } from "../src/server/presentation-visual-review";
import type { AiPresentation } from "../src/server/mind-document";

/** C：视觉检查集合由 ChangeScope 决定，且保留原页码（文档 §6.1、§7.4）。 */
const plan10: AiPresentation = {
  title: "十页资料", theme: "blue",
  slides: Array.from({ length: 10 }, (_, index) => ({
    layout: "content" as const, title: `第 ${index + 1} 页`, subtitle: "",
    lines: [`原始事实 ${index + 1}`, "支撑条件"], notes: "来源原文", sourceIds: [`s-${index + 1}`],
  })),
};
const screenshots = () => Array.from({ length: 10 }, () => Buffer.from("png"));

function submittedPage(messages: Array<{ content: unknown }>): number {
  const user = messages[1]?.content;
  const text = Array.isArray(user) ? String((user[0] as { text?: string })?.text ?? "") : String(user ?? "");
  return JSON.parse(text).page as number;
}

it("C08：局部检查只向模型提交第 3 页，不遍历其余九页", async () => {
  const submitted: number[] = [];
  const result = await reviewRenderedPresentation(plan10, [], async () => screenshots(),
    async messages => {
      submitted.push(submittedPage(messages));
      return { content: JSON.stringify({ issues: [] }), truncated: false };
    },
    undefined, undefined, [3]);
  expect(submitted).toEqual([3]);
  expect(result.checkedPages).toEqual([3]);
  expect(result.complete).toBe(true);
  expect(result.summary).toMatch(/1 页/);
});

it("C09：局部检查发现问题时报告的是原页码，不是重编号后的第 1 页", async () => {
  const result = await reviewRenderedPresentation(plan10, [], async () => screenshots(),
    async messages => {
      expect(submittedPage(messages)).toBe(3);
      return { content: JSON.stringify({ issues: ["标题与正文拥挤"] }), truncated: false };
    },
    undefined, undefined, [3]);
  expect(result.issues.some(issue => issue.page === 3)).toBe(true);
  expect(result.issues.some(issue => issue.page === 1)).toBe(false);
});

it("C10：不传 pageNumbers 时保持整稿检查的既有行为", async () => {
  const submitted: number[] = [];
  const result = await reviewRenderedPresentation(plan10, [], async () => screenshots(),
    async messages => {
      submitted.push(submittedPage(messages));
      return { content: JSON.stringify({ issues: [] }), truncated: false };
    });
  expect(submitted).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(result.checkedPages).toHaveLength(10);
  expect(result.summary).toContain("全部 10 页");
});

it("C14：性能指标分开记模型调用页数与 WPS 导出页数，WPS 仍加载整稿", async () => {
  const result = await reviewRenderedPresentation(plan10, [], async () => screenshots(),
    async () => ({ content: JSON.stringify({ issues: [] }), truncated: false }),
    undefined, undefined, [3]);
  expect(result.metrics.pages).toEqual([3]);
  expect(result.metrics.modelCalls).toBe(1);
  expect(result.metrics.cacheHits).toBe(0);
  expect(result.metrics.wps.renders).toBe(1);
  // WPS 导出的是整份十页，不能因为只检查第 3 页就宣称只处理一页。
  expect(result.metrics.wps.exportedPages).toBe(10);
});

it("C15：相同检查再次执行时命中缓存，模型调用为 0", async () => {
  const cache = new Map<string, string>();
  const cacheOptions = { scope: "metrics-test", get: (key: string) => cache.get(key) ?? null, set: (key: string, value: string) => { cache.set(key, value); } };
  const first = await reviewRenderedPresentation(plan10, [], async () => screenshots(),
    async () => ({ content: JSON.stringify({ issues: [] }), truncated: false }),
    undefined, cacheOptions, [3]);
  const second = await reviewRenderedPresentation(plan10, [], async () => screenshots(),
    async () => { throw new Error("命中缓存时不应再调用模型"); },
    undefined, cacheOptions, [3]);
  expect(first.metrics.cacheHits).toBe(0);
  expect(first.metrics.modelCalls).toBe(1);
  expect(second.metrics.cacheHits).toBe(1);
  expect(second.metrics.modelCalls).toBe(0);
});

it("C16：不同文件版本的同页同截图可以复用视觉结论，不再被文件哈希整体作废", async () => {
  const store = new Map<string, string>();
  const options = (scope: string) => ({
    scope, engineVersion: "visual-v2",
    get: (key: string) => store.get(key) ?? null,
    set: (key: string, value: string) => { store.set(key, value); },
  });
  const first = await reviewRenderedPresentation(plan10, [], async () => screenshots(),
    async () => ({ content: JSON.stringify({ issues: [] }), truncated: false }),
    undefined, options("sha-version-a"), [3]);
  const second = await reviewRenderedPresentation(plan10, [], async () => screenshots(),
    async () => { throw new Error("同页同截图应命中缓存"); },
    undefined, options("sha-version-b"), [3]);
  expect(first.metrics.cacheHits).toBe(0);
  expect(second.metrics.cacheHits).toBe(1);
  expect(second.metrics.modelCalls).toBe(0);
});

it("C17：页面内容变化后不再复用旧视觉结论", async () => {
  const store = new Map<string, string>();
  const options = {
    scope: "sha-version-a", engineVersion: "visual-v2",
    get: (key: string) => store.get(key) ?? null,
    set: (key: string, value: string) => { store.set(key, value); },
  };
  await reviewRenderedPresentation(plan10, [], async () => screenshots(),
    async () => ({ content: JSON.stringify({ issues: [] }), truncated: false }),
    undefined, options, [3]);
  const changed = { ...plan10, slides: plan10.slides.map((slide, index) => index === 2 ? { ...slide, title: "改了标题" } : slide) };
  let called = 0;
  const second = await reviewRenderedPresentation(changed, [], async () => screenshots(),
    async () => { called++; return { content: JSON.stringify({ issues: [] }), truncated: false }; },
    undefined, options, [3]);
  expect(called).toBe(1);
  expect(second.metrics.cacheHits).toBe(0);
});

it("C11：页码集合去重升序，越界页码必须拒绝", async () => {
  const submitted: number[] = [];
  await reviewRenderedPresentation(plan10, [], async () => screenshots(),
    async messages => {
      submitted.push(submittedPage(messages));
      return { content: JSON.stringify({ issues: [] }), truncated: false };
    },
    undefined, undefined, [7, 3, 7]);
  expect(submitted).toEqual([3, 7]);
  await expect(reviewRenderedPresentation(plan10, [], async () => screenshots(),
    async () => ({ content: JSON.stringify({ issues: [] }), truncated: false }),
    undefined, undefined, [11])).rejects.toThrow();
});
