import { useEffect, useRef, useState } from "react";
import {
  Activity, AlertCircle, CheckCircle2, ChevronRight, Download, Eye, History, Image as ImageIcon,
  ImagePlus, KeyRound, LoaderCircle, Plus, RefreshCw, RotateCcw, Server, Settings2, SlidersHorizontal,
  Sparkles, Square, Trash2, Upload, Wand2, X,
} from "lucide-react";
import { api } from "./api";
import { APP_VERSION } from "../shared/app-config";
import { AddChannelWizard } from "./channels/AddChannelWizard";
import { ChannelDialog } from "./channels/ChannelDialog";
import { ChannelsView } from "./channels/ChannelsView";
import type { Asset, Channel, Diagnostic, Task, TaskStatus } from "../shared/types";

type View = "generate" | "channels" | "history";
type Toast = { kind: "success" | "error"; message: string };
type ReferenceImageState = { file: File; previewUrl: string };

const terminalStatuses: TaskStatus[] = ["succeeded", "failed", "cancelled", "expired"];
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REFERENCE_IMAGES = 8;
const DRAFT_STORAGE_PREFIX = "vector-image:generation-draft:";
const openAiSizeGroups = [
  { label: "方形", sizes: ["1024x1024", "2048x2048"] },
  { label: "横向", sizes: ["1280x720", "1536x1024", "1600x1200", "2048x1152", "3840x2160"] },
  { label: "纵向", sizes: ["720x1280", "1024x1536", "1200x1600", "1152x2048", "2160x3840"] },
] as const;

const statusLabels: Record<TaskStatus, string> = {
  queued: "排队中", validating: "校验中", submitting: "提交中", running: "生成中", succeeded: "已完成",
  failed: "失败", cancelled: "已取消", expired: "已超时",
};

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

export interface ReferenceController {
  images: ReferenceImageState[];
  reading: boolean;
  select: (event: React.ChangeEvent<HTMLInputElement>) => void;
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

  return { images, reading, select, remove, clear, addFromAsset };
}

export function App() {
  const [view, setView] = useState<View>("generate");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedChannelId, setSelectedChannelId] = usePersistentState("channelId", "");
  const [selectedModel, setSelectedModel] = usePersistentState("model", "");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [editorChannel, setEditorChannel] = useState<Channel | null | undefined>(undefined);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [diagnosticTask, setDiagnosticTask] = useState<Task | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
  const activeTask = tasks.find((task) => task.id === activeTaskId) ?? null;
  // 参考图状态在 App 层持有，切换视图不丢失（修复切换界面参考图消失）
  const references = useReferenceImages(showToast);

  useEffect(() => {
    void api.bootstrap()
      .then((data) => {
        setChannels(data.channels);
        setTasks(data.tasks);
        const first = data.channels.find((item) => item.id === selectedChannelId && item.enabled)
          ?? data.channels.find((item) => item.enabled)
          ?? data.channels[0];
        if (first) {
          setSelectedChannelId(first.id);
          setSelectedModel(first.models.includes(selectedModel) ? selectedModel : first.models[0] ?? "");
        }
        const latest = data.tasks.find((task) => task.status === "succeeded") ?? data.tasks[0];
        if (latest) setActiveTaskId(latest.id);
      })
      .catch((error) => showToast("error", error.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!activeTask || terminalStatuses.includes(activeTask.status)) return;
    const timer = window.setInterval(() => {
      void api.task(activeTask.id).then((updated) => {
        setTasks((current) => [updated, ...current.filter((item) => item.id !== updated.id)]);
      }).catch(() => undefined);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [activeTask?.id, activeTask?.status]);

  function showToast(kind: Toast["kind"], message: string) {
    setToast({ kind, message });
    window.setTimeout(() => setToast(null), 3200);
  }

  function selectChannel(id: string) {
    const channel = channels.find((item) => item.id === id);
    setSelectedChannelId(id);
    setSelectedModel(channel?.models[0] ?? "");
  }

  async function refreshTasks() {
    try { setTasks(await api.tasks()); } catch (error) { showToast("error", error instanceof Error ? error.message : "刷新失败"); }
  }

  function handleChannelSaved(channel: Channel) {
    setChannels((current) => [channel, ...current.filter((item) => item.id !== channel.id)]);
    if (!selectedChannelId) {
      setSelectedChannelId(channel.id);
      setSelectedModel(channel.models[0] ?? "");
    } else if (selectedChannelId === channel.id && !channel.models.includes(selectedModel)) {
      setSelectedModel(channel.models[0] ?? "");
    }
    setEditorChannel(undefined);
    showToast("success", "渠道已保存");
  }

  function handleWizardSaved(channel: Channel) {
    setChannels((current) => [channel, ...current.filter((item) => item.id !== channel.id)]);
    if (!selectedChannelId || selectedChannelId === channel.id) {
      setSelectedChannelId(channel.id);
      setSelectedModel(channel.models[0] ?? "");
    }
  }

  function handleWizardRemoved(id: string) {
    setChannels((current) => {
      const remaining = current.filter((item) => item.id !== id);
      if (selectedChannelId === id) selectChannel(remaining[0]?.id ?? "");
      return remaining;
    });
  }

  async function deleteChannel(channel: Channel) {
    if (!window.confirm(`删除渠道“${channel.name}”？历史任务仍会保留。`)) return;
    try {
      await api.deleteChannel(channel.id);
      const remaining = channels.filter((item) => item.id !== channel.id);
      setChannels(remaining);
      if (selectedChannelId === channel.id) selectChannel(remaining[0]?.id ?? "");
      showToast("success", "渠道已删除");
    } catch (error) { showToast("error", error instanceof Error ? error.message : "删除失败"); }
  }

  async function deleteTask(task: Task) {
    try {
      await api.deleteTask(task.id);
      setTasks((current) => current.filter((item) => item.id !== task.id));
      if (activeTaskId === task.id) setActiveTaskId(null);
      showToast("success", "已删除该记录");
    } catch (error) { showToast("error", error instanceof Error ? error.message : "删除失败"); }
  }

  async function clearTasks() {
    if (!tasks.length) return;
    if (!window.confirm(`清空全部 ${tasks.length} 条生成记录？此操作不可恢复。`)) return;
    const results = await Promise.allSettled(tasks.map((task) => api.deleteTask(task.id)));
    const failed = results.filter((item) => item.status === "rejected").length;
    try { setTasks(await api.tasks()); } catch { setTasks([]); }
    setActiveTaskId(null);
    if (failed) showToast("error", `${failed} 条记录删除失败`);
    else showToast("success", "已清空生成历史");
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setView("generate")} aria-label="小勤画图">
          <span className="brand-mark"><img src="/app-logo.png" alt="" /></span>
          <span>小勤画图</span>
        </button>
        <nav className="topnav" aria-label="主导航">
          <NavButton active={view === "generate"} icon={<Sparkles size={16} />} label="生图工作台" onClick={() => setView("generate")} />
          <NavButton active={view === "channels"} icon={<Server size={16} />} label="渠道配置" onClick={() => setView("channels")} />
          <NavButton active={view === "history"} icon={<History size={16} />} label="生成历史" onClick={() => setView("history")} />
        </nav>
        <div className="topbar-status">
          <span className="status-dot" />
          <span className="version">v{APP_VERSION}</span>
        </div>
      </header>

      <main className="workspace">
        {loading ? <LoadingScreen /> : null}
        {!loading && view === "generate" ? (
          <GenerateView
            channels={channels}
            selectedChannelId={selectedChannelId}
            selectedModel={selectedModel}
            activeTask={activeTask}
            tasks={tasks}
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
        {!loading && view === "channels" ? (
          <ChannelsView channels={channels} onAdd={() => setWizardOpen(true)} onEdit={setEditorChannel} onDelete={deleteChannel} onToast={showToast} />
        ) : null}
        {!loading && view === "history" ? (
          <HistoryView tasks={tasks} references={references} onRefresh={refreshTasks} onDelete={deleteTask} onClear={clearTasks} onDiagnostics={setDiagnosticTask} onToast={showToast} />
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
      {toast ? <div className={`toast ${toast.kind}`} role="status">{toast.kind === "success" ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}{toast.message}</div> : null}
    </div>
  );
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick}>{icon}<span>{label}</span></button>;
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
        size: requestedSize,
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
        <div><h1>生成工作台</h1><span className="page-kicker">{referenceImages.length ? "IMAGE TO IMAGE" : "TEXT TO IMAGE"}</span></div>
        <div className="header-selects">
          <label><span>渠道</span><select value={props.selectedChannelId} onChange={(event) => props.onChannelChange(event.target.value)}>
            <option value="">选择渠道</option>{props.channels.filter((item) => item.enabled).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          <label><span>模型</span><select value={props.selectedModel} onChange={(event) => props.onModelChange(event.target.value)} disabled={!channel}>
            <option value="">选择模型</option>{channel?.models.map((model) => <option key={model} value={model}>{model}</option>)}
          </select></label>
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
                <div className={`reference-picker ${referenceImages.length ? "has-image" : ""}`}>
                  <label className="reference-add-tile" title="添加参考图">
                    <input className="file-input" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={references.select} disabled={readingImage || submitting || referenceImages.length >= MAX_REFERENCE_IMAGES} />
                    <span className="reference-icon">{readingImage ? <LoaderCircle className="spin" size={21} /> : <ImagePlus size={21} />}</span>
                    <span className="reference-file"><strong>{readingImage ? "读取中" : "添加参考图"}</strong><small>PNG / JPEG / WebP · 单张最大 10 MB</small></span>
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

function HistoryView({ tasks, references, onRefresh, onDelete, onClear, onDiagnostics, onToast }: {
  tasks: Task[]; references: ReferenceController; onRefresh: () => void; onDelete: (task: Task) => void; onClear: () => void; onDiagnostics: (task: Task) => void; onToast: (kind: Toast["kind"], message: string) => void;
}) {
  const [preview, setPreview] = useState<Task | null>(null);
  return (
    <div className="page">
      <div className="page-header">
        <div><h1>历史</h1><span className="page-kicker">GENERATIONS</span></div>
        <div className="header-actions">
          {tasks.length ? <button className="secondary-button" title="清空全部记录" onClick={onClear}><Trash2 size={16} />清空</button> : null}
          <button className="icon-button header-icon" title="刷新历史" onClick={onRefresh}><RefreshCw size={17} /></button>
        </div>
      </div>
      <div className="data-table-wrap">
        <table className="data-table history-table">
          <thead><tr><th aria-label="预览" /><th>任务</th><th>渠道</th><th>模型</th><th>状态</th><th>时间</th><th aria-label="操作" /></tr></thead>
          <tbody>{tasks.map((task) => (
            <tr key={task.id}>
              <td>
                <button type="button" className="history-thumb" title={task.assets.length ? "查看大图" : "暂无图片"} onClick={() => task.assets.length && setPreview(task)}>
                  {task.assets[0]
                    ? <img src={api.assetUrl(task.assets[0].url)} alt="生成结果缩略图" loading="lazy" decoding="async" />
                    : <span className="history-thumb-empty"><ImageIcon size={16} /></span>}
                  {task.assets.length > 1 ? <span className="history-thumb-count">{task.assets.length}</span> : null}
                </button>
              </td>
              <td><button className="prompt-cell" title={task.assets.length ? "查看大图" : task.prompt} onClick={() => task.assets.length ? setPreview(task) : undefined}>{task.prompt}</button></td>
              <td>{task.channelName}</td><td>{task.model}</td>
              <td><StatusBadge status={task.status} /></td><td>{formatTime(task.createdAt)}</td>
              <td><div className="table-actions">
                <button className="icon-button" title="查看诊断" onClick={() => onDiagnostics(task)}><Eye size={16} /></button>
                <button className="icon-button danger" title="删除记录" onClick={() => onDelete(task)}><Trash2 size={16} /></button>
              </div></td>
            </tr>
          ))}</tbody>
        </table>
        {!tasks.length ? <div className="table-empty"><History size={28} /><span>暂无生成记录</span></div> : null}
      </div>
      {preview ? <HistoryPreview task={preview} references={references} onClose={() => setPreview(null)} onToast={onToast} /> : null}
    </div>
  );
}

function HistoryPreview({ task, references, onClose, onToast }: { task: Task; references: ReferenceController; onClose: () => void; onToast: (kind: Toast["kind"], message: string) => void }) {
  const [index, setIndex] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const asset = task.assets[Math.min(index, task.assets.length - 1)];
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  async function download() {
    if (!asset) return;
    setDownloading(true);
    try { if (await api.downloadAsset(asset)) onToast("success", "图片已保存"); }
    catch (error) { onToast("error", error instanceof Error ? error.message : "下载失败"); }
    finally { setDownloading(false); }
  }
  if (!asset) return null;
  return (
    <div className="image-preview-backdrop" role="dialog" aria-modal="true" aria-label="历史图片预览" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="image-preview history-preview">
        <img src={api.assetUrl(asset.url)} alt="历史生成大图" />
        <div className="history-preview-bar">
          <button type="button" className="secondary-button" disabled={downloading} onClick={() => void download()}>{downloading ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}下载</button>
          <button type="button" className="secondary-button" disabled={references.reading} onClick={() => void references.addFromAsset(asset)}><Wand2 size={16} />添加到参考图</button>
          {task.assets.length > 1 ? <div className="history-preview-thumbs">{task.assets.map((item, i) => <button key={item.id} type="button" className={`stage-thumb ${i === index ? "active" : ""}`} onClick={() => setIndex(i)}><img src={api.assetUrl(item.url)} alt={`结果 ${i + 1}`} loading="lazy" decoding="async" /></button>)}</div> : null}
        </div>
        <button type="button" className="image-preview-close" title="关闭预览" aria-label="关闭预览" onClick={onClose}><X size={21} /></button>
      </div>
    </div>
  );
}

function DiagnosticDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const [items, setItems] = useState<Diagnostic[] | null>(null);
  useEffect(() => { void api.diagnostics(task.id).then(setItems).catch(() => setItems([])); }, [task.id]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="modal diagnostic-modal"><div className="modal-header"><div><Activity size={18} /><h2>请求诊断</h2></div><button className="icon-button" title="关闭" onClick={onClose}><X size={18} /></button></div><div className="diagnostic-summary"><StatusBadge status={task.status} /><span>{task.model}</span><span>{task.id.slice(0, 8)}</span></div><div className="diagnostic-list">{items === null ? <LoadingScreen compact /> : items.length ? items.map((item) => <article key={item.id} className="diagnostic-entry"><header><span>HTTP {item.httpStatus ?? "-"}</span><span>{item.durationMs != null ? `${item.durationMs} ms` : ""}</span><span>{formatTime(item.createdAt)}</span></header><h3>Request</h3><pre>{JSON.stringify(item.request, null, 2)}</pre><h3>Response</h3><pre>{JSON.stringify(item.response, null, 2)}</pre></article>) : <div className="table-empty"><Activity size={28} /><span>暂无诊断记录</span></div>}</div></div></div>;
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
