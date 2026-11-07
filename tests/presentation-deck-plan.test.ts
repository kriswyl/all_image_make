import { expect, it } from "vitest";
import { markdownToMind } from "../src/server/chat-tools/markdown";
import { runTemplatePresentation } from "../src/server/presentation-workflow";
import { PAGE_ROLES, preferredLayouts, type PageRole } from "../src/shared/presentation-roles";

/** D1：整稿职责与布局计划进入生成链路（文档 §6.3）。 */
const chapters = Array.from({ length: 10 }, (_, index) => `第 ${index + 1} 单元`);
const markdown = ["# 虚构运营资料", ...chapters.flatMap(title => [`## ${title}`, `- ${title}的关键事实与限定条件`])].join("\n");
const mind = markdownToMind(markdown, "虚构运营资料");

const ROLES: PageRole[] = ["claim", "evidence", "comparison", "process", "case", "case", "case", "claim", "action", "appendix"];

type Call = Parameters<typeof runTemplatePresentation>[1];
function outline(catalog: Array<{ id: number }>, withRole: boolean, roles: PageRole[] = ROLES) {
  return {
    title: "虚构运营资料", audience: "学员", objective: "掌握要点",
    pages: catalog.map((row, index) => ({
      title: chapters[index] ?? `单元${index + 1}`, goal: "讲清本单元的关键事实", batchIds: [row.id],
      ...(withRole ? { role: roles[index] ?? "claim" } : {}),
      ...(withRole && index >= 4 && index <= 6 ? { seriesId: "cases" } : {}),
    })),
  };
}
function pageOf(input: { page: number; title: string; pageRole?: PageRole }, forceBullets: boolean) {
  const role = input.pageRole ?? "claim";
  const layout = forceBullets ? "bullets" : preferredLayouts(role)[0]!;
  const base = { page: input.page, title: input.title, layout, notes: "按原文核对" };
  if (layout === "bullets") return { ...base, bullets: [`要点 ${input.page} 的说明与限定`] };
  if (layout === "table") return { ...base, table: [["维度", "数值"], ["示例", "100"]] };
  if (layout === "chart") return { ...base, chart: { type: "bar" as const, categories: ["A", "B"], series: [{ name: "数量", values: [1, 2] }] } };
  return { ...base, groups: [{ title: "组一", items: ["说明一"] }, { title: "组二", items: ["说明二"] }] };
}
function makeCall(options: { withRole: boolean; forceBullets?: boolean; roles?: PageRole[] }): Call {
  return async messages => {
    const instruction = String(messages[0]?.content);
    const input = JSON.parse(String(messages[1]?.content));
    if (instruction.includes("总策划")) return { content: JSON.stringify(outline(input.catalog, options.withRole, options.roles)), truncated: false };
    if (instruction.includes("审校")) return { content: JSON.stringify({ issues: [] }), truncated: false };
    return {
      content: JSON.stringify({ pages: input.pages.map((page: { page: number; title: string; pageRole?: PageRole }) => pageOf(page, options.forceBullets ?? false)) }),
      truncated: false,
    };
  };
}
const baseOptions = (scope: string) => {
  const cache = new Map<string, string>();
  return {
    request: "做成 11 页培训 PPT，封面计入总页数", scope, images: [],
    get: (key: string) => cache.get(key) ?? null,
    set: (key: string, value: string) => { cache.set(key, value); },
  };
};

it("D07：规划角色落到每一页，版式与职责匹配，页数与内容不丢", async () => {
  const result = await runTemplatePresentation(mind, makeCall({ withRole: true }), baseOptions("deck-plan-1"));
  expect(result.plan?.slides).toHaveLength(11);
  const deck = result.template.deckPlan;
  expect(deck?.pages).toHaveLength(10);
  expect(deck?.pages.map(item => item.role)).toEqual(ROLES);
  expect(deck?.pages.every(item => item.fitsRole)).toBe(true);
  expect(deck?.pages.every(item => item.layout && item.layout !== "")).toBe(true);
  // 每页仍带内容，没有因为增加计划而丢页或丢正文。
  for (const slide of result.plan!.slides.slice(1)) {
    expect((slide.lines?.length ?? 0) + (slide.elements?.length ?? 0)).toBeGreaterThan(0);
  }
});

it("D08：同一案例系列的连续同构图不算无理由重复", async () => {
  const result = await runTemplatePresentation(mind, makeCall({ withRole: true }), baseOptions("deck-plan-2"));
  expect(result.template.deckPlan?.repeatedRuns).toEqual([]);
});

it("D09：模型不按职责选版式时，连续三页同构图会被确定性报出来", async () => {
  const result = await runTemplatePresentation(mind, makeCall({ withRole: true, forceBullets: true }), baseOptions("deck-plan-3"));
  const runs = result.template.deckPlan?.repeatedRuns ?? [];
  expect(runs.length).toBeGreaterThan(0);
  expect(runs[0]!.layout).toBe("bullets");
  expect(runs[0]!.roles.length).toBeGreaterThan(1);
  // 只提示，不影响交付。
  expect(result.template.draft).toBe(false);
});

it("D13：模型把大多数单元标成同一职责时，报告给出集中度提示（否则重复检测会失效）", async () => {
  const allClaim = Array.from({ length: 10 }, () => "claim" as PageRole);
  const result = await runTemplatePresentation(mind, makeCall({ withRole: true, roles: allClaim }), baseOptions("deck-plan-5"));
  const deck = result.template.deckPlan;
  expect(deck?.concentration).toMatchObject({ role: "claim", count: 10 });
  expect(deck?.roleDistribution?.claim).toBe(10);
  // 职责相同，按规则不判「无理由重复」——这正是集中度提示要补的盲区。
  expect(deck?.repeatedRuns).toEqual([]);
});

it("D14：契约的结构要求会传给总策划，否则模型不知道要分配几个案例页", async () => {
  let outlinePrompt = "";
  const call: Call = async messages => {
    const instruction = String(messages[0]?.content);
    const input = JSON.parse(String(messages[1]?.content));
    if (instruction.includes("总策划")) {
      outlinePrompt = instruction;
      return { content: JSON.stringify(outline(input.catalog, true)), truncated: false };
    }
    if (instruction.includes("审校")) return { content: JSON.stringify({ issues: [] }), truncated: false };
    return { content: JSON.stringify({ pages: input.pages.map((page: { page: number; title: string; pageRole?: PageRole }) => pageOf(page, false)) }), truncated: false };
  };
  await runTemplatePresentation(mind, call, { ...baseOptions("deck-plan-6"), requiredCaseCount: 3 });
  expect(outlinePrompt).toContain("3 个案例");
  expect(outlinePrompt).toContain("role=case");
});

it("D15：规划回退时仍要满足案例页数，不能因为降级就丢掉结构要求", async () => {
  const call: Call = async messages => {
    const instruction = String(messages[0]?.content);
    if (instruction.includes("总策划")) return { content: "无法规划", truncated: false };
    const input = JSON.parse(String(messages[1]?.content));
    if (instruction.includes("审校")) return { content: JSON.stringify({ issues: [] }), truncated: false };
    return { content: JSON.stringify({ pages: input.pages.map((page: { page: number; title: string; pageRole?: PageRole }) => pageOf(page, false)) }), truncated: false };
  };
  const result = await runTemplatePresentation(mind, call, { ...baseOptions("deck-plan-7"), requiredCaseCount: 3 });
  expect(result.template.planningFallback).toBe(true);
  const roles = result.template.deckPlan?.pages.map(item => item.role) ?? [];
  expect(roles.filter(role => role === "case")).toHaveLength(3);
});

it("D10：模型漏填 role 时按标题确定性兜底，不整稿退化成同一类", async () => {
  const result = await runTemplatePresentation(mind, makeCall({ withRole: false }), baseOptions("deck-plan-4"));
  const roles = result.template.deckPlan?.pages.map(item => item.role) ?? [];
  expect(roles).toHaveLength(10);
  expect(roles.every(role => PAGE_ROLES.includes(role as PageRole))).toBe(true);
  expect(new Set(roles).size).toBeGreaterThan(1);
  // 最后一页正文兜底为行动建议。
  expect(roles.at(-1)).toBe("action");
});

it("D27：主题进入生成链路，报告记录实际主题且封面/正文字号随之变化", async () => {
  const blue = await runTemplatePresentation(mind, makeCall({ withRole: true }), baseOptions("theme-blue"));
  const magazine = await runTemplatePresentation(mind, makeCall({ withRole: true }), { ...baseOptions("theme-magazine"), themeId: "magazine", styleRequest: "换成杂志风" });
  expect(blue.template.theme).toMatchObject({ id: "blue" });
  expect(magazine.template.theme).toMatchObject({ id: "magazine", requested: "换成杂志风" });

  const titleOf = (slide: { elements?: Array<{ id: string; type: string; style?: { fontSize?: number } }> }) =>
    slide.elements?.find(element => element.id === "title")?.style?.fontSize;
  expect(titleOf(magazine.plan!.slides[1]!)).toBeGreaterThan(titleOf(blue.plan!.slides[1]!)!);
  // 封面也换主题底与字号
  expect(blue.plan!.slides[0]!.background).toBe("142A43");
  expect(magazine.plan!.slides[0]!.background).toBe("1A1A1A");
});

it("D28：未知主题回退默认，不产生半套样式", async () => {
  const result = await runTemplatePresentation(mind, makeCall({ withRole: true }), { ...baseOptions("theme-unknown"), themeId: "赛博朋克" });
  expect(result.template.theme?.id).toBe("blue");
  expect(result.plan?.slides[0]!.background).toBe("142A43");
});
