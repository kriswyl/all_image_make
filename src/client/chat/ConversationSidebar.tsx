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
  if (!host) return null;
  return createPortal(
    <div className="sidebar-group">
      <div className="sidebar-group-title">
        <span>最近</span>
        <button type="button" className="sidebar-group-add" title="新建会话" aria-label="新建会话" onClick={onCreate}>
          <Plus size={13} />
        </button>
      </div>
      <div className="sidebar-conv-list">
        {conversations.length ? conversations.map((item) => (
          <div
            key={item.id}
            className={`sidebar-conv ${item.id === activeId ? "is-active" : ""} ${renamingId === item.id ? "is-renaming" : ""}`}
            onContextMenu={(event) => onContextMenu(event, item.id)}
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
              <button type="button" className="sidebar-conv-main" title={item.lastMessage || item.title} onClick={() => onSelect(item.id)}>
                <span className="sidebar-conv-title">{item.title || DEFAULT_CONVERSATION_TITLE}</span>
                {item.running ? <LoaderCircle size={11} className="spin" /> : null}
              </button>
            )}
            <button
              type="button"
              className="icon-button compact danger sidebar-conv-del"
              title="删除会话"
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
  );
}
