import type { ToolResult } from "../shared/agent-types.js";
import type { ToolOutcome } from "./agent-tools.js";
import type { BrainContentPart } from "./brain.js";
import type { NativeMediaConfirmation } from "./chat-tools/native-image.js";

export function nativeBatchCheckpoint(state: NativeMediaConfirmation, results: ToolOutcome[]): string {
  const callIds = state.callIds ?? [state.callId];
  const toolMessages = [...new Set(callIds)].map(id => {
    const batch = results.filter((_, index) => callIds[index] === id).map(item => item.result);
    const assetIds = batch.flatMap(result => result.assetIds ?? (result.assetId ? [result.assetId] : []));
    return { role: "tool" as const, tool_call_id: id,
      content: JSON.stringify({ ok: batch.every(result => result.ok), summary: batch.map(result => result.summary).join("\n"), assetIds,
        ...(assetIds.length ? { hint: "如需判断画面是否符合要求，请先调用 view_images 查看这些图片，再描述效果。" } : {}) }) };
  });
  return JSON.stringify({ ...state.checkpoint, messages: [...state.checkpoint.messages, ...toolMessages,
    ...(state.imageContext ? [{ role: "user", content: state.imageContext }] : [])] });
}

export function nativeMediaCheckpoint(state: NativeMediaConfirmation, result: ToolResult, generatedImage?: BrainContentPart[]): string {
  const ids = result.assetIds ?? (result.assetId ? [result.assetId] : []);
  const checkpoint = {
    ...state.checkpoint, messages: [...state.checkpoint.messages, {
      role: "tool" as const, tool_call_id: state.callId,
      content: JSON.stringify({ ok: result.ok, summary: result.summary, assetIds: ids,
        ...(ids.length ? { hint: "如需判断画面是否符合要求，请先调用 view_images 查看这些图片，再描述效果。" } : {}) }),
    }, ...(state.imageContext ? [{ role: "user", content: state.imageContext }] : []),
    ...(generatedImage?.length ? [{ role: "user" as const, content: generatedImage }] : [])],
  };
  return JSON.stringify(checkpoint);
}
