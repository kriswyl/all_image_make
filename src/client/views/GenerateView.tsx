import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle, ChevronRight, Copy, Download, Eye, Image as ImageIcon, ImagePlus,
  KeyRound, LoaderCircle, Paintbrush, Plus, RotateCcw, Server, Settings2, SlidersHorizontal,
  Sparkles, Square, Upload, Wand2, X,
} from "lucide-react";
import { api } from "../api";
import { confirmGeneration } from "../generation-confirm";
import { copyImageToClipboard } from "../clipboard";
import { ChannelPicker } from "../chat/ChannelPicker";
import { ModelPicker } from "../chat/ModelPicker";
import { MaskEditorDialog } from "../MaskEditorDialog";
import { PromptPolishButton } from "../PromptPolishButton";
import { useFileDrop } from "../useFileDrop";
import { useImagePaste } from "../useImagePaste";
import { StatusBadge, formatTime, optionalNumber, statusLabels, terminalStatuses, usePersistentState } from "../task-ui";
import { IMAGE_SIZE_VALUES, MAX_REFERENCE_IMAGES } from "../../shared/types";
import { isMidjourneyActionModel, midjourneyButtonLabel, midjourneyUsableButtons, type MidjourneyButton } from "../../shared/midjourney";
import { MidjourneyActions } from "../ui/MidjourneyActions";
import type { Asset, Channel, ImageSizeValue, Task, TaskStatus } from "../../shared/types";
import type { InpaintMaskController, ReferenceController, Toast } from "../app-shared";

const openAiSizeGroups = [
  { label: "方形", sizes: ["1024x1024", "2048x2048"] },
  { label: "横向", sizes: ["1280x720", "1536x1024", "1600x1200", "2048x1152", "3840x2160"] },
  { label: "纵向", sizes: ["720x1280", "1024x1536", "1200x1600", "1152x2048", "2160x3840"] },
] as const;

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

export function GenerateView(props: {
  channels: Channel[]; selectedChannelId: string; selectedModel: string; activeTask: Task | null; tasks: Task[]; references: ReferenceController;
  inpaint: InpaintMaskController;
  onChannelChange: (id: string) => void; onModelChange: (model: string) => void; onAddChannel: () => void; onConfigureChannel: (channel: Channel) => void;
  onTask: (task: Task) => void; onSelectTask: (task: Task) => void; onToast: (kind: Toast["kind"], message: string) => void; onDiagnostics: (task: Task) => void;
}) {
  const [prompt, setPrompt] = usePersistentState("prompt", "");
  const [negativePrompt, setNegativePrompt] = usePersistentState("negativePrompt", "");
  const [size, setSize] = usePersistentState("size", "1024x1024");
  const [customWidth, setCustomWidth] = usePersistentState("customWidth", "1024");
  const [customHeight, setCustomHeight] = usePersistentState("customHeight", "1024");
  const [aspectRatio, setAspectRatio] = usePersistentState("aspectRatio", "auto");
  const [mjVersion, setMjVersion] = usePersistentState("mjVersion", "");
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
  const [maskEditorOpen, setMaskEditorOpen] = useState(false);
  const references = props.references;
  const referenceImages = references.images;
  const readingImage = references.reading;
  const channel = props.channels.find((item) => item.id === props.selectedChannelId);
  const adapterType = channel?.adapterType;
  const isOpenAi = adapterType === "openai-images" || adapterType === "openai-chat-image" || adapterType === "generic-json";
  const isMidjourney = adapterType === "midjourney";
  const showAspectRatio = adapterType === "gemini-content" || isMidjourney;
  /**
   * 局部重绘：OpenAI Images 渠道 + 恰好一张底图。
   * 是否真的支持 mask 由当前渠道的上游决定——同名模型在不同渠道背后可能行为不同，
   * 所以这里不按模型名预先禁用它。
   */
  const maskAvailable = adapterType === "openai-images" && referenceImages.length === 1;
  useEffect(() => { if (!maskAvailable) setMaskEditorOpen(false); }, [maskAvailable]);
  // 旧版本可能把 mj_edits / 动作模型存成了上次选择；它们已不在下拉里，回落到 mj_imagine
  useEffect(() => {
    if (!isMidjourney) return;
    if (props.selectedModel === "mj_edits" || isMidjourneyActionModel(props.selectedModel)) {
      props.onModelChange("mj_imagine");
    }
  }, [isMidjourney, props.selectedModel, props.onModelChange]);
  const drop = useFileDrop(!submitting && referenceImages.length < MAX_REFERENCE_IMAGES, references.dropFiles);
  const dropActive = drop.active;
  const dropProps = drop.dropProps;
  const pasteImages = useCallback((files: File[]) => {
    if (submitting || readingImage) return;
    references.dropFiles(files);
  }, [submitting, readingImage, references]);
  useImagePaste(pasteImages, !submitting && !readingImage && !maskEditorOpen);

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
    if (!confirmGeneration({ kind: "图片生成", model: props.selectedModel, channel: channel.name, detail: `请求数量：${count} 张` })) return;
    setSubmitting(true);
    try {
      const task = await api.generate({
        channelId: channel.id, model: props.selectedModel, prompt: prompt.trim(), negativePrompt: negativePrompt.trim() || undefined,
        // 尺寸只有 OpenAI 系适配器认（`openAiImageParameters`）；gemini 和视频渠道收到它只会
        // 丢掉，然后在新加的「请求参数」里留一条扎眼的「未发出」——那是我们自己多发的，
        // 不该让用户以为是他的配置有问题
        size: isOpenAi ? requestedSize : undefined,
        aspectRatio: aspectRatio === "auto" ? undefined : aspectRatio,
        midjourneyVersion: isMidjourney ? mjVersion || undefined : undefined,
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
      }, referenceImages.map((item) => item.file), maskAvailable ? props.inpaint.mask?.file : undefined);
      props.onTask(task);
      props.onToast("success", "任务已提交");
    } catch (error) { props.onToast("error", error instanceof Error ? error.message : "提交失败"); }
    finally { setSubmitting(false); }
  }

  return (
    <div className="page generate-page">
      <div className="page-header">
        <div><h1>图片生成</h1><span className="page-kicker">{referenceImages.length ? "IMAGE TO IMAGE" : "TEXT TO IMAGE"}</span></div>
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
              options={(channel?.models ?? [])
                .filter((model) => !isMidjourney || !isMidjourneyActionModel(model))
                .map((model) => ({
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
              <div className="section-title">
                <div><Sparkles size={17} /><h2>提示词</h2></div>
                <div className="prompt-heading-tools">
                  <PromptPolishButton prompt={prompt} target="image" onPolished={setPrompt} onToast={props.onToast} disabled={submitting} />
                  <span>{prompt.length} / 20000</span>
                </div>
              </div>
              <textarea className="prompt-input" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={20000} placeholder="输入画面内容、构图、风格与光线…" />
              {isMidjourney ? (
                <p className="mode-hint">
                  提示词支持 Midjourney 原生参数（如 <code>--ar 16:9</code>、<code>--v 7</code>、<code>--no text</code>）；
                  加参考图会自动走 MJ 的图生图接口（只取第 1 张），否则走 mj_imagine。结果是一张四宫格。
                </p>
              ) : null}
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
                    <span className="reference-file"><strong>{dropActive ? "松开即可添加" : readingImage ? "读取中" : "添加参考图"}</strong><small>点击选择、拖入或 Ctrl+V 粘贴 · PNG / JPEG / WebP · 单张最大 20 MB</small></span>
                    <Upload size={17} />
                  </label>
                  {referenceImages.map((item, index) => <div className="reference-thumb" key={item.previewUrl}>
                    <img src={item.previewUrl} alt={`参考图 ${index + 1}`} />
                    <button type="button" className="reference-remove" title={`移除参考图 ${index + 1}`} onClick={() => references.remove(item.previewUrl)}><X size={13} /></button>
                    <span>{item.file.name}</span>
                  </div>)}
                </div>
                {adapterType === "openai-images" ? (
                  <div className="inpaint-row">
                    {maskAvailable && props.inpaint.mask ? (
                      <>
                        <img className="inpaint-mask-thumb" src={props.inpaint.mask.previewUrl} alt="局部重绘蒙版预览" />
                        <div className="inpaint-copy">
                          <strong>局部重绘已启用</strong>
                          <small>红色区域会重新生成；引导式编辑，蒙版外可能仍有变化</small>
                        </div>
                        <button type="button" className="secondary-button" onClick={() => setMaskEditorOpen(true)} disabled={submitting || readingImage}>
                          <Paintbrush size={15} />编辑蒙版
                        </button>
                        <button type="button" className="icon-button compact" title="移除蒙版" onClick={props.inpaint.clear} disabled={submitting}>
                          <X size={15} />
                        </button>
                      </>
                    ) : maskAvailable ? (
                      <>
                        <div className="inpaint-copy">
                          <strong>局部重绘</strong>
                          <small>在参考图上涂抹需要重新生成的区域</small>
                        </div>
                        <button type="button" className="secondary-button" onClick={() => setMaskEditorOpen(true)} disabled={submitting || readingImage}>
                          <Paintbrush size={15} />绘制蒙版
                        </button>
                      </>
                    ) : (
                      <div className="inpaint-hint">
                        <Paintbrush size={15} />
                        <span>{referenceImages.length === 0
                          ? "添加 1 张参考图后可使用局部重绘"
                          : "局部重绘只支持 1 张参考图，请先移除多余的参考图"}</span>
                      </div>
                    )}
                  </div>
                ) : null}
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
                {showAspectRatio ? (
                  <label><span>宽高比</span><select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}><option value="auto">自动</option><option>1:1</option><option>2:3</option><option>3:2</option><option>3:4</option><option>4:3</option><option>4:5</option><option>5:4</option><option>9:16</option><option>16:9</option><option>21:9</option></select></label>
                ) : null}
                {adapterType === "gemini-content" ? (
                  <label><span>输出尺寸</span><select value={imageSize} onChange={(event) => setImageSize(event.target.value)}><option value="auto">自动</option><option>1K</option><option>2K</option><option>4K</option></select></label>
                ) : null}
                {isMidjourney ? (
                  <>
                    <label>
                      <span>模型版本 <small>--v</small></span>
                      <select value={mjVersion} onChange={(event) => setMjVersion(event.target.value)}>
                        <option value="">默认</option>
                        <option value="8.2">8.2</option>
                        <option value="7">7</option>
                        <option value="6.1">6.1</option>
                        <option value="6">6</option>
                      </select>
                    </label>
                    <label className="mj-no-field">
                      <span>排除内容 <small>--no</small></span>
                      <input value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} placeholder="例如 text, watermark" />
                    </label>
                  </>
                ) : null}
              </div>

              {/* 高级参数：默认折叠 */}
              <details className="advanced-panel">
                <summary><Settings2 size={16} /><span>高级参数</span><ChevronRight className="details-chevron" size={16} /></summary>
                <div className="advanced-body">
                  {!isMidjourney ? (
                    <label className="field-block"><span>负面提示词</span><input value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} placeholder="可选" /></label>
                  ) : null}
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
      {maskEditorOpen && maskAvailable && referenceImages[0] ? (
        <MaskEditorDialog
          sourceUrl={referenceImages[0].previewUrl}
          sourceName={referenceImages[0].file.name}
          initialMask={props.inpaint.mask?.file ?? null}
          onClose={() => setMaskEditorOpen(false)}
          onApply={({ file, previewUrl }) => {
            props.inpaint.apply(file, previewUrl);
            setMaskEditorOpen(false);
          }}
        />
      ) : null}
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
  const [copying, setCopying] = useState(false);
  const [actingCustomId, setActingCustomId] = useState<string | null>(null);
  const midjourneyButtons = midjourneyUsableButtons(task?.remoteMeta?.midjourney?.buttons ?? []);
  /**
   * 预取当前结果图的字节。Ctrl+C 是用户手势，剪贴板写入要尽量在激活期内完成；
   * 等一次 fetch 再 write 有被浏览器判定「不是用户操作」的风险，所以先缓存。
   */
  const activeAssetBlob = useRef<{ id: string; blob: Blob } | null>(null);
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

  useEffect(() => {
    if (!activeAsset || !activeAsset.mimeType.startsWith("image/")) {
      activeAssetBlob.current = null;
      return;
    }
    let cancelled = false;
    const assetId = activeAsset.id;
    void fetch(api.assetUrl(activeAsset.url))
      .then((response) => response.ok ? response.blob() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((blob) => { if (!cancelled) activeAssetBlob.current = { id: assetId, blob }; })
      .catch(() => { /* 复制时再兜底取一次 */ });
    return () => { cancelled = true; };
  }, [activeAsset?.id, activeAsset?.url]);

  /**
   * 把当前结果图复制进系统剪贴板。
   * Ctrl/Cmd+C 只在没有输入框焦点、也没有选中文字时接管，避免和正常复制冲突。
   */
  const copyActiveImage = useCallback(async () => {
    if (!activeAsset || !activeAsset.mimeType.startsWith("image/") || copying) return;
    setCopying(true);
    try {
      const cached = activeAssetBlob.current?.id === activeAsset.id ? activeAssetBlob.current.blob : null;
      const blob = cached ?? await (async () => {
        const response = await fetch(api.assetUrl(activeAsset.url));
        if (!response.ok) throw new Error(`读取图片失败：HTTP ${response.status}`);
        return response.blob();
      })();
      await copyImageToClipboard(blob);
      onToast("success", "图片已复制到剪贴板");
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "复制图片失败");
    } finally {
      setCopying(false);
    }
  }, [activeAsset, copying, onToast]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "c" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (window.getSelection()?.toString()) return;
      if (!activeAsset || !activeAsset.mimeType.startsWith("image/")) return;
      event.preventDefault();
      void copyActiveImage();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeAsset, copyActiveImage]);

  async function cancel() {
    if (!task) return;
    try { onTask(await api.cancel(task.id)); } catch (error) { onToast("error", error instanceof Error ? error.message : "取消失败"); }
  }
  async function retry() {
    if (!task) return;
    if (!confirmGeneration({ kind: "图片生成", model: task.model, channel: task.channelName, retry: true })) return;
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

  async function midjourneyAct(button: MidjourneyButton) {
    if (!task || actingCustomId) return;
    if (!confirmGeneration({ kind: `Midjourney ${midjourneyButtonLabel(button)}`, model: task.model, channel: task.channelName })) return;
    setActingCustomId(button.customId);
    try {
      const next = await api.midjourneyAction(task.id, button.customId, midjourneyButtonLabel(button));
      onTask(next);
      onSelectTask(next);
      onToast("success", `已提交 ${midjourneyButtonLabel(button)}，任务在后台继续`);
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "提交 Midjourney 操作失败");
    } finally {
      setActingCustomId(null);
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
          <button type="button" className="secondary-button" disabled={copying} onClick={() => void copyActiveImage()} title="复制图片（Ctrl+C）">
            {copying ? <LoaderCircle className="spin" size={16} /> : <Copy size={16} />}复制
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
      {midjourneyButtons.length ? (
        <MidjourneyActions
          buttons={midjourneyButtons}
          busy={Boolean(actingCustomId)}
          activeId={actingCustomId}
          onAct={(button) => void midjourneyAct(button)}
          className="mj-actions"
        />
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

