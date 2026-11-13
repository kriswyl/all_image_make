import type { Asset, MusicMode, Task } from "./types.js";

export const SUNO_DAMOBI_MODEL = "suno_damobi_music";
export const SUNO_V6_DEFAULT = "chirp-hawk";
export const SUNO_V6_VERSIONS = [
  { value: SUNO_V6_DEFAULT, label: "v6" },
  { value: "chirp-hawk-wild", label: "v6-wild" },
  { value: "chirp-goose", label: "v6-mini" },
] as const;
export const SUNO_TARGET_DURATIONS = [45, 60] as const;
export const MUSIC_MODE_LABELS: Record<MusicMode, string> = {
  inspiration: "灵感创作", custom: "自定义歌词", cover: "翻唱", mashup: "混音",
  sound: "音效", playlist: "歌单风格", sample: "取样",
};

export interface SunoTrackInfo {
  model?: string;
  version?: string;
  task?: string;
  sound?: { tempo?: number; key?: string; loop?: boolean };
  controls?: { styleWeight?: number; weirdness?: number };
}

export interface SunoTaskMeta {
  remoteIds?: string[];
  tracks?: Array<SunoTrackInfo & { clipId: string }>;
  warning?: string;
}

export interface SunoSourceSelection {
  mode: "cover" | "mashup";
  task: Task;
  asset: Asset;
}

export function isSunoV6Version(value: string | undefined) {
  return SUNO_V6_VERSIONS.some((option) => option.value === value);
}

export function sunoResultLabel(info?: SunoTrackInfo) {
  if (info?.model === "chirp-sfx") return "Suno 音效";
  const version = info?.version || SUNO_V6_VERSIONS.find((option) => option.value === info?.model)?.label || info?.model;
  return version ? "Suno " + version : undefined;
}

export function sunoTrackInfo(task: Task | null | undefined, clipId: string | null | undefined) {
  return clipId ? task?.remoteMeta?.suno?.tracks?.find((item) => item.clipId === clipId) : undefined;
}

export function isSunoSong(task: Task, asset: Asset) {
  const info = sunoTrackInfo(task, asset.remoteClipId);
  return Boolean(asset.remoteClipId) && asset.mimeType.startsWith("audio/")
    && task.effectiveParameters?.task !== "sound" && info?.task !== "sound" && info?.model !== "chirp-sfx";
}
