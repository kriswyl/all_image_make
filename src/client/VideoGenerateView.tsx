import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle, CheckCircle2, ChevronRight, Clapperboard, Download, Eye, Film, ImagePlus, KeyRound,
  Link as LinkIcon, LoaderCircle, Plus, RotateCcw, Settings2, SlidersHorizontal, Square, Upload, X,
} from "lucide-react";
import { api } from "./api";
import { confirmGeneration } from "./generation-confirm";
import { ChannelPicker } from "./chat/ChannelPicker";
import { ModelPicker } from "./chat/ModelPicker";
import { LazyVideoThumb } from "./LazyVideoThumb";
import { PromptPolishButton } from "./PromptPolishButton";
import { useFileDrop } from "./useFileDrop";
import { useImagePaste } from "./useImagePaste";
import type {
  Asset, Channel, KlingCharacterOrientation, KlingMediaInput, KlingVideoMode, SeedanceMediaInput,
  SeedanceMediaRole, SeedanceVideoMode, Task, TaskStatus, VideoMediaInput, VideoMediaType, WanVideoMode,
} from "../shared/types";
import {
  KLING_MODE_CAPABILITIES, klingModesForModel, VIDEO_CAPABILITIES, type VideoAdapter,
} from "../shared/video-capabilities";
import type { ReferenceController } from "./app-shared";
import {
  StatusBadge, formatDuration, formatTime, optionalNumber, statusLabels, terminalStatuses,
  usePersistentState as useSharedPersistentState,
} from "./task-ui";

type Toast = { kind: "success" | "error"; message: string };



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
  return useSharedPersistentState(key, initialValue, "vector-image:video-draft:");
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
  const [klingMode, setKlingMode] = usePersistentState<KlingVideoMode>("klingMode", "text-to-video");
  const [klingReferenceVideoUrl, setKlingReferenceVideoUrl] = usePersistentState("klingReferenceVideoUrl", "");
  const [klingCharacterOrientation, setKlingCharacterOrientation] = usePersistentState<KlingCharacterOrientation>("klingOrientation", "video");
  const [klingMultiShot, setKlingMultiShot] = usePersistentState("klingMultiShot", true);
  const [urlInputs, setUrlInputs] = usePersistentState<Record<VideoMediaType, string>>("urlInputs", {} as Record<VideoMediaType, string>);
  const [submitting, setSubmitting] = useState(false);
  const [uploadingVideo, setUploadingVideo] = useState(false);
  const [videoUpload, setVideoUpload] = useState<{ name: string; url: string; size: number; duration: number; target: "wan" | "kling" } | null>(null);
  const [audioUpload, setAudioUpload] = useState<{ name: string; dataUri: string; size: number; duration: number } | null>(null);
  const uploadEpoch = useRef(0);

  const references = props.references;
  const referenceImages = references.images;
  const readingImage = references.reading;
  const channel = props.channels.find((item) => item.id === props.selectedChannelId);
  const adapterType = channel?.adapterType as VideoAdapter | undefined;
  const caps = adapterType ? VIDEO_CAPABILITIES[adapterType] : null;
  const isWan = adapterType === "wan-video";
  const isSeedance = adapterType === "seedance-video";
  const isKling = adapterType === "kling-video";
  // 可灵的能力按模型分：turbo 只有文生/首帧/首尾帧，omni 才有多图，运动控制只有 kling-3.0
  const isKlingOmni = isKling && /omni/i.test(props.selectedModel);
  const klingModeOrder = isKling ? klingModesForModel(props.selectedModel) : [];
  const klingCap = isKling ? KLING_MODE_CAPABILITIES[klingMode] : null;
  const modeSpec = isWan ? WAN_MODES[wanMode]
    : isSeedance ? SEEDANCE_MODE_SPECS[seedanceMode]
      : isKling ? klingCap
        : null;
  // 万相/Seedance/可灵按当前模式的槽位算上限，Grok 没有模式概念，直接用适配器上限
  const maxReferenceImages = (isWan || isSeedance || isKling)
    ? (modeSpec?.imageRepeatable ? caps?.maxReferenceImages ?? 0 : modeSpec?.imageSlots.length ?? 0)
    : caps?.maxReferenceImages ?? 0;
  // 分辨率档位跟着模式走：运动控制没有 4K
  const resolutionOptions = klingCap?.resolutions ?? caps?.resolutions ?? [];
  // 可灵普通图生视频（含首尾帧）不认 aspect_ratio，Omni 才认
  const klingAspectRatio = !isKling || klingMode === "text-to-video" || isKlingOmni;
  const urlModeSpec = !isKling ? modeSpec as WanModeSpec | null : null;
  useEffect(() => {
    uploadEpoch.current += 1;
    setUploadingVideo(false);
    setAudioUpload(null);
    setVideoUpload((old) => {
      if (old?.target === "wan") setUrlInputs((current) => current.reference_video === old.url ? { ...current, reference_video: "" } : current);
      if (old?.target === "kling") setKlingReferenceVideoUrl((current) => current === old.url ? "" : current);
      return null;
    });
  }, [props.selectedChannelId, wanMode, klingMode]);

  async function uploadVideo(file: File, target: "wan" | "kling") {
    const epoch = uploadEpoch.current;
    try {
      if (!channel?.uploadEndpoint) throw new Error("该渠道未配置视频上传服务，请手动填写公网地址");
      if (!['video/mp4', 'video/quicktime'].includes(file.type)) throw new Error("请选择 MP4 或 MOV 视频");
      if (file.size > 100 * 1024 * 1024) throw new Error("视频不能超过 100 MB");
      setUploadingVideo(true);
      const seconds = await mediaDuration(file, "video");
      const max = target === "kling" ? (klingCharacterOrientation === "image" ? 10 : 30) : 15;
      const min = target === "kling" ? 3 : 1;
      if (seconds < min || seconds > max) throw new Error(`视频时长需为 ${min}–${max} 秒`);
      if (epoch !== uploadEpoch.current) return;
      const result = await api.uploadReferenceVideo(channel.id, file);
      if (epoch !== uploadEpoch.current) return;
      if (target === "wan") setUrlInputs((current) => ({ ...current, reference_video: result.url }));
      else setKlingReferenceVideoUrl(result.url);
      setVideoUpload({ name: file.name, url: result.url, size: file.size, duration: seconds, target });
    } catch (error) {
      if (epoch === uploadEpoch.current) props.onToast("error", error instanceof Error ? error.message : "视频上传失败");
    } finally { if (epoch === uploadEpoch.current) setUploadingVideo(false); }
  }

  async function selectAudio(file: File) {
    const epoch = uploadEpoch.current;
    try {
      if (!['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/wav', 'audio/x-wav'].includes(file.type)) throw new Error("请选择 MP3、M4A、AAC 或 WAV 音频");
      if (file.size > 15 * 1024 * 1024) throw new Error("音频不能超过 15 MB");
      const duration = await mediaDuration(file, "audio");
      if (duration > 15 || duration <= 0) throw new Error("音频时长需在 15 秒以内");
      const dataUri = await fileToDataUrl(file);
      if (dataUri.length > 15 * 1024 * 1024 * 0.9) throw new Error("音频过大，请换成更小的音频，为其他素材留出空间");
      if (epoch === uploadEpoch.current) setAudioUpload({ name: file.name, dataUri, size: file.size, duration });
    } catch (error) { if (epoch === uploadEpoch.current) props.onToast("error", error instanceof Error ? error.message : "音频读取失败"); }
  }
  const drop = useFileDrop(maxReferenceImages > 0 && !submitting && referenceImages.length < maxReferenceImages, references.dropFiles);
  const pasteImages = useCallback((files: File[]) => {
    if (submitting || readingImage || maxReferenceImages <= 0) return;
    const room = maxReferenceImages - referenceImages.length;
    if (room <= 0) { props.onToast("error", `最多 ${maxReferenceImages} 张图片`); return; }
    if (files.length > room) { props.onToast("error", `最多 ${maxReferenceImages} 张图片，还可添加 ${room} 张`); return; }
    references.dropFiles(files);
  }, [submitting, readingImage, maxReferenceImages, referenceImages.length, references, props.onToast]);
  useImagePaste(pasteImages, !submitting && !readingImage && maxReferenceImages > 0);

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

  useEffect(() => {
    if (isKling && referenceImages.length) references.clear();
  }, [klingMode]);

  useEffect(() => {
    if (isKling && !klingModeOrder.includes(klingMode)) setKlingMode(klingModeOrder[0] ?? "text-to-video");
  }, [isKling, props.selectedModel, klingMode]);

  // 4K 只对文生/图生/Omni 开放，切到运动控制时要退回 1080p
  useEffect(() => {
    if (!resolutionOptions.length) return;
    if (!resolutionOptions.includes(resolution)) setResolution(resolutionOptions[1] ?? resolutionOptions[0]);
  }, [adapterType, klingMode, resolutionOptions.join(",")]);

  // Seedance 首帧/首尾帧只接受自适应比例，界面直接锁定，避免提交后被接口拒绝
  const ratioLocked = isSeedance && (seedanceMode === "first-frame" || seedanceMode === "first-last-frame");
  useEffect(() => {
    if (ratioLocked && ratio !== "adaptive") setRatio("adaptive");
  }, [ratioLocked, ratio]);

  /** 把上传的图片和 URL 输入按模式拼成万相要求的 media 数组 */
  async function buildWanMedia(): Promise<VideoMediaInput[] | string> {
    const spec = WAN_MODES[wanMode];
    const media: VideoMediaInput[] = [];

    // 图片按槽位顺序分配 type：首尾帧模式下第 1 张是 first_frame，第 2 张是 last_frame
    for (const [index, item] of referenceImages.entries()) {
      const type = spec.imageRepeatable
        ? spec.imageSlots[0]
        : spec.imageSlots[index];
      if (!type) return `${spec.label}最多接受 ${spec.imageSlots.length} 张图片`;
      media.push({ type, url: await fileToVideoDataUrl(item.file) });
    }

    for (const slot of spec.urlSlots) {
      if (slot.type === "reference_audio" && audioUpload) {
        media.push({ type: slot.type, url: audioUpload.dataUri });
        continue;
      }
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
    if (spec.imageSlots.length && !spec.imageRepeatable && referenceImages.length < spec.imageSlots.length) {
      return `${spec.label}需要 ${spec.imageSlots.length} 张图片`;
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

  /** 可灵的 media：首帧/尾帧/参考图/角色图，运动控制再补参考视频 */
  async function buildKlingMedia(): Promise<KlingMediaInput[] | string> {
    const spec = KLING_MODE_CAPABILITIES[klingMode];
    const slots = spec.imageSlots;
    if (!slots.length && !spec.needsReferenceVideo) return [];
    if (!spec.imageRepeatable && slots.length && referenceImages.length < slots.length) {
      return `${spec.label}需要 ${slots.length} 张图片`;
    }
    if (!spec.imageRepeatable && referenceImages.length > slots.length) {
      return `${spec.label}最多 ${slots.length} 张图片`;
    }
    const media: KlingMediaInput[] = [];
    for (const [index, item] of referenceImages.entries()) {
      const type = spec.imageRepeatable ? slots[0] : slots[index];
      if (!type) return `${spec.label}最多 ${slots.length} 张图片`;
      media.push({ type, url: await fileToVideoDataUrl(item.file) });
    }
    if (spec.needsReferenceVideo) {
      const url = klingReferenceVideoUrl.trim();
      if (!url) return "运动控制需要填写参考视频的公网地址";
      if (!/^https?:\/\//i.test(url)) return "参考视频需要 http(s):// 公网地址";
      media.push({ type: "video", url });
    }
    return media;
  }

  async function generate() {
    if (uploadingVideo) return props.onToast("error", "视频上传中，请稍候");
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
      let klingVideoMedia: KlingMediaInput[] | undefined;
      if (isWan) {
        const built = await buildWanMedia();
        if (typeof built === "string") { props.onToast("error", built); return; }
        wanVideoMedia = built.length ? built : undefined;
      } else if (isSeedance) {
        const built = await buildSeedanceMedia();
        if (typeof built === "string") { props.onToast("error", built); return; }
        seedanceVideoMedia = built.length ? built : undefined;
      } else if (isKling) {
        const built = await buildKlingMedia();
        if (typeof built === "string") { props.onToast("error", built); return; }
        klingVideoMedia = built.length ? built : undefined;
      }

      if (!confirmGeneration({ kind: "视频生成", model: props.selectedModel, channel: channel.name, detail: `时长：${caps.durations.fixed ?? duration} 秒 · 分辨率：${resolution}` })) return;
      const task = await api.generate({
        channelId: channel.id,
        model: props.selectedModel,
        prompt: prompt.trim(),
        negativePrompt: negativePrompt.trim() || undefined,
        duration: modeSpec && !modeSpec.durationEditable ? undefined : caps.durations.fixed ?? duration,
        resolution,
        // Grok 用 aspect_ratio，万相用 ratio；可灵的图生/运动控制不认宽高比
        aspectRatio: caps.ratioField === "aspectRatio" && klingAspectRatio ? aspectRatio : undefined,
        ratio: caps.ratioField === "ratio" ? ratio : undefined,
        audio: caps.supportsAudio ? audio : undefined,
        promptExtend: caps.supportsPromptExtend ? promptExtend : undefined,
        watermark: caps.supportsWatermark ? watermark : undefined,
        seed: caps.supportsSeed ? optionalNumber(seed) : undefined,
        wanVideoMode: isWan ? wanMode : undefined,
        wanVideoMedia,
        seedanceVideoMode: isSeedance ? seedanceMode : undefined,
        seedanceVideoMedia,
        klingVideoMedia,
        klingVideoMode: isKling ? klingMode : undefined,
        klingCharacterOrientation: isKling && klingMode === "motion-control" ? klingCharacterOrientation : undefined,
        klingMultiShot: isKling ? klingMultiShot : undefined,
        timeoutMs: timeoutSeconds * 1000,
        rawParameters,
      }, (isWan || isSeedance || isKling) ? [] : referenceImages.map((item) => item.file));
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
          <h1>视频生成</h1>
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
              {isWan || isSeedance || isKling ? (
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
                      : isSeedance
                        ? SEEDANCE_MODE_ORDER.map((item) => (
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
                          ))
                        : klingModeOrder.map((item) => (
                            <button
                              key={item}
                              type="button"
                              role="radio"
                              aria-checked={klingMode === item}
                              className={`mode-chip ${klingMode === item ? "active" : ""}`}
                              onClick={() => setKlingMode(item)}
                            >
                              {KLING_MODE_CAPABILITIES[item].label}
                            </button>
                          ))}
                  </div>
                  {modeSpec ? <p className="mode-hint">{modeSpec.hint}</p> : null}
                </>
              ) : null}

              <div className="section-title">
                <div><Film size={17} /><h2>提示词</h2></div>
                <div className="prompt-heading-tools">
                  <PromptPolishButton prompt={prompt} target="video" onPolished={setPrompt} onToast={props.onToast} disabled={submitting} />
                  <span>{prompt.length} / 20000</span>
                </div>
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
                      <span className="reference-file"><strong>{drop.active ? "松开即可添加" : readingImage ? "读取中" : "添加图片"}</strong><small>点击选择、拖入或 Ctrl+V 粘贴 · PNG / JPEG / WebP · 单张最大 20 MB</small></span>
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

              {isKling && klingCap?.needsReferenceVideo ? (
                <div className="media-url-block">
                  <div className="section-title compact"><div><LinkIcon size={16} /><h2>参考视频</h2></div></div>
                  <div className="media-input-group"><label className="field-block">
                    <span>视频地址<em className="required-mark">必填</em></span>
                    <input
                      value={klingReferenceVideoUrl}
                      onChange={(event) => { setKlingReferenceVideoUrl(event.target.value); if (videoUpload?.target === "kling" && event.target.value !== videoUpload.url) setVideoUpload(null); }}
                      placeholder="https://…/motion.mp4"
                      spellCheck={false}
                    />
                  </label>
                  {channel?.uploadEndpoint ? <label className={`media-upload-button ${uploadingVideo ? "is-loading" : ""}`}><Upload size={14} />{uploadingVideo ? "上传中…" : "选择视频"}<input type="file" accept="video/mp4,video/quicktime,.mp4,.mov" disabled={uploadingVideo} onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (f) void uploadVideo(f, "kling"); }} /></label> : <p className="mode-hint">该渠道未配置上传地址，请手动填写公网地址。</p>}
                  {videoUpload?.target === "kling" ? <div className="media-file-chip"><Film size={15} /><span><strong title={videoUpload.name}>{videoUpload.name}</strong><small>{videoUpload.duration.toFixed(1)} 秒 · {(videoUpload.size / 1024 / 1024).toFixed(1)} MB · 已上传</small></span><button type="button" aria-label="移除已上传视频" onClick={() => { setKlingReferenceVideoUrl(""); setVideoUpload(null); }}><X size={14} /></button></div> : null}</div>
                  <p className="mode-hint">
                    上传后文件可通过公网访问，请勿上传敏感内容。
                    角色朝向选「图片」时视频需 ≤10 秒，选「视频」时 ≤30 秒。
                  </p>
                </div>
              ) : null}

              {urlModeSpec?.urlSlots.length ? (
                <div className="media-url-block">
                  <div className="section-title compact"><div><LinkIcon size={16} /><h2>参考素材</h2></div><span>支持文件或链接</span></div>
                  {urlModeSpec.urlSlots.map((slot) => (
                    <div className="media-input-group" key={slot.type}><label className="field-block">
                      <span>{slot.label}{slot.required ? <em className="required-mark">必填</em> : null}</span>
                      <input
                        value={urlInputs[slot.type] ?? ""}
                        onChange={(event) => { setUrlInputs({ ...urlInputs, [slot.type]: event.target.value }); if (slot.type === "reference_video" && videoUpload?.target === "wan" && event.target.value !== videoUpload.url) setVideoUpload(null); }}
                        placeholder={slot.placeholder}
                        spellCheck={false}
                      />
                    </label>
                    {slot.type === "reference_video" && channel?.uploadEndpoint ? <label className={`media-upload-button ${uploadingVideo ? "is-loading" : ""}`}><Upload size={14} />{uploadingVideo ? "上传中…" : "选择视频"}<input type="file" accept="video/mp4,video/quicktime,.mp4,.mov" disabled={uploadingVideo} onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (f) void uploadVideo(f, "wan"); }} /></label> : null}
                    {slot.type === "reference_video" && !channel?.uploadEndpoint ? <p className="mode-hint">该渠道未配置上传地址，请手动填写公网地址。</p> : null}
                    {slot.type === "reference_video" && videoUpload?.target === "wan" ? <div className="media-file-chip"><Film size={15} /><span><strong title={videoUpload.name}>{videoUpload.name}</strong><small>{videoUpload.duration.toFixed(1)} 秒 · {(videoUpload.size / 1024 / 1024).toFixed(1)} MB · 已上传</small></span><button type="button" aria-label="移除已上传视频" onClick={() => { setUrlInputs((v) => ({ ...v, reference_video: "" })); setVideoUpload(null); }}><X size={14} /></button></div> : null}
                    {slot.type === "reference_audio" ? <><label className="media-upload-button"><Upload size={14} />选择音频<input type="file" accept="audio/mpeg,audio/mp4,audio/aac,audio/wav,audio/x-wav,.mp3,.m4a,.aac,.wav" onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ""; if (f) void selectAudio(f); }} /></label>{audioUpload ? <div className="media-file-chip"><span className="media-audio-icon">♫</span><span><strong title={audioUpload.name}>{audioUpload.name}</strong><small>{audioUpload.duration.toFixed(1)} 秒 · {(audioUpload.size / 1024 / 1024).toFixed(1)} MB · 优先于链接</small></span><button type="button" aria-label="移除已选择音频" onClick={() => setAudioUpload(null)}><X size={14} /></button></div> : <p className="media-input-note">MP3 / M4A / AAC / WAV · 最长 15 秒</p>}</> : null}
                    </div>
                  ))}
                  <p className="mode-hint">视频上传后可通过公网访问，请勿上传敏感内容。音频支持本地文件或手动地址。</p>
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
                      {resolutionOptions.map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                  </label>
                  {isKling && klingMode === "motion-control" ? (
                    <label>
                      <span>角色朝向</span>
                      <select value={klingCharacterOrientation} onChange={(event) => setKlingCharacterOrientation(event.target.value as KlingCharacterOrientation)}>
                        <option value="video">跟随参考视频（≤30 秒）</option>
                        <option value="image">跟随角色图片（≤10 秒）</option>
                      </select>
                    </label>
                  ) : null}
                  {caps.ratioField === "aspectRatio" && caps.aspectRatios.length && klingAspectRatio ? (
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
                    <label className="switch-field">
                      <span>{isKling && klingMode === "motion-control" ? "保留参考视频原声" : "包含音频"}</span>
                      <input type="checkbox" checked={audio} onChange={(event) => setAudio(event.target.checked)} />
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
                      {isKling && klingMode !== "motion-control" ? (
                        <label className="switch-field">
                          <span>多镜头</span>
                          <input type="checkbox" checked={klingMultiShot} onChange={(event) => setKlingMultiShot(event.target.checked)} />
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
              <button className="primary-button generate-button" onClick={generate} disabled={submitting || uploadingVideo || readingImage || !channel || !props.selectedModel}>
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
    if (!confirmGeneration({ kind: "视频生成", model: task.model, channel: task.channelName, retry: true })) return;
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
                onContextMenu={(event) => event.preventDefault()}
              />
            ) : null}
            {/* disablePictureInPicture / disableRemotePlayback 去掉悬停时浮出的「画中画」「投屏」按钮 */}
            <video
              key={activeAsset.id}
              className="stage-video-main"
              src={api.assetUrl(activeAsset.url)}
              controls
              controlsList="nodownload"
              loop
              playsInline
              preload="metadata"
              title="双击放大"
              onContextMenu={(event) => event.preventDefault()}
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
                  <video src={api.assetUrl(asset.url)} muted playsInline preload="metadata" onContextMenu={(event) => event.preventDefault()} />
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
            <video src={api.assetUrl(activeAsset.url)} controls controlsList="nodownload" autoPlay loop playsInline disablePictureInPicture disableRemotePlayback onContextMenu={(event) => event.preventDefault()} />
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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/** 图片和音频可使用 data URI。 */
function mediaDuration(file: File, kind: "audio" | "video"): Promise<number> {
  return new Promise((resolve, reject) => {
    const media = document.createElement(kind);
    const url = URL.createObjectURL(file);
    const timeout = window.setTimeout(() => finish(new Error("读取素材时长超时")), 15000);
    function finish(error?: Error) {
      const duration = media.duration;
      window.clearTimeout(timeout);
      URL.revokeObjectURL(url);
      media.removeAttribute("src");
      if (error) reject(error); else resolve(duration);
    }
    media.preload = "metadata";
    media.onloadedmetadata = () => Number.isFinite(media.duration) ? finish() : finish(new Error("无法读取素材时长"));
    media.onerror = () => finish(new Error("无法读取素材，请检查文件格式"));
    media.src = url;
  });
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
    reader.readAsDataURL(file);
  });
}

/** 视频图片沿用长边 1280 的 JPEG 预处理，为其他素材留出空间。 */
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

function imageSlotLabel(modeSpec: { imageSlots: readonly string[]; imageRepeatable: boolean } | null): string {
  if (!modeSpec) return "参考图";
  if (modeSpec.imageSlots.length === 0) return "参考素材";
  if (modeSpec.imageSlots[0] === "first_frame") return modeSpec.imageSlots.length === 1 ? "首帧图像" : "首帧与尾帧";
  if (modeSpec.imageSlots[0] === "image") return "角色图片";
  return "参考图像";
}

function slotRoleLabel(
  modeSpec: { imageSlots: readonly string[]; imageRepeatable: boolean } | null,
  index: number,
): string | null {
  if (!modeSpec || modeSpec.imageRepeatable) return null;
  const type = modeSpec.imageSlots[index];
  if (type === "first_frame") return "首帧";
  if (type === "last_frame") return "尾帧";
  if (type === "image") return "角色";
  return null;
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
