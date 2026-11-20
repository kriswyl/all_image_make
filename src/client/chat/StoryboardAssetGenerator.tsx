import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, ChevronDown, ImageIcon, Maximize2, Minus, Sparkles, X } from "lucide-react";
import { api } from "../api";
import { confirmGeneration } from "../generation-confirm";
import { GenerationActivity, statusLabels, terminalStatuses } from "../task-ui";
import { OPENAI_SIZE_PRESETS } from "../../shared/image-sizes";
import { SEEDREAM_ADAPTER, SEEDREAM_RATIOS, SEEDREAM_SIZES, SEEDREAM_SIZE_HINT } from "../../shared/seedream";
import { modelSupportsNegativePrompt } from "../../shared/channel-fields";
import type { Asset, Task, TaskStatus } from "../../shared/types";
import type { StoryboardProjectData } from "../../shared/storyboard-project";
import { defaultImageDraft, imageGenerationParameters, type ImageDraft } from "./storyboard-image-params";
import { ModelPicker } from "./ModelPicker";
import { StoryboardImageViewer } from "./StoryboardImageViewer";
import type { ReferenceKind } from "./StoryboardReferences";

type ImageChoice = { alias: string; model: string; channelName: string; channelId: string; adapterType: string };
export function StoryboardAssetGenerator({ sessionId, visible, kind, item, style, onStatus, onClose, onChoose }: {
  sessionId: string;
  visible: boolean;
  kind: ReferenceKind;
  item: StoryboardProjectData["characters"][number]; style: string;
  onStatus: (sessionId: string, status: TaskStatus | null) => void;
  onClose: () => void; onChoose: (asset: Asset) => void;
}) {
  const label = kind === "characters" ? "角色" : kind === "scenes" ? "场景" : "道具";
  const guide = kind === "characters" ? "同一人物的正面、侧面、背面全身三视图，统一服装、比例和光线，简洁背景，无文字。" : kind === "scenes" ? "展示环境全貌、空间结构、光线与色调，保持场景细节一致，无人物，无文字。" : "清晰展示外形、材质和细节，简洁背景，单件物品，无文字。";
  const [prompt, setPrompt] = useState(() => [`${label}设定图：${item.name}。`, item.prompt, guide, style ? `视觉风格：${style}` : ""].filter(Boolean).join(" "));
  const [choices, setChoices] = useState<ImageChoice[]>([]);
  const [params, setParams] = useState<ImageDraft>({ ...defaultImageDraft });
  const updateParam = (key: keyof ImageDraft, value: string) => setParams((current) => ({ ...current, [key]: value }));
  const [alias, setAlias] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const previewTrigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.capabilities(), api.settings()]).then(([capabilities, settings]) => {
      if (cancelled) return;
      const options = capabilities.aliases.filter((entry) => entry.kind === "image");
      setChoices(options); setAlias(options.find((entry) => entry.alias === settings.defaultImageAlias)?.alias ?? options[0]?.alias ?? "");
    }).catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "加载模型失败"); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  const liveTaskKey = tasks.filter(task => !terminalStatuses.includes(task.status)).map(task => task.id).join(",");
  const status = submitting ? "submitting" : tasks.find(task => !terminalStatuses.includes(task.status))?.status
    ?? (tasks.some(task => task.status === "succeeded") ? "succeeded" : tasks[0]?.status) ?? null;
  const generating = submitting || Boolean(liveTaskKey);
  useEffect(() => { onStatus(sessionId, status); }, [onStatus, sessionId, status]);
  useEffect(() => {
    if (!liveTaskKey) return;
    const ids = liveTaskKey.split(",");
    let stopped = false;
    let timer = window.setTimeout(() => void poll(), 1500);
    async function poll() {
      try {
        const results = await Promise.allSettled(ids.map(id => api.task(id)));
        if (stopped) return;
        const updated = new Map(results.flatMap(result => result.status === "fulfilled" ? [[result.value.id, result.value] as const] : []));
        setTasks(current => current.map(task => updated.get(task.id) ?? task));
        setPollError(results.some(result => result.status === "rejected"));
        if (ids.every(id => terminalStatuses.includes(updated.get(id)?.status ?? "queued"))) return;
      } catch {
        if (stopped) return;
        setPollError(true);
      }
      timer = window.setTimeout(() => void poll(), 1500);
    }
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [liveTaskKey]);
  async function submit() {
    const model = choices.find((entry) => entry.alias === alias);
    if (!model || !prompt.trim() || generating) return;
    let parameters: ReturnType<typeof imageGenerationParameters>;
    try { parameters = imageGenerationParameters(model.adapterType, params); }
    catch (e) { setError(e instanceof Error ? e.message : "参数有误"); return; }
    if (!confirmGeneration({ kind: `${label}参考图生成`, model: model.model, channel: model.channelName, detail: `请求数量：${parameters.count ?? 1} 张${item.assetId ? "；生成后可选择替换当前参考图" : ""}` })) return;
    setSubmitting(true); setError(""); setPollError(false); setTasks([]); setPreviewId(null);
    try {
      const input = { channelId: model.channelId, model: model.model, prompt: prompt.trim(), ...parameters };
      if (model.adapterType === SEEDREAM_ADAPTER && (parameters.count ?? 1) > 1) {
        const result = await api.generateImageBatch(input);
        setTasks(result.tasks);
        if (result.failures.length) setError(result.failures.map(failure => `第 ${failure.index} 张：${failure.message}`).join("；"));
      } else setTasks([await api.generate(input)]);
    }
    catch (e) { setError(e instanceof Error ? e.message : "提交失败"); }
    finally { setSubmitting(false); }
  }
  if (!visible) return null;
  const images = tasks.flatMap(task => task.assets.filter(asset => asset.mimeType.startsWith("image/")));
  const task = tasks.find(item => item.status === "succeeded") ?? tasks[0];
  const currentModel = choices.find((entry) => entry.alias === alias);
  const selectedModel = currentModel?.model ?? "";
  const adapter = currentModel?.adapterType ?? "";
  const openai = ["openai-images", "openai-chat-image", "generic-json"].includes(adapter);
  const gemini = adapter === "gemini-content";
  const seedream = adapter === SEEDREAM_ADAPTER;
  const mj = adapter === "midjourney";
  const previewIndex = images.findIndex((asset) => asset.id === previewId);
  const preview = images[previewIndex];
  const failure = task && terminalStatuses.includes(task.status) && task.status !== "succeeded";
  function closeViewer() {
    setPreviewId(null);
    requestAnimationFrame(() => previewTrigger.current?.focus());
  }
  return <div className="story-reference-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !preview) onClose(); }}>
    <section ref={setPanel} className="story-generator" role="dialog" tabIndex={-1} aria-modal={preview ? undefined : true}
      aria-label={`生成${label}参考图`} inert={Boolean(preview)} onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); onClose(); }
      }}>
      <header>
        <div className="story-generator-title"><span><Sparkles size={19} /></span><div><h2>生成{label}参考图</h2><p>{item.name}</p></div></div>
        <button type="button" className="storydesk-icon" aria-label="关闭生成窗口" title={generating ? "收起，后台继续生成" : "关闭"} onClick={onClose}><X size={19} /></button>
      </header>
      <div className="story-generator-body">
      <div className="story-generator-inputs">
      <div className="story-generator-model"><span>生图模型</span>
        <ModelPicker kind="image" ariaLabel="参考图生图模型" options={choices.map((entry) => ({ value: entry.alias, model: entry.model, channelName: entry.channelName }))}
          value={alias} onChange={setAlias} disabled={generating || loading || !choices.length} menuPlacement="down" portalContainer={panel}
          placeholder={loading ? "正在读取模型…" : "暂无可用模型"} />
        {currentModel ? <small>{currentModel.channelName}</small> : null}
        {!loading && !choices.length ? <small>请先在模型设置中添加生图模型。</small> : null}
      </div>
      <label>生成提示词<textarea rows={5} value={prompt} disabled={generating} maxLength={20000} onChange={(event) => setPrompt(event.target.value)} /></label>
      {openai || gemini || mj || seedream ? <h3>生成参数</h3> : null}
      <div className="story-generator-grid">
        {seedream ? <>
          <label>清晰度<select value={params.seedreamTier} disabled={generating} onChange={e => updateParam("seedreamTier", e.target.value)}>
            {SEEDREAM_SIZES.map(value => <option key={value}>{value}</option>)}<option value="custom">自定义</option>
          </select></label>
          {params.seedreamTier === "custom" ? <label>自定义宽×高
            <input value={params.seedreamCustomSize} disabled={generating} placeholder="例如 1536x1024" title={SEEDREAM_SIZE_HINT}
              onChange={e => updateParam("seedreamCustomSize", e.target.value)} />
          </label> : <label>画幅比例<select value={params.seedreamRatio} disabled={generating} onChange={e => updateParam("seedreamRatio", e.target.value)}>
            <option value="">自动</option>{SEEDREAM_RATIOS.map(value => <option key={value}>{value}</option>)}
          </select></label>}
          <label>数量<input type="number" min="1" max="8" step="1" value={params.count} disabled={generating} onChange={e => updateParam("count", e.target.value)} /></label>
        </> : null}
        {openai ? <>
          <label>图片尺寸<input list="story-generator-sizes" value={params.size} disabled={generating} placeholder="自动，或输入宽x高" onChange={(e) => updateParam("size", e.target.value)} /><datalist id="story-generator-sizes">{OPENAI_SIZE_PRESETS.map((size) => <option value={size} key={size} />)}</datalist><small>可选择预设或自定义尺寸，具体支持范围由上游决定。</small></label>
          <label>质量<select value={params.quality} disabled={generating} onChange={(e) => updateParam("quality", e.target.value)}><option value="">自动</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
          <label>数量<input type="number" min="1" max="8" step="1" value={params.count} disabled={generating} onChange={(e) => updateParam("count", e.target.value)} /></label>
          <label>输出格式<select value={params.outputFormat} disabled={generating} onChange={(e) => updateParam("outputFormat", e.target.value)}><option value="">自动</option><option value="png">PNG</option><option value="jpeg">JPEG</option><option value="webp">WebP</option></select></label>
        </> : null}
        {gemini || mj ? <label>画幅比例<input list="story-generator-ratios" value={params.aspectRatio} disabled={generating} placeholder="自动，或输入 16:9" onChange={(e) => updateParam("aspectRatio", e.target.value)} /><datalist id="story-generator-ratios">{["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"].map((value) => <option value={value} key={value} />)}</datalist></label> : null}
        {gemini ? <label>输出尺寸<select value={params.imageSize} disabled={generating} onChange={(e) => updateParam("imageSize", e.target.value)}><option value="">自动</option><option>1K</option><option>2K</option><option>4K</option></select></label> : null}
        {mj ? <label>模型版本<select value={params.midjourneyVersion} disabled={generating} onChange={(e) => updateParam("midjourneyVersion", e.target.value)}><option value="">默认</option>{["8.2", "7", "6.1", "6"].map((value) => <option key={value}>{value}</option>)}</select></label> : null}
      </div>
      <details className="story-generator-advanced"><summary>高级参数<ChevronDown size={14} /></summary><div className="story-generator-grid">
        {seedream ? <label>AI 生成水印<select value={params.seedreamWatermark} disabled={generating} onChange={e => updateParam("seedreamWatermark", e.target.value)}>
          <option value="true">开启</option><option value="false">关闭</option>
        </select></label> : null}
        {openai && !modelSupportsNegativePrompt(selectedModel) ? null : openai || mj ? <label className="wide">负面提示词<textarea rows={2} maxLength={10000} value={params.negativePrompt} disabled={generating} placeholder="不希望出现的内容" onChange={(e) => updateParam("negativePrompt", e.target.value)} /></label> : null}
        {openai ? <>
          <label>背景<select value={params.background} disabled={generating} onChange={(e) => updateParam("background", e.target.value)}><option value="">自动</option><option value="opaque">不透明</option><option value="transparent">透明</option></select></label>
          <label>风格<select value={params.style} disabled={generating} onChange={(e) => updateParam("style", e.target.value)}><option value="">自动</option><option value="vivid">Vivid</option><option value="natural">Natural</option></select></label>
          <label>内容审核<select value={params.moderation} disabled={generating} onChange={(e) => updateParam("moderation", e.target.value)}><option value="">自动</option><option value="low">低限制</option></select></label>
          <label>响应格式<select value={params.responseFormat} disabled={generating} onChange={(e) => updateParam("responseFormat", e.target.value)}><option value="">自动</option><option value="url">URL</option><option value="b64_json">Base64</option></select></label>
        </> : null}
        {gemini ? <>
          {([ ["temperature", "温度", "0", "2", "0.1"], ["topP", "Top P", "0", "1", "0.01"], ["topK", "Top K", "1", "100", "1"], ["maxOutputTokens", "最大输出 Token", "1", "32768", "1"], ["seed", "随机种子", "0", "2147483647", "1"] ] as const).map(([field, text, min, max, step]) => <label key={field}>{text}<input type="number" min={min} max={max} step={step} placeholder="自动" value={params[field]} disabled={generating} onChange={(e) => updateParam(field, e.target.value)} /></label>)}
          <label>响应模态<select value={params.responseModalities} disabled={generating} onChange={(e) => updateParam("responseModalities", e.target.value)}><option value="IMAGE">仅图片</option><option value="TEXT,IMAGE">文本与图片</option></select></label>
        </> : null}
        <label>超时时间（秒）<input type="number" min="10" max="1800" step="1" value={params.timeoutSeconds} disabled={generating} onChange={(e) => updateParam("timeoutSeconds", e.target.value)} /></label>
        {!seedream ? <label className="wide">渠道额外参数（JSON）<textarea rows={3} value={params.raw} disabled={generating} spellCheck={false} onChange={(e) => updateParam("raw", e.target.value)} /><small>仅在需要传递渠道特有字段时填写。</small></label> : null}
      </div></details>
      {error ? <p className="story-review-error" role="alert">{error}</p> : null}
      </div>
      <section className="story-generator-output" aria-label="参考图结果">
        <header><h3>生成结果</h3>{images.length ? <small>{images.length} 张</small> : null}</header>
        {tasks.length > 1 && !generating ? tasks.flatMap((item, index) => item.status === "succeeded" ? []
          : [<p key={item.id} className="story-review-error">第 {index + 1} 张：{item.errorMessage || statusLabels[item.status]}</p>]) : null}
        {generating && status ? <div className="story-generator-state" role="status">
          <GenerationActivity status={status} visual size={status === "running" ? 104 : 96} />
          <strong>{statusLabels[status]}</strong>
          <small>{pollError ? "状态查询暂时失败，正在重试" : "收起窗口后仍会继续生成"}</small>
        </div> : null}
        {!generating && images.length ? <div className="story-generator-results" data-single={images.length === 1}>
          {images.map((asset, index) => <article key={asset.id}>
            <button type="button" className="story-generator-thumb" aria-label={`放大查看图片 ${index + 1}`} onClick={(event) => {
              previewTrigger.current = event.currentTarget; setPreviewId(asset.id);
            }}>
              <img src={api.assetUrl(asset.thumbUrl || asset.url)} alt="" onError={(event) => {
                const fallback = api.assetUrl(asset.url);
                if (event.currentTarget.getAttribute("src") !== fallback) event.currentTarget.src = fallback;
              }} /><span><Maximize2 size={16} /></span>
            </button>
            <div><small>图片 {index + 1}</small><button type="button" className="storydesk-button" disabled={item.assetId === asset.id}
              onClick={() => onChoose(asset)}><Check size={14} />{item.assetId === asset.id ? "已使用" : "使用"}</button></div>
          </article>)}
        </div> : null}
        {!generating && !images.length ? <div className="story-generator-state">
          {failure ? <AlertCircle size={27} /> : <ImageIcon size={27} />}
          <strong>{failure ? statusLabels[task.status] : task ? "未返回图片" : "等待生成"}</strong>
          <small>{failure ? task.errorMessage || "可重新提交生成" : task ? "可更换参数后重试" : "生成后可放大查看并选择参考图"}</small>
        </div> : null}
      </section>
      </div>
      <footer><span>{generating ? "任务正在处理" : "选择图片后，在分镜顶栏保存关联"}</span>
        <button type="button" className="storydesk-button" onClick={onClose}>{generating ? <><Minus size={16} />收起</> : "关闭"}</button>
        <button type="button" className="storydesk-button is-primary" disabled={loading || generating || !alias || !prompt.trim()} onClick={() => void submit()}>
          <Sparkles size={15} />{generating && status ? statusLabels[status] : task ? "重新生成" : "生成参考图"}
        </button>
      </footer>
    </section>
    {preview ? <StoryboardImageViewer key={preview.id} url={api.assetUrl(preview.url)}
      title={preview.title || `图片 ${previewIndex + 1}`} position={previewIndex} count={images.length}
      onNavigate={(delta) => setPreviewId(images[previewIndex + delta]?.id ?? null)}
      onUse={item.assetId === preview.id ? undefined : () => { setPreviewId(null); onChoose(preview); }}
      onClose={closeViewer} /> : null}
  </div>;
}
