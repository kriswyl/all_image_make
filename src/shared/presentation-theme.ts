/**
 * D2 主题令牌：把版式的颜色、字体、留白、装饰从渲染器里抽出来。
 *
 * 硬性边界：令牌只描述「长什么样」，不描述「放哪里算对」。
 * 坐标仍由确定性渲染器按令牌计算，模型永远不输出 x/y/w/h。
 */

export type ThemeColors = {
  background: string;
  /** 省略时按背景自动推导面板色，保持可读性下限 */
  panel?: string;
  /** 省略时按背景自动推导，保证对比度 */
  ink?: string;
  accent: string;
  muted: string;
  coverBackground: string;
  coverAccent: string;
};

export type ThemeTypography = {
  fontFace: string;
  coverTitle: number;
  title: number;
  titleMin: number;
  takeaway: number;
  takeawayMin: number;
  body: number;
  bodyMin: number;
  cardTitle: number;
  cardItem: number;
  small: number;
};

export type ThemeLayout = {
  marginX: number;
  contentWidth: number;
  ruleY: number;
  ruleWidth: number;
  ruleHeight: number;
  titleY: number;
  titleHeight: number;
  takeawayY: number;
  takeawayHeight: number;
  /** 无 takeaway 时正文起点 */
  bodyTop: number;
  /** 有 takeaway 时正文起点 */
  bodyTopWithTakeaway: number;
  bottom: number;
  gap: number;
  /** 单条 bullet 行高的上限，决定疏密 */
  rowCap: number;
  bulletX: number;
  bulletWidth: number;
  bulletWidthWithMedia: number;
  markerX: number;
  markerWidth: number;
  markerHeight: number;
  /** 卡片/对比/流程面板的圆角 */
  panelShape: "rect" | "roundRect";
  /** 图片列起点与宽度 */
  mediaX: number;
  mediaWidth: number;
};

export type ThemeCover = {
  ruleY: number;
  ruleWidth: number;
  ruleHeight: number;
  titleY: number;
  titleHeight: number;
  subtitleY: number;
  subtitleHeight: number;
};

export type ThemeTokens = {
  id: string;
  name: string;
  /** 面向用户的差异说明，会写进报告，便于核对「换了风格到底变了什么」 */
  description: string;
  colors: ThemeColors;
  typography: ThemeTypography;
  layout: ThemeLayout;
  cover: ThemeCover;
};

export const DEFAULT_THEME_ID = "blue";

/** 与改造前的硬编码几何一致，保证默认主题的输出不变。 */
const blue: ThemeTokens = {
  id: "blue",
  name: "商务蓝",
  description: "深蓝标题栏与细强调线，中性纸底，信息密度中等，适合培训与汇报",
  colors: {
    background: "F8FAFC", accent: "286D9C", muted: "64748B",
    coverBackground: "142A43", coverAccent: "6EA9C7",
  },
  typography: {
    fontFace: "Microsoft YaHei",
    coverTitle: 32, title: 32, titleMin: 20, takeaway: 19, takeawayMin: 15,
    body: 21, bodyMin: 15, cardTitle: 20, cardItem: 17, small: 13,
  },
  layout: {
    marginX: 0.76, contentWidth: 11.8, ruleY: 0.45, ruleWidth: 0.48, ruleHeight: 0.055,
    titleY: 0.62, titleHeight: 1.08, takeawayY: 1.76, takeawayHeight: 0.76,
    bodyTop: 2.05, bodyTopWithTakeaway: 2.78, bottom: 6.78, gap: 0.24, rowCap: 1.15,
    bulletX: 1.06, bulletWidth: 11.5, bulletWidthWithMedia: 5.13,
    markerX: 0.81, markerWidth: 0.12, markerHeight: 0.05,
    panelShape: "roundRect", mediaX: 6.58, mediaWidth: 5.98,
  },
  cover: { ruleY: 1.52, ruleWidth: 0.62, ruleHeight: 0.06, titleY: 1.78, titleHeight: 2.08, subtitleY: 4.12, subtitleHeight: 1.75 },
};

/** 杂志风：大标题、宽留白、竖条标记、直角面板 —— 几何真的不同，不只是换色。 */
const magazine: ThemeTokens = {
  id: "magazine",
  name: "杂志风",
  description: "大号衬线感标题、宽留白、竖条项目符号与直角图块，适合对外宣讲与品牌材料",
  colors: {
    background: "FFFDF8", panel: "F1EADF", ink: "1A1A1A", accent: "B23B2E", muted: "6B6259",
    coverBackground: "1A1A1A", coverAccent: "B23B2E",
  },
  typography: {
    fontFace: "Microsoft YaHei",
    coverTitle: 40, title: 38, titleMin: 24, takeaway: 20, takeawayMin: 16,
    body: 22, bodyMin: 16, cardTitle: 21, cardItem: 18, small: 12,
  },
  layout: {
    marginX: 0.62, contentWidth: 12.12, ruleY: 0.52, ruleWidth: 0.28, ruleHeight: 0.16,
    titleY: 0.78, titleHeight: 1.42, takeawayY: 2.22, takeawayHeight: 0.72,
    bodyTop: 2.5, bodyTopWithTakeaway: 3.06, bottom: 6.86, gap: 0.34, rowCap: 1.36,
    bulletX: 1.02, bulletWidth: 11.72, bulletWidthWithMedia: 5.6,
    markerX: 0.62, markerWidth: 0.09, markerHeight: 0.52,
    panelShape: "rect", mediaX: 6.72, mediaWidth: 6.02,
  },
  cover: { ruleY: 1.34, ruleWidth: 0.34, ruleHeight: 0.2, titleY: 1.62, titleHeight: 2.5, subtitleY: 4.28, subtitleHeight: 1.6 },
};

/** 极简黑白：细通栏分隔线、更小字号、灰度面板，靠排版而非色块。 */
const mono: ThemeTokens = {
  id: "mono",
  name: "极简黑白",
  description: "细通栏分隔线、灰阶面板、克制字号，靠排版层级而非色块，适合内部评审与文档型汇报",
  colors: {
    background: "FFFFFF", panel: "F2F2F2", ink: "111111", accent: "333333", muted: "787878",
    coverBackground: "FFFFFF", coverAccent: "111111",
  },
  typography: {
    fontFace: "Microsoft YaHei",
    coverTitle: 34, title: 28, titleMin: 18, takeaway: 17, takeawayMin: 14,
    body: 19, bodyMin: 14, cardTitle: 18, cardItem: 16, small: 12,
  },
  layout: {
    marginX: 0.9, contentWidth: 11.5, ruleY: 0.52, ruleWidth: 11.5, ruleHeight: 0.02,
    titleY: 0.72, titleHeight: 1.0, takeawayY: 1.76, takeawayHeight: 0.7,
    bodyTop: 2.1, bodyTopWithTakeaway: 2.72, bottom: 6.7, gap: 0.2, rowCap: 1.05,
    bulletX: 1.0, bulletWidth: 11.4, bulletWidthWithMedia: 5.0,
    markerX: 0.9, markerWidth: 0.1, markerHeight: 0.03,
    panelShape: "rect", mediaX: 6.3, mediaWidth: 6.1,
  },
  cover: { ruleY: 1.6, ruleWidth: 11.5, ruleHeight: 0.02, titleY: 1.84, titleHeight: 2.0, subtitleY: 4.0, subtitleHeight: 1.5 },
};

/** 暖色：米色纸底、大圆角卡片、赭色强调，适合教学与workshop。 */
const warm: ThemeTokens = {
  id: "warm",
  name: "暖色教学",
  description: "米色纸底、大圆角卡片与赭色强调，字距更松，适合课堂教学与工作坊",
  colors: {
    background: "FDF7F0", panel: "F6E8D8", ink: "3B2A20", accent: "C2683A", muted: "8A7467",
    coverBackground: "4A3226", coverAccent: "E0A16B",
  },
  typography: {
    fontFace: "Microsoft YaHei",
    coverTitle: 36, title: 34, titleMin: 21, takeaway: 19, takeawayMin: 15,
    body: 21, bodyMin: 15, cardTitle: 20, cardItem: 17, small: 13,
  },
  layout: {
    marginX: 0.82, contentWidth: 11.72, ruleY: 0.5, ruleWidth: 0.62, ruleHeight: 0.09,
    titleY: 0.7, titleHeight: 1.2, takeawayY: 1.96, takeawayHeight: 0.74,
    bodyTop: 2.26, bodyTopWithTakeaway: 2.92, bottom: 6.76, gap: 0.32, rowCap: 1.28,
    bulletX: 1.14, bulletWidth: 11.3, bulletWidthWithMedia: 5.2,
    markerX: 0.86, markerWidth: 0.16, markerHeight: 0.16,
    panelShape: "roundRect", mediaX: 6.62, mediaWidth: 5.92,
  },
  cover: { ruleY: 1.46, ruleWidth: 0.7, ruleHeight: 0.1, titleY: 1.72, titleHeight: 2.2, subtitleY: 4.18, subtitleHeight: 1.7 },
};

export const THEMES: ThemeTokens[] = [blue, magazine, mono, warm];
export const THEME_IDS = THEMES.map(theme => theme.id);

export function getTheme(id?: string): ThemeTokens {
  if (!id) return blue;
  const normalized = id.trim().toLowerCase();
  return THEMES.find(theme => theme.id === normalized) ?? blue;
}

/**
 * 用户/模型用自然语言表达风格时映射到内置主题。
 * 匹配不到就返回 undefined，由调用方决定是否沿用默认主题，
 * 而不是硬猜一个「最像」的。
 */
const STYLE_KEYWORDS: Array<{ id: string; pattern: RegExp }> = [
  { id: "magazine", pattern: /杂志|画册|品牌|宣讲|海报|editorial|magazine/i },
  { id: "mono", pattern: /黑白|极简|简约|灰度|朴素|mono|minimal/i },
  { id: "warm", pattern: /暖|教学|课堂|工作坊|亲和|活泼|warm/i },
  { id: "blue", pattern: /商务|专业|正式|汇报|培训|蓝|blue|business/i },
];

export function themeFromText(text?: string): string | undefined {
  if (!text) return undefined;
  for (const { id, pattern } of STYLE_KEYWORDS) if (pattern.test(text)) return id;
  return undefined;
}

/** 模型可以直接传主题 id，也可以传一句风格描述；两者都接受。 */
export function resolveThemeId(style?: string): string | undefined {
  if (!style) return undefined;
  const direct = style.trim().toLowerCase();
  if (THEME_IDS.includes(direct)) return direct;
  return themeFromText(style);
}
