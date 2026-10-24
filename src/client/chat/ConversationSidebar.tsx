import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Plus, Trash2 } from "lucide-react";
import { DEFAULT_CONVERSATION_TITLE, type ConversationSummary } from "../../shared/agent-types";

export type SidebarConversation = ConversationSummary & { running: boolean };

/**
 * 会话列表（portal 到 App 的全局侧栏）。
 *
 * 状态仍然由 ChatView 持有：列表和 SSE 长在一起，把状态整体上提的代价更大；
 * 这里只把渲染拆出来，ChatView 的主渲染不再被会话列表撑长。
 */
export function ConversationSidebar({
  host,
  conversations,
  activeId,
  renamingId,
  renameDraft,
  filter,
  onSelect,
  onCreate,
  onDelete,
  onContextMenu,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
}: {
  host: HTMLElement | null;
  conversations: SidebarConversation[];
  activeId: string | null;
  renamingId: string | null;
  renameDraft: string;
  filter: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onContextMenu: (event: React.MouseEvent, id: string) => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: (id: string) => void;
  onRenameCancel: () => void;
}) {
  const [tip, setTip] = useState<{ title: string; text: string; x: number; y: number } | null>(null);
  const tipTimer = useRef<number | null>(null);

  /**
   * 会话行原来用原生 title 显示最后一条消息，浏览器会弹一条又长又难看的白框。
   * 这里改成自绘深色提示：延迟和全局 tooltip 一致（700ms），跟着行右侧固定定位，最多 5 行。
   */
  function showTip(target: HTMLElement, item: SidebarConversation) {
    const text = item.lastMessage?.trim() ?? "";
    if (!text || text === item.title) return;
    if (tipTimer.current) window.clearTimeout(tipTimer.current);
    const rect = target.getBoundingClientRect();
    tipTimer.current = window.setTimeout(() => {
      const width = 320;
      setTip({
        title: item.title,
        text,
        x: Math.max(8, Math.min(rect.right + 10, window.innerWidth - width - 8)),
        y: Math.max(8, Math.min(rect.top - 4, window.innerHeight - 210)),
      });
    }, 700);
  }

  function hideTip() {
    if (tipTimer.current) window.clearTimeout(tipTimer.current);
    tipTimer.current = null;
    setTip(null);
  }

  useEffect(() => () => {
    if (tipTimer.current) window.clearTimeout(tipTimer.current);
  }, []);

  useEffect(() => {
    if (!tip) return;
    const hide = () => setTip(null);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [tip]);

  if (!host) return null;
  return (
    <>
      {createPortal(
        <div className="sidebar-group">
      <div className="sidebar-group-title">
        <span>最近</span>
        <button type="button" className="sidebar-group-add" aria-label="新建会话" data-tooltip="新建会话" onClick={onCreate}>
          <Plus size={13} />
        </button>
      </div>
      <div className="sidebar-conv-list">
        {conversations.length ? conversations.map((item) => (
          <div
            key={item.id}
            className={`sidebar-conv ${item.id === activeId ? "is-active" : ""} ${renamingId === item.id ? "is-renaming" : ""}`}
            onContextMenu={(event) => { hideTip(); onContextMenu(event, item.id); }}
          >
            {renamingId === item.id ? (
              <input
                className="sidebar-conv-rename"
                value={renameDraft}
                autoFocus
                maxLength={120}
                aria-label="会话名称"
                onChange={(event) => onRenameChange(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                onClick={(event) => event.stopPropagation()}
                onContextMenu={(event) => event.stopPropagation()}
                onBlur={() => onRenameCommit(item.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    onRenameCancel();
                    event.currentTarget.blur();
                  }
                }}
              />
            ) : (
              <button
                type="button"
                className="sidebar-conv-main"
                aria-label={item.lastMessage ? `${item.title}：${item.lastMessage}` : item.title}
                onMouseEnter={(event) => showTip(event.currentTarget, item)}
                onMouseLeave={hideTip}
                onFocus={(event) => showTip(event.currentTarget, item)}
                onBlur={hideTip}
                onClick={() => { hideTip(); onSelect(item.id); }}
              >
                <span className="sidebar-conv-title">{item.title || DEFAULT_CONVERSATION_TITLE}</span>
                {item.running ? <LoaderCircle size={11} className="spin" /> : null}
              </button>
            )}
            <button
              type="button"
              className="icon-button compact danger sidebar-conv-del"
              aria-label="删除会话"
              data-tooltip="删除会话"
              onClick={() => onDelete(item.id)}
            >
              <Trash2 size={12} />
            </button>
          </div>
        )) : (
          <p className="sidebar-conv-empty">
            {filter.trim() ? "没有匹配的会话。" : "还没有会话。点上面的「新对话」开始，然后用一句话让它画图或改图。"}
          </p>
        )}
      </div>
    </div>,
        host,
      )}
      {tip ? createPortal(
        <div className="sidebar-conv-tooltip" style={{ left: tip.x, top: tip.y }} role="tooltip">
          <span className="sidebar-conv-tooltip-title">{tip.title}</span>
          <p>{tip.text}</p>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
