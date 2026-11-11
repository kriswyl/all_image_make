import crypto from "node:crypto";
import type { AppDatabase, BoardRecord } from "./db.js";
import { allocateNodeRef, BOARD_LIMITS, directUpstreamImages, type BoardDoc, type BoardNode, type ConfigBoardNode, type ImageBoardNode } from "../shared/board.js";
import { AppError } from "./app-error.js";
import type { ReferenceImageUpload, TaskRunner } from "./tasks.js";
import { prepareImageBytes, REFERENCE_PROFILE } from "./vision.js";
import { buildCapabilityAliases, resolveAlias } from "./capabilities.js";
import type { GenerationInput } from "../shared/types.js";
import { boardView, requireBoard } from "./board-core.js";
import { now, placeResultNode, saveGeneratedBoard, type BoardGenerateOverrides, type BoardGenerateResult } from "./board-generation-shared.js";

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
  const count = Math.min(
    BOARD_LIMITS.maxCount,
    Math.max(1, Math.floor(Number(input.overrides?.count ?? config.count) || 1)),
  );
  if (board.doc.nodes.length + count > BOARD_LIMITS.maxNodes) {
    throw new AppError("BOARD_NODE_LIMIT", `一块无限画布最多 ${BOARD_LIMITS.maxNodes} 个节点，请先删掉一些`, 400);
  }

  // 直接上游图片按画布位置排序，最多 8 张；读不到字节的跳过，不让一张坏图带走整次生成
  const references: ReferenceImageUpload[] = [];
  for (const node of directUpstreamImages(board.doc, config.id)) {
    if (!node.assetId) continue;
    const asset = db.getAsset(node.assetId);
    if (!asset) continue;
    const prepared = await prepareImageBytes(db, asset, REFERENCE_PROFILE);
    if (!prepared) continue;
    references.push({
      bytes: prepared.bytes,
      mimeType: prepared.mimeType,
      fileName: prepared.fileName,
    });
  }

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
    prompt,
    count,
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
  };

  const task = await runner.create(generation, references);

  const at = now();
  const resultNodes: ImageBoardNode[] = [];
  let nextRef = board.doc.nextRef;
  for (let index = 0; index < count; index += 1) {
    const allocated = allocateNodeRef({ nodes: [...board.doc.nodes, ...resultNodes], nextRef });
    nextRef = allocated.nextRef;
    const position = placeResultNode(
      [...board.doc.nodes, ...resultNodes],
      { width: 300, height: 310 },
      config.x + config.width + 120,
      config.y,
    );
    resultNodes.push({
      id: `node-${crypto.randomUUID()}`,
      ref: allocated.ref,
      type: "image",
      x: position.x,
      y: position.y,
      width: 300,
      height: 310,
      title: `结果 ${index + 1}`,
      createdAt: at,
      updatedAt: at,
      assetId: null,
      source: "generated",
      status: "loading",
      taskId: task.id,
      prompt,
      useUpstreamText: false,
    });
  }

  const resultNodeIds = resultNodes.map((node) => node.id);
  const nodes: BoardNode[] = [
    ...board.doc.nodes.map((node) => node.id === config.id
      ? {
        ...node,
        status: "loading" as const,
        lastTaskId: task.id,
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
    board, doc, source: config, taskId: task.id, resultNodeIds, kind: "image",
  });

  return {
    board: boardView(db, requireBoard(db, input.boardId)),
    task,
    kind: "image",
    resultNodeIds,
    configNodeId: config.id,
    prompt,
    referenceCount: references.length,
    modelAlias: resolution.alias,
  };
}
