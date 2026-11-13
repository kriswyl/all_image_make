/**
 * TaskRunner 完成事件 → 对话消息 + 自动续跑。
 *
 * 这是「一气呵成」的关键：异步任务提交出去以后 HTTP 连接早就断了，
 * 但任务完成时这里仍然能把结果写回消息、并让大脑接着说话（§12.2）。
 */
import type { AppDatabase } from "./db.js";
import type { TaskEvent } from "./tasks.js";
import { isTerminalStatus } from "./tasks.js";
import { MAX_AUTO_CONTINUE } from "./agent-constants.js";
import { assetRef, usesPlainChat, type AgentStreamEvent, type ChatMessage, type Conversation, type ToolResult } from "../shared/agent-types.js";
import type { NativeMediaConfirmation } from "./chat-tools/native-image.js";
import { taskKindFor } from "../shared/types.js";
import { sunoResultLabel } from "../shared/suno.js";
import { midjourneyUsableButtons } from "../shared/midjourney.js";
import { auditParameters } from "./diagnose.js";

export interface TaskEventHost {
  db: AppDatabase;
  broadcast(conversationId: string, event: AgentStreamEvent): void;
  hasActiveTurn(conversationId: string): boolean;
  startTurn(conversationId: string, text: null, trigger: "task_finished"): void;
  reportTurnFailure(conversationId: string, error: unknown): void;
  finishNativeTask?(conversation: Conversation, pending: ChatMessage, operation: ChatMessage, result: ToolResult, state: NativeMediaConfirmation): void | Promise<void>;
}

export function handleTaskEvent(host: TaskEventHost, event: TaskEvent): void {
  const db = host.db;
  const taskRow = db.getTaskRow(event.task.id);
  if (taskRow?.agentOperationId && isTerminalStatus(event.task.status)) db.executions.settleTask(taskRow.agentOperationId,event.task.id,
    event.task.errorCode === "SUBMISSION_UNKNOWN" ? "unknown_submit" : event.task.status === "succeeded" ? "completed" : event.task.status === "cancelled" ? "cancelled" : "failed",event.task.errorCode ?? undefined);
  const conversation = db.findConversationByTask(event.task.id);
  if (!conversation) return;

  if (!isTerminalStatus(event.task.status)) {
    host.broadcast(conversation.id, {
      type: "progress", taskId: event.task.id, status: event.task.status, progress: event.task.progress,
    });
    return;
  }

  // `async === true` 是必须的：批量会把 N 条产图行**先**以 pending 写下来
  // （好让 N 张卡立刻出现），它们一旦拿到 taskId 就会满足前两个条件，
  // 被这条「异步任务收口」的逻辑当成自己的任务。
  const pendingMessages = db.listPendingMessages(conversation.id);
  const active = pendingMessages
    .find((message) => message.taskId === event.task.id && !message.confirm && message.toolResult?.async === true);
  const continued = active ? null : db.findTaskTimeoutMessage(conversation.id, event.task.id);
  const pending = active ?? continued;
  if (!pending) {
    // 收尾消息已经被别人处理掉了（用户中断、会话被删）。至少别让状态卡在 waiting_task
    if (conversation.status === "waiting_task" && !pendingMessages.some(message => message.toolResult?.async)) {
      db.setConversationStatus(conversation.id, "idle", { touch: false });
      host.broadcast(conversation.id, { type: "done", status: "idle" });
    }
    return;
  }
  const operationId = pending.toolResult?.data?.agentOperationId;
  const operation = typeof operationId === "string" ? db.getMessage(operationId) : null;
  const state = operation?.conversationId === conversation.id ? db.getNativeMediaConfirmation(operation.id) : null;
  if (operation && state && host.finishNativeTask && conversation.status === "running"
    && host.hasActiveTurn(conversation.id) && !db.hasUserMessageAfter(conversation.id, operation.seq)) return;

  const adapter = db.getChannel(event.task.channelId)?.adapterType;
  const kind = taskKindFor(
    adapter,
    event.task.assets.map((asset) => asset.mimeType),
  );
  const producedAssets = event.task.assets;
  const produced = producedAssets[0] ?? null;
  const ok = event.task.status === "succeeded" && Boolean(produced);
  const titles = producedAssets
    .map((asset) => asset.title)
    .filter((title): title is string => Boolean(title));
  const boardRef = typeof pending.toolResult?.data?.nodeRef === "string" ? pending.toolResult.data.nodeRef : "";
  const label = kind === "audio" ? pending.toolName === "generate_speech" ? "配音" : event.task.effectiveParameters?.task === "sound" ? "音效" : "音乐" : kind === "image" ? "图片" : "视频";
  const summary = conversation.kind === "board" && boardRef
    ? ok ? `画布节点 ${boardRef} 的${kind === "image" ? "图片" : kind === "video" ? "视频" : "音频"}任务已完成，结果将由画布回填。` : `画布节点 ${boardRef} 的生成失败：${event.task.errorMessage ?? event.task.errorCode ?? "上游没有返回结果"}`
    : ok && produced
    ? label === "配音"
      ? `配音完成${produced.duration ? `，约 ${produced.duration.toFixed(1)} 秒` : ""}，已保存 ${assetRef(produced.id)}。`
      : kind === "audio"
        ? `${label}生成完成，共 ${producedAssets.length} ${label === "音效" ? "条" : "首"}${titles.length ? `：${titles.join(" / ")}` : ""}。${event.task.remoteMeta?.suno?.warning ?? ""}`
      : `${label}生成完成（${event.task.model}），产物 ${assetRef(produced.id)}${produced.duration ? `，约 ${produced.duration} 秒` : ""}。`
    : `${label}生成失败：${event.task.errorMessage ?? event.task.errorCode ?? "上游没有返回结果"}`;
  // async 标记只在「等任务」时有意义；落库时丢掉，免得回放给大脑时它以为还没做完
  const previous = pending.toolResult ?? { ok: false, summary: "" };
  const { async: _pending, error: _previousError, ...rest } = previous;
  // Midjourney 的 U/V/R 按钮藏在任务 meta 里；带上给对话卡片直接渲染，
  // 用户不用跳去生成历史才能继续放大 / 变体 / 重绘。
  const midjourneyButtons = midjourneyUsableButtons(event.task.remoteMeta?.midjourney?.buttons ?? []);
  const imageData = state?.target.kind === "image" && operation && adapter
    ? { model: event.task.model, count: producedAssets.length, parameterNotes: auditParameters(adapter, operation.toolArgs ?? {}, event.task.effectiveParameters) }
    : undefined;
  const suno = event.task.remoteMeta?.suno;
  const observedModels = [...new Set((suno?.tracks ?? []).map(sunoResultLabel).filter(Boolean))];
  const data = previous.data || imageData || suno || midjourneyButtons.length || continued ? {
    ...previous.data, ...imageData,
    ...(suno ? { musicResultModels: observedModels.join(" / "), musicWarning: suno.warning ?? "" } : {}),
    ...(continued ? { continuedQuery: true } : {}),
    ...(midjourneyButtons.length ? { midjourneyButtons, midjourneyTaskId: event.task.id } : {}),
  } : undefined;
  const result: ToolResult = {
    ...rest, ok, summary, taskId: event.task.id,
    ...(event.task.errorCode ? { error: event.task.errorCode } : {}),
    ...(produced ? {
      assetId: produced.id,
      assetIds: producedAssets.map((asset) => asset.id),
      mimeType: produced.mimeType,
    } : {}),
    ...(data ? { data } : {}),
  };
  if (!continued && operation && state && host.finishNativeTask) {
    void Promise.resolve(host.finishNativeTask(conversation, pending, operation, result, state))
      .catch((error) => host.reportTurnFailure(conversation.id, error));
    return;
  }
  db.updateMessage(pending.id, {
    content: summary, toolResult: result, status: ok ? "ok" : "error",
    ...(produced ? { assetId: produced.id } : {}),
    errorMessage: ok ? null : summary,
  });
  const updated = db.getMessage(pending.id);
  if (updated) host.broadcast(conversation.id, { type: "message", message: updated });
  if (continued) {
    host.broadcast(conversation.id, { type: "progress", taskId: event.task.id, status: event.task.status, progress: event.task.progress });
    return;
  }

  // 画布只跟着图片走：视频/音乐做完了，画布仍是那张原图
  if (conversation.status !== "waiting_task") return;
  if (host.hasActiveTurn(conversation.id)) return;

  if (event.task.errorCode === "SUBMISSION_UNKNOWN" || usesPlainChat(conversation)) {
    db.setConversationStatus(conversation.id, "idle", { touch: false });
    host.broadcast(conversation.id, { type: "done", status: "idle" });
    return;
  }

  const autoContinueLimit = conversation.kind === "board" ? conversation.boardAutoContinueLimit ?? MAX_AUTO_CONTINUE : MAX_AUTO_CONTINUE;
  if (conversation.autoContinueCount >= autoContinueLimit) {
    const note = db.appendMessage({
      conversationId: conversation.id, role: "system",
      content: `已经连续自动续跑 ${autoContinueLimit} 次，我先停下来了。继续说一句就能接着做。`,
    });
    host.broadcast(conversation.id, { type: "message", message: note });
    db.setConversationStatus(conversation.id, "idle", { touch: false });
    host.broadcast(conversation.id, { type: "done", status: "idle" });
    return;
  }

  db.bumpAutoContinue(conversation.id);
  try {
    host.startTurn(conversation.id, null, "task_finished");
  } catch (error) {
    host.reportTurnFailure(conversation.id, error);
  }
}
