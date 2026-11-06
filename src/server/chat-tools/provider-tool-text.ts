import { randomUUID } from "node:crypto";
import type { BrainToolCall, BrainToolSpec } from "../brain.js";

const bar = "[|｜]\\s*";
const marker = `<\\s*(?:${bar}){1,2}DSML\\s*(?:${bar}){1,2}`;
const markerPattern = new RegExp(marker, "i");
const partialMarker = /<\s*(?:[|｜]\s*){1,2}D(?:S(?:M(?:L)?)?)?\s*$/i;
const tag = new RegExp(`<\\s*(/?)\\s*(?:${bar}){1,2}DSML\\s*(?:${bar}){1,2}([a-z_]+)([^<>]*)>`, "gi");
const wrapper = new Set(["calls", "tool_calls", "function_calls"]);
const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function separateProviderToolText(content: string) {
  const markerStart = content.search(markerPattern);
  const start = markerStart < 0 ? content.search(partialMarker) : markerStart;
  return start < 0 ? { content, block: "" } : { content: content.slice(0, start).trimEnd(), block: content.slice(start) };
}

/** Some OpenAI-compatible gateways put DeepSeek's tool envelope in the content field. */
export function parseProviderToolText(block: string, tools: BrainToolSpec[]): BrainToolCall[] | undefined {
  if (!block) return undefined;
  const allowed = new Set(tools.map(tool => tool.function.name));
  const tags = [...block.matchAll(tag)];
  const calls: BrainToolCall[] = [];
  let cursor = 0, index = 0;
  function take(name: string, closing = false) {
    const token = tags[index];
    if (!token || token[2] !== name || Boolean(token[1]) !== closing || block.slice(cursor, token.index).trim()) return undefined;
    index++;
    cursor = token.index + token[0].length;
    return token[3]?.trim() ?? "";
  }
  const root = tags[0]?.[2];
  if (!root || !wrapper.has(root) || take(root) !== "") return undefined;
  while (tags[index]?.[2] === "invoke" && !tags[index]?.[1]) {
    const name = /^name\s*=\s*"([a-zA-Z0-9_-]+)"$/.exec(take("invoke") ?? "")?.[1];
    if (!name || !allowed.has(name) || calls.length >= 8) return undefined;
    const args: Record<string, unknown> = Object.create(null);
    while (tags[index]?.[2] === "parameter" && !tags[index]?.[1]) {
      const attrs = /^name\s*=\s*"([a-zA-Z0-9_-]+)"\s+string\s*=\s*"(true|false)"$/.exec(take("parameter") ?? "");
      const end = tags[index];
      if (!attrs || !end || Object.hasOwn(args, attrs[1]!)) return undefined;
      const value = block.slice(cursor, end.index);
      cursor = end.index;
      if (take("parameter", true) !== "") return undefined;
      try { args[attrs[1]!] = attrs[2] === "true" ? value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => entities[entity]!) : JSON.parse(value); }
      catch { return undefined; }
    }
    if (take("invoke", true) !== "") return undefined;
    calls.push({ id: `call_${randomUUID()}`, name, arguments: JSON.stringify(args) });
  }
  if (!calls.length || take(root, true) !== "" || index !== tags.length || block.slice(cursor).trim()) return undefined;
  return calls;
}

/** Keep a possible partial opening tag buffered across SSE chunks. */
export function providerToolTextStream(emit: (text: string) => void) {
  let pending = "", hidden = false;
  return {
    write(text: string) {
      if (hidden) return;
      pending += text;
      const start = pending.search(markerPattern);
      if (start >= 0) {
        if (start) emit(pending.slice(0, start));
        pending = "";
        hidden = true;
        return;
      }
      const tail = pending.lastIndexOf("<");
      const keep = tail >= 0 && pending.length - tail <= 80 ? tail : pending.length;
      if (keep) emit(pending.slice(0, keep));
      pending = pending.slice(keep);
    },
    finish() { if (!hidden && pending && !/^<\s*[|｜]/.test(pending)) emit(pending); },
  };
}
