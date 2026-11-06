import { z } from "zod";
import type { BrainMessage, BrainResult } from "./brain.js";

export type StructuredWorkflowCall = (
  messages: BrainMessage[], schema?: Record<string, unknown>, options?: { maxTokens?: number },
) => Promise<Pick<BrainResult, "content" | "truncated">>;

export function cleanStructuredText(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

/** Accept only an explicit provider output cap, separate from a context-window error. */
export function readProviderOutputCap(message: string, requested: number): number | undefined {
  const match = /(?:max_tokens|max_completion_tokens|输出\s*tokens?).{0,65}?(?:<=|less than or equal to|at most|maximum(?: is| of)?|must not exceed|不能超过|上限(?:为)?)\s*([\d,]+)/i.exec(message)
    ?? /maximum(?: supported)? output (?:tokens?|length)(?: is| of|:)?\s*([\d,]+)/i.exec(message);
  const cap = Number(match?.[1]?.replace(/,/g, ""));
  return Number.isSafeInteger(cap) && cap > 0 && cap < requested ? cap : undefined;
}

/** Repair syntax only outside quoted strings so punctuation in the source survives. */
function parseCandidate(text: string): unknown {
  try { return JSON.parse(text); } catch {
    const repaired = text.replace(
      /"(?:\\[\s\S]|[^"\\])*"|,\s*(?=[}\]])|([{,]\s*)([A-Za-z_$][\w$-]*)(?=\s*:)/g,
      (token, prefix?: string, key?: string) => prefix ? `${prefix}"${key}"` : token.startsWith('"') ? token : "",
    );
    return JSON.parse(repaired);
  }
}

function balancedEnd(input: string, start: number): number | undefined {
  const stack: string[] = [];
  let quoted = false, escaped = false;
  for (let i = start; i < input.length; i++) {
    const char = input[i]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return undefined;
      if (!stack.length) return i + 1;
    }
  }
  return undefined;
}

export function decodeWorkflowJson(text: string, accept: (value: unknown) => boolean = () => true): unknown {
  const input = cleanStructuredText(text);
  const read = (candidate: string) => {
    try { const value = parseCandidate(candidate); return accept(value) ? { value } : undefined; }
    catch { return undefined; }
  };
  const direct = read(input);
  if (direct) return direct.value;
  for (let i = 0, probes = 0; i < input.length && probes < 32; i++) {
    if (input[i] !== "{" && input[i] !== "[") continue;
    if (++probes === 1 && i === 0) {
      const end = balancedEnd(input, i);
      if (!end) break;
      if (end === input.length) break;
    }
    const end = balancedEnd(input, i);
    if (!end) continue;
    const found = read(input.slice(i, end));
    if (found) return found.value;
    i = end - 1;
  }
  throw new Error("模型返回的内容不是预期的 JSON");
}

/** Only return complete top-level objects from a truncated, single-property array response. */
export function recoverWorkflowItems(text: string, field: string): unknown[] {
  const input = cleanStructuredText(text);
  if (!/^\w+$/.test(field)) return [];
  const prefix = new RegExp(`\\{\\s*(?:"${field}"|${field})\\s*:\\s*\\[`).exec(input);
  if (!prefix) return [];
  const items: unknown[] = [];
  for (let i = prefix.index + prefix[0].length; i < input.length;) {
    while (i < input.length && /[\s,]/.test(input[i]!)) i++;
    if (input[i] !== "{") break;
    const end = balancedEnd(input, i);
    if (!end) break;
    try { items.push(parseCandidate(input.slice(i, end))); } catch { /* The caller can retry this item. */ }
    i = end;
  }
  return items;
}

export async function requestWorkflowObject<T>(
  call: StructuredWorkflowCall, messages: BrainMessage[], schema: z.ZodType<T>,
  accept: (value: T) => boolean = () => true,
): Promise<T | undefined> {
  const shape = z.toJSONSchema(schema);
  let maxTokens = 8192;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await call(attempt ? [...messages, { role: "user", content: "上次返回不完整或不符合结构。请只提交一个完整对象，包含全部必填字段和指定编号。" }] : messages, shape, { maxTokens });
    try {
      return schema.parse(decodeWorkflowJson(result.content, value => {
        const parsed = schema.safeParse(value);
        return parsed.success && accept(parsed.data);
      }));
    } catch { if (result.truncated) maxTokens = 16_384; }
  }
  return undefined;
}
