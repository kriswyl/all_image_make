/**
 * 无限画布节点的内容渲染。
 *
 * 拖拽 / 选中 / 缩放由 BoardCanvas 的外层负责；这里只管节点里面长什么样，
 * 以及文本编辑、图片预览、删除这些节点内动作。
 */
import { useEffect, useRef, useState } from "react";
import {
  AlertCircle, AudioLines, ChevronDown, ChevronUp, Image as ImageIcon, LoaderCircle, Pencil, Play, RefreshCw,
  Sparkles, Square, Trash2, Upload, Video, X,
} from "lucide-react";
import type {
  AudioBoardNode, BoardNode, ConfigBoardNode, ImageBoardNode, TextBoardNode, VideoBoardNode,
} from "../../shared/board";
import type { Asset } from "../../shared/types";
import { api } from "../api";

export interface BoardNodeViewProps {
  node: BoardNode;
  asset: Asset | null;
  editing: boolean;
  upstream: { textCount: number; imageCount: number };
  onStartEdit: () => void;
  onCommitText: (text: string) => void;
  onCancelEdit: () => void;
  onUpdateNode: (patch: Partial<BoardNode>) => void;
  onPreview: (asset: Asset) => void;
  onSelect: () => void;
  onPickImage: (nodeId: string) => void;
  onRemoveAsset: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
  onGenerate: (nodeId: string) => void;
  onStopTask: (taskId: string) => void;
  onRetryTask: (taskId: string) => void;
}

function assetSrc(asset: Asset, thumb = true): string {
  return api.assetUrl(asset.thumbUrl && thumb ? asset.thumbUrl : asset.url);
}

function StatusBadge({ status }: { status: string }) {
  if (status === "loading") return <span className="board-badge is-active"><LoaderCircle size={10} className="spin" />生成中</span>;
  if (status === "failed") return <span className="board-badge is-failed"><AlertCircle size={10} />失败</span>;
  if (status === "succeeded") return <span className="board-badge is-done">已生成</span>;
  if (status === "cancelled") return <span className="board-badge">已取消</span>;
  return null;
}

/**
 * 图片 / 视频 / 音频节点自带的生成条。
 *
 * 提示词写在节点上，生成结果回填同一个节点；这样模板里的角色 / 场景占位
 * 不用先加一个配置节点就能直接出图。
 */
function MediaPrompt({
  node, upstream, hasAsset, onUpdateNode, onGenerate, onStopTask, onRetryTask,
}: {
  node: ImageBoardNode | VideoBoardNode | AudioBoardNode;
  upstream: { textCount: number; imageCount: number };
  hasAsset: boolean;
  onUpdateNode: (patch: Partial<BoardNode>) => void;
  onGenerate: (nodeId: string) => void;
  onStopTask: (taskId: string) => void;
  onRetryTask: (taskId: string) => void;
}) {
  // 有结果时默认收起提示词，把高度让给图片；没有结果时展开，方便直接写
  const [expanded, setExpanded] = useState(!hasAsset);
  const touchedRef = useRef(false);
  useEffect(() => {
    if (hasAsset && !touchedRef.current) setExpanded(false);
  }, [hasAsset]);
  const edited = expanded || !hasAsset;
  const generating = node.status === "loading";
  const canGenerate = Boolean((node.prompt ?? "").trim() || upstream.textCount);
  const kindLabel = node.type === "video" ? "视频" : node.type === "audio"
    ? (node.audioKind === "music" ? "音乐" : "配音") : "图片";
  const toggle = () => {
    touchedRef.current = true;
    setExpanded((value) => !value);
  };
  return (
    <div className={`board-media-prompt-row ${edited ? "is-expanded" : "is-collapsed"}`}>
      {edited ? (
        <textarea
          className="board-media-prompt"
          rows={2}
          maxLength={20000}
          value={node.prompt ?? ""}
          placeholder={`写提示词直接生成${kindLabel}，或把文本节点连到左边`}
          onChange={(event) => onUpdateNode({ prompt: event.target.value } as Partial<BoardNode>)}
          onPointerDown={(event) => event.stopPropagation()}
        />
      ) : (
        <button
          type="button"
          className="board-media-prompt-preview"
          title="展开提示词"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={toggle}
        >
          {node.prompt?.trim() || "未填写提示词"}
        </button>
      )}
      <div className="board-media-prompt-side">
        <span className="board-media-upstream" title="直接上游">
          {upstream.textCount ? `${upstream.textCount} 文本` : "无上游"}
          {upstream.imageCount ? ` · ${upstream.imageCount} 图` : ""}
        </span>
        <div className="board-config-buttons">
          {edited && generating && node.taskId ? (
            <button
              type="button"
              className="board-config-stop"
              title="停止生成"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onStopTask(node.taskId!)}
            >
              <Square size={10} />
            </button>
          ) : null}
          {edited && (node.status === "failed" || node.status === "cancelled") && node.taskId ? (
            <button
              type="button"
              className="board-config-retry"
              title="用同样的参数重试"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onRetryTask(node.taskId!)}
            >
              <RefreshCw size={10} />
            </button>
          ) : null}
          <button
            type="button"
            className="board-config-generate"
            disabled={generating || !canGenerate}
            title={canGenerate ? `用当前提示词生成${kindLabel}` : "先写提示词，或把文本节点连到左边"}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onGenerate(node.id)}
          >
            {generating
              ? <><LoaderCircle size={11} className="spin" />生成中</>
              : <><Sparkles size={11} />生成</>}
          </button>
          {hasAsset ? (
            <button
              type="button"
              className="board-media-prompt-toggle"
              title={edited ? "收起提示词" : "展开提示词"}
              aria-label={edited ? "收起提示词" : "展开提示词"}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={toggle}
            >
              {edited ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
            </button>
          ) : null}
        </div>
      </div>
      {edited && node.error ? <p className="board-config-error" title={node.error}>{node.error}</p> : null}
    </div>
  );
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

function ImageNodeView({ node, asset, upstream, onPreview, onSelect, onPickImage, onRemoveAsset, onDelete, onUpdateNode, onGenerate, onStopTask, onRetryTask }: {
  node: ImageBoardNode;
  asset: Asset | null;
  upstream: { textCount: number; imageCount: number };
  onPreview: (asset: Asset) => void;
  onSelect: () => void;
  onPickImage: (nodeId: string) => void;
  onRemoveAsset: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
  onUpdateNode: (patch: Partial<BoardNode>) => void;
  onGenerate: (nodeId: string) => void;
  onStopTask: (taskId: string) => void;
  onRetryTask: (taskId: string) => void;
}) {
  return (
    <>
      <div className="board-media-body">
        <button
          type="button"
          className={`board-image-body ${asset ? "has-asset" : ""}`}
          title={asset ? "点击查看设置，双击预览" : "还没有图片，可以写提示词生成或上传"}
          disabled={!asset}
          onClick={onSelect}
          onDoubleClick={() => { if (asset) onPreview(asset); }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {asset ? (
            <img src={assetSrc(asset)} alt="" loading="lazy" draggable={false} />
          ) : (
            <span className="board-image-empty">
              <ImageIcon size={22} />
              <em>{node.status === "loading" ? "生成中…" : "写提示词生成，或上传图片"}</em>
            </span>
          )}
          {node.status === "loading" ? <span className="board-image-loading"><LoaderCircle size={18} className="spin" /></span> : null}
        </button>
        {(!node.assetId || node.status === "loading") && <MediaPrompt
          node={node}
          upstream={upstream}
          hasAsset={Boolean(asset)}
          onUpdateNode={onUpdateNode}
          onGenerate={onGenerate}
          onStopTask={onStopTask}
          onRetryTask={onRetryTask}
        />}
      </div>
      <div className="board-node-tools">
        <button type="button" title="上传 / 替换图片" onClick={() => onPickImage(node.id)} onPointerDown={(event) => event.stopPropagation()}>
          <Upload size={12} />
        </button>
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

function VideoNodeView({ node, asset, upstream, onPreview, onSelect, onPickImage, onDelete, onUpdateNode, onGenerate, onStopTask, onRetryTask }: {
  node: VideoBoardNode;
  asset: Asset | null;
  upstream: { textCount: number; imageCount: number };
  onPreview: (asset: Asset) => void;
  onSelect: () => void;
  onPickImage: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
  onUpdateNode: (patch: Partial<BoardNode>) => void;
  onGenerate: (nodeId: string) => void;
  onStopTask: (taskId: string) => void;
  onRetryTask: (taskId: string) => void;
}) {
  return (
    <>
      <div className="board-media-body">
        <button
          type="button"
          className={`board-image-body ${asset ? "has-asset" : ""}`}
          title={asset ? "点击查看设置，双击播放" : node.status === "loading" ? "视频生成中…" : "写提示词生成视频"}
          disabled={!asset}
          onClick={onSelect}
          onDoubleClick={() => { if (asset) onPreview(asset); }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {asset ? (
            <>
              <video src={`${api.assetUrl(asset.url)}#t=0.1`} muted preload="metadata" playsInline />
              <span className="board-video-play"><Play size={14} /></span>
            </>
          ) : (
            <span className="board-image-empty">
              <Video size={22} />
              <em>{node.status === "loading" ? "视频生成中…" : "写提示词生成，或连接图片当首帧"}</em>
            </span>
          )}
          {node.status === "loading" ? <span className="board-image-loading"><LoaderCircle size={18} className="spin" /></span> : null}
        </button>
        {(!node.assetId || node.status === "loading") && <MediaPrompt
          node={node}
          upstream={upstream}
          hasAsset={Boolean(asset)}
          onUpdateNode={onUpdateNode}
          onGenerate={onGenerate}
          onStopTask={onStopTask}
          onRetryTask={onRetryTask}
        />}
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

function AudioNodeView({ node, asset, upstream, onPreview, onSelect, onPickImage, onDelete, onUpdateNode, onGenerate, onStopTask, onRetryTask }: {
  node: AudioBoardNode;
  asset: Asset | null;
  upstream: { textCount: number; imageCount: number };
  onPreview: (asset: Asset) => void;
  onSelect: () => void;
  onPickImage: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
  onUpdateNode: (patch: Partial<BoardNode>) => void;
  onGenerate: (nodeId: string) => void;
  onStopTask: (taskId: string) => void;
  onRetryTask: (taskId: string) => void;
}) {
  const kindLabel = node.audioKind === "music" ? "音乐" : "配音";
  return (
    <>
      <div className="board-media-body">
        <button
          type="button"
          className={`board-audio-body ${asset ? "has-asset" : ""}`}
          title={asset ? "点击查看设置，双击播放" : node.status === "loading" ? "正在生成音频…" : `写提示词生成${kindLabel}`}
          disabled={!asset}
          onClick={onSelect}
          onDoubleClick={() => { if (asset) onPreview(asset); }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <span className="board-audio-icon">
            {node.status === "loading" ? <LoaderCircle size={18} className="spin" /> : <AudioLines size={20} />}
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
        {(!node.assetId || node.status === "loading") && <MediaPrompt
          node={node}
          upstream={upstream}
          hasAsset={Boolean(asset)}
          onUpdateNode={onUpdateNode}
          onGenerate={onGenerate}
          onStopTask={onStopTask}
          onRetryTask={onRetryTask}
        />}
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

function ConfigNodeView({ node, upstream, onUpdateNode, onDelete, onGenerate, onStopTask, onRetryTask }: {
  node: ConfigBoardNode;
  upstream: { textCount: number; imageCount: number };
  onUpdateNode: (patch: Partial<BoardNode>) => void;
  onDelete: (nodeId: string) => void;
  onGenerate: (nodeId: string) => void;
  onStopTask: (taskId: string) => void;
  onRetryTask: (taskId: string) => void;
}) {
  const emptyPrompt = !node.prompt.trim() && upstream.textCount === 0;
  const generating = node.status === "loading";
  return (
    <div className="board-config-body">
      <div className="board-config-row">
        <span className="board-config-mode">
          {node.mode === "video" ? "生视频" : node.mode === "text" ? "生文本" : node.mode === "audio" ? "生音频" : "生图"}
        </span>
        <span className="board-config-count">
          {node.mode === "video"
            ? `${node.durationSeconds ? `${node.durationSeconds} 秒` : "默认时长"}${node.resolution ? ` · ${node.resolution}` : ""}`
            : node.mode === "text" ? "1 段"
              : node.mode === "audio" ? (node.audioKind === "music" ? "2 首" : "1 段")
                : `${node.count} 张`}
        </span>
        {node.status === "loading" ? <span className="board-badge is-active"><LoaderCircle size={10} className="spin" />生成中</span> : null}
      </div>
      <div className="board-config-upstream">
        <span>上游</span>
        <strong>{upstream.textCount} 段文本</strong>
        <span>·</span>
        <strong>{upstream.imageCount} 张参考图</strong>
      </div>
      <textarea
        className="board-config-prompt"
        value={node.prompt}
        maxLength={20000}
        placeholder={emptyPrompt ? "写这一组生成用的提示词，或把文本节点连到左边" : "补充提示词（可留空，直接用上游文本）"}
        onChange={(event) => onUpdateNode({ prompt: event.target.value } as Partial<BoardNode>)}
        onPointerDown={(event) => event.stopPropagation()}
      />
      <div className="board-config-actions">
        <label className="board-config-check">
          <input
            type="checkbox"
            checked={node.useUpstreamText}
            onChange={(event) => onUpdateNode({ useUpstreamText: event.target.checked } as Partial<BoardNode>)}
            onPointerDown={(event) => event.stopPropagation()}
          />
          拼上游文本
        </label>
        <div className="board-config-buttons">
          {generating && node.lastTaskId ? (
            <button
              type="button"
              className="board-config-stop"
              title="停止这次生成"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onStopTask(node.lastTaskId!)}
            >
              <Square size={10} />停止
            </button>
          ) : null}
          {(node.status === "failed" || node.status === "cancelled") && node.lastTaskId ? (
            <button
              type="button"
              className="board-config-retry"
              title="用同样的参数再跑一次"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onRetryTask(node.lastTaskId!)}
            >
              <RefreshCw size={10} />重试
            </button>
          ) : null}
          <button
            type="button"
            className="board-config-generate"
            disabled={generating || emptyPrompt}
            title={generating ? "正在生成…" : emptyPrompt ? "先写提示词，或把文本节点连到左边" : "按上游文本 / 图片生成"}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => onGenerate(node.id)}
          >
            {generating
              ? <><LoaderCircle size={11} className="spin" />生成中</>
              : node.mode === "video" ? "生成视频"
                : node.mode === "text" ? "生成文本"
                  : node.mode === "audio" ? "生成音频"
                    : "生成"}
          </button>
        </div>
      </div>
      {node.error ? <p className="board-config-error" title={node.error}>{node.error}</p> : null}
    </div>
  );
}

export function BoardNodeView({
  node, asset, editing, upstream, onStartEdit, onCommitText, onCancelEdit, onUpdateNode,
  onPreview, onSelect, onPickImage, onRemoveAsset, onDelete, onGenerate, onStopTask, onRetryTask,
}: BoardNodeViewProps) {
  return (
    <>
      <header className="board-node-head">
        <span className={`board-node-kind is-${node.type}`}>
          {node.type === "text" ? "文本" : node.type === "config" ? "配置" : node.type === "video" ? "视频" : node.type === "audio" ? "音频" : "图片"}
        </span>
        <strong className="board-node-title" title={node.title}>{node.title || node.ref}</strong>
        {node.type === "text" && !editing ? <button type="button" className="board-text-edit-button" title="编辑文本" aria-label="编辑文本" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onSelect(); onStartEdit(); }}><Pencil size={13} /></button> : null}
        {node.type === "image" || node.type === "video" || node.type === "audio"
          ? <StatusBadge status={node.status} />
          : null}
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
          upstream={upstream}
          onPreview={onPreview}
          onSelect={onSelect}
          onPickImage={onPickImage}
          onRemoveAsset={onRemoveAsset}
          onDelete={onDelete}
          onUpdateNode={onUpdateNode}
          onGenerate={onGenerate}
          onStopTask={onStopTask}
          onRetryTask={onRetryTask}
        />
      ) : null}
      {node.type === "video" ? (
        <VideoNodeView
          node={node}
          asset={asset}
          upstream={upstream}
          onPreview={onPreview}
          onSelect={onSelect}
          onDelete={onDelete}
          onPickImage={onPickImage}
          onUpdateNode={onUpdateNode}
          onGenerate={onGenerate}
          onStopTask={onStopTask}
          onRetryTask={onRetryTask}
        />
      ) : null}
      {node.type === "audio" ? (
        <AudioNodeView
          node={node}
          asset={asset}
          upstream={upstream}
          onPreview={onPreview}
          onSelect={onSelect}
          onDelete={onDelete}
          onPickImage={onPickImage}
          onUpdateNode={onUpdateNode}
          onGenerate={onGenerate}
          onStopTask={onStopTask}
          onRetryTask={onRetryTask}
        />
      ) : null}
      {node.type === "config" ? (
        <ConfigNodeView
          node={node}
          upstream={upstream}
          onUpdateNode={onUpdateNode}
          onDelete={onDelete}
          onGenerate={onGenerate}
          onStopTask={onStopTask}
          onRetryTask={onRetryTask}
        />
      ) : null}

      <footer className="board-node-foot">
        <span>{node.ref}</span>
        {node.type === "text" ? <span>{node.text.length} 字</span> : null}
        {node.type === "config" && node.useUpstreamText ? <span>含上游文本</span> : null}
      </footer>
    </>
  );
}
