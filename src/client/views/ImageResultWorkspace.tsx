import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, Copy, Download, Eye, Image as ImageIcon, LoaderCircle, RotateCcw, Square, Wand2, X } from "lucide-react";
import { midjourneyButtonLabel, midjourneyUsableButtons, type MidjourneyButton } from "../../shared/midjourney";
import type { Asset, Task } from "../../shared/types";
import { api } from "../api";
import type { ReferenceController, Toast } from "../app-shared";
import { copyImageToClipboard } from "../clipboard";
import { confirmGeneration } from "../generation-confirm";
import { formatTime, StatusBadge, statusLabels, terminalStatuses } from "../task-ui";
import { MidjourneyActions } from "../ui/MidjourneyActions";

export function ImageResultWorkspace({ task, tasks, references, onDiagnostics, onTask, onSelectTask, onToast }: {
  task: Task | null; tasks: Task[]; references: ReferenceController;
  onDiagnostics: (task: Task) => void; onTask: (task: Task) => void; onSelectTask: (task: Task) => void; onToast: (kind: Toast["kind"], message: string) => void;
}) {
  const busy = task && !terminalStatuses.includes(task.status);
  const [downloadingAssetId, setDownloadingAssetId] = useState<string | null>(null);
  const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [actingCustomId, setActingCustomId] = useState<string | null>(null);
  const midjourneyButtons = task?.model === "mj_upscale"
    ? []
    : midjourneyUsableButtons(task?.remoteMeta?.midjourney?.buttons ?? []);
  const continueQuery = task?.errorCode === "VIDEO_TIMEOUT";
  /**
   * 预取当前结果图的字节。Ctrl+C 是用户手势，剪贴板写入要尽量在激活期内完成；
   * 等一次 fetch 再 write 有被浏览器判定「不是用户操作」的风险，所以先缓存。
   */
  const activeAssetBlob = useRef<{ id: string; blob: Blob } | null>(null);
  // 生成中的任务占据固定位置，完成后原位变成缩略图。
  const recentTasks = tasks.slice(0, 12);
  const activeAsset = task?.assets.find((item) => item.id === selectedAssetId) ?? task?.assets[0] ?? null;
  useEffect(() => { setSelectedAssetId(null); }, [task?.id]);
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
    if (!continueQuery && !confirmGeneration({ kind: "图片生成", model: task.model, channel: task.channelName, retry: true })) return;
    try {
      onTask(await (continueQuery ? api.continueTaskQuery(task.id) : api.retry(task.id)));
      onToast("success", continueQuery ? "已继续查询原任务" : "已重新提交");
    } catch (error) { onToast("error", error instanceof Error ? error.message : "重试失败"); }
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
    <section className="image-results" aria-label="图片生成结果">
      <nav className="image-history" aria-label="最近生成">
        <h2>最近生成</h2>
        <div className="image-history-list">
          {recentTasks.map((item) => {
            const pending = !terminalStatuses.includes(item.status);
            const label = `${statusLabels[item.status]}：${item.prompt}`;
            return (
              <button
                key={item.id}
                type="button"
                className="image-history-item"
                aria-current={item.id === task?.id ? "true" : undefined}
                title={`${label} · ${formatTime(item.createdAt)}`}
                aria-label={label}
                onClick={() => onSelectTask(item)}
              >
                {pending ? <LoaderCircle className="spin" size={19} />
                  : item.assets[0] ? <ImageThumbnail asset={item.assets[0]} />
                    : item.status === "succeeded" ? <ImageIcon size={19} /> : <AlertCircle size={19} />}
                {!pending && item.assets.length > 1 ? <span className="recent-thumb-count">{item.assets.length}</span> : null}
              </button>
            );
          })}
          {!recentTasks.length ? <span className="image-history-empty">暂无任务</span> : null}
        </div>
      </nav>

      <div className="image-preview-column">
        <div className="image-result-heading">
          <h2>生成结果</h2>
          {task ? <><StatusBadge status={task.status} /><span title={`${task.channelName} · ${formatTime(task.createdAt)}`}>{task.model}</span></> : null}
        </div>
        <div className={`result-stage image-result-stage ${activeAsset ? "has-image" : ""}`}>
          {activeAsset ? (
            <button className="image-preview-trigger" type="button" onClick={() => setPreviewAsset(activeAsset)} aria-label="放大预览图片">
              <img src={api.assetUrl(activeAsset.url)} alt="生成结果" />
            </button>
          ) : busy ? (
            <div className="task-progress" role="status">
              <LoaderCircle className="spin" size={26} />
              <strong>{statusLabels[task.status]}</strong>
              {task.progress != null ? <div className="progress-track"><span style={{ width: `${task.progress}%` }} /></div> : null}
              <span>{task.model}</span>
            </div>
          ) : task?.status === "failed" ? (
            <div className="task-error" role="status">
              <AlertCircle size={24} />
              <strong>{task.errorCode === "VIDEO_TIMEOUT" ? "查询已暂停" : task.errorCode || "生成失败"}</strong>
              {task.errorMessage ? <span>{task.errorMessage}</span> : null}
            </div>
          ) : (
            <div className="empty-result"><div className="empty-result-icon"><ImageIcon size={28} /></div><strong>{task?.status === "cancelled" ? "任务已取消" : "等待生成"}</strong></div>
          )}
        </div>
        {task && task.assets.length > 1 ? (
          <div className="stage-thumbs image-result-candidates" role="group" aria-label="本次生成结果">
            {task.assets.map((asset, index) => (
              <button
                key={asset.id}
                type="button"
                className={`stage-thumb ${asset.id === activeAsset?.id ? "active" : ""}`}
                aria-label={`结果 ${index + 1}`}
                aria-pressed={asset.id === activeAsset?.id}
                onClick={() => setSelectedAssetId(asset.id)}
              >
                <ImageThumbnail asset={asset} />
              </button>
            ))}
          </div>
        ) : null}
        {midjourneyButtons.length ? (
          <MidjourneyActions
            buttons={midjourneyButtons}
            busy={Boolean(actingCustomId)}
            activeId={actingCustomId}
            onAct={(button) => void midjourneyAct(button)}
            className="image-mj-actions"
          />
        ) : null}
      </div>
      {task ? (
        <div className="image-result-tools" role="group" aria-label="结果操作">
          {activeAsset ? (
            <>
              <button type="button" className="secondary-button" disabled={downloadingAssetId === activeAsset.id} onClick={() => void download(activeAsset)}>
                {downloadingAssetId === activeAsset.id ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}下载
              </button>
              <button type="button" className="secondary-button" disabled={copying} onClick={() => void copyActiveImage()} title="复制图片（Ctrl+C）">
                {copying ? <LoaderCircle className="spin" size={16} /> : <Copy size={16} />}复制
              </button>
              <button type="button" className="secondary-button" title="用作参考图" disabled={references.reading} onClick={() => void references.addFromAsset(activeAsset)}><Wand2 size={16} />参考</button>
            </>
          ) : null}
          {busy ? <button type="button" className="secondary-button" title="取消任务" onClick={() => void cancel()}><Square size={16} />取消</button>
            : activeAsset || task.status === "failed" || task.status === "cancelled" ? (
              <button type="button" className="secondary-button" title={continueQuery ? "继续查询" : "按原参数重新生成"} onClick={() => void retry()}>
                <RotateCcw size={16} />{continueQuery ? "续查" : "重绘"}
              </button>
            ) : null}
          <button type="button" className="secondary-button" onClick={() => onDiagnostics(task)}><Eye size={16} />诊断</button>
        </div>
      ) : null}
      {previewAsset ? (
        <div className="image-preview-backdrop" role="dialog" aria-modal="true" aria-label="图片预览" onMouseDown={(event) => { if (event.target === event.currentTarget) setPreviewAsset(null); }}>
          <div className="image-preview">
            <img src={api.assetUrl(previewAsset.url)} alt="生成结果放大预览" />
            <button type="button" className="image-preview-close" aria-label="关闭预览" onClick={() => setPreviewAsset(null)}><X size={21} /></button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ImageThumbnail({ asset }: { asset: Asset }) {
  const originalUrl = api.assetUrl(asset.url);
  const thumbnailUrl = asset.thumbUrl ? api.assetUrl(asset.thumbUrl) : originalUrl;
  return <img
    src={thumbnailUrl}
    alt=""
    loading="lazy"
    decoding="async"
    onError={(event) => {
      if (event.currentTarget.getAttribute("src") !== originalUrl) event.currentTarget.src = originalUrl;
    }}
  />;
}


