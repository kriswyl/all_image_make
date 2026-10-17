import { useEffect, useRef, useState } from "react";
import {
  Activity, AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Download, Eye, Film, FolderOpen, History, Image as ImageIcon,
  ImagePlus, KeyRound, LoaderCircle, Minus, PanelLeft, PanelLeftClose, Plug, Plus, RefreshCw, RotateCcw, Search, Server,
  Settings2, SlidersHorizontal, Sparkles, Square, SquarePen, Trash2, Upload, Wand2, X,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, isTauriRuntime } from "./api";
import { BrandMark } from "./BrandMark";
import { APP_VERSION } from "../shared/app-config";
import { AddChannelWizard } from "./channels/AddChannelWizard";
import { ChannelDialog } from "./channels/ChannelDialog";
import { ChannelsView } from "./channels/ChannelsView";
import { ChatView } from "./ChatView";
import { ChannelPicker } from "./chat/ChannelPicker";
import { ModelPicker } from "./chat/ModelPicker";
import { LazyVideoThumb } from "./LazyVideoThumb";
import { ParamChips } from "./ParamChips";
import { useFileDrop } from "./useFileDrop";
import { UpdateStatus } from "./UpdateStatus";
import { VideoGenerateView } from "./VideoGenerateView";
import { WelcomeView } from "./WelcomeView";
import { IMAGE_SIZE_VALUES, MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES, isImageAdapter, isVideoAdapter, isVideoTask } from "../shared/types";
import type { Asset, Channel, ClearScope, Diagnostic, ImageSizeValue, Task, TaskStatus } from "../shared/types";

type View = "generate" | "video" | "chat" | "channels" | "history";
export type Toast = { kind: "success" | "error"; message: string };
type ReferenceImageState = { file: File; previewUrl: string };

const terminalStatuses: TaskStatus[] = ["succeeded", "failed", "cancelled", "expired"];
const DRAFT_STORAGE_PREFIX = "vector-image:generation-draft:";
/** 侧栏宽度：可拖，落进 localStorage；190 是不把「生成历史」挤成两行的下限 */
const SIDEBAR_WIDTH_KEY = "yida.sidebar-width";
const SIDEBAR_DEFAULT_WIDTH = 236;
const SIDEBAR_MIN_WIDTH = 190;
const SIDEBAR_MAX_WIDTH = 420;
const openAiSizeGroups = [
  { label: "方形", sizes: ["1024x1024", "2048x2048"] },
  { label: "横向", sizes: ["1280x720", "1536x1024", "1600x1200", "2048x1152", "3840x2160"] },
  { label: "纵向", sizes: ["720x1280", "1024x1536", "1200x1600", "1152x2048", "2160x3840"] },
] as const;

const statusLabels: Record<TaskStatus, string> = {
  queued: "排队中", validating: "校验中", submitting: "提交中", running: "生成中", succeeded: "已完成",
  failed: "失败", cancelled: "已取消", expired: "已超时",
};

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

function usePersistentState<T>(key: string, initialValue: T) {
  const storageKey = `${DRAFT_STORAGE_PREFIX}${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      return stored === null ? initialValue : JSON.parse(stored) as T;
    } catch {
      return initialValue;
    }
  });
  useEffect(() => {
    try { window.localStorage.setItem(storageKey, JSON.stringify(value)); }
    catch { /* The form still works when storage is unavailable. */ }
  }, [storageKey, value]);
  return [value, setValue] as const;
}

/** 轮询未完成的任务，直到进入终态 */
function usePolling(task: Task | null, setTasks: React.Dispatch<React.SetStateAction<Task[]>>) {
  useEffect(() => {
    if (!task || terminalStatuses.includes(task.status)) return;
    const timer = window.setInterval(() => {
      void api.task(task.id).then((updated) => {
        setTasks((current) => [updated, ...current.filter((item) => item.id !== updated.id)]);
      }).catch(() => undefined);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [task?.id, task?.status, setTasks]);
}

export interface ReferenceController {
  images: ReferenceImageState[];
  reading: boolean;
  select: (event: React.ChangeEvent<HTMLInputElement>) => void;
  /** 拖拽落图：与文件选择框走同一条校验路径 */
  dropFiles: (files: File[]) => void;
  remove: (previewUrl: string) => void;
  clear: () => void;
  addFromAsset: (asset: Asset) => Promise<void>;
}

// 参考图状态提升到 App，使其在切换视图时不被卸载清空，并可从生成结果/历史中追加
function useReferenceImages(onToast: (kind: Toast["kind"], message: string) => void): ReferenceController {
  const [images, setImages] = useState<ReferenceImageState[]>([]);
  const [reading, setReading] = useState(false);
  const referenceUrls = useRef(new Set<string>());

  useEffect(() => () => {
    referenceUrls.current.forEach((url) => URL.revokeObjectURL(url));
    referenceUrls.current.clear();
  }, []);

  function addFiles(files: File[]): boolean {
    if (!files.length) return false;
    const remaining = MAX_REFERENCE_IMAGES - images.length;
    if (files.length > remaining) { onToast("error", `参考图最多上传 ${MAX_REFERENCE_IMAGES} 张`); return false; }
    const prepared = files.map((file) => ({ file, mimeType: referenceImageMimeType(file) }));
    if (prepared.some((item) => !item.mimeType)) { onToast("error", "仅支持 PNG、JPEG 或 WebP 参考图"); return false; }
    if (files.some((file) => file.size > MAX_REFERENCE_IMAGE_BYTES)) { onToast("error", "单张参考图不能超过 10 MB"); return false; }
    const nextImages = prepared.map(({ file }) => {
      const previewUrl = URL.createObjectURL(file);
      referenceUrls.current.add(previewUrl);
      return { file, previewUrl };
    });
    setImages((current) => [...current, ...nextImages]);
    return true;
  }

  function select(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    setReading(true);
    try { addFiles(files); } finally { setReading(false); }
  }

  function dropFiles(files: File[]) {
    if (!files.length) return;
    setReading(true);
    try {
      if (addFiles(files)) onToast("success", `已加入 ${files.length} 张参考图`);
    } finally {
      setReading(false);
    }
  }

  function remove(previewUrl: string) {
    URL.revokeObjectURL(previewUrl);
    referenceUrls.current.delete(previewUrl);
    setImages((current) => current.filter((item) => item.previewUrl !== previewUrl));
  }

  function clear() {
    images.forEach((item) => {
      URL.revokeObjectURL(item.previewUrl);
      referenceUrls.current.delete(item.previewUrl);
    });
    setImages([]);
  }

  async function addFromAsset(asset: Asset) {
    if (images.length >= MAX_REFERENCE_IMAGES) { onToast("error", `参考图最多上传 ${MAX_REFERENCE_IMAGES} 张`); return; }
    setReading(true);
    try {
      const file = await api.assetAsFile(asset);
      if (addFiles([file])) onToast("success", "已加入参考图");
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "无法读取图片");
    } finally {
      setReading(false);
    }
  }

  return { images, reading, select, dropFiles, remove, clear, addFromAsset };
}

export function App() {
  const [view, setView] = useState<View>("generate");
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
  // 图片与视频各自记住渠道与模型，互不干扰
  const [selectedChannelId, setSelectedChannelId] = usePersistentState("channelId", "");
  const [selectedModel, setSelectedModel] = usePersistentState("model", "");
  const [videoChannelId, setVideoChannelId] = usePersistentState("videoChannelId", "");
  const [videoModel, setVideoModel] = usePersistentState("videoModel", "");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeVideoTaskId, setActiveVideoTaskId] = useState<string | null>(null);
  // 上次看过生成历史的时间点，比它新的任务算未读
  const [historySeenAt, setHistorySeenAt] = usePersistentState("historySeenAt", "");
  const [editorChannel, setEditorChannel] = useState<Channel | null | undefined>(undefined);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [diagnosticTask, setDiagnosticTask] = useState<Task | null>(null);
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
  const [sidebarHidden, setSidebarHidden] = usePersistentState("sidebarHidden", false);
  const toggleSidebar = () => setSidebarHidden((hidden) => !hidden);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key.toLowerCase() !== "b") return;
      event.preventDefault();
      setSidebarHidden((hidden) => !hidden);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSidebarHidden]);

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


  /** 一个渠道都没有、用户也还没说「先自己看看」——这时候主区留给新用户向导 */
  const showWelcome = !channels.length && !welcomeDismissed;

  // 对话渠道只是 Agent 的大脑，不出图也不出视频，所以生图 / 视频工作台都要排除它
  const imageChannels = channels.filter((channel) => isImageAdapter(channel.adapterType));
  const videoChannels = channels.filter((channel) => isVideoAdapter(channel.adapterType));
  const imageTasks = tasks.filter((task) => !isVideoTask(task, channels));
  const videoTasks = tasks.filter((task) => isVideoTask(task, channels));
  const activeTask = tasks.find((task) => task.id === activeTaskId) ?? null;
  const activeVideoTask = tasks.find((task) => task.id === activeVideoTaskId) ?? null;
  const latestTaskActivity = latestActivity(tasks);
  const historyUnread = latestTaskActivity > historySeenAt;
  // 参考图状态在 App 层持有，切换视图不丢失（修复切换界面参考图消失）
  const references = useReferenceImages(showToast);

  useEffect(() => {
    void api.bootstrap()
      .then((data) => {
        setChannels(data.channels);
        setTasks(data.tasks);
        setAssetsPath(data.service.assetsPath);
        setDefaultAssetsPath(data.service.defaultAssetsPath);
        const images = data.channels.filter((item) => isImageAdapter(item.adapterType));
        const videos = data.channels.filter((item) => isVideoAdapter(item.adapterType));
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
        const imageHistory = data.tasks.filter((task) => !isVideoTask(task, data.channels));
        const videoHistory = data.tasks.filter((task) => isVideoTask(task, data.channels));
        const latestImage = imageHistory.find((task) => task.status === "succeeded") ?? imageHistory[0];
        if (latestImage) setActiveTaskId(latestImage.id);
        const latestVideo = videoHistory.find((task) => task.status === "succeeded") ?? videoHistory[0];
        if (latestVideo) setActiveVideoTaskId(latestVideo.id);
        // 首次启动把手上已有的历史视为已读，避免一打开就顶着未读小红点
        setHistorySeenAt((current) => current || latestActivity(data.tasks));
      })
      .catch((error) => showToast("error", error.message))
      .finally(() => setLoading(false));
  }, []);

  // 图片与视频任务各自轮询，切换视图也不会中断
  usePolling(activeTask, setTasks);
  usePolling(activeVideoTask, setTasks);

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

  /** 清空指定类型的历史：图片、视频或全部 */
  function requestClearTasks(scope: ClearScope = "all") {
    const target = scope === "image" ? imageTasks : scope === "video" ? videoTasks : tasks;
    if (!target.length) return;
    const label = scope === "image" ? "生图记录" : scope === "video" ? "视频记录" : "记录";
    setClearRequest({ mode: "scope", scope, count: target.length, label, tasks: target });
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
      className={`app-shell ${sidebarHidden ? "is-sidebar-hidden" : ""} ${customChrome ? "has-custom-chrome" : ""}`}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}
    >
      {/* decorations:false 之后自己画的标题栏。开关放在这里，和 Codex 一样在窗口左上角 */}
      {customChrome ? (
        <div className="titlebar" data-tauri-drag-region>
          <button
            type="button"
            className="titlebar-toggle"
            title={sidebarHidden ? "展开侧边栏（Ctrl+B）" : "收起侧边栏（Ctrl+B）"}
            aria-label={sidebarHidden ? "展开侧边栏" : "收起侧边栏"}
            onClick={toggleSidebar}
          >
            {sidebarHidden ? <PanelLeft size={15} /> : <PanelLeftClose size={15} />}
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

      <aside className="sidebar">
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
                onClick={() => setSidebarHidden(true)}
              >
                <PanelLeftClose size={15} />
              </button>
            ) : null}
            <button className="brand" onClick={() => setWorkspaceMenuOpen((open) => !open)} aria-expanded={workspaceMenuOpen}>
              <span className="brand-mark"><BrandMark size={18} /></span>
              {/* 两行：英文主名在上，中文名「语布」压成小字在下。代价是侧栏高 10px */}
              <span className="brand-text">
                <span className="brand-name">ChatCanvas</span>
                <span className="brand-sub">语布</span>
              </span>
              <ChevronDown size={14} className="brand-chevron" />
            </button>
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
            placeholder="搜索会话标题或内容"
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
            label="新对话"
            onClick={() => { dismissWelcome(); setView("chat"); setNewChatSignal((value) => value + 1); }}
          />
          <NavButton active={view === "generate"} icon={<ImageIcon size={16} />} label="生图" onClick={() => { dismissWelcome(); setView("generate"); }} />
          <NavButton active={view === "video"} icon={<Film size={16} />} label="生视频" onClick={() => { dismissWelcome(); setView("video"); }} />
          <NavButton active={view === "history"} icon={<History size={16} />} label="历史" unread={historyUnread} onClick={() => { dismissWelcome(); setView("history"); }} />
          <NavButton active={view === "channels"} icon={<Plug size={16} />} label="渠道" onClick={() => { dismissWelcome(); setView("channels"); }} />
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
        {sidebarHidden && !customChrome ? (
          <button
            type="button"
            className="sidebar-expand"
            title="展开侧边栏（Ctrl+B）"
            aria-label="展开侧边栏"
            onClick={() => setSidebarHidden(false)}
          >
            <PanelLeft size={16} />
          </button>
        ) : null}
        {loading ? <LoadingScreen /> : null}
        {!loading && showWelcome ? <WelcomeView onStart={() => setWizardOpen(true)} onSkip={dismissWelcome} /> : null}
        {!loading && !showWelcome && view === "generate" ? (
          <GenerateView
            channels={imageChannels}
            selectedChannelId={selectedChannelId}
            selectedModel={selectedModel}
            activeTask={activeTask}
            tasks={imageTasks}
            references={references}
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
        {!loading && !showWelcome && view === "chat" ? (
          <ChatView
            channels={channels}
            sidebarHost={sidebarRecentEl}
            sidebarFilter={searchOpen ? searchQuery : ""}
            newChatSignal={newChatSignal}
            onNewChatHandled={() => setNewChatSignal(0)}
            onConfigureChannel={setEditorChannel}
            onToast={(kind, text) => showToast(kind === "ok" ? "success" : "error", text)}
          />
        ) : null}
        {!loading && !showWelcome && view === "channels" ? (
          <ChannelsView channels={channels} onAdd={() => setWizardOpen(true)} onEdit={setEditorChannel} onDelete={deleteChannel} onToast={showToast} />
        ) : null}
        {!loading && !showWelcome && view === "video" ? (
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
        {!loading && !showWelcome && view === "history" ? (
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

function GenerateView(props: {
  channels: Channel[]; selectedChannelId: string; selectedModel: string; activeTask: Task | null; tasks: Task[]; references: ReferenceController;
  onChannelChange: (id: string) => void; onModelChange: (model: string) => void; onAddChannel: () => void; onConfigureChannel: (channel: Channel) => void;
  onTask: (task: Task) => void; onSelectTask: (task: Task) => void; onToast: (kind: Toast["kind"], message: string) => void; onDiagnostics: (task: Task) => void;
}) {
  const [prompt, setPrompt] = usePersistentState("prompt", "");
  const [negativePrompt, setNegativePrompt] = usePersistentState("negativePrompt", "");
  const [size, setSize] = usePersistentState("size", "1024x1024");
  const [customWidth, setCustomWidth] = usePersistentState("customWidth", "1024");
  const [customHeight, setCustomHeight] = usePersistentState("customHeight", "1024");
  const [aspectRatio, setAspectRatio] = usePersistentState("aspectRatio", "auto");
  const [quality, setQuality] = usePersistentState("quality", "auto");
  const [background, setBackground] = usePersistentState<"auto" | "opaque" | "transparent">("background", "auto");
  const [outputFormat, setOutputFormat] = usePersistentState<"png" | "jpeg" | "webp">("outputFormat", "png");
  const [moderation, setModeration] = usePersistentState<"auto" | "low">("moderation", "auto");
  const [style, setStyle] = usePersistentState<"auto" | "vivid" | "natural">("style", "auto");
  const [responseFormat, setResponseFormat] = usePersistentState<"auto" | "url" | "b64_json">("responseFormat", "auto");
  const [imageSize, setImageSize] = usePersistentState("imageSize", "auto");
  const [temperature, setTemperature] = usePersistentState("temperature", "");
  const [topP, setTopP] = usePersistentState("topP", "");
  const [topK, setTopK] = usePersistentState("topK", "");
  const [maxOutputTokens, setMaxOutputTokens] = usePersistentState("maxOutputTokens", "");
  const [responseModalities, setResponseModalities] = usePersistentState<"IMAGE" | "TEXT,IMAGE">("responseModalities", "IMAGE");
  const [seed, setSeed] = usePersistentState("seed", "");
  const [timeoutSeconds, setTimeoutSeconds] = usePersistentState("timeoutSeconds", 180);
  const [count, setCount] = usePersistentState("count", 1);
  const [raw, setRaw] = usePersistentState("raw", "{}");
  const [submitting, setSubmitting] = useState(false);
  const references = props.references;
  const referenceImages = references.images;
  const readingImage = references.reading;
  const channel = props.channels.find((item) => item.id === props.selectedChannelId);
  const adapterType = channel?.adapterType;
  const isOpenAi = adapterType === "openai-images" || adapterType === "openai-chat-image" || adapterType === "generic-json";
  const showAspectRatio = adapterType === "gemini-content";
  const drop = useFileDrop(!submitting && referenceImages.length < MAX_REFERENCE_IMAGES, references.dropFiles);
  const dropActive = drop.active;
  const dropProps = drop.dropProps;

  async function generate() {
    if (!channel) return props.onToast("error", "请先添加渠道");
    if (!props.selectedModel) return props.onToast("error", "请选择模型");
    if (!prompt.trim()) return props.onToast("error", "请输入提示词");
    let requestedSize = size === "auto" ? undefined : size;
    if (size === "custom") {
      requestedSize = customSize(customWidth, customHeight);
      if (!requestedSize) return props.onToast("error", "自定义尺寸须为 16 的倍数，最长边不超过 3840，比例不超过 3:1，总像素为 655360 到 8294400");
    }
    let rawParameters: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error();
      rawParameters = parsed;
    } catch {
      return props.onToast("error", "高级参数必须是 JSON 对象");
    }
    setSubmitting(true);
    try {
      const task = await api.generate({
        channelId: channel.id, model: props.selectedModel, prompt: prompt.trim(), negativePrompt: negativePrompt.trim() || undefined,
        // 尺寸只有 OpenAI 系适配器认（`openAiImageParameters`）；gemini 和视频渠道收到它只会
        // 丢掉，然后在新加的「请求参数」里留一条扎眼的「未发出」——那是我们自己多发的，
        // 不该让用户以为是他的配置有问题
        size: isOpenAi ? requestedSize : undefined,
        aspectRatio: aspectRatio === "auto" ? undefined : aspectRatio,
        count,
        quality: quality === "auto" ? undefined : quality,
        outputFormat,
        background: background === "auto" ? undefined : background,
        moderation: isOpenAi && moderation !== "auto" ? moderation : undefined,
        style: isOpenAi && style !== "auto" ? style : undefined,
        responseFormat: isOpenAi && responseFormat !== "auto" ? responseFormat : undefined,
        imageSize: adapterType === "gemini-content" && imageSize !== "auto" ? imageSize : undefined,
        temperature: adapterType === "gemini-content" ? optionalNumber(temperature) : undefined,
        topP: adapterType === "gemini-content" ? optionalNumber(topP) : undefined,
        topK: adapterType === "gemini-content" ? optionalNumber(topK) : undefined,
        maxOutputTokens: adapterType === "gemini-content" ? optionalNumber(maxOutputTokens) : undefined,
        responseModalities: adapterType === "gemini-content" ? responseModalities.split(",") as Array<"TEXT" | "IMAGE"> : undefined,
        seed: adapterType === "gemini-content" ? optionalNumber(seed) : undefined,
        timeoutMs: timeoutSeconds * 1000,
        rawParameters,
      }, referenceImages.map((item) => item.file));
      props.onTask(task);
      props.onToast("success", "任务已提交");
    } catch (error) { props.onToast("error", error instanceof Error ? error.message : "提交失败"); }
    finally { setSubmitting(false); }
  }

  return (
    <div className="page generate-page">
      <div className="page-header">
        <div><h1>生图</h1><span className="page-kicker">{referenceImages.length ? "IMAGE TO IMAGE" : "TEXT TO IMAGE"}</span></div>
        <div className="header-selects">
          <label><span>渠道</span>
            <ChannelPicker
              className="header-picker header-channel-picker"
              placeholder="选择渠道"
              value={props.selectedChannelId}
              onChange={props.onChannelChange}
              options={props.channels.filter((item) => item.enabled).map((item) => ({
                value: item.id, name: item.name, baseUrl: item.baseUrl,
              }))}
            />
          </label>
          <label><span>模型</span>
            <ModelPicker
              className="header-picker header-model-picker"
              kind="image"
              menuPlacement="down"
              placeholder="选择模型"
              ariaLabel="生图模型"
              value={props.selectedModel}
              disabled={!channel}
              onChange={props.onModelChange}
              options={(channel?.models ?? []).map((model) => ({
                value: model, model, channelName: channel?.name ?? "",
              }))}
            />
          </label>
        </div>
      </div>

      {!props.channels.length ? (
        <div className="empty-page"><Server size={34} /><h2>尚无渠道</h2><button className="primary-button" onClick={props.onAddChannel}><Plus size={17} />添加渠道</button></div>
      ) : (
        <div className="generation-grid">
          <section className="control-panel">
            <div className="control-scroll">
              {/* 基础参数：常驻可见 */}
              <div className="section-title"><div><Sparkles size={17} /><h2>提示词</h2></div><span>{prompt.length} / 20000</span></div>
              <textarea className="prompt-input" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={20000} placeholder="输入画面内容、构图、风格与光线…" />
              <div className="reference-block">
                <div className="reference-heading">
                  <div><ImagePlus size={16} /><span>参考图</span></div>
                  <span className="reference-count">{referenceImages.length}/{MAX_REFERENCE_IMAGES}</span>
                  {referenceImages.length ? <button type="button" className="icon-button compact" title="移除全部参考图" onClick={references.clear}><X size={15} /></button> : null}
                </div>
                <div className={`reference-picker ${referenceImages.length ? "has-image" : ""} ${dropActive ? "is-drop-target" : ""}`} {...dropProps}>
                  <label className="reference-add-tile" title="添加参考图">
                    <input className="file-input" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={references.select} disabled={readingImage || submitting || referenceImages.length >= MAX_REFERENCE_IMAGES} />
                    <span className="reference-icon">{readingImage ? <LoaderCircle className="spin" size={21} /> : <ImagePlus size={21} />}</span>
                    <span className="reference-file"><strong>{dropActive ? "松开即可添加" : readingImage ? "读取中" : "添加参考图"}</strong><small>点击选择，或把图片拖到这里 · PNG / JPEG / WebP · 单张最大 10 MB</small></span>
                    <Upload size={17} />
                  </label>
                  {referenceImages.map((item, index) => <div className="reference-thumb" key={item.previewUrl}>
                    <img src={item.previewUrl} alt={`参考图 ${index + 1}`} />
                    <button type="button" className="reference-remove" title={`移除参考图 ${index + 1}`} onClick={() => references.remove(item.previewUrl)}><X size={13} /></button>
                    <span>{item.file.name}</span>
                  </div>)}
                </div>
              </div>
              <div className="section-title parameters-title"><div><SlidersHorizontal size={17} /><h2>基础参数</h2></div></div>
              <div className="parameter-grid">
                {isOpenAi ? <>
                  <label><span>尺寸</span><select value={size} onChange={(event) => setSize(event.target.value)}>
                    <option value="auto">自动</option>
                    {openAiSizeGroups.map((group) => <optgroup key={group.label} label={group.label}>{group.sizes.map((item) => <option key={item} value={item}>{item}</option>)}</optgroup>)}
                    <option value="custom">自定义</option>
                  </select></label>
                  {size === "custom" ? <div className="custom-size-fields wide-field" aria-label="自定义尺寸">
                    <label><span>宽度</span><input type="number" min={64} max={3840} step={16} value={customWidth} onChange={(event) => setCustomWidth(event.target.value)} /></label>
                    <span aria-hidden="true">x</span>
                    <label><span>高度</span><input type="number" min={64} max={3840} step={16} value={customHeight} onChange={(event) => setCustomHeight(event.target.value)} /></label>
                  </div> : null}
                  <label><span>质量</span><select value={quality} onChange={(event) => setQuality(event.target.value)}><option value="auto">自动</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
                  <label><span>格式</span><select value={outputFormat} onChange={(event) => setOutputFormat(event.target.value as typeof outputFormat)}><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select></label>
                  <label><span>响应格式</span><select value={responseFormat} onChange={(event) => setResponseFormat(event.target.value as typeof responseFormat)}><option value="auto">自动</option><option value="b64_json">Base64</option><option value="url">URL</option></select></label>
                </> : null}
                {showAspectRatio ? <>
                  <label><span>宽高比</span><select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}><option value="auto">自动</option><option>1:1</option><option>2:3</option><option>3:2</option><option>3:4</option><option>4:3</option><option>4:5</option><option>5:4</option><option>9:16</option><option>16:9</option><option>21:9</option></select></label>
                  <label><span>输出尺寸</span><select value={imageSize} onChange={(event) => setImageSize(event.target.value)}><option value="auto">自动</option><option>1K</option><option>2K</option><option>4K</option></select></label>
                </> : null}
              </div>

              {/* 高级参数：默认折叠 */}
              <details className="advanced-panel">
                <summary><Settings2 size={16} /><span>高级参数</span><ChevronRight className="details-chevron" size={16} /></summary>
                <div className="advanced-body">
                  <label className="field-block"><span>负面提示词</span><input value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} placeholder="可选" /></label>
                  {isOpenAi ? <>
                    <div className="parameter-subtitle">OpenAI Images</div>
                    <div className="parameter-grid">
                      <label><span>数量</span><input type="number" min={1} max={8} value={count} onChange={(event) => setCount(Math.max(1, Math.min(8, Number(event.target.value))))} /></label>
                      <label><span>背景</span><select value={background} onChange={(event) => setBackground(event.target.value as typeof background)}><option value="auto">自动</option><option value="opaque">不透明</option><option value="transparent">透明</option></select></label>
                      <label><span>内容审核</span><select value={moderation} onChange={(event) => setModeration(event.target.value as typeof moderation)}><option value="auto">自动</option><option value="low">低限制</option></select></label>
                      <label><span>风格</span><select value={style} onChange={(event) => setStyle(event.target.value as typeof style)}><option value="auto">自动</option><option value="vivid">Vivid</option><option value="natural">Natural</option></select></label>
                    </div>
                  </> : null}
                  {adapterType === "gemini-content" ? <>
                    <div className="parameter-subtitle">Gemini Content</div>
                    <div className="parameter-grid">
                      <label><span>候选数量</span><input type="number" min={1} max={8} value={count} onChange={(event) => setCount(Math.max(1, Math.min(8, Number(event.target.value))))} /></label>
                      <label><span>温度</span><input type="number" min={0} max={2} step={0.1} value={temperature} onChange={(event) => setTemperature(event.target.value)} placeholder="0 - 2" /></label>
                      <label><span>Top P</span><input type="number" min={0} max={1} step={0.01} value={topP} onChange={(event) => setTopP(event.target.value)} placeholder="0 - 1" /></label>
                      <label><span>Top K</span><input type="number" min={1} max={100} step={1} value={topK} onChange={(event) => setTopK(event.target.value)} placeholder="1 - 100" /></label>
                      <label><span>最大输出 Token</span><input type="number" min={1} max={32768} step={1} value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(event.target.value)} placeholder="可选" /></label>
                      <label><span>Seed</span><input type="number" min={0} value={seed} onChange={(event) => setSeed(event.target.value)} placeholder="可选" /></label>
                      <label><span>响应模态</span><select value={responseModalities} onChange={(event) => setResponseModalities(event.target.value as typeof responseModalities)}><option value="IMAGE">仅图片</option><option value="TEXT,IMAGE">文字 + 图片</option></select></label>
                    </div>
                  </> : null}
                  <div className="parameter-subtitle">生成超时</div>
                  <div className="parameter-grid">
                    <label>
                      <span>等待时长 <small>秒</small></span>
                      <input type="number" min={10} max={1800} step={10} value={timeoutSeconds}
                        onChange={(event) => setTimeoutSeconds(Math.max(10, Math.min(1800, Number(event.target.value) || 180)))} />
                    </label>
                    <label>
                      <span>快速选择</span>
                      <select value={[60, 180, 300, 600, 900].includes(timeoutSeconds) ? String(timeoutSeconds) : "custom"}
                        onChange={(event) => { if (event.target.value !== "custom") setTimeoutSeconds(Number(event.target.value)); }}>
                        <option value="60">1 分钟</option>
                        <option value="180">3 分钟（默认）</option>
                        <option value="300">5 分钟</option>
                        <option value="600">10 分钟</option>
                        <option value="900">15 分钟</option>
                        <option value="custom">自定义</option>
                      </select>
                    </label>
                  </div>
                  <div className="parameter-subtitle">高级 JSON</div>
                  <textarea className="json-input" spellCheck={false} value={raw} onChange={(event) => setRaw(event.target.value)} />
                </div>
              </details>
            </div>

            {/* 生成按钮吸底常驻 */}
            <div className="submit-row">
              {channel && !channel.hasKey ? <button type="button" className="key-warning" onClick={() => props.onConfigureChannel(channel)}><KeyRound size={15} />填写密钥</button> : <span />}
              <button className="primary-button generate-button" onClick={generate} disabled={submitting || readingImage || !channel || !props.selectedModel}>
                {submitting ? <LoaderCircle className="spin" size={18} /> : <Sparkles size={18} />}生成图片
              </button>
            </div>
          </section>

          <ResultPanel task={props.activeTask} tasks={props.tasks} references={references} onDiagnostics={props.onDiagnostics} onTask={props.onTask} onSelectTask={props.onSelectTask} onToast={props.onToast} />
        </div>
      )}
    </div>
  );
}

function ResultPanel({ task, tasks, references, onDiagnostics, onTask, onSelectTask, onToast }: {
  task: Task | null; tasks: Task[]; references: ReferenceController;
  onDiagnostics: (task: Task) => void; onTask: (task: Task) => void; onSelectTask: (task: Task) => void; onToast: (kind: Toast["kind"], message: string) => void;
}) {
  const busy = task && !terminalStatuses.includes(task.status);
  const [downloadingAssetId, setDownloadingAssetId] = useState<string | null>(null);
  const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  // 最近生成：取有图片的成功任务，供缩略图快速切换
  const recentTasks = tasks.filter((item) => item.status === "succeeded" && item.assets.length).slice(0, 12);
  const activeAsset = task?.assets.find((item) => item.id === selectedAssetId) ?? task?.assets[0] ?? null;
  useEffect(() => { setSelectedAssetId(task?.assets[0]?.id ?? null); }, [task?.id, task?.assets.length]);
  useEffect(() => {
    if (!previewAsset) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setPreviewAsset(null); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [previewAsset]);
  async function cancel() {
    if (!task) return;
    try { onTask(await api.cancel(task.id)); } catch (error) { onToast("error", error instanceof Error ? error.message : "取消失败"); }
  }
  async function retry() {
    if (!task) return;
    try { onTask(await api.retry(task.id)); onToast("success", "已重新提交"); } catch (error) { onToast("error", error instanceof Error ? error.message : "重试失败"); }
  }
  async function download(asset: Asset) {
    setDownloadingAssetId(asset.id);
    try {
      const saved = await api.downloadAsset(asset);
      if (saved) onToast("success", "图片已保存");
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "下载失败");
    } finally {
      setDownloadingAssetId(null);
    }
  }
  return (
    <section className="result-panel">
      <div className="result-toolbar">
        <div><ImageIcon size={17} /><h2>结果</h2>{task ? <StatusBadge status={task.status} /> : null}</div>
        <div className="icon-actions">
          {task ? <button className="icon-button" title="查看诊断" onClick={() => onDiagnostics(task)}><Eye size={17} /></button> : null}
          {busy ? <button className="icon-button danger" title="取消任务" onClick={cancel}><Square size={16} /></button> : null}
        </div>
      </div>
      <div className={`result-stage ${activeAsset ? "has-image" : ""}`}>
        {!task ? <EmptyResult /> : null}
        {busy ? <div className="task-progress"><LoaderCircle className="spin" size={30} /><strong>{statusLabels[task.status]}</strong>{task.progress != null ? <div className="progress-track"><span style={{ width: `${task.progress}%` }} /></div> : null}<span>{task.model}</span></div> : null}
        {task && task.status === "failed" ? <div className="task-error"><AlertCircle size={30} /><strong>{task.errorCode}</strong><span>{task.errorMessage}</span></div> : null}
        {task && !busy && task.status !== "failed" && !task.assets.length ? <EmptyResult /> : null}
        {activeAsset ? <figure className="stage-image"><img src={api.assetUrl(activeAsset.url)} alt="生成结果" title="双击放大" onDoubleClick={() => setPreviewAsset(activeAsset)} /></figure> : null}
      </div>
      {/*
        请求参数（需求.md 问题 1 D）：和 Agent 工具卡片同一个核对结果，只是这里折叠起来。
        失败时默认展开——参数被吞掉正是失败的常见原因，这时候再让用户多点一次是添乱。
        `open` 只在「从没展开过」到 true 时被 React 写一次，用户手动收起不会被抢回来。
      */}
      {task?.parameterNotes?.length ? (
        <details className="result-params" open={task.status === "failed"}>
          <summary>请求参数</summary>
          <ParamChips notes={task.parameterNotes} />
        </details>
      ) : null}
      {activeAsset ? (
        <div className="result-actions">
          <button type="button" className="secondary-button" disabled={downloadingAssetId === activeAsset.id} onClick={() => void download(activeAsset)}>
            {downloadingAssetId === activeAsset.id ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}下载
          </button>
          <button type="button" className="secondary-button" onClick={retry}><RotateCcw size={16} />重生成</button>
          <button type="button" className="secondary-button" disabled={references.reading} onClick={() => void references.addFromAsset(activeAsset)}><Wand2 size={16} />用作参考图</button>
          {task && task.assets.length > 1 ? (
            <div className="stage-thumbs" role="tablist" aria-label="本次生成结果">
              {task.assets.map((asset, index) => (
                <button key={asset.id} type="button" className={`stage-thumb ${asset.id === activeAsset.id ? "active" : ""}`} title={`结果 ${index + 1}`} onClick={() => setSelectedAssetId(asset.id)}>
                  <img src={api.assetUrl(asset.url)} alt={`结果 ${index + 1}`} loading="lazy" decoding="async" />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {recentTasks.length ? (
        <div className="recent-strip" aria-label="最近生成">
          <span className="recent-label">最近</span>
          <div className="recent-thumbs">
            {recentTasks.map((item) => (
              <button key={item.id} type="button" className={`recent-thumb ${item.id === task?.id ? "active" : ""}`} title={item.prompt} onClick={() => onSelectTask(item)}>
                <img src={api.assetUrl(item.assets[0].url)} alt="最近生成" loading="lazy" decoding="async" />
                {item.assets.length > 1 ? <span className="recent-thumb-count">{item.assets.length}</span> : null}
              </button>
            ))}
          </div>
        </div>
      ) : task ? <div className="result-meta"><span>{task.channelName}</span><span>{task.model}</span><span>{formatTime(task.createdAt)}</span></div> : null}
      {previewAsset ? <div className="image-preview-backdrop" role="dialog" aria-modal="true" aria-label="图片预览" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewAsset(null); }}><div className="image-preview"><img src={api.assetUrl(previewAsset.url)} alt="生成结果放大预览" /><button type="button" className="image-preview-close" title="关闭预览" aria-label="关闭预览" onClick={() => setPreviewAsset(null)}><X size={21} /></button></div></div> : null}
    </section>
  );
}

function EmptyResult() {
  return <div className="empty-result"><div className="empty-result-icon"><ImageIcon size={32} /></div><strong>等待生成</strong></div>;
}

function HistoryView({ channels, tasks, references, onRefresh, onDelete, onDeleteSelected, onClear, onOpenAssetSettings, onDiagnostics, onToast }: {
  channels: Channel[];
  tasks: Task[];
  references: ReferenceController;
  onRefresh: () => void;
  onDelete: (task: Task) => void;
  onDeleteSelected: (tasks: Task[]) => void;
  onClear: (scope?: ClearScope) => void;
  onOpenAssetSettings: () => void;
  onDiagnostics: (task: Task) => void;
  onToast: (kind: Toast["kind"], message: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | "image" | "video">("all");
  const [preview, setPreview] = useState<Task | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const selectAllRef = useRef<HTMLInputElement>(null);
  const imageTasks = tasks.filter((task) => !isVideoTask(task, channels));
  const videoTasks = tasks.filter((task) => isVideoTask(task, channels));
  const filtered = filter === "image" ? imageTasks : filter === "video" ? videoTasks : tasks;
  const selectedTasks = tasks.filter((task) => selected.has(task.id));
  const allFilteredSelected = filtered.length > 0 && filtered.every((task) => selected.has(task.id));

  // 列表刷新后，已经被删掉/过期的勾选要跟着清掉，否则「已选 N 条」和实际能删的对不上
  useEffect(() => {
    setSelected((current) => {
      if (!current.size) return current;
      const alive = new Set(tasks.map((task) => task.id));
      const next = new Set([...current].filter((id) => alive.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [tasks]);

  // 半选状态只能通过 DOM 属性设置，React 没有对应的 prop
  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = selected.size > 0 && !allFilteredSelected;
  }, [selected, allFilteredSelected]);

  /** 换筛选时清空勾选：勾中的可能已经不在眼前，留着会出现「看不见却被删掉」 */
  function changeFilter(next: "all" | "image" | "video") {
    setFilter(next);
    setSelected(new Set());
  }

  function toggleAll() {
    setSelected(allFilteredSelected ? new Set() : new Set(filtered.map((task) => task.id)));
  }

  function toggleOne(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // 图片视频都落在应用数据目录里，路径不好记，给个按钮直接翻到那儿
  async function revealMedia() {
    try {
      const result = await api.revealMedia();
      onToast("success", `已打开素材目录：${result.opened}`);
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "打开素材目录失败");
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div><h1>历史</h1><span className="page-kicker">GENERATIONS</span></div>
        <div className="header-actions">
          <div className="filter-tabs">
            <button className={filter === "all" ? "active" : ""} onClick={() => changeFilter("all")}>全部 ({tasks.length})</button>
            <button className={filter === "image" ? "active" : ""} onClick={() => changeFilter("image")}>图片 ({imageTasks.length})</button>
            <button className={filter === "video" ? "active" : ""} onClick={() => changeFilter("video")}>视频 ({videoTasks.length})</button>
          </div>
          {selected.size ? (
            <div className="selection-bar">
              <span>已选 <strong>{selected.size}</strong> 条</span>
              <button className="secondary-button danger" onClick={() => onDeleteSelected(selectedTasks)}><Trash2 size={16} />删除选中</button>
              <button className="secondary-button" onClick={() => setSelected(new Set())}>取消选择</button>
            </div>
          ) : null}
          {filtered.length ? <button className="secondary-button" title={`清空${filter === "all" ? "全部" : filter === "image" ? "图片" : "视频"}记录`} onClick={() => onClear(filter === "all" ? "all" : filter)}><Trash2 size={16} />清空</button> : null}
          <button className="secondary-button" title="打开图片与视频的保存目录" onClick={() => void revealMedia()}><FolderOpen size={16} />素材目录</button>
          <button className="secondary-button" title="素材目录、gemini 渠道缺省输出尺寸" onClick={onOpenAssetSettings}><Settings2 size={16} />设置</button>
          <button className="icon-button header-icon" title="刷新历史" onClick={onRefresh}><RefreshCw size={17} /></button>
        </div>
      </div>
      <div className="data-table-wrap">
        <table className="data-table history-table">
          <thead><tr>
            <th className="history-select"><input ref={selectAllRef} type="checkbox" checked={allFilteredSelected} disabled={!filtered.length} onChange={toggleAll} aria-label="全选当前列表" /></th>
            <th aria-label="预览" /><th>任务</th><th>渠道</th><th>模型</th><th>状态</th><th>时间</th><th aria-label="操作" />
          </tr></thead>
          <tbody>{filtered.map((task) => {
            const isVideo = isVideoTask(task, channels);
            return (
              <tr key={task.id} className={selected.has(task.id) ? "selected" : ""}>
                <td className="history-select"><input type="checkbox" checked={selected.has(task.id)} onChange={() => toggleOne(task.id)} aria-label="勾选该记录" /></td>
                <td>
                  <button type="button" className="history-thumb" title={task.assets.length ? "查看详情" : "暂无产物"} onClick={() => task.assets.length && setPreview(task)}>
                    {task.assets[0]
                      ? isVideo
                        ? <LazyVideoThumb src={api.assetUrl(task.assets[0].url)} alt="生成结果缩略图" />
                        : <img src={api.assetUrl(task.assets[0].url)} alt="生成结果缩略图" loading="lazy" decoding="async" />
                      : <span className="history-thumb-empty">{isVideo ? <Film size={16} /> : <ImageIcon size={16} />}</span>}
                    {task.assets.length > 1 ? <span className="history-thumb-count">{task.assets.length}</span> : null}
                  </button>
                </td>
                <td><button className="prompt-cell" title={task.assets.length ? "查看详情" : task.prompt} onClick={() => task.assets.length ? setPreview(task) : undefined}>{task.prompt}</button></td>
                <td>{task.channelName}</td><td>{task.model}</td>
                <td><StatusBadge status={task.status} /></td><td>{formatTime(task.createdAt)}</td>
                <td><div className="table-actions">
                  <button className="icon-button" title="查看诊断" onClick={() => onDiagnostics(task)}><Eye size={16} /></button>
                  <button className="icon-button danger" title="删除记录" onClick={() => onDelete(task)}><Trash2 size={16} /></button>
                </div></td>
              </tr>
            );
          })}</tbody>
        </table>
        {!filtered.length ? <div className="table-empty"><History size={28} /><span>暂无生成记录</span></div> : null}
      </div>
      {preview ? <HistoryPreview task={preview} channels={channels} references={references} onClose={() => setPreview(null)} onToast={onToast} /> : null}
    </div>
  );
}

function HistoryPreview({ task, channels, references, onClose, onToast }: {
  task: Task;
  channels: Channel[];
  references: ReferenceController;
  onClose: () => void;
  onToast: (kind: Toast["kind"], message: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const isVideo = isVideoTask(task, channels);
  const asset = task.assets[Math.min(index, task.assets.length - 1)];
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  async function download() {
    if (!asset) return;
    setDownloading(true);
    try { if (await api.downloadAsset(asset)) onToast("success", isVideo ? "视频已保存" : "图片已保存"); }
    catch (error) { onToast("error", error instanceof Error ? error.message : "下载失败"); }
    finally { setDownloading(false); }
  }
  if (!asset) return null;
  const isAssetVideo = asset.mimeType.startsWith("video/");
  return (
    <div className="image-preview-backdrop" role="dialog" aria-modal="true" aria-label="历史预览" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="image-preview history-preview">
        {/* disablePictureInPicture / disableRemotePlayback 去掉悬停时浮出的「画中画」「投屏」按钮 */}
        {isAssetVideo ? (
          <video src={api.assetUrl(asset.url)} controls autoPlay loop disablePictureInPicture disableRemotePlayback />
        ) : (
          <img src={api.assetUrl(asset.url)} alt="历史生成大图" />
        )}
        <div className="history-preview-bar">
          <button type="button" className="secondary-button" disabled={downloading} onClick={() => void download()}>{downloading ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}下载</button>
          {!isVideo ? <button type="button" className="secondary-button" disabled={references.reading} onClick={() => void references.addFromAsset(asset)}><Wand2 size={16} />添加到参考图</button> : null}
          {task.assets.length > 1 ? <div className="history-preview-thumbs">{task.assets.map((item, i) => {
            const thumbIsVideo = item.mimeType.startsWith("video/");
            return (
              <button key={item.id} type="button" className={`stage-thumb ${i === index ? "active" : ""}`} onClick={() => setIndex(i)}>
                {thumbIsVideo ? <video src={api.assetUrl(item.url)} muted playsInline preload="metadata" /> : <img src={api.assetUrl(item.url)} alt={`结果 ${i + 1}`} loading="lazy" decoding="async" />}
              </button>
            );
          })}</div> : null}
        </div>
        <button type="button" className="image-preview-close" title="关闭预览" aria-label="关闭预览" onClick={onClose}><X size={21} /></button>
      </div>
    </div>
  );
}

/**
 * 清空历史 / 删除记录的确认弹窗。
 *
 * 除了二次确认，还要问清楚磁盘上的图片视频删不删——以前是直接删，
 * 想留图的用户只能自己去素材目录翻。
 */
function ClearHistoryDialog({ mode, count, label, onClose, onConfirm }: {
  mode: "task" | "selection" | "scope";
  count: number;
  label: string;
  onClose: () => void;
  onConfirm: (keepFiles: boolean) => Promise<void>;
}) {
  // 默认连文件一起删：和改动前的行为一致，也避免磁盘无限增长
  const [deleteFiles, setDeleteFiles] = useState(true);
  const [busy, setBusy] = useState(false);
  // 「清空」和「删除选中的几条」是两件事，标题和按钮都得分开说
  const scopeClear = mode === "scope";
  const title = scopeClear ? "清空历史" : mode === "selection" ? "删除选中的记录" : "删除记录";

  async function confirm() {
    setBusy(true);
    try { await onConfirm(!deleteFiles); } finally { setBusy(false); }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="modal narrow" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <div><Trash2 size={18} /><h2>{title}</h2></div>
          <button className="icon-button" title="关闭" onClick={onClose} disabled={busy}><X size={18} /></button>
        </div>
        <div className="modal-body">
          <p className="modal-lead">将删除 {count} 条{label}。删除记录不可恢复，请确认本地文件怎么处理。</p>
          <div className="confirm-options" role="radiogroup" aria-label="本地文件处理方式">
            <label className={`confirm-option ${deleteFiles ? "selected" : ""}`}>
              <input type="radio" name="clear-files" checked={deleteFiles} onChange={() => setDeleteFiles(true)} />
              <span>
                <strong>同时删除本地文件</strong>
                <small>记录和磁盘上的图片、视频一起删除，无法恢复。该任务上传的参考图也会一并清理。</small>
              </span>
            </label>
            <label className={`confirm-option ${!deleteFiles ? "selected" : ""}`}>
              <input type="radio" name="clear-files" checked={!deleteFiles} onChange={() => setDeleteFiles(false)} />
              <span>
                <strong>仅删除记录，保留本地文件</strong>
                <small>图片和视频留在素材目录里，只是不再显示在生成历史中，之后可以自己去目录里整理。</small>
              </span>
            </label>
          </div>
        </div>
        <div className="modal-footer">
          <button className="secondary-button" onClick={onClose} disabled={busy}>取消</button>
          <button className="primary-button danger" onClick={() => void confirm()} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />}
            {scopeClear ? `清空 ${count} 条` : count === 1 ? "删除" : `删除 ${count} 条`}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 设置：素材目录 + gemini 渠道的缺省输出尺寸。
 *
 * 目录由桌面版的原生选择器挑，服务端只负责校验和落库；切换只影响之后生成的
 * 产物，历史记录里的旧产物按各自记录保存的目录读取，不会被搬动。
 *
 * 输出尺寸这一项是需求.md 问题 1 的产物：gemini 系站点要求请求体里必须带
 * `imageConfig.imageSize`，缺了上游直接回「Unsupported resolution」。补默认值
 * 时必须让用户看得见、也改得动——所以它在这儿，而不是藏在某个常量里。
 */
function SettingsDialog({ assetsDir, defaultAssetsDir, onClose, onChanged, onToast }: {
  assetsDir: string;
  defaultAssetsDir: string;
  onClose: () => void;
  onChanged: (assetsDir: string) => void;
  onToast: (kind: Toast["kind"], message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const isDefault = assetsDir === defaultAssetsDir;
  const canPick = isTauriRuntime();
  const [imageSize, setImageSize] = useState<ImageSizeValue | null>(null);

  useEffect(() => {
    void api.settings().then((current) => setImageSize(current.geminiImageSize)).catch(() => undefined);
  }, []);

  async function applyImageSize(next: ImageSizeValue) {
    setBusy(true);
    try {
      const result = await api.updateSettings({ geminiImageSize: next });
      setImageSize(result.geminiImageSize);
      onToast("success", `gemini 渠道的缺省尺寸已改为 ${result.geminiImageSize}`);
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "尺寸设置更新失败");
    } finally {
      setBusy(false);
    }
  }

  async function apply(next: string) {
    setBusy(true);
    try {
      const result = await api.updateSettings({ assetsDir: next });
      onChanged(result.assetsDir);
      onToast("success", next === "" ? "已恢复默认素材目录" : "素材目录已更新");
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "素材目录更新失败");
    } finally {
      setBusy(false);
    }
  }

  async function choose() {
    try {
      const picked = await api.pickDirectory();
      if (!picked) return; // 用户取消
      await apply(picked);
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "无法打开目录选择器");
    }
  }

  async function reveal() {
    try {
      const result = await api.revealMedia();
      onToast("success", `已打开素材目录：${result.opened}`);
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "打开素材目录失败");
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="modal narrow" role="dialog" aria-modal="true" aria-label="设置">
        <div className="modal-header">
          <div><Settings2 size={18} /><h2>设置</h2></div>
          <button className="icon-button" title="关闭" onClick={onClose} disabled={busy}><X size={18} /></button>
        </div>
        <div className="modal-body">
          <div className="settings-section">
            <h3>素材目录</h3>
            <p className="modal-lead">生成的图片和视频保存到下面这个目录。{isDefault ? "当前是默认位置。" : "当前使用自定义位置。"}</p>
            <div className="settings-path">{assetsDir || "（未获取到）"}</div>
            <div className="settings-actions">
              <button className="secondary-button" onClick={() => void choose()} disabled={busy || !canPick}>
                <FolderOpen size={16} />更改目录
              </button>
              <button className="secondary-button" onClick={() => void reveal()} disabled={busy}>
                <Eye size={16} />打开目录
              </button>
              <button className="secondary-button" onClick={() => void apply("")} disabled={busy || isDefault}>
                <RotateCcw size={16} />恢复默认
              </button>
            </div>
            <div className="modal-note">
              <AlertCircle size={15} />
              <span>
                {canPick
                  ? "更改目录只影响之后生成的产物。历史记录里的旧图片、视频仍从原来的目录读取，不会被搬动，也不会失效。"
                  : "只有桌面版支持用原生对话框选择目录；Web 开发模式下这里不可用。"}
              </span>
            </div>
          </div>

          <div className="settings-section">
            <h3>gemini 渠道的输出尺寸</h3>
            <p className="modal-lead">
              这类站点要求请求体里必须带 <code>imageConfig.imageSize</code>，缺了直接回「Unsupported resolution」。
              你和助手都没指定尺寸时，就用这里的值补上——工具卡片上会标出「尺寸：{imageSize ?? "2K"}（默认）」，
              不让你猜它到底发了什么。
            </p>
            <div className="settings-segment">
              {IMAGE_SIZE_VALUES.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`secondary-button ${imageSize === value ? "is-on" : ""}`}
                  disabled={busy || imageSize === null}
                  onClick={() => void applyImageSize(value)}
                >
                  {value}{value === "2K" ? "（推荐）" : ""}
                </button>
              ))}
            </div>
            <div className="modal-note">
              <AlertCircle size={15} />
              <span>只影响 gemini 系的渠道，别的渠道不认这个参数。尺寸越大越贵、也越慢，2K 是这类站点最稳的一档。</span>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="secondary-button" onClick={onClose} disabled={busy}>关闭</button>
        </div>
      </div>
    </div>
  );
}

function DiagnosticDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const [items, setItems] = useState<Diagnostic[] | null>(null);
  useEffect(() => { void api.diagnostics(task.id).then(setItems).catch(() => setItems([])); }, [task.id]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="modal diagnostic-modal"><div className="modal-header"><div><Activity size={18} /><h2>请求诊断</h2></div><button className="icon-button" title="关闭" onClick={onClose}><X size={18} /></button></div><div className="diagnostic-summary"><StatusBadge status={task.status} /><span>{task.model}</span><span>{task.id.slice(0, 8)}</span></div><div className="diagnostic-list">{items === null ? <LoadingScreen compact /> : items.length ? items.map((item) => {
      // 中间轮询不存完整响应（一个视频任务上百次能把库撑到几 MB），request 为 null 就是摘要行
      const compact = item.request === null;
      return (
        <article key={item.id} className={`diagnostic-entry ${compact ? "compact" : ""}`}>
          <header>
            <span>HTTP {item.httpStatus ?? "-"}</span>
            <span>{item.durationMs != null ? `${item.durationMs} ms` : ""}</span>
            <span>{formatTime(item.createdAt)}</span>
          </header>
          {compact ? (
            <p className="diagnostic-compact">{pollSummary(item.response)}<small>中间轮询只保留状态摘要，完整响应见最后一次</small></p>
          ) : (
            <><h3>Request</h3><pre>{JSON.stringify(item.request, null, 2)}</pre><h3>Response</h3><pre>{JSON.stringify(item.response, null, 2)}</pre></>
          )}
        </article>
      );
    }) : <div className="table-empty"><Activity size={28} /><span>暂无诊断记录</span></div>}</div></div></div>;
}

function pollSummary(response: unknown) {
  if (!response || typeof response !== "object") return "轮询中";
  const record = response as Record<string, unknown>;
  const parts: string[] = [typeof record.status === "string" ? record.status : "进行中"];
  if (typeof record.progress === "number") parts.push(`${record.progress}%`);
  return `${typeof record.poll === "number" ? `第 ${record.poll} 次轮询 · ` : ""}${parts.join(" · ")}`;
}

function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`status-badge ${status}`}>{!["succeeded", "failed", "cancelled", "expired"].includes(status) ? <LoaderCircle className="spin" size={13} /> : status === "succeeded" ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}{statusLabels[status]}</span>;
}

function LoadingScreen({ compact = false }: { compact?: boolean }) {
  return <div className={compact ? "loading-compact" : "loading-screen"}><LoaderCircle className="spin" size={24} /><span>加载中</span></div>;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function optionalNumber(value: string) {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function customSize(widthValue: string, heightValue: string) {
  if (!/^\d+$/.test(widthValue.trim()) || !/^\d+$/.test(heightValue.trim())) return undefined;
  const width = Number(widthValue);
  const height = Number(heightValue);
  const pixels = width * height;
  const ratio = Math.max(width, height) / Math.min(width, height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64 || width > 3840 || height > 3840) return undefined;
  if (width % 16 !== 0 || height % 16 !== 0 || ratio > 3 || pixels < 655360 || pixels > 8294400) return undefined;
  return `${width}x${height}`;
}

function referenceImageMimeType(file: File): "image/png" | "image/jpeg" | "image/webp" | null {
  if (file.type === "image/png" || file.type === "image/jpeg" || file.type === "image/webp") return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  return null;
}
