import { useEffect, useRef } from "react";

/** 从剪贴板事件里挑出图片文件；同一个文件可能同时出现在 items 和 files 里，去重一次 */
export function imageFilesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const images: File[] = [];
  const seen = new Set<string>();
  const push = (file: File | null) => {
    if (!file || !file.type.startsWith("image/")) return;
    const key = `${file.type}:${file.size}:${file.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    images.push(file);
  };
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === "file") push(item.getAsFile());
  }
  if (!images.length) {
    for (const file of Array.from(data.files ?? [])) push(file);
  }
  return images;
}

/**
 * Ctrl+V 粘贴图片。
 *
 * 只在剪贴板里真的有图片时拦截：剪贴板是文字时照常让输入框粘贴文本。
 * 截图通常没有有意义的文件名，`useReferenceImages` 只要求 type/size 合规，所以不用改名。
 */
export function useImagePaste(onImages: (files: File[]) => void, enabled = true) {
  const handler = useRef(onImages);
  handler.current = onImages;

  useEffect(() => {
    if (!enabled) return;
    const onPaste = (event: ClipboardEvent) => {
      const images = imageFilesFromClipboard(event.clipboardData);
      if (!images.length) return;
      event.preventDefault();
      handler.current(images);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [enabled]);
}
