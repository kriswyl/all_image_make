import { randomUUID } from "node:crypto";
import { videoOverviewSampleTimes, type VideoOverviewFrames, type VideoOverviewRequest } from "../shared/media-review.js";

interface Pending {
  event: VideoOverviewRequest;
  finish(result: VideoOverviewFrames): void;
}

export class VideoOverviewRequests {
  private readonly requests = new Map<string, Pending>();

  read(conversationId: string, assetId: string, signal: AbortSignal, publish: (event: VideoOverviewRequest) => void) {
    signal.throwIfAborted();
    if (this.requests.has(conversationId)) throw new Error("本会话已有视频正在抽帧。");
    return new Promise<VideoOverviewFrames>((resolve, reject) => {
      const event = { type: "video_overview_frames", requestId: randomUUID(), assetId } satisfies VideoOverviewRequest;
      const dispose = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.requests.delete(conversationId);
      };
      const finish = (result: VideoOverviewFrames) => { dispose(); resolve(result); };
      const abort = () => { dispose(); reject(signal.reason); };
      const timer = setTimeout(() => finish({ ok: false, reason: "timeout" }), 120_000);
      this.requests.set(conversationId, { event, finish });
      signal.addEventListener("abort", abort, { once: true });
      try { publish(event); }
      catch (error) { dispose(); reject(error); }
    });
  }

  pending(conversationId: string) {
    return this.requests.get(conversationId)?.event;
  }

  submit(conversationId: string, requestId: string, result: VideoOverviewFrames) {
    const pending = this.requests.get(conversationId);
    if (!pending || pending.event.requestId !== requestId) return "expired";
    if (result.ok) {
      const samples = videoOverviewSampleTimes(result.durationMs);
      const times = result.sheets.flatMap(sheet => sheet.timesMs);
      if (result.planned !== samples.length || times.length > samples.length
          || times.some((time, index) => !samples.includes(time) || index > 0 && time <= times[index - 1]!)) return "invalid";
      if (result.sheets.some(sheet => !Buffer.from(sheet.jpeg.slice("data:image/jpeg;base64,".length), "base64").subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))) return "invalid";
    }
    pending.finish(result);
    return "accepted";
  }
}
