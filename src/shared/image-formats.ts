import { z } from "zod";

/**
 * 图片输出格式的唯一来源。以前枚举散在 5 个文件里，加一个格式要挨个改，
 * 漏一处就会出现「UI 能选、zod 拒收」或「重试时丢字段」。
 */
export const IMAGE_OUTPUT_FORMATS = ["png", "jpeg", "webp", "gif", "svg"] as const;
export type ImageOutputFormat = (typeof IMAGE_OUTPUT_FORMATS)[number];
export const imageOutputFormatSchema = z.enum(IMAGE_OUTPUT_FORMATS);

/** GIF 默认 9 帧 × 200ms = 1.8s 循环（约 5fps），与上游默认一致。 */
export const DEFAULT_FRAME_COUNT = 9;
export const DEFAULT_FRAME_DURATION_MS = 200;
export const MIN_FRAME_COUNT = 1;
export const MAX_FRAME_COUNT = 24;
export const MIN_FRAME_DURATION_MS = 40;
export const MAX_FRAME_DURATION_MS = 2000;

/**
 * GIF 用 sprite sheet 拼帧：9 帧按 3×3 拼，768×768 得到 2304×2304（实测可用），
 * 1024×1024 得到 3072×3072（实测超像素预算被拒）。这是经验护栏，不是上游硬规格。
 */
export const GIF_SHEET_MAX_EDGE = 2304;

export function parseImageSize(size?: string): { width: number; height: number } | null {
  const match = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size?.trim() ?? "");
  if (!match) return null;
  const width = Number(match[1]), height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

export function gifSheetEdge(size: string | undefined, frameCount: number): number | null {
  const parsed = parseImageSize(size);
  if (!parsed) return null; // auto / 自定义未解析：不猜，交给上游
  const grid = Math.ceil(Math.sqrt(Math.max(1, frameCount)));
  return grid * Math.max(parsed.width, parsed.height);
}

export function gifSheetFits(size: string | undefined, frameCount: number): boolean {
  const edge = gifSheetEdge(size, frameCount);
  return edge === null || edge <= GIF_SHEET_MAX_EDGE;
}

/** 给 UI 与服务端共用的解释性提示；返回 undefined 表示没有问题。 */
export function gifBudgetMessage(size: string | undefined, frameCount: number): string | undefined {
  const edge = gifSheetEdge(size, frameCount);
  if (edge === null || edge <= GIF_SHEET_MAX_EDGE) return undefined;
  return `GIF 按 ${Math.ceil(Math.sqrt(Math.max(1, frameCount)))}×${Math.ceil(Math.sqrt(Math.max(1, frameCount)))} 拼帧会得到 ${edge}×${edge} 的 sprite sheet，超过像素预算；请把尺寸降到 768×768 以下或减少帧数。`;
}

/** 帧参数只在 GIF 输出时发，避免其它格式被上游当成未知字段。 */
export function frameParameters(outputFormat: string | undefined, frameCount?: number, frameDurationMs?: number) {
  if (outputFormat !== "gif") return {};
  return {
    frame_count: frameCount ?? DEFAULT_FRAME_COUNT,
    frame_duration_ms: frameDurationMs ?? DEFAULT_FRAME_DURATION_MS,
  };
}
