import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import {
  referenceImageMimeType,
  type InpaintMaskController,
  type InpaintMaskState,
  type ReferenceController,
  type ReferenceImageState,
  type Toast,
} from "../app-shared";
import { MAX_REFERENCE_IMAGES, MAX_REFERENCE_IMAGE_BYTES, type Asset } from "../../shared/types";

/** 参考图状态提升到 App，切换视图时不被卸载清空，并可从生成结果/历史中追加 */
export function useReferenceImages(onToast: (kind: Toast["kind"], message: string) => void): ReferenceController {
  const [images, setImages] = useState<ReferenceImageState[]>([]);
  const [reading, setReading] = useState(false);
  const referenceUrls = useRef(new Set<string>());

  useEffect(() => () => {
    referenceUrls.current.forEach((url) => URL.revokeObjectURL(url));
    referenceUrls.current.clear();
  }, []);

  function addFiles(files: File[]): boolean {
    if (!files.length) return false;
    const remaining = MAX_REFERENCE_IMAGES - images.length;
    if (files.length > remaining) { onToast("error", `参考图最多上传 ${MAX_REFERENCE_IMAGES} 张`); return false; }
    const prepared = files.map((file) => ({ file, mimeType: referenceImageMimeType(file) }));
    if (prepared.some((item) => !item.mimeType)) { onToast("error", "仅支持 PNG、JPEG 或 WebP 参考图"); return false; }
    if (files.some((file) => file.size > MAX_REFERENCE_IMAGE_BYTES)) { onToast("error", "单张参考图不能超过 10 MB"); return false; }
    const nextImages = prepared.map(({ file }) => {
      const previewUrl = URL.createObjectURL(file);
      referenceUrls.current.add(previewUrl);
      return { file, previewUrl };
    });
    setImages((current) => [...current, ...nextImages]);
    return true;
  }

  function select(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    setReading(true);
    try { addFiles(files); } finally { setReading(false); }
  }

  function dropFiles(files: File[]) {
    if (!files.length) return;
    setReading(true);
    try {
      if (addFiles(files)) onToast("success", `已加入 ${files.length} 张参考图`);
    } finally {
      setReading(false);
    }
  }

  function remove(previewUrl: string) {
    URL.revokeObjectURL(previewUrl);
    referenceUrls.current.delete(previewUrl);
    setImages((current) => current.filter((item) => item.previewUrl !== previewUrl));
  }

  function clear() {
    images.forEach((item) => {
      URL.revokeObjectURL(item.previewUrl);
      referenceUrls.current.delete(item.previewUrl);
    });
    setImages([]);
  }

  async function addFromAsset(asset: Asset) {
    if (images.length >= MAX_REFERENCE_IMAGES) { onToast("error", `参考图最多上传 ${MAX_REFERENCE_IMAGES} 张`); return; }
    setReading(true);
    try {
      const file = await api.assetAsFile(asset);
      if (addFiles([file])) onToast("success", "已加入参考图");
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "无法读取图片");
    } finally {
      setReading(false);
    }
  }

  return { images, reading, select, dropFiles, remove, clear, addFromAsset };
}

/**
 * 局部重绘蒙版的状态。
 *
 * 和参考图一样放在 App 层，切换视图不会丢；但生命周期更短：
 * 只认「当前这张底图」。底图一变，旧蒙版自动作废。
 */
export function useInpaintMask(sourcePreviewUrl: string | null): InpaintMaskController {
  const [mask, setMask] = useState<InpaintMaskState | null>(null);
  const latestMask = useRef<InpaintMaskState | null>(null);
  latestMask.current = mask;

  const clear = useCallback(() => {
    setMask((current) => {
      if (current) URL.revokeObjectURL(current.previewUrl);
      return null;
    });
  }, []);

  const apply = useCallback((file: File, previewUrl: string) => {
    if (!sourcePreviewUrl) {
      URL.revokeObjectURL(previewUrl);
      return;
    }
    setMask((current) => {
      if (current) URL.revokeObjectURL(current.previewUrl);
      return { file, previewUrl, sourcePreviewUrl };
    });
  }, [sourcePreviewUrl]);

  useEffect(() => {
    setMask((current) => {
      if (!current) return null;
      if (sourcePreviewUrl && current.sourcePreviewUrl === sourcePreviewUrl) return current;
      URL.revokeObjectURL(current.previewUrl);
      return null;
    });
  }, [sourcePreviewUrl]);

  useEffect(() => () => {
    if (latestMask.current) URL.revokeObjectURL(latestMask.current.previewUrl);
  }, []);

  return { mask, apply, clear };
}
