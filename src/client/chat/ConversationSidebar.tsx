import { LoadingIndicator } from "../ui/LoadingIndicator";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Ellipsis, Folder, FolderOpen, Plus, Search, SquarePen, Trash2 } from "lucide-react";
import { DEFAULT_CONVERSATION_TITLE, type ConversationSummary } from "../../shared/agent-types";
import type { LocalWorkspace } from "../../shared/local-workspace";
import { usePersistentState } from "../task-ui";

export type SidebarConversation = ConversationSummary & { running: boolean };

function recentGroups(conversations: SidebarConversation[]) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const week = new Date(today);
  week.setDate(today.getDate() - 6);
  const groups = [
    { label: "今天", items: [] as SidebarConversation[] },
    { label: "昨天", items: [] as SidebarConversation[] },
    { label: "过去 7 天", items: [] as SidebarConversation[] },
    { label: "更早", items: [] as SidebarConversation[] },
  ];
  for (const item of conversations) {
    const date = Date.parse(item.updatedAt || item.createdAt);
    (date >= +today ? groups[0]! : date >= +yesterday ? groups[1]! : date >= +week ? groups[2]! : groups[3]!).items.push(item);
  }
  return groups;
}

/**
 * 会话列表（portal 到 App 的全局侧栏）。
 *
 * 状态仍然由 ChatView 持有：列表和 SSE 长在一起，把状态整体上提的代价更大；
 * 这里只把渲染拆出来，ChatView 的主渲染不再被会话列表撑长。
 */
export function ConversationSidebar({
  host,
  active,
  conversations,
  workspaces,
  addingWorkspace,
  activeId,
  renamingId,
  renameDraft,
  filter,
  searchOpen,
  onToggleSearch,
  onSelect,
  onCreate,
  onAddWorkspace,
  onWorkspaceMenu,
  workspaceMenuId,
  onOpenTrash,
  onContextMenu,
  menuId,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
}: {
  host: HTMLElement | null;
  active: boolean;
  conversations: SidebarConversation[];
  workspaces: LocalWorkspace[];
  addingWorkspace: boolean;
  activeId: string | null;
  renamingId: string | null;
  renameDraft: string;
  filter: string;
  searchOpen?: boolean;
  onToggleSearch?: () => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onAddWorkspace: () => void;
  onWorkspaceMenu: (event: React.MouseEvent<HTMLElement>, id: string) => void;
  workspaceMenuId?: string;
  onOpenTrash: () => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>, id: string) => void;
  menuId?: string;
  onRenameChange: (value: string) => void;
  onRenameCommit: (id: string) => void;
  onRenameCancel: () => void;
}) {
  const [tip, setTip] = useState<{ title: string; text: string; x: number; y: number } | null>(null);
  const tipTimer = useRef<number | null>(null);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [recentCollapsed, setRecentCollapsed] = usePersistentState("recentCollapsed", false, "chatcanvas.chat-sidebar.");
  const recentListId = useId();
  const searching = Boolean(filter.trim());
  const recentOpen = searching || !recentCollapsed;

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
  useEffect(() => { if (!active) hideTip(); }, [active]);

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
  const workspaceIds = new Set(workspaces.map(({ id }) => id));
  const recent = conversations.filter(({ workspaceId }) => !workspaceId || !workspaceIds.has(workspaceId));
  const renderConversation = (item: SidebarConversation) => (
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
        aria-current={item.id === activeId ? "page" : undefined}
        aria-label={item.lastMessage ? `${item.title}：${item.lastMessage}` : item.title}
        onMouseEnter={(event) => showTip(event.currentTarget, item)}
        onMouseLeave={hideTip}
        onFocus={(event) => showTip(event.currentTarget, item)}
        onBlur={hideTip}
        onClick={() => { hideTip(); onSelect(item.id); }}
      >
        <span className="sidebar-conv-title">{item.title || DEFAULT_CONVERSATION_TITLE}</span>
        {item.running ? <LoadingIndicator variant="dots" size={24} /> : null}
      </button>
    )}
    {renamingId !== item.id ? <button type="button" className="sidebar-conv-more" data-sidebar-menu-trigger
      aria-label="会话操作" aria-haspopup="menu" aria-expanded={menuId === item.id}
      onClick={event => { hideTip(); onContextMenu(event, item.id); }}><Ellipsis size={16} /></button> : null}
  </div>
  );
  return (
    <>
      {createPortal(
        <div className="sidebar-group sidebar-conversations">
      <div className="context-sidebar-actions sidebar-chat-actions">
        <button type="button" className="context-link sidebar-chat-create" onClick={onCreate}><SquarePen size={16} strokeWidth={1.7} />新建对话</button>
      </div>
      <div className="sidebar-conv-list">
        <div className="sidebar-group-title sidebar-workspace-label">
          <span>工作区</span>
          <button type="button" className="sidebar-group-add" aria-label="添加本地工作区" data-tooltip="添加本地工作区" onClick={onAddWorkspace} disabled={addingWorkspace}>
            <Plus size={15} strokeWidth={1.8} />
          </button>
        </div>
        {workspaces.map((workspace) => {
          const items = conversations.filter(({ workspaceId }) => workspaceId === workspace.id);
          const isOpen = !collapsed.includes(workspace.id) || searching;
          if (searching && !items.length) return null;
          return <section className="sidebar-workspace" key={workspace.id}>
            <div className="sidebar-workspace-heading" onContextMenu={event => onWorkspaceMenu(event, workspace.id)}>
              <button type="button" className="sidebar-workspace-toggle" aria-expanded={isOpen} aria-label={workspace.name} data-tooltip={workspace.directory}
                onClick={() => setCollapsed(current => isOpen ? [...new Set([...current, workspace.id])] : current.filter(id => id !== workspace.id))}>
                <ChevronDown className={isOpen ? "" : "is-collapsed"} size={12} strokeWidth={1.7} />
                {isOpen ? <FolderOpen size={15} strokeWidth={1.7} /> : <Folder size={15} strokeWidth={1.7} />}
                <span>{workspace.name}</span>
              </button>
              <button type="button" className="sidebar-conv-more" data-sidebar-menu-trigger
                aria-label={`工作区操作 ${workspace.name}`} aria-haspopup="menu" aria-expanded={workspaceMenuId === workspace.id}
                onClick={event => onWorkspaceMenu(event, workspace.id)}><Ellipsis size={16} /></button>
            </div>
            {isOpen ? <div className="sidebar-workspace-chats">{items.map(renderConversation)}</div> : null}
          </section>;
        })}
        <div className="sidebar-group-title sidebar-recent-header">
          <button type="button" className="sidebar-recent-heading" aria-expanded={recentOpen}
            aria-controls={recentListId} disabled={searching} onClick={() => setRecentCollapsed(value => !value)}>
            <span>最近对话</span><ChevronDown size={12} strokeWidth={1.7} />
          </button>
          {onToggleSearch ? <button type="button" className="context-icon sidebar-recent-search" aria-label="搜索会话"
            aria-expanded={searchOpen} data-tooltip="搜索会话" onClick={onToggleSearch}><Search size={14} strokeWidth={1.7} /></button> : null}
        </div>
        <div id={recentListId} hidden={!recentOpen}>
          {recentOpen && (recent.length ? recentGroups(recent).map(({ label, items }) => items.length ? (
            <section className="sidebar-recent-section" key={label} aria-label={label}>
              <h3>{label}</h3>
              {items.map(renderConversation)}
            </section>
          ) : null) : <p className="sidebar-conv-empty">{searching ? "没有匹配的普通会话。" : "暂无普通会话"}</p>)}
        </div>
      </div>
      <button type="button" className="sidebar-conv-trash" onClick={onOpenTrash}><Trash2 size={13} />最近删除</button>
    </div>,
        host,
      )}
      {active && tip ? createPortal(
        <div className="sidebar-conv-tooltip" style={{ left: tip.x, top: tip.y }} role="tooltip">
          <span className="sidebar-conv-tooltip-title">{tip.title}</span>
          <p>{tip.text}</p>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
