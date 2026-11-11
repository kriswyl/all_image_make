import { cloneElement, isValidElement, useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, HTMLAttributes, ReactElement, ReactNode } from "react";
import {
  ArrowLeftRight, ChevronDown, ChevronLeft, ChevronRight, Film, ImagePlus, KeyRound, LoaderCircle, Maximize2, Minimize2, Music, Send, Upload, Wand2, X,
} from "lucide-react";
import { createPortal } from "react-dom";
import type { Channel } from "../../shared/types";
import type { VideoCapability } from "../../shared/video-capabilities";
import type { VideoDraft } from "../../shared/video-draft";
import { referenceMediaLimits, type VideoModeSpec } from "../../shared/video-modes";
import type { MediaBucket } from "../hooks/useMediaBuckets";
import { PromptPolishButton } from "../PromptPolishButton";
import { VideoParamsPanel } from "./VideoParamsPanel";
import { VideoMentionPanel, type MentionItem, type MentionUpload } from "./VideoMentionPanel";
import { PromptEditor, type PromptEditorHandle } from "./PromptEditor";
import { addableOptions, assetOptions, type AssetOption } from "./asset-options";
import { assetPageCapacity, assetPageCount } from "./asset-paging";
import { useAnchoredPanelStyle, usePanelDismiss, type PanelAnchorRect } from "./useAnchoredPanel";

/**
 * 一体化创作框。
 *
 * 版面按设计稿：**上方一排**参考素材，下面提示词，底部一排**一个**参数模块——
 * 点它就弹参数浮层，不再是一串各管一块的胶囊。
 *
 * 多张参考素材默认是**不规则折叠的一摞**（最近 3 张错开 + 轻微旋转，角标写总数），
 * 只有鼠标悬停在**这一摞本身**（或键盘聚焦进来）才展开成整齐的一排；一页放满就
 * 翻页，不做横向滚动。箭头是排里的普通兄弟节点，不会压住任何一格。
 *
 * 素材排在输入框上方而不是左边，是为了让「加素材」永远不改变输入框的尺寸：
 * 那一排高度是固定的，折叠、展开、翻页都不会让正文被挤窄或挤矮。
 *
 * 模式、参数、@ 素材都是浮层，浮层挂在 body 上，因此开面板、加素材都不会
 * 重新挂载编辑器——正在写的提示词不会丢。
 */

export interface VideoComposerProps {
  channel: Channel | undefined;
  adapter: string | undefined;
  model: string;
  caps: VideoCapability | null;
  modes: VideoModeSpec[];
  spec: VideoModeSpec | null;
  draft: VideoDraft;
  bucket: MediaBucket;
  maxImages: number;
  /** 参考视频/音频还能放几段：>1 时文件对话框允许多选 */
  videoRoom: number;
  audioRoom: number;
  submitting: boolean;
  reading: boolean;
  dropActive: boolean;
  dropProps: Pick<HTMLAttributes<HTMLDivElement>, "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop">;
  notice: string | null;
  /** 展开态：输入框吃掉工作区，记录区让位（状态由页面持有） */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onDraftChange: (patch: Partial<VideoDraft>) => void;
  onModeChange: (mode: VideoModeSpec) => void;
  onAddImages: (files: File[]) => void;
  onRemoveImage: (previewUrl: string) => void;
  onSelectVideos: (files: File[]) => void;
  onRemoveVideo: (id: string) => void;
  onSelectAudios: (files: File[]) => void;
  onRemoveAudio: (id: string) => void;
  onGenerate: () => void;
  onConfigureChannel: () => void;
  onToast: (kind: "success" | "error", message: string) => void;
}

const ROLE_LABELS: Record<string, string> = {
  first_frame: "首帧",
  last_frame: "尾帧",
  reference_image: "参考图",
  image: "角色图",
};

interface MediaEntry {
  key: string;
  /** 视频/音频的桶内 id：移除时用它，不靠下标 */
  mediaId?: string;
  label: string;
  kind: "视频" | "图片" | "音频";
  previewUrl?: string;
  duration?: number;
  size?: number;
  fileName?: string;
  onRemove: () => void;
}

function roleLabel(spec: VideoModeSpec | null, index: number): string {
  if (!spec) return "参考图";
  // 合并后的首尾帧：第 1 张必填、第 2 张可选；格子上只写「尾帧」，
  // 可选性交给模式提示说明，别把四个字塞进小方格（设计稿里是两字标签）
  if (spec.id === "frames" && index === 1) return "尾帧";
  if (spec.imageRepeatable) return ROLE_LABELS[spec.imageSlots[0] ?? ""] ?? "参考图";
  return ROLE_LABELS[spec.imageSlots[index] ?? ""] ?? "参考图";
}

/** 固定槽位模式（首尾帧 / 角色图）按槽位画格子；参考图模式画缩略图 + 加号 */
function isFixedSlotMode(spec: VideoModeSpec | null): boolean {
  return Boolean(spec && !spec.imageRepeatable && spec.imageSlots.length > 0);
}

/**
 * @ 引用的素材清单：顺序与提交时的素材数组一致。
 *
 * 视频和音频都可以有多段（Seedance 2.0 三段、2.5 十段），编号就是提交顺序，
 * 所以「@视频2」指的确实是第二段，不会因为编号写死成 1 而错位。
 */
function mentionItemsOf(bucket: MediaBucket): MentionItem[] {
  return [
    ...bucket.videos.map((item, index) => ({ label: `视频${index + 1}`, kind: "视频" as const, previewUrl: item.previewUrl })),
    ...bucket.images.map((item, index) => ({ label: `图片${index + 1}`, kind: "图片" as const, previewUrl: item.previewUrl })),
    ...bucket.audios.map((_, index) => ({ label: `音频${index + 1}`, kind: "音频" as const })),
  ];
}

function mediaEntriesOf(bucket: MediaBucket, handlers: {
  onRemoveImage: (previewUrl: string) => void;
  onRemoveVideo: (id: string) => void;
  onRemoveAudio: (id: string) => void;
}): MediaEntry[] {
  return [
    ...bucket.videos.map((item, index) => ({
      key: `video-${index}`, mediaId: item.id, label: `视频${index + 1}`, kind: "视频" as const,
      previewUrl: item.previewUrl, duration: item.duration, size: item.file.size, fileName: item.file.name,
      onRemove: () => handlers.onRemoveVideo(item.id),
    })),
    ...bucket.images.map((item, index) => ({
      key: `image-${index}`, label: `图片${index + 1}`, kind: "图片" as const, previewUrl: item.previewUrl,
      size: item.file.size, fileName: item.file.name, onRemove: () => handlers.onRemoveImage(item.previewUrl),
    })),
    ...bucket.audios.map((item, index) => ({
      key: `audio-${index}`, mediaId: item.id, label: `音频${index + 1}`, kind: "音频" as const,
      duration: item.duration, size: item.file.size, fileName: item.file.name,
      onRemove: () => handlers.onRemoveAudio(item.id),
    })),
  ];
}

/**
 * @ 胶囊详情要显示的素材信息：按「视频2 / 图片3 / 音频1」这种记号回桶里找。
 * 视频/音频现在是多段的，不能再假设只有第 1 段。
 */
function chipMediaMeta(item: MentionItem, bucket: MediaBucket): { duration?: number; size: number; fileName: string } | undefined {
  const index = Number(item.label.replace(/\D/g, "")) - 1;
  if (index < 0) return undefined;
  if (item.kind === "视频") {
    const file = bucket.videos[index];
    return file ? { duration: file.duration, size: file.file.size, fileName: file.file.name } : undefined;
  }
  if (item.kind === "音频") {
    const file = bucket.audios[index];
    return file ? { duration: file.duration, size: file.file.size, fileName: file.file.name } : undefined;
  }
  const image = bucket.images[index];
  return image ? { size: image.file.size, fileName: image.file.name } : undefined;
}

/** 素材缩略图：视频取首帧，音频画音符 */
function MediaThumb({ entry }: { entry: Pick<MediaEntry, "kind" | "previewUrl"> }) {
  if (entry.previewUrl && entry.kind === "视频") {
    return <video src={`${entry.previewUrl}#t=0.1`} muted playsInline preload="metadata" />;
  }
  if (entry.previewUrl) return <img src={entry.previewUrl} alt="" />;
  return entry.kind === "音频" ? <Music size={18} /> : <Film size={18} />;
}

/** 点开的素材详情：大图 / 播放器 + 名称、时长、体积 */
function MediaDetail(props: { entry: MediaEntry; rect: PanelAnchorRect; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const style = useAnchoredPanelStyle(true, props.rect, 320, 420, "start");
  usePanelDismiss(true, props.onClose, panelRef, null);
  if (!style) return null;
  const { entry } = props;
  return createPortal(
    <div className="vstudio-panel vstudio-media-detail" ref={panelRef} style={style} role="dialog" aria-label={`${entry.label}详情`}>
      <div className={`vstudio-media-detail-body is-${entry.kind}`}>
        {entry.kind === "视频" && entry.previewUrl
          ? <video src={entry.previewUrl} controls autoPlay muted loop playsInline />
          : entry.kind === "图片" && entry.previewUrl
            ? <img src={entry.previewUrl} alt={entry.label} />
            : entry.kind === "音频" && entry.previewUrl
              ? <audio src={entry.previewUrl} controls autoPlay />
              : <div className="vstudio-media-detail-empty"><Music size={26} /></div>}
      </div>
      <div className="vstudio-media-detail-meta">
        <strong>{entry.label}</strong>
        <span>
          {entry.duration != null ? `${entry.duration.toFixed(1)} 秒 · ` : ""}
          {entry.size != null ? `${(entry.size / 1024 / 1024).toFixed(1)} MB` : ""}
        </span>
      </div>
      {entry.fileName ? <p className="vstudio-media-detail-name" title={entry.fileName}>{entry.fileName}</p> : null}
    </div>,
    document.body,
  );
}

/**
 * 提示词输入框交给 `PromptEditor`（contenteditable）。
 *
 * 为什么不用 textarea：`@图片1` 要一直是**带缩略图的胶囊**。textarea 里放不了
 * 内联元素，只能靠盖在上面的展示层去画，而展示层的宽度一旦和文字不同，光标、
 * 选区、点击定位就全错位。换成 contenteditable 之后，胶囊和正文是同一棵 DOM，
 * 编辑中和失焦后长得一模一样，光标也永远落在正确的位置。
 */

export function VideoComposer(props: VideoComposerProps) {
  const {
    channel, adapter, caps, modes, spec, draft, bucket, maxImages, submitting, reading,
    dropActive, dropProps, notice, expanded, onExpandedChange, onDraftChange, onModeChange,
  } = props;
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  // @ 面板的锚点：敲 @ 时贴着光标，点按钮时贴着按钮（否则面板会飘到输入框左边）
  const [mentionFromCaret, setMentionFromCaret] = useState(false);
  const [mentionRect, setMentionRect] = useState<PanelAnchorRect | null>(null);
  const [promptFocused, setPromptFocused] = useState(false);
  const [detail, setDetail] = useState<{ entry: MediaEntry; rect: PanelAnchorRect } | null>(null);
  const [chipDetail, setChipDetail] = useState<{ item: MentionItem; rect: PanelAnchorRect } | null>(null);
  /** 「参考内容」入口的类型选择：能收多种素材时才弹，锚点就用点下去那一格的矩形 */
  const [assetMenu, setAssetMenu] = useState<PanelAnchorRect | null>(null);
  const assetMenuRef = useRef<HTMLDivElement | null>(null);
  const assetAnchorRef = useRef<HTMLElement | null>(null);
  const assetMenuStyle = useAnchoredPanelStyle(Boolean(assetMenu), assetMenu, 264, 280, "start");
  usePanelDismiss(Boolean(assetMenu), () => setAssetMenu(null), assetMenuRef, assetAnchorRef.current);
  /**
   * 鼠标点进输入框只该出现文字光标；用 Tab 键过来才给一圈低调的焦点提示。
   * textarea 的 :focus-visible 在鼠标点击时也成立（浏览器把它当文本输入），
   * 所以这里自己记「最近一次是键盘还是指针」，不靠伪类猜。
   */
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Tab") setKeyboardFocus(true); };
    const onPointerDown = () => setKeyboardFocus(false);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, []);
  const modeChipRef = useRef<HTMLButtonElement | null>(null);
  const paramChipRef = useRef<HTMLButtonElement | null>(null);
  const mentionButtonRef = useRef<HTMLButtonElement | null>(null);
  const modePanelRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<PromptEditorHandle | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);

  const modeStyle = useAnchoredPanelStyle(modeMenuOpen, modeChipRef.current, 260, 360);
  usePanelDismiss(modeMenuOpen, () => setModeMenuOpen(false), modePanelRef, modeChipRef.current);

  const fixedSlots = isFixedSlotMode(spec) ? spec!.imageSlots : null;
  const repeatable = Boolean(spec?.imageRepeatable) || (!spec && maxImages > 0);
  const filled = bucket.images.length;
  const hasVideoSlot = Boolean(spec?.acceptsReferenceVideo || spec?.needsReferenceVideo);
  const hasAudioSlot = Boolean(spec?.acceptsReferenceAudio);
  /** 参考视频/音频各能放几段：Seedance 按版本上限，万相/可灵各一段 */
  const mediaLimits = referenceMediaLimits(props.adapter, props.model, spec);
  const canUploadVideo = Boolean(channel?.uploadEndpoint);
  const ratioValue = caps?.ratioField === "ratio" ? draft.ratio : draft.aspectRatio;
  const ratioLabel = ratioValue === "adaptive" ? "智能比例" : ratioValue;
  const resolutionLabel = draft.resolution ? draft.resolution.toUpperCase() : "—";
  const audioSupported = Boolean(caps?.supportsAudio);
  const durationLabel = spec && !spec.durationEditable ? "时长随视频" : draft.duration === -1 ? "智能时长" : `${draft.duration} 秒`;
  const disabled = submitting || reading || !channel || !props.model;
  const mentionItems = mentionItemsOf(bucket);
  const mediaEntries = mediaEntriesOf(bucket, {
    onRemoveImage: props.onRemoveImage,
    onRemoveVideo: props.onRemoveVideo,
    onRemoveAudio: props.onRemoveAudio,
  });
  /**
   * 可选素材的入口：图片可追加、或能加参考视频/音频的模式，那一排即使空着
   * 也要在——「提示词生视频」同样需要放参考内容的入口，不是只有首尾帧才有。
   */
  const optionalAssets = Boolean(spec?.imageRepeatable) || hasVideoSlot || hasAudioSlot;

  /**
   * 空槽位只在「非放不可」的时候出现：首尾帧的两格、视频编辑/延长必须的参考视频。
   * 另外，能放可选素材的模式留一个「参考内容」入口——一个虚线格，比一排空槽位
   * 安静，但入口是有的。
   */
  const requiredVideoSlot = Boolean(spec?.needsReferenceVideo) && bucket.videos.length === 0;
  const showSlots = Boolean(fixedSlots) || requiredVideoSlot || mediaEntries.length > 0 || optionalAssets;

  /**
   * 素材一排分页显示：**不做横向滚动**。
   *
   * 之前是横向滚动 + 两个浮在末尾的箭头，箭头会压住最后一张的角。现在按可用
   * 宽度算一页能放几张，箭头摆在两侧（不覆盖素材），翻页只看这一排，正文和
   * 输入框都不动。
   */
  const mediaCount = mediaEntries.length;
  const assetsRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [stripWidth, setStripWidth] = useState(0);
  // 量的是整个创作框主体，不是素材排自己：折叠态那一排会缩成浮动的小块，
  // 拿它的宽度算每页容量会只剩 1 格，展开后一页一张反倒全乱了。
  const measureStrip = useCallback(() => setStripWidth(bodyRef.current?.clientWidth ?? 0), []);
  useEffect(() => {
    measureStrip();
    window.addEventListener("resize", measureStrip);
    return () => window.removeEventListener("resize", measureStrip);
  }, [measureStrip]);
  useEffect(() => { measureStrip(); }, [mediaCount, measureStrip]);

  const [assetPage, setAssetPage] = useState(0);
  /** 一摞只是「没悬停」的样子；移进这一排（或键盘聚焦进来）就摊开 */
  const [assetsExpanded, setAssetsExpanded] = useState(false);

  function pickImages(files: FileList | null) {
    if (!files?.length) return;
    props.onAddImages(Array.from(files));
  }

  /** 合并入口到底会按哪种上游模式提交，写清楚，别让用户猜 */
  function effectiveModeHint(): string | null {
    if (!spec?.compose) return null;
    if (spec.compose === "frames") {
      if (bucket.images.length >= 2) return "已放 2 张图：按「首尾帧生视频」提交";
      if (bucket.images.length === 1) return "已放 1 张图：按「首帧生视频」提交，再加 1 张就是尾帧";
      return "上传 1 张图作为首帧；再加 1 张自动变成首尾帧";
    }
    // 没有素材时不啰嗦：标题下面那行已经写着「文生视频」了
    const count = mediaEntries.length;
    if (!count) return null;
    const parts = [
      bucket.images.length ? `${bucket.images.length} 张图` : "",
      bucket.videos.length ? `${bucket.videos.length} 段视频` : "",
      bucket.audios.length ? `${bucket.audios.length} 段音频` : "",
    ].filter(Boolean).join(" + ");
    return `已放 ${parts}：按「参考生视频」提交`;
  }

  /** 把 @记号 插到光标处；光标前若正好是刚敲的「@」，用它替换掉，避免出现「@@图片1」 */
  function insertMention(label: string) {
    editorRef.current?.insertMention(label);
    setMentionOpen(false);
  }

  /**
   * 素材入口：哪些能传、为什么不能传、已经有了能不能换，都在同一处算。
   *
   * 视频 / 音频上游各只收一段，但入口不再「传过就消失」——再点一次是替换，
   * 不用先把旧的删掉。
   */
  const options = assetOptions({
    maxImages,
    filled,
    maxVideos: hasVideoSlot ? mediaLimits.videos : 0,
    maxAudios: hasAudioSlot ? mediaLimits.audios : 0,
    videoCount: bucket.videos.length,
    audioCount: bucket.audios.length,
    canUploadVideo,
    disabled,
  });
  const uploads: MentionUpload[] = options;
  const addableKinds: AssetOption[] = addableOptions(options, {
    repeatableImages: repeatable,
    videoSlotRequired: Boolean(spec?.needsReferenceVideo),
  });
  const addableLabel = addableKinds.map((item) => item.kind).join(" / ");

  function triggerUpload(kind: MentionUpload["kind"]) {
    if (kind === "图片") imageInputRef.current?.click();
    else if (kind === "视频") videoInputRef.current?.click();
    else audioInputRef.current?.click();
  }

  /**
   * 点「参考内容」：模式只收一种素材就直接开系统选择框；收多种（图片 / 视频 /
   * 音频）就先问一句加哪种。之前这里写死成只能加图片，带参考视频槽位的模式
   * 等于没有入口，只能绕到 @ 面板里去传。
   */
  function openAssetPicker(target: HTMLElement) {
    if (!addableKinds.length) {
      props.onToast("error", "当前模式没有可添加的参考内容");
      return;
    }
    const usable = addableKinds.filter((item) => !item.disabled);
    if (usable.length <= 1) {
      const only = usable[0] ?? addableKinds[0]!;
      if (only.disabled) {
        props.onToast("error", only.hint ?? `${only.kind}暂时不能上传`);
        return;
      }
      triggerUpload(only.kind);
      return;
    }
    assetAnchorRef.current = target;
    setAssetMenu(target.getBoundingClientRect());
  }

  const fileInputs = (
    <>
      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple={repeatable}
        disabled={disabled || filled >= maxImages}
        className="vstudio-file-input"
        onChange={(event) => { pickImages(event.currentTarget.files); event.currentTarget.value = ""; }}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept="video/mp4,video/quicktime,.mp4,.mov"
        multiple={props.videoRoom > 1}
        disabled={disabled || !canUploadVideo}
        className="vstudio-file-input"
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          if (files.length) props.onSelectVideos(files);
        }}
      />
      <input
        ref={audioInputRef}
        type="file"
        accept="audio/mpeg,audio/mp4,audio/aac,audio/wav,.mp3,.m4a,.aac,.wav"
        multiple={props.audioRoom > 1}
        disabled={disabled}
        className="vstudio-file-input"
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          if (files.length) props.onSelectAudios(files);
        }}
      />
    </>
  );

  /**
   * 素材格：一排铺开、按页显示。
   *
   * 之前是「左侧一列收成一摞、悬停抖开」——素材和输入框抢宽度，展开时正文会被
   * 挤窄。改成输入框上方固定高度的一排之后，加多少素材都不会改变输入框大小；
   * 一排放不下就翻页，不做横向滚动（滚动会把翻页键推到素材上面盖住角）。
   */
  function assetTileList() {
    const tiles: ReactNode[] = [];

    if (fixedSlots) {
      fixedSlots.forEach((slotType, index) => {
        const item = bucket.images[index];
        const link = index === 1 ? <span className="vstudio-slot-link" aria-hidden="true"><ArrowLeftRight size={12} /></span> : null;
        if (item) {
          tiles.push(
            <div className="vstudio-slot-pair" key={slotType}>
              {link}
              <div className="vstudio-media-tile">
                <button
                  type="button"
                  className="vstudio-media-open"
                  title={`查看${roleLabel(spec, index)}`}
                  onClick={(event) => setDetail({
                    entry: mediaEntries.find((media) => media.key === `image-${index}`) ?? {
                      key: `image-${index}`, label: roleLabel(spec, index), kind: "图片",
                      previewUrl: item.previewUrl, size: item.file.size, fileName: item.file.name,
                      onRemove: () => props.onRemoveImage(item.previewUrl),
                    },
                    rect: event.currentTarget.getBoundingClientRect(),
                  })}
                >
                  <img src={item.previewUrl} alt={roleLabel(spec, index)} />
                  <span className="vstudio-media-tag">{roleLabel(spec, index)}</span>
                </button>
                <button type="button" className="vstudio-media-remove" aria-label={`移除${roleLabel(spec, index)}`}
                  onClick={() => props.onRemoveImage(item.previewUrl)}><X size={11} /></button>
              </div>
            </div>,
          );
          return;
        }
        tiles.push(
          <div className="vstudio-slot-pair" key={slotType}>
            {link}
            <button className="vstudio-slot" type="button" title={`添加${roleLabel(spec, index)}`}
              onClick={() => imageInputRef.current?.click()}>
              {reading ? <LoaderCircle className="spin" size={16} /> : <ImagePlus size={16} />}
              <span>{roleLabel(spec, index)}</span>
            </button>
          </div>,
        );
      });
    } else {
      bucket.images.forEach((item, index) => {
        const entry = mediaEntries.find((media) => media.key === `image-${index}`);
        if (!entry) return;
        tiles.push(
          <div className="vstudio-media-tile" key={item.previewUrl}>
            <button
              type="button"
              className="vstudio-media-open"
              title={`查看图片${index + 1}`}
              onClick={(event) => setDetail({ entry, rect: event.currentTarget.getBoundingClientRect() })}
            >
              <img src={item.previewUrl} alt={`图片${index + 1}`} />
              {/* 标签与 @ 记号一一对应：素材格写「图片2」，提示词里就是 @图片2 */}
              <span className="vstudio-media-tag">
                {spec && !spec.imageRepeatable ? roleLabel(spec, index) : `图片${index + 1}`}
              </span>
            </button>
            <button type="button" className="vstudio-media-remove" aria-label={`移除图片 ${index + 1}`}
              onClick={() => props.onRemoveImage(item.previewUrl)}><X size={11} /></button>
          </div>,
        );
      });
    }

    // 参考视频可能有多段：每段一张格子，标签写「视频2」跟 @ 记号对得上
    bucket.videos.forEach((item, index) => {
      const entry = mediaEntries.find((media) => media.key === `video-${index}`);
      if (!entry) return;
      tiles.push(
        <div className="vstudio-media-tile" key={entry.key}>
          <button type="button" className="vstudio-media-open" title={`查看${entry.label}`}
            onClick={(event) => setDetail({ entry, rect: event.currentTarget.getBoundingClientRect() })}>
            <MediaThumb entry={entry} />
            <span className="vstudio-media-tag">{entry.label}</span>
          </button>
          <button type="button" className="vstudio-media-remove" aria-label={`移除${entry.label}`}
            onClick={entry.onRemove}><X size={11} /></button>
        </div>,
      );
    });

    bucket.audios.forEach((item, index) => {
      const entry = mediaEntries.find((media) => media.key === `audio-${index}`);
      if (!entry) return;
      tiles.push(
        <div className="vstudio-media-tile" key={entry.key}>
          <button type="button" className="vstudio-media-open" title={`查看${entry.label}`}
            onClick={(event) => setDetail({ entry, rect: event.currentTarget.getBoundingClientRect() })}>
            <span className="vstudio-audio-bars"><i /><i /><i /><i /></span>
            <span className="vstudio-media-tag">{entry.label}</span>
          </button>
          <button type="button" className="vstudio-media-remove" aria-label={`移除${entry.label}`}
            onClick={entry.onRemove}><X size={11} /></button>
        </div>,
      );
    });

    if (requiredVideoSlot) {
      tiles.push(
        <button
          key="required-video"
          type="button"
          className={`vstudio-slot ${reading ? "is-busy" : ""} ${canUploadVideo ? "" : "is-locked"}`}
          title={canUploadVideo ? "上传参考视频（MP4 / MOV，≤100MB）" : "该渠道未配置上传服务，暂时无法上传参考视频"}
          disabled={!canUploadVideo}
          onClick={() => videoInputRef.current?.click()}
        >
          {reading ? <LoaderCircle className="spin" size={16} /> : <Film size={16} />}
          <span>{canUploadVideo ? "参考视频" : "暂不支持上传"}</span>
        </button>,
      );
    }

    return tiles;
  }

  // 一页能放几张：按可用宽度算，箭头不浮在素材上面（所以先把它们的位置扣掉）
  const tiles = assetTileList();
  // 宽度还没量出来时容量是 Infinity，直接拿去算下标会得到 NaN（0 × Infinity），
  // 切片就成了空数组——素材明明在桶里却一张都不显示。先退回「这一页就是全部」。
  const capacity = assetPageCapacity(stripWidth, addableKinds.length > 0);
  const perPage = Number.isFinite(capacity) ? capacity : Math.max(1, tiles.length);
  const pageCount = assetPageCount(tiles.length, perPage);
  const currentPage = Math.min(assetPage, pageCount - 1);
  const pageTiles = tiles.slice(currentPage * perPage, currentPage * perPage + perPage);

  /**
   * 首尾帧是固定两格的格式：始终并排、不叠、不随悬停展开、不带动画。
   * 其他模式两张以上默认叠成一摞，移进来（或 Tab 进来）摊开盖在正文上。
   *
   * 用负 margin 而不是绝对定位：元素始终是同一个 flex 节点，margin 和 transform
   * 就能平滑过渡，折叠↔展开不会闪一下；整层脱离文档流，正文位置完全不动。
   */
  const fixedSlotsMode = Boolean(fixedSlots);
  const stacked = tiles.length > 1 && !assetsExpanded && !fixedSlotsMode;
  /** 折叠态：素材是左上角一层窄浮层；展开后就地铺开覆盖文字 */
  const folded = showSlots && !assetsExpanded;
  /** 折叠且已有好几张时，大虚线格换成摞旁一个小圆 +（设计图里的样子） */
  const showBigAddSlot = !folded || tiles.length <= 1;

  // 刚加的那张如果落在后一页，展开状态下直接翻过去，不然「传了像没传」。
  // 折叠时那一摞本来就包含全部素材，不翻页：否则一悬停就从「9 张叠着」跳成
  // 只剩末页 2 张，反倒像是素材丢了。
  const previousTileCount = useRef(tiles.length);
  useEffect(() => {
    if (tiles.length > previousTileCount.current && !stacked) setAssetPage(pageCount - 1);
    previousTileCount.current = tiles.length;
  }, [tiles.length, pageCount, stacked]);

  // 折叠的是最近 3 张叠成的一摞，角标写总数；展开后才按页摊成一排，配合两侧箭头翻页。
  // 不把全部素材都叠进去：三张以上再叠只是重复边缘，看不出有几张，角标反而更清楚。
  const shownTiles = stacked ? tiles.slice(-3) : pageTiles;
  const stripTiles = stacked
    ? shownTiles.map((tile, index) => isValidElement(tile)
      ? cloneElement(tile as ReactElement<{ style?: CSSProperties }>, {
        style: { "--tile-i": index } as CSSProperties,
      })
      : tile)
    : shownTiles;

  return (
    <div className="vstudio-composer-wrap">
      <div
        className={`vstudio-composer ${expanded ? "is-expanded" : ""} ${dropActive ? "is-drop-target" : ""} ${promptFocused && keyboardFocus ? "is-kb-focus" : ""}`}
        {...dropProps}
      >
        {fileInputs}

        <div
          className={["vstudio-body", showSlots ? "has-assets" : "", folded ? "is-folded" : ""].filter(Boolean).join(" ")}
          /* 文字左边固定让出的一列：首尾帧两格更宽，两种状态都不变 */
          style={{ "--asset-gutter": fixedSlotsMode ? "190px" : "148px" } as CSSProperties}
          ref={bodyRef}
        >
          {showSlots ? (
            <div
              className={["vstudio-assets", stacked ? "is-stacked" : "", pageCount > 1 ? "has-pages" : ""].filter(Boolean).join(" ")}
              ref={assetsRef}
              /* 只有移出整条素材排才收回：展开后要去点两侧箭头，中途不能收 */
              onMouseLeave={() => setAssetsExpanded(false)}
              onFocusCapture={() => { if (!fixedSlotsMode) setAssetsExpanded(true); }}
              onBlurCapture={(event) => {
                const to = event.relatedTarget as Node | null;
                if (to && event.currentTarget.contains(to)) return;
                // 焦点落空（relatedTarget 为 null）除了真离开，还有一种是焦点元素被禁用/移除：
                // 点「下一页」翻到末页时按钮置灰，浏览器会主动让它失焦。指针还压在素材排上
                // 就不能收——不然「翻页」这个动作本身会把展开的素材排折起来，翻页键当场
                // 消失，没法继续翻。
                if (!to) {
                  try { if (assetsRef.current?.matches(":hover")) return; } catch { /* 选择器不支持就按原逻辑收 */ }
                }
                setAssetsExpanded(false);
              }}
            >
              {/* 入口钉在最左边：翻到后面也随时能加 */}
              {addableKinds.length && showBigAddSlot ? (
                <button
                  key="add"
                  type="button"
                  className="vstudio-slot vstudio-slot-add"
                  title={addableLabel ? `添加参考内容（${addableLabel}）` : "添加参考内容"}
                  aria-label="添加参考内容"
                  onClick={(event) => openAssetPicker(event.currentTarget)}
                >
                  {reading ? <LoaderCircle className="spin" size={16} /> : <ImagePlus size={16} />}
                  <span>参考内容</span>
                </button>
              ) : null}

              {/* 翻页键在素材排两侧，不压住任何一格；第一页只露右边那一个 */}
              {pageCount > 1 ? (
                <button
                  key="prev"
                  type="button"
                  className={`vstudio-asset-more ${currentPage === 0 ? "is-first" : ""}`}
                  aria-label="上一页参考内容"
                  title="上一页"
                  disabled={currentPage === 0}
                  onClick={() => setAssetPage(Math.max(0, currentPage - 1))}
                >
                  <ChevronLeft size={14} />
                </button>
              ) : null}

              <div key="strip" className="vstudio-asset-strip">
                {/* 悬停只认这一摞本身：入口格、空白区、翻页键上悬停都不展开。
                    首尾帧是固定两格，完全不参与展开。 */}
                <div
                  className={["vstudio-asset-stack", stacked ? "is-collapsed" : "", fixedSlotsMode ? "is-fixed-slots" : ""].filter(Boolean).join(" ")}
                  data-count={tiles.length}
                  onMouseEnter={() => { if (!fixedSlotsMode) setAssetsExpanded(true); }}
                >
                  {stripTiles}
                </div>
              </div>

              {pageCount > 1 ? (
                <button
                  key="next"
                  type="button"
                  className="vstudio-asset-more"
                  aria-label="下一页参考内容"
                  title="下一页"
                  disabled={currentPage >= pageCount - 1}
                  onClick={() => setAssetPage(Math.min(pageCount - 1, currentPage + 1))}
                >
                  <ChevronRight size={14} />
                </button>
              ) : null}

            </div>
          ) : null}

          <div className="vstudio-prompt">
            <PromptEditor
              ref={editorRef}
              value={draft.prompt}
              items={mentionItems}
              maxLength={20000}
              placeholder="描述视频内容，输入 @ 引用已上传的图片、视频或音频……"
              onChange={(next) => onDraftChange({ prompt: next })}
              onFocusChange={setPromptFocused}
              onTypedAt={(rect) => {
                // 刚敲下一个 @ 就打开素材列表，接着选一个即可插成 @图片1
                setMentionFromCaret(true);
                setMentionRect(rect);
                setMentionOpen(true);
              }}
              onOpenItem={(item, rect) => setChipDetail({ item, rect })}
            />

            <div className="vstudio-composer-tools">
              <button
                type="button"
                ref={mentionButtonRef}
                className="vstudio-tool"
                aria-haspopup="dialog"
                aria-expanded={mentionOpen}
                aria-label="引用素材"
                title="引用素材：把图片 / 视频 / 音频插进提示词"
                onClick={() => {
                  setModeMenuOpen(false);
                  setParamsOpen(false);
                  setMentionFromCaret(false);
                  setMentionOpen((value) => !value);
                }}
              >
                @
              </button>

              <button
                type="button"
                className="vstudio-tool"
                title={expanded ? "收起输入框" : "展开输入框"}
                aria-label={expanded ? "收起输入框" : "展开输入框"}
                aria-expanded={expanded}
                onClick={() => onExpandedChange(!expanded)}
              >
                {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              </button>
            </div>
          </div>
        </div>

        {/* 提示行预留固定高度：有没有素材、有没有提示都不改变创作框总高度，
            否则加一张图多出一行小字，下方创作记录就被往下挤、卡片被截断 */}
        <div className="vstudio-hints">
          {notice ? <p className="vstudio-hint" role="status">{notice}</p> : null}
          {effectiveModeHint() ? <p className="vstudio-mode-hint">{effectiveModeHint()}</p> : null}
        </div>

        <div className="vstudio-footer">
          {/* 参数是一个点击模块：左边切生成方式，右边点开参数浮层 */}
          <div className="vstudio-bar" role="group" aria-label="生成方式与参数">
            {modes.length ? (
              <button
                type="button"
                ref={modeChipRef}
                className="vstudio-bar-mode"
                aria-haspopup="dialog"
                aria-expanded={modeMenuOpen}
                onClick={() => { setParamsOpen(false); setMentionOpen(false); setModeMenuOpen((value) => !value); }}
              >
                {spec?.label ?? "生成方式"}
                <ChevronDown size={12} />
              </button>
            ) : null}

            <span className="vstudio-bar-split" aria-hidden="true" />

            <button
              type="button"
              ref={paramChipRef}
              className="vstudio-bar-params"
              aria-haspopup="dialog"
              aria-expanded={paramsOpen}
              title="点击修改比例、分辨率、时长、声音等参数"
              onClick={() => { setModeMenuOpen(false); setMentionOpen(false); setParamsOpen((value) => !value); }}
            >
              <span className="vstudio-bar-item">{ratioLabel}</span>
              <span className="vstudio-bar-sep" aria-hidden="true" />
              <span className="vstudio-bar-item">{resolutionLabel}</span>
              <span className="vstudio-bar-sep" aria-hidden="true" />
              <span className="vstudio-bar-item">{durationLabel}</span>
              {audioSupported ? (
                <>
                  <span className="vstudio-bar-sep" aria-hidden="true" />
                  <span className="vstudio-bar-item">{draft.audio ? "有声" : "无声"}</span>
                </>
              ) : null}
              <span className="vstudio-bar-sep" aria-hidden="true" />
              <span className="vstudio-bar-item">1 条</span>
            </button>
          </div>

          {draft.prompt.trim() ? (
            <PromptPolishButton prompt={draft.prompt} target="video" onPolished={(next) => onDraftChange({ prompt: next })}
              onToast={props.onToast} disabled={submitting} />
          ) : null}

          <span className="vstudio-spacer" />

          {channel && !channel.hasKey ? (
            <button type="button" className="vstudio-key-warning" onClick={props.onConfigureChannel}>
              <KeyRound size={13} />填写密钥
            </button>
          ) : null}

          <button
            type="button"
            className="vstudio-send"
            aria-label="提交生成"
            title="提交生成"
            disabled={disabled || !draft.prompt.trim()}
            onClick={props.onGenerate}
          >
            {submitting ? <LoaderCircle className="spin" size={16} /> : <Send size={15} />}
          </button>
        </div>

        {modeMenuOpen && modeStyle ? createPortal(
          <div className="vstudio-panel" ref={modePanelRef} style={modeStyle} role="dialog" aria-label="生成方式">
            <p className="vstudio-panel-title">生成方式</p>
            <div className="vstudio-mode-list">
              {modes.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`vstudio-mode-item ${spec?.id === item.id ? "is-active" : ""}`}
                  onClick={() => { onModeChange(item); setModeMenuOpen(false); }}
                >
                  <strong>{item.label}</strong>
                  <span>{item.hint}</span>
                </button>
              ))}
            </div>
          </div>,
          document.body,
        ) : null}

        {caps ? (
          <VideoParamsPanel
            open={paramsOpen}
            anchor={paramChipRef.current}
            onClose={() => setParamsOpen(false)}
            adapter={adapter}
            model={props.model}
            spec={spec}
            caps={caps}
            draft={draft}
            onChange={onDraftChange}
          />
        ) : null}

        <VideoMentionPanel
          open={mentionOpen}
          anchor={mentionFromCaret ? mentionRect ?? mentionButtonRef.current : mentionButtonRef.current}
          items={mentionItems}
          uploads={uploads}
          onUpload={triggerUpload}
          onClose={() => setMentionOpen(false)}
          onSelect={insertMention}
        />

        {/* 参考内容入口的类型选择：能收几种就给几行，不能传的写明原因 */}
        {assetMenu && assetMenuStyle ? createPortal(
          <div className="vstudio-panel vstudio-asset-add" ref={assetMenuRef} style={assetMenuStyle} role="menu" aria-label="添加参考内容">
            {addableKinds.map((item) => (
              <button
                key={item.kind}
                type="button"
                role="menuitem"
                className="vstudio-mention-upload"
                disabled={item.disabled}
                title={item.hint}
                onClick={() => { setAssetMenu(null); if (!item.disabled) triggerUpload(item.kind); }}
              >
                {item.kind === "图片" ? <ImagePlus size={14} /> : item.kind === "视频" ? <Film size={14} /> : <Music size={14} />}
                <span>{`${item.replace ? "替换" : "添加"}${item.kind}`}</span>
                {item.hint ? <small>{item.hint}</small> : null}
              </button>
            ))}
          </div>,
          document.body,
        ) : null}

        {detail ? (
          <MediaDetail entry={detail.entry} rect={detail.rect} onClose={() => setDetail(null)} />
        ) : null}

        {chipDetail ? (
          <MediaDetail
            entry={{
              key: chipDetail.item.label, label: chipDetail.item.label, kind: chipDetail.item.kind,
              previewUrl: chipDetail.item.previewUrl,
              ...chipMediaMeta(chipDetail.item, bucket),
              onRemove: () => undefined,
            }}
            rect={chipDetail.rect}
            onClose={() => setChipDetail(null)}
          />
        ) : null}
      </div>

      {/* 展开后下方给一个居中的收起键：设计稿里就是这个位置 */}
      {expanded ? (
        <button type="button" className="vstudio-collapse" aria-label="收起提示词框" title="收起" onClick={() => onExpandedChange(false)}>
          <ChevronDown size={15} />
        </button>
      ) : null}
    </div>
  );
}

/** 给「空状态」用的占位：没有渠道时仍显示创作框的骨架，点加号去配置 */
export function VideoComposerPlaceholder({ onAddChannel }: { onAddChannel: () => void }) {
  return (
    <div className="vstudio-composer">
      <textarea className="vstudio-input" readOnly value="" placeholder="先添加一个视频渠道，再开始创作……" />
      <div className="vstudio-footer">
        <div className="vstudio-bar">
          <span className="vstudio-bar-mode is-static"><Upload size={12} />参考生成</span>
          <span className="vstudio-bar-split" aria-hidden="true" />
          <span className="vstudio-bar-params is-static">
            <span className="vstudio-bar-item"><Wand2 size={12} />16:9</span>
            <span className="vstudio-bar-sep" aria-hidden="true" />
            <span className="vstudio-bar-item">720P</span>
            <span className="vstudio-bar-sep" aria-hidden="true" />
            <span className="vstudio-bar-item">MP4</span>
            <span className="vstudio-bar-sep" aria-hidden="true" />
            <span className="vstudio-bar-item">1 条</span>
          </span>
        </div>
        <span className="vstudio-spacer" />
        <button type="button" className="vstudio-send" aria-label="添加渠道" title="添加渠道" onClick={onAddChannel}>
          <Send size={15} />
        </button>
      </div>
    </div>
  );
}
