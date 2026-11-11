import crypto from "node:crypto";
import type { AppDatabase, BoardRecord } from "./db.js";
import { allocateNodeRef, BOARD_LIMITS, directInputLinks, type BoardDoc, type BoardNode, type BoardAudioKind, type AudioBoardNode, type ConfigBoardNode } from "../shared/board.js";
import { AppError } from "./app-error.js";
import type { TaskRunner } from "./tasks.js";
import { buildCapabilityAliases, resolveAlias } from "./capabilities.js";
import type { GenerationInput } from "../shared/types.js";
import { TTS_DEFAULT_VOICE, TTS_VOICES } from "../shared/tts.js";
import { boardView, requireBoard } from "./board-core.js";
import { now, placeResultNode, saveGeneratedBoard, type BoardGenerateResult } from "./board-generation-shared.js";

export async function generateBoardAudio(input: {
  db: AppDatabase;
  runner: TaskRunner;
  boardId: string;
  board: BoardRecord;
  config: ConfigBoardNode;
  prompt: string;
  overrides?: {
    model?: string;
    audioKind?: BoardAudioKind;
    voice?: string;
    ttsStyle?: string;
    instrumental?: boolean;
    musicTitle?: string;
    musicTags?: string;
    musicNegativeTags?: string;
  };
}): Promise<BoardGenerateResult> {
  const { db, runner, board, config } = input;
  const links = directInputLinks(board.doc, config.id);
  if (links.some((link) => link.node.type !== "text")) {
    throw new AppError("BOARD_AUDIO_INPUT_UNSUPPORTED", "生音频只用文本上游；请断开图片 / 视频连线", 400);
  }
  const kind: BoardAudioKind = input.overrides?.audioKind ?? config.audioKind ?? "speech";
  const count = kind === "music" ? 2 : 1;
  if (board.doc.nodes.length + count > BOARD_LIMITS.maxNodes) {
    throw new AppError("BOARD_NODE_LIMIT", `一块无限画布最多 ${BOARD_LIMITS.maxNodes} 个节点，请先删掉一些`, 400);
  }

  const allAliases = buildCapabilityAliases(db.listChannels());
  const wantedAdapter = kind === "music" ? "suno-music" : "gemini-tts";
  const aliases = allAliases.filter((alias) => alias.kind === "audio" && alias.adapterType === wantedAdapter);
  if (!aliases.length) {
    throw new AppError("BOARD_NO_AUDIO_CHANNEL", kind === "music"
      ? "还没有可用的音乐渠道，请先到「模型配置」添加"
      : "还没有可用的语音渠道，请先到「模型配置」添加", 400);
  }
  const hint = input.overrides?.model ?? config.model;
  const hinted = hint ? allAliases.find((alias) => alias.alias === hint) : undefined;
  if (hinted && hinted.adapterType !== wantedAdapter) {
    throw new AppError("BOARD_AUDIO_KIND_MISMATCH", hinted.adapterType === "gemini-tts"
      ? "当前模型是配音模型，不能用来生成音乐"
      : "当前模型是音乐模型，不能用来做配音", 400);
  }
  const preferred = kind === "music"
    ? db.getSetting("agentDefaultMusicAlias") ?? db.getSetting("agentDefaultAudioAlias") ?? undefined
    : db.getSetting("agentDefaultSpeechAlias") ?? db.getSetting("agentDefaultAudioAlias") ?? undefined;
  const resolution = resolveAlias(aliases, hint, "audio", preferred);
  if (!resolution) throw new AppError("BOARD_NO_AUDIO_CHANNEL", "没有解析到可用的音频模型", 400);
  const channel = db.getChannel(resolution.channelId);
  if (!channel || !channel.enabled) {
    throw new AppError("BOARD_NO_AUDIO_CHANNEL", "解析到的音频渠道不存在或未启用", 400);
  }

  let voice = "";
  if (kind === "speech") {
    const requested = (input.overrides?.voice ?? config.voice ?? "").trim();
    if (requested) {
      const match = TTS_VOICES.find((item) => item.toLowerCase() === requested.toLowerCase());
      if (!match) throw new AppError("BOARD_TTS_VOICE_INVALID", `音色「${requested}」不存在。可用音色：${TTS_VOICES.join("、")}`, 400);
      voice = match;
    } else {
      voice = TTS_DEFAULT_VOICE;
    }
  }

  const generation: GenerationInput = kind === "music"
    ? {
      channelId: channel.id,
      model: resolution.model,
      prompt: input.prompt,
      musicMode: "inspiration",
      musicInstrumental: input.overrides?.instrumental ?? config.instrumental ?? false,
      ...((input.overrides?.musicTitle ?? config.musicTitle)
        ? { musicTitle: input.overrides?.musicTitle ?? config.musicTitle }
        : {}),
      ...((input.overrides?.musicTags ?? config.musicTags)
        ? { musicTags: input.overrides?.musicTags ?? config.musicTags }
        : {}),
      ...((input.overrides?.musicNegativeTags ?? config.musicNegativeTags)
        ? { musicNegativeTags: input.overrides?.musicNegativeTags ?? config.musicNegativeTags }
        : {}),
      timeoutMs: 900_000,
    }
    : {
      channelId: channel.id,
      model: resolution.model,
      prompt: input.prompt,
      ttsVoice: voice,
      ttsStyle: input.overrides?.ttsStyle ?? config.ttsStyle,
      timeoutMs: 300_000,
    };

  const task = await runner.create(generation);

  const at = now();
  const resultNodes: AudioBoardNode[] = [];
  let nextRef = board.doc.nextRef;
  for (let index = 0; index < count; index += 1) {
    const allocated = allocateNodeRef({ nodes: [...board.doc.nodes, ...resultNodes], nextRef });
    nextRef = allocated.nextRef;
    const position = placeResultNode(
      [...board.doc.nodes, ...resultNodes],
      { width: 320, height: 220 },
      config.x + config.width + 120,
      config.y,
    );
    resultNodes.push({
      id: `node-${crypto.randomUUID()}`,
      ref: allocated.ref,
      type: "audio",
      x: position.x,
      y: position.y,
      width: 320,
      height: 220,
      title: kind === "music" ? `音乐结果 ${index + 1}` : "配音结果",
      createdAt: at,
      updatedAt: at,
      assetId: null,
      source: "generated",
      status: "loading",
      taskId: task.id,
      prompt: input.prompt,
      audioKind: kind,
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
        audioKind: kind,
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
    board, doc, source: config, taskId: task.id, resultNodeIds, kind: "audio",
  });

  return {
    board: boardView(db, requireBoard(db, input.boardId)),
    task,
    kind: "audio",
    resultNodeIds,
    configNodeId: config.id,
    prompt: input.prompt,
    referenceCount: 0,
    modelAlias: resolution.alias,
  };
}
