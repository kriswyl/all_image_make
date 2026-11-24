import { BRAND } from "../shared/brand.generated";
import type { KeyboardEvent, PointerEvent, Ref } from "react";
import {
  Film, History, Image, Images, Mic, Music,
  PanelLeft, PanelLeftClose, Pin, PinOff, Search, Settings2, type LucideIcon,
} from "lucide-react";
import type { View } from "./app-shared";
import { BrandMark } from "./BrandMark";
import { NavigationGlyph, type NavigationGlyphId } from "./NavigationGlyph";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "./layout";
import { UpdateStatus } from "./UpdateStatus";
import type { HistoryKind, HistoryMode, HistoryNavigation } from "./views/history-navigation";

const creationPages = [
  { view: "generate", label: "图片生成", icon: Image },
  { view: "video", label: "视频生成", icon: Film },
  { view: "music", label: "音乐生成", icon: Music },
  { view: "speech", label: "语音生成", icon: Mic },
] as const;

export type CreationView = (typeof creationPages)[number]["view"];
export type NavigationMode = NavigationGlyphId | "channels";

export function isCreationView(view: View): view is CreationView {
  return creationPages.some(item => item.view === view);
}

export function navigationMode(view: View): NavigationMode {
  return isCreationView(view) ? "create" : view;
}

const modeLabels = {
  chat: "对话",
  board: "无限画布",
  create: "AI 创作",
  history: "素材管理",
  channels: "模型设置",
} satisfies Record<NavigationMode, string>;

const primaryModes = ["chat", "board", "create", "history"] as const;
const historyModes = [
  { value: "assets", label: "素材", icon: Images },
  { value: "records", label: "生成记录", icon: History },
] satisfies Array<{ value: HistoryMode; label: string; icon: LucideIcon }>;
const historyKinds = [
  { value: "all", label: "全部", icon: Images },
  { value: "image", label: "图片", icon: Image },
  { value: "video", label: "视频", icon: Film },
  { value: "audio", label: "音频", icon: Music },
] satisfies Array<{ value: HistoryKind; label: string; icon: LucideIcon }>;

function railKeys(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-rail-route]"));
  const index = buttons.findIndex(button => button === event.target);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
    : (index + (event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
  buttons[next]?.focus();
}

export function NavigationRail({ mode, collapsed, showToggle, historyUnread, service, onNavigate, onToggle }: {
  mode: NavigationMode;
  collapsed: boolean;
  showToggle: boolean;
  historyUnread: boolean;
  service: "ready" | "loading" | "offline";
  onNavigate: (mode: NavigationMode) => void;
  onToggle: () => void;
}) {
  function destination(destinationMode: NavigationMode) {
    const label = modeLabels[destinationMode];
    const unread = destinationMode === "history" && historyUnread;
    return <button key={destinationMode} type="button" className="navigation-rail-button" data-rail-route={destinationMode}
      aria-label={label} data-tooltip={unread ? "素材管理 · 有新记录" : label}
      aria-current={mode === destinationMode ? "page" : undefined} aria-controls="context-sidebar"
      onClick={() => onNavigate(destinationMode)}>
      {destinationMode === "channels" ? <Settings2 size={19} strokeWidth={1.7} aria-hidden="true" /> : <NavigationGlyph name={destinationMode} />}
      {unread ? <span className="navigation-rail-unread" aria-hidden="true" /> : null}
    </button>;
  }
  const serviceLabel = service === "ready" ? "本地运行" : service === "loading" ? "正在连接本地服务" : "本地服务不可用";
  const toggleLabel = collapsed ? "展开侧边栏" : "收起侧边栏";
  return <nav className="navigation-rail" aria-label="主导航" onKeyDown={railKeys}>
    <div className="navigation-rail-brand" aria-label={BRAND.productName} role="img"><BrandMark size={25} /></div>
    <div className="navigation-rail-primary">{primaryModes.map(destination)}</div>
    <div className="navigation-rail-bottom">
      {showToggle ? <button type="button" className="navigation-rail-button navigation-rail-toggle" data-sidebar-toggle aria-label={toggleLabel}
        aria-expanded={!collapsed} aria-controls="context-sidebar" data-tooltip={`${toggleLabel}（Ctrl+B）`} onClick={onToggle}>
        {collapsed ? <PanelLeft size={17} /> : <PanelLeftClose size={17} />}
      </button> : null}
      {destination("channels")}
      <span className="navigation-rail-service" data-service={service} role="status" aria-label={serviceLabel} data-tooltip={serviceLabel}>
        <span className="status-dot" aria-hidden="true" />
      </span>
    </div>
  </nav>;
}

function ContextButton({ icon: Icon, label, selected, onClick }: { icon: LucideIcon; label: string; selected?: boolean; onClick: () => void }) {
  return <button type="button" className="context-link" aria-current={selected ? "page" : undefined} onClick={onClick}>
    <Icon size={17} strokeWidth={1.7} /><span>{label}</span>
  </button>;
}

export function ContextSidebar({ mode, view, collapsed, overlay, boardPinned, width, widthLimit, panelRef, chatHostRef, boardHostRef,
  search, onSearch, history, onNavigate, onTogglePin, onResizeStart, onResize, onSettings }: {
  mode: NavigationMode;
  view: View;
  collapsed: boolean;
  overlay: boolean;
  boardPinned: boolean;
  width: number;
  widthLimit: number;
  panelRef: Ref<HTMLElement>;
  chatHostRef: Ref<HTMLDivElement>;
  boardHostRef: Ref<HTMLDivElement>;
  search?: string;
  onSearch: (value: string | undefined) => void;
  history: HistoryNavigation;
  onNavigate: (view: View) => void;
  onTogglePin: () => void;
  onResizeStart: (event: PointerEvent<HTMLDivElement>) => void;
  onResize: (step: number) => void;
  onSettings: () => void;
}) {
  const searchAvailable = mode === "chat" || mode === "board";
  const searchLabel = mode === "board" ? "搜索画布" : "搜索会话";
  const pinLabel = boardPinned ? "取消固定侧边栏" : "固定侧边栏";

  return <aside id="context-sidebar" className="context-sidebar" ref={panelRef} aria-label={`${modeLabels[mode]}侧边栏`}
    aria-hidden={collapsed || undefined} inert={collapsed}>
    <header className="context-sidebar-header">
      <div className="context-sidebar-heading">
        <div className="context-sidebar-identity">
          {mode === "chat" ? <><strong>{BRAND.productName}</strong>{BRAND.subtitle ? <small>{BRAND.subtitle}</small> : null}</>
            : <>{mode === "channels" ? <Settings2 size={17} strokeWidth={1.7} aria-hidden="true" /> : <NavigationGlyph name={mode} size={17} />}
              <strong>{modeLabels[mode]}</strong></>}
        </div>
        {mode === "board" ? <button type="button" className="context-icon" aria-label={pinLabel} aria-pressed={boardPinned} data-tooltip={pinLabel} onClick={onTogglePin}>
          {boardPinned ? <PinOff size={15} /> : <Pin size={15} />}
        </button> : null}
        {mode === "board" ? <button type="button" className="context-icon" aria-label={searchLabel} aria-expanded={search !== undefined}
          data-tooltip={searchLabel} onClick={() => onSearch(search === undefined ? "" : undefined)}><Search size={16} /></button> : null}
      </div>
      {searchAvailable && search !== undefined ? <div className="context-search">
        <Search size={14} />
        <input key={mode} autoFocus aria-label={searchLabel} placeholder={mode === "chat" ? "搜索标题或内容" : "搜索画布名称"}
          value={search} onChange={event => onSearch(event.target.value)}
          onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onSearch(undefined); } }} />
      </div> : null}
    </header>
    <div className="context-sidebar-body">
      <div className="context-portal" ref={chatHostRef} hidden={mode !== "chat"} />
      <div className="context-portal" ref={boardHostRef} hidden={mode !== "board"} />
      {mode === "create" ? <nav className="context-links" aria-label="创作类型">
        {creationPages.map(item => <ContextButton key={item.view} icon={item.icon} label={item.label} selected={view === item.view} onClick={() => onNavigate(item.view)} />)}
      </nav> : null}
      {mode === "history" ? <nav className="context-links" aria-label="素材管理分类">
        {historyModes.map(item => <ContextButton key={item.value} icon={item.icon} label={item.label} selected={history.mode === item.value} onClick={() => history.setMode(item.value)} />)}
        <h2>素材类型</h2>
        {historyKinds.map(item => <ContextButton key={item.value} icon={item.icon} label={item.label} selected={history.kind === item.value} onClick={() => history.setKind(item.value)} />)}
        <h2>管理</h2>
        <ContextButton icon={Settings2} label="素材设置" onClick={onSettings} />
      </nav> : null}
      {mode === "channels" ? <nav className="context-links" aria-label="设置分类">
        <ContextButton icon={Settings2} label="应用设置" onClick={onSettings} />
      </nav> : null}
    </div>
    <footer className="context-sidebar-footer"><UpdateStatus /></footer>
    {!overlay && !collapsed ? <div className="context-sidebar-resizer" role="separator" aria-orientation="vertical" aria-label="调整侧栏宽度"
      aria-valuenow={width} aria-valuemin={SIDEBAR_MIN_WIDTH} aria-valuemax={Math.min(SIDEBAR_MAX_WIDTH, widthLimit)} tabIndex={0}
      onPointerDown={onResizeStart} onKeyDown={event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        onResize(event.key === "ArrowLeft" ? -12 : 12);
      }} /> : null}
  </aside>;
}
