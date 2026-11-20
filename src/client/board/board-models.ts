import { matchModelAlias } from "../../shared/model-alias";
import type { BoardAudioKind, ConfigBoardNode } from "../../shared/board";
import { VIDEO_DEFAULTS } from "../../shared/video-capabilities";
import { TTS_DEFAULT_VOICE } from "../../shared/tts";
import { SEEDREAM_ADAPTER, SEEDREAM_DEFAULT_SIZE } from "../../shared/seedream";

export interface BoardConfigModelSummary {
  model?: string;
  parameters?: string;
}

export interface BoardModelAlias {
  alias: string;
  model: string;
  channelName: string;
  channelId: string;
  adapterType: string;
  localVideoUploadConfigured?: boolean;
}

export function resolveBoardModel(aliases: readonly BoardModelAlias[], selected: string | undefined, preferred: string) {
  return matchModelAlias(aliases, selected) ?? matchModelAlias(aliases, preferred) ?? aliases[0];
}

export function boardAudioModels(aliases: readonly BoardModelAlias[], kind: BoardAudioKind = "speech") {
  const adapter = kind === "music" ? "suno-music" : "gemini-tts";
  return aliases.filter((alias) => alias.adapterType === adapter);
}

export function describeBoardConfigModel(node: ConfigBoardNode, alias: BoardModelAlias | undefined, defaultImageSize?: string): BoardConfigModelSummary {
  switch (node.mode) {
    case "image": {
      const size = alias?.adapterType === "gemini-content" ? node.imageSize ?? defaultImageSize
        : alias?.adapterType === SEEDREAM_ADAPTER ? (node.size ?? SEEDREAM_DEFAULT_SIZE).replace("x", "×")
        : alias?.adapterType === "openai-images" ? node.size?.replace("x", "×") : undefined;
      return { model: alias?.model, parameters: [size, `${node.count ?? 1} 张`].filter(Boolean).join(" · ") };
    }
    case "video": {
      const defaults = alias ? VIDEO_DEFAULTS[alias.adapterType] : undefined;
      const duration = node.durationSeconds ?? defaults?.duration;
      return { model: alias?.model, parameters: [node.resolution ?? defaults?.resolution, duration && `${duration} 秒`].filter(Boolean).join(" · ") };
    }
    case "audio":
      return { model: alias?.model, parameters: node.audioKind === "music" ? "音乐" : node.voice ?? TTS_DEFAULT_VOICE };
    case "text":
      return {};
  }
}
