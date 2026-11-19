import type { VideoOverviewRequest } from "../../shared/media-review";
import { api, ApiError } from "../api";
import { extractVideoOverview } from "./video-frame";

const requests = new Map<string, { conversationId: string; controller: AbortController }>();

/** 抽帧请求可在事件流重连时重发，客户端和后端都按请求 ID 去重。 */
export async function respondToVideoOverview(conversationId: string, event: VideoOverviewRequest) {
  if (requests.has(event.requestId)) return;
  const controller = new AbortController();
  requests.set(event.requestId, { conversationId, controller });
  const { signal } = controller;
  try {
    const url = api.assetUrl(`/api/assets/${encodeURIComponent(event.assetId)}/file`);
    const frames = await extractVideoOverview(url, signal);
    await api.submitVideoOverview(conversationId, event.requestId, frames, signal);
  } catch (error) {
    if (error instanceof ApiError && error.code === "INVALID_OVERVIEW_FRAMES" && !signal.aborted) {
      await api.submitVideoOverview(conversationId, event.requestId, { ok: false, reason: "empty" }, signal).catch(() => {});
    }
  } finally {
    requests.delete(event.requestId);
  }
}

export function cancelVideoOverviews(conversationId: string) {
  for (const job of requests.values()) {
    if (job.conversationId === conversationId) job.controller.abort();
  }
}
