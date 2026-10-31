/**
 * 提示词里「可以单独改的片段」。
 *
 * 我们自己拼进去的片段带固定前缀（`景别：中景` / `运镜：缓慢推近`），所以改一个维度时
 * 只需要替换那一段，主体、场景、台词、风格原样不动。用户手写的句子没有前缀，认不出来，
 * 也就不会被误改——这是这个机制只对自己拼的内容生效的原因，也是它的边界。
 */
export const CLAUSE_LABELS = ["景别", "运镜"] as const;
export type ClauseLabel = (typeof CLAUSE_LABELS)[number];

/** 片段可能出现在开头，也可能跟在某个分隔符后面 */
function clausePattern(label: ClauseLabel) {
  return new RegExp(`[，,；;、]?\\s*${label}\\s*[：:]\\s*[^，,；;、。\\n]*`, "g");
}

/** 读出某个维度的当前值；没有这个片段就返回 undefined */
export function readPromptClause(text: string, label: ClauseLabel): string | undefined {
  const match = new RegExp(`${label}\\s*[：:]\\s*([^，,；;、。\\n]*)`).exec(text ?? "");
  const value = match?.[1]?.trim();
  return value || undefined;
}

/** 提示词里出现过哪些维度 */
export function readPromptClauses(text: string): Partial<Record<ClauseLabel, string>> {
  const result: Partial<Record<ClauseLabel, string>> = {};
  for (const label of CLAUSE_LABELS) {
    const value = readPromptClause(text, label);
    if (value) result[label] = value;
  }
  return result;
}

/**
 * 替换某个维度。
 *
 * - 有值：原地替换（没有这个片段就补在末尾，分隔符跟着正文已有的风格走）
 * - 空值：把这段连同它前面的分隔符一起删掉
 */
export function replacePromptClause(text: string, label: ClauseLabel, value: string | undefined): string {
  const source = text ?? "";
  const next = value?.trim() ?? "";
  let matched = false;
  const output = source.replace(clausePattern(label), (match) => {
    matched = true;
    if (!next) return "";
    const lead = /^[，,；;、]/.test(match) ? match[0] : "";
    return `${lead}${label}：${next}`;
  });
  if (matched) return output.replace(/^[，,；;、\s]+/, "").replace(/\s{2,}/g, " ").trim();
  if (!next) return source.trim();

  const body = source.replace(/[，,；;、\s]+$/, "").trim();
  if (!body) return `${label}：${next}`;
  const separator = /[；;]/.test(body) ? "；" : "，";
  return `${body}${separator}${label}：${next}`;
}
