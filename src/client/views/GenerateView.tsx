import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ChevronDown, ChevronRight,
  KeyRound, LoaderCircle, Plus, Server, Settings2, Send,
} from "lucide-react";
import { api } from "../api";
import { confirmGeneration } from "../generation-confirm";
import { ChannelPicker } from "../chat/ChannelPicker";
import { ModelPicker } from "../chat/ModelPicker";
import { MaskEditorDialog } from "../MaskEditorDialog";
import { PromptPolishButton } from "../PromptPolishButton";
import { useImagePaste } from "../useImagePaste";
import { optionalNumber, usePersistentState, useScopedPersistentState } from "../task-ui";
import { OPENAI_SIZE_GROUPS } from "../../shared/image-sizes";
import { modelSupportsNegativePrompt } from "../../shared/channel-fields";
import {
  DEFAULT_FRAME_COUNT, DEFAULT_FRAME_DURATION_MS, gifBudgetMessage, IMAGE_OUTPUT_FORMATS,
  MAX_FRAME_COUNT, MAX_FRAME_DURATION_MS, MIN_FRAME_COUNT, MIN_FRAME_DURATION_MS,
  type ImageOutputFormat,
} from "../../shared/image-formats";
import { isMidjourneyActionModel } from "../../shared/midjourney";
import { ImageResultWorkspace } from "./ImageResultWorkspace";
import { ImagePromptComposer, invalidImageMention, remapImageMentions } from "./ImagePromptComposer";
import "./image-workbench.css";
import { SelectMenu, type SelectOption } from "../ui/SelectMenu";
import type { Channel, Task } from "../../shared/types";
import type { InpaintMaskController, ReferenceController, Toast } from "../app-shared";

const openAiSizeGroups = OPENAI_SIZE_GROUPS;

const openAiSizeOptions: SelectOption[] = [
  { value: "auto", label: "自动" },
  ...openAiSizeGroups.flatMap((group) => group.sizes.map((item) => ({ value: item, label: item, group: group.label }))),
  { value: "custom", label: "自定义" },
];
const qualityOptions: SelectOption[] = [
  { value: "auto", label: "自动" }, { value: "low", label: "低" }, { value: "medium", label: "中" }, { value: "high", label: "高" },
];
const responseFormatOptions: SelectOption[] = [
  { value: "auto", label: "自动" }, { value: "b64_json", label: "Base64" }, { value: "url", label: "URL" },
];
const aspectRatioOptions: SelectOption[] = ["auto", "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]
  .map((value) => ({ value, label: value === "auto" ? "自动" : value }));
const imageSizeOptions: SelectOption[] = ["auto", "1K", "2K", "4K"].map((value) => ({ value, label: value === "auto" ? "自动" : value }));
const mjVersionOptions: SelectOption[] = [
  { value: "", label: "默认" }, { value: "8.2", label: "8.2" }, { value: "7", label: "7" }, { value: "6.1", label: "6.1" }, { value: "6", label: "6" },
];
const backgroundOptions: SelectOption[] = [
  { value: "auto", label: "自动" }, { value: "opaque", label: "不透明" }, { value: "transparent", label: "透明" },
];
const moderationOptions: SelectOption[] = [
  { value: "auto", label: "自动" }, { value: "low", label: "低限制" },
];
const styleOptions: SelectOption[] = [
  { value: "auto", label: "自动" }, { value: "vivid", label: "Vivid" }, { value: "natural", label: "Natural" },
];
const responseModalityOptions: SelectOption[] = [
  { value: "IMAGE", label: "仅图片" }, { value: "TEXT,IMAGE", label: "文字 + 图片" },
];
const timeoutQuickOptions: SelectOption[] = [
  { value: "60", label: "1 分钟" }, { value: "180", label: "3 分钟（默认）" }, { value: "300", label: "5 分钟" },
  { value: "600", label: "10 分钟" }, { value: "900", label: "15 分钟" }, { value: "custom", label: "自定义" },
];

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

/** 只是给界面预算提示用：与提交时算出的尺寸保持一致，不参与请求 */
function requestedSizeForDisplay(size: string, widthValue: string, heightValue: string) {
  if (size === "auto") return undefined;
  return size === "custom" ? customSize(widthValue, heightValue) : size;
}

export function GenerateView(props: {
  channels: Channel[]; selectedChannelId: string; selectedModel: string; activeTask: Task | null; tasks: Task[]; references: ReferenceController;
  inpaint: InpaintMaskController;
  onChannelChange: (id: string) => void; onModelChange: (model: string) => void; onAddChannel: () => void; onConfigureChannel: (channel: Channel) => void;
  onTask: (task: Task) => void; onSelectTask: (task: Task) => void; onToast: (kind: Toast["kind"], message: string) => void; onDiagnostics: (task: Task) => void;
}) {
  const draftAdapter = props.channels.find((item) => item.id === props.selectedChannelId)?.adapterType ?? "none";
  const draftScope = `${draftAdapter}:${props.selectedChannelId}:${props.selectedModel}`;
  const [prompt, setPrompt] = usePersistentState("prompt", "");
  const [negativePrompt, setNegativePrompt] = useScopedPersistentState(draftScope, "negativePrompt", "");
  const [size, setSize] = useScopedPersistentState(draftScope, "size", "1024x1024");
  const [customWidth, setCustomWidth] = useScopedPersistentState(draftScope, "customWidth", "1024");
  const [customHeight, setCustomHeight] = useScopedPersistentState(draftScope, "customHeight", "1024");
  const [aspectRatio, setAspectRatio] = useScopedPersistentState(draftScope, "aspectRatio", "auto");
  const [mjVersion, setMjVersion] = useScopedPersistentState(draftScope, "mjVersion", "");
  const [quality, setQuality] = useScopedPersistentState(draftScope, "quality", "auto");
  const [background, setBackground] = useScopedPersistentState<"auto" | "opaque" | "transparent">(draftScope, "background", "auto");
  const [outputFormat, setOutputFormat] = useScopedPersistentState<ImageOutputFormat>(draftScope, "outputFormat", "png");
  const [frameCount, setFrameCount] = useScopedPersistentState(draftScope, "frameCount", DEFAULT_FRAME_COUNT);
  const [frameDurationMs, setFrameDurationMs] = useScopedPersistentState(draftScope, "frameDurationMs", DEFAULT_FRAME_DURATION_MS);
  const [moderation, setModeration] = useScopedPersistentState<"auto" | "low">(draftScope, "moderation", "auto");
  const [style, setStyle] = useScopedPersistentState<"auto" | "vivid" | "natural">(draftScope, "style", "auto");
  const [responseFormat, setResponseFormat] = useScopedPersistentState<"auto" | "url" | "b64_json">(draftScope, "responseFormat", "auto");
  const [imageSize, setImageSize] = useScopedPersistentState(draftScope, "imageSize", "auto");
  const [temperature, setTemperature] = useScopedPersistentState(draftScope, "temperature", "");
  const [topP, setTopP] = useScopedPersistentState(draftScope, "topP", "");
  const [topK, setTopK] = useScopedPersistentState(draftScope, "topK", "");
  const [maxOutputTokens, setMaxOutputTokens] = useScopedPersistentState(draftScope, "maxOutputTokens", "");
  const [responseModalities, setResponseModalities] = useScopedPersistentState<"IMAGE" | "TEXT,IMAGE">(draftScope, "responseModalities", "IMAGE");
  const [seed, setSeed] = useScopedPersistentState(draftScope, "seed", "");
  const [timeoutSeconds, setTimeoutSeconds] = useScopedPersistentState(draftScope, "timeoutSeconds", 180);
  const [count, setCount] = useScopedPersistentState(draftScope, "count", 1);
  const [raw, setRaw] = useScopedPersistentState(draftScope, "raw", "{}");
  const [submitting, setSubmitting] = useState(false);
  const [maskEditorOpen, setMaskEditorOpen] = useState(false);
  const parametersRef = useRef<HTMLDetailsElement>(null);
  const parameterInteraction = useRef<Event | null>(null);
  useEffect(() => {
    function dismissParameters(event: PointerEvent) {
      const panel = parametersRef.current;
      if (!panel?.open || event === parameterInteraction.current) return;
      if (event.target instanceof Node && !panel.contains(event.target)) panel.open = false;
    }
    document.addEventListener("pointerdown", dismissParameters);
    return () => document.removeEventListener("pointerdown", dismissParameters);
  }, []);
  const references = props.references;
  const referenceImages = references.images;
  const readingImage = references.reading;
  const channel = props.channels.find((item) => item.id === props.selectedChannelId);
  const adapterType = channel?.adapterType;
  const isOpenAi = adapterType === "openai-images" || adapterType === "openai-chat-image" || adapterType === "generic-json";
  const isMidjourney = adapterType === "midjourney";
  const supportsNegativePrompt = modelSupportsNegativePrompt(props.selectedModel);
  // 不再按模型名硬禁用：自定义模型 ID 也能选，能否生成由上游决定。
  const outputFormatOptions: SelectOption[] = IMAGE_OUTPUT_FORMATS.map(format => ({
    value: format, label: format === "jpeg" ? "JPEG" : format.toUpperCase(),
  }));
  const showAspectRatio = adapterType === "gemini-content" || isMidjourney;
  /**
   * 局部重绘：OpenAI Images 渠道 + 恰好一张底图。
   * 是否真的支持 mask 由当前渠道的上游决定——同名模型在不同渠道背后可能行为不同，
   * 所以这里不按模型名预先禁用它。
   */
  const maskAvailable = adapterType === "openai-images" && referenceImages.length === 1;
  const activeMask = maskAvailable && props.inpaint.mask?.sourcePreviewUrl === referenceImages[0]?.previewUrl
    ? props.inpaint.mask : null;
  useEffect(() => { if (!maskAvailable) setMaskEditorOpen(false); }, [maskAvailable]);
  // 旧版本可能把 mj_edits / 动作模型存成了上次选择；它们已不在下拉里，回落到 mj_imagine
  useEffect(() => {
    if (!isMidjourney) return;
    if (props.selectedModel === "mj_edits" || isMidjourneyActionModel(props.selectedModel)) {
      props.onModelChange("mj_imagine");
    }
  }, [isMidjourney, props.selectedModel, props.onModelChange]);
  const previousReferences = useRef(referenceImages);
  useLayoutEffect(() => {
    const previous = previousReferences.current;
    previousReferences.current = referenceImages;
    if (previous !== referenceImages) setPrompt(value => remapImageMentions(value, previous, referenceImages));
  }, [referenceImages, setPrompt]);
  const pasteImages = useCallback((files: File[]) => {
    if (submitting || readingImage) return;
    references.dropFiles(files);
  }, [submitting, readingImage, references]);
  useImagePaste(pasteImages, !submitting && !readingImage && !maskEditorOpen);

  const quickSummary = isOpenAi
    ? [openAiSizeOptions.find(option => option.value === size)?.label ?? size, "质量 " + (qualityOptions.find(option => option.value === quality)?.label ?? quality), outputFormat.toUpperCase(), count + " 张"]
    : isMidjourney
      ? [aspectRatio === "auto" ? "自动比例" : aspectRatio, mjVersion ? "v" + mjVersion : "默认版本"]
      : adapterType === "gemini-content"
        ? [aspectRatio === "auto" ? "自动比例" : aspectRatio, imageSize === "auto" ? "自动尺寸" : imageSize, count + " 张"]
        : ["生成参数"];

  async function generate() {
    if (!channel) return props.onToast("error", "请先添加渠道");
    if (!props.selectedModel) return props.onToast("error", "请选择模型");
    if (!prompt.trim()) return props.onToast("error", "请输入提示词");
    const missing = invalidImageMention(prompt, isMidjourney ? Math.min(1, referenceImages.length) : referenceImages.length);
    if (missing) return props.onToast("error", "无法使用 " + missing + "，请移除它或重新引用可用的参考图");
    let requestedSize = size === "auto" ? undefined : size;
    if (size === "custom") {
      requestedSize = customSize(customWidth, customHeight);
      if (!requestedSize) return props.onToast("error", "自定义尺寸须为 16 的倍数，最长边不超过 3840，比例不超过 3:1，总像素为 655360 到 8294400");
    }
    if (outputFormat === "gif") {
      const budget = gifBudgetMessage(requestedSize, frameCount);
      if (budget) return props.onToast("error", budget);
    }
    let rawParameters: Record<string, unknown>;    try {
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
        channelId: channel.id, model: props.selectedModel, prompt: prompt.trim(),
        negativePrompt: supportsNegativePrompt ? negativePrompt.trim() || undefined : undefined,
        // 尺寸只有 OpenAI 系适配器认（`openAiImageParameters`）；gemini 和视频渠道收到它只会
        // 丢掉，然后在新加的「请求参数」里留一条扎眼的「未发出」——那是我们自己多发的，
        // 不该让用户以为是他的配置有问题
        size: isOpenAi ? requestedSize : undefined,
        aspectRatio: aspectRatio === "auto" ? undefined : aspectRatio,
        midjourneyVersion: isMidjourney ? mjVersion || undefined : undefined,
        count,
        quality: quality === "auto" ? undefined : quality,
        outputFormat,
        frameCount: outputFormat === "gif" ? frameCount : undefined,
        frameDurationMs: outputFormat === "gif" ? frameDurationMs : undefined,
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
      }, referenceImages.map((item) => item.file), activeMask?.file);
      props.onTask(task);
      props.onToast("success", "任务已提交");
    } catch (error) { props.onToast("error", error instanceof Error ? error.message : "提交失败"); }
    finally { setSubmitting(false); }
  }

  return (
    <div className="page generate-page image-workbench-page">
      <div className="page-header">
        <h1>图片生成</h1>
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
        <div className="image-workbench">
          <ImageResultWorkspace
            task={props.activeTask}
            tasks={props.tasks}
            references={references}
            onDiagnostics={props.onDiagnostics}
            onTask={props.onTask}
            onSelectTask={props.onSelectTask}
            onToast={props.onToast}
          />
          <section className="image-composer vstudio-composer" aria-label="图片创作">
            <ImagePromptComposer
              value={prompt}
              onChange={setPrompt}
              references={references}
              disabled={submitting}
              midjourney={isMidjourney}
              inpaint={maskAvailable ? {
                maskApplied: Boolean(activeMask),
                open: () => setMaskEditorOpen(true),
                clear: props.inpaint.clear,
              } : undefined}
            />
            <div className="image-composer-controls">
              <details ref={parametersRef} className="image-parameters"
                onPointerDownCapture={(event) => {
                  // 参数下拉通过 portal 渲染，React 事件仍会经过参数面板。
                  parameterInteraction.current = event.nativeEvent;
                }}>
                <summary className="vstudio-bar" aria-label="生成参数">
                  <Settings2 size={13} />
                  {quickSummary.map(value => <span key={value} className="image-parameter-value">{value}</span>)}
                  <ChevronDown size={12} />
                </summary>
                <div className="image-parameter-panel">
                  <div className="image-quick-params" role="group" aria-label="常用参数">
                    {isOpenAi ? <>
                      <label><span>尺寸</span>
                        <SelectMenu value={size} options={openAiSizeOptions} onChange={setSize} ariaLabel="尺寸" className="param-select" minWidth={220} />
                      </label>
                      <label><span>质量</span>
                        <SelectMenu value={quality} options={qualityOptions} onChange={setQuality} ariaLabel="质量" className="param-select" />
                      </label>
                      <label><span>格式</span>
                        <SelectMenu value={outputFormat} options={outputFormatOptions} onChange={(value) => setOutputFormat(value as typeof outputFormat)} ariaLabel="格式" className="param-select" />
                      </label>
                      <label><span>数量</span><input type="number" min={1} max={8} value={count} onChange={(event) => setCount(Math.max(1, Math.min(8, Number(event.target.value))))} /></label>
                    </> : null}
                    {showAspectRatio ? (
                      <label><span>宽高比</span>
                        <SelectMenu value={aspectRatio} options={aspectRatioOptions} onChange={setAspectRatio} ariaLabel="宽高比" className="param-select" />
                      </label>
                    ) : null}
                    {adapterType === "gemini-content" ? (<>
                      <label><span>输出尺寸</span>
                        <SelectMenu value={imageSize} options={imageSizeOptions} onChange={setImageSize} ariaLabel="输出尺寸" className="param-select" />
                      </label>
                      <label><span>候选数量</span><input type="number" min={1} max={8} value={count} onChange={(event) => setCount(Math.max(1, Math.min(8, Number(event.target.value))))} /></label>
                    </>) : null}
                    {isMidjourney ? (
                      <>
                        <label>
                          <span>模型版本 <small>--v</small></span>
                          <SelectMenu value={mjVersion} options={mjVersionOptions} onChange={setMjVersion} ariaLabel="模型版本" className="param-select" />
                        </label>
                      </>
                    ) : null}
                  </div>
                  {isOpenAi && size === "custom" ? <div className="custom-size-fields image-custom-size" aria-label="自定义尺寸">
                      <label><span>宽度</span><input type="number" min={64} max={3840} step={16} value={customWidth} onChange={(event) => setCustomWidth(event.target.value)} /></label>
                      <span aria-hidden="true">x</span>
                      <label><span>高度</span><input type="number" min={64} max={3840} step={16} value={customHeight} onChange={(event) => setCustomHeight(event.target.value)} /></label>
                    </div> : null}
                  {/* 高级参数：默认折叠 */}
                  <details className="advanced-panel image-advanced">
                    <summary><Settings2 size={16} /><span>高级参数</span><ChevronRight className="details-chevron" size={16} /></summary>
                    <div className="advanced-body">
                      {isMidjourney ? (
                        <p className="mode-hint">
                          提示词支持 Midjourney 原生参数（如 <code>--ar 16:9</code>、<code>--v 7</code>、<code>--no text</code>）；
                          参考图会切换到图生图，只使用第一张。默认生成一张四宫格。
                        </p>
                      ) : null}
                      {isMidjourney ? (
                        <label className="mj-no-field">
                          <span>排除内容 <small>--no</small></span>
                          <input value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} placeholder="例如 text, watermark" />
                        </label>
                      ) : null}
                      {isOpenAi ? (
                        <div className="parameter-grid">
                          <label><span>响应格式</span>
                            <SelectMenu value={responseFormat} options={responseFormatOptions} onChange={(value) => setResponseFormat(value as typeof responseFormat)} ariaLabel="响应格式" className="param-select" />
                          </label>
                          {outputFormat === "gif" ? <>
                            <label><span>帧数</span>
                              <input type="number" min={MIN_FRAME_COUNT} max={MAX_FRAME_COUNT} step={1} value={frameCount}
                                onChange={(event) => setFrameCount(Math.max(MIN_FRAME_COUNT, Math.min(MAX_FRAME_COUNT, Number(event.target.value) || DEFAULT_FRAME_COUNT)))} />
                            </label>
                            <label><span>每帧时长 <small>ms</small></span>
                              <input type="number" min={MIN_FRAME_DURATION_MS} max={MAX_FRAME_DURATION_MS} step={10} value={frameDurationMs}
                                onChange={(event) => setFrameDurationMs(Math.max(MIN_FRAME_DURATION_MS, Math.min(MAX_FRAME_DURATION_MS, Number(event.target.value) || DEFAULT_FRAME_DURATION_MS)))} />
                            </label>
                            <div className="wide-field" aria-label="GIF 尺寸提示">
                              <small>{gifBudgetMessage(requestedSizeForDisplay(size, customWidth, customHeight), frameCount)
                                ?? `默认 ${DEFAULT_FRAME_COUNT} 帧 × ${DEFAULT_FRAME_DURATION_MS}ms ≈ 1.8 秒循环；1024×1024 + 9 帧会超 sprite sheet 像素预算，建议 768×768 以下。`}</small>
                            </div>
                          </> : null}
                        </div>
                      ) : null}

                      {!isMidjourney && supportsNegativePrompt ? (
                        <label className="field-block"><span>负面提示词</span><input value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} placeholder="可选" /></label>
                      ) : !isMidjourney ? <div className="field-block"><span>负面提示词</span><small>当前模型不支持这个字段，已停止发送，避免请求被上游拒绝。</small></div> : null}
                      {isOpenAi ? <>
                        <div className="parameter-subtitle">OpenAI Images</div>
                        <div className="parameter-grid">
                          <label><span>背景</span>
                            <SelectMenu value={background} options={backgroundOptions} onChange={(value) => setBackground(value as typeof background)} ariaLabel="背景" className="param-select" />
                          </label>
                          <label><span>内容审核</span>
                            <SelectMenu value={moderation} options={moderationOptions} onChange={(value) => setModeration(value as typeof moderation)} ariaLabel="内容审核" className="param-select" />
                          </label>
                          <label><span>风格</span>
                            <SelectMenu value={style} options={styleOptions} onChange={(value) => setStyle(value as typeof style)} ariaLabel="风格" className="param-select" />
                          </label>
                        </div>
                      </> : null}
                      {adapterType === "gemini-content" ? <>
                        <div className="parameter-subtitle">Gemini Content</div>
                        <div className="parameter-grid">
                          <label><span>温度</span><input type="number" min={0} max={2} step={0.1} value={temperature} onChange={(event) => setTemperature(event.target.value)} placeholder="0 - 2" /></label>
                          <label><span>Top P</span><input type="number" min={0} max={1} step={0.01} value={topP} onChange={(event) => setTopP(event.target.value)} placeholder="0 - 1" /></label>
                          <label><span>Top K</span><input type="number" min={1} max={100} step={1} value={topK} onChange={(event) => setTopK(event.target.value)} placeholder="1 - 100" /></label>
                          <label><span>最大输出 Token</span><input type="number" min={1} max={32768} step={1} value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(event.target.value)} placeholder="可选" /></label>
                          <label><span>Seed</span><input type="number" min={0} value={seed} onChange={(event) => setSeed(event.target.value)} placeholder="可选" /></label>
                          <label><span>响应模态</span>
                            <SelectMenu value={responseModalities} options={responseModalityOptions} onChange={(value) => setResponseModalities(value as typeof responseModalities)} ariaLabel="响应模态" className="param-select" />
                          </label>
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
                          <SelectMenu
                            value={[60, 180, 300, 600, 900].includes(timeoutSeconds) ? String(timeoutSeconds) : "custom"}
                            options={timeoutQuickOptions}
                            onChange={(value) => { if (value !== "custom") setTimeoutSeconds(Number(value)); }}
                            ariaLabel="快速选择等待时长"
                            className="param-select"
                          />
                        </label>
                      </div>
                      <div className="parameter-subtitle">高级 JSON</div>
                      <textarea className="json-input" spellCheck={false} value={raw} onChange={(event) => setRaw(event.target.value)} />
                    </div>
                  </details>
                </div>
              </details>
              <PromptPolishButton prompt={prompt} target="image" onPolished={setPrompt} onToast={props.onToast} disabled={submitting} />
              {channel && !channel.hasKey ? <button type="button" className="key-warning" onClick={() => props.onConfigureChannel(channel)}><KeyRound size={15} />填写密钥</button> : null}
              <button type="button" className="vstudio-send image-submit" aria-label="生成图片" title="生成图片"
                onClick={generate} disabled={submitting || readingImage || !channel || !props.selectedModel || !prompt.trim()}>
                {submitting ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}
              </button>
            </div>
          </section>
        </div>
      )}
      {maskEditorOpen && maskAvailable && referenceImages[0] ? (
        <MaskEditorDialog
          sourceUrl={referenceImages[0].previewUrl}
          sourceName={referenceImages[0].file.name}
          initialMask={activeMask?.file ?? null}
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
