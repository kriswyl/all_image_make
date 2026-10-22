import { X } from "lucide-react";
import { api } from "../api";
import { assetRef } from "../../shared/agent-types";
import type { Asset } from "../../shared/types";

/** 对话里的结果预览：图片 / 视频 / 音乐（含歌词） */
export function AssetLightbox({
  assetId,
  asset,
  onClose,
}: {
  assetId: string;
  asset: Asset | null;
  onClose: () => void;
}) {
  const isAudio = asset?.mimeType.startsWith("audio/") ?? false;
  const isVideo = asset?.mimeType.startsWith("video/") ?? false;
  return (
    <div className="chat-lightbox" onClick={onClose} role="presentation">
      <div className="chat-lightbox-body" onClick={(event) => event.stopPropagation()}>
        {isAudio ? (
          <div className="chat-audio-lightbox">
            {asset?.thumbUrl ? <img src={api.assetUrl(asset.thumbUrl)} alt="" /> : null}
            <strong>{asset?.title || "音乐"}</strong>
            <audio src={api.assetUrl(`/api/assets/${assetId}/file`)} controls autoPlay />
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
            controls autoPlay loop playsInline disablePictureInPicture disableRemotePlayback
          />
        ) : (
          <img src={api.assetUrl(`/api/assets/${assetId}/file`)} alt="" />
        )}
        <div className="chat-lightbox-bar">
          <span>{assetRef(assetId)}{asset ? ` · ${asset.fileName}` : ""}</span>
          <button type="button" className="icon-button compact" onClick={onClose} title="关闭">
            <X size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
