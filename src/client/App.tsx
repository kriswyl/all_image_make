import { BRAND } from "../shared/brand.generated";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle, CheckCircle2, Minus, Moon, PanelLeft, PanelLeftClose, Square, Sun, X,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, isTauriRuntime } from "./api";
import { copyImageToClipboard } from "./clipboard";
import { AddChannelWizard } from "./channels/AddChannelWizard";
import { ChannelDialog } from "./channels/ChannelDialog";
import { ChannelsView } from "./channels/ChannelsView";
import { ChatView } from "./ChatView";
import { BoardWorkspace } from "./board/BoardWorkspace";
import { ChannelPicker } from "./chat/ChannelPicker";
import { ModelPicker } from "./chat/ModelPicker";
import { LazyVideoThumb } from "./LazyVideoThumb";
import { MaskEditorDialog } from "./MaskEditorDialog";
import { MusicGenerateView } from "./MusicGenerateView";
import { SpeechGenerateView } from "./SpeechGenerateView";
import { GenerateView } from "./views/GenerateView";
import { ParamChips } from "./ParamChips";
import { PromptPolishButton } from "./PromptPolishButton";
import { useFileDrop } from "./useFileDrop";
import { useImagePaste } from "./useImagePaste";
import { VideoGenerateView } from "./VideoGenerateView";
import { ImmersiveOnboarding } from "./onboarding/ImmersiveOnboarding";
import { LoadingScreen, StatusBadge, formatTime, optionalNumber, statusLabels, terminalStatuses, usePersistentState } from "./task-ui";
import { IMAGE_SIZE_VALUES, MAX_REFERENCE_IMAGE_BYTES, isImageAdapter, isVideoAdapter, taskKind } from "../shared/types";
import { imageReferenceLimit } from "../shared/image-reference-limits";
import type { Asset, Channel, ClearScope, Diagnostic, ImageSizeValue, Task, TaskStatus } from "../shared/types";
import type { SunoSourceSelection } from "../shared/suno";
import type { InpaintMaskController, ReferenceController, Toast, View } from "./app-shared";
import { useInpaintMask, useReferenceImages } from "./hooks/useReferenceImages";
import { useMediaBuckets } from "./hooks/useMediaBuckets";
import { usePublicTaskEvents, usePolling } from "./hooks/usePolling";
import { ClearHistoryDialog, HistoryView } from "./views/HistoryView";
import { SettingsDialog } from "./dialogs/SettingsDialog";
import { DiagnosticDialog } from "./dialogs/DiagnosticDialog";
import { setThemeMode, useTheme } from "./theme";
import { clampSidebarWidth, sidebarWidthLimit, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_OVERLAY_BREAKPOINT } from "./layout";
import { ContextSidebar, NavigationRail, isCreationView, navigationMode, type CreationView, type NavigationMode } from "./ShellNavigation";
import { WorkspaceSurface } from "./WorkspaceSurface";
import { useHistoryNavigation } from "./views/history-navigation";

export type { Toast, View } from "./app-shared";

const SIDEBAR_WIDTH_KEY = "yida.sidebar-width";
type TransientSidebar = "board" | "create" | null;

/** 任务最新一次活动的时间：跑完的算完成时间，还在跑的算创建时间 */
function taskActivityAt(task: Task) {
  return task.finishedAt ?? task.createdAt;
}

/** 一批任务里最新的活动时间，都是 ISO 字符串，直接按字典序比大小即可 */
function latestActivity(tasks: Task[]) {
  return tasks.reduce((latest, task) => {
    const at = taskActivityAt(task);
    return at > latest ? at : latest;
  }, "");
}

export function App() {
  const [view, setView] = useState<View>("generate");
  const [openedViews, setOpenedViews] = useState<ReadonlySet<View>>(() => new Set(["generate"]));
  const lastCreation = useRef<CreationView>("generate");
  const mode = navigationMode(view);
  const historyNavigation = useHistoryNavigation();
  const theme = useTheme();

  /** 切换工作区直接提交状态，不为整页截图和动画等待渲染。 */
  function switchView(next: View, sidebar: TransientSidebar = null) {
    if (isCreationView(next)) lastCreation.current = next;
    setTransientSidebar(sidebar);
    setOpenedViews(current => current.has(next) ? current : new Set([...current, next]));
    setView(next);
  }
  /**
   * 新用户向导：一个渠道都没有时占住主区，直到用户真的配好渠道、
   * 或者点「先自己看看」主动跳过。跳过的选择记在本机，免得每次开都弹。
   */
  const [welcomeDismissed, setWelcomeDismissed] = useState(() => {
    try { return window.localStorage.getItem("yida.welcome-dismissed") === "1"; } catch { return false; }
  });
  const [channels, setChannels] = useState<Channel[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [serviceReady, setServiceReady] = useState(false);
  // 图片、视频、音乐各自记住渠道与模型，互不干扰
  const [selectedChannelId, setSelectedChannelId] = usePersistentState("channelId", "");
  const [selectedModel, setSelectedModel] = usePersistentState("model", "");
  const [videoChannelId, setVideoChannelId] = usePersistentState("videoChannelId", "");
  const [videoModel, setVideoModel] = usePersistentState("videoModel", "");
  const [musicChannelId, setMusicChannelId] = usePersistentState("musicChannelId", "");
  const [musicModel, setMusicModel] = usePersistentState("musicModel", "");
  const [musicSource, setMusicSource] = useState<SunoSourceSelection | null>(null);
  const [speechChannelId, setSpeechChannelId] = usePersistentState("speechChannelId", "");
  const [speechModel, setSpeechModel] = usePersistentState("speechModel", "");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeVideoTaskId, setActiveVideoTaskId] = useState<string | null>(null);
  const [activeMusicTaskId, setActiveMusicTaskId] = useState<string | null>(null);
  const [activeSpeechTaskId, setActiveSpeechTaskId] = useState<string | null>(null);
  // 上次看过生成历史的时间点，比它新的任务算未读
  const [historySeenAt, setHistorySeenAt] = usePersistentState("historySeenAt", "");
  const [editorChannel, setEditorChannel] = useState<Channel | null | undefined>(undefined);
  const [wizardOpen, setWizardOpen] = useState(false);
  /**
   * 沉浸式引导的开关。
   *
   * 不在渲染时直接用 `!channels.length` 推导：用户配完最后一个渠道时，channels 会
   * 立刻变成非空；如果 overlay 跟着卸载，「欢迎来到 AI 宇宙」的收尾动画就看不到了。
   * 首次启动由下面的 effect 打开一次，之后只由用户/引导自己关闭。
   */
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [diagnosticTask, setDiagnosticTask] = useState<Task | null>(null);
  const onVideoRecovered = useCallback((task: Task) => {
    setTasks((current) => current.map((item) => item.id === task.id ? task : item));
  }, []);
  /**
   * 对话里的「诊断」也走应用内弹窗。
   *
   * 以前 ToolCard 用 `window.open` 直接打 API 的 JSON 地址；Tauri webview 默认
   * 不允许新窗口，点下去什么都不会发生——用户看到的就是「诊断点不开」。
   * 任务不在当前历史列表里时再补一次 GET，弹窗仍能正常显示。
   */
  async function openDiagnostics(taskId: string) {
    const known = tasks.find((task) => task.id === taskId);
    if (known) { setDiagnosticTask(known); return; }
    try { setDiagnosticTask(await api.task(taskId)); }
    catch (error) { showToast("error", error instanceof Error ? error.message : "读取诊断失败"); }
  }
  // 三个入口共用同一个确认弹窗，靠 mode 区分真正要删的范围：
  // task=单条、selection=历史页勾选的若干条、scope=按图片/视频/全部清空
  const [clearRequest, setClearRequest] = useState<
    | { mode: "task"; count: number; label: string; tasks: Task[] }
    | { mode: "selection"; count: number; label: string; tasks: Task[] }
    | { mode: "scope"; scope: ClearScope; count: number; label: string; tasks: Task[] }
    | null
  >(null);
  const [assetDirOpen, setAssetDirOpen] = useState(false);
  const [assetsPath, setAssetsPath] = useState("");
  const [defaultAssetsPath, setDefaultAssetsPath] = useState("");
  const [dataPath, setDataPath] = useState("");
  const [toast, setToast] = useState<Toast | null>(null);
  const [chatSidebarHost, setChatSidebarHost] = useState<HTMLDivElement | null>(null);
  const [boardSidebarHost, setBoardSidebarHost] = useState<HTMLDivElement | null>(null);
  const [sidebarSearch, setSidebarSearch] = useState<{ chat?: string; board?: string }>({});
  const sidebarRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const compact = viewportWidth < SIDEBAR_OVERLAY_BREAKPOINT;
  const [sidebarHiddenPreference, setSidebarHiddenPreference] = usePersistentState("sidebarHidden", false);
  const [compactSidebarOpen, setCompactSidebarOpen] = useState(false);
  const [boardSidebarPinned, setBoardSidebarPinned] = usePersistentState("boardSidebarPinned", false);
  const [transientSidebar, setTransientSidebar] = useState<TransientSidebar>(null);
  const boardSidebarPinnedRef = useRef(boardSidebarPinned);
  boardSidebarPinnedRef.current = boardSidebarPinned;
  const onBoardSelected = useCallback(() => {
    if (!boardSidebarPinnedRef.current || window.innerWidth < SIDEBAR_OVERLAY_BREAKPOINT) {
      setTransientSidebar(open => open === "board" ? null : open);
    }
  }, []);
  const transientMode = mode === "board" || mode === "create";
  const sidebarHidden = transientMode ? transientSidebar !== mode : compact ? !compactSidebarOpen : sidebarHiddenPreference;
  const sidebarOverlay = compact || mode === "create" || (mode === "board" && !boardSidebarPinned);
  const toggleSidebar = useCallback(() => {
    if (mode === "board" || mode === "create") setTransientSidebar(open => open === mode ? null : mode);
    else if (compact) setCompactSidebarOpen(open => !open);
    else setSidebarHiddenPreference(hidden => !hidden);
  }, [mode, compact, setSidebarHiddenPreference]);

  function navigateFromRail(next: NavigationMode) {
    dismissWelcome();
    if (next === "create" || next === "board") {
      switchView(next === "create" ? lastCreation.current : next, next);
      return;
    }
    if (compact) setCompactSidebarOpen(true);
    else setSidebarHiddenPreference(false);
    switchView(next);
  }

  useEffect(() => {
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape" && sidebarOverlay && !sidebarHidden) {
        toggleSidebar();
        return;
      }
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.key.toLowerCase() !== "b") return;
      event.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sidebarOverlay, sidebarHidden, toggleSidebar]);

  useEffect(() => {
    if (!sidebarOverlay || sidebarHidden) return;
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || sidebarRef.current?.contains(event.target) || railRef.current?.contains(event.target)) return;
      if (event.target.closest("[data-sidebar-toggle], .sidebar-conv-menu, .update-popover")) return;
      toggleSidebar();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [sidebarOverlay, sidebarHidden, toggleSidebar]);
  /**
   * 自绘标题栏（decorations: false 之后）。
   *
   * 用 `isDecorated()` 探测而不是写死一个开关：现在正在跑的那套窗口还是原生标题栏，
   * 配置改完要重启 Tauri 才生效；探测一下，重启前界面不会突然多出第二层标题栏。
   */
  const [customChrome, setCustomChrome] = useState(false);
  useEffect(() => {
    if (!isTauriRuntime()) return;
    void getCurrentWindow().isDecorated()
      .then((decorated) => setCustomChrome(!decorated))
      .catch(() => setCustomChrome(false));
  }, []);

  /**
   * 自绘窗口的圆角外壳。
   *
   * 只在真的没有原生标题栏时启用（否则给装饰窗口加一圈透明边会很怪）。
   * 最大化时去掉外边距和圆角，避免屏幕四边漏出透明缝。
   */
  useEffect(() => {
    document.documentElement.classList.toggle("tauri-window", customChrome);
    return () => document.documentElement.classList.remove("tauri-window", "is-maximized");
  }, [customChrome]);

  useEffect(() => {
    if (!customChrome) return;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow: getWindow }) => {
      const win = getWindow();
      const sync = async () => {
        document.documentElement.classList.toggle("is-maximized", await win.isMaximized());
      };
      await sync();
      unlisten = await win.onResized(() => { void sync(); });
    }).catch(() => undefined);
    return () => unlisten?.();
  }, [customChrome]);

  const sidebarMaxWidth = sidebarWidthLimit(viewportWidth);
  const [preferredSidebarWidth, setPreferredSidebarWidth] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
      return stored >= SIDEBAR_MIN_WIDTH ? Math.min(stored, SIDEBAR_MAX_WIDTH) : SIDEBAR_DEFAULT_WIDTH;
    } catch { return SIDEBAR_DEFAULT_WIDTH; }
  });
  const sidebarWidth = clampSidebarWidth(viewportWidth, preferredSidebarWidth);
  const stopResizeRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopResizeRef.current?.(), []);
  useEffect(() => {
    try { window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(preferredSidebarWidth)); } catch { /* Local storage is optional. */ }
  }, [preferredSidebarWidth]);

  function startSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    stopResizeRef.current?.();
    const startX = event.clientX;
    const pointerId = event.pointerId;
    const onMove = (move: PointerEvent) => {
      if (move.pointerId === pointerId) setPreferredSidebarWidth(clampSidebarWidth(window.innerWidth, sidebarWidth + move.clientX - startX));
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      stopResizeRef.current = null;
    };
    const end = (move: PointerEvent) => { if (move.pointerId === pointerId) stop(); };
    stopResizeRef.current = stop;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function dismissWelcome() {
    setWelcomeDismissed(true);
    setOnboardingOpen(false);
    try { window.localStorage.setItem("yida.welcome-dismissed", "1"); } catch { /* 存不下也只是下次再显示一遍 */ }
  }



  /**
   * 首次启动：一个渠道都没有、用户也还没跳过——自动拉开沉浸式引导。
   *
   * 只在「首次加载完成」或用户从渠道页主动打开时触发。配完渠道后 channels 变非空，
   * 不会重新打开；overlay 自己负责收尾动画。
   */
  useEffect(() => {
    if (loading) return;
    if (!channels.length && !welcomeDismissed) setOnboardingOpen(true);
  }, [loading, channels.length, welcomeDismissed]);

  /** 关闭引导：如果这次是首次启动且最终没配任何渠道，顺手记下「先自己看看」 */
  function closeOnboarding() {
    setOnboardingOpen(false);
    if (!channels.length) dismissWelcome();
  }

  // 对话渠道只是 Agent 的大脑，不出图也不出视频，所以生图 / 视频工作台都要排除它
  const imageChannels = channels.filter((channel) => isImageAdapter(channel.adapterType));
  const videoChannels = channels.filter((channel) => isVideoAdapter(channel.adapterType));
  // 音乐和配音都属于 audio 品类，但各自只认自己的适配器
  const musicChannels = channels.filter((channel) => channel.adapterType === "suno-music");
  const speechChannels = channels.filter((channel) => channel.adapterType === "gemini-tts");
  const imageTasks = tasks.filter((task) => taskKind(task, channels) === "image");
  const videoTasks = tasks.filter((task) => taskKind(task, channels) === "video");
  const audioTasks = tasks.filter((task) => taskKind(task, channels) === "audio");
  const adapterOfTask = (task: Task) => channels.find((channel) => channel.id === task.channelId)?.adapterType;
  const musicTasks = audioTasks.filter((task) => adapterOfTask(task) === "suno-music");
  const speechTasks = audioTasks.filter((task) => adapterOfTask(task) === "gemini-tts");
  const activeTask = tasks.find((task) => task.id === activeTaskId) ?? null;
  const activeVideoTask = tasks.find((task) => task.id === activeVideoTaskId) ?? null;
  const activeMusicTask = tasks.find((task) => task.id === activeMusicTaskId) ?? null;
  const activeSpeechTask = tasks.find((task) => task.id === activeSpeechTaskId) ?? null;
  const latestTaskActivity = latestActivity(tasks);
  const historyUnread = latestTaskActivity > historySeenAt;
  // 参考图状态在 App 层持有，切换视图不丢失（修复切换界面参考图消失）
  const generateChannel = imageChannels.find((channel) => channel.id === selectedChannelId);
  const references = useReferenceImages(showToast, imageReferenceLimit(generateChannel?.adapterType, selectedModel).max);
  /** 视频页单独一份参考图状态：Seedance 2.5 的上限远高于图片页 */
  // 视频页按「渠道:模式」分桶存素材：切模式不再清空已上传的图片/视频
  const videoMedia = useMediaBuckets(showToast);
  /**
   * 局部重绘只对 openai-images（gpt / gpt-c）且恰好一张参考图生效。
   * 底图一变（删除、替换、加第二张、换渠道），`maskSourceUrl` 就变，旧蒙版自动作废。
   */
  const maskSourceUrl = generateChannel?.adapterType === "openai-images"
    && references.images.length === imageReferenceLimit(generateChannel.adapterType, selectedModel, "mask").max
    ? references.images[0].previewUrl
    : null;
  const inpaint = useInpaintMask(maskSourceUrl);

  useEffect(() => {
    void api.bootstrap()
      .then((data) => {
        setServiceReady(true);
        setChannels(data.channels);
        setTasks(data.tasks);
        setAssetsPath(data.service.assetsPath);
        setDefaultAssetsPath(data.service.defaultAssetsPath);
        setDataPath(data.service.dataPath);
        const images = data.channels.filter((item) => isImageAdapter(item.adapterType));
        const videos = data.channels.filter((item) => isVideoAdapter(item.adapterType));
        const musics = data.channels.filter((item) => item.adapterType === "suno-music");
        const speeches = data.channels.filter((item) => item.adapterType === "gemini-tts");
        const firstImage = images.find((item) => item.id === selectedChannelId && item.enabled)
          ?? images.find((item) => item.enabled)
          ?? images[0];
        if (firstImage) {
          setSelectedChannelId(firstImage.id);
          setSelectedModel(firstImage.models.includes(selectedModel) ? selectedModel : firstImage.models[0] ?? "");
        }
        const firstVideo = videos.find((item) => item.id === videoChannelId && item.enabled)
          ?? videos.find((item) => item.enabled)
          ?? videos[0];
        if (firstVideo) {
          setVideoChannelId(firstVideo.id);
          setVideoModel(firstVideo.models.includes(videoModel) ? videoModel : firstVideo.models[0] ?? "");
        }
        const firstMusic = musics.find((item) => item.id === musicChannelId && item.enabled)
          ?? musics.find((item) => item.enabled)
          ?? musics[0];
        if (firstMusic) {
          setMusicChannelId(firstMusic.id);
          setMusicModel(firstMusic.models.includes(musicModel) ? musicModel : firstMusic.models[0] ?? "");
        }
        const firstSpeech = speeches.find((item) => item.id === speechChannelId && item.enabled)
          ?? speeches.find((item) => item.enabled)
          ?? speeches[0];
        if (firstSpeech) {
          setSpeechChannelId(firstSpeech.id);
          setSpeechModel(firstSpeech.models.includes(speechModel) ? speechModel : firstSpeech.models[0] ?? "");
        }
        const imageHistory = data.tasks.filter((task) => taskKind(task, data.channels) === "image");
        const videoHistory = data.tasks.filter((task) => taskKind(task, data.channels) === "video");
        const latestImage = imageHistory.find((task) => task.status === "succeeded") ?? imageHistory[0];
        if (latestImage) setActiveTaskId(latestImage.id);
        const latestVideo = videoHistory.find((task) => task.status === "succeeded") ?? videoHistory[0];
        if (latestVideo) setActiveVideoTaskId(latestVideo.id);
        const musicHistory = data.tasks.filter((task) =>
          taskKind(task, data.channels) === "audio"
          && data.channels.find((channel) => channel.id === task.channelId)?.adapterType === "suno-music");
        const latestMusic = musicHistory.find((task) => task.status === "succeeded") ?? musicHistory[0];
        if (latestMusic) setActiveMusicTaskId(latestMusic.id);
        const speechHistory = data.tasks.filter((task) =>
          taskKind(task, data.channels) === "audio"
          && data.channels.find((channel) => channel.id === task.channelId)?.adapterType === "gemini-tts");
        const latestSpeech = speechHistory.find((task) => task.status === "succeeded") ?? speechHistory[0];
        if (latestSpeech) setActiveSpeechTaskId(latestSpeech.id);
        // 首次启动把手上已有的历史视为已读，避免一打开就顶着未读小红点
        setHistorySeenAt((current) => current || latestActivity(data.tasks));
      })
      .catch((error) => showToast("error", error.message))
      .finally(() => setLoading(false));
  }, []);

  // 图片、音乐和语音订阅任务事件，切换历史结果也能更新未完成的任务。
  // 视频页是卡片网格，列表里可能同时有好几条在跑；轮询最新一条未完成的，
  // 而不是只盯「当前选中」——刷新页面后没选中任何一条时也能继续推进。
  const pendingVideoTask = videoTasks.find((task) => !terminalStatuses.includes(task.status)) ?? null;
  usePublicTaskEvents([...imageTasks, ...musicTasks, ...speechTasks], setTasks);
  usePolling(pendingVideoTask, setTasks);

  // 停在生成历史页时随时把新记录标记成已读：用户正看着，不该再算未读
  useEffect(() => {
    if (view !== "history") return;
    setHistorySeenAt(latestTaskActivity);
  }, [view, latestTaskActivity, setHistorySeenAt]);

  function showToast(kind: Toast["kind"], message: string, action?: Toast["action"]) {
    const next = { kind, message, action };
    setToast(next);
    window.setTimeout(() => setToast((current) => current === next ? null : current), action ? 8000 : 3200);
  }

  function selectChannel(id: string) {
    const channel = channels.find((item) => item.id === id);
    setSelectedChannelId(id);
    setSelectedModel(channel?.models[0] ?? "");
  }

  function selectVideoChannel(id: string) {
    const channel = channels.find((item) => item.id === id);
    setVideoChannelId(id);
    setVideoModel(channel?.models[0] ?? "");
  }

  function selectMusicChannel(id: string) {
    const channel = channels.find((item) => item.id === id);
    setMusicChannelId(id);
    setMusicModel(channel?.models[0] ?? "");
  }

  function selectSpeechChannel(id: string) {
    const channel = channels.find((item) => item.id === id);
    setSpeechChannelId(id);
    setSpeechModel(channel?.models[0] ?? "");
  }

  async function refreshTasks() {
    try { setTasks(await api.tasks()); } catch (error) { showToast("error", error instanceof Error ? error.message : "刷新失败"); }
  }

  function handleChannelSaved(channel: Channel) {
    setChannels((current) => [channel, ...current.filter((item) => item.id !== channel.id)]);
    adoptChannel(channel);
    setEditorChannel(undefined);
    showToast("success", "渠道已保存");
  }

  function handleWizardSaved(channel: Channel) {
    setChannels((current) => [channel, ...current.filter((item) => item.id !== channel.id)]);
    adoptChannel(channel);
  }

  /** 新渠道按类型落到对应工作台，不会把视频渠道塞进生图选择框 */
  function adoptChannel(channel: Channel) {
    if (isVideoAdapter(channel.adapterType)) {
      if (!videoChannelId || videoChannelId === channel.id) {
        setVideoChannelId(channel.id);
        setVideoModel(channel.models[0] ?? "");
      }
      return;
    }
    if (channel.adapterType === "gemini-tts") {
      if (!speechChannelId || speechChannelId === channel.id) {
        setSpeechChannelId(channel.id);
        setSpeechModel(channel.models[0] ?? "");
      }
      return;
    }
    if (channel.adapterType === "suno-music") {
      if (!musicChannelId || musicChannelId === channel.id) {
        setMusicChannelId(channel.id);
        setMusicModel(channel.models[0] ?? "");
      }
      return;
    }
    // 对话渠道只是大脑，不能塞进生图工作台的渠道选择框
    if (!isImageAdapter(channel.adapterType)) return;
    if (!selectedChannelId || selectedChannelId === channel.id) {
      setSelectedChannelId(channel.id);
      setSelectedModel(channel.models[0] ?? "");
    }
  }

  function handleWizardRemoved(id: string) {
    setChannels((current) => {
      const remaining = current.filter((item) => item.id !== id);
      dropChannel(id, remaining);
      return remaining;
    });
  }

  /** 渠道消失后，把该工作台的选择退回到同类型的下一个渠道 */
  function dropChannel(id: string, remaining: Channel[]) {
    if (selectedChannelId === id) {
      const next = remaining.find((item) => isImageAdapter(item.adapterType));
      setSelectedChannelId(next?.id ?? "");
      setSelectedModel(next?.models[0] ?? "");
    }
    if (videoChannelId === id) {
      const next = remaining.find((item) => isVideoAdapter(item.adapterType));
      setVideoChannelId(next?.id ?? "");
      setVideoModel(next?.models[0] ?? "");
    }
    if (musicChannelId === id) {
      const next = remaining.find((item) => item.adapterType === "suno-music");
      setMusicChannelId(next?.id ?? "");
      setMusicModel(next?.models[0] ?? "");
    }
    if (speechChannelId === id) {
      const next = remaining.find((item) => item.adapterType === "gemini-tts");
      setSpeechChannelId(next?.id ?? "");
      setSpeechModel(next?.models[0] ?? "");
    }
  }

  async function deleteChannel(channel: Channel) {
    if (!window.confirm(`删除渠道“${channel.name}”？历史任务仍会保留。`)) return;
    try {
      await api.deleteChannel(channel.id);
      const remaining = channels.filter((item) => item.id !== channel.id);
      setChannels(remaining);
      dropChannel(channel.id, remaining);
      showToast("success", "渠道已删除");
    } catch (error) { showToast("error", error instanceof Error ? error.message : "删除失败"); }
  }

  /** 删除单条记录：和清空历史走同一个弹窗，都要问一句磁盘上的文件删不删 */
  function requestDeleteTask(task: Task) {
    setClearRequest({ mode: "task", count: 1, label: "记录", tasks: [task] });
  }

  /** 删除历史页勾选的若干条：只动勾中的，页面上没勾的照旧留着 */
  function requestDeleteSelected(selected: Task[]) {
    if (!selected.length) return;
    setClearRequest({ mode: "selection", count: selected.length, label: "记录", tasks: selected });
  }

  /** 清空指定类型的历史：图片、视频、音乐或全部 */
  function requestClearTasks(scope: ClearScope = "all", allRecords?: Task[]) {
    const target = allRecords ?? (scope === "image" ? imageTasks
      : scope === "video" ? videoTasks
      : scope === "audio" ? audioTasks
      : tasks);
    if (!target.length) return;
    const label = scope === "image" ? "生图记录"
      : scope === "video" ? "视频记录"
      : scope === "audio" ? "音频记录"
      : "记录";
    setClearRequest({ mode: "selection", count: target.length, label, tasks: target });
  }

  /** 弹窗里选完之后真正执行删除。keepFiles 为真时磁盘上的图片视频原地保留 */
  async function confirmClear(request: NonNullable<typeof clearRequest>, keepFiles: boolean) {
    const removed = new Set(request.tasks.map((task) => task.id));
    const dropLocally = (current: Task[]) => current.filter((task) => !removed.has(task.id));
    // 聊天生成的记录归对话所有：删的时候得把消息里的锚点、画布、分镜引用一起摘掉，
    // 否则对话里会留下裂图。公共记录没有引用，照旧直删。
    const detach = request.tasks.some((task) => task.historySource === "chat");
    try {
      if (request.mode === "task") {
        await api.deleteTask(request.tasks[0].id, keepFiles, detach);
        setTasks(dropLocally);
        if (activeTaskId && removed.has(activeTaskId)) setActiveTaskId(null);
        if (activeVideoTaskId && removed.has(activeVideoTaskId)) setActiveVideoTaskId(null);
        showToast("success", "已删除该记录");
        setClearRequest(null);
        return;
      }
      const result = request.mode === "selection"
        ? await api.deleteTasks(request.tasks.map((task) => task.id), keepFiles, detach)
        : await api.clearTasks(request.scope, keepFiles).then((value) => ({ ...value, skipped: 0, skippedConversation: 0 }));
      if (request.mode === "scope") {
        // 服务端按范围清的是全库记录，本地列表要重新拉一次才不会残留
        try { setTasks(await api.tasks()); } catch { setTasks(dropLocally); }
      } else {
        setTasks(dropLocally);
      }
      if (activeTaskId && removed.has(activeTaskId)) setActiveTaskId(null);
      if (activeVideoTaskId && removed.has(activeVideoTaskId)) setActiveVideoTaskId(null);
      const skipped = "skipped" in result ? result.skipped : 0;
      const main = request.mode === "scope" ? "已清空生成历史" : `已删除 ${result.deleted} 条记录`;
      // 有被跳过的就把原因说清楚，否则用户会以为「点了没反应」
      showToast("success", skipped ? `${main}，${skipped} 条因仍被分镜或对话引用已跳过` : main);
      setClearRequest(null);
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "删除失败");
    }
  }

  return (
    <div
      className={`app-shell ${sidebarHidden ? "is-sidebar-hidden" : ""} ${sidebarOverlay ? "is-context-overlay" : ""} ${customChrome ? "has-custom-chrome" : ""}`}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
    >
      {/* decorations:false 之后自己画的标题栏。开关放在这里，和 Codex 一样在窗口左上角 */}
      {customChrome ? (
        <div className="titlebar" data-tauri-drag-region>
          <button
            type="button"
            className="titlebar-toggle"
            data-sidebar-toggle
            aria-expanded={!sidebarHidden}
            aria-controls="context-sidebar"
            title={sidebarHidden ? "展开侧边栏（Ctrl+B）" : "收起侧边栏（Ctrl+B）"}
            aria-label={sidebarHidden ? "展开侧边栏" : "收起侧边栏"}
            onClick={toggleSidebar}
          >
            {sidebarHidden ? <PanelLeft size={15} /> : <PanelLeftClose size={15} />}
          </button>
          {/* 深色开关放到标题栏左上角，紧挨侧边栏开关；图标显示的是「点下去会切到哪边」 */}
          <button
            type="button"
            className="titlebar-toggle titlebar-theme"
            title={theme.resolved === "dark" ? "切换到浅色主题" : "切换到深色主题"}
            aria-label={theme.resolved === "dark" ? "切换到浅色主题" : "切换到深色主题"}
            onClick={() => setThemeMode(theme.resolved === "dark" ? "light" : "dark")}
          >
            {theme.resolved === "dark" ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <span
            className="titlebar-title"
            data-tauri-drag-region
            onDoubleClick={() => void getCurrentWindow().toggleMaximize()}
          >
            {BRAND.productName}
          </span>
          <div
            className="titlebar-drag"
            data-tauri-drag-region
            onDoubleClick={() => void getCurrentWindow().toggleMaximize()}
          />
          <div className="titlebar-controls">
            <button type="button" className="titlebar-control" title="最小化" aria-label="最小化"
              onClick={() => void getCurrentWindow().minimize()}>
              <Minus size={14} />
            </button>
            <button type="button" className="titlebar-control" title="最大化 / 还原" aria-label="最大化或还原"
              onClick={() => void getCurrentWindow().toggleMaximize()}>
              <Square size={10} />
            </button>
            <button type="button" className="titlebar-control titlebar-close" title="关闭" aria-label="关闭"
              onClick={() => void getCurrentWindow().close()}>
              <X size={14} />
            </button>
          </div>
        </div>
      ) : null}

      <div className="navigation-rail-slot" ref={railRef}>
        <NavigationRail mode={mode} collapsed={sidebarHidden} showToggle={!customChrome} historyUnread={historyUnread}
          service={loading ? "loading" : serviceReady ? "ready" : "offline"} onNavigate={navigateFromRail} onToggle={toggleSidebar} />
      </div>
      <ContextSidebar mode={mode} view={view} collapsed={sidebarHidden} overlay={sidebarOverlay} boardPinned={boardSidebarPinned}
        width={sidebarWidth} widthLimit={sidebarMaxWidth} panelRef={sidebarRef} chatHostRef={setChatSidebarHost} boardHostRef={setBoardSidebarHost}
        search={mode === "chat" || mode === "board" ? sidebarSearch[mode] : undefined}
        onSearch={value => {
          if (mode === "chat" || mode === "board") setSidebarSearch(current => ({ ...current, [mode]: value }));
        }}
        history={historyNavigation} onNavigate={switchView} onTogglePin={() => setBoardSidebarPinned(pinned => !pinned)}
        onResizeStart={startSidebarResize} onResize={step => setPreferredSidebarWidth(clampSidebarWidth(viewportWidth, sidebarWidth + step))}
        onSettings={() => setAssetDirOpen(true)} />

      <main className="workspace">
        {loading ? <LoadingScreen /> : null}
        {!loading && openedViews.has("generate") ? (
          <WorkspaceSurface view="generate" active={view === "generate"}>
            <GenerateView
              channels={imageChannels}
              selectedChannelId={selectedChannelId}
              selectedModel={selectedModel}
              activeTask={activeTask}
              tasks={imageTasks}
              references={references}
              inpaint={inpaint}
              onChannelChange={selectChannel}
              onModelChange={setSelectedModel}
              onAddChannel={() => setWizardOpen(true)}
              onConfigureChannel={(channel) => setEditorChannel(channel)}
              onTask={(task) => {
                setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
                setActiveTaskId(task.id);
              }}
              onSelectTask={(task) => setActiveTaskId(task.id)}
              onToast={showToast}
              onDiagnostics={setDiagnosticTask}
            />
          </WorkspaceSurface>
        ) : null}
        {!loading && openedViews.has("chat") ? (
          <WorkspaceSurface view="chat" active={view === "chat"}>
            <ChatView
              channels={channels}
              sidebarHost={chatSidebarHost}
              sidebarVisible={!sidebarHidden}
              sidebarFilter={sidebarSearch.chat ?? ""}
              sidebarSearchOpen={sidebarSearch.chat !== undefined}
              onToggleSidebarSearch={() => setSidebarSearch(current => ({ ...current, chat: current.chat === undefined ? "" : undefined }))}
              onSidebarSelect={() => { if (compact) setCompactSidebarOpen(false); }}
              onConfigureChannel={setEditorChannel}
              onDiagnostics={openDiagnostics}
              onToast={(kind, text, action) => showToast(kind === "ok" ? "success" : "error", text, action)}
            />
          </WorkspaceSurface>
        ) : null}
        {!loading && openedViews.has("board") ? (
          <WorkspaceSurface view="board" active={view === "board"}>
            <BoardWorkspace
              sidebarHost={boardSidebarHost}
              onOpenMenu={toggleSidebar}
              onBoardSelected={onBoardSelected}
              sidebarOpen={transientSidebar === "board"}
              sidebarFilter={sidebarSearch.board ?? ""}
              onToast={showToast}
            />
          </WorkspaceSurface>
        ) : null}
        {!loading && openedViews.has("channels") ? (
          <WorkspaceSurface view="channels" active={view === "channels"}>
            <ChannelsView
              channels={channels}
              onAdd={() => setWizardOpen(true)}
              onQuickSetup={() => setOnboardingOpen(true)}
              onEdit={setEditorChannel}
              onDelete={deleteChannel}
              onToast={showToast}
            />
          </WorkspaceSurface>
        ) : null}
        {!loading && openedViews.has("video") ? (
          <WorkspaceSurface view="video" active={view === "video"}>
            <VideoGenerateView
              channels={videoChannels}
              selectedChannelId={videoChannelId}
              selectedModel={videoModel}
              activeTask={activeVideoTask}
              tasks={videoTasks}
              media={videoMedia}
              onChannelChange={selectVideoChannel}
              onModelChange={setVideoModel}
              onAddChannel={() => setWizardOpen(true)}
              onConfigureChannel={(channel) => setEditorChannel(channel)}
              onTask={(task) => {
                setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
                setActiveVideoTaskId(task.id);
              }}
              onSelectTask={(task) => setActiveVideoTaskId(task.id)}
              onDelete={requestDeleteTask}
              onToast={showToast}
              onDiagnostics={setDiagnosticTask}
            />
          </WorkspaceSurface>
        ) : null}
        {!loading && openedViews.has("music") ? (
          <WorkspaceSurface view="music" active={view === "music"}>
            <MusicGenerateView
              channels={musicChannels}
              selectedChannelId={musicChannelId}
              selectedModel={musicModel}
              activeTask={activeMusicTask}
              tasks={musicTasks}
              sourceSelection={musicSource}
              onSourceSelectionApplied={() => setMusicSource(null)}
              onChannelChange={selectMusicChannel}
              onModelChange={setMusicModel}
              onAddChannel={() => setWizardOpen(true)}
              onConfigureChannel={(channel) => setEditorChannel(channel)}
              onTask={(task) => {
                setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
              }}
              onSelectTask={(task) => setActiveMusicTaskId(task.id)}
              onToast={showToast}
              onDiagnostics={setDiagnosticTask}
            />
          </WorkspaceSurface>
        ) : null}
        {!loading && openedViews.has("speech") ? (
          <WorkspaceSurface view="speech" active={view === "speech"}>
            <SpeechGenerateView
              channels={speechChannels}
              selectedChannelId={speechChannelId}
              selectedModel={speechModel}
              activeTask={activeSpeechTask}
              tasks={speechTasks}
              onChannelChange={selectSpeechChannel}
              onModelChange={setSpeechModel}
              onAddChannel={() => setWizardOpen(true)}
              onConfigureChannel={(channel) => setEditorChannel(channel)}
              onTask={(task) => {
                setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
                setActiveSpeechTaskId(task.id);
              }}
              onSelectTask={(task) => setActiveSpeechTaskId(task.id)}
              onToast={showToast}
              onDiagnostics={setDiagnosticTask}
            />
          </WorkspaceSurface>
        ) : null}
        {!loading && openedViews.has("history") ? (
          <WorkspaceSurface view="history" active={view === "history"}>
            <HistoryView
              navigation={historyNavigation}
              controlsInSidebar={view === "history" && !sidebarHidden}
              channels={channels}
              tasks={tasks}
              references={references}
              onRefresh={refreshTasks}
              onDelete={requestDeleteTask}
              onDeleteSelected={requestDeleteSelected}
              onClear={requestClearTasks}
              onOpenAssetSettings={() => setAssetDirOpen(true)}
              onImageTask={(task) => {
                setTasks(current => [task, ...current.filter(item => item.id !== task.id)]);
                setActiveTaskId(task.id);
                switchView("generate");
              }}
              onUseMusicSource={(selection) => {
                setTasks(current => current.some(task => task.id === selection.task.id) ? current : [selection.task, ...current]);
                setActiveMusicTaskId(selection.task.id);
                setMusicSource(selection);
                switchView("music");
              }}
              onDiagnostics={setDiagnosticTask}
              onToast={showToast}
            />
          </WorkspaceSurface>
        ) : null}
      </main>

      {wizardOpen ? (
        <AddChannelWizard
          channels={channels}
          onClose={() => setWizardOpen(false)}
          onSaved={handleWizardSaved}
          onRemoved={handleWizardRemoved}
          onCustom={() => { setWizardOpen(false); setEditorChannel(null); }}
          onToast={showToast}
        />
      ) : null}
      {onboardingOpen ? (
        <ImmersiveOnboarding
          channels={channels}
          onSaved={handleWizardSaved}
          onToast={showToast}
          onClose={closeOnboarding}
          onOpenTemplates={() => { setOnboardingOpen(false); setWizardOpen(true); }}
          onOpenCustom={() => { setOnboardingOpen(false); setEditorChannel(null); }}
        />
      ) : null}
      {editorChannel !== undefined ? (
        <ChannelDialog channel={editorChannel} onClose={() => setEditorChannel(undefined)} onSaved={handleChannelSaved} />
      ) : null}
      {diagnosticTask ? <DiagnosticDialog task={diagnosticTask} onClose={() => setDiagnosticTask(null)} onVideoRecovered={onVideoRecovered} /> : null}
      {clearRequest ? (
        <ClearHistoryDialog
          mode={clearRequest.mode}
          count={clearRequest.count}
          label={clearRequest.label}
          hasChatRecords={clearRequest.tasks.some((task) => task.historySource === "chat")}
          onClose={() => setClearRequest(null)}
          onConfirm={(keepFiles) => confirmClear(clearRequest, keepFiles)}
        />
      ) : null}
      {assetDirOpen ? (
        <SettingsDialog
          assetsDir={assetsPath}
          defaultAssetsDir={defaultAssetsPath}
          dataPath={dataPath}
          onClose={() => setAssetDirOpen(false)}
          onChanged={(next) => { setAssetsPath(next); void refreshTasks(); }}
          onToast={showToast}
        />
      ) : null}
      {toast ? <div className={`toast ${toast.kind}`} role="status">
        {toast.kind === "success" ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}{toast.message}
        {toast.action ? <button type="button" className="toast-action" onClick={() => { setToast(null); toast.action?.run(); }}>{toast.action.label}</button> : null}
      </div> : null}
    </div>
  );
}
