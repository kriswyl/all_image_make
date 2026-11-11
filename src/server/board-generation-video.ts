import crypto from "node:crypto";
import type { AppDatabase, BoardRecord } from "./db.js";
import { allocateNodeRef, BOARD_LIMITS, type BoardDoc, type BoardNode, type BoardVideoMode, type ConfigBoardNode, type VideoBoardNode } from "../shared/board.js";
import { AppError } from "./app-error.js";
import type { ReferenceImageUpload, TaskRunner } from "./tasks.js";
import { prepareImageBytes, videoInlineProfile } from "./vision.js";
import { buildCapabilityAliases, resolveAlias } from "./capabilities.js";
import type { GenerationInput, KlingMediaType, SeedanceVideoMode, VideoMediaType, WanVideoMode } from "../shared/types.js";
import { VIDEO_CAPABILITIES, VIDEO_DEFAULTS, type VideoAdapter } from "../shared/video-capabilities.js";
import { boardView, requireBoard } from "./board-core.js";
import { resolveBoardVideoSelection } from "./board-video-selection.js";
import { now, placeResultNode, appendBoardMediaInputs, saveGeneratedBoard, type BoardGenerateResult } from "./board-generation-shared.js";

export async function generateBoardVideo(input: {
  db: AppDatabase;
  runner: TaskRunner;
  boardId: string;
  board: BoardRecord;
  config: ConfigBoardNode;
  prompt: string;
  overrides?: {
    model?: string;
    videoMode?: BoardVideoMode;
    durationSeconds?: number;
    resolution?: string;
    audio?: boolean;
    seed?: number;
    aspectRatio?: string;
    ratio?: string;
    promptExtend?: boolean;
    watermark?: boolean;
  };
}): Promise<BoardGenerateResult> {
  const { db, runner, board, config } = input;
  if (board.doc.nodes.length + 1 > BOARD_LIMITS.maxNodes) {
    throw new AppError("BOARD_NODE_LIMIT", `一块无限画布最多 ${BOARD_LIMITS.maxNodes} 个节点，请先删掉一些`, 400);
  }

  const aliases = buildCapabilityAliases(db.listChannels());
  const resolution = resolveAlias(
    aliases,
    input.overrides?.model ?? config.model,
    "video",
    db.getSetting("agentDefaultVideoAlias") ?? undefined,
  );
  if (!resolution) throw new AppError("BOARD_NO_VIDEO_CHANNEL", "还没有可用的视频渠道，请先到「模型配置」添加", 400);
  const channel = db.getChannel(resolution.channelId);
  if (!channel || !channel.enabled) {
    throw new AppError("BOARD_NO_VIDEO_CHANNEL", "解析到的视频渠道不存在或未启用", 400);
  }
  const capability = VIDEO_CAPABILITIES[channel.adapterType as VideoAdapter];
  if (!capability) {
    throw new AppError("BOARD_VIDEO_CHANNEL_MISMATCH", `渠道「${channel.name}」不是视频模型`, 400);
  }

  const resolved = resolveBoardVideoSelection({
    doc: board.doc,
    config,
    adapterType: channel.adapterType,
    model: resolution.model,
    modeOverride: input.overrides?.videoMode,
  });
  if (!resolved.selection) {
    throw new AppError("BOARD_VIDEO_INVALID", resolved.error ?? "这次视频用哪几张图没定下来", 400);
  }
  const selection = resolved.selection;

  const defaults = VIDEO_DEFAULTS[channel.adapterType] ?? { duration: 5, resolution: "720p", audio: false };
  const generation: GenerationInput = {
    channelId: channel.id,
    model: resolution.model,
    prompt: input.prompt,
    duration: input.overrides?.durationSeconds ?? config.durationSeconds ?? defaults.duration,
    resolution: input.overrides?.resolution ?? config.resolution ?? defaults.resolution,
    audio: input.overrides?.audio ?? config.audio ?? defaults.audio,
    promptExtend: input.overrides?.promptExtend ?? config.promptExtend ?? true,
    ...((input.overrides?.watermark ?? config.watermark) === undefined
      ? {}
      : { watermark: input.overrides?.watermark ?? config.watermark }),
    ...((input.overrides?.seed ?? config.seed) === undefined
      ? {}
      : { seed: input.overrides?.seed ?? config.seed }),
    ...((input.overrides?.aspectRatio ?? config.aspectRatio)
      ? { aspectRatio: input.overrides?.aspectRatio ?? config.aspectRatio }
      : {}),
    ...((input.overrides?.ratio ?? config.ratio)
      ? { ratio: input.overrides?.ratio ?? config.ratio }
      : {}),
    timeoutMs: 300_000,
  };
  const uploads: ReferenceImageUpload[] = [];

  if (selection.inputs.length) {
    const profile = videoInlineProfile(selection.inputs.length);
    const prepared: Array<{ bytes: Buffer; mimeType: "image/png" | "image/jpeg" | "image/webp"; fileName: string }> = [];
    for (const item of selection.inputs) {
      const asset = db.getAsset(item.assetId);
      if (!asset) {
        throw new AppError("BOARD_ASSET_INVALID", `节点「${item.node.title || item.node.ref}」的素材不存在`, 400);
      }
      const encoded = await prepareImageBytes(db, asset, profile);
      if (!encoded) {
        throw new AppError("BOARD_ASSET_INVALID", `节点「${item.node.title || item.node.ref}」的图片读取失败`, 400);
      }
      prepared.push(encoded);
    }

    if (channel.adapterType === "grok-video") {
      // Grok 只吃 reference_images，没有首帧 / 尾帧字段
      for (const item of prepared) uploads.push(item);
    } else {
      const media = prepared.map((item, index) => ({
        role: selection.inputs[index]!.role,
        url: `data:${item.mimeType};base64,${item.bytes.toString("base64")}`,
      }));
      if (channel.adapterType === "seedance-video") {
        generation.seedanceVideoMedia = media.map((item) => ({ type: "image_url", url: item.url, role: item.role }));
        generation.seedanceVideoMode = selection.mode as SeedanceVideoMode;
        if (selection.mode === "first-frame" || selection.mode === "first-last-frame") generation.ratio = "adaptive";
      } else if (channel.adapterType === "kling-video") {
        generation.klingVideoMedia = media.map((item) => ({ type: selection.mode === "motion-control" ? "image" : item.role as KlingMediaType, url: item.url }));
        generation.klingVideoMode = selection.mode;
        generation.aspectRatio = generation.aspectRatio ?? "16:9";
      } else {
        generation.wanVideoMedia = media.map((item) => ({ type: item.role as VideoMediaType, url: item.url }));
        generation.wanVideoMode = selection.mode as WanVideoMode;
      }
    }
  } else if (channel.adapterType === "wan-video") {
    generation.wanVideoMode = "text-to-video";
  } else if (channel.adapterType === "seedance-video") {
    generation.seedanceVideoMode = "text-to-video";
  } else if (channel.adapterType === "kling-video") {
    generation.klingVideoMode = "text-to-video";
    generation.aspectRatio = generation.aspectRatio ?? "16:9";
  }

  const referenceVideoUpload = await appendBoardMediaInputs(db, channel, board.doc, config.id, generation);
  const task = await runner.create({ ...generation, referenceVideoUpload }, uploads);

  const at = now();
  const allocated = allocateNodeRef(board.doc);
  const position = placeResultNode(
    board.doc.nodes,
    { width: 320, height: 320 },
    config.x + config.width + 120,
    config.y,
  );
  const resultNode: VideoBoardNode = {
    id: `node-${crypto.randomUUID()}`,
    ref: allocated.ref,
    type: "video",
    x: position.x,
    y: position.y,
    width: 320,
    height: 320,
    title: "视频结果",
    createdAt: at,
    updatedAt: at,
    assetId: null,
    source: "generated",
    status: "loading",
    taskId: task.id,
    prompt: input.prompt,
    useUpstreamText: false,
  };

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
    resultNode,
  ];
  const edges = [
    ...board.doc.edges,
    {
      id: `edge-${crypto.randomUUID()}`,
      source: config.id,
      target: resultNode.id,
      kind: "result" as const,
    },
  ];
  const doc: BoardDoc = { ...board.doc, nextRef: allocated.nextRef, nodes, edges };

  saveGeneratedBoard(db, runner, {
    board, doc, source: config, taskId: task.id, resultNodeIds: [resultNode.id], kind: "video",
  });

  return {
    board: boardView(db, requireBoard(db, input.boardId)),
    task,
    kind: "video",
    resultNodeIds: [resultNode.id],
    configNodeId: config.id,
    prompt: input.prompt,
    referenceCount: selection.inputs.length,
    modelAlias: resolution.alias,
  };
}
