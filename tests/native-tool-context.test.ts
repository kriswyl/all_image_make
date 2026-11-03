import { expect, it } from "vitest";
import type { BrainMessage } from "../src/server/brain";
import { compactNativeToolReads } from "../src/server/chat-tools/context";

it("长会话回收较早的分页读取，保留调用配对和可重新读取的位置", () => {
  const messages: BrainMessage[] = [];
  for (let i = 0; i < 4; i++) {
    messages.push({ role: "assistant", content: null, tool_calls: [{ id: `call${i}`, type: "function", function: { name: "doc_read", arguments: JSON.stringify({ fileId: "file-1", offset: i * 100 }) } }] });
    messages.push({ role: "tool", tool_call_id: `call${i}`, content: "原文".repeat(10000) });
  }
  const compact = compactNativeToolReads(messages, 50_000);
  expect(compact[1]).toMatchObject({ role: "tool", tool_call_id: "call0" });
  expect((compact[1] as any).content).toContain("fileId=file-1，offset=0");
  expect((compact[7] as any).content).toBe("原文".repeat(10000));
  expect((messages[1] as any).content).toBe("原文".repeat(10000));
});
