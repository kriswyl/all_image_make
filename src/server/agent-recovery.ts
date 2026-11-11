import { assetRef, usesNativeCreativeTools, type ChatMessage, type Conversation, type ToolResult } from "../shared/agent-types.js";
import { isImageAsset } from "../shared/types.js";
import { nativeMediaCheckpoint } from "./agent-media-checkpoint.js";
import { handleTaskEvent, type TaskEventHost } from "./agent-task-events.js";
import { isVisionBlocked } from "./agent-vision.js";
import type { BrainContentPart } from "./brain.js";
import type { NativeMediaConfirmation } from "./chat-tools/native-image.js";
import type { AppDatabase } from "./db.js";
import { isTerminalStatus } from "./tasks.js";
import { assetVisionParts } from "./vision.js";

export interface RecoveryHost extends TaskEventHost {
  startRecoveredTurn(conversationId: string): void;
}

/**
 * 启动时恢复上一进程留下的会话和工具任务。
 *
 * 只收拾 `running`：`waiting_task` 要留着——那条视频可能还在上游跑，`runner.resume()`
 * 会接着轮询；`awaiting_confirmation` 也留着，那是在等用户点头。
 */
export function recoverStaleConversations(host: RecoveryHost): number {
  const { db } = host;
  db.workflows.recoverInterrupted();
  db.executions.recoverInterrupted();
  const resumable = db.recoverableNativeTurnIds();
  const recoveredTasks = db.listUnlinkedAgentTasks();
  for (const task of recoveredTasks) {
    const operation = db.getMessage(task.agentOperationId!);
    if (!operation?.toolName) continue;
    const summary = "已找回此前提交的生成任务，正在核对结果。";
    const toolResult: ToolResult = { ok: true, async: true, summary, taskId: task.id, data: { agentOperationId: operation.id } };
    if (operation.role === "tool") {
      db.updateMessage(operation.id, { status: "pending", content: summary, taskId: task.id, toolResult });
    } else {
      db.appendMessage({ conversationId: operation.conversationId, role: "tool", toolName: operation.toolName,
        status: "pending", content: summary, taskId: task.id, toolResult });
    }
  }
  db.interruptUnstartedAgentConfirmations();
  const conversations = db.listConversations();
  for (const conversation of conversations) {
    if (conversation.status !== "running") continue;
    const waitingOnNativeTask = db.listPendingMessages(conversation.id).some(message => {
      const operationId = message.toolResult?.data?.agentOperationId;
      if (!message.taskId || message.toolResult?.async !== true || typeof operationId !== "string") return false;
      const operation = db.getMessage(operationId);
      return operation && db.getNativeMediaConfirmation(operation.id)
        && !db.hasUserMessageAfter(conversation.id, operation.seq);
    });
    if (waitingOnNativeTask) db.setConversationStatus(conversation.id, "waiting_task", { touch: false });
  }
  const count = db.resetConversationsStuckInRunning();
  for (const recovered of recoveredTasks) {
    const task = db.getTaskView(recovered.id);
    if (task && isTerminalStatus(task.status)) handleTaskEvent(host, { kind: "finished", task });
  }
  for (const conversation of conversations) settleFinishedTasks(host, conversation.id);
  for (const conversationId of resumable) host.startRecoveredTurn(conversationId);
  return count;
}

/**
 * 补上「任务比消息先结束」那个时间窗。
 *
 * 提交即失败是最常见的例子（渠道没配 key、上游直接拒、参数不合法）：
 * `runner.create()` 把任务排进微任务，`run()` 立刻失败并发出 `finished` 事件，
 * 而那时工具消息还没落库——`handleTaskEvent` 按 taskId 找不到人接手，事情就彻底丢了：
 * 消息停在 pending、会话卡在 waiting_task，用户等不到任何回音（实测就是这样）。
 *
 * 所以要在**状态已经设成 waiting_task 之后**再自查一次（`handleTaskEvent` 开头那道
 * 状态门就是这么要求的），让它照常跑一遍收口。和 `TaskRunner.waitFor` 里那句
 * 「订阅之前任务可能已经结束，必须再查一次」是同一个道理。
 */
export function settleFinishedTasks(host: TaskEventHost, conversationId: string) {
  const { db } = host;
  for (const message of db.listPendingMessages(conversationId)) {
    if (!message.taskId || message.toolResult?.async !== true) continue;
    const task = db.getTaskView(message.taskId);
    if (task && isTerminalStatus(task.status)) handleTaskEvent(host, { kind: "finished", task });
  }
}

/** 把生成图交给支持视觉的模型，用于判断生成或编辑效果。 */
async function generatedImageContext(db: AppDatabase, result: ToolResult): Promise<BrainContentPart[] | undefined> {
  const id = result.assetId ?? result.assetIds?.[0];
  if (!id) return undefined;
  const asset = db.getAsset(id);
  if (!asset || !isImageAsset(asset)) return undefined;
  const view = await assetVisionParts(db, asset, assetRef(asset.id), 6);
  if (!view.loaded) return undefined;
  return [
    { type: "text", text: `这是本轮生成/修改的图片 ${assetRef(asset.id)}。请以实际画面为准判断效果，不要凭空描述。${view.animated ? "它是动图，下面附了按时间抽取的帧。" : ""}` },
    ...view.parts,
  ];
}

export async function finishNativeTask(
  host: RecoveryHost,
  conversation: Conversation,
  pending: ChatMessage,
  operation: ChatMessage,
  result: ToolResult,
  state: NativeMediaConfirmation,
): Promise<void> {
  const { db } = host;
  const ownsWait = conversation.status === "waiting_task" && !host.hasActiveTurn(conversation.id)
    && !db.hasUserMessageAfter(conversation.id, operation.seq);
  const brainChannel = db.getChannel(conversation.brainChannelId);
  const { checkpoint } = state;
  const shouldResume = ownsWait && result.ok && usesNativeCreativeTools(conversation)
    && conversation.brainChannelId === checkpoint.channelId && conversation.brainModel === checkpoint.model
    && brainChannel?.updatedAt === checkpoint.channelVersion;
  const generatedImage = shouldResume && conversation.visionEnabled && !isVisionBlocked(db, conversation)
    ? await generatedImageContext(db, result).catch(() => undefined) : undefined;
  const stillOwnsWait = ownsWait && !host.hasActiveTurn(conversation.id) && !db.hasUserMessageAfter(conversation.id, operation.seq);
  const resume = db.completeNativeMediaTask(conversation.id, pending.id, operation.id, result,
    stillOwnsWait, shouldResume && stillOwnsWait ? nativeMediaCheckpoint(state, result, generatedImage) : null);
  const updated = db.getMessage(pending.id);
  if (updated) host.broadcast(conversation.id, { type: "message", message: updated });
  if (resume) {
    host.startRecoveredTurn(conversation.id);
    return;
  }
  if (stillOwnsWait) host.broadcast(conversation.id, { type: "done", status: "idle" });
}
