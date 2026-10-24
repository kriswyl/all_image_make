/**
 * Midjourney 的模型名、按钮和任务动作。
 *
 * 提交用 mj_imagine / mj_edits；放大、变体、重绘是对已有任务的后续动作，
 * 不能当成普通生图模型出现在模型下拉里，否则用户会选到一个必须先有任务的模型。
 */

export const MIDJOURNEY_SUBMIT_MODELS = ["mj_imagine", "mj_edits"] as const;
export const MIDJOURNEY_ACTION_MODELS = ["mj_upscale", "mj_variation", "mj_reroll"] as const;
export const MIDJOURNEY_MODELS = [
  ...MIDJOURNEY_SUBMIT_MODELS,
  ...MIDJOURNEY_ACTION_MODELS,
] as const;

export type MidjourneySubmitModel = (typeof MIDJOURNEY_SUBMIT_MODELS)[number];
export type MidjourneyActionModel = (typeof MIDJOURNEY_ACTION_MODELS)[number];
export type MidjourneyModel = (typeof MIDJOURNEY_MODELS)[number];

export function isMidjourneyActionModel(model: string): model is MidjourneyActionModel {
  return (MIDJOURNEY_ACTION_MODELS as readonly string[]).includes(model);
}

export interface MidjourneyButton {
  customId: string;
  label?: string;
  emoji?: string;
  type?: number;
  style?: number;
}

export interface MidjourneyMeta {
  action?: string;
  promptEn?: string;
  description?: string;
  buttons?: MidjourneyButton[];
}

export type MidjourneyActionKind = "upscale" | "variation" | "reroll";

/**
 * 判断一个按钮能不能直接通过 `/mj/submit/action` 执行。
 *
 * 只放行放大/变体/重绘：区域变体、自定义缩放、平移、动画需要额外的
 * modal 参数或视频链路，硬显示出来只会让用户点了报错。
 * 同时把英文标签翻成中文，按钮区不再出现 Upscale (Subtle) 这种半截英文。
 */
export function midjourneyActionKind(customId: string, label?: string): MidjourneyActionKind | null {
  const text = `${customId} ${label ?? ""}`.toLowerCase();
  if (/region|inpaint|modal|zoom|pan|animate|custom\s*zoom/.test(text)) return null;
  if (/upsample|upscale/.test(text)) return "upscale";
  if (/variation/.test(text)) return "variation";
  if (/reroll/.test(text)) return "reroll";
  return null;
}

/** 从按钮的 customId 推断动作模型；认不出或需要额外输入的返回 null */
export function midjourneyModelForCustomId(customId: string, label?: string): MidjourneyActionModel | null {
  const kind = midjourneyActionKind(customId, label);
  if (kind === "upscale") return "mj_upscale";
  if (kind === "variation") return "mj_variation";
  if (kind === "reroll") return "mj_reroll";
  return null;
}

/** 只保留能直接执行的按钮 */
export function midjourneyUsableButtons(buttons: MidjourneyButton[]): MidjourneyButton[] {
  return buttons.filter((button) => midjourneyActionKind(button.customId, button.label) !== null);
}

/** 按钮文案全部中文；U1/V1 这种编号保留，方便对照 MJ 原界面 */
export function midjourneyButtonLabel(button: MidjourneyButton): string {
  const label = button.label?.trim() ?? "";
  const kind = midjourneyActionKind(button.customId, label);
  if (!kind) return label || "操作";
  if (kind === "reroll") return "重绘";
  if (kind === "upscale") {
    if (/subtle/i.test(label)) return "放大（细腻）";
    if (/creative|strong/i.test(label)) return "放大（创意）";
    return /^U\d/i.test(label) ? `放大 ${label}` : "放大";
  }
  if (/subtle/i.test(label)) return "变体（细微）";
  if (/strong/i.test(label)) return "变体（强烈）";
  return /^V\d/i.test(label) ? `变体 ${label}` : "变体";
}

/**
 * 四宫格象限：1=左上 2=右上 3=左下 4=右下。
 *
 * MJ 一次出四张拼成一张，`U1`/`V1` 指的就是这四个位置。按钮排成同样的 2×2，
 * 用户不用再换算「U3 到底是第几张」。
 */
export const MIDJOURNEY_QUADRANT_NAMES = ["左上", "右上", "左下", "右下"] as const;

export function midjourneyQuadrant(button: MidjourneyButton): number | null {
  const fromLabel = /^[UV]\s*([1-4])\b/i.exec(button.label?.trim() ?? "");
  if (fromLabel) return Number(fromLabel[1]);
  // 部分渠道的 label 只有 Upscale，但 customId 里仍带象限号：MJ::JOB::upsample::3::hash
  const fromId = /::([1-4])::/.exec(button.customId);
  return fromId ? Number(fromId[1]) : null;
}

export interface MidjourneyButtonGroups {
  /** 象限 → 该象限的放大/变体按钮；缺哪张就缺哪个键 */
  quadrants: Map<number, { upscale?: MidjourneyButton; variation?: MidjourneyButton }>;
  /** 重绘等没有象限归属的按钮 */
  extras: MidjourneyButton[];
}

export function groupMidjourneyButtons(buttons: MidjourneyButton[]): MidjourneyButtonGroups {
  const quadrants: MidjourneyButtonGroups["quadrants"] = new Map();
  const extras: MidjourneyButton[] = [];
  for (const button of buttons) {
    const kind = midjourneyActionKind(button.customId, button.label);
    const index = kind === "reroll" ? null : midjourneyQuadrant(button);
    if (!kind || !index) {
      extras.push(button);
      continue;
    }
    const cell = quadrants.get(index) ?? {};
    // 同一象限出现第二个同类按钮（比如细化版 / 创意版放大）时不要覆盖丢掉，挪到额外一行
    if (kind === "upscale" && !cell.upscale) cell.upscale = button;
    else if (kind === "variation" && !cell.variation) cell.variation = button;
    else {
      extras.push(button);
      continue;
    }
    quadrants.set(index, cell);
  }
  return { quadrants, extras };
}

export function midjourneyActionTooltip(button: MidjourneyButton): string {
  const label = midjourneyButtonLabel(button);
  const kind = midjourneyActionKind(button.customId, button.label);
  const index = midjourneyQuadrant(button);
  if (!index || !kind) {
    return kind === "reroll" ? "重新生成一组四宫格" : `用 Midjourney 继续：${label}`;
  }
  const position = MIDJOURNEY_QUADRANT_NAMES[index - 1];
  return kind === "upscale"
    ? `放大第 ${index} 张（四宫格${position}）`
    : `以第 ${index} 张生成变体（四宫格${position}）`;
}
