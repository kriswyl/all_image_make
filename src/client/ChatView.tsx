/**
 * 对话式 Agent 工作区（AGENT_PLAN.md §17）。
 *
 * 这里是**唯一**一个「用户说的话直接变成生成任务」的界面，所以两件事必须一直可见：
 * 现在说的是哪张图（画布徽章 + 缩略条），以及助手到底调了什么（工具卡片）。
 * 少了前者，多轮改图就是盲改；少了后者，用户会以为它在自己瞎画。
 *
 * 消息流靠 SSE 增量更新，但每个 `done` 之后仍然重新拉一次会话——
 * 重连、丢事件、画布指针变化这三种情况，一次全量拉取比补逻辑便宜得多。
 *
 * 行的折叠规则在 `chat/rows.ts`：那个模块被单独拆出去，一是它有单测，
 * 二是这个文件还要 export 组件，混着 export 纯函数会让 Fast Refresh 整个失效。
 */
import {
  Brain, Clapperboard, Eye, EyeOff, Film, Images, ListTree, LoaderCircle, MessageSquarePlus, PenLine, Plus, Trash2, Wand2, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ConversationSidebar } from "./chat/ConversationSidebar";
import { clearCompletionBadge, notifyCompletion } from "./notifications";
import { AssetLightbox } from "./chat/AssetLightbox";
import { MAX_CANVAS_IMAGES, MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES, isChatAdapter } from "../shared/types";
import type { Asset, Channel, DefaultModelGroup, TaskKind } from "../shared/types";
import {
  assetRef, videoConfirmPolicyLabels, VIDEO_CONFIRM_POLICIES, DEFAULT_CONVERSATION_TITLE, type AgentStreamEvent,
  type ChatMessage, type ConversationStatus, type ConversationSummary,
  type ConversationView, type GenerateVideoArgs, type VideoConfirmPolicy,
} from "../shared/agent-types";
import { api, ApiError, isTauriRuntime } from "./api";
import { Composer, isScriptDocument } from "./chat/Composer";
import { MAX_SCRIPT_CHARS, MAX_SCRIPT_TOTAL_CHARS } from "../shared/storyboard";
import { ConfirmCard } from "./chat/ConfirmCard";
import { AssistantBubble, StreamingBubble, SystemNote, UserBubble } from "./chat/MessageBubble";
import { ModelPanel } from "./chat/ModelPanel";
import { ModelPicker, type ModelOption } from "./chat/ModelPicker";
import { buildRows } from "./chat/rows";
import { ToolCard, type TaskProgress } from "./chat/ToolCard";
import { StoryboardPanel } from "./chat/StoryboardPanel";
import { AssetLibrary } from "./chat/AssetLibrary";

const STORAGE_KEY = "yida.agent.lastConversation";

/**
 * 从 `ask` 的消息里取出可点的选项。
 *
 * 选项一直存在库里（`plan.args.options`），以前只是落库时被丢掉了，
 * 于是模型问「你要 A 还是 B」，用户面前只有一句话。这里把它们捞回来渲染成按钮。
 */
function readAskOptions(message: ChatMessage): string[] {
  if (message.plan?.tool !== "ask") return [];
  const options = message.plan.args?.options;
  if (!Array.isArray(options)) return [];
  return options.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 8);
}

/** token 数太长了，状态行只放得下 k / M 两种缩写；完整数值挂在 tooltip 上 */
function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(value);
}

function upsert(messages: ChatMessage[], incoming: ChatMessage): ChatMessage[] {
  const index = messages.findIndex((item) => item.id === incoming.id);
  if (index === -1) return [...messages, incoming].sort((left, right) => left.seq - right.seq);
  const next = messages.slice();
  next[index] = incoming;
  return next;
}

/**
 * 画布改动的合并窗口。定 250ms 是因为它要盖住的**只有一个原生双击**——
 * 双击的两次 click 间隔在系统设置的上限附近也就 200ms 上下，比这更长的延迟
 * 会让单击「加入画布」也变得粘手。连点两张图仍然各自成一次请求，那是对的。
 */
const CANVAS_PATCH_DEBOUNCE_MS = 250;

export function ChatView({
  channels,
  sidebarHost,
  sidebarFilter = "",
  newChatSignal = 0,
  onNewChatHandled,
  onConfigureChannel,
  onDiagnostics,
  onToast,
}: {
  channels: Channel[];
  /** 全局侧栏里挂会话列表的节点（还没挂载完时为 null，此时不渲染列表） */
  sidebarHost: HTMLElement | null;
  /** 侧栏搜索框里的词：按标题和最后一条消息过滤会话列表，空串表示不过滤 */
  sidebarFilter?: string;
  /** 大于 0 表示侧栏刚点了「新对话」，值本身不重要，只看它变没变 */
  newChatSignal?: number;
  /** 处理完就把它归零，免得下次挂载又建一条（挂载时信号还留着的话会重复触发） */
  onNewChatHandled?: () => void;
  /** 模型面板里的「调整」：直接把那个渠道的编辑弹窗打开 */
  onConfigureChannel?: (channel: Channel) => void;
  /** 工具卡片里的「诊断」：打开应用内诊断弹窗（Tauri 里 window.open 会被拦掉） */
  onDiagnostics?: (taskId: string) => void;
  onToast: (kind: "ok" | "error", text: string) => void;
}) {
  const brains = useMemo(() => channels.filter((channel) => isChatAdapter(channel.adapterType) && channel.enabled), [channels]);

  const [list, setList] = useState<Array<ConversationSummary & { running: boolean }>>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<ConversationView | null>(null);
  // 发送时要在同一次事件里读到「刚上传 / 刚并入」的画布，不等 React 下一次渲染
  const viewRef = useRef(view);
  viewRef.current = view;
  const [status, setStatus] = useState<ConversationStatus>("idle");
  const [reasoning, setReasoning] = useState("");
  const [draft, setDraft] = useState("");
  const [progress, setProgress] = useState<Record<string, TaskProgress>>({});
  const [capabilities, setCapabilities] = useState<Array<{
    alias: string; kind: TaskKind; model: string; channelName: string; channelId: string; adapterType: string;
  }>>([]);
  /** 默认生图 / 生视频 / 音乐 / 语音模型，空串表示不指定、用该类里第一个 */
  const [defaults, setDefaults] = useState<Record<DefaultModelGroup, string>>({
    image: "", video: "", music: "", speech: "",
  });
  const [preview, setPreview] = useState<string | null>(null);
  const [storyboardOpen, setStoryboardOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 正在上传自己带的图（需求.md 问题 4）：传的时候不让再点一次 */
  const [uploading, setUploading] = useState(false);
  /** 会话列表的右键菜单：位置固定在视口里，避免被侧栏滚动裁掉 */
  const [convMenu, setConvMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const convMenuRef = useRef<HTMLDivElement>(null);
  const renameCancelRef = useRef(false);
  const threadRef = useRef<HTMLDivElement>(null);
  /** 消息流的实际内容高度：图片异步加载时消息条数不变，只能靠它感知「版面又长高了」 */
  const threadInnerRef = useRef<HTMLDivElement>(null);

  /**
   * 大脑候选：所有启用的对话渠道 × 它们的模型。
   *
   * 末尾补上「当前这一条」——渠道被停用或改了模型列表之后，它已经不在候选里了，
   * 但选择器上必须还显示得出来，否则用户看到一个空白按钮，不知道自己在用什么。
   */
  const brainOptions = useMemo<ModelOption[]>(() => {
    const options = brains.flatMap((channel) => channel.models.map((model) => ({
      value: `${channel.id}::${model}`, model, channelName: channel.name,
    })));
    if (!view) return options;
    const currentValue = `${view.brainChannelId}::${view.brainModel}`;
    if (options.some((item) => item.value === currentValue)) return options;
    return [...options, { value: currentValue, model: `${view.brainModel}（不可用）`, channelName: "当前设置" }];
  }, [brains, view?.brainChannelId, view?.brainModel]);

  // 对话完成但窗口在后台时，闪任务栏并挂一个「1」角标；用户回到窗口后清掉
  const previousStatusRef = useRef(status);
  useEffect(() => {
    const previous = previousStatusRef.current;
    previousStatusRef.current = status;
    if ((previous === "running" || previous === "waiting_task") && status === "idle") {
      void notifyCompletion();
    }
  }, [status]);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      unlisten = await getCurrentWindow().onFocusChanged(({ payload }) => {
        if (payload) void clearCompletionBadge();
      });
    }).catch(() => undefined);
    return () => unlisten?.();
  }, []);

  const running = status === "running";
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  /**
   * 最后一条「用户/助手」消息的 id。
   *
   * 只有它可能是「还没被回答的问题」——用它来判断 ask 的选项按钮该不该出现。
   * 系统提示（自动续跑停下之类）不算回答，所以要跳过。
   */
  const lastAnswerableId = useMemo(() => {
    const messages = view?.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.role === "user" || message.role === "assistant") return message.id;
    }
    return null;
  }, [view?.messages]);

  /** 侧栏搜索：标题和最后一条消息都算，记得住哪句就搜得到 */
  const filteredList = useMemo(() => {
    const query = sidebarFilter.trim().toLowerCase();
    if (!query) return list;
    return list.filter((item) => `${item.title} ${item.lastMessage}`.toLowerCase().includes(query));
  }, [list, sidebarFilter]);

  /**
   * `onToast` 是 App 里现写的箭头函数，**每次 App 渲染都是新的函数身份**。
   * 直接让它进下面那些 `useCallback` 的依赖数组，会让 SSE 那个 effect 每渲染一次就
   * 断线重连一次（重连又会触发 onOpen 的全量拉取），变成一场请求风暴。
   * 用 ref 固定住调用目标，对外只暴露一个身份稳定的 `toast`。
   */
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;
  /**
   * 模型面板是个原生 `<details>`：点外面它不会自己收（浏览器不管这个）。
   * 用户遇到的就是「这个页面打开后点其他地方关不掉」。这里的处理是**直接改 DOM 的 open**，
   * 不引入一份受控状态——面板里还有两个 select 和长列表，没必要为开关多绕一圈 state。
   */
  const capsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const closeOnOutside = (event: MouseEvent) => {
      const node = capsRef.current;
      if (!node?.open) return;
      if (event.target instanceof Node && node.contains(event.target)) return;
      node.open = false;
    };
    document.addEventListener("mousedown", closeOnOutside);
    return () => document.removeEventListener("mousedown", closeOnOutside);
  }, []);
  const toast = useCallback((kind: "ok" | "error", text: string) => onToastRef.current(kind, text), []);

  /**
   * 侧栏的「新对话」：点一下要真的开一条新会话，而不是切回上次那条。
   *
   * 处理完立刻把信号归零。不归零的话，切到别的视图再切回来、组件重新挂载时，
   * 那个还留着的信号会让它又建一条——用户会看见侧栏自己多出一条空会话。
   * `createConversation` 是组件内的函数声明（会被提升），故意不进依赖数组：
   * 它每次渲染都是新身份，放进去等于信号一来就重跑。
   */
  const onNewChatHandledRef = useRef(onNewChatHandled);
  onNewChatHandledRef.current = onNewChatHandled;
  useEffect(() => {
    if (newChatSignal <= 0) return;
    onNewChatHandledRef.current?.();
    void createConversation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newChatSignal]);

  // ── 数据加载 ───────────────────────────────────────────────────────────────

  const toastError = useCallback((error: unknown) => {
    toast("error", error instanceof Error ? error.message : "出错了");
  }, [toast]);

  const reloadList = useCallback(async () => {
    try {
      const next = await api.conversations();
      setList(next);
      return next;
    } catch (error) {
      toastError(error);
      return [];
    }
  }, [toastError]);

  /**
   * 「最后发出的写/读赢」的序号。
   *
   * 之前只有「切走了就别写回」这一道保护，挡不住**同一会话**里乱序的两份快照：
   * 用户点一下「原话直发」（PATCH），正好撞上 SSE 的 done 触发的那次 GET——
   * 那次 GET 是在 PATCH 落库**之前**发出的，拿回来的是旧值，却后到、于是把开关又摁了回去。
   * 用户的感受就是「这个开关有时候切换不生效」。
   *
   * 每次发起写或读都领一个号，回来时号不是最新的就丢掉。
   */
  const viewSeq = useRef(0);

  const reloadView = useCallback(async (id: string) => {
    const seq = ++viewSeq.current;
    try {
      const next = await api.conversation(id);
      // 期间用户可能已经切走了，别把旧会话的内容写回来
      if (activeIdRef.current !== id) return;
      // 有更新的读/写发出去了，这份是旧快照
      if (seq !== viewSeq.current) return;
      setView(next);
      setStatus(next.running ? "running" : next.status);
    } catch (error) {
      // 这个会话没了（在别处删掉、或者本窗口刚删）：把指针放掉。
      // 否则已死的 id 会一直被 SSE 重连和 onOpen 拉取，用户反复看到「会话不存在」
      if (error instanceof ApiError && error.status === 404) {
        if (activeIdRef.current === id) {
          localStorage.removeItem(STORAGE_KEY);
          setActiveId(null);
          void reloadList();
        }
        return;
      }
      toastError(error);
    }
  }, [toastError, reloadList]);

  // 首次进入：列出会话和可用能力，恢复上次打开的那一个
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [conversations, caps, settings] = await Promise.all([
        reloadList(),
        api.capabilities().catch(() => ({ manifest: "", aliases: [] })),
        api.settings().catch(() => null),
      ]);
      if (cancelled) return;
      setCapabilities(caps.aliases);
      if (settings) setDefaults({
        image: settings.defaultImageAlias,
        video: settings.defaultVideoAlias,
        music: settings.defaultMusicAlias,
        speech: settings.defaultSpeechAlias,
      });
      const remembered = localStorage.getItem(STORAGE_KEY);
      const pick = conversations.find((item) => item.id === remembered) ?? conversations[0];
      // 记着的那个已经没了（多半是在别处删的），顺手把指针抹掉；
      // 否则它会一直躺在 localStorage 里，下次启动还要再白找一遍
      if (pick) setActiveId(pick.id);
      else if (remembered) localStorage.removeItem(STORAGE_KEY);
    })();
    return () => { cancelled = true; };
  }, [reloadList]);

  // 右键菜单：点外面、按 Esc、滚动或窗口尺寸变化都收起
  useEffect(() => {
    if (!convMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!convMenuRef.current?.contains(event.target as Node)) setConvMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setConvMenu(null); };
    const close = () => setConvMenu(null);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [convMenu]);

  // 切换会话：拉全量 + 开 SSE
  useEffect(() => {
    if (!activeId) { setView(null); setStatus("idle"); return; }
    localStorage.setItem(STORAGE_KEY, activeId);
    setReasoning("");
    setDraft("");
    setProgress({});
    void reloadView(activeId);

    const onEvent = (event: AgentStreamEvent) => {
      switch (event.type) {
        case "reasoning":
          setReasoning((current) => current + event.text);
          break;
        case "token":
          setDraft((current) => current + event.text);
          break;
        case "reset":
          // 这一轮要重来：把上一段的流式内容丢掉，别和重试后的正文拼在一起
          setReasoning("");
          setDraft("");
          break;
        case "status":
          setStatus(event.status);
          break;
        case "message":
          setView((current) => {
            if (!current || current.id !== event.message.conversationId) return current;
            // 这一轮的正文已经落库了，临时气泡就该让位
            if (event.message.role === "assistant") { setReasoning(""); setDraft(""); }
            return { ...current, messages: upsert(current.messages, event.message) };
          });
          // 刚拆完镜就把面板打开：用户下一步一定是看描述、点生成
          if ((event.message.toolName === "create_storyboard" || event.message.toolName === "tag_storyboard_characters") && event.message.status === "ok") {
            setStoryboardOpen(true);
          }
          break;
        case "progress":
          setProgress((current) => ({ ...current, [event.taskId]: { status: event.status, progress: event.progress } }));
          break;
        case "error":
          toast("error", event.message);
          break;
        case "done":
          setStatus(event.status);
          setReasoning("");
          setDraft("");
          // 画布指针、任务额度这些都不在事件里，落定后拉一次最稳
          void reloadView(activeId);
          void reloadList();
          break;
        default:
          break;
      }
    };

    // 断线重连成功后补齐错过的消息：EventSource 自己会重试，我们只管在连上时对齐
    return api.openConversationStream(activeId, {
      onEvent,
      onOpen: () => { void reloadView(activeId); },
    });
    // toast / reloadList / reloadView 现在都是身份稳定的，这个 effect 只在换会话时重开
  }, [activeId, reloadView, reloadList, toast]);

  /**
   * 滚动跟随。
   *
   * 「强制到底」的标记用会话 id 表示，**不自动清除**：内容是一路异步到的
   * （先来消息、再来缩略图），提前清掉就会停在半路——这正是以前「切会话有时
   * 不滚到最新」的原因（新会话比旧会话长时，旧位置不算贴近底部）。
   * 现在只有三种情况会松开：换会话、发送新指令（重新锁上）、用户自己往上翻。
   * 同一会话里的新消息仍然只在贴近底部时跟随，用户正翻历史时不打扰。
   */
  const forcedScrollConversation = useRef<string | null>(null);
  useEffect(() => { forcedScrollConversation.current = activeId; }, [activeId]);

  useEffect(() => {
    const node = threadRef.current;
    if (!node) return;
    const forced = Boolean(activeId) && forcedScrollConversation.current === activeId;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 160;
    if (forced || nearBottom) node.scrollTop = node.scrollHeight;
    // 依赖里带 view.id：切会话时旧视图还在，等新视图真正挂上要再滚一次
  }, [activeId, view?.id, view?.messages.length, draft, reasoning, status]);

  /**
   * 图片 / 缩略图加载完会让内容变高，但消息数组没变。
   * 观察内层内容的高度，强制模式下每次都重新贴到底——否则切进一个带图的会话，
   * 图出来之后人又会被留在半空。
   */
  useEffect(() => {
    const node = threadRef.current;
    const inner = threadInnerRef.current;
    if (!node || !inner) return;
    const observer = new ResizeObserver(() => {
      if (forcedScrollConversation.current === activeId) node.scrollTop = node.scrollHeight;
    });
    observer.observe(inner);
    return () => observer.disconnect();
    // view.id 要进依赖：首次进来时 view 还是 null，内层节点根本不存在；
    // 只盯 activeId 的话观察器永远挂不上去
  }, [activeId, view?.id]);

  /** 用户主动往回翻 = 不再跟着最新消息走（往下滚不解除，只有向上才解除） */
  const touchY = useRef(0);
  function onThreadWheel(event: React.WheelEvent<HTMLDivElement>) {
    if (event.deltaY < 0) forcedScrollConversation.current = null;
  }
  function onThreadTouchStart(event: React.TouchEvent<HTMLDivElement>) {
    touchY.current = event.touches[0]?.clientY ?? 0;
  }
  function onThreadTouchMove(event: React.TouchEvent<HTMLDivElement>) {
    const y = event.touches[0]?.clientY ?? touchY.current;
    // 手指往下划（clientY 变大）= 在看更早的消息
    if (y > touchY.current + 4) forcedScrollConversation.current = null;
  }

  // ── 操作 ───────────────────────────────────────────────────────────────────

  async function createConversation() {
    if (!brains.length) { onToast("error", "先在「模型配置」里加一个对话模型，助手才有大脑"); return; }
    try {
      const created = await api.createConversation({});
      await reloadList();
      setActiveId(created.id);
    } catch (error) {
      toastError(error);
    }
  }

  async function send(text: string, assetRefs: string[] = []) {
    if (!activeId) return;
    // 画布是「这一轮要带的图」：连同拖进来的产物一起写进这条消息，
    // 这样发完清空画布也不会影响助手这一轮看到的图。
    const refs = [...new Set([...(viewRef.current?.canvasAssetIds ?? []), ...assetRefs])];
    // 发了新指令就盯住最新：即使用户之前翻在历史里，也要把这一轮的开头和结果带到他眼前
    forcedScrollConversation.current = activeId;
    setReasoning("");
    setDraft("");
    try {
      await api.sendMessage(activeId, text, refs);
      setStatus("running");
      if (refs.length) writeCanvas([]);
    } catch (error) {
      toastError(error);
      setDraft("");
    }
  }

  async function interrupt() {
    if (!activeId) return;
    try { await api.interruptConversation(activeId); } catch (error) { toastError(error); }
  }

  async function patch(patchBody: Parameters<typeof api.updateConversation>[1]) {
    if (!activeId) return;
    // 先领号：这一下写出去之后，在途的旧 GET 就作废了（见 viewSeq 的注释）
    const seq = ++viewSeq.current;
    try {
      const next = await api.updateConversation(activeId, patchBody);
      if (seq !== viewSeq.current) return;
      setView(next);
    } catch (error) {
      toastError(error);
    }
  }

  /**
   * 画布的写路径。**故意不走 `patch()`**，两个原因：
   *
   * 1. `patch()` 会把服务端返回的整份 view 回灌 `setView`。连点时两个请求的返回顺序不保证，
   *    先发后到的那份会把后一次的落点覆盖回去——画布只有一个写者、服务端也不做额外加工，
   *    乐观值就是最终值，不需要回灌。
   * 2. 单击「加入/移出画布」和双击「看大图」是同一个按钮：原生双击前必先发两次 click，
   *    不防抖就会发出两次 PATCH，第二次基于**旧**的 ids 算，把用户刚加的又减掉。
   */
  const canvasPatchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function writeCanvas(ids: string[]) {
    setView((current) => (current ? { ...current, canvasAssetIds: ids } : current));
    if (!activeId) return;
    if (canvasPatchTimer.current) clearTimeout(canvasPatchTimer.current);
    const target = activeId;
    canvasPatchTimer.current = setTimeout(() => {
      canvasPatchTimer.current = null;
      void api.updateConversation(target, { canvasAssetIds: ids }).catch((error) => {
        toastError(error);
        // 服务端没落上，乐观值就是错的——拉回真相，别让用户对着一个假的画布继续说话
        void reloadView(target);
      });
    }, CANVAS_PATCH_DEBOUNCE_MS);
  }

  /** 素材库单击：在画布里就移出，不在就加到末尾（参考图） */
  function toggleCanvasSelection(assetId: string) {
    const current = viewRef.current?.canvasAssetIds ?? [];
    if (current.includes(assetId)) {
      writeCanvas(current.filter((id) => id !== assetId));
      return;
    }
    if (current.length >= MAX_CANVAS_IMAGES) {
      toast("error", `画布最多 ${MAX_CANVAS_IMAGES} 张，先移出一张再加`);
      return;
    }
    writeCanvas([...current, assetId]);
  }

  /** 设为首帧：移到画布第 1 位；不在画布里就加进来 */
  function setCanvasFirst(assetId: string) {
    if (!view) return;
    const ids = view.canvasAssetIds.filter((id) => id !== assetId);
    const next = [assetId, ...ids].slice(0, MAX_CANVAS_IMAGES);
    if (next.length < ids.length + 1) toast("error", `画布最多 ${MAX_CANVAS_IMAGES} 张，最后一张被移出了`);
    writeCanvas(next);
    toast("ok", "已设为首帧");
  }

  /** 设为尾帧：放到画布第 2 位；画布为空时先把它加进来 */
  function setCanvasLast(assetId: string) {
    if (!view) return;
    const current = view.canvasAssetIds;
    if (!current.length) {
      writeCanvas([assetId]);
      toast("ok", "已加入画布；再选一张设为首帧");
      return;
    }
    if (current.length === 1 && current[0] === assetId) {
      toast("error", "这已经是唯一一张，先再选一张首帧");
      return;
    }
    const without = current.filter((id) => id !== assetId);
    const next = [without[0]!, assetId, ...without.slice(1)].slice(0, MAX_CANVAS_IMAGES);
    writeCanvas(next);
    toast("ok", "已设为尾帧");
  }

  function addCanvasBatch(assetIds: string[]) {
    if (!view || !assetIds.length) return;
    const current = view.canvasAssetIds;
    const additions = assetIds.filter((id) => !current.includes(id));
    const room = Math.max(0, MAX_CANVAS_IMAGES - current.length);
    if (!additions.length) return;
    writeCanvas([...current, ...additions.slice(0, room)]);
    if (additions.length > room) toast("error", `画布最多 ${MAX_CANVAS_IMAGES} 张，多的没有加入`);
  }

  function removeCanvasBatch(assetIds: string[]) {
    if (!view || !assetIds.length) return;
    const remove = new Set(assetIds);
    writeCanvas(view.canvasAssetIds.filter((id) => !remove.has(id)));
  }

  /**
   * 往会话里传图（需求.md 问题 4）。
   *
   * 服务端把新图顺手设成了当前画布并返回整份视图，所以这里直接就位——
   * 用户传完马上就能说「把这张图的手改成握着咖啡杯」，中间不用再点一次「设为当前」。
   */
  /**
   * 把图上传进会话（上传成功即成为当前画布）。
   *
   * 返回是否成功：发送那条路上要看它决定「图没传上去，这句话还要不要发」——
   * 图传失败还把话发出去，助手会对着上一张图改，用户看到的结果和说的完全不是一件事。
   */
  async function uploadImages(files: File[]): Promise<string[] | null> {
    if (!activeId || !files.length || uploading) return null;
    // 先在本地挡住明显不合规的：让用户当场知道哪里不对，比发出去等一个 400 强
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) { toast("error", "只支持 PNG、JPEG 或 WebP 图片"); return null; }
    if (images.length > MAX_REFERENCE_IMAGES) { toast("error", `一次最多上传 ${MAX_REFERENCE_IMAGES} 张`); return null; }
    const oversized = images.find((file) => file.size > MAX_REFERENCE_IMAGE_BYTES);
    if (oversized) { toast("error", `${oversized.name} 超过 10 MB`); return null; }

    setUploading(true);
    try {
      const next = await api.uploadConversationImages(activeId, images);
      setView(next);
      await reloadList();
      toast("ok", images.length > 1 ? `已上传 ${images.length} 张，已放入画布` : "已上传，已放入画布");
      // 返回新上传的产物 id：发送时要把它们一起写进这条消息
      return next.canvasAssetIds;
    } catch (error) {
      toastError(error);
      return null;
    } finally {
      setUploading(false);
    }
  }

  /**
   * 把脚本文档读成文本再上传。
   *
   * 读文件是异步的，所以这里单独占一个 `uploading` 窗口：发送按钮转圈，
   * 用户在读完之前不能再塞附件。任何一篇读失败都不发那句话——
   * 否则助手会以为「拆一下」指的是上一篇文档。
   */
  async function uploadDocuments(files: File[]): Promise<boolean> {
    if (!activeId || !files.length) return false;
    setUploading(true);
    try {
      const documents: Array<{ name: string; content: string }> = [];
      let total = 0;
      for (const file of files) {
        const content = (await file.text()).replace(/^﻿/, "").replace(/\0/g, "");
        if (!content.trim()) {
          toast("error", `${file.name} 是空的`);
          return false;
        }
        if (content.length > MAX_SCRIPT_CHARS) {
          toast("error", `${file.name} 超过 ${MAX_SCRIPT_CHARS.toLocaleString()} 字，请拆分后再传`);
          return false;
        }
        total += content.length;
        if (total > MAX_SCRIPT_TOTAL_CHARS) {
          toast("error", `脚本文档合计最多 ${MAX_SCRIPT_TOTAL_CHARS.toLocaleString()} 字，请拆分后再传`);
          return false;
        }
        documents.push({ name: file.name, content });
      }
      setView(await api.uploadConversationDocuments(activeId, documents));
      await reloadList();
      toast("ok", documents.length > 1 ? `已上传 ${documents.length} 个脚本文档` : `已上传《${documents[0]!.name}》`);
      return true;
    } catch (error) {
      toastError(error);
      return false;
    } finally {
      setUploading(false);
    }
  }

  /**
   * 立刻落画布（不走 250ms 防抖）。
   *
   * 平时连点是靠防抖合并的，但发送这一下必须**落定之后**才发消息：
   * 防抖还没触发就发出去，助手读到的还是旧画布——用户拖进来的图等于白拖。
   */
  async function flushCanvas(ids: string[]) {
    if (!activeId) return;
    if (canvasPatchTimer.current) { clearTimeout(canvasPatchTimer.current); canvasPatchTimer.current = null; }
    setView((current) => (current ? { ...current, canvasAssetIds: ids } : current));
    try {
      await api.updateConversation(activeId, { canvasAssetIds: ids });
    } catch (error) {
      toastError(error);
      await reloadView(activeId);
    }
  }

  /**
   * 发送：先把输入框里挂着的图交出去，再把这句发出去。
   *
   * 顺序不能反——图要在这句话之前成为当前画布，助手这一轮才看得见它。
   * 本地文件上传失败就不发，用户重新挑一张即可，别让助手对着上一张改；
   * 拖进来的既有产物不用上传，并进画布就行。
   */
  async function sendWithFiles(text: string, files: File[], assetIds: string[]) {
    // 图和文档分开传；文档放在最后，这样「文档消息 + 这句话」在库里是紧挨着的
    const images = files.filter((file) => !isScriptDocument(file));
    const documents = files.filter(isScriptDocument);
    const uploadedIds = images.length ? await uploadImages(images) : [];
    if (uploadedIds === null) return;
    if (documents.length && !(await uploadDocuments(documents))) return;
    // 本地新传的、拖进来的既有产物、画布里已经挑好的，合并成「这一轮要带的图」
    const base = viewRef.current?.canvasAssetIds ?? [];
    const merged = [...new Set([...base, ...uploadedIds, ...assetIds])].slice(0, MAX_CANVAS_IMAGES);
    if (merged.length) await flushCanvas(merged);
    // 引用的是哪几张也记在这句话上：画布条默认收着，只留文字的话回头根本看不出指的是哪张
    await send(text, merged);
  }

  async function removeConversation(id: string) {
    try {
      await api.deleteConversation(id);
      const next = await reloadList();
      if (id === activeId) setActiveId(next[0]?.id ?? null);
      void api.capabilities().then((caps) => setCapabilities(caps.aliases)).catch(() => undefined);
    } catch (error) {
      toastError(error);
    }
  }

  /** 右键会话行：显示应用内菜单，而不是 WebView 自带的「返回 / 刷新 / 检查」 */
  function openConversationMenu(event: React.MouseEvent, id: string) {
    event.preventDefault();
    event.stopPropagation();
    const width = 160;
    const height = 82;
    setConvMenu({
      id,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
    });
  }

  function beginRenameConversation(id: string) {
    const item = list.find((conversation) => conversation.id === id);
    if (!item) return;
    renameCancelRef.current = false;
    setRenameDraft(item.title || "");
    setRenamingId(id);
    setConvMenu(null);
  }

  /**
   * 改完立即写本地状态，再发 PATCH。
   * 不等服务端返回再刷列表——用户点完回车就该看到新名字，而不是等一次往返。
   */
  async function commitRenameConversation(id: string) {
    const title = renameDraft.trim() || DEFAULT_CONVERSATION_TITLE;
    setRenamingId(null);
    const current = list.find((conversation) => conversation.id === id);
    if (!current || current.title === title) return;
    setList((items) => items.map((item) => item.id === id ? { ...item, title } : item));
    setView((value) => value && value.id === id ? { ...value, title } : value);
    try {
      const next = await api.updateConversation(id, { title });
      // 服务端可能做了 trim/兜底，用它的最终值校正一次；不整份回灌 view
      if (next.title && next.title !== title) {
        setList((items) => items.map((item) => item.id === id ? { ...item, title: next.title } : item));
        setView((value) => value && value.id === id ? { ...value, title: next.title } : value);
      }
    } catch (error) {
      toastError(error);
      void reloadList();
      if (id === activeId) void reloadView(id);
    }
  }

  /** 确认卡片：改过的参数跟着这次确认一起提交，服务端才会用上新值 */
  async function resolveConfirm(messageId: string, decision: "approve" | "reject", args?: Partial<GenerateVideoArgs>) {
    if (!activeId) return;
    setBusy(true);
    try {
      await api.confirmMessage(activeId, messageId, decision, args as Record<string, unknown> | undefined);
      if (decision === "approve") setStatus("running");
    } catch (error) {
      toastError(error);
      void reloadView(activeId);
    } finally {
      setBusy(false);
    }
  }

  const rows = useMemo(() => (view ? buildRows(view.messages) : []), [view]);
  const hasStream = Boolean(reasoning || draft);
  /** 本会话出现过的全部图片（仓库，时间序）——下区渲染它 */
  const sessionImages = view?.sessionImages ?? [];
  const mediaAssets = view?.mediaAssets ?? [];
  /**
   * 画布那一组（参与下一步），`[0]` 是第 1 张——上区渲染它。
   *
   * **从 `canvasAssetIds` 现算，不直接用服务端发来的 `canvasImages`。** 点选是乐观更新的
   * （`writeCanvas` 先改本地、250ms 后再发 PATCH），而 PATCH 的响应刻意不回灌 view——连点时
   * 两个请求的返回顺序不保证，回灌会把后一次的落点覆盖回去。渲染跟着 `canvasAssetIds` 走，
   * 乐观值才看得见；跟着 `canvasImages` 走的话，点一下缩略图界面上**什么都不会变**，
   * 要等下一次 `reloadView`（生成、轮询）才补上——看起来就像点击失灵了。
   *
   * 过滤规则和服务端 `db.canvasImages` 对齐：查不到的 id、非图片都丢掉，
   * 否则历史页删掉一个任务之后，上区会多出一个裂图的空位。
   */
  const canvasImages = useMemo(() => {
    const ids = view?.canvasAssetIds ?? [];
    return ids
      .map((id) => mediaAssets.find((item) => item.asset.id === id)?.asset
        ?? sessionImages.find((item) => item.asset.id === id)?.asset)
      .filter((asset): asset is Asset => asset !== undefined && asset.mimeType.startsWith("image/"));
  }, [view?.canvasAssetIds, mediaAssets, sessionImages]);
  /**
   * 预览要在**全部**素材里找。只在 `sessionImages`（只有图）里找的话，视频的
   * assetId 永远查不到，灯箱就拿不到 mimeType、照旧当图片渲染——用户看到的是一个
   * 裂图加一条 `#711e ✕` 的 bar，这正是需求.md 问题 3 的现场。
   */
  const previewAsset = preview
    ? mediaAssets.find((item) => item.asset.id === preview)?.asset
      ?? sessionImages.find((item) => item.asset.id === preview)?.asset
      ?? null
    : null;
  const previewIsVideo = previewAsset?.mimeType.startsWith("video/") ?? false;
  const previewIsAudio = previewAsset?.mimeType.startsWith("audio/") ?? false;

  async function setDefaultAlias(group: DefaultModelGroup, alias: string) {
    const label: Record<DefaultModelGroup, string> = {
      image: "生图", video: "生视频", music: "音乐", speech: "语音",
    };
    try {
      const result = await api.updateSettings(
        group === "image" ? { agentDefaultImageAlias: alias }
          : group === "video" ? { agentDefaultVideoAlias: alias }
            : group === "music" ? { agentDefaultMusicAlias: alias }
              : { agentDefaultSpeechAlias: alias },
      );
      setDefaults({
        image: result.defaultImageAlias,
        video: result.defaultVideoAlias,
        music: result.defaultMusicAlias,
        speech: result.defaultSpeechAlias,
      });
      toast("ok", alias ? `默认${label[group]}模型已设为 ${alias}` : `默认${label[group]}模型已交回自动选择`);
    } catch (error) {
      toastError(error);
    }
  }

  return (
    <div className="chat-view">
      {/*
        会话列表搬进全局侧栏（portal 到 App 的 .sidebar-recent）。
        列表数据和 SSE 都长在这个组件里，把状态整个往上提的代价远大于挂一个 portal 节点；
        换来的是导航只剩侧栏一层——原来是「顶栏 + 页内侧栏」叠两层，Codex 只有一层。
      */}
      <ConversationSidebar
        host={sidebarHost}
        conversations={filteredList}
        activeId={activeId}
        renamingId={renamingId}
        renameDraft={renameDraft}
        filter={sidebarFilter}
        onSelect={setActiveId}
        onCreate={() => void createConversation()}
        onDelete={(id) => void removeConversation(id)}
        onContextMenu={openConversationMenu}
        onRenameChange={setRenameDraft}
        onRenameCommit={(id) => void commitRenameConversation(id)}
        onRenameCancel={() => { renameCancelRef.current = true; setRenamingId(null); }}
      />

      {convMenu ? createPortal(
        <div
          ref={convMenuRef}
          className="sidebar-conv-menu"
          role="menu"
          aria-label="会话操作"
          style={{ left: convMenu.x, top: convMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button type="button" role="menuitem" onClick={() => beginRenameConversation(convMenu.id)}>重命名</button>
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              const id = convMenu.id;
              setConvMenu(null);
              void removeConversation(id);
            }}
          >
            删除会话
          </button>
        </div>,
        document.body,
      ) : null}

      <section className="chat-main">
        {!view ? (
          <div className="chat-blank">
            {brains.length ? (
              <>
                <Wand2 size={22} />
                <h2>对话式创作</h2>
                <p>建一个会话就能直接说：</p>
                <ul>
                  <li>「画一只戴草帽的橘猫，水彩风」——自动挑合适的模型</li>
                  <li>「把它手里的东西换成咖啡杯」——看着当前这张图改</li>
                  <li>「刚才那张做成 5 秒视频，镜头慢慢推近」——接着上一张往下走</li>
                </ul>
                <button type="button" className="primary-button" onClick={() => void createConversation()}>
                  <MessageSquarePlus size={14} />新建会话
                </button>
              </>
            ) : (
              <>
                <Brain size={22} />
                <h2>还没有可以用来当大脑的模型配置</h2>
                <p>助手需要走 chat completions 协议的对话模型。到「模型配置」加一个对话模型，填好 Base URL、模型 ID 和 Key，再回来这里。</p>
              </>
            )}
          </div>
        ) : (
          <>
            <header className="chat-header">
              <input
                className="chat-title"
                value={view.title}
                placeholder="未命名会话"
                onChange={(event) => setView({ ...view, title: event.target.value })}
                onBlur={(event) => void patch({ title: event.target.value.trim() || DEFAULT_CONVERSATION_TITLE })}
              />
              {/* 头部只留「这个会话是什么」；模型、确认策略这些「我这次要用什么」都在输入框那一行 */}
              <div className="chat-header-controls">
                <button
                  type="button"
                  className={`chat-control chat-toggle ${storyboardOpen ? "is-on" : ""}`}
                  title={view.storyboardCount ? "展开分镜表：逐镜改描述、确认后生成" : "还没有分镜：上传剧本后让助手「拆成分镜」"}
                  onClick={() => setStoryboardOpen((open) => !open)}
                >
                  <Clapperboard size={13} />
                  分镜{view.storyboardCount ? ` ${view.storyboardCount}` : ""}
                </button>

                <button
                  type="button"
                  className="chat-control chat-toggle"
                  title="打开素材库：筛选、搜索、批量选图，设为首帧 / 尾帧"
                  onClick={() => setLibraryOpen(true)}
                >
                  <Images size={13} />
                  素材 {sessionImages.length}
                </button>

                <button
                  type="button"
                  className={`chat-control chat-toggle ${view.visionEnabled ? "is-on" : ""}`}
                  title={view.visionEnabled ? "助手能看到当前画布，改图更准" : "助手看不到图，只按你的描述改"}
                  onClick={() => void patch({ visionEnabled: !view.visionEnabled })}
                >
                  {view.visionEnabled ? <Eye size={13} /> : <EyeOff size={13} />}
                  {view.visionEnabled ? "看图改" : "盲改"}
                </button>

                {capabilities.length ? (
                  <ModelPanel
                    capabilities={capabilities}
                    defaults={defaults}
                    channels={channels}
                    capsRef={capsRef}
                    onSetDefaultAlias={setDefaultAlias}
                    onConfigureChannel={onConfigureChannel}
                  />
                ) : null}
              </div>
            </header>

            <div
              className="chat-thread"
              ref={threadRef}
              onWheel={onThreadWheel}
              onTouchStart={onThreadTouchStart}
              onTouchMove={onThreadTouchMove}
            >
              <div className="chat-thread-inner" ref={threadInnerRef}>
              {!rows.length && !hasStream ? (
                <div className="chat-thread-empty">
                  <p>说一句话开始。它会自己决定是画图、改图、优化提示词，还是接着上一张生成视频。</p>
                </div>
              ) : null}

              {rows.map((row) => {
                if (row.kind === "user") return <UserBubble key={row.message.id} message={row.message} onPreview={setPreview} />;
                if (row.kind === "note") return <SystemNote key={row.message.id} message={row.message} />;
                if (row.kind === "assistant") {
                  // 「还没被回答的那一条」才给按钮：翻回去看老记录时，那些选项早就失效了
                  const options = row.message.id === lastAnswerableId ? readAskOptions(row.message) : [];
                  return (
                    <AssistantBubble
                      key={row.message.id}
                      message={row.message}
                      options={options}
                      disabled={running}
                      onPick={(text) => void send(text)}
                    />
                  );
                }
                if (row.kind === "confirm") {
                  // 卡片上的参数是用户能改的；改完随确认一起提交
                  return (
                    <ConfirmCard
                      key={row.message.id}
                      message={row.message}
                      preview={row.preview}
                      busy={busy || running}
                      onApprove={(patchArgs) => void resolveConfirm(row.message.id, "approve", patchArgs)}
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
                    assets={mediaAssets}
                    onPreview={setPreview}
                    onDiagnostics={onDiagnostics}
                    onToast={toast}
                  />
                );
              })}

              {hasStream ? <StreamingBubble reasoning={reasoning} content={draft} /> : null}

              {status === "waiting_task" ? (
                <div className="chat-note"><LoaderCircle size={13} className="spin" /><span>视频在后台生成，好了我接着处理</span></div>
              ) : null}
              </div>
            </div>

            {/*
              画布条默认收起（Codex 里根本没有这一条——它靠「接着上一张说」和「把图拖进输入框」
              完成同一件事）。开关放在会话头，徽标上带着张数，需要挑图时点一下就有。
              没有图的时候整条不出现：一条「还没有图」的空条只会占地方。
            */}
            {storyboardOpen ? (
              <StoryboardPanel
                conversationId={view.id}
                refreshKey={
                  // 消息数变化之外，拆分镜工具落定那一刻也要刷新：
                  // 工具行先以 pending 落库、执行完再改成 ok，中间消息数不变
                  view.messages.length
                  + view.messages.filter((message) => (message.toolName === "create_storyboard" || message.toolName === "tag_storyboard_characters") && message.status === "ok").length
                }
                canvasIds={canvasImages.map((asset) => asset.id)}
                images={sessionImages}
                capabilities={capabilities}
                defaultImageAlias={defaults.image}
                onClose={() => setStoryboardOpen(false)}
                onToast={toast}
                onAddToCanvas={(assetId) => {
                  if (canvasImages.some((asset) => asset.id === assetId)) return;
                  if (canvasImages.length >= MAX_CANVAS_IMAGES) {
                    toast("error", `画布最多 ${MAX_CANVAS_IMAGES} 张，先移出一张再加`);
                    return;
                  }
                  writeCanvas([...canvasImages.map((asset) => asset.id), assetId]);
                  toast("ok", "已加入画布");
                }}
                onTagCharacters={() => {
                  void send("请根据当前分镜表，为每一镜标注出场角色和场景：同一个人物 / 同一个地点全片用同一个名字，多个人物用「、」连接；空镜、道具、字幕的角色留空，但场景尽量标。顺便给每个角色一句外貌/服装描述、每个场景一句空间/光线描述。用 tag_storyboard_characters 更新现有分镜，不要重新拆分，也不要重新生成。");
                }}
                tagCharactersDisabled={running}
              />
            ) : null}

            <Composer
              running={running}
              uploading={uploading}
              placeholder={canvasImages.length
                ? canvasImages.length > 1
                  ? `画布 ${canvasImages.length} 张（① 首帧 ${assetRef(canvasImages[0]!.id)} / ② 尾帧${canvasImages[1] ? ` ${assetRef(canvasImages[1].id)}` : ""}${canvasImages.length > 2 ? " / 其余参考" : ""}），直接说怎么改…`
                  : `画布 1 张（① 首帧 / 主图 ${assetRef(canvasImages[0]!.id)}），直接说怎么改…`
                : "说你想画什么，或者要改哪张图…"}
              leftSlot={(
                <>
                  {/*
                    「原话直发」：平时大脑会把口语扩写成完整画面（默认就该这样，效果更好），
                    但有些人是带着自己攒了很久的提示词来的，被「优化」一下反而不是他要的。
                    开关交给他自己，开了就是逐字透传。
                  */}
                  <button
                    type="button"
                    className={`chat-control chat-toggle ${view.verbatimPrompt ? "is-on" : ""}`}
                    title={view.verbatimPrompt
                      ? "正在原话直发：你写什么就发什么，助手不润色"
                      : "开启后助手把你的话原样当提示词发出去，不润色、不扩写"}
                    onClick={() => void patch({ verbatimPrompt: !view.verbatimPrompt })}
                  >
                    <PenLine size={13} />
                    原话直发
                  </button>
                  <label className="chat-control" title="生成视频前要不要先问一句">
                    <Film size={13} />
                    <select
                      value={view.videoConfirmPolicy}
                      onChange={(event) => void patch({ videoConfirmPolicy: event.target.value as VideoConfirmPolicy })}
                    >
                      {VIDEO_CONFIRM_POLICIES.map((policy) => (
                        <option key={policy} value={policy}>{videoConfirmPolicyLabels[policy]}</option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              rightSlot={(
                <ModelPicker
                  options={brainOptions}
                  value={`${view.brainChannelId}::${view.brainModel}`}
                  onChange={(next) => {
                    const [brainChannelId, brainModel] = next.split("::");
                    void patch({ brainChannelId: brainChannelId ?? "", brainModel: brainModel ?? "" });
                  }}
                />
              )}
              statusSlot={view.usage?.calls ? (
                <span
                  className="composer-stats"
                  title={[
                    `上下文：最近一次大脑请求的输入 ${view.usage.contextTokens.toLocaleString()} tokens`,
                    `本会话累计输入 ${view.usage.promptTokens.toLocaleString()} tokens`,
                    `本会话累计输出 ${view.usage.completionTokens.toLocaleString()} tokens`,
                    view.usage.reasoningTokens
                      ? `其中推理 ${view.usage.reasoningTokens.toLocaleString()} tokens（已包含在输出里）`
                      : "",
                    `共 ${view.usage.calls} 次大脑调用`,
                  ].filter(Boolean).join("\n")}
                >
                  上下文 {formatTokenCount(view.usage.contextTokens)}
                  <span className="composer-stats-sep">·</span>
                  本会话 输入 {formatTokenCount(view.usage.promptTokens)} / 输出 {formatTokenCount(view.usage.completionTokens)}
                </span>
              ) : undefined}
              onSend={(text, files, assetIds) => void sendWithFiles(text, files, assetIds)}
              onInterrupt={() => void interrupt()}
              onAssetAttached={(assetId) => addCanvasBatch([assetId])}
              canvasItems={canvasImages.map((asset, index) => ({ asset, index }))}
              onPreviewCanvas={setPreview}
              onRemoveCanvas={(assetId) => removeCanvasBatch([assetId])}
              onSetCanvasFirst={setCanvasFirst}
              onSetCanvasLast={setCanvasLast}
            />
          </>
        )}
      </section>

      <AssetLibrary
        open={libraryOpen}
        assets={sessionImages}
        canvasIds={canvasImages.map((asset) => asset.id)}
        onClose={() => setLibraryOpen(false)}
        onPreview={setPreview}
        onToggleCanvas={toggleCanvasSelection}
        onSetFirst={setCanvasFirst}
        onSetLast={setCanvasLast}
      />

      {preview ? (
        <AssetLightbox
          assetId={preview}
          asset={previewAsset}
          onClose={() => setPreview(null)}
          onToast={toast}
          onSetFirst={setCanvasFirst}
          onSetLast={setCanvasLast}
          onAddToCanvas={(assetId) => addCanvasBatch([assetId])}
          onRemoveFromCanvas={(assetId) => removeCanvasBatch([assetId])}
          inCanvas={Boolean(view?.canvasAssetIds.includes(preview))}
        />
      ) : null}
    </div>
  );
}
