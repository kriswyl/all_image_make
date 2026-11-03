import { z } from "zod";
import type { BrainMessage } from "../brain.js";
import type { ChatToolResult } from "./registry.js";

const toolCall = z.object({ id: z.string().min(1), type: z.literal("function"), function: z.object({ name: z.string().min(1), arguments: z.string() }) });
const contentPart = z.union([z.object({ type: z.literal("text"), text: z.string() }), z.object({ type: z.literal("image_url"), image_url: z.object({ url: z.string() }) })]);
const content = z.union([z.string(), z.array(contentPart)]);
const message = z.union([
  z.object({ role: z.enum(["system", "user"]), content }),
  z.object({ role: z.literal("assistant"), content: content.nullable(), tool_calls: z.array(toolCall).optional() }),
  z.object({ role: z.literal("tool"), content: z.string(), tool_call_id: z.string().min(1) }),
]);
const outcome = z.object({ ok: z.boolean(), summary: z.string(), data: z.record(z.string(), z.unknown()).optional(), uiData: z.record(z.string(), z.unknown()).optional() });
const schema = z.object({
  version: z.literal(3), channelId: z.string(), channelVersion: z.string(), model: z.string(), toolSignature: z.string(),
  messages: z.array(message).min(1), toolRounds: z.number().int().min(0), brainCalls: z.number().int().min(0), elapsedMs: z.number().int().min(0), usedTokens: z.number().int().min(0), usageMissing: z.boolean(),
  previousCalls: z.array(z.tuple([z.string(), outcome])),
});

export type NativeTurnCheckpoint = { version: 3; channelId: string; channelVersion: string; model: string; toolSignature: string; messages: BrainMessage[]; toolRounds: number; brainCalls: number; elapsedMs: number; usedTokens: number; usageMissing: boolean; previousCalls: Array<[string, ChatToolResult]> };
export function parseNativeTurnCheckpoint(raw: string | null): NativeTurnCheckpoint | null {
  if (!raw || raw.length > 2_000_000) return null;
  try { const parsed = schema.safeParse(JSON.parse(raw)); return parsed.success ? parsed.data as NativeTurnCheckpoint : null; }
  catch { return null; }
}
