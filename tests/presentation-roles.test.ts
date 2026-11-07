import { expect, it } from "vitest";
import {
  PAGE_ROLES, SLIDE_LAYOUTS, findRepeatedRuns, inferRole, layoutFitsRole,
  preferredLayouts, summarizeRoles, type DeckPlanPage, type PageRole, type SlideLayout,
} from "../src/shared/presentation-roles";
import { slideContentSchema } from "../src/server/presentation-templates";

/** D1：整稿职责与布局计划（文档 §6.3）。 */
const planPage = (page: number, role: PageRole, layout: SlideLayout, seriesId?: string): DeckPlanPage => ({
  page, role, layout, preferred: preferredLayouts(role), ...(seriesId ? { seriesId } : {}),
});

it("D01：shared 的版式字面量与渲染 schema 不漂移", () => {
  const schemaLayouts = slideContentSchema.shape.layout.options as string[];
  expect([...SLIDE_LAYOUTS].sort()).toEqual([...schemaLayouts].sort());
});

it("D02：八种职责都有候选版式，且首个候选是主推", () => {
  expect(PAGE_ROLES).toHaveLength(8);
  for (const role of PAGE_ROLES) {
    const layouts = preferredLayouts(role);
    expect(layouts.length).toBeGreaterThan(0);
    expect(layoutFitsRole(role, layouts[0]!)).toBe(true);
  }
  expect(preferredLayouts("comparison")[0]).toBe("comparison");
  expect(preferredLayouts("process")[0]).toBe("process");
  expect(preferredLayouts("evidence")).toContain("table");
  expect(layoutFitsRole("comparison", "bullets")).toBe(false);
});

it("D03：模型未给职责时按标题确定性兜底，不整稿退化成同一类", () => {
  expect(inferRole("方案对比：自建与外包")).toBe("comparison");
  expect(inferRole("上线流程与阶段划分")).toBe("process");
  expect(inferRole("案例：某门店三个月复盘")).toBe("case");
  expect(inferRole("关键指标趋势")).toBe("evidence");
  expect(inferRole("下一步行动建议")).toBe("action");
  expect(inferRole("术语与参考")).toBe("appendix");
  expect(inferRole("第一章 背景")).toBe("claim");
  // 最后一页正文默认落到行动，避免全篇都是结论页。
  expect(inferRole("小结", "", { index: 8, contentCount: 9 })).toBe("action");
});

it("D04：连续三页同版式且职责不同、又不在同一系列，判为无理由重复", () => {
  const pages = [
    planPage(1, "claim", "bullets"),
    planPage(2, "evidence", "bullets"),
    planPage(3, "process", "bullets"),
    planPage(4, "comparison", "comparison"),
  ];
  const runs = findRepeatedRuns(pages);
  expect(runs).toHaveLength(1);
  expect(runs[0]).toMatchObject({ start: 1, end: 3, layout: "bullets", pages: [1, 2, 3] });
  expect(runs[0]!.roles).toEqual(["claim", "evidence", "process"]);
});

it("D05：同一案例系列的连续同构图不算重复，两页相同也不算", () => {
  const series = [
    planPage(1, "claim", "bullets"),
    planPage(2, "case", "cards", "case-a"),
    planPage(3, "case", "cards", "case-a"),
    planPage(4, "case", "cards", "case-a"),
  ];
  expect(findRepeatedRuns(series)).toEqual([]);
  expect(findRepeatedRuns([planPage(1, "claim", "bullets"), planPage(2, "action", "bullets")])).toEqual([]);
});

it("D11：单一职责占比过高会被确定性报出", () => {
  const pages = Array.from({ length: 9 }, (_, index) => planPage(index + 1, "claim", "bullets"));
  const summary = summarizeRoles(pages);
  expect(summary.distribution.claim).toBe(9);
  expect(summary.concentration).toMatchObject({ role: "claim", count: 9 });
});

it("D12：职责分布分散时不报集中", () => {
  const summary = summarizeRoles([
    planPage(1, "claim", "bullets"), planPage(2, "evidence", "table"),
    planPage(3, "process", "process"), planPage(4, "case", "cards"),
  ]);
  expect(summary.concentration).toBeNull();
});

it("D06：版式不同、或职责相同，都不触发提示", () => {
  expect(findRepeatedRuns([
    planPage(1, "claim", "bullets"), planPage(2, "evidence", "table"), planPage(3, "process", "process"),
  ])).toEqual([]);
  expect(findRepeatedRuns([
    planPage(1, "claim", "bullets"), planPage(2, "claim", "bullets"), planPage(3, "claim", "bullets"),
  ])).toEqual([]);
});
