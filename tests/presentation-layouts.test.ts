import { expect, it } from "vitest";
import { renderContentSlide, validSlideContent, type SlideContent } from "../src/server/presentation-templates";
import { DEFAULT_THEME_ID, getTheme } from "../src/shared/presentation-theme";
import { PAGE_ROLES, preferredLayouts } from "../src/shared/presentation-roles";
import { layoutIssues, type PresentationElement } from "../src/server/presentation-elements";

/** D2 扩展版式：kpi / timeline / quote 都只描述结构，坐标由渲染器算。 */
const theme = getTheme(DEFAULT_THEME_ID);
const render = (content: SlideContent, themeId = DEFAULT_THEME_ID) =>
  renderContentSlide(content, {}, ["s1"], "来源原文", undefined, undefined, getTheme(themeId)).slide;
const texts = (slide: { elements?: PresentationElement[] }) =>
  (slide.elements ?? []).filter((element): element is Extract<PresentationElement, { type: "text" }> => element.type === "text");

it("L01：kpi 至少要两个指标，单指标或缺失都不合法", () => {
  const base: SlideContent = { page: 2, title: "三项关键指标", layout: "kpi" };
  expect(validSlideContent({ ...base, metrics: [{ label: "覆盖率", value: "92%" }] }, [])).toBe(false);
  expect(validSlideContent({ ...base, metrics: [{ label: "覆盖率", value: "92%" }, { label: "周转", value: "3 天" }] }, [])).toBe(true);
  expect(validSlideContent(base, [])).toBe(false);
});

it("L02：timeline 至少要三个阶段，两个太少", () => {
  const base: SlideContent = { page: 2, title: "上线路径", layout: "timeline" };
  expect(validSlideContent({ ...base, steps: [{ title: "试点" }, { title: "推广" }] }, [])).toBe(false);
  expect(validSlideContent({ ...base, steps: [{ title: "试点" }, { title: "推广" }, { title: "复盘" }] }, [])).toBe(true);
});

it("L03：quote 的正文不能等于标题，也不能是空串", () => {
  const base: SlideContent = { page: 2, title: "结论只有一句", layout: "quote" };
  expect(validSlideContent({ ...base, quote: { text: "结论只有一句" } }, [])).toBe(false);
  expect(validSlideContent({ ...base, quote: { text: "  " } }, [])).toBe(false);
  expect(validSlideContent({ ...base, quote: { text: "先把流程跑通，再谈规模。" } }, [])).toBe(true);
});

it("L04：kpi 渲染出等宽指标卡，数值用强调色且不越界", () => {
  const slide = render({
    page: 2, title: "三项关键指标", layout: "kpi",
    metrics: [
      { label: "门店覆盖率", value: "92%", note: "较上季 +6pt" },
      { label: "平均周转", value: "3 天" },
      { label: "试点转化", value: "8%" },
    ],
  });
  const panels = (slide.elements ?? []).filter(element => element.id.startsWith("kpi-") && element.type === "shape");
  expect(panels).toHaveLength(3);
  const values = texts(slide).filter(element => element.id.startsWith("kpi-value-"));
  expect(values).toHaveLength(3);
  expect(values.every(value => value.style?.color === theme.colors.accent)).toBe(true);
  expect(values.every(value => value.style?.bold)).toBe(true);
  // 三列等宽且不重叠
  const widths = panels.map(panel => ("w" in panel ? Number(panel.w) : 0));
  expect(new Set(widths.map(width => width.toFixed(2))).size).toBe(1);
  expect(layoutIssues(slide.elements ?? [])).toEqual([]);
});

it("L05：timeline 生成一条主轴 + 与阶段数一致的节点与编号", () => {
  const slide = render({
    page: 3, title: "上线路径", layout: "timeline",
    steps: [
      { title: "选点", detail: "12 家门店" },
      { title: "试点", detail: "四周观察" },
      { title: "评估", detail: "口径统一后再比对" },
      { title: "推广", detail: "分批放量" },
    ],
  });
  const ids = (slide.elements ?? []).map(element => element.id);
  expect(ids).toContain("timeline-axis");
  expect(ids.filter(id => id.startsWith("timeline-node-"))).toHaveLength(4);
  expect(ids.filter(id => id.startsWith("timeline-detail-"))).toHaveLength(4);
  expect(texts(slide).filter(element => element.id.startsWith("timeline-index-")).map(element => element.text))
    .toEqual(["01", "02", "03", "04"]);
  expect(layoutIssues(slide.elements ?? [])).toEqual([]);
});

it("L06：quote 是大字留白页，出处跟在后面且不越界", () => {
  const slide = render({
    page: 4, title: "阶段结论", layout: "quote",
    quote: { text: "先把流程跑通，再谈规模。", source: "虚构运营复盘" },
  });
  const ids = (slide.elements ?? []).map(element => element.id);
  expect(ids).toContain("quote-bar");
  const body = texts(slide).find(element => element.id === "quote-text")!;
  const title = texts(slide).find(element => element.id === "title")!;
  expect(body.style!.fontSize).toBeGreaterThan(title.style!.fontSize!);
  expect(texts(slide).find(element => element.id === "quote-source")!.text).toContain("虚构运营复盘");
  expect(layoutIssues(slide.elements ?? [])).toEqual([]);
});

it("L07：新版的尺寸跟随主题令牌，不是写死的", () => {
  const content: SlideContent = {
    page: 2, title: "两项指标", layout: "kpi",
    metrics: [{ label: "覆盖", value: "92%" }, { label: "周转", value: "3 天" }],
  };
  const blue = texts(render(content, "blue")).find(element => element.id === "kpi-value-0")!.style!.fontSize!;
  const magazine = texts(render(content, "magazine")).find(element => element.id === "kpi-value-0")!.style!.fontSize!;
  expect(magazine).toBeGreaterThan(blue);
});

it("L08：每个职责都能给出候选版式，且首选仍在候选内", () => {
  for (const role of PAGE_ROLES) {
    const layouts = preferredLayouts(role);
    expect(layouts.length).toBeGreaterThanOrEqual(1);
    expect(new Set(layouts).size).toBe(layouts.length);
  }
  // 新增版式被真实分配出去，而不是只存在于枚举里
  expect(preferredLayouts("evidence")).toContain("kpi");
  expect(preferredLayouts("process")).toContain("timeline");
  expect(preferredLayouts("section")).toContain("quote");
});

it("L09：两栏对比与两栏卡片不能长得一样（几何签名必须可区分）", () => {
  const groups = [{ title: "自建", items: ["投入高", "周期长"] }, { title: "外包", items: ["上线快", "依赖服务商"] }];
  const comparison = render({ page: 2, title: "两种方案", layout: "comparison", groups });
  const cards = render({ page: 2, title: "两种方案", layout: "cards", groups });
  expect((comparison.elements ?? []).map(element => element.id)).toContain("comparison-divider");
  expect((cards.elements ?? []).map(element => element.id)).not.toContain("comparison-divider");
  // 元素几何集合不同，才不会被判成「换名不换布局」
  const boxes = (slide: { elements?: PresentationElement[] }) =>
    (slide.elements ?? []).map(element => "w" in element ? `${Number(element.x).toFixed(2)},${Number(element.w).toFixed(2)}` : element.id).sort().join("|");
  expect(boxes(comparison)).not.toBe(boxes(cards));
});
