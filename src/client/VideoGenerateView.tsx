import { useEffect, useState } from "react";
import {
  AlertCircle, CheckCircle2, ChevronRight, Clapperboard, Download, Eye, Film, ImagePlus, KeyRound,
  Link as LinkIcon, LoaderCircle, Plus, RotateCcw, Settings2, SlidersHorizontal, Square, Upload, X,
} from "lucide-react";
import { api } from "./api";
import { ChannelPicker } from "./chat/ChannelPicker";
import { ModelPicker } from "./chat/ModelPicker";
import { LazyVideoThumb } from "./LazyVideoThumb";
import { useFileDrop } from "./useFileDrop";
import type {
  Asset, Channel, SeedanceMediaInput, SeedanceMediaRole, SeedanceVideoMode,
  Task, TaskStatus, VideoMediaInput, VideoMediaType, WanVideoMode,
} from "../shared/types";
import { VIDEO_CAPABILITIES, type VideoAdapter } from "../shared/video-capabilities";
import type { ReferenceController } from "./App";

type Toast = { kind: "success" | "error"; message: string };

const terminalStatuses: TaskStatus[] = ["succeeded", "failed", "cancelled", "expired"];
const statusLabels: Record<TaskStatus, string> = {
  queued: "排队中", validating: "校验中", submitting: "提交中", running: "生成中", succeeded: "已完成",
  failed: "失败", cancelled: "已取消", expired: "已超时",
};



/**
 * 万相 7 种模式的输入槽定义，对应官方文档的「请求示例」分类。
 * imageSlots 用上传的图片按顺序填充，urlSlots 需要公网 URL 或 OSS 临时 URL。
 */
interface WanModeSpec {
  label: string;
  hint: string;
  /** 按顺序分配给上传图片的 media type，长度即图片上限 */
  imageSlots: VideoMediaType[];
  /** 图片槽是否可重复（参考图模式下 reference_image 可传多张） */
  imageRepeatable: boolean;
  /** 需要 URL 输入的素材槽 */
  urlSlots: Array<{ type: VideoMediaType; label: string; placeholder: string; required: boolean }>;
  /** 该模式下 duration 是否可调 */
  durationEditable: boolean;
}

const WAN_MODES: Record<WanVideoMode, WanModeSpec> = {
  "text-to-video": {
    label: "文生视频",
    hint: "仅凭提示词生成，不需要任何素材",
    imageSlots: [],
    imageRepeatable: false,
    urlSlots: [],
    durationEditable: true,
  },
  "first-frame": {
    label: "首帧生视频",
    hint: "上传 1 张图作为视频第一帧",
    imageSlots: ["first_frame"],
    imageRepeatable: false,
    urlSlots: [],
    durationEditable: true,
  },
  "first-last-frame": {
    label: "首尾帧生视频",
    hint: "第 1 张为首帧，第 2 张为尾帧",
    imageSlots: ["first_frame", "last_frame"],
    imageRepeatable: false,
    urlSlots: [],
    durationEditable: true,
  },
  reference: {
    label: "参考生视频",
    hint: "最多 10 张参考图，可搭配参考视频/音频；提示词里用「图1」「视频1」指代",
    imageSlots: ["reference_image"],
    imageRepeatable: true,
    urlSlots: [
      { type: "reference_video", label: "参考视频", placeholder: "https://… .mp4 或 oss://…", required: false },
      { type: "reference_audio", label: "参考音频", placeholder: "https://… .mp3 或 oss://…", required: false },
    ],
    durationEditable: true,
  },
  "video-edit": {
    label: "视频编辑",
    hint: "对一段视频做风格或内容改写，不支持设置时长",
    imageSlots: [],
    imageRepeatable: false,
    urlSlots: [
      { type: "reference_video", label: "待编辑视频", placeholder: "https://… .mp4 或 oss://…", required: true },
    ],
    durationEditable: false,
  },
  "video-extend": {
    label: "视频延长",
    hint: "在原视频之后续接新内容，输入与输出总时长不超过 30 秒",
    imageSlots: [],
    imageRepeatable: false,
    urlSlots: [
      { type: "reference_video", label: "待延长视频", placeholder: "https://… .mp4 或 oss://…", required: true },
    ],
    durationEditable: true,
  },
  "file-to-video": {
    label: "参考文件生视频",
    hint: "依据文档或网页内容生成，提示词改写会强制开启",
    imageSlots: [],
    imageRepeatable: false,
    urlSlots: [
      { type: "file", label: "文档地址", placeholder: "https://… .pptx / .pdf / .docx", required: false },
      { type: "link", label: "网页链接", placeholder: "https://…（与文档二选一）", required: false },
    ],
    durationEditable: true,
  },
};

const WAN_MODE_ORDER: WanVideoMode[] = [
  "text-to-video", "first-frame", "first-last-frame", "reference",
  "video-edit", "video-extend", "file-to-video",
];

/** Seedance 没有文档/网页素材，所以 urlSlots 恒为空，其余字段与万相同构 */
const SEEDANCE_MODE_SPECS: Record<SeedanceVideoMode, WanModeSpec> = {
  "text-to-video": {
    label: "文生视频",
    hint: "仅凭提示词生成，不需要任何素材",
    imageSlots: [],
    imageRepeatable: false,
    urlSlots: [],
    durationEditable: true,
  },
  "first-frame": {
    label: "首帧生视频",
    hint: "上传 1 张图作为视频第一帧",
    imageSlots: ["first_frame"],
    imageRepeatable: false,
    urlSlots: [],
    durationEditable: true,
  },
  "first-last-frame": {
    label: "首尾帧生视频",
    hint: "第 1 张为首帧，第 2 张为尾帧；该模式下宽高比固定为自适应",
    imageSlots: ["first_frame", "last_frame"],
    imageRepeatable: false,
    urlSlots: [],
    durationEditable: true,
  },
  reference: {
    label: "参考生视频",
    hint: "最多 10 张参考图，提示词里可用「图1」「图2」指代",
    imageSlots: ["reference_image"],
    imageRepeatable: true,
    urlSlots: [],
    durationEditable: true,
  },
};

const SEEDANCE_MODE_ORDER: SeedanceVideoMode[] = [
  "text-to-video", "first-frame", "first-last-frame", "reference",
];

function usePersistentState<T>(key: string, initialValue: T) {
  const storageKey = `vector-image:video-draft:${key}`;
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
    catch { /* 存储不可用时表单依然可用 */ }
  }, [storageKey, value]);
  return [value, setValue] as const;
}

export function VideoGenerateView(props: {
  channels: Channel[];
  selectedChannelId: string;
  selectedModel: string;
  activeTask: Task | null;
  tasks: Task[];
  references: ReferenceController;
  onChannelChange: (id: string) => void;
  onModelChange: (model: string) => void;
  onAddChannel: () => void;
  onConfigureChannel: (channel: Channel) => void;
  onTask: (task: Task) => void;
  onSelectTask: (task: Task) => void;
  onToast: (kind: Toast["kind"], message: string) => void;
  onDiagnostics: (task: Task) => void;
}) {
  const [prompt, setPrompt] = usePersistentState("prompt", "");
  const [negativePrompt, setNegativePrompt] = usePersistentState("negativePrompt", "");
  const [duration, setDuration] = usePersistentState("duration", 8);
  const [resolution, setResolution] = usePersistentState("resolution", "");
  const [aspectRatio, setAspectRatio] = usePersistentState("aspectRatio", "16:9");
  const [ratio, setRatio] = usePersistentState("ratio", "adaptive");
  const [audio, setAudio] = usePersistentState("audio", true);
  const [promptExtend, setPromptExtend] = usePersistentState("promptExtend", true);
  const [watermark, setWatermark] = usePersistentState("watermark", false);
  const [seed, setSeed] = usePersistentState("seed", "");
  const [timeoutSeconds, setTimeoutSeconds] = usePersistentState("timeoutSeconds", 600);
  const [raw, setRaw] = usePersistentState("raw", "{}");
  const [wanMode, setWanMode] = usePersistentState<WanVideoMode>("wanMode", "text-to-video");
  const [seedanceMode, setSeedanceMode] = usePersistentState<SeedanceVideoMode>("seedanceMode", "text-to-video");
  const [urlInputs, setUrlInputs] = usePersistentState<Record<VideoMediaType, string>>("urlInputs", {} as Record<VideoMediaType, string>);
  const [submitting, setSubmitting] = useState(false);

  const references = props.references;
  const referenceImages = references.images;
  const readingImage = references.reading;
  const channel = props.channels.find((item) => item.id === props.selectedChannelId);
  const adapterType = channel?.adapterType as VideoAdapter | undefined;
  const caps = adapterType ? VIDEO_CAPABILITIES[adapterType] : null;
  const isWan = adapterType === "wan-video";
  const isSeedance = adapterType === "seedance-video";
  const modeSpec = isWan ? WAN_MODES[wanMode] : isSeedance ? SEEDANCE_MODE_SPECS[seedanceMode] : null;
  // 万相/Seedance 按当前模式的槽位算上限，Grok 没有模式概念，直接用适配器上限
  const maxReferenceImages = (isWan || isSeedance)
    ? (modeSpec?.imageRepeatable ? caps?.maxReferenceImages ?? 0 : modeSpec?.imageSlots.length ?? 0)
    : caps?.maxReferenceImages ?? 0;
  const drop = useFileDrop(maxReferenceImages > 0 && !submitting && referenceImages.length < maxReferenceImages, references.dropFiles);

  // 切换渠道时把参数收敛到该适配器支持的取值
  useEffect(() => {
    if (!caps) return;
    if (!caps.resolutions.includes(resolution)) setResolution(caps.resolutions[1] ?? caps.resolutions[0]);
    if (caps.durations.fixed != null) setDuration(caps.durations.fixed);
    else setDuration((current) => clamp(current, caps.durations.min, caps.durations.max));
    if (caps.ratioField === "ratio" && !caps.aspectRatios.includes(ratio)) setRatio(caps.aspectRatios[0]);
    if (caps.ratioField === "aspectRatio" && !caps.aspectRatios.includes(aspectRatio)) setAspectRatio(caps.aspectRatios[0]);
  }, [adapterType]);

  // 切换模式时清空已上传图片（槽位数量/语义变了，避免混乱）
  useEffect(() => {
    if (isWan && referenceImages.length) references.clear();
  }, [wanMode]);

  useEffect(() => {
    if (isSeedance && referenceImages.length) references.clear();
  }, [seedanceMode]);

  // Seedance 首帧/首尾帧只接受自适应比例，界面直接锁定，避免提交后被接口拒绝
  const ratioLocked = isSeedance && (seedanceMode === "first-frame" || seedanceMode === "first-last-frame");
  useEffect(() => {
    if (ratioLocked && ratio !== "adaptive") setRatio("adaptive");
  }, [ratioLocked, ratio]);

  /** 把上传的图片和 URL 输入按模式拼成万相要求的 media 数组 */
  async function buildWanMedia(): Promise<VideoMediaInput[] | string> {
    if (!modeSpec) return [];
    const media: VideoMediaInput[] = [];

    // 图片按槽位顺序分配 type：首尾帧模式下第 1 张是 first_frame，第 2 张是 last_frame
    for (const [index, item] of referenceImages.entries()) {
      const type = modeSpec.imageRepeatable
        ? modeSpec.imageSlots[0]
        : modeSpec.imageSlots[index];
      if (!type) return `${modeSpec.label}最多接受 ${modeSpec.imageSlots.length} 张图片`;
      media.push({ type, url: await fileToVideoDataUrl(item.file) });
    }

    for (const slot of modeSpec.urlSlots) {
      const url = (urlInputs[slot.type] ?? "").trim();
      if (!url) {
        if (slot.required) return `请填写${slot.label}`;
        continue;
      }
      if (!/^(https?:\/\/|oss:\/\/)/i.test(url)) return `${slot.label}需要 http(s):// 或 oss:// 地址`;
      media.push({ type: slot.type, url });
    }

    // 文档：file 与 link 互斥
    if (media.some((item) => item.type === "file") && media.some((item) => item.type === "link")) {
      return "文档地址与网页链接只能填写一个";
    }
    if (wanMode === "file-to-video" && !media.some((item) => item.type === "file" || item.type === "link")) {
      return "请填写文档地址或网页链接";
    }
    if (modeSpec.imageSlots.length && !modeSpec.imageRepeatable && referenceImages.length < modeSpec.imageSlots.length) {
      return `${modeSpec.label}需要 ${modeSpec.imageSlots.length} 张图片`;
    }
    return media;
  }

  /** Seedance 的 content 数组：图片按模式带上 role，首尾帧必须按序 */
  async function buildSeedanceMedia(): Promise<SeedanceMediaInput[] | string> {
    const spec = SEEDANCE_MODE_SPECS[seedanceMode];
    const slots = spec.imageSlots;
    if (!slots.length) return [];
    if (!spec.imageRepeatable && referenceImages.length < slots.length) {
      return `${spec.label}需要 ${slots.length} 张图片`;
    }
    if (!spec.imageRepeatable && referenceImages.length > slots.length) {
      return `${spec.label}最多 ${slots.length} 张图片`;
    }

    const media: SeedanceMediaInput[] = [];
    for (const [index, item] of referenceImages.entries()) {
      const roleType = spec.imageRepeatable ? slots[0] : slots[index];
      if (!roleType) return `${spec.label}最多 ${slots.length} 张图片`;
      media.push({ type: "image_url", url: await fileToVideoDataUrl(item.file), role: roleType as SeedanceMediaRole });
    }
    return media;
  }

  async function generate() {
    if (!channel || !caps) return props.onToast("error", "请先选择视频渠道");
    if (!props.selectedModel) return props.onToast("error", "请选择模型");
    if (!prompt.trim()) return props.onToast("error", "请输入提示词");
    if (!isWan && !isSeedance && referenceImages.length > caps.maxReferenceImages) {
      return props.onToast("error", `${caps.label} 参考图最多 ${caps.maxReferenceImages} 张`);
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
      // 万相走 media 数组（素材带 type），Grok 仍走 multipart 上传
      let wanVideoMedia: VideoMediaInput[] | undefined;
      let seedanceVideoMedia: SeedanceMediaInput[] | undefined;
      if (isWan) {
        const built = await buildWanMedia();
        if (typeof built === "string") { props.onToast("error", built); return; }
        wanVideoMedia = built.length ? built : undefined;
      } else if (isSeedance) {
        const built = await buildSeedanceMedia();
        if (typeof built === "string") { props.onToast("error", built); return; }
        seedanceVideoMedia = built.length ? built : undefined;
      }

      const task = await api.generate({
        channelId: channel.id,
        model: props.selectedModel,
        prompt: prompt.trim(),
        negativePrompt: negativePrompt.trim() || undefined,
        duration: modeSpec && !modeSpec.durationEditable ? undefined : caps.durations.fixed ?? duration,
        resolution,
        // Grok 用 aspect_ratio，万相用 ratio，两者不混用
        aspectRatio: caps.ratioField === "aspectRatio" ? aspectRatio : undefined,
        ratio: caps.ratioField === "ratio" ? ratio : undefined,
        audio: caps.supportsAudio ? audio : undefined,
        promptExtend: caps.supportsPromptExtend ? promptExtend : undefined,
        watermark: caps.supportsWatermark ? watermark : undefined,
        seed: caps.supportsSeed ? optionalNumber(seed) : undefined,
        wanVideoMode: isWan ? wanMode : undefined,
        wanVideoMedia,
        seedanceVideoMode: isSeedance ? seedanceMode : undefined,
        seedanceVideoMedia,
        timeoutMs: timeoutSeconds * 1000,
        rawParameters,
      }, (isWan || isSeedance) ? [] : referenceImages.map((item) => item.file));
      props.onTask(task);
      props.onToast("success", "视频任务已提交");
    } catch (error) {
      props.onToast("error", error instanceof Error ? error.message : "提交失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page generate-page">
      <div className="page-header">
        <div>
          <h1>生视频</h1>
          <span className="page-kicker">{modeSpec ? modeSpec.label : "VIDEO GENERATION"}</span>
        </div>
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
              kind="video"
              menuPlacement="down"
              placeholder="选择模型"
              ariaLabel="生视频模型"
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
        <div className="empty-page">
          <Film size={34} />
          <h2>尚无视频渠道</h2>
          <p>在渠道配置中添加 xAI 或阿里云百炼的视频渠道</p>
          <button className="primary-button" onClick={props.onAddChannel}><Plus size={17} />添加渠道</button>
        </div>
      ) : (
        <div className="generation-grid">
          <section className="control-panel">
            <div className="control-scroll">
              {isWan || isSeedance ? (
                <>
                  <div className="section-title"><div><Clapperboard size={17} /><h2>生成方式</h2></div></div>
                  <div className="mode-picker" role="radiogroup" aria-label={`${caps?.label ?? ""}生成方式`}>
                    {isWan
                      ? WAN_MODE_ORDER.map((item) => (
                          <button
                            key={item}
                            type="button"
                            role="radio"
                            aria-checked={wanMode === item}
                            className={`mode-chip ${wanMode === item ? "active" : ""}`}
                            onClick={() => setWanMode(item)}
                          >
                            {WAN_MODES[item].label}
                          </button>
                        ))
                      : SEEDANCE_MODE_ORDER.map((item) => (
                          <button
                            key={item}
                            type="button"
                            role="radio"
                            aria-checked={seedanceMode === item}
                            className={`mode-chip ${seedanceMode === item ? "active" : ""}`}
                            onClick={() => setSeedanceMode(item)}
                          >
                            {SEEDANCE_MODE_SPECS[item].label}
                          </button>
                        ))}
                  </div>
                  {modeSpec ? <p className="mode-hint">{modeSpec.hint}</p> : null}
                </>
              ) : null}

              <div className="section-title">
                <div><Film size={17} /><h2>提示词</h2></div>
                <span>{prompt.length} / 20000</span>
              </div>
              <textarea className="prompt-input" value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={20000} placeholder="描述画面主体、动作、镜头运动与风格…" />

              {maxReferenceImages ? (
                <div className="reference-block">
                  <div className="reference-heading">
                    <div><ImagePlus size={16} /><span>{imageSlotLabel(modeSpec)}</span></div>
                    <span className="reference-count">{referenceImages.length}/{maxReferenceImages}</span>
                    {referenceImages.length ? <button type="button" className="icon-button compact" title="移除全部图片" onClick={references.clear}><X size={15} /></button> : null}
                  </div>
                  <div className={`reference-picker ${referenceImages.length ? "has-image" : ""} ${drop.active ? "is-drop-target" : ""}`} {...drop.dropProps}>
                    <label className="reference-add-tile" title="添加图片">
                      <input className="file-input" type="file" accept="image/png,image/jpeg,image/webp" multiple={maxReferenceImages > 1} onChange={references.select} disabled={readingImage || submitting || referenceImages.length >= maxReferenceImages} />
                      <span className="reference-icon">{readingImage ? <LoaderCircle className="spin" size={21} /> : <ImagePlus size={21} />}</span>
                      <span className="reference-file"><strong>{drop.active ? "松开即可添加" : readingImage ? "读取中" : "添加图片"}</strong><small>点击选择，或把图片拖到这里 · PNG / JPEG / WebP · 单张最大 10 MB</small></span>
                      <Upload size={17} />
                    </label>
                    {referenceImages.map((item, index) => {
                      const role = slotRoleLabel(modeSpec, index);
                      return (
                        <div className="reference-thumb" key={item.previewUrl}>
                          <img src={item.previewUrl} alt={role ?? `图片 ${index + 1}`} />
                          <button type="button" className="reference-remove" title={`移除${role ?? `图片 ${index + 1}`}`} onClick={() => references.remove(item.previewUrl)}><X size={13} /></button>
                          {role ? <em className="reference-role">{role}</em> : null}
                          <span>{item.file.name}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {modeSpec?.urlSlots.length ? (
                <div className="media-url-block">
                  <div className="section-title compact"><div><LinkIcon size={16} /><h2>素材地址</h2></div></div>
                  {modeSpec.urlSlots.map((slot) => (
                    <label className="field-block" key={slot.type}>
                      <span>{slot.label}{slot.required ? <em className="required-mark">必填</em> : null}</span>
                      <input
                        value={urlInputs[slot.type] ?? ""}
                        onChange={(event) => setUrlInputs({ ...urlInputs, [slot.type]: event.target.value })}
                        placeholder={slot.placeholder}
                        spellCheck={false}
                      />
                    </label>
                  ))}
                  <p className="mode-hint">视频、音频与文档只接受公网地址或百炼的 oss:// 临时地址，不支持本地上传</p>
                </div>
              ) : null}

              <div className="section-title parameters-title"><div><SlidersHorizontal size={17} /><h2>基础参数</h2></div>{caps ? <span>{caps.label}</span> : null}</div>
              <div className="parameter-grid">
                {caps ? <>
                  <label>
                    <span>时长 <small>秒</small></span>
                    {caps.durations.fixed != null || (modeSpec && !modeSpec.durationEditable)
                      ? <input type="text" value={`${caps.durations.fixed ?? 5} 秒（固定）`} disabled />
                      : <div className="duration-input-wrapper">
                          <input type="number" min={caps.durations.min} max={caps.durations.max} value={duration}
                            onChange={(event) => setDuration(clamp(Number(event.target.value) || caps.durations.default, caps.durations.min, caps.durations.max))} />
                          {caps.supportsSmartDuration ? (
                            <button type="button" className="smart-duration-btn" title="智能时长（-1）" onClick={() => setDuration(-1)}>
                              自动
                            </button>
                          ) : null}
                        </div>}
                  </label>
                  <label>
                    <span>分辨率</span>
                    <select value={resolution} onChange={(event) => setResolution(event.target.value)}>
                      {caps.resolutions.map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                  </label>
                  {caps.ratioField === "aspectRatio" && caps.aspectRatios.length ? (
                    <label>
                      <span>宽高比</span>
                      <select value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)}>
                        {caps.aspectRatios.map((item) => <option key={item} value={item}>{item}</option>)}
                      </select>
                    </label>
                  ) : null}
                  {caps.ratioField === "ratio" && caps.aspectRatios.length ? (
                    <label>
                      <span>宽高比</span>
                      <select value={ratio} disabled={ratioLocked} onChange={(event) => setRatio(event.target.value)}>
                        {caps.aspectRatios.map((item) => <option key={item} value={item}>{item === "adaptive" ? "自适应" : item}</option>)}
                      </select>
                    </label>
                  ) : null}
                  {caps.supportsAudio ? (
                    <label className="checkbox-label">
                      <input type="checkbox" checked={audio} onChange={(event) => setAudio(event.target.checked)} />
                      <span>包含音频</span>
                    </label>
                  ) : null}
                </> : null}
              </div>

              <details className="advanced-panel">
                <summary><Settings2 size={16} /><span>高级参数</span><ChevronRight className="details-chevron" size={16} /></summary>
                <div className="advanced-body">
                  <label className="field-block"><span>负面提示词</span><input value={negativePrompt} onChange={(event) => setNegativePrompt(event.target.value)} placeholder="可选，描述不希望出现的内容" /></label>
                  {caps && (caps.supportsPromptExtend || caps.supportsSeed || caps.supportsWatermark) ? <>
                    <div className="parameter-subtitle">{caps.label}</div>
                    <div className="parameter-grid">
                      {caps.supportsPromptExtend ? (
                        <label className="switch-field">
                          <span>提示词智能改写</span>
                          <input type="checkbox" checked={promptExtend} onChange={(event) => setPromptExtend(event.target.checked)} />
                        </label>
                      ) : null}
                      {caps.supportsWatermark ? (
                        <label className="switch-field">
                          <span>AI 生成水印</span>
                          <input type="checkbox" checked={watermark} onChange={(event) => setWatermark(event.target.checked)} />
                        </label>
                      ) : null}
                      {caps.supportsSeed ? (
                        <label><span>Seed</span><input type="number" min={0} value={seed} onChange={(event) => setSeed(event.target.value)} placeholder="可选，用于复现" /></label>
                      ) : null}
                    </div>
                  </> : null}
                  <div className="parameter-subtitle">生成超时</div>
                  <div className="parameter-grid">
                    <label>
                      <span>等待时长 <small>秒</small></span>
                      <input type="number" min={60} max={1800} step={30} value={timeoutSeconds}
                        onChange={(event) => setTimeoutSeconds(clamp(Number(event.target.value) || 600, 60, 1800))} />
                    </label>
                    <label>
                      <span>快速选择</span>
                      <select value={[300, 600, 900, 1200].includes(timeoutSeconds) ? String(timeoutSeconds) : "custom"}
                        onChange={(event) => { if (event.target.value !== "custom") setTimeoutSeconds(Number(event.target.value)); }}>
                        <option value="300">5 分钟</option>
                        <option value="600">10 分钟（默认）</option>
                        <option value="900">15 分钟</option>
                        <option value="1200">20 分钟</option>
                        <option value="custom">自定义</option>
                      </select>
                    </label>
                  </div>
                  <div className="parameter-subtitle">高级 JSON</div>
                  <textarea className="json-input" spellCheck={false} value={raw} onChange={(event) => setRaw(event.target.value)} />
                </div>
              </details>
            </div>

            <div className="submit-row">
              {channel && !channel.hasKey ? <button type="button" className="key-warning" onClick={() => props.onConfigureChannel(channel)}><KeyRound size={15} />填写密钥</button> : <span />}
              <button className="primary-button generate-button" onClick={generate} disabled={submitting || readingImage || !channel || !props.selectedModel}>
                {submitting ? <LoaderCircle className="spin" size={18} /> : <Film size={18} />}
                {modeSpec ? modeSpec.label : referenceImages.length ? "图生视频" : "文生视频"}
              </button>
            </div>
          </section>

          <VideoResultPanel
            task={props.activeTask}
            tasks={props.tasks}
            onDiagnostics={props.onDiagnostics}
            onTask={props.onTask}
            onSelectTask={props.onSelectTask}
            onToast={props.onToast}
          />
        </div>
      )}
    </div>
  );
}

function VideoResultPanel({ task, tasks, onDiagnostics, onTask, onSelectTask, onToast }: {
  task: Task | null;
  tasks: Task[];
  onDiagnostics: (task: Task) => void;
  onTask: (task: Task) => void;
  onSelectTask: (task: Task) => void;
  onToast: (kind: Toast["kind"], message: string) => void;
}) {
  const busy = task && !terminalStatuses.includes(task.status);
  const [downloadingAssetId, setDownloadingAssetId] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [theater, setTheater] = useState(false);
  const recentTasks = tasks.filter((item) => item.status === "succeeded" && item.assets.length).slice(0, 12);
  const activeAsset = task?.assets.find((item) => item.id === selectedAssetId) ?? task?.assets[0] ?? null;
  // 竖屏视频两侧会空出大片版面，用画面自身的模糊放大图垫底
  const [portraitAssetId, setPortraitAssetId] = useState<string | null>(null);

  useEffect(() => { setSelectedAssetId(task?.assets[0]?.id ?? null); }, [task?.id, task?.assets.length]);
  useEffect(() => {
    if (!theater) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setTheater(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [theater]);

  async function cancel() {
    if (!task) return;
    try { onTask(await api.cancel(task.id)); }
    catch (error) { onToast("error", error instanceof Error ? error.message : "取消失败"); }
  }

  async function retry() {
    if (!task) return;
    try { onTask(await api.retry(task.id)); onToast("success", "已重新提交"); }
    catch (error) { onToast("error", error instanceof Error ? error.message : "重试失败"); }
  }

  async function download(asset: Asset) {
    setDownloadingAssetId(asset.id);
    try {
      if (await api.downloadAsset(asset)) onToast("success", "视频已保存");
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "下载失败");
    } finally {
      setDownloadingAssetId(null);
    }
  }

  return (
    <section className="result-panel">
      <div className="result-toolbar">
        <div><Film size={17} /><h2>结果</h2>{task ? <StatusBadge status={task.status} /> : null}</div>
        <div className="icon-actions">
          {task ? <button className="icon-button" title="查看诊断" onClick={() => onDiagnostics(task)}><Eye size={17} /></button> : null}
          {busy ? <button className="icon-button danger" title="取消任务" onClick={cancel}><Square size={16} /></button> : null}
        </div>
      </div>

      <div className={`result-stage ${activeAsset ? "has-image" : ""}`}>
        {!task ? <EmptyVideoResult /> : null}
        {busy ? (
          <div className="task-progress">
            <LoaderCircle className="spin" size={30} />
            <strong>{statusLabels[task.status]}</strong>
            {task.progress != null ? <div className="progress-track"><span style={{ width: `${task.progress}%` }} /></div> : null}
            <span>{task.model}</span>
            <small>视频生成通常需要 1 到 10 分钟</small>
          </div>
        ) : null}
        {task && task.status === "failed" ? (
          <div className="task-error"><AlertCircle size={30} /><strong>{task.errorCode}</strong><span>{task.errorMessage}</span></div>
        ) : null}
        {task && !busy && task.status !== "failed" && !task.assets.length ? <EmptyVideoResult /> : null}
        {activeAsset ? (
          <figure className={`stage-video ${portraitAssetId === activeAsset.id ? "portrait" : ""}`}>
            {/* 竖屏视频左右会空出大片版面，用同一段画面的模糊放大版垫底 */}
            {portraitAssetId === activeAsset.id ? (
              <video
                className="stage-video-backdrop"
                src={api.assetUrl(activeAsset.url)}
                muted
                playsInline
                preload="auto"
                aria-hidden="true"
                tabIndex={-1}
                disablePictureInPicture
                disableRemotePlayback
              />
            ) : null}
            {/* disablePictureInPicture / disableRemotePlayback 去掉悬停时浮出的「画中画」「投屏」按钮 */}
            <video
              key={activeAsset.id}
              className="stage-video-main"
              src={api.assetUrl(activeAsset.url)}
              controls
              loop
              playsInline
              preload="metadata"
              title="双击放大"
              onDoubleClick={() => setTheater(true)}
              onLoadedMetadata={(event) => {
                const video = event.currentTarget;
                const isPortrait = video.videoWidth > 0 && video.videoWidth < video.videoHeight;
                setPortraitAssetId(isPortrait ? activeAsset.id : null);
              }}
              disablePictureInPicture
              disableRemotePlayback
            />
          </figure>
        ) : null}
      </div>

      {activeAsset ? (
        <div className="result-actions">
          <button type="button" className="secondary-button" disabled={downloadingAssetId === activeAsset.id} onClick={() => void download(activeAsset)}>
            {downloadingAssetId === activeAsset.id ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}下载
          </button>
          <button type="button" className="secondary-button" onClick={retry}><RotateCcw size={16} />重生成</button>
          <span className="asset-meta">
            {activeAsset.duration != null ? <span>{formatDuration(activeAsset.duration)}</span> : null}
            <span>{formatBytes(activeAsset.byteSize)}</span>
          </span>
          {task && task.assets.length > 1 ? (
            <div className="stage-thumbs" role="tablist" aria-label="本次生成结果">
              {task.assets.map((asset, index) => (
                <button key={asset.id} type="button" className={`stage-thumb ${asset.id === activeAsset.id ? "active" : ""}`} title={`结果 ${index + 1}`} onClick={() => setSelectedAssetId(asset.id)}>
                  <video src={api.assetUrl(asset.url)} muted playsInline preload="metadata" />
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
                <LazyVideoThumb src={api.assetUrl(item.assets[0].url)} alt={item.prompt} />
                {item.assets.length > 1 ? <span className="recent-thumb-count">{item.assets.length}</span> : null}
              </button>
            ))}
          </div>
        </div>
      ) : task ? (
        <div className="result-meta"><span>{task.channelName}</span><span>{task.model}</span><span>{formatTime(task.createdAt)}</span></div>
      ) : null}

      {theater && activeAsset ? (
        <div className="image-preview-backdrop" role="dialog" aria-modal="true" aria-label="视频预览" onMouseDown={(event) => { if (event.target === event.currentTarget) setTheater(false); }}>
          <div className="image-preview">
            <video src={api.assetUrl(activeAsset.url)} controls autoPlay loop playsInline disablePictureInPicture disableRemotePlayback />
            <button type="button" className="image-preview-close" title="关闭预览" aria-label="关闭预览" onClick={() => setTheater(false)}><X size={21} /></button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function EmptyVideoResult() {
  return <div className="empty-result"><div className="empty-result-icon"><Film size={32} /></div><strong>等待生成</strong></div>;
}

function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`status-badge ${status}`}>
      {!terminalStatuses.includes(status) ? <LoaderCircle className="spin" size={13} />
        : status === "succeeded" ? <CheckCircle2 size={13} />
        : <AlertCircle size={13} />}
      {statusLabels[status]}
    </span>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/** 万相的图片素材走 data URI，和视频/音频的公网 URL 混在同一个 media 数组里 */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/** 中转站对请求体有硬上限：实测 1MB 能过、2MB 被网关掐断，且失败时只回含糊的
 *  502 / "fetch failed"。所以视频素材先压到长边 1280 的 JPEG（单张约 150~250KB）。 */
const VIDEO_IMAGE_MAX_EDGE = 1280;
const VIDEO_IMAGE_QUALITY = 0.85;
/** 小于这个体积的图原样发送，省掉一次无谓的有损重编码 */
const VIDEO_IMAGE_PASSTHROUGH_BYTES = 320 * 1024;

async function fileToVideoDataUrl(file: File): Promise<string> {
  if (file.size <= VIDEO_IMAGE_PASSTHROUGH_BYTES) return fileToDataUrl(file);
  try {
    return await downscaleToJpeg(file);
  } catch {
    // 解码不了就退回原图，交给服务端的体积校验给出明确报错
    return fileToDataUrl(file);
  }
}

async function downscaleToJpeg(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, VIDEO_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("无法创建画布");
    // JPEG 没有透明通道，先铺白底，免得带透明度的图渲染成黑块
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", VIDEO_IMAGE_QUALITY);
  } finally {
    bitmap.close();
  }
}

function imageSlotLabel(modeSpec: WanModeSpec | null): string {
  if (!modeSpec) return "参考图";
  if (modeSpec.imageSlots.length === 0) return "参考素材";
  if (modeSpec.imageSlots[0] === "first_frame") return modeSpec.imageSlots.length === 1 ? "首帧图像" : "首帧与尾帧";
  return "参考图像";
}

function slotRoleLabel(modeSpec: WanModeSpec | null, index: number): string | null {
  if (!modeSpec || modeSpec.imageRepeatable) return null;
  const type = modeSpec.imageSlots[index];
  if (type === "first_frame") return "首帧";
  if (type === "last_frame") return "尾帧";
  return null;
}

function optionalNumber(value: string) {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
