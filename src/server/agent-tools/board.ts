import type { BoardApplyArgs, BoardGenerateArgs, BoardReadArgs } from "../../shared/board-ops.js";
import { storyboardProjectDataSchema } from "../../shared/storyboard-project.js";
import { applyBoardOps, describeBoard } from "../board-agent.js";
import { describeBoardStoryboards, inspectBoardGeneration } from "../board-assistant.js";
import { requestBoardFrame } from "../board-frame-broker.js";
import { generateBoardConfig } from "../board-generation.js";
import { buildBoardDelta } from "../board.js";
import type { BoardRecord } from "../db.js";
import type { BoardToolInput } from "./board-schema.js";
import { describeError, failResult, okResult, type ToolContext, type ToolOutcome } from "./shared.js";

function boardForTool(ctx: ToolContext): BoardRecord | null {
  if (ctx.conversation.kind !== "board" || !ctx.conversation.boardId) return null;
  return ctx.db.getBoardRecord(ctx.conversation.boardId);
}

export function boardReadTool(ctx: ToolContext, args: BoardReadArgs): ToolOutcome {
  const board = boardForTool(ctx);
  if (!board) return failResult("board_read 只能在无限画布线程里使用", "BOARD_ONLY");
  const text = describeBoard(board, args);
  return okResult(text, {
    data: {
      boardId: board.id,
      nodeCount: board.doc.nodes.length,
      edgeCount: board.doc.edges.length,
    },
  });
}

export function boardApplyTool(ctx: ToolContext, args: BoardApplyArgs): ToolOutcome {
  const board = boardForTool(ctx);
  if (!board) return failResult("board_apply 只能在无限画布线程里使用", "BOARD_ONLY");
  try {
    if (args.expectedBoardVersion && board.version !== args.expectedBoardVersion) return failResult("画布在确认后发生变化，请重新检查并确认操作。", "BOARD_VERSION_CONFLICT");
    const result = applyBoardOps(ctx.db, board.id, args.ops);
    ctx.emit({
      type: "board",
      boardId: board.id,
      version: result.board.version,
      reason: "agent:apply",
      delta: buildBoardDelta(board.id, board.doc, result.board.doc, board.version, result.board.version),
    });
    return okResult(result.summary, { data: result.data });
  } catch (error) {
    return failResult(describeError(error), "BOARD_APPLY_FAILED");
  }
}

export async function boardGenerateTool(ctx: ToolContext, args: BoardGenerateArgs): Promise<ToolOutcome> {
  const board = boardForTool(ctx);
  if (!board) return failResult("board_generate 只能在无限画布线程里使用", "BOARD_ONLY");
  const target = board.doc.nodes.find((node) => node.ref === args.nodeRef);
  if (!target || target.type === "text") {
    return failResult(`节点 ${args.nodeRef} 不能生成：请指定配置 / 图片 / 视频 / 音频节点`, "BOARD_CONFIG_NOT_FOUND");
  }
  try {
    if (args.expectedBoardVersion && board.version !== args.expectedBoardVersion) return failResult("画布在确认后发生变化，请重新检查并确认生成。", "BOARD_VERSION_CONFLICT");
    const check = inspectBoardGeneration(ctx.db, board, ctx.aliases, ctx.defaultAliases, [args.nodeRef], args.overrides)[0];
    if (check?.errors.length) return failResult(`生成前检查未通过：${check.errors.join("；")}`, "BOARD_PREFLIGHT_FAILED");
    const result = await generateBoardConfig({
      db: ctx.db,
      runner: ctx.runner,
      keys: ctx.sessionKeys,
      boardId: board.id,
      nodeId: target.id,
      ...(args.overrides ? { overrides: args.overrides } : {}),
    });
    const resultNodes = result.board.doc.nodes.filter((node) => result.resultNodeIds.includes(node.id));
    const refs = resultNodes.map((node) => node.ref);
    const unit = result.kind === "video" ? "个视频"
      : result.kind === "text" ? "段文本"
        : result.kind === "audio" ? "个音频"
          : "张图";
    ctx.emit({
      type: "board",
      boardId: board.id,
      version: result.board.version,
      reason: "agent:generate",
      delta: buildBoardDelta(board.id, board.doc, result.board.doc, board.version, result.board.version),
    });
    const summary = result.task
      ? `已提交：${args.nodeRef} 生成 ${refs.length} ${unit}，结果节点 ${refs.join("、")}；taskId=${result.task.id}。结果会由画布回填。`
      : `已生成：${args.nodeRef} 的 ${refs.length} 段文本已写入结果节点 ${refs.join("、")}。`;
    return okResult(
      summary,
      {
        ...(result.task ? { taskId: result.task.id, async: true } : {}),
        data: {
          nodeRef: args.nodeRef,
          ...(result.task ? { taskId: result.task.id } : {}),
          kind: result.kind,
          resultRefs: refs,
          resultNodeIds: result.resultNodeIds,
          modelAlias: result.modelAlias,
          referenceCount: result.referenceCount,
        },
      },
    );
  } catch (error) {
    return failResult(describeError(error), "BOARD_GENERATE_FAILED");
  }
}

export async function boardGenerateBatchTool(
  ctx: ToolContext,
  input: BoardToolInput<"board_generate_batch">,
): Promise<ToolOutcome> {
  const board = boardForTool(ctx);
  if (!board) return failResult("画布不存在", "BOARD_ONLY");
  if (input.expectedBoardVersion && input.expectedBoardVersion !== board.version) return failResult("画布在确认后发生变化，请重新检查并确认", "BOARD_VERSION_CONFLICT");
  const checks = inspectBoardGeneration(ctx.db, board, ctx.aliases, ctx.defaultAliases, input.nodeRefs);
  const blocked = checks.filter((item) => item.errors.length || item.kind === "text");
  if (blocked.length) return failResult(`批量生成前检查未通过：${blocked.map((item) => `${item.ref} ${item.errors.join("、") || "不支持文本节点批量生成"}`).join("；")}`, "BOARD_PREFLIGHT_FAILED");
  const tasks: Array<{ ref: string; id: string }> = [];
  const failures: string[] = [];
  let expectedVersion = board.version;
  for (const ref of input.nodeRefs) {
    if (ctx.signal?.aborted) {
      failures.push("用户中止后续提交；已提交任务仍在后台执行");
      break;
    }
    const before = ctx.db.getBoardRecord(board.id);
    if (!before || before.version !== expectedVersion) {
      failures.push("画布在批量提交期间变化，已停止提交剩余节点");
      break;
    }
    const node = before.doc.nodes.find((item) => item.ref === ref);
    if (!node) {
      failures.push(`${ref} 不存在`);
      break;
    }
    try {
      const result = await generateBoardConfig({ db: ctx.db, runner: ctx.runner, keys: ctx.sessionKeys, boardId: board.id, nodeId: node.id });
      expectedVersion = result.board.version;
      ctx.emit({
        type: "board",
        boardId: board.id,
        version: result.board.version,
        reason: "agent:batch-generate",
        delta: buildBoardDelta(board.id, before.doc, result.board.doc, before.version, result.board.version),
      });
      if (result.task) {
        tasks.push({ ref, id: result.task.id });
        ctx.emit({ type: "board_batch_progress", text: `已提交 ${tasks.length}/${input.nodeRefs.length} 个任务，最新节点 ${ref}` });
      }
    } catch (error) {
      failures.push(`${ref} 提交失败：${describeError(error)}`);
      break;
    }
  }
  const completed = await Promise.all(tasks.map(async (task) => {
    try {
      const result = await ctx.runner.waitFor(task.id, { timeoutMs: 15 * 60_000, signal: ctx.signal });
      const succeeded = result.status === "succeeded";
      ctx.emit({ type: "board_batch_progress", text: `${task.ref} ${succeeded ? "已完成" : "失败或停止"}，其余任务继续` });
      return `${task.ref}：${succeeded ? "已完成" : `失败或停止（${result.errorMessage || result.status}）`}`;
    } catch (error) {
      return `${task.ref}：${ctx.signal?.aborted ? "已停止等待，任务可能仍在后台执行" : describeError(error)}`;
    }
  }));
  const summary = [`批量提交 ${tasks.length}/${input.nodeRefs.length} 个任务。`, ...completed, ...failures].join("\n");
  if (!tasks.length && failures.length) return failResult(summary, "BOARD_BATCH_FAILED");
  return okResult(summary, { data: { taskIds: tasks.map((item) => item.id) } });
}

export function boardStoryboardUpdateTool(
  ctx: ToolContext,
  input: BoardToolInput<"board_storyboard_update">,
): ToolOutcome {
  const board = boardForTool(ctx);
  if (!board) return failResult("画布不存在", "BOARD_ONLY");
  if (input.expectedBoardVersion && input.expectedBoardVersion !== board.version) return failResult("画布在确认后发生变化，请重新检查分镜", "BOARD_VERSION_CONFLICT");
  const node = board.doc.nodes.find((item) => item.ref === input.nodeRef);
  if (!node?.storyboard) return failResult("该节点没有关联的分镜项目", "STORYBOARD_NOT_FOUND");
  const project = ctx.db.getStoryboardProject(node.storyboard.projectId);
  if (!project || project.revision !== input.revision) return failResult("分镜不存在或已改变，请重新读取", "STORYBOARD_CONFLICT");
  const shotIndex = project.data.shots.findIndex((shot) => shot.id === node.storyboard!.shotId);
  if (shotIndex < 0) return failResult("项目中的镜头不存在", "STORYBOARD_NOT_FOUND");
  const previous = project.data.shots[shotIndex]!;
  const next = { ...previous, ...input.patch };
  if (input.patch.scene !== undefined && input.patch.scene !== previous.scene && input.patch.sceneVersionId === undefined) next.sceneVersionId = "";
  if (input.patch.character !== undefined && input.patch.characterVersions === undefined) {
    const names = new Set(next.character.split(/[、,，]/).map((name) => name.trim()));
    next.characterVersions = Object.fromEntries(Object.entries(next.characterVersions).filter(([name]) => names.has(name)));
  }
  if (input.patch.props !== undefined && input.patch.propVersions === undefined) {
    const names = new Set(next.props.split(/[、,，]/).map((name) => name.trim()));
    next.propVersions = Object.fromEntries(Object.entries(next.propVersions).filter(([name]) => names.has(name)));
  }
  const scene = project.data.scenes.find((item) => item.name === next.scene);
  if (next.sceneVersionId && !scene?.variants.some((item) => item.id === next.sceneVersionId)) return failResult("场景版本不存在，请先读取对应的版本 ID", "STORYBOARD_VARIANT_MISSING");
  for (const [key, values, text] of [["characterVersions", project.data.characters, next.character], ["propVersions", project.data.props, next.props]] as const) {
    const names = new Set(text.split(/[、,，]/).map((name) => name.trim()).filter(Boolean));
    for (const [name, id] of Object.entries(next[key])) {
      if (id && (!names.has(name) || !values.find((item) => item.name === name)?.variants.some((item) => item.id === id))) {
        return failResult(`「${name}」的版本不存在或不在该镜头中`, "STORYBOARD_VARIANT_MISSING");
      }
    }
  }
  const data = storyboardProjectDataSchema.parse({ ...project.data, shots: project.data.shots.map((shot, index) => index === shotIndex ? next : shot) });
  if (!ctx.db.updateStoryboardProject(project.id, project.revision, data)) return failResult("分镜已改变，请重新读取", "STORYBOARD_CONFLICT");
  return okResult(`已更新分镜项目「${project.data.name}」第 ${shotIndex + 1} 镜。当前画布是导入快照，尚未改变；需要重新导入或单独修改画布。`);
}

export function boardStoryboardTool(
  ctx: ToolContext,
  input: BoardToolInput<"board_storyboard">,
): ToolOutcome {
  const board = boardForTool(ctx);
  if (!board) return failResult("画布不存在", "BOARD_ONLY");
  return okResult(describeBoardStoryboards(ctx.db, board, input.nodeRefs));
}

export function boardCheckTool(
  ctx: ToolContext,
  input: BoardToolInput<"board_check">,
): ToolOutcome {
  const board = boardForTool(ctx);
  if (!board) return failResult("画布不存在", "BOARD_ONLY");
  const checks = inspectBoardGeneration(ctx.db, board, ctx.aliases, ctx.defaultAliases, input.nodeRefs);
  return okResult(checks.map((item) => `${item.ref} ${item.kind} 模型：${item.model}；${item.errors.length ? `不能生成：${item.errors.join("、")}` : "基础检查通过"}${item.warnings.length ? `；注意：${item.warnings.join("、")}` : ""}`).join("\n") + "\n此检查不提交任务，实际能力仍以渠道响应为准。", { data: { checks } });
}

export function boardAssetsTool(
  ctx: ToolContext,
  input: BoardToolInput<"board_assets">,
): ToolOutcome {
  const records = ctx.db.listLibraryTaskViews({ limit: 20, offset: 0, query: input.query, kind: input.kind, mode: "assets" });
  const assets = records.flatMap((task) => task.assets).filter((asset) => input.kind === "all" || asset.mimeType.startsWith(`${input.kind}/`)).slice(0, 20);
  return okResult(assets.length ? assets.map((asset) => `素材ID=${asset.id} 类型=${asset.mimeType} 名称=${asset.title || asset.fileName}`).join("\n") : "公共素材库没有匹配的素材。", { data: { count: assets.length } });
}

export function boardVersionsTool(
  ctx: ToolContext,
  input: BoardToolInput<"board_versions">,
): ToolOutcome {
  const board = boardForTool(ctx);
  if (!board) return failResult("画布不存在", "BOARD_ONLY");
  const ref = input.nodeRef;
  const node = board.doc.nodes.find((item) => item.ref === ref);
  if (!node || (node.type !== "image" && node.type !== "video" && node.type !== "audio")) return failResult("请选择素材节点", "BOARD_NODE_NOT_FOUND");
  const rows = ctx.db.listBoardTasksByBoard(board.id).filter((row) => row.resultNodeId === node.id).reverse().slice(0, 20);
  const versions = rows.flatMap((row) => {
    const task = ctx.db.getTaskView(row.taskId);
    if (!task || task.status !== "succeeded") return [];
    const siblings = ctx.db.listBoardTasksByTask(row.taskId).filter((entry) => entry.boardId === board.id);
    const index = siblings.findIndex((entry) => entry.resultNodeId === node.id);
    const asset = task.assets.filter((entry) => entry.mimeType.startsWith(`${node.type}/`))[index];
    return asset ? [{ taskId: task.id, assetId: asset.id, model: task.model, prompt: task.prompt, finishedAt: task.finishedAt }] : [];
  });
  return okResult(versions.length ? versions.map((item) => `素材ID=${item.assetId} 模型=${item.model} 时间=${item.finishedAt ?? "未知"} 提示词=${item.prompt.slice(0, 150)}`).join("\n") : `${ref} 没有可用的生成版本。`, { data: { versions } });
}

export async function boardExtractFrameTool(
  ctx: ToolContext,
  input: BoardToolInput<"board_extract_frame">,
): Promise<ToolOutcome> {
  const board = boardForTool(ctx);
  if (!board) return failResult("画布不存在", "BOARD_ONLY");
  const video = board.doc.nodes.find((item) => item.ref === input.nodeRef);
  if (!video || video.type !== "video" || !video.assetId || !ctx.db.getAsset(video.assetId)) return failResult("所选视频节点没有可用视频", "BOARD_VIDEO_MISSING");
  if (input.targetRef) {
    const target = board.doc.nodes.find((item) => item.ref === input.targetRef);
    if (!target || (target.type !== "video" && !(target.type === "config" && target.mode === "video"))) return failResult("目标不是视频生成节点", "BOARD_TARGET_INVALID");
    if (target.videoMode && target.videoMode !== "first-frame") return failResult("目标当前不是首帧模式，请先调整视频方式", "BOARD_VIDEO_MODE_CONFLICT");
    if (hasImageInput(board, target.id)) {
      return failResult("目标已有图片输入，请先明确移除原图片连线后再提取连接", "BOARD_FIRST_FRAME_EXISTS");
    }
  }
  const request = requestBoardFrame(board.id, ctx.signal);
  ctx.emit({ type: "board_frame_request", boardId: board.id, requestId: request.requestId, videoAssetId: video.assetId });
  try {
    const assetId = await request.promise;
    const asset = ctx.db.getAsset(assetId);
    if (!asset || !asset.mimeType.startsWith("image/") || !ctx.db.findBoardAssetRefs(assetId).some((item) => item.boardId === board.id)) return failResult("提取结果不是当前画布的图片", "FRAME_INVALID");
    const before = ctx.db.getBoardRecord(board.id);
    if (!before) return failResult("画布不存在", "BOARD_ONLY");
    const source = before.doc.nodes.find((item) => item.id === video.id);
    if (!source || source.type !== "video" || source.assetId !== video.assetId) return failResult("提取期间视频发生变化，请重新操作", "BOARD_VERSION_CONFLICT");
    if (input.targetRef) {
      const target = before.doc.nodes.find((item) => item.ref === input.targetRef);
      if (!target || (target.type !== "video" && !(target.type === "config" && target.mode === "video"))
        || (target.videoMode && target.videoMode !== "first-frame") || hasImageInput(before, target.id)) {
        return failResult("提取期间目标或首帧连线发生变化，请重新检查", "BOARD_VERSION_CONFLICT");
      }
    }
    const ops: BoardApplyArgs["ops"] = [{ op: "add_node", tempId: "frame", type: "image", x: source.x + source.width + 100, y: source.y, title: `${source.title || source.ref} · 尾帧`.slice(0, 80), assetRef: assetId }];
    if (input.targetRef) ops.push({ op: "connect", from: "frame", to: input.targetRef, kind: "input", role: "first-frame" });
    const result = applyBoardOps(ctx.db, board.id, ops);
    ctx.emit({ type: "board", boardId: board.id, version: result.board.version, reason: "agent:frame", delta: buildBoardDelta(board.id, before.doc, result.board.doc, before.version, result.board.version) });
    return okResult(`已提取 ${input.nodeRef} 的视频尾帧为 ${result.data.created[0]?.ref ?? "图片节点"}${input.targetRef ? `，并连接到 ${input.targetRef} 的首帧` : "，可用于下一镜的首帧"}。`);
  } catch (error) {
    return failResult(describeError(error), "FRAME_EXTRACTION_FAILED");
  }
}

function hasImageInput(board: BoardRecord, targetId: string): boolean {
  return board.doc.edges.some((edge) => edge.target === targetId && edge.kind === "input"
    && board.doc.nodes.some((node) => node.id === edge.source && node.type === "image"));
}
