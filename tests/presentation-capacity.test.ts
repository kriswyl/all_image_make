import { expect, it } from "vitest";
import {
  compressText, diagnoseSlots, fitChars, measureHeight, textUnits,
} from "../src/shared/presentation-capacity";
import { renderContentSlide, validSlideContent, type SlideContent } from "../src/server/presentation-templates";
import { getTheme } from "../src/shared/presentation-theme";
import type { TemplateReport } from "../src/shared/presentation-report";

const theme = getTheme("blue");
const long = (chars: number) => Array.from({ length: chars }, (_, index) => "资料证据第" + (index % 10) + "条").join("").slice(0, chars);

it("C01：度量口径自洽 —— 放得下就报 0 溢出，放不下时 fitChars 一定少于全长", () => {
  const rect = { w: 12.1, h: 1.2 };
  const short = "三个案例都指向同一结论";
  expect(measureHeight(short, 18, rect)).toBeLessThanOrEqual(rect.h + 0.06);
  expect(fitChars(short, 18, rect)).toBe(Array.from(short).length);

  const dense = long(400);
  expect(measureHeight(dense, 18, rect)).toBeGreaterThan(rect.h + 0.06);
  const budget = fitChars(dense, 18, rect);
  expect(budget).toBeGreaterThan(0);
  expect(budget).toBeLessThan(Array.from(dense).length);
  // 预算本身就是「能放下的最长前缀」，再多一个字就超
  expect(measureHeight(Array.from(dense).slice(0, budget).join(""), 18, rect)).toBeLessThanOrEqual(rect.h + 0.06);
});

it("C02：压缩优先断在分句处，并明确标记丢字", () => {
  const source = "第一阶段选点验证需求是否真实存在，第二阶段做小范围试点，第三阶段再全面推广到其他区域。";
  const budget = 20;
  const result = compressText(source, budget);
  expect(result.cut).toBe(true);
  expect(Array.from(result.text).length).toBeLessThanOrEqual(budget + 1);
  // 断在第一个分句之后，收尾的标点换成省略号，不留半句
  expect(result.text).toBe("第一阶段选点验证需求是否真实存在…");

  const fits = compressText("短句直接保留", 20);
  expect(fits).toEqual({ text: "短句直接保留", cut: false });
  expect(textUnits("中文") > textUnits("ab")).toBe(true);
});

it("C03：诊断区分「该压缩」与「该拆页」，条目过多时建议换排法", () => {
  const tight = { w: 5.2, h: 0.8 };
  const report = diagnoseSlots({
    slots: [{ id: "item-0", text: long(200), rect: tight, fontSize: 18, minFontSize: 14 }],
    containers: [{ id: "bullets", count: 6, rows: 1 }],
  });
  expect(report.ok).toBe(false);
  expect(report.issues.some(issue => issue.kind === "too_long")).toBe(true);
  expect(report.issues.some(issue => issue.remedy === "reflow")).toBe(true);
  // 只能留住不到一半时必须建议拆页，不能靠压缩硬塞
  const ruthless = diagnoseSlots({ slots: [{ id: "item-0", text: long(400), rect: { w: 3.2, h: 0.5 }, fontSize: 18, minFontSize: 14 }] });
  expect(ruthless.issues[0]!.remedy).toBe("split_page");
});

it("C04：条目少、纵向有余量时放宽行高（约束内重排），而不是先截断", () => {
  const content: SlideContent = {
    page: 4, title: "两条长证据", layout: "bullets",
    bullets: [long(300), long(300)],
  };
  expect(validSlideContent(content, [])).toBe(true);
  const rendered = renderContentSlide(content, {}, [], "", undefined, undefined, theme);
  const items = (rendered.slide.elements ?? []).filter(element => element.id.startsWith("item-")) as Array<{ y: number; h: number }>;
  expect(items.length).toBe(2);
  // 两行各占一半正文区，行高不再被 rowCap 卡在 1.15
  expect(items[1]!.y - items[0]!.y).toBeGreaterThan(theme.layout.rowCap + 0.1);
  expect(items[0]!.h).toBeGreaterThan(theme.layout.rowCap);
  expect(rendered.capacity.reflowed[0]).toMatchObject({ slot: "bullets", mode: "row_height" });
  expect(rendered.capacity.truncated).toEqual([]);
  expect(rendered.capacity.ok).toBe(true);
});

it("C05：压到最小字号仍放不下才截断，并且诊断与原文都要留证", () => {
  const content: SlideContent = {
    page: 5, title: "超长条目", layout: "bullets", bullets: [long(600), long(600), long(600)],
  };
  const rendered = renderContentSlide(content, {}, [], "", undefined, undefined, theme);
  expect(rendered.capacity.ok).toBe(false);
  expect(rendered.capacity.truncated).toContain("item-0");
  const issue = rendered.capacity.issues[0]!;
  expect(issue.kind === "font_floor" || issue.kind === "too_long").toBe(true);
  expect(issue.keepChars).toBeLessThan(600);
  // 丢字必须进备注，页面不能只剩半句话还显示成完整
  expect(rendered.slide.notes).toContain("页面补充");
  expect(rendered.overflow).toBe(true);
  // 报告字段可容纳这份诊断（结构校验，不靠“约定”）
  const report: TemplateReport = {
    draft: false, resume: false, fallbackPages: [], pendingPages: [], overflowPages: [5],
    sourceLimitedPages: [], notesLimitedPages: [], unplacedImages: 0, planningFallback: false,
    audit: "unavailable", issues: [],
    capacity: { truncatedPages: [5], reflowedPages: [], issues: [{ page: 5, detail: issue.detail.slice(0, 180) }] },
  };
  expect(report.capacity!.truncatedPages).toEqual([5]);
});
