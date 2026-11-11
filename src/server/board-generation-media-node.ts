import type { AppDatabase, BoardRecord } from "./db.js";
import { BOARD_LIMITS, composeConfigPrompt, directInputLinks, directUpstreamImages, type BoardDoc, type BoardNode, type BoardAudioKind, type AudioBoardNode, type ImageBoardNode, type VideoBoardNode } from "../shared/board.js";
import { AppError } from "./app-error.js";
import type { ReferenceImageUpload, TaskRunner } from "./tasks.js";
import { prepareImageBytes, REFERENCE_PROFILE, videoInlineProfile } from "./vision.js";
import { buildCapabilityAliases, resolveAlias } from "./capabilities.js";
import type { GenerationInput, KlingMediaType, SeedanceVideoMode, Task, VideoMediaType, WanVideoMode } from "../shared/types.js";
import { VIDEO_CAPABILITIES, VIDEO_DEFAULTS, type VideoAdapter } from "../shared/video-capabilities.js";
import { TTS_DEFAULT_VOICE, TTS_VOICES } from "../shared/tts.js";
import type { KeyStore } from "./key-store.js";
import { boardView, requireBoard } from "./board-core.js";
import { resolveBoardVideoSelection } from "./board-video-selection.js";
import { now, appendBoardMediaInputs, saveGeneratedBoard, type BoardGenerateOverrides, type BoardGenerateResult } from "./board-generation-shared.js";

/**
 * 图片 / 视频 / 音频节点就地生成。
 *
 * 和配置节点不同：不新建结果卡片，任务完成后把素材回填到当前节点本身。
 * 这样「一张图 = 一个提示词 + 结果」，连线只保留真正有意义的上下游关系。
 */
export async function generateBoardMediaNode(input: {
  db: AppDatabase;
  runner: TaskRunner;
  keys: KeyStore;
  boardId: string;
  board: BoardRecord;
  node: ImageBoardNode | VideoBoardNode | AudioBoardNode;
  overrides?: BoardGenerateOverrides;
}): Promise<BoardGenerateResult> {
  const { db, runner, board, node } = input;
  const overrides = input.overrides ?? {};
  const prompt = composeConfigPrompt(board.doc, {
    id: node.id,
    prompt: overrides.prompt ?? node.prompt ?? "",
    useUpstreamText: node.useUpstreamText !== false,
  }).trim();
  if (!prompt) {
    throw new AppError("BOARD_PROMPT_EMPTY", "提示词是空的：在节点里写一句，或把文本节点连到左边", 400);
  }
  if (prompt.length > BOARD_LIMITS.maxTextChars) {
    throw new AppError("BOARD_PROMPT_TOO_LONG", `提示词超过 ${BOARD_LIMITS.maxTextChars} 字，请删减后再试`, 400);
  }

  let task: Task;
  let kind: "image" | "video" | "audio";
  let modelAlias: string;
  let referenceCount = 0;
  let patch: Record<string, unknown> = { prompt, source: "generated" };

  if (node.type === "image") {
    const references: ReferenceImageUpload[] = [];
    for (const upstream of directUpstreamImages(board.doc, node.id)) {
      if (!upstream.assetId) continue;
      const asset = db.getAsset(upstream.assetId);
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
      overrides.model ?? node.model,
      "image",
      db.getSetting("agentDefaultImageAlias") ?? undefined,
    );
    if (!resolution) throw new AppError("BOARD_NO_IMAGE_CHANNEL", "还没有可用的生图渠道，请先到「模型配置」添加", 400);
    const channel = db.getChannel(resolution.channelId);
    if (!channel || !channel.enabled) throw new AppError("BOARD_NO_IMAGE_CHANNEL", "解析到的生图渠道不存在或未启用", 400);
    const size = overrides.size ?? node.size;
    const imageSize = overrides.imageSize ?? node.imageSize;
    const quality = overrides.quality ?? node.quality;
    const negativePrompt = overrides.negativePrompt ?? node.negativePrompt;
    const aspectRatio = overrides.aspectRatio ?? node.aspectRatio;
    const seed = overrides.seed ?? node.seed;
    const style = overrides.style ?? node.style;
    const background = overrides.background ?? node.background;
    const outputFormat = overrides.outputFormat ?? node.outputFormat;
    const moderation = overrides.moderation ?? node.moderation;
    task = await runner.create({
      channelId: channel.id,
      model: resolution.model,
      prompt,
      count: 1,
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
    }, references);
    kind = "image";
    modelAlias = resolution.alias;
    referenceCount = references.length;
    patch = {
      ...patch,
      model: resolution.alias,
      channelId: channel.id,
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
  } else if (node.type === "video") {
    const aliases = buildCapabilityAliases(db.listChannels());
    const resolution = resolveAlias(
      aliases,
      overrides.model ?? node.model,
      "video",
      db.getSetting("agentDefaultVideoAlias") ?? undefined,
    );
    if (!resolution) throw new AppError("BOARD_NO_VIDEO_CHANNEL", "还没有可用的视频渠道，请先到「模型配置」添加", 400);
    const channel = db.getChannel(resolution.channelId);
    if (!channel || !channel.enabled) throw new AppError("BOARD_NO_VIDEO_CHANNEL", "解析到的视频渠道不存在或未启用", 400);
    const capability = VIDEO_CAPABILITIES[channel.adapterType as VideoAdapter];
    if (!capability) throw new AppError("BOARD_VIDEO_CHANNEL_MISMATCH", `渠道「${channel.name}」不是视频模型`, 400);
    const resolved = resolveBoardVideoSelection({
      doc: board.doc,
      config: node,
      adapterType: channel.adapterType,
      model: resolution.model,
      modeOverride: overrides.videoMode,
    });
    if (!resolved.selection) {
      throw new AppError("BOARD_VIDEO_INVALID", resolved.error ?? "这次视频用哪几张图没定下来", 400);
    }
    const selection = resolved.selection;
    const defaults = VIDEO_DEFAULTS[channel.adapterType] ?? { duration: 5, resolution: "720p", audio: false };
    const duration = overrides.durationSeconds ?? node.durationSeconds ?? defaults.duration;
    const resolutionValue = overrides.resolution ?? node.resolution ?? defaults.resolution;
    const audio = overrides.audio ?? node.audio ?? defaults.audio;
    const promptExtend = overrides.promptExtend ?? node.promptExtend ?? true;
    const watermark = overrides.watermark ?? node.watermark;
    const seed = overrides.seed ?? node.seed;
    const aspectRatio = overrides.aspectRatio ?? node.aspectRatio;
    const generation: GenerationInput = {
      channelId: channel.id,
      model: resolution.model,
      prompt,
      duration,
      resolution: resolutionValue,
      audio,
      promptExtend,
      ...(watermark === undefined ? {} : { watermark }),
      ...(seed === undefined ? {} : { seed }),
      ...(aspectRatio ? { aspectRatio } : {}),
      timeoutMs: 300_000,
    };
    const uploads: ReferenceImageUpload[] = [];
    if (selection.inputs.length) {
      const profile = videoInlineProfile(selection.inputs.length);
      const prepared: Array<{ bytes: Buffer; mimeType: "image/png" | "image/jpeg" | "image/webp"; fileName: string }> = [];
      for (const item of selection.inputs) {
        const asset = db.getAsset(item.assetId);
        if (!asset) throw new AppError("BOARD_ASSET_INVALID", `节点「${item.node.title || item.node.ref}」的素材不存在`, 400);
        const encoded = await prepareImageBytes(db, asset, profile);
        if (!encoded) throw new AppError("BOARD_ASSET_INVALID", `节点「${item.node.title || item.node.ref}」的图片读取失败`, 400);
        prepared.push(encoded);
      }
      if (channel.adapterType === "grok-video") {
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
    const referenceVideoUpload = await appendBoardMediaInputs(db, channel, board.doc, node.id, generation);
    task = await runner.create({ ...generation, referenceVideoUpload }, uploads);
    kind = "video";
    modelAlias = resolution.alias;
    referenceCount = selection.inputs.length;
    patch = {
      ...patch,
      model: resolution.alias,
      channelId: channel.id,
      ...(selection.mode === "motion-control" ? {} : { videoMode: selection.mode }),
      durationSeconds: duration,
      resolution: resolutionValue,
      audio,
      promptExtend,
      ...(watermark === undefined ? {} : { watermark }),
      ...(seed === undefined ? {} : { seed }),
      ...(aspectRatio ? { aspectRatio } : {}),
    };
  } else {
    const links = directInputLinks(board.doc, node.id);
    if (links.some((link) => link.node.type !== "text")) {
      throw new AppError("BOARD_AUDIO_INPUT_UNSUPPORTED", "生音频只用文本上游；请断开图片 / 视频连线", 400);
    }
    const audioKind: BoardAudioKind = overrides.audioKind ?? node.audioKind ?? "speech";
    const allAliases = buildCapabilityAliases(db.listChannels());
    const wantedAdapter = audioKind === "music" ? "suno-music" : "gemini-tts";
    const aliases = allAliases.filter((alias) => alias.kind === "audio" && alias.adapterType === wantedAdapter);
    if (!aliases.length) {
      throw new AppError("BOARD_NO_AUDIO_CHANNEL", audioKind === "music"
        ? "还没有可用的音乐渠道，请先到「模型配置」添加"
        : "还没有可用的语音渠道，请先到「模型配置」添加", 400);
    }
    const hint = overrides.model ?? node.model;
    const hinted = hint ? allAliases.find((alias) => alias.alias === hint) : undefined;
    if (hinted && hinted.adapterType !== wantedAdapter) {
      throw new AppError("BOARD_AUDIO_KIND_MISMATCH", hinted.adapterType === "gemini-tts"
        ? "当前模型是配音模型，不能用来生成音乐"
        : "当前模型是音乐模型，不能用来做配音", 400);
    }
    const preferred = audioKind === "music"
      ? db.getSetting("agentDefaultMusicAlias") ?? db.getSetting("agentDefaultAudioAlias") ?? undefined
      : db.getSetting("agentDefaultSpeechAlias") ?? db.getSetting("agentDefaultAudioAlias") ?? undefined;
    const resolution = resolveAlias(aliases, hint, "audio", preferred);
    if (!resolution) throw new AppError("BOARD_NO_AUDIO_CHANNEL", "没有解析到可用的音频模型", 400);
    const channel = db.getChannel(resolution.channelId);
    if (!channel || !channel.enabled) throw new AppError("BOARD_NO_AUDIO_CHANNEL", "解析到的音频渠道不存在或未启用", 400);
    let voice = "";
    if (audioKind === "speech") {
      const requested = (overrides.voice ?? node.voice ?? "").trim();
      if (requested) {
        const match = TTS_VOICES.find((item) => item.toLowerCase() === requested.toLowerCase());
        if (!match) throw new AppError("BOARD_TTS_VOICE_INVALID", `音色「${requested}」不存在。可用音色：${TTS_VOICES.join("、")}`, 400);
        voice = match;
      } else {
        voice = TTS_DEFAULT_VOICE;
      }
    }
    const instrumental = overrides.instrumental ?? node.instrumental ?? false;
    const musicTitle = overrides.musicTitle ?? node.musicTitle;
    const musicTags = overrides.musicTags ?? node.musicTags;
    const musicNegativeTags = overrides.musicNegativeTags ?? node.musicNegativeTags;
    task = await runner.create(audioKind === "music"
      ? {
        channelId: channel.id,
        model: resolution.model,
        prompt,
        musicMode: "inspiration",
        musicInstrumental: instrumental,
        ...(musicTitle ? { musicTitle } : {}),
        ...(musicTags ? { musicTags } : {}),
        ...(musicNegativeTags ? { musicNegativeTags } : {}),
        timeoutMs: 900_000,
      }
      : {
        channelId: channel.id,
        model: resolution.model,
        prompt,
        ttsVoice: voice,
        ttsStyle: overrides.ttsStyle ?? node.ttsStyle,
        timeoutMs: 300_000,
      });
    kind = "audio";
    modelAlias = resolution.alias;
    patch = {
      ...patch,
      model: resolution.alias,
      channelId: channel.id,
      audioKind,
      ...(audioKind === "speech" ? { voice } : {}),
      ...(audioKind === "speech" && (overrides.ttsStyle ?? node.ttsStyle)
        ? { ttsStyle: overrides.ttsStyle ?? node.ttsStyle }
        : {}),
      ...(audioKind === "music" ? { instrumental } : {}),
      ...(audioKind === "music" && musicTitle ? { musicTitle } : {}),
      ...(audioKind === "music" && musicTags ? { musicTags } : {}),
      ...(audioKind === "music" && musicNegativeTags ? { musicNegativeTags } : {}),
    };
  }

  const at = now();
  const doc: BoardDoc = {
    ...board.doc,
    nodes: board.doc.nodes.map((item) => item.id === node.id
      ? {
        ...item,
        ...patch,
        status: "loading" as const,
        taskId: task.id,
        updatedAt: at,
        error: undefined,
      } as BoardNode
      : item),
  };
  saveGeneratedBoard(db, runner, {
    board, doc, source: node, taskId: task.id, resultNodeIds: [node.id], kind: kind,
  });

  return {
    board: boardView(db, requireBoard(db, input.boardId)),
    task,
    kind,
    resultNodeIds: [node.id],
    configNodeId: node.id,
    prompt,
    referenceCount,
    modelAlias,
  };
}
