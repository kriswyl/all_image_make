import { expect, it } from "vitest";
import {
  DEFAULT_THEME_ID, THEMES, getTheme, resolveThemeId, themeFromText,
} from "../src/shared/presentation-theme";
import { renderContentSlide, renderTemplateCover, type SlideContent } from "../src/server/presentation-templates";
import type { PresentationElement } from "../src/server/presentation-elements";

const content = (overrides: Partial<SlideContent> = {}): SlideContent => ({
  page: 3, title: "渠道试点的三条经验", takeaway: "先小步验证再放量",
  layout: "bullets", bullets: ["门店改造覆盖 12 家", "渠道试点的转化提升 8%", "供应链周转缩短 3 天"], ...overrides,
});

const texts = (slide: { elements?: PresentationElement[] }) =>
  (slide.elements ?? []).filter((element): element is Extract<PresentationElement, { type: "text" }> => element.type === "text");

const byId = (slide: { elements?: PresentationElement[] }, id: string) =>
  (slide.elements ?? []).find(element => element.id === id) as Extract<PresentationElement, { type: "text" }> | undefined;

it("D20：内置主题互不相同，且都通过主题解析取到", () => {
  expect(THEMES.length).toBeGreaterThanOrEqual(4);
  expect(new Set(THEMES.map(theme => theme.id)).size).toBe(THEMES.length);
  for (const theme of THEMES) expect(getTheme(theme.id).id).toBe(theme.id);
  expect(getTheme("不存在的主题").id).toBe(DEFAULT_THEME_ID);
  expect(getTheme(undefined).id).toBe(DEFAULT_THEME_ID);
});

it("D21：风格描述能映射到主题，匹配不到不硬猜", () => {
  expect(themeFromText("换成杂志风")).toBe("magazine");
  expect(themeFromText("极简一点，黑白就行")).toBe("mono");
  expect(themeFromText("课堂教学用，暖色")).toBe("warm");
  expect(themeFromText("商务汇报")).toBe("blue");
  expect(themeFromText("随便来点感觉")).toBeUndefined();
  expect(resolveThemeId("magazine")).toBe("magazine");
  expect(resolveThemeId("想要杂志风")).toBe("magazine");
  expect(resolveThemeId("随便来点感觉")).toBeUndefined();
});

it("D22：换主题会产生真实几何差异，不只是换颜色", () => {
  const blue = renderContentSlide(content(), {}, [], "", undefined, undefined, getTheme("blue")).slide;
  const magazine = renderContentSlide(content(), {}, [], "", undefined, undefined, getTheme("magazine")).slide;
  const mono = renderContentSlide(content(), {}, [], "", undefined, undefined, getTheme("mono")).slide;

  // 标题字号不同
  expect(byId(magazine, "title")!.style!.fontSize).toBeGreaterThan(byId(blue, "title")!.style!.fontSize!);
  expect(byId(mono, "title")!.style!.fontSize).toBeLessThan(byId(blue, "title")!.style!.fontSize!);
  // 左边界与内容宽度不同
  expect(byId(magazine, "title")!.x).not.toBe(byId(blue, "title")!.x);
  // 强调线的形状不同（杂志风是竖块，极简是通栏细线）
  const ruleOf = (slide: typeof blue) =>
    (slide.elements ?? []).find(element => element.id === "accent-rule") as { w: number; h: number };
  expect(ruleOf(magazine).h).toBeGreaterThan(ruleOf(blue).h);
  expect(ruleOf(mono).w).toBeGreaterThan(ruleOf(blue).w);
  // 版心宽度随之变化，正文不会越界
  expect(byId(magazine, "item-0")!.w).not.toBe(byId(blue, "item-0")!.w);
});

it("D23：面板形状与字体由主题决定，标题仍加粗", () => {
  const cards: SlideContent = {
    page: 2, title: "两种方案", layout: "comparison",
    groups: [{ title: "自建", items: ["投入高"] }, { title: "外包", items: ["上线快"] }],
  };
  const blue = renderContentSlide(cards, {}, [], "", undefined, undefined, getTheme("blue")).slide;
  const mono = renderContentSlide(cards, {}, [], "", undefined, undefined, getTheme("mono")).slide;
  const panelOf = (slide: typeof blue) => (slide.elements ?? []).find(element => element.id === "panel-0")! as { shape: string };
  expect(panelOf(blue).shape).toBe("roundRect");
  expect(panelOf(mono).shape).toBe("rect");
  expect(byId(mono, "title")!.style!.fontFace).toBe(getTheme("mono").typography.fontFace);
  expect(byId(mono, "title")!.style!.bold).toBe(true);
});

it("D24：用户显式 design 覆盖主题色，但不会丢失对比度兜底", () => {
  const slide = renderContentSlide(content(), { accent: "B23B2E", background: "101923" }, [], "", undefined, undefined, getTheme("magazine")).slide;
  const rule = (slide.elements ?? []).find(element => element.id === "accent-rule")! as { fill: string };
  expect(rule.fill).toBe("B23B2E");
  expect(slide.background).toBe("101923");
  // 深底上正文必须是浅色
  expect(byId(slide, "item-0")!.style!.color).toBe("FFFFFF");
});

it("D25：封面随主题变化，纯色封面仍保证文字可读", () => {
  const blue = renderTemplateCover("虚构运营培训", "掌握 18 个模块", {}, undefined, getTheme("blue"));
  const mono = renderTemplateCover("虚构运营培训", "掌握 18 个模块", {}, undefined, getTheme("mono"));
  const magazine = renderTemplateCover("虚构运营培训", "掌握 18 个模块", {}, undefined, getTheme("magazine"));
  expect(blue.background).toBe(getTheme("blue").colors.coverBackground);
  expect(mono.background).toBe(getTheme("mono").colors.coverBackground);
  expect(byId(magazine, "cover-title")!.style!.fontSize).toBeGreaterThan(byId(blue, "cover-title")!.style!.fontSize!);
  // 极简主题封面是白底，标题必须变成深色而不是白字
  expect(byId(mono, "cover-title")!.style!.color).not.toBe("FFFFFF");
});

it("D26：同一主题两次渲染完全一致（确定性坐标）", () => {
  const first = renderContentSlide(content(), {}, [], "", undefined, undefined, getTheme("warm")).slide;
  const second = renderContentSlide(content(), {}, [], "", undefined, undefined, getTheme("warm")).slide;
  expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  // 模型不参与坐标：所有元素坐标都来自令牌 + 内容长度
  expect(texts(first).every(element => Number.isFinite(element.x) && Number.isFinite(element.w))).toBe(true);
});
