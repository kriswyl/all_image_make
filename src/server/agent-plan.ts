/**
 * Agent 的计划解析：把大脑输出的一段文本变成可执行的 `AgentPlan`。
 *
 * 这里只放纯函数，不碰数据库、不发请求。`agent.ts` 只负责编排；
 * 解析的宽容策略（去代码块、剥自然语言、缝被截断的 JSON）全在这一个文件里。
 */
import {
  AGENT_TOOL_NAMES,
  IMAGE_PRODUCING_TOOLS,
  MAX_BATCH_CALLS,
  type AgentPlan,
  type AgentToolName,
  type PlannedCall,
} from "../shared/agent-types.js";
import { parseLooseJson, repairTruncatedObject, sliceFirstObject } from "./agent-tools.js";

/** 把模型输出里那一个 JSON 对象挖出来，挖不到返回 null（调用方决定重试还是报错） */
export function parsePlan(text: string): AgentPlan | null {
  return normalizePlan(parseLooseJson(text));
}

export function normalizePlan(value: unknown): AgentPlan | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let record = value as Record<string, unknown>;
  // 有的模型会多包一层 {"plan": {...}} / {"action": {...}}
  for (const key of ["plan", "action", "output", "result"]) {
    const nested = record[key];
    if (nested && typeof nested === "object" && !Array.isArray(nested) && ("tool" in nested || "calls" in nested)) {
      record = nested as Record<string, unknown>;
      break;
    }
  }
  // 批量形式：`{"calls":[…]}`。只留下工具名认得出的那些，
  // 坏的那几个丢掉而不是整份作废——认得出的一半就是能画的
  const calls = normalizeCalls(record.calls);
  const tool = calls.length ? calls[0].tool : typeof record.tool === "string" ? record.tool.trim() : "";
  if (!(AGENT_TOOL_NAMES as readonly string[]).includes(tool)) return null;
  const rawArgs = record.args ?? record.arguments ?? record.parameters;
  const args = calls.length
    ? calls[0].args
    : rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
  const say = typeof record.say === "string" ? record.say
    : typeof record.message === "string" ? record.message
      : typeof record.reply === "string" ? record.reply : undefined;
  const consistency = normalizeConsistency(record.consistency ?? record.consistent);
  return {
    tool: tool as AgentToolName, args,
    ...(say ? { say } : {}),
    // 只有真的多个才写上去：单调用时保持和老记录一模一样的形状
    ...(calls.length > 1 ? { calls } : {}),
    // 单张没有「一致性」可言，丢掉而不是落进库
    ...(calls.length > 1 && consistency ? { consistency } : {}),
  };
}

/**
 * 一致性标记的宽容解析。
 *
 * 提示词里只教了 `"character"` / `"style"` 两个词，但模型偶尔会写成
 * `true`、`"same-character"`、`"same_style"` 这类变体——认得出的就收下，
 * 认不出的当成没写（退回普通并行），不要因为这一个小字段让整份计划作废。
 */
export function normalizeConsistency(value: unknown): AgentPlan["consistency"] | undefined {
  if (value === true) return "character";
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (normalized === "character" || normalized === "same-character" || normalized === "person") return "character";
  if (normalized === "style" || normalized === "same-style" || normalized === "art-style") return "style";
  return undefined;
}

/**
 * 把 `calls` 洗成能执行的调用列表。
 *
 * 表里那几条**不合法就丢掉**，不整个作废：大脑写了 4 张图、其中一条忘写 prompt，
 * 用户要的仍然是那 3 张画得出来的——把 4 条一起拒掉只会白烧一轮大脑。
 */
export function normalizeCalls(raw: unknown): PlannedCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: PlannedCall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const tool = typeof entry.tool === "string" ? entry.tool.trim() : "";
    if (!(AGENT_TOOL_NAMES as readonly string[]).includes(tool)) continue;
    const rawArgs = entry.args ?? entry.arguments ?? entry.parameters;
    const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
    calls.push({ tool: tool as AgentToolName, args });
  }
  return calls;
}

/** 能并行的工具：**只有**产图那两个。视频/音乐一次一个，其余工具没有并行的意义 */
export const BATCHABLE_TOOLS: AgentToolName[] = IMAGE_PRODUCING_TOOLS;

/**
 * 「这一批到底跑哪几个」（需求.md 问题 2）。
 *
 * 两件事在这里定，而且是**确认闸门和执行器共用的同一份**——两边分开算的话，
 * 卡片上问的是 A、实际提交的是 B，正是最不该出的那种错。
 */
export function resolveBatch(calls: PlannedCall[]): { calls: PlannedCall[]; note: string } {
  if (calls.length <= 1) return { calls, note: "" };
  if (calls.some((call) => !BATCHABLE_TOOLS.includes(call.tool))) {
    return {
      calls: calls.slice(0, 1),
      note: "一次批量里只能放 generate_image / edit_image，本轮只执行了第一个。要生成视频、音乐或其他操作，请下一轮单独提交。",
    };
  }
  if (calls.length > MAX_BATCH_CALLS) {
    return {
      calls: calls.slice(0, MAX_BATCH_CALLS),
      note: `一次最多并行 ${MAX_BATCH_CALLS} 个，另外 ${calls.length - MAX_BATCH_CALLS} 个没有提交。`,
    };
  }
  return { calls, note: "" };
}

/** 从一段可能不全的 JSON 里尽力取出 plan，给「解析失败」的兜底路径用 */
export function salvagePlan(text: string): AgentPlan | null {
  const sliced = sliceFirstObject(text);
  if (!sliced) return null;
  try {
    return normalizePlan(JSON.parse(sliced) as unknown);
  } catch {
    return null;
  }
}

/**
 * 兜底的兜底：连平衡的 JSON 都找不到时，试试把被截断的那个缝起来。
 *
 * 单独一个函数是为了让 `salvagePlan`（只处理完整对象）和这个的差别一眼可见——
 * 缝出来的计划可能少个参数，调用方得知道这份结果更可疑。
 */
export function repairPlan(text: string): AgentPlan | null {
  const repaired = repairTruncatedObject(text);
  if (!repaired) return null;
  try {
    return normalizePlan(JSON.parse(repaired) as unknown);
  } catch {
    return null;
  }
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** 把第一个 JSON 对象剥掉，剩下的自然语言就是模型在 JSON 外面说的话 */
export function proseOutsidePlan(raw: string): string {
  let prose = raw;
  const json = sliceFirstObject(raw);
  if (json) {
    const index = raw.indexOf(json);
    if (index >= 0) prose = `${raw.slice(0, index)} ${raw.slice(index + json.length)}`;
  }
  return prose.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
}

/**
 * reply / ask 的正文。
 *
 * 先认 args 里的常见字段（各家模型对「文字」的叫法不一样），都没有时退回 JSON 外面的
 * 自然语言——有的模型会先把话说完，再补一个空的 `{"tool":"reply","args":{}}`，
 * 只读 args 的话用户那边就是一条空气泡（实测「你好」经常这样）。
 */
export function extractPlanText(plan: AgentPlan, raw: string): string {
  const args = plan.args ?? {};
  const direct = asString(args.text) ?? asString(args.reply) ?? asString(args.message)
    ?? asString(args.content) ?? asString(args.answer) ?? asString(args.response)
    ?? asString(args.question) ?? plan.say;
  if (direct) return direct.trim();
  return proseOutsidePlan(raw);
}
