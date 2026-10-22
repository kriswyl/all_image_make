/**
 * 大脑调用失败的分类与用户文案。
 *
 * 和「工具执行失败」分开：这里判断的是**大脑这一侧**能不能继续，
 * 决定是重试、降级直通，还是把错误如实告诉用户。
 */
import { looksLikeVisionRejection } from "./capabilities.js";
import { RemoteApiError } from "./adapters.js";
import { BrainError } from "./brain.js";
import { AppError } from "./tasks.js";

export function isVisionError(error: unknown): boolean {
  const status = error instanceof RemoteApiError ? error.status : error instanceof BrainError ? error.status : undefined;
  const message = error instanceof Error ? error.message : "";
  return looksLikeVisionRejection(status, message);
}

/** 鉴权/参数类错误重试没有意义，直接抛给用户看 */
export function isFatalBrainError(error: unknown): boolean {
  const status = error instanceof RemoteApiError ? error.status : error instanceof BrainError ? error.status : undefined;
  return status === 401 || status === 403 || status === 404;
}

/**
 * §15 直通模式的触发条件：**大脑这一侧挂了**，而不是「用户这句话有问题」。
 *
 * `fetch` 自己的网络错误（DNS 解析不到、连接被拒）不是 `RemoteApiError`，
 * 只能靠 name/message 认——只认几种明确的网络故障，宁可漏判也不要把
 * 「提示词被拒」误判成大脑不可用。
 */
export function isBrainDown(error: unknown): boolean {
  if (error instanceof AppError) {
    return error.code === "BRAIN_UNAVAILABLE" || error.code === "CHANNEL_AUTH_FAILED";
  }
  if (error instanceof RemoteApiError) {
    return error.status >= 500 || error.status === 401 || error.status === 403
      || error.status === 404 || error.status === 429;
  }
  if (error instanceof BrainError) return true;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : "";
  return /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|other side closed/i.test(message);
}

/**
 * 给用户看的一句话失败原因。
 *
 * 刻意不复用 `error.message`：上游的报错里可能带着 Base URL、请求体片段甚至密钥回显。
 * 这里只按状态码翻译成人话。
 */
export function describeBrainFailure(error: unknown): string {
  const status = error instanceof RemoteApiError ? error.status : error instanceof BrainError ? error.status : undefined;
  if (status === 401 || status === 403) return "对话渠道的密钥无效或没有权限";
  if (status === 404) return "对话渠道的地址或模型 ID 不对";
  if (status === 429) return "对话渠道限流了";
  if (typeof status === "number" && status >= 500) return `对话渠道返回 ${status}`;
  if (error instanceof AppError && error.code === "CHANNEL_AUTH_FAILED") return "对话渠道还没有配密钥";
  if (error instanceof AppError && error.code === "BRAIN_UNAVAILABLE") return "当前渠道不是对话模型";
  return "连不上对话渠道";
}
