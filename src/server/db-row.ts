export type DbRow = Record<string, string | number | null>;

export function now() {
  return new Date().toISOString();
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function stringArrayFromJson(value: unknown): string[] {
  if (value == null) return [];
  try {
    const parsed = JSON.parse(String(value)) as unknown;
    return Array.isArray(parsed) ? [...new Set(parsed.filter((item): item is string => typeof item === "string" && Boolean(item)))] : [];
  } catch {
    return [];
  }
}

/**
 * 画布列 → `string[]`。这一列有三种"不是正常数组"的可能：NULL（加列之前就存在、又没被回填到的老行）、
 * 坏 JSON、以及被人手工改成别的形状。三种都当成**空画布**——一行坏数据不该让会话列表或大脑上下文炸掉。
 */
export function canvasIdsFromRow(value: unknown): string[] {
  const parsed = parseJson<unknown>(value, []);
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
}
