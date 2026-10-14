/**
 * 消息行折叠（AGENT_PLAN.md §17）。
 *
 * 一次工具调用在库里是**两行**：assistant 的计划行（带 toolName/toolArgs）加 tool 的结果行。
 * 库这么存是为了回放给大脑时保持 role 语义——模型必须看见自己「请求过什么、拿到了什么」；
 * 但用户看到的应该是**一张卡**，所以在这里折回去。
 *
 * 单独成模块（而不是留在 ChatView.tsx 里）有两个理由：折叠规则本身值得单测，
 * 以及 ChatView 还要 export 组件，混着 export 纯函数会让 dev 的 Fast Refresh 失效。
 */
import type { ChatMessage, ConfirmPreview } from "../../shared/agent-types";

export type Row =
  | { kind: "user"; message: ChatMessage }
  | { kind: "assistant"; message: ChatMessage }
  | { kind: "note"; message: ChatMessage }
  | { kind: "confirm"; message: ChatMessage; preview: ConfirmPreview }
  | { kind: "tool"; message: ChatMessage; result: ChatMessage | null };

/**
 * 把持久化的行折成能渲染的行。
 *
 * 只跟「紧邻的下一条」配对：同一轮里两次 `generate_image` 也能各自配对（顺序由服务端保证）。
 * 已经被折走的结果行不再单独渲染；反过来，万一配对缺失（数据异常、工具行被单独写进来），
 * 工具行自己也要能显示出来，否则用户会觉得「它调了工具但什么都没发生」。
 */
export function buildRows(messages: ChatMessage[]): Row[] {
  const rows: Row[] = [];
  const folded = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "user") { rows.push({ kind: "user", message }); continue; }
    if (message.role === "system") { rows.push({ kind: "note", message }); continue; }
    if (message.role === "tool") {
      // 已经被上一张卡折走；没被折走就自己和自己配对，好歹显示出来
      if (!folded.has(message.id)) rows.push({ kind: "tool", message, result: message });
      continue;
    }
    if (message.confirm) { rows.push({ kind: "confirm", message, preview: message.confirm }); continue; }
    if (message.toolName) {
      const next = messages[index + 1];
      const paired = next && next.role === "tool" && !folded.has(next.id) ? next : null;
      if (paired) folded.add(paired.id);
      rows.push({ kind: "tool", message, result: paired });
      continue;
    }
    rows.push({ kind: "assistant", message });
  }
  return rows;
}
