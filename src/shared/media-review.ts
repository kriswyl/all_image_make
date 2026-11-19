import { z } from "zod";
import { MAX_REFERENCE_IMAGES } from "./types.js";

export const MAX_OVERVIEW_SAMPLES = 24;
export const MAX_OVERVIEW_FRAME_CHARS = 220_000;

const timeMs = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const overviewSheetSchema = z.object({
  timesMs: z.array(timeMs).min(1).max(3),
  jpeg: z.string().max(MAX_OVERVIEW_FRAME_CHARS).regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/),
}).strict();

export const videoOverviewFramesSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), durationMs: timeMs.min(1), planned: z.number().int().min(1).max(MAX_OVERVIEW_SAMPLES),
    sheets: z.array(overviewSheetSchema).min(1).max(MAX_REFERENCE_IMAGES) }).strict(),
  z.object({ ok: z.literal(false), reason: z.enum(["unreadable", "timeout", "empty"]) }).strict(),
]);
export type VideoOverviewFrames = z.infer<typeof videoOverviewFramesSchema>;
export interface VideoOverviewRequest {
  type: "video_overview_frames";
  requestId: string;
  assetId: string;
}

export const videoOverviewSchema = z.object({
  assetId: z.string(),
  title: z.string(),
  durationMs: timeMs.min(1),
  planned: z.number().int().positive(),
  timesMs: z.array(timeMs).min(1).max(MAX_OVERVIEW_SAMPLES),
});
export type VideoOverview = z.infer<typeof videoOverviewSchema>;

export function videoOverviewSampleTimes(durationMs: number) {
  const count = Math.min(durationMs, durationMs <= 120_000 ? 8 : durationMs <= 480_000 ? 16 : MAX_OVERVIEW_SAMPLES);
  return Array.from({ length: count }, (_, index) => Math.floor(durationMs * (index + 0.5) / count));
}

export const mediaReviewSegmentSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  frameTimesMs: z.array(z.number().int().nonnegative()),
  visual: z.string().optional(),
  speech: z.array(z.object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().positive(), text: z.string() })).optional(),
  speechSource: z.enum(["subtitles", "transcript"]).optional(),
  visualIssue: z.string().optional(),
  audioIssue: z.string().optional(),
  pending: z.boolean().optional(),
});

export const mediaReviewSchema = z.object({
  assetId: z.string(),
  title: z.string(),
  kind: z.enum(["video", "audio"]),
  version: z.string(),
  detail: z.boolean(),
  tracks: z.enum(["all", "visual", "dialogue"]),
  durationMs: z.number().int().positive(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  segments: z.array(mediaReviewSegmentSchema),
});

export type MediaReview = z.infer<typeof mediaReviewSchema>;
export function mediaTime(ms: number, milliseconds = false) {
  const seconds = Math.floor(ms / 1000);
  const minute = Math.floor(seconds / 60);
  const clock = `${String(minute).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return milliseconds ? `${clock}.${String(ms % 1000).padStart(3, "0")}` : clock;
}
