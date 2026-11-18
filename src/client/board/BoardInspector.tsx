/**
 * 选中节点下方的编辑面板。
 * 所有修改都走 useBoard 的 applyLocal，和画布拖拽共用同一套防抖保存 / 撤销。
 */
import { LoadingIndicator } from "../ui/LoadingIndicator";
import { useCallback, useRef, useState } from "react";
import {
  Activity, ArrowUp, AtSign, AudioLines, Box, ChevronDown, FileText, Image as ImageIcon,
  FolderOpen, Maximize2, Minimize2, MoreHorizontal, Plus, RefreshCw, Send, SlidersHorizontal, Square, Trash2, Upload, Video, X,
} from "lucide-react";
import {
  BOARD_LIMITS, composeConfigPrompt, directInputLinks, directUpstreamImages, directUpstreamText,
  type BoardAudioKind, type BoardEdgeRole, type BoardNode, type BoardView, type ConfigBoardNode,
} from "../../shared/board";
import { TTS_DEFAULT_VOICE, TTS_VOICES } from "../../shared/tts";
import {
  VIDEO_CAPABILITIES, VIDEO_DEFAULTS, VIDEO_MODE_LABELS, videoModeLabel, type VideoAdapter,
} from "../../shared/video-capabilities";
import { OPENAI_SIZE_PRESETS } from "../../shared/image-sizes";
import { CHANNEL_FIELD_SUPPORT, unsupportedLabels } from "../../shared/channel-fields";
import { IMAGE_OUTPUT_FORMATS, type ImageOutputFormat } from "../../shared/image-formats";
import { imageReferenceCountError, imageReferenceLimit } from "../../shared/image-reference-limits";
import { matchModelAlias } from "../../shared/model-alias";
import { CLAUSE_LABELS, readPromptClauses, replacePromptClause } from "../../shared/prompt-clauses";
import type { AdapterType } from "../../shared/types";
import type { Asset } from "../../shared/types";
import { ModelPicker } from "../chat/ModelPicker";
import { StylePresetPicker } from "../chat/StylePresetPicker";
import type { StylePreset } from "../../shared/style-presets";
import { api } from "../api";
import { BoardComposerPopover } from "./BoardComposerPopover";
import { BOARD_CONFIG_MODES } from "./board-config-modes";
import { BoardVideoReferences, type VideoReference } from "./BoardVideoReferences";
import { resolveBoardVideoSelection } from "../../shared/board-video-selection";
import { maxImagesForMode, referenceMediaLimits, supportedVideoModes, videoModeSpec, videoRatioIsAdaptive } from "../../shared/video-modes";
import { boardMentionLabel, removeBoardMention } from "../../shared/board-mentions";
import { PromptEditor, type PromptEditorHandle } from "../video/PromptEditor";
import { VideoMentionPanel, type MentionItem } from "../video/VideoMentionPanel";
import type { PanelAnchorRect } from "../video/useAnchoredPanel";

export interface BoardImageAlias {
  alias: string;
  model: string;
  channelName: string;
  channelId: string;
  adapterType: string;
  localVideoUploadConfigured?: boolean;
}

export type BoardVideoAlias = BoardImageAlias;

const GEMINI_SIZES = ["1K", "2K", "4K"] as const;
const IMAGE_RATIOS = ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9"] as const;
const QUALITIES = [
  { value: "", label: "自动" }, { value: "low", label: "低" },
  { value: "medium", label: "中" }, { value: "high", label: "高" },
];
const VIDEO_MODE_OPTIONS = [
  { value: "", label: "自动（按连线角色）" },
  { value: "text-to-video", label: VIDEO_MODE_LABELS["text-to-video"] },
  { value: "first-frame", label: VIDEO_MODE_LABELS["first-frame"] },
  { value: "first-last-frame", label: VIDEO_MODE_LABELS["first-last-frame"] },
  { value: "reference", label: VIDEO_MODE_LABELS.reference },
] as const;

export function BoardInspector({
  view, node, assets, imageAliases, defaultImageAlias, videoAliases, defaultVideoAlias, submitting = false,
  audioAliases, defaultSpeechAlias, defaultMusicAlias,
  onUpdateNode, onUpdateEdge, onDeleteNode, onPreview, onPickImage, onRemoveAsset,
  onGenerate, onStopTask, onRetryTask, onExtractFrame, onCompareVersions, onClose, onDiagnostic, onNextShot, onBranch,
  onApplyStyle, onConnectReference, onUploadMediaIntoNode, onLocateReference, onRemoveReference, onPickReference,
}: {
  view: BoardView;
  node: BoardNode;
  submitting?: boolean;
  assets: Map<string, Asset>;
  imageAliases: BoardImageAlias[];
  defaultImageAlias: string;
  videoAliases: BoardVideoAlias[];
  defaultVideoAlias: string;
  audioAliases: BoardImageAlias[];
  defaultSpeechAlias: string;
  defaultMusicAlias: string;
  onUpdateNode: (nodeId: string, patch: Partial<BoardNode>) => void;
  onUpdateEdge: (edgeId: string, patch: { role?: BoardEdgeRole | undefined }) => void;
  onDeleteNode: (nodeId: string) => void;
  onPreview: (asset: Asset) => void;
  onPickImage: (nodeId: string) => void;
  onRemoveAsset: (nodeId: string) => void;
  onGenerate: (nodeId: string) => void;
  onStopTask: (taskId: string) => void;
  onRetryTask: (taskId: string) => void;
  onExtractFrame: (nodeId: string) => void;
  onCompareVersions: (nodeId: string) => void;
  onDiagnostic?: (taskId: string) => void;
  onNextShot?: (nodeId: string) => void;
  onBranch?: (nodeId: string) => void;
  /** 套用风格模板；nodeIds 不传 = 整块画布。只用到 id 和 prompt 两个字段 */
  onApplyStyle: (preset: Pick<StylePreset, "id" | "prompt"> | null, nodeIds?: string[]) => void;
  onClose: () => void;
  onConnectReference: (source: BoardNode, targetId: string, role?: BoardEdgeRole) => boolean;
  onUploadMediaIntoNode: (nodeId: string) => void;
  onLocateReference: (nodeId: string) => void;
  onRemoveReference: (edgeId: string) => void;
  onPickReference: (nodeId: string) => void;
}) {
  const [section, setSection] = useState<"assets" | "references" | "style" | "parameters" | "video-mode" | "node" | null>(null);
  const [expanded, setExpanded] = useState(false);
  const assetTriggerRef = useRef<HTMLButtonElement>(null);
  const referenceTriggerRef = useRef<HTMLButtonElement>(null);
  const referenceAnchor = useRef<HTMLButtonElement>(null);
  const promptEditorRef = useRef<PromptEditorHandle>(null);
  const mentionTriggerRef = useRef<HTMLButtonElement>(null);
  const [mentionAnchor, setMentionAnchor] = useState<HTMLElement | PanelAnchorRect | null>(null);
  const closeMentions = useCallback(() => setMentionAnchor(null), []);
  const videoModeTriggerRef = useRef<HTMLButtonElement>(null);
  const styleTriggerRef = useRef<HTMLButtonElement>(null);
  const parameterTriggerRef = useRef<HTMLButtonElement>(null);
  const nodeTriggerRef = useRef<HTMLButtonElement>(null);
  const closeSection = useCallback(() => setSection(null), []);
  const toggleSection = (next: NonNullable<typeof section>) => setSection((current) => current === next ? null : next);
  const toggleVideoReferences = (trigger: HTMLButtonElement) => {
    const sameTrigger = referenceAnchor.current === trigger;
    referenceAnchor.current = trigger;
    setSection((current) => current === "references" && sameTrigger ? null : "references");
  };
  const asset = node.type === "image" || node.type === "video" || node.type === "audio"
    ? (node.assetId ? assets.get(node.assetId) ?? null : null)
    : null;
  const isConfig = node.type === "config";
  const isGenerator = node.type !== "text";
  const taskId = isConfig ? node.lastTaskId : isGenerator ? node.taskId : undefined;
  const mode = node.type === "config" ? node.mode : node.type;
  const isVideo = mode === "video";
  const isText = mode === "text";
  const isAudio = mode === "audio";
  const audioKind: BoardAudioKind = isGenerator ? node.audioKind ?? "speech" : "speech";
  const audioAliasList = audioAliases.filter((alias) =>
    alias.adapterType === (audioKind === "music" ? "suno-music" : "gemini-tts"));
  const upstreamText = isGenerator ? directUpstreamText(view.doc, node.id) : [];
  const upstreamImages = isGenerator ? directUpstreamImages(view.doc, node.id) : [];
  const upstreamLinks = isGenerator ? directInputLinks(view.doc, node.id) : [];
  const aliasList = isVideo ? videoAliases : isAudio ? audioAliasList : imageAliases;
  const defaultAlias = isVideo
    ? defaultVideoAlias
    : isAudio
      ? (audioKind === "music" ? defaultMusicAlias : defaultSpeechAlias)
      : defaultImageAlias;
  const effectiveAliasInfo = isGenerator
    ? matchModelAlias(aliasList, node.model) ?? matchModelAlias(aliasList, defaultAlias) ?? aliasList[0] ?? null
    : null;
  const sizeMode = effectiveAliasInfo?.adapterType === "gemini-content"
    ? "gemini"
    : effectiveAliasInfo?.adapterType === "midjourney"
      ? "none"
      : "size";
  const videoCapability = isVideo
    ? VIDEO_CAPABILITIES[effectiveAliasInfo?.adapterType as VideoAdapter] ?? null
    : null;
  const videoDefaults = VIDEO_DEFAULTS[effectiveAliasInfo?.adapterType ?? ""] ?? { duration: 5, resolution: "720p", audio: false };
  const videoResolutions = videoCapability?.resolutions ?? [videoDefaults.resolution];
  const videoModeOptions = isVideo
    ? VIDEO_MODE_OPTIONS.filter((option) => !option.value
      || supportedVideoModes(effectiveAliasInfo?.adapterType ?? "", effectiveAliasInfo?.model).includes(option.value))
    : VIDEO_MODE_OPTIONS;
  const modelOptions = [
    {
      value: "",
      model: (aliasList.find((item) => item.alias === defaultAlias) ?? aliasList[0])?.model ?? "选择模型",
      channelName: defaultAlias
        ? `默认${isVideo ? "视频" : isAudio ? "音频" : "生图"}模型 ${defaultAlias}`
        : `默认${isVideo ? "视频" : isAudio ? "音频" : "生图"}模型`,
    },
    ...aliasList.map((item) => ({
      value: item.alias,
      model: item.model,
      channelName: item.channelName,
    })),
  ];
  const generateBlocked = isGenerator && !isText && !aliasList.length;
  const effectivePrompt = isGenerator ? composeConfigPrompt(view.doc, node) : "";
  const isImage = mode === "image";
  const imageReferencePolicy = imageReferenceLimit(effectiveAliasInfo?.adapterType, effectiveAliasInfo?.model);
  const imageReferenceError = isImage && effectiveAliasInfo
    ? imageReferenceCountError(effectiveAliasInfo.adapterType, effectiveAliasInfo.model, upstreamImages.length) : undefined;
  const imageCount = node.type === "image" || (node.type === "config" && isImage) ? node.count ?? 1 : 1;
  const imageBatchIds = node.type === "config" ? node.imageBatchResultIds : undefined;
  const runningBatchTasks = imageBatchIds ? view.doc.nodes.flatMap((item) =>
    item.type === "image" && item.status === "loading" && item.taskId && imageBatchIds.includes(item.id) ? [item.taskId] : []) : [];
  const usesMediaReferences = isImage || isVideo;
  const videoSelection = isGenerator && isVideo && effectiveAliasInfo
    ? resolveBoardVideoSelection({ doc: view.doc, config: node, adapterType: effectiveAliasInfo.adapterType, model: effectiveAliasInfo.model, localVideoUploadConfigured: effectiveAliasInfo.localVideoUploadConfigured })
    : undefined;
  const unsupportedConfigInputs = isConfig && (isText || isAudio) && upstreamLinks.some(({ node: source }) =>
    isText ? source.type === "image" || source.type === "video" : source.type !== "text");
  const referenceError = unsupportedConfigInputs ? "请从上方移除当前生成类型不支持的媒体引用。" : imageReferenceError ?? videoSelection?.error;
  const showImageReferenceCount = isImage && effectiveAliasInfo && upstreamImages.length > 0;
  const activeVideoMode = videoSelection?.selection?.mode ?? (isGenerator ? node.videoMode : undefined);
  const modeLabel = activeVideoMode === "motion-control" ? "运动控制"
    : activeVideoMode ? videoModeLabel(activeVideoMode, effectiveAliasInfo?.adapterType) : "自动识别";
  const isMinimaxVideo = effectiveAliasInfo?.adapterType === "minimax-video";
  const boardRatio = isGenerator ? node.aspectRatio ?? node.ratio : undefined;
  const ratioFollowsFrame = isMinimaxVideo && videoRatioIsAdaptive(effectiveAliasInfo.adapterType, effectiveAliasInfo.model, activeVideoMode);
  const needsConcreteRatio = isMinimaxVideo && activeVideoMode === "text-to-video";
  const shownRatio = ratioFollowsFrame ? "adaptive" : needsConcreteRatio && (!boardRatio || boardRatio === "adaptive") ? "16:9" : boardRatio;
  const videoParameterValues = isGenerator && isVideo ? [
    shownRatio === "adaptive" && isMinimaxVideo ? "自适应" : shownRatio || "自动比例",
    node.resolution ?? videoDefaults.resolution,
    `${node.durationSeconds ?? videoDefaults.duration} 秒`,
    ...(videoCapability?.supportsAudio ? [(node.audio ?? videoDefaults.audio) ? "有声" : "无声"] : []),
  ] : [];
  const mediaReferences: VideoReference[] = upstreamLinks.map((link) => {
    const source = link.node;
    const asset = "assetId" in source && source.assetId ? assets.get(source.assetId) : undefined;
    if (source.type === "text") {
      const enabled = isGenerator && node.useUpstreamText !== false && Boolean(source.text.trim());
      return { link, label: enabled ? "文本提示" : "未参与生成", warning: !enabled };
    }
    if (!isVideo && !(isImage && source.type === "image")) return { link, asset, label: "当前类型不使用", warning: true };
    if (!("assetId" in source) || !source.assetId) return { link, label: "未就绪", warning: true };
    if (isImage) return { link, asset, label: "参考图" };
    if (videoSelection?.error) return { link, asset, label: "检查引用", warning: true };
    if (!videoSelection?.selection) return { link, asset, label: "待选模型" };
    const role = videoSelection.selection.inputs.find((input) => input.node.id === source.id)?.role;
    const label = role === "first_frame" ? "首帧" : role === "last_frame" ? "尾帧"
      : source.type === "image" ? "参考图" : source.type === "video" ? "参考视频" : "参考音频";
    return { link, asset, label };
  });
  const mentionItems = mediaReferences.flatMap(({ link, asset, warning }): MentionItem[] => {
    const label = boardMentionLabel(link.node);
    if (!label || !asset || warning) return [];
    const kind = link.node.type === "image" ? "图片" : link.node.type === "video" ? "视频" : "音频";
    return [{ label, kind, previewUrl: kind === "图片" ? api.assetUrl(asset.thumbUrl ?? asset.url) : api.assetUrl(asset.url) }];
  });
  const promptPlaceholder = (isGenerator && !node.prompt?.trim() && effectivePrompt) || (isAudio
    ? (audioKind === "speech" ? "要朗读的正文；留空则只用上游文本" : "风格 / 情绪 / 使用场景；留空则只用上游文本")
    : isVideo ? "描述视频里的动作、镜头和画面变化…" : "描述要生成的内容，或连接上游文本作为提示词");
  const imageFields = CHANNEL_FIELD_SUPPORT[effectiveAliasInfo?.adapterType as AdapterType];
  const supportsImageRatio = Boolean(imageFields?.aspectRatio);
  const imageRatio = isGenerator && supportsImageRatio ? (node.aspectRatio ?? node.ratio ?? "") : "";
  const ratios: readonly string[] = imageRatio && !IMAGE_RATIOS.some((ratio) => ratio === imageRatio)
    ? [...IMAGE_RATIOS, imageRatio] : IMAGE_RATIOS;
  const referenceIds = new Set(upstreamLinks.map(({ node: source }) => source.id));
  const videoAdapter = effectiveAliasInfo?.adapterType;
  const videoModel = effectiveAliasInfo?.model ?? "";
  const videoReferenceSpec = videoModeSpec(videoAdapter, videoModel, videoAdapter === "kling-video" ? "motion-control" : "reference");
  const referenceLimits = referenceMediaLimits(videoAdapter, videoModel, videoReferenceSpec, effectiveAliasInfo?.localVideoUploadConfigured);
  const videoImageLimit = maxImagesForMode(videoAdapter, videoModel, "reference");
  const candidates = section === "references" ? view.doc.nodes.filter((source) => {
    if (source.id === node.id || referenceIds.has(source.id)) return false;
    if (source.type === "text") return Boolean(source.text.trim());
    if (source.type === "config" || !source.assetId) return false;
    if (source.type === "image") return isImage || isVideo;
    return isVideo && (source.type === "video"
      ? referenceLimits.videos > 0
      : (videoAdapter === "wan-video" || videoAdapter === "minimax-video") && referenceLimits.audios > 0);
  }) : [];
  const parameterLabel = !isGenerator || isText ? "参数"
    : isImage ? [
      imageRatio,
      sizeMode === "gemini" ? node.imageSize : sizeMode === "size" ? node.size : undefined,
      `${imageCount} 张`,
    ].filter(Boolean).join(" · ")
      : isVideo ? videoParameterValues.join(" · ")
        : audioKind === "music" ? "音乐参数" : (node.voice ?? TTS_DEFAULT_VOICE);
  const generateLabel = !isGenerator ? "" : node.status === "loading" ? "生成中"
    : !isConfig && node.assetId ? "重新生成" : isVideo ? "生成视频" : isText ? "生成文本"
      : isAudio ? (audioKind === "music" ? "生成音乐" : "生成配音") : "生成图片";

  const changeConfigMode = (nextMode: ConfigBoardNode["mode"]) => {
    if (!isConfig || nextMode === node.mode || submitting || node.status === "loading") return;
    closeSection();
    closeMentions();
    referenceAnchor.current = null;
    // 模型别名和以下参数属于当前生成类型，切换时重新使用新类型的默认值。
    onUpdateNode(node.id, {
      mode: nextMode,
      model: undefined,
      channelId: undefined,
      size: undefined,
      imageSize: undefined,
      quality: undefined,
      videoMode: undefined,
      durationSeconds: undefined,
      resolution: undefined,
      audio: undefined,
      audioKind: "speech",
      voice: undefined,
      ttsStyle: undefined,
      instrumental: undefined,
      lastTaskId: undefined,
      imageBatchResultIds: undefined,
      status: "idle",
      error: undefined,
    });
  };

  return (
    <aside className={`board-inspector${isGenerator ? " board-composer" : ""}${isConfig ? " board-config-composer" : ""}${isVideo ? " vstudio-composer board-video-composer" : ""}${expanded ? " is-expanded" : ""}`} aria-label={isGenerator ? "生成配置" : "节点设置"}>
      {!isGenerator && <header className="board-inspector-head">
        <div>
          <strong>文本设置</strong>
        </div>
        <button type="button" className="icon-button compact" aria-label="关闭节点设置" onClick={onClose}>
          <X size={14} />
        </button>
      </header>}
      {isConfig && <header className="board-config-composer-head">
        <div className="board-config-mode-switch" role="group" aria-label="生成类型">
          {(Object.keys(BOARD_CONFIG_MODES) as ConfigBoardNode["mode"][]).map((kind) => {
            const { label, icon: Icon } = BOARD_CONFIG_MODES[kind];
            return <button key={kind} type="button" aria-pressed={kind === node.mode}
              disabled={submitting || node.status === "loading"} onClick={() => changeConfigMode(kind)}>
              <Icon size={14} />{label}
            </button>;
          })}
        </div>
        <button ref={nodeTriggerRef} type="button" className="board-composer-tool board-config-node-settings"
          aria-label="配置节点设置" title="配置节点设置" aria-expanded={section === "node"} onClick={() => toggleSection("node")}>
          <MoreHorizontal size={18} />
        </button>
      </header>}

      <div className="board-inspector-body">
        {isGenerator ? (
          <>
            <section className="board-composer-editor">
              <div className="board-composer-reference-row">
                <div className="board-composer-reference-list">
                  {isVideo && <button ref={referenceTriggerRef} type="button" className="vstudio-slot board-video-add-reference"
                    aria-expanded={section === "references" && referenceAnchor.current === referenceTriggerRef.current}
                    onClick={(event) => toggleVideoReferences(event.currentTarget)}>
                    <Plus size={16} /><span>参考内容</span>
                  </button>}
                  <BoardVideoReferences entries={mediaReferences} onPreview={onPreview} onLocate={onLocateReference}
                    onRemove={({ edge, node: source }) => {
                      const prompt = removeBoardMention(node.prompt ?? "", source);
                      if (prompt !== (node.prompt ?? "")) onUpdateNode(node.id, { prompt });
                      onRemoveReference(edge.id);
                    }}
                    onChangeRole={isVideo ? (edgeId, role) => onUpdateEdge(edgeId, { role }) : undefined}
                    onOpen={() => { closeSection(); closeMentions(); }} />
                </div>
                {showImageReferenceCount && (
                  <span className={`board-image-reference-quota${imageReferenceError ? " is-warn" : ""}`}
                    title={imageReferencePolicy.source === "default" ? "应用默认参考图上限" : "当前模型的参考图上限"}
                    aria-label={`已引用 ${upstreamImages.length} 张参考图，上限 ${imageReferencePolicy.max} 张`}>
                    <ImageIcon size={12} aria-hidden="true" />
                    <span>{upstreamImages.length}<span className="board-image-reference-quota-separator">/</span>{imageReferencePolicy.max}</span>
                  </span>
                )}
              </div>
              <div className={isVideo ? "board-video-prompt-area vstudio-prompt" : "board-prompt-area"}>
              {usesMediaReferences ? <div className="board-reference-prompt">
                <PromptEditor ref={promptEditorRef} value={node.prompt ?? ""} placeholder={promptPlaceholder}
                  items={mentionItems} onChange={(prompt) => onUpdateNode(node.id, { prompt })}
                  onTypedAt={(rect) => { closeSection(); setMentionAnchor(rect ?? mentionTriggerRef.current); }}
                  onOpenItem={(item) => {
                    const entry = mediaReferences.find(({ link }) => boardMentionLabel(link.node) === item.label);
                    if (entry?.asset) onPreview(entry.asset);
                  }} />
              </div> : <textarea
                className="board-composer-prompt"
                aria-label="提示词"
                rows={3}
                maxLength={20000}
                value={node.prompt ?? ""}
                onChange={(event) => {
                  onUpdateNode(node.id, { prompt: event.target.value } as Partial<BoardNode>);
                }}
                placeholder={promptPlaceholder}
              />}
                <div className={isVideo ? "vstudio-composer-tools" : "board-composer-editor-actions"}>
                  {usesMediaReferences && <button ref={mentionTriggerRef} type="button" className="vstudio-tool" title="在提示词中引用素材"
                    aria-label="引用素材" aria-expanded={Boolean(mentionAnchor)}
                    onClick={(event) => {
                      closeSection();
                      setMentionAnchor(mentionAnchor ? null : event.currentTarget);
                    }}>@</button>}
                  <button type="button" className={isVideo ? "vstudio-tool" : "board-composer-tool"}
                    title={expanded ? "收起提示词" : "展开提示词"} aria-label={expanded ? "收起提示词" : "展开提示词"} aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
                    {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                  </button>
                </div>
              </div>
            </section>
            {usesMediaReferences && <VideoMentionPanel open={Boolean(mentionAnchor)} anchor={mentionAnchor} items={mentionItems}
              imagesOnly={isImage} consumeEscape onClose={closeMentions} onSelect={(label) => {
                promptEditorRef.current?.insertMention(label);
                closeMentions();
              }} />}
            {section === "assets" && !isConfig && <BoardComposerPopover anchor={assetTriggerRef.current} label="素材" width={220} onClose={closeSection}>
              <div className="board-composer-menu">
                {node.type === "image" && <button type="button" onClick={() => { closeSection(); onUploadMediaIntoNode(node.id); }}>
                  <Upload size={15} />上传本地图片
                </button>}
                <button type="button" onClick={() => { closeSection(); onPickImage(node.id); }}>
                  <FolderOpen size={15} />从资源库选择
                </button>
                {node.type === "image" && <button type="button" onClick={() => setSection("references")}>
                  <ImageIcon size={15} />画布参考
                </button>}
              </div>
            </BoardComposerPopover>}
            {section === "node" && isConfig && <BoardComposerPopover anchor={nodeTriggerRef.current} label="配置节点设置" width={252} onClose={closeSection}>
              <div className="board-inspector-more-body">
                <label className="board-field">
                  <span>节点名称</span>
                  <input value={node.title} maxLength={80} onChange={(event) => onUpdateNode(node.id, { title: event.target.value })} placeholder="配置节点" />
                </label>
                <label className="board-config-check">
                  <input type="checkbox" checked={node.useUpstreamText !== false}
                    onChange={(event) => onUpdateNode(node.id, { useUpstreamText: event.target.checked })} />
                  拼接上游文本
                </label>
                <button type="button" className="secondary-button compact is-danger" onClick={() => onDeleteNode(node.id)}>
                  <Trash2 size={12} />删除节点
                </button>
              </div>
            </BoardComposerPopover>}
            {section === "references" && <BoardComposerPopover anchor={node.type === "image" ? assetTriggerRef.current : referenceAnchor.current ?? referenceTriggerRef.current} label={isVideo || isConfig ? "添加输入" : "画布引用"} onClose={closeSection}>
              <div className="board-inspector-more-body">
                {(isVideo || (isConfig && isImage)) && <div className="board-inspector-actions">
                  <button type="button" className="secondary-button compact" onClick={() => { closeSection(); onPickReference(node.id); }}>
                    <FolderOpen size={14} />本地上传或资源库
                  </button>
                </div>}
                <section className="board-inspector-section">
                  <div className="board-inspector-label"><span>引用画布节点</span></div>
                  {candidates.length ? (
                    <div className="board-composer-menu board-composer-reference-options">
                      {candidates.map((source) => {
                        const Icon = source.type === "text" ? FileText : source.type === "video" ? Video : source.type === "audio" ? AudioLines : ImageIcon;
                        return <button key={source.id} type="button" onClick={() => {
                          if (onConnectReference(source, node.id, source.type === "text" ? "text" : isVideo ? undefined : "reference")) {
                            closeSection();
                            (node.type === "image" ? assetTriggerRef.current : referenceTriggerRef.current)?.focus({ preventScroll: true });
                          }
                        }}>
                          <Icon size={15} />
                          <span>{source.title || (source.type === "text" ? source.text : source.ref)}</span>
                          <small>{source.ref}</small>
                          <Plus size={14} />
                        </button>;
                      })}
                    </div>
                  ) : <p className="board-inspector-hint">没有可添加的画布节点</p>}
                </section>
                {!isVideo && (node.type === "image" || node.type === "video" || node.type === "audio") ? (
                  <section className="board-inspector-section">
                    <div className="board-inspector-actions">
                      {asset ? (
                        <button type="button" className="secondary-button compact" onClick={() => onPreview(asset)}>预览</button>
                      ) : null}
                      {asset && node.type === "video" ? <button type="button" className="secondary-button compact" onClick={() => onExtractFrame(node.id)}>提取尾帧</button> : null}
                      {asset && node.type === "video" && onNextShot ? <button type="button" className="secondary-button compact" onClick={() => onNextShot(node.id)}>用尾帧创建下一镜</button> : null}
                      {asset && node.type === "image" && onBranch ? <button type="button" className="secondary-button compact" onClick={() => onBranch(node.id)}>从此结果建分支</button> : null}
                      {asset ? <button type="button" className="secondary-button compact" onClick={() => onCompareVersions(node.id)}>版本对比</button> : null}
                      <button type="button" className="secondary-button compact" onClick={() => onPickImage(node.id)}>
                        <Upload size={12} />{asset ? "替换素材" : "选择素材"}
                      </button>
                      {node.assetId ? (
                        <button type="button" className="secondary-button compact" onClick={() => onRemoveAsset(node.id)}>
                          <X size={12} />移除
                        </button>
                      ) : null}
                    </div>
                    {asset ? <p className="board-inspector-hint">{asset.fileName}</p> : null}
                  </section>
                ) : null}

                {!isConfig && !isVideo && <section className="board-inspector-section">
                  <div className="board-inspector-label">
                    <span>上游</span>
                    <em>
                      {upstreamText.length} 段文本 · {upstreamImages.length} 张图
                    </em>
                  </div>
                  <div className="board-inspector-chips">
                    {upstreamText.map((item) => (
                      <span key={item.id} className="board-chip is-text">{item.title || item.ref}</span>
                    ))}
                    {upstreamImages.map((item) => (
                      <span key={item.id} className="board-chip is-image">{item.title || item.ref}</span>
                    ))}
                    {!upstreamText.length && !upstreamImages.length ? (
                      <span className="board-inspector-hint">把文本 / 图片节点连到配置节点的左侧端口。</span>
                    ) : null}
                    {(isText || isAudio) && upstreamImages.length ? (
                      <span className="board-inspector-hint is-warn">
                        {isText ? "生文本" : "生音频"}只使用文本上游；图片连线会被服务端拒绝。
                      </span>
                    ) : null}
                  </div>
                </section>}
                {!isConfig && <><label className="board-config-check">
                  <input
                    type="checkbox"
                    checked={node.useUpstreamText !== false}
                    onChange={(event) => onUpdateNode(node.id, { useUpstreamText: event.target.checked } as Partial<BoardNode>)}
                  />
                  拼接上游文本
                </label>
                <section className="board-inspector-section">
                  <label className="board-field">
                    <span>名称</span>
                    <input
                      value={node.title}
                      maxLength={80}
                      onChange={(event) => {
                        onUpdateNode(node.id, { title: event.target.value } as Partial<BoardNode>);
                      }}
                      placeholder="节点名称"
                    />
                  </label>
                </section>

                {node.type !== "video" && <button type="button" className="secondary-button compact is-danger" onClick={() => onDeleteNode(node.id)}>
                  <Trash2 size={12} />删除节点
                </button>}</>}
              </div>
            </BoardComposerPopover>}
            {section === "style" && isImage && <BoardComposerPopover anchor={styleTriggerRef.current} label="风格" width={320} onClose={closeSection}>
              <div className="board-inspector-more-body">
                <StylePresetPicker value={node.stylePresetId ?? ""} onChange={(preset) => onApplyStyle(preset, [node.id])} presentation="buttons" />
                {node.styleSuffix && <button type="button" className="secondary-button compact" onClick={() => onApplyStyle({ id: node.stylePresetId ?? "", prompt: node.styleSuffix! })}>套用到整块画布</button>}
              </div>
            </BoardComposerPopover>}
            {section === "video-mode" && isVideo && <BoardComposerPopover anchor={videoModeTriggerRef.current} label="生成方式" width={268} onClose={closeSection}>
              <div className="board-composer-menu">
                {videoModeOptions.map((option) => (
                  <button key={option.value || "auto"} type="button" aria-pressed={(node.videoMode ?? "") === option.value}
                    onClick={() => {
                      onUpdateNode(node.id, { videoMode: option.value || undefined });
                      closeSection();
                      videoModeTriggerRef.current?.focus({ preventScroll: true });
                    }}>
                    {option.label}
                  </button>
                ))}
              </div>
            </BoardComposerPopover>}
            {section === "parameters" && <BoardComposerPopover anchor={parameterTriggerRef.current} label="生成参数" onClose={closeSection}>
              <div className="board-inspector-more-body">
                {isImage && <fieldset className="board-parameter-group">
                  <legend>生成张数</legend>
                  <div className="board-parameter-choices">
                    {Array.from({ length: BOARD_LIMITS.maxCount }, (_, index) => index + 1).map((count) => (
                      <button key={count} type="button" aria-pressed={imageCount === count} disabled={node.status === "loading"}
                        onClick={() => onUpdateNode(node.id, { count })}>{count} 张</button>
                    ))}
                  </div>
                  {imageCount > 1 && <p className="board-inspector-hint">提交 {imageCount} 次独立请求，每次生成一份结果。</p>}
                </fieldset>}
                <section className="board-inspector-section">
                  {isText ? (
                    <>
                      <div className="board-inspector-label">
                        <span>文本模型</span>
                        <em>跟随无限画布助手</em>
                      </div>
                      <p className="board-inspector-hint">
                        生文本使用创建无限画布时选中的对话模型，直接写进右侧新的文本节点。
                      </p>
                    </>
                  ) : (
                    <>
                  {!isImage && <div className="board-inspector-label">
                    <span>{isVideo ? "视频模型" : isAudio ? "音频选项" : "图像选项"}</span>
                    <em>{effectiveAliasInfo ? effectiveAliasInfo.channelName : "默认"}</em>
                  </div>}
                  {isVideo && !videoAliases.length ? (
                    <p className="board-inspector-hint is-warn">还没有可用的视频渠道。先到「模型配置」添加一个，再回来生成视频。</p>
                  ) : null}
                  {isAudio && !audioAliasList.length ? (
                    <p className="board-inspector-hint is-warn">
                      还没有可用的{audioKind === "music" ? "音乐" : "语音"}渠道。先到「模型配置」添加一个。
                    </p>
                  ) : null}
                  {isAudio ? (
                    <label className="board-field">
                      <span>音频类型</span>
                      <select
                        value={audioKind}
                        onChange={(event) => {
                          const nextKind = event.target.value as BoardAudioKind;
                          onUpdateNode(node.id, {
                            audioKind: nextKind,
                            model: undefined,
                            channelId: undefined,
                            voice: undefined,
                            ttsStyle: undefined,
                            instrumental: undefined,
                          } as Partial<BoardNode>);
                        }}
                      >
                        <option value="speech">配音 / 朗读</option>
                        <option value="music">音乐</option>
                      </select>
                    </label>
                  ) : null}

                  {isVideo && videoCapability ? <p className="board-inspector-hint">
                    {videoCapability.label} · {videoCapability.durations.min}–{videoCapability.durations.max} 秒
                    {videoImageLimit > 0 ? ` · 参考图最多 ${videoImageLimit} 张` : ""}
                    {referenceLimits.videos > 0 ? ` · 参考视频最多 ${referenceLimits.videos} 段` : ""}
                    {videoReferenceSpec?.acceptsReferenceVideo && effectiveAliasInfo?.localVideoUploadConfigured === false ? " · 参考视频需配置素材上传服务" : ""}
                  </p> : null}
                  {isAudio ? (
                    <>
                      {audioKind === "speech" ? (
                        <>
                          <label className="board-field">
                            <span>音色</span>
                            <select
                              value={node.voice ?? TTS_DEFAULT_VOICE}
                              onChange={(event) => onUpdateNode(node.id, { voice: event.target.value } as Partial<BoardNode>)}
                            >
                              {TTS_VOICES.map((voice) => <option key={voice} value={voice}>{voice}</option>)}
                            </select>
                          </label>
                          <label className="board-field">
                            <span>语气 / 风格（可选）</span>
                            <input
                              value={node.ttsStyle ?? ""}
                              maxLength={200}
                              placeholder="例如：温柔、放慢，像在讲睡前故事"
                              onChange={(event) => onUpdateNode(node.id, { ttsStyle: event.target.value || undefined } as Partial<BoardNode>)}
                            />
                          </label>
                          <p className="board-inspector-hint">提示词区域就是配音正文；一次生成 1 段音频。</p>
                        </>
                      ) : (
                        <>
                          <label className="board-config-check">
                            <input
                              type="checkbox"
                              checked={node.instrumental ?? false}
                              onChange={(event) => onUpdateNode(node.id, { instrumental: event.target.checked } as Partial<BoardNode>)}
                            />
                            只要纯音乐，不要人声
                          </label>
                          <label className="board-field">
                            <span>歌名（可选）</span>
                            <input
                              value={node.musicTitle ?? ""}
                              maxLength={80}
                              placeholder="不填由上游自动命名"
                              onChange={(event) => onUpdateNode(node.id, { musicTitle: event.target.value || undefined } as Partial<BoardNode>)}
                            />
                          </label>
                          <label className="board-field">
                            <span>曲风标签（可选）</span>
                            <input
                              value={node.musicTags ?? ""}
                              maxLength={1000}
                              placeholder="例如：city pop, rainy night, female vocal"
                              onChange={(event) => onUpdateNode(node.id, { musicTags: event.target.value || undefined } as Partial<BoardNode>)}
                            />
                          </label>
                          <label className="board-field">
                            <span>排除曲风（可选）</span>
                            <input
                              value={node.musicNegativeTags ?? ""}
                              maxLength={1000}
                              placeholder="例如：heavy metal, rap"
                              onChange={(event) => onUpdateNode(node.id, { musicNegativeTags: event.target.value || undefined } as Partial<BoardNode>)}
                            />
                          </label>
                          <p className="board-inspector-hint">
                            提示词写风格 / 情绪 / 使用场景；Suno 一次可能返回 2 首，配置节点会拆成两张结果卡，媒体节点显示第一首。
                          </p>
                        </>
                      )}
                    </>
                  ) : isVideo ? (
                    <>
                      <div className="board-inspector-grid">
                        <label className="board-field">
                          <span>时长（秒）</span>
                          <input
                            type="number"
                            min={videoCapability?.durations.min ?? 1}
                            max={videoCapability?.durations.max ?? 30}
                            value={node.durationSeconds ?? videoDefaults.duration}
                            onChange={(event) => {
                              const value = Number(event.target.value);
                              onUpdateNode(node.id, {
                                durationSeconds: Number.isFinite(value)
                                  ? Math.min(videoCapability?.durations.max ?? 30, Math.max(videoCapability?.durations.min ?? 1, value))
                                  : undefined,
                              } as Partial<BoardNode>);
                            }}
                          />
                        </label>
                        <label className="board-field">
                          <span>分辨率</span>
                          <select
                            value={node.resolution ?? videoDefaults.resolution}
                            onChange={(event) => onUpdateNode(node.id, { resolution: event.target.value } as Partial<BoardNode>)}
                          >
                            {videoResolutions.map((value) => <option key={value} value={value}>{value}</option>)}
                          </select>
                        </label>
                      </div>
                      {videoCapability?.nativeAudio ? <p className="board-inspector-hint">输出包含模型原生音频</p> : null}
                      {videoCapability?.supportsAudio ? (
                        <label className="board-config-check">
                          <input
                            type="checkbox"
                            checked={node.audio ?? videoDefaults.audio}
                            onChange={(event) => onUpdateNode(node.id, { audio: event.target.checked } as Partial<BoardNode>)}
                          />
                          生成音频
                        </label>
                      ) : null}
                      <details className="board-advanced">
                        <summary>高级参数</summary>
                        {(() => {
                          const clauses = readPromptClauses("prompt" in node ? node.prompt ?? "" : "");
                          const labels = CLAUSE_LABELS.filter((label) => clauses[label]);
                          if (!labels.length) return null;
                          return (
                            <div className="board-clause-row">
                              {labels.map((label) => (
                                <label key={`${label}-${clauses[label]}`} className="board-field">
                                  <span>{label}</span>
                                  <input
                                    defaultValue={clauses[label]}
                                    onBlur={(event) => {
                                      const next = event.target.value.trim();
                                      if (next === clauses[label]) return;
                                      if (!("prompt" in node)) return;
                                      onUpdateNode(node.id, { prompt: replacePromptClause(node.prompt ?? "", label, next) } as Partial<BoardNode>);
                                    }}
                                    onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                                  />
                                </label>
                              ))}
                            </div>
                          );
                        })()}
                        <div className="board-inspector-grid">
                          {!isMinimaxVideo ? <label className="board-field">
                            <span>随机种子（可选）</span>
                            <input
                              type="number"
                              min={0}
                              value={node.seed ?? ""}
                              placeholder="不填随机"
                              onChange={(event) => onUpdateNode(node.id, {
                                seed: event.target.value === "" ? undefined : Math.max(0, Math.floor(Number(event.target.value))),
                              } as Partial<BoardNode>)}
                            />
                          </label> : null}
                          <label className="board-field">
                            <span>画幅比例（可选）</span>
                            <select
                              // 只存 aspectRatio：万相 / Seedance 的 ratio 由适配器按渠道自动转，
                              // 界面不再需要记住「这个渠道用哪个字段名」
                              value={shownRatio ?? ""}
                              disabled={ratioFollowsFrame}
                              onChange={(event) => {
                                const value = event.target.value || undefined;
                                onUpdateNode(node.id, { aspectRatio: value, ratio: undefined } as Partial<BoardNode>);
                              }}
                            >
                              {!ratioFollowsFrame && !needsConcreteRatio ? <option value="">自动</option> : null}
                              {(videoCapability?.aspectRatios ?? []).filter((value) => (!ratioFollowsFrame || value === "adaptive") && (!needsConcreteRatio || value !== "adaptive")).map((value) => (
                                <option key={value} value={value}>{value === "adaptive" ? "自适应" : value}</option>
                              ))}
                            </select>
                          </label>
                        </div>
                        {!isMinimaxVideo ? (
                          <>
                            <label className="board-config-check">
                              <input
                                type="checkbox"
                                checked={node.promptExtend ?? true}
                                onChange={(event) => onUpdateNode(node.id, { promptExtend: event.target.checked } as Partial<BoardNode>)}
                              />
                              允许模型扩写提示词
                            </label>
                            <label className="board-config-check">
                              <input
                                type="checkbox"
                                checked={node.watermark ?? false}
                                onChange={(event) => onUpdateNode(node.id, { watermark: event.target.checked } as Partial<BoardNode>)}
                              />
                              生成水印
                            </label>
                          </>
                        ) : null}
                      </details>
                    </>
                  ) : (
                    <>
                      {(() => {
                        const ignored = unsupportedLabels((effectiveAliasInfo?.adapterType ?? "") as AdapterType, {
                          negativePrompt: node.negativePrompt,
                          aspectRatio: node.aspectRatio,
                          ratio: node.ratio,
                          duration: node.durationSeconds,
                          resolution: node.resolution,
                          audio: node.audio,
                          seed: node.seed,
                          watermark: node.watermark,
                          size: node.size,
                          imageSize: node.imageSize,
                          quality: node.quality,
                          style: node.style,
                          background: node.background,
                          outputFormat: node.outputFormat,
                          moderation: node.moderation,
                        });
                        return ignored.length
                          ? <p className="board-inspector-hint">当前渠道会忽略：{ignored.join("、")}</p>
                          : null;
                      })()}
                      {sizeMode === "gemini" && (
                        <fieldset className="board-parameter-group">
                          <legend>清晰度</legend>
                          <div className="board-parameter-choices">
                            {(["", ...GEMINI_SIZES] as const).map((value) => (
                              <button key={value} type="button" aria-pressed={(node.imageSize ?? "") === value}
                                onClick={() => onUpdateNode(node.id, { imageSize: value || undefined, size: undefined })}>
                                {value || "自动"}
                              </button>
                            ))}
                          </div>
                        </fieldset>
                      )}
                      {imageFields?.size && (
                        <label className="board-field">
                          <span>输出尺寸</span>
                          <input list="board-image-sizes" value={node.size ?? ""} placeholder="自动，或输入宽 × 高"
                            onChange={(event) => onUpdateNode(node.id, { size: event.target.value || undefined, imageSize: undefined })} />
                          <datalist id="board-image-sizes">
                            {OPENAI_SIZE_PRESETS.map((value) => <option key={value} value={value} />)}
                          </datalist>
                        </label>
                      )}
                      {imageFields?.quality && (
                        <fieldset className="board-parameter-group">
                          <legend>质量</legend>
                          <div className="board-parameter-choices">
                            {QUALITIES.map(({ value, label }) => (
                              <button key={value} type="button" aria-pressed={(node.quality === "auto" ? "" : node.quality ?? "") === value}
                                onClick={() => onUpdateNode(node.id, { quality: value || undefined })}>
                                {label}
                              </button>
                            ))}
                          </div>
                        </fieldset>
                      )}
                      {supportsImageRatio && (
                        <fieldset className="board-parameter-group">
                          <legend>比例</legend>
                          <div className="board-parameter-ratios">
                            {[...ratios, ""].map((ratio) => {
                              const [width, height] = ratio.split(":").map(Number);
                              const scale = 16 / Math.max(width, height);
                              return (
                                <button key={ratio} type="button" aria-pressed={imageRatio === ratio}
                                  onClick={() => onUpdateNode(node.id, { aspectRatio: ratio || undefined, ratio: undefined })}>
                                  <span className="board-parameter-ratio-icon" aria-hidden="true">
                                    <i style={width > 0 && height > 0 ? { width: width * scale, height: height * scale } : undefined} />
                                  </span>
                                  {ratio || "自动"}
                                </button>
                              );
                            })}
                          </div>
                        </fieldset>
                      )}
                      <details className="board-advanced">
                        <summary>高级参数</summary>
                        {(() => {
                          const clauses = readPromptClauses("prompt" in node ? node.prompt ?? "" : "");
                          const labels = CLAUSE_LABELS.filter((label) => clauses[label]);
                          if (!labels.length) return null;
                          return (
                            <div className="board-clause-row">
                              {labels.map((label) => (
                                <label key={`${label}-${clauses[label]}`} className="board-field">
                                  <span>{label}</span>
                                  <input
                                    defaultValue={clauses[label]}
                                    onBlur={(event) => {
                                      const next = event.target.value.trim();
                                      if (next === clauses[label]) return;
                                      if (!("prompt" in node)) return;
                                      onUpdateNode(node.id, { prompt: replacePromptClause(node.prompt ?? "", label, next) } as Partial<BoardNode>);
                                    }}
                                    onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
                                  />
                                </label>
                              ))}
                            </div>
                          );
                        })()}
                        <label className="board-field">
                          <span>负向提示词（可选）</span>
                          <textarea
                            rows={3}
                            maxLength={2000}
                            value={node.negativePrompt ?? ""}
                            placeholder="不希望出现的元素，例如：文字、水印、多余手指"
                            onChange={(event) => onUpdateNode(node.id, { negativePrompt: event.target.value || undefined } as Partial<BoardNode>)}
                          />
                        </label>
                        <div className="board-inspector-grid">
                          {supportsImageRatio && <label className="board-field">
                            <span>自定义比例</span>
                            <input value={imageRatio} maxLength={20} placeholder="例如 3:2"
                              onChange={(event) => onUpdateNode(node.id, { aspectRatio: event.target.value || undefined, ratio: undefined })} />
                          </label>}
                          <label className="board-field">
                            <span>随机种子（可选）</span>
                            <input
                              type="number"
                              min={0}
                              value={node.seed ?? ""}
                              placeholder="不填随机"
                              onChange={(event) => onUpdateNode(node.id, {
                                seed: event.target.value === "" ? undefined : Math.max(0, Math.floor(Number(event.target.value))),
                              } as Partial<BoardNode>)}
                            />
                          </label>
                          <label className="board-field">
                            <span>风格</span>
                            <select
                              value={node.style ?? ""}
                              onChange={(event) => onUpdateNode(node.id, {
                                style: event.target.value ? event.target.value as "auto" | "vivid" | "natural" : undefined,
                              } as Partial<BoardNode>)}
                            >
                              <option value="">自动</option>
                              <option value="vivid">vivid</option>
                              <option value="natural">natural</option>
                              <option value="auto">auto</option>
                            </select>
                          </label>
                          <label className="board-field">
                            <span>背景</span>
                            <select
                              value={node.background ?? ""}
                              onChange={(event) => onUpdateNode(node.id, {
                                background: event.target.value ? event.target.value as "auto" | "opaque" | "transparent" : undefined,
                              } as Partial<BoardNode>)}
                            >
                              <option value="">自动</option>
                              <option value="transparent">透明</option>
                              <option value="opaque">不透明</option>
                              <option value="auto">auto</option>
                            </select>
                          </label>
                          <label className="board-field">
                            <span>输出格式</span>
                            <select
                              value={node.outputFormat ?? ""}
                              onChange={(event) => onUpdateNode(node.id, {
                                outputFormat: event.target.value ? event.target.value as ImageOutputFormat : undefined,
                              } as Partial<BoardNode>)}
                            >
                              <option value="">自动</option>
                              {IMAGE_OUTPUT_FORMATS.map(format => (
                                <option key={format} value={format}>{format === "jpeg" ? "JPEG" : format.toUpperCase()}</option>
                              ))}
                            </select>
                          </label>
                          <label className="board-field">
                            <span>审核级别</span>
                            <select
                              value={node.moderation ?? ""}
                              onChange={(event) => onUpdateNode(node.id, {
                                moderation: event.target.value ? event.target.value as "auto" | "low" : undefined,
                              } as Partial<BoardNode>)}
                            >
                              <option value="">自动</option>
                              <option value="low">low</option>
                              <option value="auto">auto</option>
                            </select>
                          </label>
                        </div>
                        <p className="board-inspector-hint">不同渠道支持度不同：不支持的高级参数会被适配器忽略。</p>
                      </details>
                    </>
                  )}
                    </>
                  )}
                </section>

                {!isConfig && <section className={`board-inspector-section ${isVideo || isText ? "" : "board-inspector-grid"}`}>
                    <label className="board-field">
                      <span>类型</span>
                      <input
                        value={isVideo ? "视频（就地生成）" : isAudio ? (audioKind === "music" ? "音乐（就地生成）" : "配音（就地生成）") : "图片（就地生成）"}
                        readOnly
                      />
                    </label>
                </section>}
              </div>
            </BoardComposerPopover>}
          </>
        ) : (
          <>
            <section className="board-inspector-section">
              <label className="board-field">
                <span>名称</span>
                <input
                  value={node.title}
                  maxLength={80}
                  onChange={(event) => {
                    onUpdateNode(node.id, { title: event.target.value } as Partial<BoardNode>);
                  }}
                  placeholder="节点名称"
                />
              </label>
            </section>

            <section className="board-inspector-section">
              <label className="board-field">
                <span>文本</span>
                <textarea
                  rows={12}
                  maxLength={20000}
                  value={node.text}
                  onChange={(event) => {
                    onUpdateNode(node.id, { text: event.target.value } as Partial<BoardNode>);
                  }}
                  placeholder="写提示词、文案或说明…"
                />
              </label>
              <p className="board-inspector-hint">{node.text.length} / 20000 字</p>
            </section>
          </>
        )}
      </div>

      <footer className="board-inspector-foot">
        {isGenerator ? (
          <>
            {referenceError || node.error ? <p className="board-config-error" title={referenceError ?? node.error}>{referenceError ?? node.error}</p> : null}
            <div className={`board-inspector-actions board-inspector-generate-actions${isVideo ? " vstudio-footer" : ""}`}>
              {!isConfig && !isVideo && <button ref={assetTriggerRef} type="button" className="board-composer-tool" aria-expanded={section === "assets" || (node.type === "image" && section === "references")} disabled={node.status === "loading"} onClick={() => {
                if (node.type === "image" && section === "references") closeSection();
                else toggleSection("assets");
              }}>
                <Plus size={16} /><span>素材</span>
              </button>}
              {!isVideo && isConfig && <button ref={referenceTriggerRef} type="button" className="board-composer-tool"
                aria-expanded={section === "references"} onClick={() => toggleSection("references")}>
                <Plus size={16} /><span>添加输入</span>
              </button>}
              {!isVideo && !isConfig && node.type !== "image" && <button ref={referenceTriggerRef} type="button" className="board-composer-tool" title="画布引用与节点操作" aria-label="画布引用与节点操作" aria-expanded={section === "references"} onClick={() => toggleSection("references")}>
                <AtSign size={15} /><span>引用{upstreamLinks.length > 0 && ` ${upstreamLinks.length}`}</span>
              </button>}
              {isImage && <button ref={styleTriggerRef} type="button" className="board-composer-tool" aria-expanded={section === "style"} onClick={() => toggleSection("style")}><Box size={15} /><span>风格</span><ChevronDown size={12} /></button>}
              {!isText ? (
                <ModelPicker
                  className="board-model-picker"
                  menuClassName="board-model-menu"
                  onOpen={closeSection}
                  options={modelOptions}
                  value={aliasList.some((item) => item.alias === node.model) ? node.model! : ""}
                  kind={isAudio ? "audio" : isVideo ? "video" : "image"}
                  menuPlacement="up"
                  onChange={(value) => {
                    const alias = aliasList.find((item) => item.alias === value);
                    onUpdateNode(node.id, {
                      model: value || undefined,
                      channelId: alias?.channelId,
                      size: undefined,
                      imageSize: undefined,
                      quality: undefined,
                      videoMode: undefined,
                      durationSeconds: undefined,
                      resolution: undefined,
                      audio: undefined,
                      voice: undefined,
                      ttsStyle: undefined,
                      instrumental: undefined,
                    } as Partial<BoardNode>);
                  }}
                  ariaLabel={isAudio ? "无限画布音频模型" : isVideo ? "无限画布视频模型" : "无限画布生图模型"}
                />
              ) : null}
              {isVideo ? <div className="vstudio-bar" role="group" aria-label="生成方式与参数">
                <button ref={videoModeTriggerRef} type="button" className="vstudio-bar-mode"
                  aria-label={`生成方式：${modeLabel}`} aria-expanded={section === "video-mode"} onClick={() => toggleSection("video-mode")}>
                  {modeLabel}<ChevronDown size={12} />
                </button>
                <span className="vstudio-bar-split" aria-hidden="true" />
                <button ref={parameterTriggerRef} type="button" className="vstudio-bar-params"
                  aria-label={`生成参数：${parameterLabel}`} title={parameterLabel} aria-expanded={section === "parameters"} onClick={() => toggleSection("parameters")}>
                  {videoParameterValues.map((value, index) => <span className="vstudio-bar-item" key={value}>
                    {index > 0 && <span className="vstudio-bar-sep" aria-hidden="true" />}{value}
                  </span>)}
                </button>
              </div> : <button ref={parameterTriggerRef} type="button" className="board-composer-tool board-composer-parameters" aria-label={`生成参数：${parameterLabel}`} title="生成参数" aria-expanded={section === "parameters"} onClick={() => toggleSection("parameters")}>
                <SlidersHorizontal size={15} /><span>{parameterLabel}</span><ChevronDown size={12} />
              </button>}
              <span className="board-composer-spacer" />
              {node.status === "loading" && (imageBatchIds ? runningBatchTasks.length > 0 : Boolean(taskId)) ? (
                <button type="button" className="board-composer-tool" onClick={() => {
                  if (imageBatchIds) runningBatchTasks.forEach(onStopTask);
                  else if (taskId) onStopTask(taskId);
                }}>
                  <Square size={13} />停止
                </button>
              ) : null}
              {!imageBatchIds && (node.status === "failed" || node.status === "cancelled") && taskId ? (
                <button type="button" className="board-composer-tool" onClick={() => onRetryTask(taskId)}>
                  <RefreshCw size={12} />重试
                </button>
              ) : null}
              {taskId && onDiagnostic && node.status === "failed" ? <button type="button" className="board-composer-tool" onClick={() => onDiagnostic(taskId)}><Activity size={13} />诊断</button> : null}
              <button
                type="button"
                className={isConfig ? "board-composer-send board-config-send" : isVideo ? "vstudio-send" : "board-composer-send"}
                aria-label={generateLabel}
                disabled={submitting || node.status === "loading" || generateBlocked || !effectivePrompt || Boolean(referenceError)}
                title={submitting ? "正在提交生成…" : node.status === "loading"
                  ? "正在生成…"
                  : generateBlocked
                    ? (isAudio ? "还没有可用的音频渠道" : isVideo ? "还没有可用的视频渠道" : "还没有可用的生图渠道")
                    : referenceError ?? (!effectivePrompt ? "先填写提示词，或启用拼接上游文本" : generateLabel)}
                onClick={() => onGenerate(node.id)}
              >
                {node.status === "loading" ? <LoadingIndicator variant="dots" size={24} /> : isVideo ? <Send size={15} /> : <ArrowUp size={18} />}
                {isConfig && <span>{generateLabel}</span>}
              </button>
            </div>
          </>
        ) : (
          <button type="button" className="secondary-button compact is-danger" onClick={() => onDeleteNode(node.id)}>
            <Trash2 size={12} />删除节点
          </button>
        )}
      </footer>
    </aside>
  );
}
