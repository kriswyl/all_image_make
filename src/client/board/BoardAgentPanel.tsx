import { ContextSummaryControl } from "../chat/ContextSummaryControl";
/**
 * 无限画布的浮动 Agent。
 *
 * 复用聊天页的消息 / 工具卡 / 确认卡 / SSE，但上下文是无限画布线程：
 * 服务端只给它 board_* 工具，不加载参考图组和分镜。
 *
 * 面板可拖动、缩放、收起；位置和尺寸存进 boards.ui_state_json。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, ChevronDown, LoaderCircle, Send, Square, X } from "lucide-react";
import { api } from "../api";
import { buildRows } from "../chat/rows";
import { AssistantBubble, StreamingBubble, SystemNote, UserBubble } from "../chat/MessageBubble";
import { ModelPicker, type ModelOption } from "../chat/ModelPicker";
import { ToolCard, type TaskProgress } from "../chat/ToolCard";
import { ConfirmCard } from "../chat/ConfirmCard";
import type { AgentStreamEvent, ChatMessage, ConversationStatus, ConversationView } from "../../shared/agent-types";
import type { BoardAgentUiState, BoardDelta } from "../../shared/board";

type Toast = (kind: "success" | "error", message: string) => void;

function upsert(messages: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((item) => item.id === incoming.id);
  if (index === -1) return [...messages, incoming].sort((left, right) => left.seq - right.seq);
  const next = messages.slice();
  next[index] = incoming;
  return next;
}

function readAskOptions(message: ChatMessage): string[] {
  if (message.plan?.tool !== "ask") return [];
  const options = message.plan.args?.options;
  if (!Array.isArray(options)) return [];
  return options.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 8);
}

/**
 * 面板可能在窗口还没量出尺寸时挂载（隐藏的 webview / 最小化窗口），
 * innerWidth 会是 0。用 1280×800 的兜底，免得初始位置被夹到左上角 (8,8)。
 */
function viewportSize() {
  return {
    width: window.innerWidth || 1280,
    height: window.innerHeight || 800,
  };
}

function defaultUi(): BoardAgentUiState {
  const viewport = viewportSize();
  const width = 380;
  const height = Math.min(560, viewport.height - 32);
  return {
    x: Math.max(12, viewport.width - width - 24),
    y: Math.max(12, viewport.height - height - 24),
    width,
    height,
    collapsed: false,
  };
}

function clampUi(ui: BoardAgentUiState): BoardAgentUiState {
  const viewport = viewportSize();
  const width = Math.min(Math.max(300, ui.width), Math.max(320, viewport.width - 24));
  const height = Math.min(Math.max(320, ui.height), Math.max(360, viewport.height - 24));
  return {
    ...ui,
    width,
    height,
    x: Math.min(Math.max(8, ui.x), Math.max(8, viewport.width - width - 8)),
    y: Math.min(Math.max(8, ui.y), Math.max(8, viewport.height - height - 8)),
    ...(ui.bubbleX === undefined ? {} : {
      bubbleX: Math.min(Math.max(8, ui.bubbleX), Math.max(8, viewport.width - 52)),
    }),
    ...(ui.bubbleY === undefined ? {} : {
      bubbleY: Math.min(Math.max(8, ui.bubbleY), Math.max(8, viewport.height - 52)),
    }),
  };
}

export function BoardAgentPanel({
  threadId, initialUiState, onUiStateChange, onToast, onBoardDelta, onFrameRequest, onBeforeSend, onClose,
}: {
  threadId: string;
  initialUiState?: BoardAgentUiState;
  onUiStateChange: (state: BoardAgentUiState) => void;
  onToast: Toast;
  onBoardDelta: (delta?: BoardDelta) => void;
  onFrameRequest: (request: { boardId: string; requestId: string; videoAssetId: string }) => void;
  onBeforeSend: () => Promise<void>;
  onClose: () => void;
}) {
  const [view, setView] = useState<(ConversationView & { running: boolean }) | null>(null);
  const [status, setStatus] = useState<ConversationStatus>("idle");
  const [draft, setDraft] = useState("");
  const [compressing, setCompressing] = useState(false);
  const [reasoning, setReasoning] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Record<string, TaskProgress>>({});
  const [batchProgress, setBatchProgress] = useState("");
  const [ui, setUi] = useState<BoardAgentUiState>(() => clampUi({ ...defaultUi(), ...(initialUiState ?? {}), collapsed: true, bubbleX: viewportSize().width - 60, bubbleY: 102 }));
  const [unread, setUnread] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** onToast 的引用会随 App 重渲染变化，不能让它触发 SSE 重连 */
  const toastRef = useRef(onToast);
  const frameRequestRef = useRef(onFrameRequest);
  useEffect(() => { frameRequestRef.current = onFrameRequest; }, [onFrameRequest]);
  useEffect(() => { toastRef.current = onToast; }, [onToast]);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startY: number; width: number; height: number } | null>(null);
  const bubbleDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const suppressBubbleClickRef = useRef(false);
  const uiRef = useRef(ui);
  const collapsedRef = useRef(ui.collapsed);
  useEffect(() => { uiRef.current = ui; collapsedRef.current = ui.collapsed; }, [ui]);

  const persist = useCallback((next: BoardAgentUiState) => {
    const clamped = clampUi(next);
    setUi(clamped);
    uiRef.current = clamped;
    onUiStateChange(clamped);
  }, [onUiStateChange]);

  // 窗口尺寸变了（或挂载时 webview 还没量出尺寸）把浮窗拉回可视区
  useEffect(() => {
    const apply = () => {
      setUi((current) => {
        const next = clampUi(current);
        uiRef.current = next;
        return next;
      });
    };
    const frame = requestAnimationFrame(apply);
    window.addEventListener("resize", apply);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", apply);
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await api.conversation(threadId);
      setView(next);
      setStatus(next.running ? "running" : next.status);
    } catch (error) {
      toastRef.current("error", error instanceof Error ? error.message : "无限画布助手加载失败");
    }
  }, [threadId]);

  useEffect(() => { void load(); }, [load]);

  /**
   * 画布助手用哪个对话模型。
   *
   * 只列「能当大脑」的渠道（/api/agent/brains 已经按对话适配器筛过）——
   * 选到生图模型只会得到一个「不是对话适配器」的报错。
   */
  const [chatOptions, setChatOptions] = useState<ModelOption[]>([]);
  useEffect(() => {
    let cancelled = false;
    void api.brains().then((brains) => {
      if (cancelled) return;
      setChatOptions(brains.flatMap((channel) => channel.models.map((model) => ({
        value: `${channel.id}::${model}`, model, channelName: channel.name,
      }))));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const pickModel = useCallback(async (next: string) => {
    const [brainChannelId, brainModel] = next.split("::");
    try {
      const updated = await api.updateConversation(threadId, { brainChannelId: brainChannelId ?? "", brainModel: brainModel ?? "" });
      setView((current) => ({ ...updated, running: current?.running ?? false }));
    } catch (error) {
      toastRef.current("error", error instanceof Error ? error.message : "切换模型失败");
    }
  }, [threadId]);

  // 渠道被停用或改了模型列表后，当前值可能已经不在候选里；补一条，别让选择器显示空白
  const modelOptions = useMemo<ModelOption[]>(() => {
    if (!view) return chatOptions;
    const current = `${view.brainChannelId}::${view.brainModel}`;
    if (chatOptions.some((item) => item.value === current)) return chatOptions;
    return [...chatOptions, { value: current, model: view.brainModel || "未配置模型", channelName: "当前设置" }];
  }, [chatOptions, view?.brainChannelId, view?.brainModel]);

  useEffect(() => {
    const onEvent = (event: AgentStreamEvent) => {
      switch (event.type) {
        case "context_compression":
          setCompressing(event.status === "started");
          if (event.status === "finished") toastRef.current(/失败|不完整/.test(event.message) ? "error" : "success", event.message);
          break;
        case "context_summary":
          setView((current) => current ? { ...current, contextSummary: { text: event.text, throughSeq: event.throughSeq } } : current);
          break;
        case "reasoning": setReasoning((current) => current + event.text); break;
        case "token": setDraft((current) => current + event.text); break;
        case "reset": setReasoning(""); setDraft(""); break;
        case "status": setStatus(event.status); break;
        case "message":
          setView((current) => {
            if (!current || current.id !== event.message.conversationId) return current;
            if (event.message.role === "assistant") { setReasoning(""); setDraft(""); }
            if (collapsedRef.current) setUnread(true);
            return { ...current, messages: upsert(current.messages, event.message) };
          });
          break;
        case "progress":
          setProgress((current) => ({ ...current, [event.taskId]: { status: event.status, progress: event.progress } }));
          break;
        case "board_batch_progress": setBatchProgress(event.text); break;
        case "board_frame_request":
          frameRequestRef.current(event);
          break;
        case "board":
          onBoardDelta(event.delta);
          break;
        case "confirm":
          if (collapsedRef.current) setUnread(true);
          break;
        case "error": toastRef.current("error", event.message); break;
        case "done":
          setBatchProgress("");
          setStatus(event.status);
          setReasoning("");
          setDraft("");
          void load();
          break;
        default: break;
      }
    };
    return api.openConversationStream(threadId, {
      onEvent,
      onOpen: () => { void load(); },
    });
  }, [load, onBoardDelta, threadId]);

  const rows = useMemo(() => (view ? buildRows(view.messages) : []), [view]);
  const hasStream = Boolean(reasoning || draft);
  const awaitingConfirmation = status === "awaiting_confirmation";
  const running = status === "running" || status === "waiting_task";
  const composerLocked = busy || running || compressing || awaitingConfirmation;

  // 滚动跟随
  useEffect(() => {
    const element = threadRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [rows.length, draft, reasoning]);

  const send = useCallback(async (text: string) => {
    const value = text.trim();
    if (!value || composerLocked) return;
    setBusy(true);
    try {
      // 先把画布上没保存的改动写掉，Agent 读到的才是用户眼前的样子
      await onBeforeSend();
      await api.sendMessage(threadId, value);
      setDraft("");
      setStatus("running");
    } catch (error) {
      toastRef.current("error", error instanceof Error ? error.message : "发送失败");
    } finally {
      setBusy(false);
    }
  }, [composerLocked, onBeforeSend, threadId]);

  const stop = useCallback(async () => {
    try {
      await api.interruptConversation(threadId);
    } catch (error) {
      toastRef.current("error", error instanceof Error ? error.message : "停止失败");
    }
  }, [threadId]);

  const resolveConfirm = useCallback(async (messageId: string, decision: "approve" | "reject") => {
    setBusy(true);
    try {
      await api.confirmMessage(threadId, messageId, decision);
      setStatus(decision === "approve" ? "running" : "idle");
      await load();
    } catch (error) {
      toastRef.current("error", error instanceof Error ? error.message : "确认失败");
    } finally {
      setBusy(false);
    }
  }, [load, threadId]);

  // 让最后一条还没被回答的 ask 保留可点选项
  const lastAnswerableId = useMemo(() => {
    let id: string | null = null;
    for (const row of rows) {
      if (row.kind === "user") id = null;
      else if (row.kind === "assistant" && readAskOptions(row.message).length) id = row.message.id;
    }
    return id;
  }, [rows]);

  const beginDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, input, textarea")) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: ui.x,
      originY: ui.y,
    };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
  };

  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = clampUi({
      ...uiRef.current,
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    });
    setUi(next);
    uiRef.current = next;
  };

  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!dragRef.current) return;
    dragRef.current = null;
    persist(uiRef.current);
  };

  const beginResize = (event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      width: ui.width,
      height: ui.height,
    };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
  };

  const moveResize = (event: React.PointerEvent<HTMLElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const next = clampUi({
      ...uiRef.current,
      width: resize.width + event.clientX - resize.startX,
      height: resize.height + event.clientY - resize.startY,
    });
    setUi(next);
    uiRef.current = next;
  };

  const endResize = (event: React.PointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!resizeRef.current) return;
    resizeRef.current = null;
    persist(uiRef.current);
  };

  const viewport = viewportSize();
  const bubbleX = Math.min(Math.max(8, ui.bubbleX ?? ui.x + ui.width - 52), Math.max(8, viewport.width - 52));
  const bubbleY = Math.min(Math.max(8, ui.bubbleY ?? ui.y + 16), Math.max(8, viewport.height - 52));

  const expandFromBubble = () => {
    const current = uiRef.current;
    const hasBubblePosition = current.bubbleX !== undefined || current.bubbleY !== undefined;
    persist({
      ...current,
      collapsed: false,
      ...(hasBubblePosition ? {
        x: bubbleX - current.width + 52,
        y: bubbleY - 16,
      } : {}),
    });
    setUnread(false);
  };

  const beginBubbleDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    // 不 preventDefault：气泡本身是 button，要让键盘 / 鼠标的 click 仍然能触发展开
    event.stopPropagation();
    bubbleDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: bubbleX,
      originY: bubbleY,
      moved: false,
    };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
  };

  const moveBubbleDrag = (event: React.PointerEvent<HTMLElement>) => {
    const drag = bubbleDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    drag.moved = true;
    const size = viewportSize();
    const next = clampUi({
      ...uiRef.current,
      bubbleX: Math.min(Math.max(8, drag.originX + dx), Math.max(8, size.width - 52)),
      bubbleY: Math.min(Math.max(8, drag.originY + dy), Math.max(8, size.height - 52)),
    });
    setUi(next);
    uiRef.current = next;
  };

  const endBubbleDrag = (event: React.PointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const drag = bubbleDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    bubbleDragRef.current = null;
    if (drag.moved) {
      suppressBubbleClickRef.current = true;
      window.setTimeout(() => { suppressBubbleClickRef.current = false; }, 0);
      persist(uiRef.current);
    }
  };

  if (ui.collapsed) {
    return (
      <button
        type="button"
        className="board-agent-bubble"
        style={{ left: bubbleX, top: bubbleY }}
        title="拖动调整位置，点击展开无限画布助手"
        onPointerDown={beginBubbleDrag}
        onPointerMove={moveBubbleDrag}
        onPointerUp={endBubbleDrag}
        onPointerCancel={endBubbleDrag}
        onClick={() => {
          if (suppressBubbleClickRef.current) return;
          expandFromBubble();
        }}
      >
        <Bot size={17} />
        {unread ? <span className="board-agent-unread" /> : null}
      </button>
    );
  }

  return (
    <section
      ref={panelRef}
      className="board-agent-panel"
      style={{ left: ui.x, top: ui.y, width: ui.width, height: ui.height }}
      aria-label="无限画布助手"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header
        className="board-agent-head"
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="board-agent-icon"><Bot size={15} /></span>
        <div className="board-agent-title">
          <strong>无限画布助手</strong>
          {/* 标题栏整体是拖拽区，选择器自己要吃掉 pointerdown，否则点开会变成拖窗口 */}
          <div className="board-agent-model" onPointerDown={(event) => event.stopPropagation()}>
            <ModelPicker
              options={modelOptions}
              value={`${view?.brainChannelId ?? ""}::${view?.brainModel ?? ""}`}
              onChange={(next) => void pickModel(next)}
              placeholder="选对话模型"
              menuPlacement="down"
              disabled={!view}
              className="board-agent-model-picker"
              ariaLabel="画布助手的对话模型"
            />
            {running ? <span className="board-agent-running">工作中</span> : null}
          </div>
        </div>
        {running || awaitingConfirmation ? <LoaderCircle size={13} className="spin board-agent-spin" /> : null}
        <button
          type="button"
          className="board-agent-head-btn"
          title="收起"
          aria-label="收起无限画布助手"
          onClick={() => persist({
            ...uiRef.current,
            collapsed: true,
            bubbleX: uiRef.current.x + uiRef.current.width - 52,
            bubbleY: uiRef.current.y + 16,
          })}
        >
          <ChevronDown size={14} />
        </button>
        <button
          type="button"
          className="board-agent-head-btn"
          title="关闭"
          aria-label="关闭无限画布助手"
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </header>

      <div className="board-agent-thread" ref={threadRef}>
        {!view ? (
          <div className="board-agent-empty"><LoaderCircle size={15} className="spin" />正在连接助手…</div>
        ) : null}
        {view && !rows.length && !hasStream ? (
          <div className="board-agent-empty">
            <strong>让助手帮你搭画板</strong>
            <span>例如「把这段文案做成一张图」「在这张图旁边加一个改图节点」「把这两个节点连起来」。</span>
          </div>
        ) : null}

        {rows.map((row) => {
          if (row.kind === "user") return <UserBubble key={row.message.id} message={row.message} />;
          if (row.kind === "note") return <SystemNote key={row.message.id} message={row.message} />;
          if (row.kind === "assistant") {
            const options = row.message.id === lastAnswerableId ? readAskOptions(row.message) : [];
            return (
              <AssistantBubble
                key={row.message.id}
                message={row.message}
                options={options}
                disabled={composerLocked}
                onPick={(value) => void send(value)}
              />
            );
          }
          if (row.kind === "confirm") {
            return (
              <ConfirmCard
                key={row.message.id}
                message={row.message}
                preview={row.preview}
                busy={busy}
                onApprove={() => void resolveConfirm(row.message.id, "approve")}
                onReject={() => void resolveConfirm(row.message.id, "reject")}
              />
            );
          }
          const taskId = row.result?.taskId ?? null;
          return (
            <ToolCard
              key={row.message.id}
              message={row.message}
              result={row.result}
              progress={taskId ? progress[taskId] : undefined}
              stale={!running}
              assets={view?.mediaAssets ?? []}
              onToast={(kind, text) => onToast(kind === "ok" ? "success" : "error", text)}
            />
          );
        })}

        {hasStream ? <StreamingBubble reasoning={reasoning} content={draft} /> : null}
        {batchProgress ? <div className="chat-note"><LoaderCircle className="spin" size={13} />{batchProgress}</div> : null}
      </div>

      {view && !view.brainChannelId ? (
        <div className="board-agent-warning">还没有对话模型。先到「模型设置」添加一个，再回来用助手。</div>
      ) : null}

      <div className="board-agent-composer">
        <textarea
          value={draft}
          rows={2}
          maxLength={20000}
          placeholder="让助手加节点、连线、改提示词，或生成图片…"
          disabled={composerLocked || !view?.brainChannelId}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send(draft);
            }
          }}
          onPointerDown={(event) => event.stopPropagation()}
        />
        <div className="board-agent-composer-foot">
          <span>{compressing ? "正在压缩上下文…" : "Enter 发送 · Shift+Enter 换行"}</span>
          {view ? <ContextSummaryControl key={view.id} view={view} compressing={compressing} disabled={busy || running} onCompress={() => {
            setCompressing(true);
            void api.compressConversation(threadId).then(() => { setCompressing(false); void load(); }).catch((error) => { setCompressing(false); toastRef.current("error", error instanceof Error ? error.message : "压缩失败"); });
          }} onBudgetChange={(contextBudget) => {
            void api.updateConversation(threadId, { contextBudget }).then(() => setView((current) => current ? { ...current, contextBudget } : current)).catch((error) => toastRef.current("error", error instanceof Error ? error.message : "设置保存失败"));
          }} onBoardLimitsChange={(patch) => {
            void api.updateConversation(threadId, patch)
              .then((updated) => setView((current) => ({ ...updated, running: current?.running ?? false })))
              .catch((error) => toastRef.current("error", error instanceof Error ? error.message : "设置保存失败"));
          }} /> : null}
          {running ? (
            <button type="button" className="board-agent-send is-stop" title="停止" onClick={() => void stop()}>
              <Square size={13} />
            </button>
          ) : (
            <button
              type="button"
              className="board-agent-send"
              title="发送"
              disabled={composerLocked || !draft.trim() || !view?.brainChannelId}
              onClick={() => void send(draft)}
            >
              <Send size={14} />
            </button>
          )}
        </div>
      </div>

      <span
        className="board-agent-resize"
        title="拖动调整助手大小"
        onPointerDown={beginResize}
        onPointerMove={moveResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
      />
    </section>
  );
}
