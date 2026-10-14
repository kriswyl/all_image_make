/**
 * 参数核对结果（需求.md 问题 1）。
 *
 * 三种状态各有说法：真的发出去了 / 我们替你补的默认值 / 你写了但没发出去。
 * 用户抱怨的正是「我提示了尺寸，但请求体里到底带没带，我完全看不出来」，
 * 所以这三行必须摆在**正面**，不能只躺在「查看诊断」的原始 JSON 里。
 *
 * Agent 的工具卡片和生图工作台的结果面板用的是同一个组件、同一套样式
 * （`.tool-param`），免得同一个结论在两处长得不一样。
 */
import type { ParamNote } from "../shared/agent-types";

export function ParamChips({ notes }: { notes: ParamNote[] }) {
  return (
    <div className="tool-card-params">
      {notes.map((note) => (
        <span
          key={`${note.status}-${note.label}`}
          className={`tool-param is-${note.status}`}
          title={note.hint ?? ""}
        >
          {note.label} <b>{note.value}</b>
          {note.status === "defaulted" ? "（默认）" : note.status === "dropped" ? "（未发出）" : ""}
        </span>
      ))}
    </div>
  );
}
