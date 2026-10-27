import { api } from "../api";
import type { Asset } from "../../shared/types";

/**
 * 在浏览器里截取视频最后一帧，作为续写镜头的首帧。
 *
 * 不依赖 ffmpeg：把视频下载成同源 blob，再用 `<video>` seek 到结尾、画进 canvas。
 * 用 blob 而不是直接给 video 一个跨域 URL，是为了避免 canvas 被 taint 后导不出 PNG。
 */
export async function extractVideoLastFrame(asset: Asset, shotIndex: number): Promise<File> {
  const response = await fetch(api.assetUrl(asset.url));
  if (!response.ok) throw new Error(`读取视频失败：HTTP ${response.status}`);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = objectUrl;

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("读取视频超时，暂时取不到尾帧")), 15_000);
      const ready = () => { window.clearTimeout(timeout); resolve(); };
      const failed = () => { window.clearTimeout(timeout); reject(new Error("浏览器无法解码这段视频，暂时取不到尾帧")); };
      video.addEventListener("loadeddata", ready, { once: true });
      video.addEventListener("error", failed, { once: true });
      video.load();
    });

    if (!video.videoWidth || !video.videoHeight) {
      throw new Error("视频没有可用画面，暂时取不到尾帧");
    }

    const duration = Number.isFinite(video.duration)
      ? video.duration
      : video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0;
    if (duration > 0) {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error("读取视频尾帧超时")), 10_000);
        const seeked = () => { window.clearTimeout(timeout); resolve(); };
        const failed = () => { window.clearTimeout(timeout); reject(new Error("读取视频尾帧失败")); };
        video.addEventListener("seeked", seeked, { once: true });
        video.addEventListener("error", failed, { once: true });
        video.currentTime = Math.max(0, duration - 0.08);
      });
    }

    // seeked 之后等一帧，部分解码器这时画布上还是旧画面
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建画布，取不到尾帧");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!frame) throw new Error("尾帧导出失败");
    return new File(
      [frame],
      `continuation-${shotIndex}-${Date.now()}.png`,
      { type: "image/png" },
    );
  } finally {
    video.pause();
    video.src = "";
    URL.revokeObjectURL(objectUrl);
  }
}
