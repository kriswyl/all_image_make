import { expect, it } from "vitest";
import type { AiPresentation } from "../src/server/mind-document";
import type { TemplateReport } from "../src/shared/presentation-report";
import { carryDeckReport } from "../src/server/presentation-deck-carry";
import { checkPresentationContract, countVisibleCaseLabels } from "../src/server/presentation-contract-check";
import type { PresentationSpecStore } from "../src/server/presentation-spec-store";
import type { PresentationSpec } from "../src/shared/presentation-spec";

function planOf(titles: string[], layouts: Array<AiPresentation["slides"][number]["layout"]> = []): AiPresentation {
  return {
    title: "培训", theme: "blue",
    slides: titles.map((title, index) => ({
      layout: (layouts[index] ?? "content") as AiPresentation["slides"][number]["layout"],
      title, subtitle: "", lines: [`${title} 的正文`], notes: "", sourceIds: [`s-${index + 1}`],
    })),
  };
}

function reportOf(pages: Array<{ page: number; role: string; layout: string }>): TemplateReport {
  return {
    draft: false, resume: false, fallbackPages: [4], pendingPages: [6], overflowPages: [],
    sourceLimitedPages: [], notesLimitedPages: [], unplacedImages: 0,
    planningFallback: false, audit: "complete", issues: [{ page: 2, detail: "原审校问题" }],
    deckPlan: {
      pages: pages.map(item => ({ ...item, fitsRole: true })) as TemplateReport["deckPlan"] extends undefined ? never : NonNullable<TemplateReport["deckPlan"]>["pages"],
      repeatedRuns: [],
      roleDistribution: { case: 3 },
    },
  };
}

it("F01：未改动的页沿用原职责，被修改的页按新标题重新推断", () => {
  const parent = planOf(["封面与总览", "案例 A：门店改造", "案例 B：渠道试点", "案例 C：供应链", "行动建议"]);
  const child = structuredClone(parent);
  // 第 3 页从「案例 B」改成对比结构，其余页不变。
  child.slides[2] = { ...child.slides[2]!, title: "方案对比：自建与外包", lines: ["两种方案的差异"] };
  const carried = carryDeckReport({
    plan: child, parentPlan: parent, touched: [3],
    parentReport: reportOf([
      { page: 1, role: "claim", layout: "content" },
      { page: 2, role: "case", layout: "content" },
      { page: 3, role: "case", layout: "content" },
      { page: 4, role: "case", layout: "content" },
      { page: 5, role: "action", layout: "content" },
    ]),
  });
  const roles = carried!.deckPlan!.pages.map(page => `${page.page}:${page.role}`);
  expect(roles).toEqual(["1:claim", "2:case", "3:comparison", "4:case", "5:action"]);
});

it("F02：修改入口不再丢掉整稿计划，改了具体页就不再算精简/待补全", () => {
  const parent = planOf(["一", "二", "三", "四", "五", "六"]);
  const carried = carryDeckReport({
    plan: parent, parentPlan: parent, touched: [4, 6],
    parentReport: reportOf([
      { page: 1, role: "case", layout: "content" },
      { page: 2, role: "case", layout: "content" },
      { page: 3, role: "case", layout: "content" },
    ]),
  });
  expect(carried?.deckPlan?.pages).toHaveLength(6);
  expect(carried?.fallbackPages).toEqual([]);
  expect(carried?.pendingPages).toEqual([]);
  // 内容已变，原内容审校结论不能继续代表当前文件。
  expect(carried?.audit).toBe("unavailable");
  expect(carried?.issues).toEqual([]);
});

it("F03：没有原报告时不造报告，保持既有行为", () => {
  expect(carryDeckReport({ plan: planOf(["一"]), parentPlan: planOf(["一"]) })).toBeUndefined();
});

it("F04：正文里数出不同案例标签，供缺职责计划时兜底", () => {
  const plan = planOf(["培训"], ["content"]);
  plan.slides.push({ layout: "content", title: "案例 A：门店改造", subtitle: "", lines: ["案例 A 的正文"], notes: "", sourceIds: ["s-a"] });
  plan.slides.push({ layout: "content", title: "案例 B：渠道试点", subtitle: "", lines: ["案例 B 的正文"], notes: "", sourceIds: ["s-b"] });
  plan.slides.push({ layout: "content", title: "案例 C：供应链", subtitle: "", lines: ["案例 C 的正文"], notes: "", sourceIds: ["s-c"] });
  expect(countVisibleCaseLabels(plan)).toBe(3);
});

it("F05：正文标签不计入备注", () => {
  const plan = planOf(["培训"]);
  plan.slides[0]!.lines = ["正文无关内容"];
  plan.slides[0]!.notes = "案例 A：门店改造\n案例 B：渠道试点\n案例 C：供应链";
  expect(countVisibleCaseLabels(plan)).toBe(0);
});

const spec = (): PresentationSpec => ({
  schemaVersion: 1, specId: "spec-1", conversationId: "c1", revision: 1, lifecycle: "active", origin: "user",
  cover: "include", sources: [], visualPolicy: "background",
  pageCount: { kind: "exact", value: 4, evidence: { sourceMessageId: "m1", text: "4 页" } },
  pageCountBasis: "total", requiredContent: [], requiredAssets: [],
  structure: [{ kind: "case_count", value: 3, evidence: { sourceMessageId: "m1", text: "必须保留三个案例" } }],
  createdAt: "2026-11-07T00:00:00.000Z", updatedAt: "2026-11-07T00:00:00.000Z",
}) as PresentationSpec;

/** 让门禁把真实校验结果写回来，而不是用固定桩掩盖结论。 */
const store = {
  saveValidation: (input: Record<string, unknown>) => ({ validationId: "v1", ...input }),
} as unknown as PresentationSpecStore;

it("F06：没有职责计划时，正文里的三个案例标签即可满足结构要求", () => {
  const plan = planOf(["总览", "案例 A：门店改造", "案例 B：渠道试点", "案例 C：供应链"]);
  const checked = checkPresentationContract(store, { conversationId: "c1", spec: spec(), plan, bytes: Buffer.from("x") });
  expect(checked.validation?.failures).toEqual([]);
  expect(checked.validation?.visibleCoverage).toEqual({ required: 1, satisfied: 1, unknown: 0 });
});

it("F07：正文只有两个案例时明确失败，不谎报满足", () => {
  const plan = planOf(["总览", "案例 A：门店改造", "案例 B：渠道试点", "其他内容"]);
  const checked = checkPresentationContract(store, { conversationId: "c1", spec: spec(), plan, bytes: Buffer.from("x") });
  expect(checked.validation?.failures.map(item => item.code)).toContain("STRUCTURE_CASE_COUNT");
  expect(checked.validation?.visibleCoverage).toEqual({ required: 1, satisfied: 0, unknown: 0 });
});

it("F08：修改版不能把版式退化成 content，应继承或从元素反推", () => {
  const parent = planOf(["总览", "指标页", "流程页", "对比页"]);
  const child = structuredClone(parent);
  // 第 2 页被改成指标卡（渲染器元素），第 4 页内容未动
  child.slides[1] = {
    layout: "content", title: "指标页", subtitle: "", notes: "", sourceIds: ["s-2"], lines: [],
    elements: [
      { type: "shape", id: "kpi-0", shape: "roundRect", x: 0.8, y: 2, w: 3, h: 4, fill: "EEEEEE" },
      { type: "text", id: "kpi-value-0", x: 1, y: 2.4, w: 2.6, h: 1.4, text: "92%", style: { fontSize: 44 } },
    ],
  };
  const carried = carryDeckReport({
    plan: child, parentPlan: parent, touched: [2],
    parentReport: reportOf([
      { page: 1, role: "claim", layout: "bullets" },
      { page: 2, role: "evidence", layout: "table" },
      { page: 3, role: "process", layout: "timeline" },
      { page: 4, role: "comparison", layout: "comparison" },
    ]),
  });
  const layouts = carried!.deckPlan!.pages.map(page => `${page.page}:${page.layout}`);
  // 未改页沿用原版式；被改页从 kpi-* 元素反推为 kpi，而不是 content
  expect(layouts).toEqual(["1:bullets", "2:kpi", "3:timeline", "4:comparison"]);
  expect(layouts.some(item => item.endsWith(":content"))).toBe(false);
});
