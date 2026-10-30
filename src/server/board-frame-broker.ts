import crypto from "node:crypto";
import { AppError } from "./tasks.js";

type Pending = { boardId: string; claimed: boolean; resolve: (assetId: string) => void; reject: (error: Error) => void };
const pending = new Map<string, Pending>();
export function requestBoardFrame(boardId: string, signal?: AbortSignal) {
  const requestId = crypto.randomUUID();
  const promise = new Promise<string>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error, assetId?: string) => { clearTimeout(timer); pending.delete(requestId); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(assetId!); };
    const abort = () => finish(new AppError("FRAME_CANCELLED", "尾帧提取已取消", 409));
    timer = setTimeout(() => finish(new AppError("FRAME_TIMEOUT", "桌面端未能及时提取尾帧，请保持画布助手打开", 408)), 90000);
    pending.set(requestId, { boardId, claimed: false, resolve: (assetId) => finish(undefined, assetId), reject: (error) => finish(error) });
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
  });
  return { requestId, promise };
}
export function claimBoardFrame(boardId: string, requestId: string): boolean {
  const item = pending.get(requestId);
  if (!item || item.boardId !== boardId || item.claimed) return false;
  item.claimed = true; return true;
}
export function completeBoardFrame(boardId: string, requestId: string, result: { assetId?: string; error?: string }): boolean {
  const item = pending.get(requestId);
  if (!item || item.boardId !== boardId || !item.claimed) return false;
  if (result.assetId) item.resolve(result.assetId); else item.reject(new AppError("FRAME_EXTRACTION_FAILED", result.error || "尾帧提取失败", 400));
  return true;
}
