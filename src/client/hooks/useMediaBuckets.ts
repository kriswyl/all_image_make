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
  /** 桶内唯一 id：移除、@ 引用、分页都靠它，文件名重复也不会串 */
  id: string;
  file: File;
  duration: number;
  /** 本地预览用的 objectURL，由 hook 负责回收 */
  previewUrl: string;
}

export interface LocalAudioFile {
  id: string;
  file: File;
  duration: number;
}

export interface MediaBucket {
  images: ReferenceImageState[];
  /** 参考视频可以有多段（Seedance 2.0 三段、2.5 十段），万相/可灵只有一段 */
  videos: LocalVideoFile[];
  audios: LocalAudioFile[];
}

const EMPTY_BUCKET: MediaBucket = { images: [], videos: [], audios: [] };

export interface MediaBucketsController {
  reading: boolean;
  get: (key: string) => MediaBucket;
  addImages: (key: string, files: File[], limit: number) => boolean;
  removeImage: (key: string, previewUrl: string) => void;
  clearImages: (key: string) => void;
  addVideo: (key: string, file: File, duration: number, limit: number) => boolean;
  removeVideo: (key: string, id: string) => void;
  addAudio: (key: string, file: File, duration: number, limit: number) => boolean;
  removeAudio: (key: string, id: string) => void;
}

export function useMediaBuckets(onToast: (kind: Toast["kind"], message: string) => void): MediaBucketsController {
  // 状态只用来触发重渲染，真正的数据在 bucketsRef 里（见下面注释）
  const [, setBuckets] = useState<Record<string, MediaBucket>>({});
  const [reading, setReading] = useState(false);
  const objectUrls = useRef(new Set<string>());
  /**
   * 和 `buckets` 并存的镜像。
   *
   * 一次选好几个文件时（多段额度下多选上传），同一个事件里会连着调好几次
   * `addVideo`——这时 `buckets` 还是这次渲染的旧值，第二段看到的第一段还没进去，
   * 既可能超额度，生成的 id 也会撞成同一个。所有读写都先落到这个 ref 上，
   * 同一次回调里的连续调用就能看到彼此的结果。
   */
  const bucketsRef = useRef<Record<string, MediaBucket>>({});

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

  function commit(key: string, next: MediaBucket) {
    bucketsRef.current = { ...bucketsRef.current, [key]: next };
    setBuckets((current) => ({ ...current, [key]: next }));
  }

  function patch(key: string, mutate: (bucket: MediaBucket) => MediaBucket) {
    commit(key, mutate(get(key)));
  }

  function get(key: string): MediaBucket {
    return bucketsRef.current[key] ?? EMPTY_BUCKET;
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

  /**
   * 加一段参考视频。
   *
   * 只有一个额度时（万相 / 可灵）再选就是**替换**——否则用户得先删掉旧的才换得了，
   * 看起来就像「只能上传一次」。多段额度（Seedance）满了就直说，让用户自己挑一段删。
   */
  function addVideo(key: string, file: File, duration: number, limit: number): boolean {
    const bucket = get(key);
    if (limit <= 0) { onToast("error", "当前模式不接受参考视频"); return false; }
    if (bucket.videos.length >= limit && limit > 1) {
      onToast("error", `当前模式最多 ${limit} 段参考视频，先移除一段再换`);
      return false;
    }
    const entry: LocalVideoFile = { id: `video-${Date.now()}-${bucket.videos.length}`, file, duration, previewUrl: createUrl(file) };
    const replaceSingle = limit === 1 && bucket.videos.length >= 1;
    if (replaceSingle) releaseUrl(bucket.videos[0]?.previewUrl);
    patch(key, (current) => ({
      ...current,
      videos: replaceSingle ? [entry] : [...current.videos, entry],
    }));
    return true;
  }

  function removeVideo(key: string, id: string) {
    const bucket = get(key);
    releaseUrl(bucket.videos.find((item) => item.id === id)?.previewUrl);
    patch(key, (current) => ({ ...current, videos: current.videos.filter((item) => item.id !== id) }));
  }

  function addAudio(key: string, file: File, duration: number, limit: number): boolean {
    const bucket = get(key);
    if (limit <= 0) { onToast("error", "当前模式不接受参考音频"); return false; }
    if (bucket.audios.length >= limit && limit > 1) {
      onToast("error", `当前模式最多 ${limit} 段参考音频，先移除一段再换`);
      return false;
    }
    const entry: LocalAudioFile = { id: `audio-${Date.now()}-${bucket.audios.length}`, file, duration };
    const replaceSingle = limit === 1 && bucket.audios.length >= 1;
    patch(key, (current) => ({
      ...current,
      audios: replaceSingle ? [entry] : [...current.audios, entry],
    }));
    return true;
  }

  function removeAudio(key: string, id: string) {
    patch(key, (current) => ({ ...current, audios: current.audios.filter((item) => item.id !== id) }));
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
    addVideo,
    removeVideo,
    addAudio,
    removeAudio,
  };
}
