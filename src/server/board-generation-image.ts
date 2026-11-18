import { resolveBoardMentions } from "../shared/board-mentions.js";
import crypto from "node:crypto";
import type { AppDatabase, BoardRecord } from "./db.js";
import { allocateNodeRef, BOARD_LIMITS, resolveBoardTimeoutMs, type BoardDoc, type BoardNode, type ConfigBoardNode, type ImageBoardNode } from "../shared/board.js";
import { AppError } from "./app-error.js";
import type { TaskRunner } from "./tasks.js";
import { buildCapabilityAliases, resolveAlias } from "./capabilities.js";
import type { GenerationInput } from "../shared/types.js";
import { boardView, requireBoard } from "./board-core.js";
import { loadBoardImageReferences, now, placeImageResultGrid, placeResultNode, saveGeneratedBoard, submitBoardImages, type BoardGenerateOverrides, type BoardGenerateResult } from "./board-generation-shared.js";

export async function generateBoardImage(input: {
  db: AppDatabase;
  runner: TaskRunner;
  boardId: string;
  board: BoardRecord;
  config: ConfigBoardNode;
  prompt: string;
  overrides?: BoardGenerateOverrides;
}): Promise<BoardGenerateResult> {
  const { db, runner, board, config, prompt } = input;
  const aliases = buildCapabilityAliases(db.listChannels());
  const resolution = resolveAlias(
    aliases,
    input.overrides?.model ?? config.model,
    "image",
    db.getSetting("agentDefaultImageAlias") ?? undefined,
  );
  if (!resolution) throw new AppError("BOARD_NO_IMAGE_CHANNEL", "还没有可用的生图渠道，请先到「模型配置」添加", 400);
  const channel = db.getChannel(resolution.channelId);
  if (!channel || !channel.enabled) {
    throw new AppError("BOARD_NO_IMAGE_CHANNEL", "解析到的生图渠道不存在或未启用", 400);
  }
  const { references, referenceNodes } = await loadBoardImageReferences(db, board.doc, config.id, channel.adapterType, resolution.model);
  const count = input.overrides?.count ?? config.count;
  if (board.doc.nodes.length + count > BOARD_LIMITS.maxNodes || board.doc.edges.length + count > BOARD_LIMITS.maxEdges) {
    throw new AppError("BOARD_NODE_LIMIT", "画布剩余节点或连线不足，请减少生成张数或腾出空间", 400);
  }

  const size = input.overrides?.size ?? config.size;
  const imageSize = input.overrides?.imageSize ?? config.imageSize;
  const quality = input.overrides?.quality ?? config.quality;
  const negativePrompt = input.overrides?.negativePrompt ?? config.negativePrompt;
  const aspectRatio = input.overrides?.aspectRatio ?? config.aspectRatio;
  const seed = input.overrides?.seed ?? config.seed;
  const style = input.overrides?.style ?? config.style;
  const background = input.overrides?.background ?? config.background;
  const outputFormat = input.overrides?.outputFormat ?? config.outputFormat;
  const moderation = input.overrides?.moderation ?? config.moderation;
  const generation: GenerationInput = {
    channelId: channel.id,
    model: resolution.model,
    prompt: resolveBoardMentions(prompt, referenceNodes, false),
    ...(size ? { size } : {}),
    ...(imageSize ? { imageSize } : {}),
    ...(quality ? { quality } : {}),
    ...(negativePrompt ? { negativePrompt } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(seed === undefined ? {} : { seed }),
    ...(style ? { style } : {}),
    ...(background ? { background } : {}),
    ...(outputFormat ? { outputFormat } : {}),
    ...(moderation ? { moderation } : {}),
    timeoutMs: resolveBoardTimeoutMs("image", input.overrides?.timeoutSeconds ?? config.timeoutSeconds),
  };

  const { firstTask: task, slots } = await submitBoardImages(runner, generation, references, count);

  const at = now();
  const resultNodes: ImageBoardNode[] = [];
  const card = count === 1 ? { width: 300, height: 310 } : { width: 240, height: 240 };
  const positions = count === 1
    ? [placeResultNode(board.doc.nodes, card, config.x + config.width + 120, config.y)]
    : placeImageResultGrid(board.doc.nodes, config, count, card);
  let nextRef = board.doc.nextRef;
  for (let index = 0; index < count; index += 1) {
    const allocated = allocateNodeRef({ nodes: [...board.doc.nodes, ...resultNodes], nextRef });
    nextRef = allocated.nextRef;
    const position = positions[index]!;
    resultNodes.push({
      id: `node-${crypto.randomUUID()}`,
      ref: allocated.ref,
      type: "image",
      x: position.x,
      y: position.y,
      ...card,
      title: `结果 ${index + 1}`,
      createdAt: at,
      updatedAt: at,
      assetId: null,
      source: "generated",
      ...slots[index]!,
      prompt,
      useUpstreamText: false,
    });
  }

  const resultNodeIds = resultNodes.map((node) => node.id);
  if (resultNodes.length > 1) {
    resultNodes[0]!.imageResultGroup = { memberIds: resultNodeIds.slice(1), expanded: false };
  }
  const assignments = resultNodes.flatMap((node) => node.taskId ? [{ taskId: node.taskId, resultNodeIds: [node.id] }] : []);
  const nodes: BoardNode[] = [
    ...board.doc.nodes.map((node) => node.id === config.id
      ? {
        ...node,
        status: "loading" as const,
        lastTaskId: task.id,
        imageBatchResultIds: count > 1 ? resultNodeIds : undefined,
        model: resolution.alias,
        channelId: channel.id,
        updatedAt: at,
        error: undefined,
      } as BoardNode
      : node),
    ...resultNodes,
  ];
  const edges = [
    ...board.doc.edges,
    ...resultNodes.map((node) => ({
      id: `edge-${crypto.randomUUID()}`,
      source: config.id,
      target: node.id,
      kind: "result" as const,
    })),
  ];
  const doc: BoardDoc = { ...board.doc, nextRef, nodes, edges };

  saveGeneratedBoard(db, runner, {
    board, doc, source: config, taskId: task.id, resultNodeIds, kind: "image", assignments,
  });

  return {
    board: boardView(db, requireBoard(db, input.boardId)),
    task,
    taskIds: assignments.map((assignment) => assignment.taskId),
    kind: "image",
    resultNodeIds,
    configNodeId: config.id,
    prompt,
    referenceCount: references.length,
    modelAlias: resolution.alias,
  };
}
