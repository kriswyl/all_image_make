import type { Task } from "../../shared/types";
import type { Toast } from "../app-shared";
import { api } from "../api";
import { confirmGeneration } from "../generation-confirm";

export async function retryImageResult(task: Task, onTask: (task: Task) => void, onToast: (kind: Toast["kind"], message: string) => void) {
  const continueQuery = task.errorCode === "VIDEO_TIMEOUT";
  if (!continueQuery && !confirmGeneration({ kind: "图片生成", model: task.model, channel: task.channelName, retry: true })) return;
  try {
    const result = await (continueQuery ? api.continueTaskQuery(task.id) : api.retry(task.id));
    onTask(result);
    onToast("success", continueQuery ? "已继续查询原任务" : "已重新提交");
  } catch (error) {
    onToast("error", error instanceof Error ? error.message : "重试失败");
  }
}
