/**
 * 无限画布节点的内容渲染。
 *
 * 拖拽 / 选中 / 缩放由 BoardCanvas 的外层负责；这里只管节点里面长什么样，
 * 以及文本编辑、图片预览、删除这些节点内动作。
 */
import { LoadingIndicator } from "../ui/LoadingIndicator";
import { useEffect, useRef, useState } from "react";
import {
  AlertCircle, AudioLines, Download, FolderOpen, Image as ImageIcon, Maximize2, Minimize2, Pencil, Play,
  SlidersHorizontal, Trash2, Upload, Video, X,
} from "lucide-react";
import type {
  AudioBoardNode, BoardNode, ConfigBoardNode, ImageBoardNode, TextBoardNode, VideoBoardNode,
} from "../../shared/board";
import type { Asset } from "../../shared/types";
import { api } from "../api";
import { ModelLogo, modelBrand } from "../chat/ModelLogo";
import { BOARD_CONFIG_MODES } from "./board-config-modes";
import type { BoardConfigModelSummary } from "./board-models";

export interface ConfigNodeConnections {
  inputs: number;
  outputs: number;
  hasUpstreamText: boolean;
}

export interface BoardNodeViewProps {
  node: BoardNode;
  asset: Asset | null;
  editing: boolean;
  configConnections?: ConfigNodeConnections;
  configModel?: BoardConfigModelSummary;
  imageResults?: { count: number; expanded: boolean; onToggle: () => void };
  primaryChoice?: { enabled: boolean; onChoose: () => void };
  onImageLoad?: (assetId: string, width: number, height: number) => void;
  onStartEdit: () => void;
  onCommitText: (text: string) => void;
  onCancelEdit: () => void;
  onPreview: (asset: Asset) => void;
  onSelect: () => void;
  onEditConfig?: () => void;
  onPickImage: (nodeId: string) => void;
  onUploadMediaIntoNode: (nodeId: string) => void;
  onRemoveAsset: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
  onCompareVersions: (nodeId: string) => void;
  onExtractFrame: (nodeId: string) => void;
}

function assetSrc(asset: Asset, thumb = true): string {
  return api.assetUrl(asset.thumbUrl && thumb ? asset.thumbUrl : asset.url);
}

function StatusBadge({ status }: { status: string }) {
  if (status === "loading") return <span className="board-badge is-active"><LoadingIndicator variant="dots" size={24} />生成中</span>;
  if (status === "failed") return <span className="board-badge is-failed"><AlertCircle size={10} />失败</span>;
  if (status === "succeeded") return <span className="board-badge is-done">已生成</span>;
  if (status === "cancelled") return <span className="board-badge">已取消</span>;
  return null;
}

function TextNodeView({ node, editing, onStartEdit, onCommitText, onCancelEdit }: {
  node: TextBoardNode;
  editing: boolean;
  onStartEdit: () => void;
  onCommitText: (text: string) => void;
  onCancelEdit: () => void;
}) {
  const [draft, setDraft] = useState(node.text);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => { setDraft(node.text); }, [node.text, editing]);
  useEffect(() => {
    if (!editing) return;
    cancelledRef.current = false;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [editing]);

  if (editing) {
    return (
      <textarea
        ref={textareaRef}
        className="board-text-editor"
        value={draft}
        maxLength={20000}
        placeholder="写提示词、文案或说明…"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (cancelledRef.current) {
            cancelledRef.current = false;
            return;
          }
          onCommitText(draft);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancelledRef.current = true;
            onCancelEdit();
          }
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            onCommitText(draft);
          }
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      />
    );
  }

  return (
    <div
      className={`board-text-body ${node.text.trim() ? "" : "is-empty"}`}
      onDoubleClick={(event) => { event.stopPropagation(); onStartEdit(); }}
    >
      {node.text.trim() || "双击编辑文字"}
    </div>
  );
}

function ImageNodeView({ node, asset, imageResults, primaryChoice, onImageLoad, onPreview, onSelect, onPickImage, onUploadMediaIntoNode, onRemoveAsset, onDelete }: {
  node: ImageBoardNode;
  asset: Asset | null;
  imageResults?: BoardNodeViewProps["imageResults"];
  primaryChoice?: BoardNodeViewProps["primaryChoice"];
  onImageLoad?: BoardNodeViewProps["onImageLoad"];
  onPreview: (asset: Asset) => void;
  onSelect: () => void;
  onPickImage: (nodeId: string) => void;
  onUploadMediaIntoNode: (nodeId: string) => void;
  onRemoveAsset: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
}) {
  return (
    <>
      <div className="board-media-body board-image-preview">
        <button
          type="button"
          className={`board-image-body ${asset ? "has-asset" : ""}`}
          aria-label={asset ? "选中图片节点，双击预览" : "选中图片节点"}
          onClick={onSelect}
          onDoubleClick={() => { if (asset) onPreview(asset); }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {asset ? (
            <img key={asset.id} src={assetSrc(asset, false)} alt="" loading="lazy" decoding="async" draggable={false}
              onLoad={({ currentTarget }) => onImageLoad?.(asset.id, currentTarget.naturalWidth, currentTarget.naturalHeight)} />
          ) : (
            <span className="board-image-empty">
              <ImageIcon size={30} />
            </span>
          )}
          {node.status === "loading" ? <span className="board-image-loading"><LoadingIndicator variant="liquid" size={64} /></span> : null}
        </button>
        {!asset && node.status !== "loading" && <div className="board-image-empty-actions" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => { onSelect(); onUploadMediaIntoNode(node.id); }}><Upload size={13} />上传</button>
          <button type="button" onClick={() => { onSelect(); onPickImage(node.id); }}><FolderOpen size={13} />资源库</button>
        </div>}
        {(imageResults || primaryChoice) && <div className="board-image-result-actions" onPointerDown={(event) => event.stopPropagation()}>
          {asset && (imageResults?.expanded || primaryChoice) && (
            <button type="button" aria-label="下载图片" title="下载图片" onClick={() => void api.downloadAsset(asset).catch(() => onPreview(asset))}>
              <Download size={14} />
            </button>
          )}
          {imageResults && <button type="button" aria-expanded={imageResults.expanded}
            aria-label={imageResults.expanded ? "收起图片结果" : `展开 ${imageResults.count} 张图片`}
            onClick={imageResults.onToggle}>
            {imageResults.expanded ? <><Minimize2 size={14} />收起</> : <><Maximize2 size={14} />{imageResults.count} 张</>}
          </button>}
          {primaryChoice && <button type="button" disabled={!primaryChoice.enabled} onClick={primaryChoice.onChoose}>设为主图</button>}
        </div>}
        {imageResults?.expanded && <span className="board-image-primary-label">主图</span>}
      </div>
      <div className={`board-node-tools${imageResults || primaryChoice ? " at-bottom" : ""}`}>
        {asset && <button type="button" title="替换图片" onClick={() => onPickImage(node.id)} onPointerDown={(event) => event.stopPropagation()}>
          <Upload size={12} />
        </button>}
        {asset ? (
          <button type="button" title="只从节点移除，不删素材" onClick={() => onRemoveAsset(node.id)} onPointerDown={(event) => event.stopPropagation()}>
            <X size={12} />
          </button>
        ) : null}
        <button type="button" title="删除节点" onClick={() => onDelete(node.id)} onPointerDown={(event) => event.stopPropagation()}>
          <Trash2 size={12} />
        </button>
      </div>
    </>
  );
}

function VideoNodeView({ node, asset, onPreview, onSelect, onPickImage, onUpload, onDelete, onCompareVersions, onExtractFrame }: {
  node: VideoBoardNode;
  asset: Asset | null;
  onPreview: (asset: Asset) => void;
  onSelect: () => void;
  onPickImage: (nodeId: string) => void;
  onUpload: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
  onCompareVersions: (nodeId: string) => void;
  onExtractFrame: (nodeId: string) => void;
}) {
  return (
    <>
      <div className="board-media-body board-image-preview">
        <button
          type="button"
          className={`board-image-body ${asset ? "has-asset" : ""}`}
          title={asset ? "点击查看设置，双击播放" : node.status === "loading" ? "视频生成中…" : "写提示词生成视频"}
          onClick={onSelect}
          onDoubleClick={() => { if (asset) onPreview(asset); }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {asset ? (
            <>
              <video src={`${api.assetUrl(asset.url)}#t=0.1`} muted preload="metadata" playsInline />
            </>
          ) : (
            <span className="board-image-empty">
              <Video size={22} />
              <em>{node.status === "loading" ? "视频生成中…" : "视频将在这里预览"}</em>
            </span>
          )}
          {node.status === "loading" ? <span className="board-image-loading"><LoadingIndicator variant="aurora" size={96} /></span> : null}
        </button>
        {asset && node.status !== "loading" && <button type="button" className="board-video-play" title="播放视频" aria-label="播放视频"
          onPointerDown={(event) => event.stopPropagation()} onClick={() => onPreview(asset)}><Play size={14} /></button>}
        {!asset && node.status !== "loading" && <div className="board-image-empty-actions" onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" onClick={() => { onSelect(); onUpload(node.id); }}><Upload size={13} />上传</button>
          <button type="button" onClick={() => { onSelect(); onPickImage(node.id); }}><FolderOpen size={13} />资源库</button>
        </div>}
      </div>
      <details className="board-video-node-menu" onPointerDown={(event) => event.stopPropagation()}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !event.currentTarget.open) return;
          event.preventDefault();
          event.currentTarget.open = false;
          event.currentTarget.querySelector("summary")?.focus();
        }}>
        <summary aria-label="视频节点操作">···</summary>
        <div className="board-composer-menu" onClick={(event) => event.currentTarget.parentElement?.removeAttribute("open")}>
          {asset && <>
            <button type="button" onClick={() => onPreview(asset)}>播放视频</button>
            <button type="button" onClick={() => void api.downloadAsset(asset).catch(() => onPreview(asset))}>下载视频</button>
            <button type="button" onClick={() => onCompareVersions(node.id)}>版本对比</button>
            <button type="button" onClick={() => onExtractFrame(node.id)}>提取尾帧</button>
            <button type="button" disabled={node.status === "loading"} onClick={() => onPickImage(node.id)}>替换视频</button>
          </>}
          <button type="button" onClick={() => onDelete(node.id)}>删除节点</button>
        </div>
      </details>
    </>
  );
}

function AudioNodeView({ node, asset, onPreview, onSelect, onPickImage, onDelete }: {
  node: AudioBoardNode;
  asset: Asset | null;
  onPreview: (asset: Asset) => void;
  onSelect: () => void;
  onPickImage: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
}) {
  const kindLabel = node.audioKind === "music" ? "音乐" : "配音";
  return (
    <>
      <div className="board-media-body">
        <button
          type="button"
          className={`board-audio-body ${asset ? "has-asset" : ""}`}
          title={asset ? "点击查看设置，双击播放" : node.status === "loading" ? "正在生成音频…" : `写提示词生成${kindLabel}`}
          onClick={onSelect}
          onDoubleClick={() => { if (asset) onPreview(asset); }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <span className="board-audio-icon">
            {node.status === "loading" ? <LoadingIndicator variant="dots" size={24} /> : <AudioLines size={20} />}
          </span>
          <span className="board-audio-meta">
            <strong>{asset ? asset.fileName : node.status === "loading" ? "生成中…" : `还没有${kindLabel}`}</strong>
            <em>
              {asset
                ? [asset.duration ? `${asset.duration.toFixed(1)} 秒` : "", asset.mimeType.replace("audio/", "").toUpperCase()]
                  .filter(Boolean).join(" · ")
                : `${kindLabel}结果会出现在这里`}
            </em>
          </span>
          {asset ? <Play size={14} className="board-audio-play" /> : null}
        </button>
      </div>
      <div className="board-node-tools">
        <button type="button" title="选择素材" onClick={() => onPickImage(node.id)} onPointerDown={(event) => event.stopPropagation()}><Upload size={12} /></button>
        <button type="button" title="删除节点" onClick={() => onDelete(node.id)} onPointerDown={(event) => event.stopPropagation()}>
          <Trash2 size={12} />
        </button>
      </div>
    </>
  );
}

function ConfigNodeView({ node, connections, summary }: {
  node: ConfigBoardNode;
  connections?: ConfigNodeConnections;
  summary?: BoardConfigModelSummary;
}) {
  const { label, icon: Icon } = BOARD_CONFIG_MODES[node.mode];
  const prompt = node.prompt.trim();
  const hasUpstreamText = node.useUpstreamText !== false && connections?.hasUpstreamText;
  const model = summary?.model;
  const kind = node.mode === "text" ? "chat" : node.mode;
  const hasLogo = model && modelBrand(model, kind);
  const details = [model ? `${label}生成` : undefined, summary?.parameters].filter(Boolean).join(" · ");
  return (
    <div className="board-config-body">
      <div className="board-config-row">
        <span className="board-config-icon" aria-hidden="true">
          {hasLogo ? <ModelLogo model={model} kind={kind} size={16} /> : <Icon size={16} />}
        </span>
        <div className="board-config-output">
          <strong title={model}>{model || `${label}生成`}</strong>
          {details && <span title={details}>{details}</span>}
        </div>
        <StatusBadge status={node.status} />
      </div>
      <div className={`board-config-prompt-preview${!prompt ? " is-empty" : ""}`}>
        <p className={`board-config-summary${!prompt ? " is-placeholder" : ""}`}>
          {prompt || (hasUpstreamText ? "使用上游文本" : "待填写提示词")}
        </p>
      </div>
      {node.error && <p className="board-config-error" title={node.error}>{node.error}</p>}
      <div className="board-config-connections">
        <span>输入 <strong>{connections?.inputs ?? 0}</strong></span>
        <span>结果 <strong>{connections?.outputs ?? 0}</strong></span>
        {prompt && hasUpstreamText && <span className="board-config-upstream">含上游文本</span>}
      </div>
    </div>
  );
}

const SETTING_ROLE_LABEL = { character: "角色", scene: "场景", prop: "道具" } as const;

/**
 * 设定图节点（角色 / 场景 / 道具）的识别。
 *
 * 这三类节点在画布上都是普通图片节点，靠标题前缀区分；给它们一个带颜色的
 * 牌子，几十个节点铺开时才能一眼分出「这是参考设定」还是「这是某一镜的产物」。
 */
function settingRoleOf(node: BoardNode): keyof typeof SETTING_ROLE_LABEL | null {
  if (node.type !== "image" || !node.title) return null;
  if (/^角色\s*[·・]/.test(node.title)) return "character";
  if (/^场景\s*[·・]/.test(node.title)) return "scene";
  if (/^道具\s*[·・]/.test(node.title)) return "prop";
  return null;
}

/** 标题里的「角色 · 」前缀由牌子承担，正文只留名字，省一行宽度 */
function titleWithoutRole(title: string) {
  return title.replace(/^(角色|场景|道具)\s*[·・]\s*/, "");
}

export function BoardNodeView({
  node, asset, editing, configConnections, configModel, imageResults, primaryChoice, onImageLoad, onStartEdit, onCommitText, onCancelEdit,
  onPreview, onSelect, onEditConfig, onPickImage, onUploadMediaIntoNode, onRemoveAsset, onDelete, onCompareVersions, onExtractFrame,
}: BoardNodeViewProps) {
  const settingRole = settingRoleOf(node);
  const displayTitle = settingRole ? titleWithoutRole(node.title) : node.title;
  return (
    <>
      <header className="board-node-head">
        {settingRole ? (
          <span className={`board-node-kind is-role is-${settingRole}`}>{SETTING_ROLE_LABEL[settingRole]}</span>
        ) : node.type === "image" ? (
          <ImageIcon size={12} className="board-node-image-kind" aria-hidden="true" />
        ) : node.type === "video" ? (
          <Video size={12} className="board-node-image-kind" aria-hidden="true" />
        ) : node.type === "config" ? (
          <SlidersHorizontal size={13} className="board-node-image-kind" aria-hidden="true" />
        ) : (
          <span className={`board-node-kind is-${node.type}`}>
            {node.type === "text" ? "文本" : "音频"}
          </span>
        )}
        <strong className="board-node-title" title={node.title ? `${node.title} · ${node.ref}` : node.ref}>{displayTitle || node.ref}</strong>
        {node.workflowSlot ? <span className="board-badge">{node.workflowSlot === "input" ? "输入" : "输出"}</span> : null}
        {node.type === "config" && <button type="button" className="board-text-edit-button" title="编辑配置" aria-label="编辑配置"
          onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); (onEditConfig ?? onSelect)(); }}>
          <Pencil size={13} />
        </button>}
        {node.type === "text" && !editing ? <button type="button" className="board-text-edit-button" title="编辑文本" aria-label="编辑文本" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onSelect(); onStartEdit(); }}><Pencil size={13} /></button> : null}
        {node.type === "image" || node.type === "video" || node.type === "audio"
          ? node.type === "video" && node.status === "empty" ? <span className="board-badge">待生成</span> : <StatusBadge status={node.status} />
          : null}
        {node.type === "image" && asset && node.naturalWidth && node.naturalHeight
          ? <span className="board-image-resolution" title={`分辨率 ${node.naturalWidth} × ${node.naturalHeight}`}>{node.naturalWidth} × {node.naturalHeight}</span> : null}
      </header>

      {node.type === "text" ? (
        <TextNodeView
          node={node}
          editing={editing}
          onStartEdit={onStartEdit}
          onCommitText={onCommitText}
          onCancelEdit={onCancelEdit}
        />
      ) : null}
      {node.type === "image" ? (
        <ImageNodeView
          node={node}
          asset={asset}
          imageResults={imageResults}
          primaryChoice={primaryChoice}
          onImageLoad={onImageLoad}
          onPreview={onPreview}
          onSelect={onSelect}
          onPickImage={onPickImage}
          onUploadMediaIntoNode={onUploadMediaIntoNode}
          onRemoveAsset={onRemoveAsset}
          onDelete={onDelete}
        />
      ) : null}
      {node.type === "video" ? (
        <VideoNodeView
          node={node}
          asset={asset}
          onPreview={onPreview}
          onSelect={onSelect}
          onDelete={onDelete}
          onPickImage={onPickImage}
          onUpload={onUploadMediaIntoNode}
          onCompareVersions={onCompareVersions}
          onExtractFrame={onExtractFrame}
        />
      ) : null}
      {node.type === "audio" ? (
        <AudioNodeView
          node={node}
          asset={asset}
          onPreview={onPreview}
          onSelect={onSelect}
          onDelete={onDelete}
          onPickImage={onPickImage}
        />
      ) : null}
      {node.type === "config" ? (
        <ConfigNodeView node={node} connections={configConnections} summary={configModel} />
      ) : null}

      {(node.type === "text" || node.type === "audio") && <footer className="board-node-foot">
        <span>{node.ref}</span>
        {node.type === "text" ? <span>{node.text.length} 字</span> : null}
      </footer>}
    </>
  );
}
