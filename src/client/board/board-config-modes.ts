import { AudioLines, FileText, Image, Video } from "lucide-react";

export const BOARD_CONFIG_MODES = {
  image: { label: "图片", icon: Image },
  video: { label: "视频", icon: Video },
  audio: { label: "音频", icon: AudioLines },
  text: { label: "文本", icon: FileText },
} as const;
