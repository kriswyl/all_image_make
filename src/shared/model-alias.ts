function loose(value: string) {
  return value.toLowerCase().replace(/[\s\-_.]/g, "");
}

/** 匹配顺序：原别名、忽略分隔符、旧版序号别名、别名或原厂型号子串。 */
export function matchModelAlias<T extends { alias: string; model: string }>(candidates: readonly T[], hint?: string | null) {
  const normalized = hint?.trim().toLowerCase();
  if (!normalized) return undefined;
  const looseHint = loose(normalized);
  return candidates.find((item) => item.alias === normalized)
    ?? candidates.find((item) => loose(item.alias) === looseHint)
    ?? candidates.find((item) => item.alias.replace(/-\d+$/, "") === normalized.replace(/-\d+$/, ""))
    ?? candidates.find((item) => loose(item.alias).includes(looseHint) || loose(item.model).includes(looseHint));
}
