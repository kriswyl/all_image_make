import { useEffect, useRef, useState } from "react";
import { referenceImageMimeType, type ReferenceImageState, type Toast } from "../app-shared";
import { MAX_REFERENCE_IMAGE_BYTES } from "../../shared/types";

/**
 * 按「渠道:模式」分桶的素材状态。
 *
 * 之前整个页面只有一份参考图数组，切模式时靠 `clear()` 抹掉——
 * 用户切去首尾帧看一眼再切回来，素材就全没了。这里给每个模式一个桶：
 * 切模式只是换一个键读写，其他桶原封不动。
 *
 * 文件本身没法进 localStorage，所以桶只在内存里；刷新页面后图片需要重选，
 * 提示词/参数/手填 URL 由 VideoDraft 持久化。
 */

export interface LocalVideoFile {
  file: File;
  duration: number;
  /** 本地预览用的 objectURL，由 hook 负责回收 */
  previewUrl: string;
}

export interface LocalAudioFile {
  file: File;
  duration: number;
}

export interface MediaBucket {
  images: ReferenceImageState[];
  video: LocalVideoFile | null;
  audio: LocalAudioFile | null;
}

const EMPTY_BUCKET: MediaBucket = { images: [], video: null, audio: null };

export interface MediaBucketsController {
  reading: boolean;
  get: (key: string) => MediaBucket;
  addImages: (key: string, files: File[], limit: number) => boolean;
  removeImage: (key: string, previewUrl: string) => void;
  clearImages: (key: string) => void;
  setVideo: (key: string, file: File, duration: number) => void;
  clearVideo: (key: string) => void;
  setAudio: (key: string, file: File, duration: number) => void;
  clearAudio: (key: string) => void;
}

export function useMediaBuckets(onToast: (kind: Toast["kind"], message: string) => void): MediaBucketsController {
  const [buckets, setBuckets] = useState<Record<string, MediaBucket>>({});
  const [reading, setReading] = useState(false);
  const objectUrls = useRef(new Set<string>());

  useEffect(() => () => {
    objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.current.clear();
  }, []);

  function createUrl(file: File) {
    const url = URL.createObjectURL(file);
    objectUrls.current.add(url);
    return url;
  }

  function releaseUrl(url: string | undefined) {
    if (!url) return;
    URL.revokeObjectURL(url);
    objectUrls.current.delete(url);
  }

  function patch(key: string, mutate: (bucket: MediaBucket) => MediaBucket) {
    setBuckets((current) => {
      const base = current[key] ?? EMPTY_BUCKET;
      return { ...current, [key]: mutate(base) };
    });
  }

  function get(key: string): MediaBucket {
    return buckets[key] ?? EMPTY_BUCKET;
  }

  function addImages(key: string, files: File[], limit: number): boolean {
    if (!files.length) return false;
    const bucket = get(key);
    if (limit <= 0) { onToast("error", "当前模式不接受参考图"); return false; }
    const room = limit - bucket.images.length;
    if (files.length > room) { onToast("error", `当前模式最多 ${limit} 张图，还可添加 ${Math.max(0, room)} 张`); return false; }
    const prepared = files.map((file) => ({ file, mimeType: referenceImageMimeType(file) }));
    if (prepared.some((item) => !item.mimeType)) { onToast("error", "仅支持 PNG、JPEG 或 WebP 参考图"); return false; }
    if (files.some((file) => file.size > MAX_REFERENCE_IMAGE_BYTES)) { onToast("error", "单张参考图不能超过 20 MB"); return false; }
    const additions = prepared.map(({ file }) => ({ file, previewUrl: createUrl(file) }));
    patch(key, (current) => ({ ...current, images: [...current.images, ...additions] }));
    return true;
  }

  function removeImage(key: string, previewUrl: string) {
    releaseUrl(previewUrl);
    patch(key, (current) => ({ ...current, images: current.images.filter((item) => item.previewUrl !== previewUrl) }));
  }

  function clearImages(key: string) {
    const bucket = get(key);
    bucket.images.forEach((item) => releaseUrl(item.previewUrl));
    patch(key, (current) => ({ ...current, images: [] }));
  }

  function setVideo(key: string, file: File, duration: number) {
    const bucket = get(key);
    releaseUrl(bucket.video?.previewUrl);
    const previewUrl = createUrl(file);
    patch(key, (current) => ({ ...current, video: { file, duration, previewUrl } }));
  }

  function clearVideo(key: string) {
    const bucket = get(key);
    releaseUrl(bucket.video?.previewUrl);
    patch(key, (current) => ({ ...current, video: null }));
  }

  function setAudio(key: string, file: File, duration: number) {
    patch(key, (current) => ({ ...current, audio: { file, duration } }));
  }

  function clearAudio(key: string) {
    patch(key, (current) => ({ ...current, audio: null }));
  }

  return {
    reading,
    get,
    addImages: (key, files, limit) => {
      setReading(true);
      try { return addImages(key, files, limit); } finally { setReading(false); }
    },
    removeImage,
    clearImages,
    setVideo,
    clearVideo,
    setAudio,
    clearAudio,
  };
}
