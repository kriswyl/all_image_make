import { createHash } from "node:crypto";
import type { AppDatabase, DbChannel } from "./db.js";
import type { BrainResult, BrainToolSpec, CallBrainOptions } from "./brain.js";
import { RemoteApiError } from "./adapters.js";

import type { ProtocolFeature, ToolProtocol } from "../shared/tool-protocol.js";
export type { ProtocolFeature, ToolProtocol } from "../shared/tool-protocol.js";
type Settings = Pick<AppDatabase, "getSetting" | "setSetting">;
const key = (channel: DbChannel, model: string) => "tool-protocol:" + createHash("sha256").update(JSON.stringify([channel.id, channel.updatedAt, model])).digest("hex");

export function readToolProtocol(db: Settings, channel: DbChannel, model: string): ToolProtocol {
  try { return JSON.parse(db.getSetting(key(channel,model)) ?? "{}"); } catch { return {}; }
}
export function recordToolProtocol(db: Settings, channel: DbChannel, model: string, features: Partial<Record<ProtocolFeature, boolean>>, source: "observed" | "probe" = "observed") {
  const data = readToolProtocol(db,channel,model);
  for (const [feature, supported] of Object.entries(features)) data[feature as ProtocolFeature] = { supported, source, at: new Date().toISOString() };
  db.setSetting(key(channel,model), JSON.stringify(data));
  return data;
}
export function protocolErrorFeature(error: unknown): ProtocolFeature | undefined {
  if (!(error instanceof RemoteApiError) || ![400,422].includes(error.status)) return;
  const message = error.message;
  if (!/unsupported|not support|not allowed|unknown parameter|unrecognized|不支持|不允许/i.test(message)) return;
  if (/tool_choice/i.test(message)) return "toolChoice";
  if (/parallel_tool_calls|parallel.*tool/i.test(message)) return "parallel";
  if (/anyOf|oneOf|\$ref|nested.*schema/i.test(message)) return "nestedSchema";
  if (/tools|function.call/i.test(message)) return "tools";
}

/** Only decorative schema keys are removed. Required fields and validation constraints remain intact. */
export function projectToolSpecs(specs: BrainToolSpec[]): BrainToolSpec[] {
  const clean = (value: unknown): unknown => Array.isArray(value) ? value.map(clean) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).filter(([name]) => !["$schema", "default"].includes(name)).map(([name,item]) => [name,clean(item)])) : value;
  return specs.map(spec => ({ ...spec, function: { ...spec.function, parameters: clean(spec.function.parameters) as Record<string,unknown> } }));
}

/** Three bounded requests using synthetic data only. No returned call is ever executed. */
export async function probeToolProtocol(call: (options: Pick<CallBrainOptions,"messages"|"tools"|"toolChoice"|"maxTokens">) => Promise<BrainResult>) {
  const echo: BrainToolSpec = { type: "function", function: { name: "protocol_echo", description: "协议探测，只返回调用，不执行操作", parameters: {
    type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false,
  } } };
  const nested: BrainToolSpec = { type: "function", function: { name: "protocol_nested", description: "协议探测，提交嵌套对象", parameters: {
    type: "object", properties: { sample: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false } }, required: ["sample"], additionalProperties: false,
  } } };
  const results: Array<{ scenario: string; status: "passed"|"unverified"|"rejected"; calls: number; tokens: number|null; durationMs: number; feature?: ProtocolFeature }> = [];
  const features: Partial<Record<ProtocolFeature,boolean>> = {};
  const scenarios = [
    { name: "single", tool: echo, text: "调用 protocol_echo，value 填 synthetic-a。", forced: false, valid: (r: BrainResult) => r.toolCalls.length === 1 && r.toolCalls[0]?.name === "protocol_echo" && JSON.parse(r.toolCalls[0].arguments).value === "synthetic-a" },
    { name: "parallel", tool: echo, text: "在同一个响应中调用 protocol_echo 两次，value 分别是 synthetic-a 和 synthetic-b。", forced: false, valid: (r: BrainResult) => r.toolCalls.length === 2 && new Set(r.toolCalls.map(c => c.id)).size === 2 && r.toolCalls.every(c => c.name === "protocol_echo") && ["synthetic-a","synthetic-b"].every(v => r.toolCalls.some(c => JSON.parse(c.arguments).value === v)) },
    { name: "forced-nested", tool: nested, text: "调用 protocol_nested，sample.count 填 7。", forced: true, valid: (r: BrainResult) => r.toolCalls.length === 1 && r.toolCalls[0]?.name === "protocol_nested" && JSON.parse(r.toolCalls[0].arguments).sample?.count === 7 },
  ];
  for (const scenario of scenarios) {
    try {
      const r = await call({ messages: [{ role:"user", content:scenario.text }], tools:[scenario.tool], maxTokens:4096,
        ...(scenario.forced ? { toolChoice: { type:"function", function:{ name:scenario.tool.function.name } } as const } : {}) });
      let valid = false;
      try { valid = !r.truncated && r.toolProtocol !== "dsml" && scenario.valid(r); } catch { /* invalid arguments are unverified, never a successful probe */ }
      if (valid) {
        features.tools = true;
        if (scenario.name === "parallel") features.parallel = true;
        if (scenario.forced) { features.toolChoice = true; features.nestedSchema = true; }
      }
      if (!r.usedFallback && valid) features.streaming = true;
      results.push({ scenario:scenario.name, status:valid ? "passed":"unverified", calls:r.toolCalls.length,
        tokens:r.usage?.complete ? r.usage.promptTokens+r.usage.completionTokens:null, durationMs:r.durationMs });
    } catch (error) {
      const feature = protocolErrorFeature(error);
      if (!feature) throw error;
      features[feature] = false;
      results.push({ scenario:scenario.name,status:"rejected",calls:0,tokens:null,durationMs:0,feature });
      if (feature === "tools") break;
    }
  }
  return { features, results };
}
