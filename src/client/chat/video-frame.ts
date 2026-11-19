import { api } from "../api";
import { MAX_REFERENCE_IMAGES, type Asset } from "../../shared/types";
import { MAX_OVERVIEW_FRAME_CHARS, videoOverviewSampleTimes, type VideoOverviewFrames } from "../../shared/media-review";

function waitForVideo(video: HTMLVideoElement, event: "loadedmetadata" | "loadeddata" | "seeked", start: () => void, timeoutMs: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      window.clearTimeout(timeout);
      video.removeEventListener(event, ready);
      video.removeEventListener("error", failed);
      signal?.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    };
    const ready = () => finish();
    const failed = () => finish(new Error("应用无法解码这段视频"));
    const aborted = () => finish(signal?.reason ?? new DOMException("已停止", "AbortError"));
    const timeout = window.setTimeout(() => finish(new DOMException("读取视频画面超时", "TimeoutError")), timeoutMs);
    video.addEventListener(event, ready, { once: true });
    video.addEventListener("error", failed, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
    try { start(); } catch (error) { finish(error); }
  });
}

/** 在已能播放的本地素材上均匀取样。媒体元素可按需读取区间，素材文件仍留在本地。 */
export async function extractVideoOverview(url: string, signal: AbortSignal): Promise<VideoOverviewFrames> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.src = url;
  try {
    await waitForVideo(video, "loadedmetadata", () => video.load(), 12_000, signal);
    const durationMs = Math.round(video.duration * 1000);
    if (!Number.isSafeInteger(durationMs) || durationMs < 1 || !video.videoWidth || !video.videoHeight) {
      return { ok: false, reason: "unreadable" };
    }
    const samples = videoOverviewSampleTimes(durationMs);
    // 兼顾长片的时间覆盖与对话渠道一次接收的图片数。长片将相邻帧横向排在一张图上。
    const perSheet = Math.ceil(samples.length / MAX_REFERENCE_IMAGES);
    const scale = Math.min(1, 480 / Math.max(video.videoWidth, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    const sheets: Extract<VideoOverviewFrames, { ok: true }>["sheets"] = [];
    for (let start = 0; start < samples.length; start += perSheet) {
      const positions = samples.slice(start, start + perSheet);
      const canvas = document.createElement("canvas");
      canvas.width = width * positions.length;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return { ok: false, reason: "unreadable" };
      const timesMs: number[] = [];
      for (const time of positions) {
        signal.throwIfAborted();
        const seconds = time / 1000;
        try {
          if (video.currentTime !== seconds || video.seeking) {
            await waitForVideo(video, "seeked", () => { video.currentTime = seconds; }, 4_000, signal);
          } else if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            await waitForVideo(video, "loadeddata", () => { video.preload = "auto"; }, 4_000, signal);
          }
        } catch {
          signal.throwIfAborted();
          if (video.error) break;
          continue;
        }
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) continue;
        ctx.drawImage(video, timesMs.length * width, 0, width, height);
        timesMs.push(time);
      }
      if (timesMs.length) {
        const fullQuality = canvas.toDataURL("image/jpeg", 0.78);
        const jpeg = fullQuality.length <= MAX_OVERVIEW_FRAME_CHARS ? fullQuality : canvas.toDataURL("image/jpeg", 0.55);
        if (jpeg.startsWith("data:image/jpeg;base64,") && jpeg.length <= MAX_OVERVIEW_FRAME_CHARS) sheets.push({ timesMs, jpeg });
      }
      if (video.error) break;
    }
    return sheets.length ? { ok: true, durationMs, planned: samples.length, sheets } : { ok: false, reason: "empty" };
  } catch (error) {
    signal.throwIfAborted();
    return { ok: false, reason: error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "unreadable" };
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
  }
}

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
    await waitForVideo(video, "loadeddata", () => video.load(), 15_000);

    if (!video.videoWidth || !video.videoHeight) {
      throw new Error("视频没有可用画面，暂时取不到尾帧");
    }

    const duration = Number.isFinite(video.duration)
      ? video.duration
      : video.seekable.length ? video.seekable.end(video.seekable.length - 1) : 0;
    if (duration > 0) {
      const target = Math.max(0, duration - 0.08);
      if (video.currentTime !== target || video.seeking) {
        await waitForVideo(video, "seeked", () => { video.currentTime = target; }, 10_000);
      }
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
