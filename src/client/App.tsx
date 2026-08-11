import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertCircle, CheckCircle2, ChevronRight, Download, Eye, History, Image as ImageIcon,
  ImagePlus, KeyRound, LoaderCircle, Plus, RefreshCw, RotateCcw, Server, Settings2, SlidersHorizontal,
  Sparkles, Square, Trash2, Upload, X,
} from "lucide-react";
import { api } from "./api";
import { APP_VERSION, VECTORENGINE_KEY_ENV, VECTORENGINE_KEY_PLACEHOLDER } from "../shared/app-config";
import type { AdapterType, Channel, ChannelInput, Diagnostic, Task, TaskStatus } from "../shared/types";

type View = "generate" | "channels" | "history";
type Toast = { kind: "success" | "error"; message: string };
type ReferenceImageState = { file: File; previewUrl: string };

const terminalStatuses: TaskStatus[] = ["succeeded", "failed", "cancelled", "expired"];
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REFERENCE_IMAGES = 8;
const openAiSizeGroups = [
  { label: "方形", sizes: ["1024x1024", "2048x2048"] },
  { label: "横向", sizes: ["1280x720", "1536x1024", "1600x1200", "2048x1152", "3840x2160"] },
  { label: "纵向", sizes: ["720x1280", "1024x1536", "1200x1600", "1152x2048", "2160x3840"] },
] as const;

const adapterLabels: Record<AdapterType, string> = {
  "openai-images": "OpenAI Images",
  "openai-chat-image": "OpenAI Chat Image",
  "gemini-content": "Gemini Content",
  "midjourney-task": "Midjourney Task",
  "generic-json": "Generic JSON",
};

const statusLabels: Record<TaskStatus, string> = {
  queued: "排队中", validating: "校验中", submitting: "提交中", running: "生成中", succeeded: "已完成",
  failed: "失败", cancelled: "已取消", expired: "已超时",
};

export function App() {
  const [view, setView] = useState<View>("generate");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedChannelId, setSelectedChannelId] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [editorChannel, setEditorChannel] = useState<Channel | null | undefined>(undefined);
  const [diagnosticTask, setDiagnosticTask] = useState<Task | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
  const activeTask = tasks.find((task) => task.id === activeTaskId) ?? null;

  useEffect(() => {
    void api.bootstrap()
      .then((data) => {
        setChannels(data.channels);
        setTasks(data.tasks);
        const first = data.channels.find((item) => item.enabled) ?? data.channels[0];
        if (first) {
          setSelectedChannelId(first.id);
          setSelectedModel(first.models[0] ?? "");
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

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => setView("generate")} aria-label="Image Relay Studio">
          <span className="brand-mark"><Sparkles size={18} /></span>
          <span>Image Relay</span>
        </button>
        <div className="topbar-status">
          <span className="support-label">向量引擎支持</span>
          <span className="status-dot" />
          <span>本地服务</span>
          <span className="version">v{APP_VERSION}</span>
        </div>
      </header>

      <aside className="sidebar" aria-label="主导航">
        <nav>
          <NavButton active={view === "generate"} icon={<Sparkles size={18} />} label="生成" onClick={() => setView("generate")} />
          <NavButton active={view === "channels"} icon={<Server size={18} />} label="渠道" onClick={() => setView("channels")} />
          <NavButton active={view === "history"} icon={<History size={18} />} label="历史" onClick={() => setView("history")} />
        </nav>
        <div className="sidebar-foot">
          <span>{channels.length}</span>
          <span>个渠道</span>
        </div>
      </aside>

      <main className="workspace">
        {loading ? <LoadingScreen /> : null}
        {!loading && view === "generate" ? (
          <GenerateView
            channels={channels}
            selectedChannelId={selectedChannelId}
            selectedModel={selectedModel}
            activeTask={activeTask}
            onChannelChange={selectChannel}
            onModelChange={setSelectedModel}
            onAddChannel={() => setEditorChannel(null)}
            onConfigureChannel={(channel) => setEditorChannel(channel)}
            onTask={(task) => {
              setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
              setActiveTaskId(task.id);
            }}
            onToast={showToast}
            onDiagnostics={setDiagnosticTask}
          />
        ) : null}
        {!loading && view === "channels" ? (
          <ChannelsView channels={channels} onAdd={() => setEditorChannel(null)} onEdit={setEditorChannel} onDelete={deleteChannel} onToast={showToast} />
        ) : null}
        {!loading && view === "history" ? (
          <HistoryView tasks={tasks} onRefresh={refreshTasks} onSelect={(task) => { setActiveTaskId(task.id); setView("generate"); }} onDiagnostics={setDiagnosticTask} />
        ) : null}
      </main>

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
  channels: Channel[]; selectedChannelId: string; selectedModel: string; activeTask: Task | null;
  onChannelChange: (id: string) => void; onModelChange: (model: string) => void; onAddChannel: () => void; onConfigureChannel: (channel: Channel) => void;
  onTask: (task: Task) => void; onToast: (kind: Toast["kind"], message: string) => void; onDiagnostics: (task: Task) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [size, setSize] = useState("1024x1024");
  const [customWidth, setCustomWidth] = useState("1024");
  const [customHeight, setCustomHeight] = useState("1024");
  const [aspectRatio, setAspectRatio] = useState("auto");
  const [quality, setQuality] = useState("auto");
  const [background, setBackground] = useState<"auto" | "opaque" | "transparent">("auto");
  const [outputFormat, setOutputFormat] = useState<"png" | "jpeg" | "webp">("png");
  const [moderation, setModeration] = useState<"auto" | "low">("auto");
  const [style, setStyle] = useState<"auto" | "vivid" | "natural">("auto");
  const [responseFormat, setResponseFormat] = useState<"auto" | "url" | "b64_json">("auto");
  const [stream, setStream] = useState(false);
  const [imageSize, setImageSize] = useState("auto");
  const [temperature, setTemperature] = useState("");
  const [topP, setTopP] = useState("");
  const [topK, setTopK] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState("");
  const [responseModalities, setResponseModalities] = useState<"IMAGE" | "TEXT,IMAGE">("IMAGE");
  const [seed, setSeed] = useState("");
  const [mjVersion, setMjVersion] = useState("");
  const [processMode, setProcessMode] = useState<"auto" | "fast" | "relax" | "turbo">("auto");
  const [stylize, setStylize] = useState("");
  const [chaos, setChaos] = useState("");
  const [weirdness, setWeirdness] = useState("");
  const [count, setCount] = useState(1);
  const [raw, setRaw] = useState("{}");
  const [referenceImages, setReferenceImages] = useState<ReferenceImageState[]>([]);
  const [readingImage, setReadingImage] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const referenceUrls = useRef(new Set<string>());
  const channel = props.channels.find((item) => item.id === props.selectedChannelId);
  const adapterType = channel?.adapterType;
  const isOpenAi = adapterType === "openai-images" || adapterType === "openai-chat-image" || adapterType === "generic-json";
  const showAspectRatio = adapterType === "gemini-content" || adapterType === "midjourney-task";
  const showCount = adapterType !== "midjourney-task";

  useEffect(() => () => {
    referenceUrls.current.forEach((url) => URL.revokeObjectURL(url));
    referenceUrls.current.clear();
  }, []);

  async function selectReferenceImage(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!files.length) return;
    const remaining = MAX_REFERENCE_IMAGES - referenceImages.length;
    if (files.length > remaining) return props.onToast("error", `参考图最多上传 ${MAX_REFERENCE_IMAGES} 张`);
    const prepared = files.map((file) => ({ file, mimeType: referenceImageMimeType(file) }));
    if (prepared.some((item) => !item.mimeType)) return props.onToast("error", "仅支持 PNG、JPEG 或 WebP 参考图");
    if (files.some((file) => file.size > MAX_REFERENCE_IMAGE_BYTES)) return props.onToast("error", "单张参考图不能超过 10 MB");
    setReadingImage(true);
    try {
      const nextImages = prepared.map(({ file, mimeType }) => {
        const previewUrl = URL.createObjectURL(file);
        referenceUrls.current.add(previewUrl);
        return { file, previewUrl };
      });
      setReferenceImages((current) => [...current, ...nextImages]);
    } catch {
      props.onToast("error", "无法读取参考图");
    } finally {
      setReadingImage(false);
    }
  }

  function removeReferenceImage(previewUrl: string) {
    URL.revokeObjectURL(previewUrl);
    referenceUrls.current.delete(previewUrl);
    setReferenceImages((current) => current.filter((item) => item.previewUrl !== previewUrl));
  }

  function clearReferenceImages() {
    referenceImages.forEach((item) => {
      URL.revokeObjectURL(item.previewUrl);
      referenceUrls.current.delete(item.previewUrl);
    });
    setReferenceImages([]);
  }

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
        stream: isOpenAi && stream ? true : undefined,
        imageSize: adapterType === "gemini-content" && imageSize !== "auto" ? imageSize : undefined,
        temperature: adapterType === "gemini-content" ? optionalNumber(temperature) : undefined,
        topP: adapterType === "gemini-content" ? optionalNumber(topP) : undefined,
        topK: adapterType === "gemini-content" ? optionalNumber(topK) : undefined,
        maxOutputTokens: adapterType === "gemini-content" ? optionalNumber(maxOutputTokens) : undefined,
        responseModalities: adapterType === "gemini-content" ? responseModalities.split(",") as Array<"TEXT" | "IMAGE"> : undefined,
        seed: adapterType === "gemini-content" || adapterType === "midjourney-task" ? optionalNumber(seed) : undefined,
        mjVersion: adapterType === "midjourney-task" ? mjVersion.trim() || undefined : undefined,
        processMode: adapterType === "midjourney-task" && processMode !== "auto" ? processMode : undefined,
        stylize: adapterType === "midjourney-task" ? optionalNumber(stylize) : undefined,
        chaos: adapterType === "midjourney-task" ? optionalNumber(chaos) : undefined,
        weirdness: adapterType === "midjourney-task" ? optionalNumber(weirdness) : undefined,
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
            <div className="section-title"><div><Sparkles size={17} /><h2>提示词</h2></div><span>{prompt.length} / 20000</span></div>
            <textarea className="prompt-input" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={20000} placeholder="输入画面内容、构图、风格与光线…" />
            <div className="reference-block">
              <div className="reference-heading">
                <div><ImagePlus size={16} /><span>参考图</span></div>
                <span className="reference-count">{referenceImages.length}/{MAX_REFERENCE_IMAGES}</span>
                {referenceImages.length ? <button type="button" className="icon-button compact" title="移除全部参考图" onClick={clearReferenceImages}><X size={15} /></button> : null}
              </div>
              <div className={`reference-picker ${referenceImages.length ? "has-image" : ""}`}>
                <label className="reference-add-tile" title="添加参考图">
                  <input className="file-input" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={selectReferenceImage} disabled={readingImage || submitting || referenceImages.length >= MAX_REFERENCE_IMAGES} />
                  <span className="reference-icon">{readingImage ? <LoaderCircle className="spin" size={21} /> : <ImagePlus size={21} />}</span>
                  <span className="reference-file"><strong>{readingImage ? "读取中" : "添加参考图"}</strong><small>PNG / JPEG / WebP · 单张最大 10 MB</small></span>
                  <Upload size={17} />
                </label>
                {referenceImages.map((item, index) => <div className="reference-thumb" key={item.previewUrl}>
                  <img src={item.previewUrl} alt={`参考图 ${index + 1}`} />
                  <button type="button" className="reference-remove" title={`移除参考图 ${index + 1}`} onClick={() => removeReferenceImage(item.previewUrl)}><X size={13} /></button>
                  <span>{item.file.name}</span>
                </div>)}
              </div>
            </div>
            <label className="field-block"><span>负面提示词</span><input value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} placeholder="可选" /></label>

            <div className="section-title parameters-title"><div><SlidersHorizontal size={17} /><h2>参数</h2></div></div>
            <div className="parameter-grid">
              {isOpenAi ? <label><span>尺寸</span><select value={size} onChange={(event) => setSize(event.target.value)}>
                <option value="auto">自动</option>
                {openAiSizeGroups.map((group) => <optgroup key={group.label} label={group.label}>{group.sizes.map((item) => <option key={item} value={item}>{item}</option>)}</optgroup>)}
                <option value="custom">自定义</option>
              </select></label> : null}
              {isOpenAi && size === "custom" ? <div className="custom-size-fields wide-field" aria-label="自定义尺寸">
                <label><span>宽度</span><input type="number" min={64} max={3840} step={16} value={customWidth} onChange={(event) => setCustomWidth(event.target.value)} /></label>
                <span aria-hidden="true">x</span>
                <label><span>高度</span><input type="number" min={64} max={3840} step={16} value={customHeight} onChange={(event) => setCustomHeight(event.target.value)} /></label>
              </div> : null}
              {showAspectRatio ? <label><span>宽高比</span><select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}><option value="auto">自动</option><option>1:1</option><option>2:3</option><option>3:2</option><option>3:4</option><option>4:3</option><option>4:5</option><option>5:4</option><option>9:16</option><option>16:9</option><option>21:9</option></select></label> : null}
              {isOpenAi ? <label><span>质量</span><select value={quality} onChange={(event) => setQuality(event.target.value)}><option value="auto">自动</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label> : null}
              {isOpenAi ? <label><span>背景</span><select value={background} onChange={(event) => setBackground(event.target.value as typeof background)}><option value="auto">自动</option><option value="opaque">不透明</option><option value="transparent">透明</option></select></label> : null}
              {isOpenAi ? <label><span>格式</span><select value={outputFormat} onChange={(event) => setOutputFormat(event.target.value as typeof outputFormat)}><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select></label> : null}
              {showCount ? <label><span>{adapterType === "gemini-content" ? "候选数量" : "数量"}</span><input type="number" min={1} max={8} value={count} onChange={(event) => setCount(Math.max(1, Math.min(8, Number(event.target.value))))} /></label> : null}
            </div>
            {isOpenAi ? <>
              <div className="parameter-subtitle">OpenAI Images</div>
              <div className="parameter-grid">
                <label><span>内容审核</span><select value={moderation} onChange={(event) => setModeration(event.target.value as typeof moderation)}><option value="auto">自动</option><option value="low">低限制</option></select></label>
                <label><span>风格</span><select value={style} onChange={(event) => setStyle(event.target.value as typeof style)}><option value="auto">自动</option><option value="vivid">Vivid</option><option value="natural">Natural</option></select></label>
                <label><span>响应格式</span><select value={responseFormat} onChange={(event) => setResponseFormat(event.target.value as typeof responseFormat)}><option value="auto">自动</option><option value="b64_json">Base64</option><option value="url">URL</option></select></label>
              </div>
              <div className="toggle-row parameter-toggles"><Toggle checked={stream} onChange={setStream} label="流式输出" /></div>
            </> : null}
            {adapterType === "gemini-content" ? <>
              <div className="parameter-subtitle">Gemini Content</div>
              <div className="parameter-grid">
                <label><span>输出尺寸</span><select value={imageSize} onChange={(event) => setImageSize(event.target.value)}><option value="auto">自动</option><option>1K</option><option>2K</option><option>4K</option></select></label>
                <label><span>温度</span><input type="number" min={0} max={2} step={0.1} value={temperature} onChange={(event) => setTemperature(event.target.value)} placeholder="0 - 2" /></label>
                <label><span>Top P</span><input type="number" min={0} max={1} step={0.01} value={topP} onChange={(event) => setTopP(event.target.value)} placeholder="0 - 1" /></label>
                <label><span>Top K</span><input type="number" min={1} max={100} step={1} value={topK} onChange={(event) => setTopK(event.target.value)} placeholder="1 - 100" /></label>
                <label><span>最大输出 Token</span><input type="number" min={1} max={32768} step={1} value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(event.target.value)} placeholder="可选" /></label>
                <label><span>Seed</span><input type="number" min={0} value={seed} onChange={(event) => setSeed(event.target.value)} placeholder="可选" /></label>
                <label><span>响应模态</span><select value={responseModalities} onChange={(event) => setResponseModalities(event.target.value as typeof responseModalities)}><option value="IMAGE">仅图片</option><option value="TEXT,IMAGE">文字 + 图片</option></select></label>
              </div>
            </> : null}
            {adapterType === "midjourney-task" ? <>
              <div className="parameter-subtitle">Midjourney 常用参数</div>
              <div className="parameter-grid">
                <label><span>版本</span><input value={mjVersion} onChange={(event) => setMjVersion(event.target.value)} placeholder="例如 7 或 6.1" /></label>
                <label><span>处理模式</span><select value={processMode} onChange={(event) => setProcessMode(event.target.value as typeof processMode)}><option value="auto">渠道默认</option><option value="fast">Fast</option><option value="relax">Relax</option><option value="turbo">Turbo</option></select></label>
                <label><span>风格化</span><input type="number" min={0} max={3000} value={stylize} onChange={(event) => setStylize(event.target.value)} placeholder="0 - 3000" /></label>
                <label><span>混乱度</span><input type="number" min={0} max={100} value={chaos} onChange={(event) => setChaos(event.target.value)} placeholder="0 - 100" /></label>
                <label><span>奇异度</span><input type="number" min={0} max={3000} value={weirdness} onChange={(event) => setWeirdness(event.target.value)} placeholder="0 - 3000" /></label>
                <label><span>Seed</span><input type="number" min={0} value={seed} onChange={(event) => setSeed(event.target.value)} placeholder="可选" /></label>
              </div>
            </> : null}
            <details className="advanced-panel">
              <summary><Settings2 size={16} /><span>高级 JSON</span><ChevronRight className="details-chevron" size={16} /></summary>
              <textarea className="json-input" spellCheck={false} value={raw} onChange={(event) => setRaw(event.target.value)} />
            </details>
            <div className="submit-row">
              {channel && !channel.hasKey ? <button type="button" className="key-warning" onClick={() => props.onConfigureChannel(channel)}><KeyRound size={15} />填写密钥</button> : <span />}
              <button className="primary-button generate-button" onClick={generate} disabled={submitting || readingImage || !channel || !props.selectedModel}>
                {submitting ? <LoaderCircle className="spin" size={18} /> : <Sparkles size={18} />}生成图片
              </button>
            </div>
          </section>

          <ResultPanel task={props.activeTask} onDiagnostics={props.onDiagnostics} onTask={props.onTask} onToast={props.onToast} />
        </div>
      )}
    </div>
  );
}

function ResultPanel({ task, onDiagnostics, onTask, onToast }: { task: Task | null; onDiagnostics: (task: Task) => void; onTask: (task: Task) => void; onToast: (kind: Toast["kind"], message: string) => void }) {
  const busy = task && !terminalStatuses.includes(task.status);
  async function cancel() {
    if (!task) return;
    try { onTask(await api.cancel(task.id)); } catch (error) { onToast("error", error instanceof Error ? error.message : "取消失败"); }
  }
  async function retry() {
    if (!task) return;
    try { onTask(await api.retry(task.id)); } catch (error) { onToast("error", error instanceof Error ? error.message : "重试失败"); }
  }
  return (
    <section className="result-panel">
      <div className="result-toolbar">
        <div><ImageIcon size={17} /><h2>结果</h2>{task ? <StatusBadge status={task.status} /> : null}</div>
        <div className="icon-actions">
          {task ? <button className="icon-button" title="查看诊断" onClick={() => onDiagnostics(task)}><Eye size={17} /></button> : null}
          {busy ? <button className="icon-button danger" title="取消任务" onClick={cancel}><Square size={16} /></button> : null}
          {task && ["failed", "expired", "cancelled"].includes(task.status) ? <button className="icon-button" title="重新生成" onClick={retry}><RotateCcw size={17} /></button> : null}
        </div>
      </div>
      <div className={`result-canvas ${task?.assets.length ? "has-images" : ""}`}>
        {!task ? <EmptyResult /> : null}
        {busy ? <div className="task-progress"><LoaderCircle className="spin" size={30} /><strong>{statusLabels[task.status]}</strong>{task.progress != null ? <div className="progress-track"><span style={{ width: `${task.progress}%` }} /></div> : null}<span>{task.model}</span></div> : null}
        {task && task.status === "failed" ? <div className="task-error"><AlertCircle size={30} /><strong>{task.errorCode}</strong><span>{task.errorMessage}</span></div> : null}
        {task?.assets.map((asset) => <figure key={asset.id} className="result-image"><img src={api.assetUrl(asset.url)} alt="生成结果" /><a className="image-download" href={api.assetUrl(asset.url)} download={asset.fileName} title="下载图片"><Download size={17} /></a></figure>)}
      </div>
      {task ? <div className="result-meta"><span>{task.channelName}</span><span>{task.model}</span><span>{formatTime(task.createdAt)}</span></div> : null}
    </section>
  );
}

function EmptyResult() {
  return <div className="empty-result"><div className="empty-result-icon"><ImageIcon size={32} /></div><strong>等待生成</strong></div>;
}

function ChannelsView({ channels, onAdd, onEdit, onDelete, onToast }: { channels: Channel[]; onAdd: () => void; onEdit: (channel: Channel) => void; onDelete: (channel: Channel) => void; onToast: (kind: Toast["kind"], message: string) => void }) {
  const [testing, setTesting] = useState<string | null>(null);
  async function test(channel: Channel) {
    setTesting(channel.id);
    try {
      const result = await api.testChannel(channel.id);
      onToast("success", result.message ?? `连接正常 · ${result.httpStatus}${result.durationMs ? ` · ${result.durationMs} ms` : ""}`);
    } catch (error) { onToast("error", error instanceof Error ? error.message : "连接失败"); }
    finally { setTesting(null); }
  }
  return (
    <div className="page">
      <div className="page-header"><div><h1>渠道</h1><span className="page-kicker">CONNECTIONS</span></div><button className="primary-button" onClick={onAdd}><Plus size={17} />添加渠道</button></div>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead><tr><th>名称</th><th>协议</th><th>模型</th><th>密钥</th><th>状态</th><th aria-label="操作" /></tr></thead>
          <tbody>{channels.map((channel) => (
            <tr key={channel.id}>
              <td><button className="table-primary" onClick={() => onEdit(channel)}>{channel.name}</button><span className="table-secondary">{channel.baseUrl}</span></td>
              <td>{adapterLabels[channel.adapterType]}</td><td>{channel.models.length}</td>
              <td>{channel.authType === "none" ? "无需密钥" : channel.hasKey ? <span className="positive"><CheckCircle2 size={15} />已配置</span> : <span className="warning"><AlertCircle size={15} />未配置</span>}</td>
              <td><span className={`channel-state ${channel.enabled ? "enabled" : ""}`}>{channel.enabled ? "启用" : "停用"}</span></td>
              <td><div className="table-actions"><button className="icon-button" title="测试连接" onClick={() => test(channel)} disabled={testing === channel.id}>{testing === channel.id ? <LoaderCircle className="spin" size={16} /> : <Activity size={16} />}</button><button className="icon-button" title="编辑渠道" onClick={() => onEdit(channel)}><Settings2 size={16} /></button><button className="icon-button danger" title="删除渠道" onClick={() => onDelete(channel)}><Trash2 size={16} /></button></div></td>
            </tr>
          ))}</tbody>
        </table>
        {!channels.length ? <div className="table-empty"><Server size={28} /><span>尚无渠道</span></div> : null}
      </div>
    </div>
  );
}

function HistoryView({ tasks, onRefresh, onSelect, onDiagnostics }: { tasks: Task[]; onRefresh: () => void; onSelect: (task: Task) => void; onDiagnostics: (task: Task) => void }) {
  return (
    <div className="page">
      <div className="page-header"><div><h1>历史</h1><span className="page-kicker">GENERATIONS</span></div><button className="icon-button header-icon" title="刷新历史" onClick={onRefresh}><RefreshCw size={17} /></button></div>
      <div className="data-table-wrap">
        <table className="data-table history-table"><thead><tr><th>任务</th><th>渠道</th><th>模型</th><th>状态</th><th>时间</th><th aria-label="操作" /></tr></thead>
          <tbody>{tasks.map((task) => <tr key={task.id}><td><button className="prompt-cell" onClick={() => onSelect(task)}>{task.prompt}</button></td><td>{task.channelName}</td><td>{task.model}</td><td><StatusBadge status={task.status} /></td><td>{formatTime(task.createdAt)}</td><td><button className="icon-button" title="查看诊断" onClick={() => onDiagnostics(task)}><Eye size={16} /></button></td></tr>)}</tbody>
        </table>
        {!tasks.length ? <div className="table-empty"><History size={28} /><span>暂无生成记录</span></div> : null}
      </div>
    </div>
  );
}

function ChannelDialog({ channel, onClose, onSaved }: { channel: Channel | null; onClose: () => void; onSaved: (channel: Channel) => void }) {
  const [form, setForm] = useState(() => ({
    name: channel?.name ?? "", baseUrl: channel?.baseUrl ?? "", adapterType: channel?.adapterType ?? "openai-images" as AdapterType,
    authType: channel?.authType ?? "bearer" as ChannelInput["authType"], authHeaderName: channel?.authHeaderName ?? "",
    secretEnv: channel?.secretEnv ?? VECTORENGINE_KEY_ENV, endpoint: channel?.endpoint ?? "", statusEndpoint: channel?.statusEndpoint ?? "",
    modelsText: channel?.models.join("\n") ?? "", apiKey: "", allowPrivateNetwork: channel?.allowPrivateNetwork ?? false, enabled: channel?.enabled ?? true,
  }));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const defaults = useMemo(() => endpointDefaults(form.adapterType), [form.adapterType]);

  function update<K extends keyof typeof form>(key: K, value: typeof form[K]) { setForm((current) => ({ ...current, [key]: value })); }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    const models = [...new Set(form.modelsText.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
    if (!models.length) return;
    setSaveError("");
    setSaving(true);
    try {
      const saved = await api.saveChannel({
        name: form.name, baseUrl: form.baseUrl, adapterType: form.adapterType, authType: form.authType,
        authHeaderName: form.authHeaderName, secretEnv: form.secretEnv, endpoint: form.endpoint || defaults.endpoint,
        statusEndpoint: form.statusEndpoint || defaults.statusEndpoint, models, apiKey: form.apiKey || undefined,
        allowPrivateNetwork: form.allowPrivateNetwork, enabled: form.enabled,
      }, channel?.id);
      onSaved(saved);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "保存失败，请检查配置后重试");
    } finally { setSaving(false); }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="modal channel-modal" onSubmit={save}>
        <div className="modal-header"><div><Server size={18} /><h2>{channel ? "编辑渠道" : "添加渠道"}</h2></div><button type="button" className="icon-button" title="关闭" onClick={onClose}><X size={18} /></button></div>
        <div className="modal-body">
          <div className="form-grid two"><label><span>名称</span><input required value={form.name} onChange={(event) => update("name", event.target.value)} placeholder="中转渠道" /></label><label><span>适配器</span><select value={form.adapterType} onChange={(event) => update("adapterType", event.target.value as AdapterType)}>{Object.entries(adapterLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
          <label><span>Base URL</span><input required type="url" value={form.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} placeholder="https://relay.example.com" /></label>
          <div className="form-grid two"><label><span>生成路径</span><input value={form.endpoint} onChange={(event) => update("endpoint", event.target.value)} placeholder={defaults.endpoint} /></label>{form.adapterType === "midjourney-task" ? <label><span>状态路径</span><input value={form.statusEndpoint} onChange={(event) => update("statusEndpoint", event.target.value)} placeholder={defaults.statusEndpoint} /></label> : <label><span>鉴权方式</span><select value={form.authType} onChange={(event) => update("authType", event.target.value as ChannelInput["authType"])}><option value="bearer">Bearer</option><option value="x-api-key">x-api-key</option><option value="custom-header">自定义 Header</option><option value="query">Query 参数</option><option value="none">无需鉴权</option></select></label>}</div>
          {form.adapterType === "midjourney-task" ? <label><span>鉴权方式</span><select value={form.authType} onChange={(event) => update("authType", event.target.value as ChannelInput["authType"])}><option value="bearer">Bearer</option><option value="x-api-key">x-api-key</option><option value="custom-header">自定义 Header</option><option value="query">Query 参数</option><option value="none">无需鉴权</option></select></label> : null}
          {form.authType !== "none" ? <div className="form-grid two"><label><span>环境变量</span><input value={form.secretEnv} onChange={(event) => update("secretEnv", event.target.value)} placeholder={VECTORENGINE_KEY_ENV} /></label><label><span>API Key</span><input type="password" value={form.apiKey} onChange={(event) => update("apiKey", event.target.value)} placeholder={channel?.hasKey ? "已配置，留空不修改" : form.baseUrl.includes("vectorengine.cn") ? VECTORENGINE_KEY_PLACEHOLDER : "仅保存在本次服务会话"} /></label></div> : null}
          {form.authType === "custom-header" || form.authType === "query" ? <label><span>{form.authType === "query" ? "参数名" : "Header 名称"}</span><input value={form.authHeaderName} onChange={(event) => update("authHeaderName", event.target.value)} placeholder={form.authType === "query" ? "key" : "x-api-key"} /></label> : null}
          <label><span>模型 ID</span><textarea required className="models-input" value={form.modelsText} onChange={(event) => update("modelsText", event.target.value)} placeholder={"每行一个模型，例如：\ngpt-image-2\ngemini-image"} /></label>
          <div className="toggle-row"><Toggle checked={form.enabled} onChange={(value) => update("enabled", value)} label="启用渠道" /><Toggle checked={form.allowPrivateNetwork} onChange={(value) => update("allowPrivateNetwork", value)} label="允许本地/内网地址" /></div>
          {saveError ? <div className="form-error" role="alert"><AlertCircle size={16} />{saveError}</div> : null}
        </div>
        <div className="modal-footer"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? <LoaderCircle className="spin" size={17} /> : <CheckCircle2 size={17} />}保存</button></div>
      </form>
    </div>
  );
}

function DiagnosticDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const [items, setItems] = useState<Diagnostic[] | null>(null);
  useEffect(() => { void api.diagnostics(task.id).then(setItems).catch(() => setItems([])); }, [task.id]);
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="modal diagnostic-modal"><div className="modal-header"><div><Activity size={18} /><h2>请求诊断</h2></div><button className="icon-button" title="关闭" onClick={onClose}><X size={18} /></button></div><div className="diagnostic-summary"><StatusBadge status={task.status} /><span>{task.model}</span><span>{task.id.slice(0, 8)}</span></div><div className="diagnostic-list">{items === null ? <LoadingScreen compact /> : items.length ? items.map((item) => <article key={item.id} className="diagnostic-entry"><header><span>HTTP {item.httpStatus ?? "-"}</span><span>{item.durationMs != null ? `${item.durationMs} ms` : ""}</span><span>{formatTime(item.createdAt)}</span></header><h3>Request</h3><pre>{JSON.stringify(item.request, null, 2)}</pre><h3>Response</h3><pre>{JSON.stringify(item.response, null, 2)}</pre></article>) : <div className="table-empty"><Activity size={28} /><span>暂无诊断记录</span></div>}</div></div></div>;
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return <label className="toggle"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span className="toggle-track"><span /></span><span>{label}</span></label>;
}

function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`status-badge ${status}`}>{!["succeeded", "failed", "cancelled", "expired"].includes(status) ? <LoaderCircle className="spin" size={13} /> : status === "succeeded" ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}{statusLabels[status]}</span>;
}

function LoadingScreen({ compact = false }: { compact?: boolean }) {
  return <div className={compact ? "loading-compact" : "loading-screen"}><LoaderCircle className="spin" size={24} /><span>加载中</span></div>;
}

function endpointDefaults(adapter: AdapterType) {
  if (adapter === "openai-images") return { endpoint: "/v1/images/generations", statusEndpoint: "" };
  if (adapter === "openai-chat-image") return { endpoint: "/v1/chat/completions", statusEndpoint: "" };
  if (adapter === "gemini-content") return { endpoint: "/v1beta/models/{model}:generateContent", statusEndpoint: "" };
  if (adapter === "midjourney-task") return { endpoint: "/mj/submit/imagine", statusEndpoint: "/mj/task/{taskId}/fetch" };
  return { endpoint: "/v1/images/generations", statusEndpoint: "" };
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
