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
  Brain, Eye, EyeOff, Film, Info, ListTree, LoaderCircle, MessageSquarePlus, Trash2, Wand2, X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MAX_CANVAS_IMAGES, MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES, isChatAdapter } from "../shared/types";
import type { Asset, Channel } from "../shared/types";
import {
  assetRef, videoConfirmPolicyLabels, VIDEO_CONFIRM_POLICIES, type AgentStreamEvent,
  type ChatMessage, type ConversationStatus, type ConversationSummary,
  type ConversationView, type GenerateVideoArgs, type VideoConfirmPolicy,
} from "../shared/agent-types";
import { api, ApiError } from "./api";
import { AssetStrip } from "./chat/AssetStrip";
import { Composer } from "./chat/Composer";
import { ConfirmCard } from "./chat/ConfirmCard";
import { AssistantBubble, StreamingBubble, SystemNote, UserBubble } from "./chat/MessageBubble";
import { buildRows } from "./chat/rows";
import { ToolCard, type TaskProgress } from "./chat/ToolCard";

const STORAGE_KEY = "yida.agent.lastConversation";

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
  onToast,
}: {
  channels: Channel[];
  onToast: (kind: "ok" | "error", text: string) => void;
}) {
  const brains = useMemo(() => channels.filter((channel) => isChatAdapter(channel.adapterType) && channel.enabled), [channels]);

  const [list, setList] = useState<Array<ConversationSummary & { running: boolean }>>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<ConversationView | null>(null);
  const [status, setStatus] = useState<ConversationStatus>("idle");
  const [reasoning, setReasoning] = useState("");
  const [draft, setDraft] = useState("");
  const [progress, setProgress] = useState<Record<string, TaskProgress>>({});
  const [capabilities, setCapabilities] = useState<Array<{ alias: string; kind: "image" | "video"; model: string; channelName: string }>>([]);
  /** 默认生图 / 生视频模型（需求.md 问题 5），空串表示不指定、用类目里第一个 */
  const [defaults, setDefaults] = useState({ image: "", video: "" });
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 正在上传自己带的图（需求.md 问题 4）：传的时候不让再点一次 */
  const [uploading, setUploading] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);

  const running = status === "running";
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  /**
   * `onToast` 是 App 里现写的箭头函数，**每次 App 渲染都是新的函数身份**。
   * 直接让它进下面那些 `useCallback` 的依赖数组，会让 SSE 那个 effect 每渲染一次就
   * 断线重连一次（重连又会触发 onOpen 的全量拉取），变成一场请求风暴。
   * 用 ref 固定住调用目标，对外只暴露一个身份稳定的 `toast`。
   */
  const onToastRef = useRef(onToast);
  onToastRef.current = onToast;
  const toast = useCallback((kind: "ok" | "error", text: string) => onToastRef.current(kind, text), []);

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

  const reloadView = useCallback(async (id: string) => {
    try {
      const next = await api.conversation(id);
      // 期间用户可能已经切走了，别把旧会话的内容写回来
      if (activeIdRef.current !== id) return;
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
      if (settings) setDefaults({ image: settings.defaultImageAlias, video: settings.defaultVideoAlias });
      const remembered = localStorage.getItem(STORAGE_KEY);
      const pick = conversations.find((item) => item.id === remembered) ?? conversations[0];
      // 记着的那个已经没了（多半是在别处删的），顺手把指针抹掉；
      // 否则它会一直躺在 localStorage 里，下次启动还要再白找一遍
      if (pick) setActiveId(pick.id);
      else if (remembered) localStorage.removeItem(STORAGE_KEY);
    })();
    return () => { cancelled = true; };
  }, [reloadList]);

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

  // 新消息进来滚到底；用户手动往上翻的时候不打扰（只在贴近底部时跟随）
  useEffect(() => {
    const node = threadRef.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 160;
    if (nearBottom) node.scrollTop = node.scrollHeight;
  }, [view?.messages.length, draft, reasoning]);

  // ── 操作 ───────────────────────────────────────────────────────────────────

  async function createConversation() {
    if (!brains.length) { onToast("error", "先在「渠道配置」里加一个对话渠道，助手才有大脑"); return; }
    try {
      const created = await api.createConversation({});
      await reloadList();
      setActiveId(created.id);
    } catch (error) {
      toastError(error);
    }
  }

  async function send(text: string) {
    if (!activeId) return;
    setReasoning("");
    setDraft("");
    try {
      await api.sendMessage(activeId, text);
      setStatus("running");
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
    try {
      const next = await api.updateConversation(activeId, patchBody);
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

  /** 点一张图：在画布里就移出，不在就加到**末尾**（顺序就是主图顺序） */
  function toggleCanvas(assetId: string) {
    if (!view) return;
    const ids = view.canvasAssetIds;
    const next = ids.includes(assetId) ? ids.filter((id) => id !== assetId) : [...ids, assetId];
    if (next.length > MAX_CANVAS_IMAGES) {
      toast("error", `画布最多 ${MAX_CANVAS_IMAGES} 张，先移出一张再加`);
      return;
    }
    writeCanvas(next);
  }

  /** 把某张提到 `[0]`：主图决定视频首帧和助手默认改的那张 */
  function promoteCanvas(assetId: string) {
    if (!view) return;
    const ids = view.canvasAssetIds;
    if (!ids.includes(assetId) || ids[0] === assetId) return;
    writeCanvas([assetId, ...ids.filter((id) => id !== assetId)]);
  }

  /**
   * 往会话里传图（需求.md 问题 4）。
   *
   * 服务端把新图顺手设成了当前画布并返回整份视图，所以这里直接就位——
   * 用户传完马上就能说「把这张图的手改成握着咖啡杯」，中间不用再点一次「设为当前」。
   */
  async function uploadImages(files: File[]) {
    if (!activeId || !files.length || uploading) return;
    // 先在本地挡住明显不合规的：让用户当场知道哪里不对，比发出去等一个 400 强
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (!images.length) { toast("error", "只支持 PNG、JPEG 或 WebP 图片"); return; }
    if (images.length > MAX_REFERENCE_IMAGES) { toast("error", `一次最多上传 ${MAX_REFERENCE_IMAGES} 张`); return; }
    const oversized = images.find((file) => file.size > MAX_REFERENCE_IMAGE_BYTES);
    if (oversized) { toast("error", `${oversized.name} 超过 10 MB`); return; }

    setUploading(true);
    try {
      setView(await api.uploadConversationImages(activeId, images));
      await reloadList();
      toast("ok", images.length > 1 ? `已上传 ${images.length} 张，已放入画布` : "已上传，现在是当前画布");
    } catch (error) {
      toastError(error);
    } finally {
      setUploading(false);
    }
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
   * 画布那一组（参与下一步），`[0]` 是主图——上区渲染它。
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

  const imageAliases = capabilities.filter((cap) => cap.kind === "image");
  const videoAliases = capabilities.filter((cap) => cap.kind === "video");
  /**
   * 「现在实际会用哪个」——优先级和 `resolveAlias` 保持一致：
   * 你设的默认值还在能力表里就用它，否则就是类目里第一个。
   * 列表里标出这一条，用户才不会对着「我设了 A 但它用了 B」发愣。
   */
  function effectiveAlias(configured: string, aliases: typeof capabilities) {
    return aliases.some((cap) => cap.alias === configured) ? configured : aliases[0]?.alias ?? "";
  }

  async function setDefaultAlias(kind: "image" | "video", alias: string) {
    const label = kind === "image" ? "生图" : "生视频";
    try {
      const result = await api.updateSettings(
        kind === "image" ? { agentDefaultImageAlias: alias } : { agentDefaultVideoAlias: alias },
      );
      setDefaults({ image: result.defaultImageAlias, video: result.defaultVideoAlias });
      toast("ok", alias ? `默认${label}模型已设为 ${alias}` : `默认${label}模型已交回自动选择`);
    } catch (error) {
      toastError(error);
    }
  }

  return (
    <div className="chat-view">
      <aside className="chat-sidebar">
        <div className="chat-sidebar-head">
          <button type="button" className="primary-button" onClick={() => void createConversation()}>
            <MessageSquarePlus size={14} />新建会话
          </button>
        </div>
        <div className="chat-sidebar-list">
          {list.length ? list.map((item) => (
            <div key={item.id} className={`chat-conv ${item.id === activeId ? "is-active" : ""}`}>
              <button type="button" className="chat-conv-main" onClick={() => setActiveId(item.id)}>
                <span className="chat-conv-title">{item.title || "新会话"}</span>
                <span className="chat-conv-sub">{item.lastMessage || "还没有消息"}</span>
                <span className="chat-conv-meta">
                  {item.running ? <em className="chat-conv-run"><LoaderCircle size={10} className="spin" />进行中</em> : null}
                  {item.messageCount} 条 · {new Date(item.updatedAt).toLocaleDateString("zh-CN")}
                </span>
              </button>
              <button
                type="button"
                className="icon-button compact danger chat-conv-del"
                title="删除会话"
                onClick={() => void removeConversation(item.id)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          )) : (
            <div className="chat-sidebar-empty">
              <Info size={13} />
              <span>还没有会话。点上面「新建会话」开始，然后用一句话让它画图或改图。</span>
            </div>
          )}
        </div>
      </aside>

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
                <h2>还没有可以用来当大脑的渠道</h2>
                <p>助手需要走 chat completions 协议的对话模型。到「渠道配置」加一个对话渠道，填好 Base URL、模型 ID 和 Key，再回来这里。</p>
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
                onBlur={(event) => void patch({ title: event.target.value.trim() || "新会话" })}
              />
              <div className="chat-header-controls">
                <label className="chat-control" title="这个会话用哪个模型当大脑">
                  <Brain size={13} />
                  <select
                    value={`${view.brainChannelId}::${view.brainModel}`}
                    onChange={(event) => {
                      const [brainChannelId, brainModel] = event.target.value.split("::");
                      void patch({ brainChannelId: brainChannelId ?? "", brainModel: brainModel ?? "" });
                    }}
                  >
                    {brains.flatMap((channel) => channel.models.map((model) => (
                      <option key={`${channel.id}::${model}`} value={`${channel.id}::${model}`}>
                        {channel.name} · {model}
                      </option>
                    )))}
                    {/* 当前组合不在可用列表里（渠道被停用/改了模型）也要能显示出来 */}
                    {!brains.some((channel) => channel.id === view.brainChannelId && channel.models.includes(view.brainModel)) ? (
                      <option value={`${view.brainChannelId}::${view.brainModel}`}>{view.brainModel}（不可用）</option>
                    ) : null}
                  </select>
                </label>

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
                  <details className="chat-caps">
                    <summary title="助手现在能调哪些模型"><ListTree size={13} />可用模型</summary>
                    <div className="chat-caps-body">
                      <div className="chat-caps-defaults">
                        <label>
                          <span>默认生图模型</span>
                          <select
                            value={defaults.image}
                            disabled={!imageAliases.length}
                            onChange={(event) => void setDefaultAlias("image", event.target.value)}
                          >
                            <option value="">自动（用第一个）</option>
                            {imageAliases.map((cap) => (
                              <option key={cap.alias} value={cap.alias}>{cap.alias} · {cap.model}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span>默认生视频模型</span>
                          <select
                            value={defaults.video}
                            disabled={!videoAliases.length}
                            onChange={(event) => void setDefaultAlias("video", event.target.value)}
                          >
                            <option value="">自动（用第一个）</option>
                            {videoAliases.map((cap) => (
                              <option key={cap.alias} value={cap.alias}>{cap.alias} · {cap.model}</option>
                            ))}
                          </select>
                        </label>
                        <p className="chat-caps-hint">
                          助手没说用哪个模型时，就用这里的。你在对话里点名了就以你说的为准。
                        </p>
                      </div>
                      {capabilities.map((cap) => {
                        const effective = cap.alias === effectiveAlias(
                          cap.kind === "video" ? defaults.video : defaults.image,
                          cap.kind === "video" ? videoAliases : imageAliases,
                        );
                        return (
                          <div key={`${cap.kind}-${cap.alias}`} className={`chat-caps-item ${effective ? "is-default" : ""}`}>
                            <em>{cap.kind === "video" ? "视频" : "图片"}</em>
                            <span className="chat-caps-alias">
                              <strong>{cap.alias}</strong>
                              {effective ? <i className="chat-caps-flag">默认</i> : null}
                            </span>
                            <span>{cap.channelName} · {cap.model}</span>
                          </div>
                        );
                      })}
                      <p className="chat-caps-note">这些是替大脑挑模型的简称——你在对话里说「用 Gemini 画」就够了，不必记真实模型 ID。</p>
                    </div>
                  </details>
                ) : null}
              </div>
            </header>

            <div className="chat-thread" ref={threadRef}>
              {!rows.length && !hasStream ? (
                <div className="chat-thread-empty">
                  <p>说一句话开始。它会自己决定是画图、改图、优化提示词，还是接着上一张生成视频。</p>
                </div>
              ) : null}

              {rows.map((row) => {
                if (row.kind === "user") return <UserBubble key={row.message.id} message={row.message} onPreview={setPreview} />;
                if (row.kind === "note") return <SystemNote key={row.message.id} message={row.message} />;
                if (row.kind === "assistant") return <AssistantBubble key={row.message.id} message={row.message} />;
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
                    assets={mediaAssets}
                    onPreview={setPreview}
                  />
                );
              })}

              {hasStream ? <StreamingBubble reasoning={reasoning} content={draft} /> : null}

              {status === "waiting_task" ? (
                <div className="chat-note"><LoaderCircle size={13} className="spin" /><span>视频在后台生成，好了我接着处理</span></div>
              ) : null}
            </div>

            <div className="chat-canvas">
              {/* 每张图只出现一次：点一下给它打上"在画布里"的序号，① 是主图。
                  标题行那枚药丸负责说清画布和这一行的关系，详情挂 tooltip */}
              <div className="canvas-panel">
                <AssetStrip
                  assets={sessionImages}
                  canvasIds={canvasImages.map((asset) => asset.id)}
                  onToggle={toggleCanvas}
                  onPreview={setPreview}
                  onPromote={promoteCanvas}
                  onClear={() => writeCanvas([])}
                />
              </div>
            </div>

            <Composer
              running={running}
              uploading={uploading}
              placeholder={canvasImages.length
                ? `当前画布 ${canvasImages.length > 1 ? `${canvasImages.length} 张（主图 ${assetRef(canvasImages[0]!.id)}）` : assetRef(canvasImages[0]!.id)}，直接说怎么改…`
                : "说你想画什么，或者要改哪张图…"}
              onSend={(text) => void send(text)}
              onUpload={(files) => void uploadImages(files)}
              onInterrupt={() => void interrupt()}
            />
          </>
        )}
      </section>

      {preview ? (
        <div className="chat-lightbox" onClick={() => setPreview(null)} role="presentation">
          <div className="chat-lightbox-body" onClick={(event) => event.stopPropagation()}>
            {previewIsVideo ? (
              // 视频只能交给浏览器解码：服务端缩略图走 jimp，喂给它视频会直接 404
              // （ASSET_NOT_IMAGE），所以这里不做 poster，直接播
              <video
                src={api.assetUrl(`/api/assets/${preview}/file`)}
                controls autoPlay loop playsInline disablePictureInPicture disableRemotePlayback
              />
            ) : (
              <img src={api.assetUrl(`/api/assets/${preview}/file`)} alt="" />
            )}
            <div className="chat-lightbox-bar">
              <span>{assetRef(preview)}{previewAsset ? ` · ${previewAsset.fileName}` : ""}</span>
              <button type="button" className="icon-button compact" onClick={() => setPreview(null)} title="关闭">
                <X size={14} />
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
