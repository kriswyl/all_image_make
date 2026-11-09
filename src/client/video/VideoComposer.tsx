import { useRef, useState } from "react";
import type { HTMLAttributes } from "react";
import {
  ChevronDown, Film, ImagePlus, KeyRound, LoaderCircle, Maximize2, Minimize2, Music, Send, Upload, Wand2, X,
} from "lucide-react";
import { createPortal } from "react-dom";
import type { Channel } from "../../shared/types";
import type { VideoCapability } from "../../shared/video-capabilities";
import type { VideoDraft } from "../../shared/video-draft";
import type { VideoModeSpec } from "../../shared/video-modes";
import { VIDEO_FORMAT_CHOICES } from "../../shared/video-modes";
import type { MediaBucket } from "../hooks/useMediaBuckets";
import { PromptPolishButton } from "../PromptPolishButton";
import { VideoParamsPanel } from "./VideoParamsPanel";
import { VideoMentionPanel, type MentionItem } from "./VideoMentionPanel";
import { useAnchoredPanelStyle, usePanelDismiss } from "./useAnchoredPanel";

/**
 * 一体化创作框。
 *
 * 结构与截图一致：素材槽在上、提示词居中、底部一排参数胶囊与发送键。
 * 模式、参数、@ 素材都是浮层，浮层挂在 body 上，因此**展开/收起、开面板都不会
 * 重新挂载 textarea**——正在写的提示词不会丢。
 *
 * 素材只走本地上传：这里没有「粘贴公网地址」的输入框，参考视频/音频都点加号选文件。
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
  submitting: boolean;
  reading: boolean;
  dropActive: boolean;
  dropProps: Pick<HTMLAttributes<HTMLDivElement>, "onDragEnter" | "onDragOver" | "onDragLeave" | "onDrop">;
  notice: string | null;
  onDraftChange: (patch: Partial<VideoDraft>) => void;
  onModeChange: (mode: VideoModeSpec) => void;
  onAddImages: (files: File[]) => void;
  onRemoveImage: (previewUrl: string) => void;
  onClearImages: () => void;
  onSelectVideo: (file: File) => void;
  onClearVideo: () => void;
  onSelectAudio: (file: File) => void;
  onClearAudio: () => void;
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

function roleLabel(spec: VideoModeSpec | null, index: number): string {
  if (!spec) return "参考图";
  if (spec.imageRepeatable) return ROLE_LABELS[spec.imageSlots[0] ?? ""] ?? "参考图";
  return ROLE_LABELS[spec.imageSlots[index] ?? ""] ?? "参考图";
}

/** 固定槽位模式（首帧 / 首尾帧 / 角色图）按槽位画格子；参考图模式画缩略图 + 加号 */
function isFixedSlotMode(spec: VideoModeSpec | null): boolean {
  return Boolean(spec && !spec.imageRepeatable && spec.imageSlots.length > 0);
}

/** @ 引用的素材清单：顺序与提交时的素材数组一致 */
function mentionItemsOf(bucket: MediaBucket): MentionItem[] {
  return [
    ...(bucket.video ? [{ label: "视频1", kind: "视频" as const, previewUrl: bucket.video.previewUrl }] : []),
    ...bucket.images.map((item, index) => ({ label: `图片${index + 1}`, kind: "图片" as const, previewUrl: item.previewUrl })),
    ...(bucket.audio ? [{ label: "音频1", kind: "音频" as const }] : []),
  ];
}

export function VideoComposer(props: VideoComposerProps) {
  const {
    channel, adapter, model, caps, modes, spec, draft, bucket, maxImages, submitting, reading,
    dropActive, dropProps, notice, onDraftChange, onModeChange,
  } = props;
  const [expanded, setExpanded] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const modeChipRef = useRef<HTMLButtonElement | null>(null);
  const paramChipRef = useRef<HTMLButtonElement | null>(null);
  const mentionButtonRef = useRef<HTMLButtonElement | null>(null);
  const modePanelRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const modeStyle = useAnchoredPanelStyle(modeMenuOpen, modeChipRef.current, 260, 360);
  usePanelDismiss(modeMenuOpen, () => setModeMenuOpen(false), modePanelRef, modeChipRef.current);

  const fixedSlots = isFixedSlotMode(spec) ? spec!.imageSlots : null;
  const repeatable = Boolean(spec?.imageRepeatable) || (!spec && maxImages > 0);
  const filled = bucket.images.length;
  const hasVideoSlot = Boolean(spec?.acceptsReferenceVideo || spec?.needsReferenceVideo);
  const hasAudioSlot = Boolean(spec?.acceptsReferenceAudio);
  const canUploadVideo = Boolean(channel?.uploadEndpoint);
  const ratioValue = caps?.ratioField === "ratio" ? draft.ratio : draft.aspectRatio;
  const ratioLabel = ratioValue === "adaptive" ? "智能比例" : ratioValue;
  const formatLabel = VIDEO_FORMAT_CHOICES[0].label;
  const audioSupported = Boolean(caps?.supportsAudio);
  const disabled = submitting || reading || !channel || !model;
  const mentionItems = mentionItemsOf(bucket);

  function pickImages(files: FileList | null) {
    if (!files?.length) return;
    props.onAddImages(Array.from(files));
  }

  /** 把 @记号 插到光标处；光标前若正好是刚敲的「@」，用它替换掉，避免出现「@@图片1」 */
  function insertMention(label: string) {
    const element = textareaRef.current;
    const prompt = draft.prompt;
    const start = element?.selectionStart ?? prompt.length;
    const end = element?.selectionEnd ?? start;
    const before = prompt.slice(0, start);
    const from = before.endsWith("@") ? start - 1 : start;
    const token = `@${label}`;
    onDraftChange({ prompt: `${prompt.slice(0, from)}${token} ${prompt.slice(end)}` });
    setMentionOpen(false);
    if (element) {
      requestAnimationFrame(() => {
        element.focus();
        const caret = from + token.length + 1;
        element.setSelectionRange(caret, caret);
      });
    }
  }

  const imageInput = (
    <input
      type="file"
      accept="image/png,image/jpeg,image/webp"
      multiple={repeatable}
      disabled={disabled || filled >= maxImages}
      onChange={(event) => { pickImages(event.currentTarget.files); event.currentTarget.value = ""; }}
    />
  );

  return (
    <div
      className={`vstudio-composer ${expanded ? "is-expanded" : ""} ${dropActive ? "is-drop-target" : ""}`}
      {...dropProps}
    >
      <div className="vstudio-composer-head">
        <div className="vstudio-slots">
          {fixedSlots
            ? fixedSlots.map((slotType, index) => {
                const item = bucket.images[index];
                if (item) {
                  return (
                    <div className="vstudio-slot is-filled" key={slotType}>
                      <img src={item.previewUrl} alt={roleLabel(spec, index)} />
                      <em className="vstudio-slot-role">{roleLabel(spec, index)}</em>
                      <button type="button" className="vstudio-slot-remove" aria-label={`移除${roleLabel(spec, index)}`}
                        onClick={() => props.onRemoveImage(item.previewUrl)}><X size={11} /></button>
                    </div>
                  );
                }
                return (
                  <label className="vstudio-slot" key={slotType} title={`添加${roleLabel(spec, index)}`}>
                    {reading ? <LoaderCircle className="spin" size={16} /> : <ImagePlus size={16} />}
                    <span>{roleLabel(spec, index)}</span>
                    {imageInput}
                  </label>
                );
              })
            : bucket.images.map((item, index) => (
                <div className="vstudio-slot is-filled" key={item.previewUrl}>
                  <img src={item.previewUrl} alt={roleLabel(spec, index)} />
                  {spec && !spec.imageRepeatable ? <em className="vstudio-slot-role">{roleLabel(spec, index)}</em> : null}
                  <button type="button" className="vstudio-slot-remove" aria-label={`移除图片 ${index + 1}`}
                    onClick={() => props.onRemoveImage(item.previewUrl)}><X size={11} /></button>
                </div>
              ))}

          {filled > 0 ? (
            <button type="button" className="vstudio-clear" onClick={props.onClearImages}>清空图片</button>
          ) : null}

          {repeatable && filled < maxImages ? (
            <label className="vstudio-slot" title="添加图片">
              {reading ? <LoaderCircle className="spin" size={16} /> : <ImagePlus size={16} />}
              <span>{filled ? "继续添加" : "参考内容"}</span>
              {imageInput}
            </label>
          ) : null}

          {hasVideoSlot && !bucket.video ? (
            <label
              className={`vstudio-slot ${reading ? "is-busy" : ""} ${canUploadVideo ? "" : "is-locked"}`}
              title={canUploadVideo ? "上传参考视频（MP4 / MOV，≤100MB）" : "该渠道未配置上传服务，暂时无法上传参考视频"}
            >
              {reading ? <LoaderCircle className="spin" size={16} /> : <Film size={16} />}
              <span>{canUploadVideo ? "参考视频" : "暂不支持上传"}</span>
              <input type="file" accept="video/mp4,video/quicktime,.mp4,.mov" disabled={disabled || !canUploadVideo}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) props.onSelectVideo(file);
                }} />
            </label>
          ) : null}

          {hasAudioSlot && !bucket.audio ? (
            <label className="vstudio-slot" title="上传参考音频（MP3 / M4A / AAC / WAV，≤15MB）">
              <Music size={16} />
              <span>参考音频</span>
              <input type="file" accept="audio/mpeg,audio/mp4,audio/aac,audio/wav,.mp3,.m4a,.aac,.wav" disabled={disabled}
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) props.onSelectAudio(file);
                }} />
            </label>
          ) : null}

          {bucket.video ? (
            <div className="vstudio-file-chip">
              <Film size={14} />
              <span>
                <strong title={bucket.video.file.name}>{bucket.video.file.name}</strong>
                <small>{bucket.video.duration.toFixed(1)} 秒 · {(bucket.video.file.size / 1024 / 1024).toFixed(1)} MB · 提交时上传</small>
              </span>
              <button type="button" aria-label="移除已选视频" onClick={props.onClearVideo}><X size={13} /></button>
            </div>
          ) : null}

          {bucket.audio ? (
            <div className="vstudio-file-chip">
              <Music size={14} />
              <span>
                <strong title={bucket.audio.file.name}>{bucket.audio.file.name}</strong>
                <small>
                  {bucket.audio.duration.toFixed(1)} 秒 · {(bucket.audio.file.size / 1024 / 1024).toFixed(1)} MB ·
                  {adapter === "seedance-video" ? " 提交时上传" : " 内联提交"}
                </small>
              </span>
              <button type="button" aria-label="移除已选音频" onClick={props.onClearAudio}><X size={13} /></button>
            </div>
          ) : null}
        </div>

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
              setMentionOpen((value) => !value);
            }}
          >
            @
          </button>

          <button
            type="button"
            className="vstudio-chip is-static vstudio-expand"
            title={expanded ? "收起输入框" : "展开输入框"}
            aria-label={expanded ? "收起输入框" : "展开输入框"}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        </div>
      </div>

      <textarea
        ref={textareaRef}
        className="vstudio-input"
        aria-label="提示词"
        value={draft.prompt}
        maxLength={20000}
        placeholder="描述视频内容，输入 @ 引用已上传的图片、视频或音频……"
        onChange={(event) => {
          const next = event.target.value;
          const caret = event.target.selectionStart ?? next.length;
          onDraftChange({ prompt: next });
          // 刚敲下一个 @ 就打开素材列表，接着选一个即可插成 @图片1。
          // 光标位置在受控组件里不一定可靠，末尾的 @ 也算。
          if (next.length > draft.prompt.length && (next[caret - 1] === "@" || next.endsWith("@"))) {
            setMentionOpen(true);
          }
        }}
      />

      {notice ? <p className="vstudio-hint" role="status">{notice}</p> : null}

      <div className="vstudio-footer">
        {modes.length ? (
          <button
            type="button"
            ref={modeChipRef}
            className="vstudio-chip is-mode"
            aria-haspopup="dialog"
            aria-expanded={modeMenuOpen}
            onClick={() => { setParamsOpen(false); setMentionOpen(false); setModeMenuOpen((value) => !value); }}
          >
            {spec?.label ?? "生成方式"}
            <ChevronDown size={12} />
          </button>
        ) : null}

        <button
          type="button"
          ref={paramChipRef}
          className="vstudio-chip"
          aria-haspopup="dialog"
          aria-expanded={paramsOpen}
          onClick={() => { setModeMenuOpen(false); setMentionOpen(false); setParamsOpen((value) => !value); }}
        >
          {ratioLabel} · {draft.resolution ? draft.resolution.toUpperCase() : "—"} · {formatLabel}
        </button>

        <button type="button" className="vstudio-chip" onClick={() => { setModeMenuOpen(false); setMentionOpen(false); setParamsOpen(true); }}>
          {spec && !spec.durationEditable ? "时长随视频" : draft.duration === -1 ? "智能时长" : `${draft.duration} 秒`}
        </button>

        {audioSupported ? (
          <button type="button" className="vstudio-chip" onClick={() => { setModeMenuOpen(false); setMentionOpen(false); setParamsOpen(true); }}>
            {draft.audio ? "有声" : "无声"}
          </button>
        ) : null}

        <span className="vstudio-chip is-static">1 条</span>

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
          model={model}
          spec={spec}
          caps={caps}
          draft={draft}
          onChange={onDraftChange}
        />
      ) : null}

      <VideoMentionPanel
        open={mentionOpen}
        anchor={mentionButtonRef.current}
        items={mentionItems}
        onClose={() => setMentionOpen(false)}
        onSelect={insertMention}
      />
    </div>
  );
}

/** 给「空状态」用的占位：没有渠道时仍显示创作框的骨架，点加号去配置 */
export function VideoComposerPlaceholder({ onAddChannel }: { onAddChannel: () => void }) {
  return (
    <div className="vstudio-composer">
      <div className="vstudio-composer-head">
        <div className="vstudio-slots">
          <label className="vstudio-slot" title="添加参考内容">
            <ImagePlus size={16} />
            <span>参考内容</span>
            <input type="file" hidden disabled />
          </label>
        </div>
      </div>
      <textarea className="vstudio-input" readOnly value="" placeholder="先添加一个视频渠道，再开始创作……" />
      <div className="vstudio-footer">
        <span className="vstudio-chip is-static"><Upload size={12} />参考生成</span>
        <span className="vstudio-chip is-static"><Wand2 size={12} />16:9 · 720P · MP4</span>
        <span className="vstudio-spacer" />
        <button type="button" className="vstudio-send" aria-label="添加渠道" title="添加渠道" onClick={onAddChannel}>
          <Send size={15} />
        </button>
      </div>
    </div>
  );
}
