import type { TaskInputSnapshot } from "./video-snapshot.js";

export type VideoReuseKind = "image" | "video" | "audio";

export interface VideoReuseSlot {
  index: number;
  kind: VideoReuseKind;
  role: string;
  name: string;
  mimeType?: string;
  available: boolean;
  reason?: string;
}

export interface VideoTaskReuse {
  snapshot: TaskInputSnapshot;
  slots: VideoReuseSlot[];
  timeoutMs?: number;
  orientation?: "image" | "video";
  multiShot?: boolean;
  inlineAudio: boolean;
  rawParameters: Record<string, unknown>;
  omittedRawFields: string[];
  unsupportedReason?: string;
}
