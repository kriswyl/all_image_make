import {
  GENERATION_TOOLS, type AgentPlan, type ConfirmPreview, type Conversation, type GenerateVideoArgs, type PlannedCall,
} from "../shared/agent-types.js";
import { boardApplySchema, boardGenerateSchema } from "../shared/board-ops.js";
import { buildConfirmPreview, shouldConfirm } from "./agent-confirm.js";
import { MAX_SESSION_TASKS } from "./agent-constants.js";
import { asString } from "./agent-plan.js";
import { BOARD_TOOL_SCHEMAS } from "./agent-tools/board-schema.js";
import type { ToolContext } from "./agent-tools/shared.js";
import { resolveVideoSelection, type VideoSelection } from "./agent-tools/video.js";
import { previewBoardOps } from "./board-agent.js";
import { inspectBoardGeneration } from "./board-assistant.js";
import { buildCapabilityAliases, resolveAlias } from "./capabilities.js";
import type { AppDatabase } from "./db.js";

type ReadDefaultAliases = () => ToolContext["defaultAliases"];

/** 预览涉及画布的操作时，将已核对的版本写入待执行参数。 */
export function previewLegacyConfirmation(
  db: AppDatabase,
  conversation: Conversation,
  calls: PlannedCall[],
  turnAttachmentIds: string[],
  { isContinuation, consistency, defaultAliases }: {
    isContinuation: boolean;
    consistency?: AgentPlan["consistency"];
    defaultAliases: ReadDefaultAliases;
  },
): ConfirmPreview | null {
  const generating = calls.filter((call) => GENERATION_TOOLS.includes(call.tool));
  // 批量只有额度这一道闸门：里面全是产图工具，`shouldConfirm` 对它们恒为 false
  const overTaskLimit = generating.length > 0 && conversation.taskCount + generating.length > MAX_SESSION_TASKS;
  const videoSelection = calls.length === 1 && calls[0]!.tool === "generate_video"
    ? resolveVideoForCall(db, conversation, calls[0]!.args, turnAttachmentIds, defaultAliases)
    : null;
  // 生图/改图也可能因为「画布多于一张又没选图」注定失败。那种情况同样先别摆确认卡：
  // 让工具把选图要求回灌给大脑，比让用户点一次「确认生成」再看到失败要好。
  const canvasCount = db.canvasImages(conversation).length;
  const imageSelectionMissing = canvasCount > 1 && turnAttachmentIds.length === 0
    && calls.some((call) => {
      if (call.tool !== "edit_image" && call.tool !== "generate_image") return false;
      if (call.tool === "generate_image" && call.args.fromScratch === true) return false;
      const refs = call.args.imageRefs;
      return !Array.isArray(refs) || refs.length === 0;
    });
  // 无限画布的删除类操作要确认；不删有内容节点时直接执行
  const boardOpsPreview = conversation.kind === "board" && conversation.boardId
    && calls.length === 1 && calls[0]!.tool === "board_apply"
    ? (() => {
      const parsed = boardApplySchema.safeParse(calls[0]!.args);
      if (!parsed.success) return null;
      try {
        return previewBoardOps(db, conversation.boardId!, parsed.data.ops);
      } catch {
        return null;
      }
    })()
    : null;
  const board = conversation.kind === "board" && conversation.boardId ? db.getBoardRecord(conversation.boardId) : null;
  const boardGeneration = board && calls.length === 1 && calls[0]!.tool === "board_generate" ? (() => {
    const args = boardGenerateSchema.safeParse(calls[0]!.args);
    if (!args.success) return null;
    const check = inspectBoardGeneration(db, board, buildCapabilityAliases(db.listChannels()), defaultAliases(), [args.data.nodeRef], args.data.overrides)[0];
    if (!check || check.errors.length || check.kind === "text") return null;
    const node = board.doc.nodes.find((item) => item.ref === args.data.nodeRef);
    const count = node?.type === "config" && node.mode === "image" ? (args.data.overrides?.count ?? node.count) : 1;
    calls[0]!.args = { ...calls[0]!.args, expectedBoardVersion: board.version };
    return { message: `将在节点 ${check.ref} 提交 1 个${check.kind === "video" ? "视频" : check.kind === "audio" ? "音频" : "图片"}生成任务${count > 1 ? `，请求 ${count} 张结果` : ""}；模型：${check.model}。${check.warnings.length ? `注意：${check.warnings.join("；")}。` : ""}实际费用由渠道决定。`, summary: `${check.ref} · 1 个任务` };
  })() : null;
  const batchGeneration = board && calls.length === 1 && calls[0]!.tool === "board_generate_batch" ? (() => {
    const args = BOARD_TOOL_SCHEMAS.board_generate_batch.safeParse(calls[0]!.args);
    if (!args.success) return null;
    const checks = inspectBoardGeneration(db, board, buildCapabilityAliases(db.listChannels()), defaultAliases(), args.data.nodeRefs);
    if (checks.some((check) => check.errors.length || check.kind === "text")) return null;
    calls[0]!.args = { ...calls[0]!.args, expectedBoardVersion: board.version };
    const lines = checks.map((check) => {
      const node = board.doc.nodes.find((item) => item.ref === check.ref);
      const count = node?.type === "config" && node.mode === "image" ? node.count : 1;
      return `${check.ref}（${check.kind}，${check.model}${count > 1 ? `，请求 ${count} 张` : ""}）${check.warnings.length ? `：${check.warnings.join("、")}` : ""}`;
    }).join("；");
    return { message: `将提交 ${checks.length} 个生成任务：${lines}。实际费用由渠道决定，已生成节点可能被覆盖。`, summary: `${checks.length} 个节点 · ${checks.length} 个任务` };
  })() : null;
  const projectUpdate = board && calls.length === 1 && calls[0]!.tool === "board_storyboard_update" ? (() => {
    const input = BOARD_TOOL_SCHEMAS.board_storyboard_update.safeParse(calls[0]!.args);
    if (!input.success) return null;
    const node = board.doc.nodes.find((item) => item.ref === input.data.nodeRef);
    const project = node?.storyboard && db.getStoryboardProject(node.storyboard.projectId);
    if (!node?.storyboard || !project || project.revision !== input.data.revision) return null;
    const index = project.data.shots.findIndex((shot) => shot.id === node.storyboard!.shotId);
    if (index < 0) return null;
    calls[0]!.args = { ...calls[0]!.args, expectedBoardVersion: board.version };
    const fields = Object.entries(input.data.patch).map(([key, value]) => `${key}：${(typeof value === "object" ? JSON.stringify(value) : String(value)).slice(0, 160)}`).join("；");
    return { message: `将修改分镜项目「${project.data.name}」第 ${index + 1} 镜：${fields}。当前画布不会自动改变。`, summary: `第 ${index + 1} 镜 · 项目版本 ${project.revision}` };
  })() : null;
  if (board && boardOpsPreview?.needsConfirm && calls[0]) calls[0].args = { ...calls[0].args, expectedBoardVersion: board.version };
  if (boardOpsPreview?.needsConfirm) {
    return {
      reason: "board_destructive",
      prompt: "",
      model: "",
      channelName: "",
      message: boardOpsPreview.message,
      boardDeleteNodes: boardOpsPreview.deleteNodes,
      boardDeleteWithAssets: boardOpsPreview.deleteWithAssets,
      boardSummary: boardOpsPreview.summary,
    };
  }
  const boardPreview = boardGeneration ?? batchGeneration ?? projectUpdate;
  if (boardPreview) {
    return {
      reason: boardGeneration || batchGeneration ? "board_generation" : "board_project_update",
      prompt: "", model: "", channelName: "",
      message: boardPreview.message,
      boardSummary: boardPreview.summary,
    };
  }
  // 选图失败时直接交给工具反馈原因，让模型提问或重新选图。
  if (videoSelection?.error || imageSelectionMissing) return null;
  const needsConfirm = overTaskLimit
    || (calls.length === 1 && shouldConfirm(calls[0]!.tool, isContinuation, conversation.videoConfirmPolicy));
  if (!needsConfirm) return null;
  return buildConfirmPreview(
    db, conversation, calls, overTaskLimit ? "session_limit" : "video_policy",
    videoSelection?.selection, consistency, defaultAliases(),
  );
}

/**
 * 把这一轮附带的图 / 已解析好的视频模式固化进参数。
 *
 * 这一步必须在**确认卡落库之前**做：用户过一会儿才点确认，那时
 * 「本条消息附带的图」早就无从查起，只有参数里的 imageRefs 还能复现。
 */
export function materializeLegacyCall(
  db: AppDatabase,
  conversation: Conversation,
  call: PlannedCall,
  turnAttachmentIds: string[],
  defaultAliases: ReadDefaultAliases,
): PlannedCall {
  if (call.tool === "generate_video") {
    const resolved = resolveVideoForCall(db, conversation, call.args, turnAttachmentIds, defaultAliases);
    if (!resolved.selection) return call;
    const selection = resolved.selection;
    const args: Record<string, unknown> = { ...call.args };
    if (selection.mode !== "text-to-video") args.mode = selection.mode;
    if (selection.assets.length) args.imageRefs = selection.assets.map((asset) => asset.id);
    return { tool: call.tool, args };
  }
  if ((call.tool === "edit_image" || call.tool === "generate_image") && turnAttachmentIds.length) {
    const hasRefs = Array.isArray(call.args.imageRefs) && call.args.imageRefs.length > 0;
    const fromScratch = call.tool === "generate_image" && call.args.fromScratch === true;
    if (!hasRefs && !fromScratch) {
      return { tool: call.tool, args: { ...call.args, imageRefs: [...turnAttachmentIds] } };
    }
  }
  return call;
}

/** 解析视频渠道和本次生成使用的图片。 */
function resolveVideoForCall(
  db: AppDatabase,
  conversation: Conversation,
  args: Record<string, unknown>,
  turnAttachmentIds: string[],
  defaultAliases: ReadDefaultAliases,
): { selection?: VideoSelection; error?: string } {
  const aliases = buildCapabilityAliases(db.listChannels());
  const resolution = resolveAlias(aliases, asString(args.modelHint), "video", defaultAliases().video);
  if (!resolution) return { error: "还没有可用的视频渠道，请先到「渠道配置」添加" };
  const channel = db.getChannel(resolution.channelId);
  if (!channel) return { error: "解析到的视频渠道不存在" };
  return resolveVideoSelection(
    db, conversation, args as unknown as GenerateVideoArgs, channel.adapterType, turnAttachmentIds,
    resolution.model,
  );
}
