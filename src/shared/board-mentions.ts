import type { BoardNode } from "./board.js";

export function boardMentionLabel(node: Pick<BoardNode, "type" | "ref">) {
  const kind = node.type === "image" ? "图片" : node.type === "video" ? "视频" : node.type === "audio" ? "音频" : undefined;
  return kind ? `${kind}${node.ref.slice(1)}` : undefined;
}

/** 节点编号稳定；提交时再换成素材在这次请求中的同类序号。 */
export function resolveBoardMentions(prompt: string, orderedSources: readonly BoardNode[], includeAt = true) {
  if (!prompt.includes("@")) return prompt;
  const positions = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const source of orderedSources) {
    const label = boardMentionLabel(source);
    if (!label) continue;
    const kind = label.slice(0, 2);
    const index = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, index);
    positions.set(label, `${includeAt ? "@" : ""}${kind}${index}`);
  }
  return prompt.replace(/@(图片|视频|音频)\d+/g, (token) => positions.get(token.slice(1)) ?? token);
}

export function removeBoardMention(prompt: string, source: Pick<BoardNode, "type" | "ref">) {
  const label = boardMentionLabel(source);
  if (!label) return prompt;
  return prompt.replace(/@(图片|视频|音频)\d+ ?/g, (token) => token.trimEnd() === `@${label}` ? "" : token);
}
