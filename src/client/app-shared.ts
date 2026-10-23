import type { Asset } from "../shared/types";

/** 应用外壳和工作台共用的轻量类型，避免所有组件都反过来 import App.tsx */
export type Toast = { kind: "success" | "error"; message: string };
export type View = "generate" | "video" | "music" | "speech" | "chat" | "channels" | "history";

export type ReferenceImageState = { file: File; previewUrl: string };

export interface ReferenceController {
  images: ReferenceImageState[];
  reading: boolean;
  select: (event: React.ChangeEvent<HTMLInputElement>) => void;
  /** 拖拽落图：与文件选择框走同一条校验路径 */
  dropFiles: (files: File[]) => void;
  remove: (previewUrl: string) => void;
  clear: () => void;
  addFromAsset: (asset: Asset) => Promise<void>;
}

export interface InpaintMaskState {
  file: File;
  /** 「原图 + 红色涂抹」缩略图，由 hook 负责 revoke */
  previewUrl: string;
  /** 蒙版绑定的参考图预览地址；底图一换，蒙版就作废 */
  sourcePreviewUrl: string;
}

export interface InpaintMaskController {
  mask: InpaintMaskState | null;
  apply: (file: File, previewUrl: string) => void;
  clear: () => void;
}

export function referenceImageMimeType(file: File): "image/png" | "image/jpeg" | "image/webp" | null {
  if (file.type === "image/png" || file.type === "image/jpeg" || file.type === "image/webp") return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  return null;
}
