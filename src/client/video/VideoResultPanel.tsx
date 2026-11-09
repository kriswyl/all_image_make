import { useEffect, useState } from "react";
import {
  AlertCircle, Download, Eye, Film, LoaderCircle, RotateCcw, Square, X,
} from "lucide-react";
import { api } from "../api";
import { confirmGeneration } from "../generation-confirm";
import { LazyVideoThumb } from "../LazyVideoThumb";
import { StatusBadge, formatDuration, formatTime, statusLabels, terminalStatuses } from "../task-ui";
import type { Asset, Task } from "../../shared/types";
import { snapshotSummaryLines } from "../../shared/video-snapshot";
import { videoModeLabel } from "../../shared/video-modes";

/**
 * 结果区：一个大舞台 + 最近记录。
 *
 * 沿用上一版的播放器（竖屏用同画面模糊垫底、双击进剧场、多结果切页），
 * 补的是「本次参数」：来自任务落库的脱敏快照，之后的表单改动不会影响它；
 * 点「复用参数」把提示词与数值回填到创作框；素材不回收，会提示重新上传。
 */

export interface VideoResultPanelProps {
  task: Task | null;
  tasks: Task[];
  onDiagnostics: (task: Task) => void;
  onTask: (task: Task) => void;
  onSelectTask: (task: Task) => void;
  onReuse: (task: Task) => void;
  onToast: (kind: "success" | "error", message: string) => void;
}

export function VideoResultPanel({ task, tasks, onDiagnostics, onTask, onSelectTask, onReuse, onToast }: VideoResultPanelProps) {
  const busy = Boolean(task && !terminalStatuses.includes(task.status));
  const [downloadingAssetId, setDownloadingAssetId] = useState<string | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [theater, setTheater] = useState(false);
  const recentTasks = tasks
    .filter((item) => !terminalStatuses.includes(item.status) || item.errorCode === "VIDEO_TIMEOUT" || (item.status === "succeeded" && item.assets.length > 0))
    .slice(0, 12);
  const activeAsset = task?.assets.find((item) => item.id === selectedAssetId) ?? task?.assets[0] ?? null;
  // 竖屏视频两侧会空出大片版面，用画面自身的模糊放大图垫底
  const [portraitAssetId, setPortraitAssetId] = useState<string | null>(null);
  const snapshotLines = snapshotSummaryLines(task?.inputParameters, videoModeLabel(task?.inputParameters?.mode));

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
    const continueQuery = task.errorCode === "VIDEO_TIMEOUT";
    if (!continueQuery && !confirmGeneration({ kind: "视频生成", model: task.model, channel: task.channelName, retry: true })) return;
    try {
      onTask(await (continueQuery ? api.continueTaskQuery(task.id) : api.retry(task.id)));
      onToast("success", continueQuery ? "已继续查询原任务" : "已重新提交");
    } catch (error) { onToast("error", error instanceof Error ? error.message : "重试失败"); }
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
        <div><Film size={17} /><h2>本次结果</h2>{task ? <StatusBadge status={task.status} /> : null}</div>
        <div className="icon-actions">
          {task ? <button className="icon-button" title="查看诊断" onClick={() => onDiagnostics(task)}><Eye size={17} /></button> : null}
          {busy ? <button className="icon-button danger" title="取消任务" onClick={cancel}><Square size={16} /></button> : null}
        </div>
      </div>

      <div className={`result-stage ${activeAsset ? "has-image" : ""}`}>
        {!task ? <EmptyVideoResult /> : null}
        {task && busy ? (
          <div className="task-progress">
            <LoaderCircle className="spin" size={30} />
            <strong>{statusLabels[task.status]}</strong>
            {task.progress != null ? <div className="progress-track"><span style={{ width: `${task.progress}%` }} /></div> : null}
            <span>{task.model}</span>
            <small>视频生成通常需要 1 到 10 分钟</small>
          </div>
        ) : null}
        {task && task.status === "failed" ? (
          <div className="task-error"><AlertCircle size={30} /><strong>{task.errorCode === "VIDEO_TIMEOUT" ? "查询已暂停" : task.errorCode}</strong><span>{task.errorMessage}</span>
            {task.errorCode === "VIDEO_TIMEOUT" ? <button type="button" className="secondary-button" onClick={() => void retry()}>继续查询</button> : null}
          </div>
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

      {task?.inputParameters && snapshotLines.length ? (
        <div className="vstudio-snapshot">
          {snapshotLines.map((line) => <span className="vstudio-snapshot-item" key={line}>{line}</span>)}
          <button type="button" onClick={() => onReuse(task)}>复用参数</button>
        </div>
      ) : null}

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
              <button key={item.id} type="button" className={`recent-thumb ${item.id === task?.id ? "active" : ""}`} title={`${statusLabels[item.status]} · ${item.prompt}`} aria-label={`${statusLabels[item.status]}：${item.prompt}`} onClick={() => onSelectTask(item)}>
                {!terminalStatuses.includes(item.status) ? <LoaderCircle className="spin recent-task-icon" size={18} /> : item.assets[0] ? <LazyVideoThumb src={api.assetUrl(item.assets[0].url)} alt={item.prompt} /> : <AlertCircle className="recent-task-error" size={18} />}
                {item.status === "succeeded" && item.assets.length > 1 ? <span className="recent-thumb-count">{item.assets.length}</span> : null}
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

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
