import type { BrainMessage } from "../brain.js";

/** Evict older paginated reads without breaking native tool-call/result pairing. */
export function compactNativeToolReads(messages: BrainMessage[], maxReadChars = 60_000): BrainMessage[] {
  const calls = new Map<string, { fileId: string; offset: number; charOffset?: number }>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.tool_calls) continue;
    for (const call of message.tool_calls) {
      if (call.function.name !== "doc_read") continue;
      try {
        const args = JSON.parse(call.function.arguments) as { fileId?: unknown; offset?: unknown; charOffset?: unknown };
        if (typeof args.fileId === "string") calls.set(call.id, { fileId: args.fileId, offset: typeof args.offset === "number" ? args.offset : 0, ...(typeof args.charOffset === "number" ? { charOffset: args.charOffset } : {}) });
      } catch { /* Invalid calls are not eligible. */ }
    }
  }
  const reads = messages.map((message, index) => ({ message, index })).filter((item): item is { message: Extract<BrainMessage, { role: "tool" }>; index: number } => item.message.role === "tool" && calls.has(item.message.tool_call_id));
  let total = reads.reduce((sum, item) => sum + item.message.content.length, 0);
  if (total <= maxReadChars) return messages;
  const result = [...messages];
  for (const { message, index } of reads.slice(0, -2)) {
    if (total <= maxReadChars) break;
    const ref = calls.get(message.tool_call_id)!;
    const position = ref.charOffset === undefined ? `offset=${ref.offset}` : `charOffset=${ref.charOffset}`;
    const replacement = `[较早的文件读取结果已从上下文移出；如需原文，调用 doc_read，fileId=${ref.fileId}，${position}。]`;
    if (replacement.length >= message.content.length) continue;
    total -= message.content.length - replacement.length;
    result[index] = { ...message, content: replacement };
  }
  return result;
}
