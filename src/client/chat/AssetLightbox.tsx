import { Download, LoaderCircle, X } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { assetRef } from "../../shared/agent-types";
import type { Asset } from "../../shared/types";

/** 对话里的结果预览：图片 / 视频 / 音乐（含歌词） */
export function AssetLightbox({
  assetId,
  asset,
  onClose,
  onToast,
  onSetFirst,
  onSetLast,
  onAddToCanvas,
  onRemoveFromCanvas,
  inCanvas = false,
}: {
  assetId: string;
  asset: Asset | null;
  onClose: () => void;
  onToast?: (kind: "ok" | "error", text: string) => void;
  /** 图片可以直接设为首帧 / 尾帧 / 加入画布；故事板里的灯箱不传这些 */
  onSetFirst?: (assetId: string) => void;
  onSetLast?: (assetId: string) => void;
  onAddToCanvas?: (assetId: string) => void;
  onRemoveFromCanvas?: (assetId: string) => void;
  inCanvas?: boolean;
}) {
  const [downloading, setDownloading] = useState(false);
  const isAudio = asset?.mimeType.startsWith("audio/") ?? false;
  const isVideo = asset?.mimeType.startsWith("video/") ?? false;

  async function download() {
    if (!asset || downloading) return;
    setDownloading(true);
    try {
      if (await api.downloadAsset(asset)) onToast?.("ok", "已保存");
    } catch (error) {
      onToast?.("error", error instanceof Error ? error.message : "下载失败");
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="chat-lightbox" onClick={onClose} role="presentation">
      <div className="chat-lightbox-body" onClick={(event) => event.stopPropagation()}>
        {isAudio ? (
          <div className="chat-audio-lightbox">
            {asset?.thumbUrl ? <img src={api.assetUrl(asset.thumbUrl)} alt="" /> : null}
            <strong>{asset?.title || "音乐"}</strong>
            <audio src={api.assetUrl(`/api/assets/${assetId}/file`)} controls controlsList="nodownload" autoPlay onContextMenu={(event) => event.preventDefault()} />
            {asset?.lyrics ? (
              <details className="music-lyrics chat-lyrics">
                <summary>歌词</summary>
                <pre>{asset.lyrics}</pre>
              </details>
            ) : null}
          </div>
        ) : isVideo ? (
          // 视频只能交给浏览器解码：服务端缩略图走 jimp，喂给它视频会直接 404
          <video
            src={api.assetUrl(`/api/assets/${assetId}/file`)}
            controls controlsList="nodownload" autoPlay loop playsInline disablePictureInPicture disableRemotePlayback
            onContextMenu={(event) => event.preventDefault()}
          />
        ) : (
          <img src={api.assetUrl(`/api/assets/${assetId}/file`)} alt="" />
        )}
        <div className="chat-lightbox-bar">
          <span>{assetRef(assetId)}{asset ? ` · ${asset.fileName}` : ""}</span>
          <div className="chat-lightbox-actions">
            {!isAudio && !isVideo && onSetFirst ? (
              <button type="button" className="secondary-button" onClick={() => onSetFirst(assetId)} title="放到画布第 1 张（生视频首帧）">
                设为首帧
              </button>
            ) : null}
            {!isAudio && !isVideo && onSetLast ? (
              <button type="button" className="secondary-button" onClick={() => onSetLast(assetId)} title="放到画布第 2 张（生视频尾帧）">
                设为尾帧
              </button>
            ) : null}
            {!isAudio && !isVideo && onAddToCanvas && !inCanvas ? (
              <button type="button" className="secondary-button" onClick={() => onAddToCanvas(assetId)} title="加入当前画布">
                加入画布
              </button>
            ) : null}
            {!isAudio && !isVideo && onRemoveFromCanvas && inCanvas ? (
              <button type="button" className="secondary-button" onClick={() => onRemoveFromCanvas(assetId)} title="从当前画布移出">
                移出画布
              </button>
            ) : null}
            <button
              type="button"
              className="secondary-button"
              onClick={() => void download()}
              disabled={!asset || downloading}
              title="下载到本地"
            >
              {downloading ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}
              下载
            </button>
            <button type="button" className="icon-button compact" onClick={onClose} title="关闭">
              <X size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
