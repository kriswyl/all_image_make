import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Copy, Download, Eye, Film, FolderOpen, History, Image as ImageIcon,
  ImagePlus, KeyRound, LayoutGrid, LoaderCircle, Mic, Minus, Moon, Music, Paintbrush, PanelLeft, PanelLeftClose, Pin, PinOff, Plug, Plus, RefreshCw, RotateCcw, Search, Server,
  Settings2, SlidersHorizontal, Sparkles, Square, SquarePen, Sun, Trash2, Upload, Wand2, X,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, isTauriRuntime } from "./api";
import { BrandMark } from "./BrandMark";
import { copyImageToClipboard } from "./clipboard";
import { APP_VERSION } from "../shared/app-config";
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
import { UpdateStatus } from "./UpdateStatus";
import { VideoGenerateView } from "./VideoGenerateView";
import { ImmersiveOnboarding } from "./onboarding/ImmersiveOnboarding";
import { LoadingScreen, StatusBadge, formatTime, optionalNumber, statusLabels, terminalStatuses, usePersistentState } from "./task-ui";
import { IMAGE_SIZE_VALUES, MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES, isImageAdapter, isVideoAdapter, taskKind } from "../shared/types";
import type { Asset, Channel, ClearScope, Diagnostic, ImageSizeValue, Task, TaskStatus } from "../shared/types";
import type { InpaintMaskController, ReferenceController, Toast, View } from "./app-shared";
import { useInpaintMask, useReferenceImages } from "./hooks/useReferenceImages";
import { useImageTaskEvents, usePolling } from "./hooks/usePolling";
import { ClearHistoryDialog, HistoryView } from "./views/HistoryView";
import { SettingsDialog } from "./dialogs/SettingsDialog";
import { DiagnosticDialog } from "./dialogs/DiagnosticDialog";
import { setThemeMode, useTheme } from "./theme";

export type { Toast, View } from "./app-shared";

/** 侧栏宽度：可拖，落进 localStorage；190 是不把「生成历史」挤成两行的下限 */
const SIDEBAR_WIDTH_KEY = "yida.sidebar-width";
const SIDEBAR_DEFAULT_WIDTH = 236;
const SIDEBAR_MIN_WIDTH = 190;
const SIDEBAR_MAX_WIDTH = 420;

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
  const theme = useTheme();

  /** 切换工作区直接提交状态，不为整页截图和动画等待渲染。 */
  function switchView(next: View, extra?: () => void) {
    if (next !== view) setView(next);
    extra?.();
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
  // 图片、视频、音乐各自记住渠道与模型，互不干扰
  const [selectedChannelId, setSelectedChannelId] = usePersistentState("channelId", "");
  const [selectedModel, setSelectedModel] = usePersistentState("model", "");
  const [videoChannelId, setVideoChannelId] = usePersistentState("videoChannelId", "");
  const [videoModel, setVideoModel] = usePersistentState("videoModel", "");
  const [musicChannelId, setMusicChannelId] = usePersistentState("musicChannelId", "");
  const [musicModel, setMusicModel] = usePersistentState("musicModel", "");
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
  /** 侧栏里给会话列表留的挂载点：DOM 节点要等挂载后才拿得到，所以用 state 兜一层 */
  const sidebarRecentRef = useRef<HTMLDivElement>(null);
  const [sidebarRecentEl, setSidebarRecentEl] = useState<HTMLElement | null>(null);
  useEffect(() => { setSidebarRecentEl(sidebarRecentRef.current); }, []);
  /** 侧栏头部的工作区菜单与搜索：搜索词透给 ChatView，用它过滤侧栏里的会话列表 */
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  /** 每点一次「新对话」加一；ChatView 盯着它建新会话（0 是初始值，不动手） */
  const [newChatSignal, setNewChatSignal] = useState(0);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);

  /**
   * 侧栏收起（对齐 Codex）。
   *
   * 收起后主区左上角会留一个展开按钮——不能只靠 Ctrl+B，否则忘了快捷键的人
   * 会以为界面坏了。状态存本机，下次打开还是上次的样子。
   */
  const [sidebarHiddenPreference, setSidebarHiddenPreference] = usePersistentState("sidebarHidden", false);
  const [boardSidebarPinned, setBoardSidebarPinned] = usePersistentState("boardSidebarPinned", false);
  const [boardSidebarOpen, setBoardSidebarOpen] = useState(false);
  const boardSidebarPinnedRef = useRef(boardSidebarPinned);
  boardSidebarPinnedRef.current = boardSidebarPinned;
  const onBoardSelected = useCallback(() => { if (!boardSidebarPinnedRef.current) setBoardSidebarOpen(false); }, []);
  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarHidden = view === "board" ? !boardSidebarOpen : sidebarHiddenPreference;
  const boardOverlay = view === "board" && boardSidebarOpen && !boardSidebarPinned;
  const toggleSidebar = useCallback(() => {
    if (view === "board") setBoardSidebarOpen((open) => !open);
    else setSidebarHiddenPreference((hidden) => !hidden);
  }, [view, setSidebarHiddenPreference]);
  const closeSidebar = () => view === "board" ? setBoardSidebarOpen(false) : setSidebarHiddenPreference(true);
  const openSidebar = () => view === "board" ? setBoardSidebarOpen(true) : setSidebarHiddenPreference(false);
  function enterBoard() {
    dismissWelcome();
    if (view !== "board") setBoardSidebarOpen(boardSidebarPinned);
    else setBoardSidebarOpen((open) => !open);
    switchView("board");
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && view === "board" && boardSidebarOpen && !boardSidebarPinned) {
        setBoardSidebarOpen(false);
        return;
      }
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key.toLowerCase() !== "b") return;
      event.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, boardSidebarOpen, boardSidebarPinned, toggleSidebar]);
  useEffect(() => {
    if (!boardOverlay) return;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || sidebarRef.current?.contains(target)) return;
      if (target.closest("[data-sidebar-toggle]")) return;
      setBoardSidebarOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [boardOverlay]);

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

  /** 侧栏宽度：拖右边缘调，存 localStorage（下次打开还是这个宽度） */
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return stored >= SIDEBAR_MIN_WIDTH && stored <= SIDEBAR_MAX_WIDTH ? stored : SIDEBAR_DEFAULT_WIDTH;
  });
  useEffect(() => {
    // 存不下也只是下次回到默认宽度，拖拽本身照常
    try { window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth)); } catch { /* 忽略 */ }
  }, [sidebarWidth]);

  /** 只在拖动期间挂全局监听：不拖的时候不留常驻的 pointermove */
  function startSidebarResize(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const onMove = (move: PointerEvent) => {
      setSidebarWidth(Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, startWidth + move.clientX - startX)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
  }

  // 点别处收起菜单。判定范围要连头部按钮一起包进来，否则点自己会先关再开、等于点不动
  useEffect(() => {
    if (!workspaceMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (!workspaceMenuRef.current?.contains(event.target as Node)) setWorkspaceMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [workspaceMenuOpen]);

  function dismissWelcome() {
    setWelcomeDismissed(true);
    setOnboardingOpen(false);
    try { window.localStorage.setItem("yida.welcome-dismissed", "1"); } catch { /* 存不下也只是下次再显示一遍 */ }
  }

  /** 打开素材目录：和生成历史页那个按钮走同一条接口 */
  async function revealMedia() {
    try {
      const result = await api.revealMedia();
      showToast("success", `已打开素材目录：${result.opened}`);
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "打开素材目录失败");
    }
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
  const references = useReferenceImages(showToast);
  /**
   * 局部重绘只对 openai-images（gpt / gpt-c）且恰好一张参考图生效。
   * 底图一变（删除、替换、加第二张、换渠道），`maskSourceUrl` 就变，旧蒙版自动作废。
   */
  const generateChannel = imageChannels.find((channel) => channel.id === selectedChannelId);
  const maskSourceUrl = generateChannel?.adapterType === "openai-images" && references.images.length === 1
    ? references.images[0].previewUrl
    : null;
  const inpaint = useInpaintMask(maskSourceUrl);

  useEffect(() => {
    void api.bootstrap()
      .then((data) => {
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

  // 图片与视频任务各自轮询，切换视图也不会中断
  useImageTaskEvents(imageTasks, setTasks);
  usePolling(activeVideoTask, setTasks);
  usePolling(activeMusicTask, setTasks);

  // 停在生成历史页时随时把新记录标记成已读：用户正看着，不该再算未读
  useEffect(() => {
    if (view !== "history") return;
    setHistorySeenAt(latestTaskActivity);
  }, [view, latestTaskActivity, setHistorySeenAt]);

  function showToast(kind: Toast["kind"], message: string) {
    setToast({ kind, message });
    window.setTimeout(() => setToast(null), 3200);
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
    try {
      if (request.mode === "task") {
        await api.deleteTask(request.tasks[0].id, keepFiles);
        setTasks(dropLocally);
      } else if (request.mode === "selection") {
        await api.deleteTasks(request.tasks.map((task) => task.id), keepFiles);
        setTasks(dropLocally);
      } else {
        await api.clearTasks(request.scope, keepFiles);
        // 服务端按范围清的是全库记录，本地列表要重新拉一次才不会残留
        try { setTasks(await api.tasks()); } catch { setTasks(dropLocally); }
      }
      if (activeTaskId && removed.has(activeTaskId)) setActiveTaskId(null);
      if (activeVideoTaskId && removed.has(activeVideoTaskId)) setActiveVideoTaskId(null);
      showToast("success", request.mode === "scope" ? "已清空生成历史"
        : request.mode === "task" ? "已删除该记录" : `已删除 ${removed.size} 条记录`);
      setClearRequest(null);
    } catch (error) {
      showToast("error", error instanceof Error ? error.message : "删除失败");
    }
  }

  return (
    <div
      className={`app-shell ${sidebarHidden ? "is-sidebar-hidden" : ""} ${boardOverlay ? "is-board-sidebar-overlay" : ""} ${customChrome ? "has-custom-chrome" : ""}`}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
    >
      {/* decorations:false 之后自己画的标题栏。开关放在这里，和 Codex 一样在窗口左上角 */}
      {customChrome ? (
        <div className="titlebar" data-tauri-drag-region>
          <button
            type="button"
            className="titlebar-toggle"
            data-sidebar-toggle
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
            ChatCanvas
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

      <aside className="sidebar" ref={sidebarRef}>
        {/* 头部对齐 Codex：粗体工作区名 + 一个下拉箭头，右边是搜索——箭头点开是真菜单，不是装饰 */}
        <div className="sidebar-workspace" ref={workspaceMenuRef}>
          <div className="sidebar-head">
            {/* 自绘标题栏之后，开关已经挪到窗口左上角；这里就不再重复一个 */}
            {!customChrome ? (
              <button
                type="button"
                className="icon-button compact sidebar-collapse"
                title="收起侧边栏（Ctrl+B）"
                aria-label="收起侧边栏"
                onClick={closeSidebar}
              >
                <PanelLeftClose size={15} />
              </button>
            ) : null}
            {/*
              logo 点击切换「对话创作 ↔ 无限画布」；旁边的下拉箭头才打开设置菜单。
              这样既满足「点 logo 进画布」，又不把原来的设置入口吞掉。
            */}
            <button
              className="brand"
              title={view === "board" ? "返回对话创作" : "进入无限画布"}
              onClick={() => {
                setWorkspaceMenuOpen(false);
                if (view === "board") {
                  dismissWelcome();
                  switchView("chat");
                } else {
                  enterBoard();
                }
              }}
            >
              <span className="brand-mark"><BrandMark size={18} /></span>
              {/* 两行：英文主名在上，中文名「语布」压成小字在下。代价是侧栏高 10px */}
              <span className="brand-text">
                <span className="brand-name">ChatCanvas</span>
                <span className="brand-sub">语布</span>
              </span>
            </button>
            <button
              type="button"
              className="brand-menu"
              aria-label="工作区菜单"
              aria-expanded={workspaceMenuOpen}
              title="设置 / 素材目录"
              onClick={() => setWorkspaceMenuOpen((open) => !open)}
            >
              <ChevronDown size={14} />
            </button>
            {view === "board" ? <button type="button" className={`icon-button compact sidebar-pin ${boardSidebarPinned ? "is-on" : ""}`}
              aria-label={boardSidebarPinned ? "取消固定侧边栏" : "固定侧边栏"}
              title={boardSidebarPinned ? "取消固定侧边栏" : "固定侧边栏"}
              onClick={() => setBoardSidebarPinned((pinned) => !pinned)}>
              {boardSidebarPinned ? <PinOff size={14} /> : <Pin size={14} />}
            </button> : null}
            <button
              className={`icon-button compact ${searchOpen ? "is-on" : ""}`}
              title="搜索会话"
              aria-label="搜索会话"
              onClick={() => {
                setWorkspaceMenuOpen(false);
                setSearchOpen((open) => !open);
                if (searchOpen) setSearchQuery("");
              }}
            >
              <Search size={15} />
            </button>
          </div>

          {workspaceMenuOpen ? (
            <div className="sidebar-menu">
              <button type="button" className="sidebar-menu-item" onClick={() => { setWorkspaceMenuOpen(false); setAssetDirOpen(true); }}>
                <Settings2 size={14} />设置
              </button>
              <button type="button" className="sidebar-menu-item" onClick={() => { setWorkspaceMenuOpen(false); void revealMedia(); }}>
                <FolderOpen size={14} />打开素材目录
              </button>
              <span className="sidebar-menu-note">ChatCanvas v{APP_VERSION}</span>
            </div>
          ) : null}
        </div>

        {searchOpen ? (
          <input
            className="sidebar-search"
            autoFocus
            value={searchQuery}
            placeholder={view === "board" ? "搜索我的画布" : "搜索会话标题或内容"}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
        ) : null}

        {/* 名字对齐 Codex 的短名：两三个字，不带「工作台」这种前缀 */}
        <nav className="sidebar-nav" aria-label="主导航">
          {/*
            「新对话」点一下就真的开一条新的（不是切回上次那条）。用递增的计数当信号，
            不去碰 ChatView 里的会话状态——那边自己知道怎么建，建完会刷新列表。
            上一次没动过的空会话由服务端在新建时顺手删掉。
          */}
          <NavButton
            active={view === "chat"}
            icon={<SquarePen size={16} />}
            label="新建对话"
            onClick={() => { dismissWelcome(); switchView("chat", () => setNewChatSignal((value) => value + 1)); }}
          />
          <NavButton
            active={view === "board"}
            icon={<LayoutGrid size={16} />}
            label="无限画布"
            onClick={enterBoard}
          />
          <NavButton active={view === "generate"} icon={<ImageIcon size={16} />} label="图片生成" onClick={() => { dismissWelcome(); switchView("generate"); }} />
          <NavButton active={view === "video"} icon={<Film size={16} />} label="视频生成" onClick={() => { dismissWelcome(); switchView("video"); }} />
          <NavButton active={view === "music"} icon={<Music size={16} />} label="音乐生成" onClick={() => { dismissWelcome(); switchView("music"); }} />
          <NavButton active={view === "speech"} icon={<Mic size={16} />} label="语音生成" onClick={() => { dismissWelcome(); switchView("speech"); }} />
          <NavButton active={view === "history"} icon={<History size={16} />} label="素材管理" unread={historyUnread} onClick={() => { dismissWelcome(); switchView("history"); }} />
          <NavButton active={view === "channels"} icon={<Plug size={16} />} label="模型设置" onClick={() => { dismissWelcome(); switchView("channels"); }} />
        </nav>

        {/*
          会话列表的挂载点。列表本身在 ChatView 手里（数据和 SSE 都在那儿），
          用 `createPortal` 塞进来——这样导航只剩侧栏一层，不用把会话状态再往上提一遍。
          不在对话页时这里是空的，「最近」这一组自然就不出现。
        */}
        <div className="sidebar-recent" ref={sidebarRecentRef} />

        <div className="sidebar-foot">
          <span className="status-dot" />
          <span>本地运行</span>
          <UpdateStatus />
        </div>

        {/* 拖这条边调宽窄。用 role=separator + 键盘左右键，纯鼠标操作对键盘用户是死路 */}
        <div
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧栏宽度"
          aria-valuenow={sidebarWidth}
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          tabIndex={0}
          onPointerDown={startSidebarResize}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const step = event.key === "ArrowLeft" ? -16 : 16;
            setSidebarWidth((width) => Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width + step)));
          }}
        />
      </aside>

      <main className={`workspace ${sidebarHidden ? "is-sidebar-hidden" : ""}`}>
        {sidebarHidden && !customChrome && view !== "board" ? (
          <button
            type="button"
            className="sidebar-expand"
            title="展开侧边栏（Ctrl+B）"
            aria-label="展开侧边栏"
            onClick={openSidebar}
          >
            <PanelLeft size={16} />
          </button>
        ) : null}
        {loading ? <LoadingScreen /> : null}
        {!loading && view === "generate" ? (
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
        ) : null}
        {!loading && view === "chat" ? (
          <ChatView
            channels={channels}
            sidebarHost={sidebarRecentEl}
            sidebarFilter={searchOpen ? searchQuery : ""}
            newChatSignal={newChatSignal}
            onNewChatHandled={() => setNewChatSignal(0)}
            onConfigureChannel={setEditorChannel}
            onDiagnostics={openDiagnostics}
            onToast={(kind, text) => showToast(kind === "ok" ? "success" : "error", text)}
          />
        ) : null}
        {!loading && view === "board" ? (
          <BoardWorkspace
            sidebarHost={sidebarRecentEl}
            onOpenMenu={toggleSidebar}
            onBoardSelected={onBoardSelected}
            sidebarOpen={boardSidebarOpen}
            sidebarFilter={searchOpen ? searchQuery : ""}
            onToast={showToast}
          />
        ) : null}
        {!loading && view === "channels" ? (
          <ChannelsView
            channels={channels}
            onAdd={() => setWizardOpen(true)}
            onQuickSetup={() => setOnboardingOpen(true)}
            onEdit={setEditorChannel}
            onDelete={deleteChannel}
            onToast={showToast}
          />
        ) : null}
        {!loading && view === "video" ? (
          <VideoGenerateView
            channels={videoChannels}
            selectedChannelId={videoChannelId}
            selectedModel={videoModel}
            activeTask={activeVideoTask}
            tasks={videoTasks}
            references={references}
            onChannelChange={selectVideoChannel}
            onModelChange={setVideoModel}
            onAddChannel={() => setWizardOpen(true)}
            onConfigureChannel={(channel) => setEditorChannel(channel)}
            onTask={(task) => {
              setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
              setActiveVideoTaskId(task.id);
            }}
            onSelectTask={(task) => setActiveVideoTaskId(task.id)}
            onToast={showToast}
            onDiagnostics={setDiagnosticTask}
          />
        ) : null}
        {!loading && view === "music" ? (
          <MusicGenerateView
            channels={musicChannels}
            selectedChannelId={musicChannelId}
            selectedModel={musicModel}
            activeTask={activeMusicTask}
            tasks={musicTasks}
            onChannelChange={selectMusicChannel}
            onModelChange={setMusicModel}
            onAddChannel={() => setWizardOpen(true)}
            onConfigureChannel={(channel) => setEditorChannel(channel)}
            onTask={(task) => {
              setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
              setActiveMusicTaskId(task.id);
            }}
            onSelectTask={(task) => setActiveMusicTaskId(task.id)}
            onToast={showToast}
            onDiagnostics={setDiagnosticTask}
          />
        ) : null}
        {!loading && view === "speech" ? (
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
        ) : null}
        {!loading && view === "history" ? (
          <HistoryView
            channels={channels}
            tasks={tasks}
            references={references}
            onRefresh={refreshTasks}
            onDelete={requestDeleteTask}
            onDeleteSelected={requestDeleteSelected}
            onClear={requestClearTasks}
            onOpenAssetSettings={() => setAssetDirOpen(true)}
            onDiagnostics={setDiagnosticTask}
            onToast={showToast}
          />
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
      {diagnosticTask ? <DiagnosticDialog task={diagnosticTask} onClose={() => setDiagnosticTask(null)} /> : null}
      {clearRequest ? (
        <ClearHistoryDialog
          mode={clearRequest.mode}
          count={clearRequest.count}
          label={clearRequest.label}
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
      {toast ? <div className={`toast ${toast.kind}`} role="status">{toast.kind === "success" ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}{toast.message}</div> : null}
    </div>
  );
}

function NavButton({ active, icon, label, unread = false, onClick }: {
  active: boolean; icon: React.ReactNode; label: string; unread?: boolean; onClick: () => void;
}) {
  return (
    <button
      className={`nav-button ${active ? "active" : ""}`}
      title={unread ? `${label}：有新记录` : undefined}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
      {unread ? <span className="nav-unread-dot" aria-hidden="true" /> : null}
    </button>
  );
}


