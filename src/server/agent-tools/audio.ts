import { assetRef, type GenerateMusicArgs, type GenerateSpeechArgs } from "../../shared/agent-types.js";
import { formatTtsDialogue, TTS_DEFAULT_VOICE, TTS_VOICES } from "../../shared/tts.js";
import { isSunoSong, MUSIC_MODE_LABELS, SUNO_DAMOBI_MODEL } from "../../shared/suno.js";
import type { GenerationInput } from "../../shared/types.js";
import { describeAliasChoice, resolveAlias } from "../capabilities.js";
import type { AssetRow } from "../db.js";
import { resolveAssetRef } from "./assets.js";
import { describeError, failResult, okResult, type ToolContext, type ToolOutcome } from "./shared.js";

type AudioPreparationContext = Pick<ToolContext, "db" | "conversation" | "aliases" | "defaultAliases" | "verbatimPrompt" | "strictSubmission">;

export function prepareMusicInput(ctx: AudioPreparationContext, args: GenerateMusicArgs) {
  let resolution = resolveAlias(ctx.aliases, args.modelHint, "audio", ctx.defaultAliases.music);
  if (!resolution) return failResult("还没有可用的音乐渠道，请先到「渠道配置」添加", "NO_MUSIC_CHANNEL");
  let channel = ctx.db.getChannel(resolution.channelId);
  // audio 类里现在同时有 Suno 和 TTS：默认音频模型若被设成配音，音乐工具退回第一个 Suno
  if (channel && channel.adapterType !== "suno-music") {
    const suno = ctx.aliases.find((item) => item.adapterType === "suno-music");
    if (suno) {
      resolution = { ...suno, usedFallback: true, source: "fallback" };
      channel = ctx.db.getChannel(suno.channelId);
    }
  }
  if (!channel) return failResult("解析到的音乐渠道不存在", "CHANNEL_NOT_FOUND");
  if (channel.adapterType !== "suno-music") {
    return failResult("audio 类里没有音乐渠道，不能写歌；配旁白请用 generate_speech", "MUSIC_CHANNEL_MISMATCH");
  }

  const mode = args.mode
    ?? (args.sourceAssetRefs?.length
      ? (args.sourceAssetRefs.length >= 2 ? "mashup" : "cover")
      : args.tags?.trim() || args.title?.trim() ? "custom" : "inspiration");
  let prompt = (ctx.verbatimPrompt ?? args.prompt ?? "").trim();
  const instrumental = mode === "sound" ? true : args.instrumental ?? false;

  if (mode !== "sound" && mode !== "mashup" && mode !== "cover" && !prompt) {
    return failResult("这个音乐模式需要 prompt。请让用户描述风格或提供歌词", "MUSIC_PROMPT_REQUIRED");
  }
  if (mode === "inspiration" && prompt.length > 500) {
    return failResult("灵感描述最多 500 字，请压缩后再提交", "MUSIC_PROMPT_TOO_LONG");
  }
  if (mode === "custom" && !args.tags?.trim()) {
    return failResult("自定义歌词模式需要曲风（tags）。请先用 ask 问用户想要什么曲风，或改成灵感模式", "MUSIC_TAGS_REQUIRED");
  }
  if (mode === "sound" && !args.tags?.trim() && !prompt) {
    return failResult("音效模式需要描述音效内容", "MUSIC_SOUND_TAGS_REQUIRED");
  }

  // 翻唱 / 混音要引用本会话里带 Suno custom_id 的歌
  const sourceAssets: AssetRow[] = [];
  const sourceRefs = args.sourceAssetRefs ?? [];
  if (ctx.strictSubmission && sourceRefs.length) {
    const ids = [...new Set(ctx.db.listConversationAssets(ctx.conversation.id).map(({ asset }) => asset.id.toLowerCase()))];
    for (const ref of sourceRefs) {
      const key = ref.toLowerCase().replace(/^#/, "");
      if (!key || (!ids.includes(key) && ids.filter(id => id.startsWith(key)).length !== 1)) {
        return failResult(`源歌曲 ${ref} 不存在或编号不唯一，请指定会话内的歌曲编号`, "MUSIC_SOURCE_NOT_FOUND");
      }
    }
  }
  for (const ref of sourceRefs) {
    const resolved = resolveAssetRef(ctx.db, ctx.conversation.id, ref);
    if (!resolved) return failResult(`找不到歌曲 ${ref}，请用本会话里出现过的产物编号`, "MUSIC_SOURCE_NOT_FOUND");
    const sourceTask = ctx.db.getTaskView(resolved.asset.taskId);
    const sourceAsset = sourceTask?.assets.find(asset => asset.id === resolved.asset.id);
    if (!sourceTask || !sourceAsset || !isSunoSong(sourceTask, sourceAsset)) {
      return failResult(`${ref} 不是带 Suno ID 的音乐产物，不能用它翻唱或混音`, "MUSIC_SOURCE_INVALID");
    }
    if (sourceTask.channelId !== channel.id) {
      return failResult(`${ref} 来自 ${sourceTask.channelName}，请使用源歌曲所在的渠道`, "MUSIC_SOURCE_CHANNEL_MISMATCH");
    }
    sourceAssets.push(resolved.asset);
  }
  if (mode === "cover" && sourceAssets.length !== 1) {
    return failResult("翻唱需要正好 1 首源歌曲（sourceAssetRefs 给 1 个）", "MUSIC_COVER_SOURCE_REQUIRED");
  }
  if (mode === "cover") {
    prompt ||= sourceAssets[0]!.lyrics.trim().slice(0, 5000);
    if (!prompt) return failResult("翻唱需要歌词，请提供要演唱的文本", "MUSIC_PROMPT_REQUIRED");
  }
  if (mode === "mashup") {
    if (sourceAssets.length !== 2) {
      return failResult("混音需要正好 2 首源歌曲（sourceAssetRefs 给 2 个）", "MUSIC_MASHUP_SOURCE_REQUIRED");
    }
    if (sourceAssets[0]!.remoteClipId === sourceAssets[1]!.remoteClipId) {
      return failResult("混音的两首歌不能是同一首", "MUSIC_MASHUP_SAME_SOURCE");
    }
  }

  const input: GenerationInput = {
    channelId: channel.id,
    model: resolution.model,
    prompt,
    musicMode: mode,
    musicInstrumental: instrumental,
    musicVersion: args.version,
    ...(resolution.model === SUNO_DAMOBI_MODEL && (mode === "inspiration" || mode === "custom")
      ? { musicTargetDuration: args.targetDuration } : {}),
    ...(resolution.model === SUNO_DAMOBI_MODEL && mode === "custom"
      ? { musicStyleWeight: args.styleWeight, musicWeirdness: args.weirdness } : {}),
    ...(["custom", "mashup", "sound"].includes(mode) ? {
      musicTitle: args.title?.trim() || undefined,
    } : {}),
    ...(["custom", "sound"].includes(mode) ? {
      musicTags: args.tags?.trim() || (mode === "sound" ? prompt : undefined),
      musicNegativeTags: args.negativeTags?.trim() || undefined,
    } : {}),
    ...(mode === "cover" ? { musicCoverClipId: sourceAssets[0]!.remoteClipId! } : {}),
    ...(mode === "mashup" ? { musicMashupClipIds: sourceAssets.map((asset) => asset.remoteClipId!) } : {}),
    ...(mode === "sound" ? {
      musicSoundConfigs: {
        tempo: args.tempo ?? 99,
        key: args.key?.trim() || "C",
        loop: args.loop ?? false,
      },
    } : {}),
    timeoutMs: 900_000,
  };
  return { input, resolution, channel, mode, instrumental, sourceAssets };
}

export async function generateMusic(ctx: ToolContext, args: GenerateMusicArgs): Promise<ToolOutcome> {
  const prepared = prepareMusicInput(ctx, args);
  if ("result" in prepared) return prepared;
  const { input, resolution, mode, instrumental, sourceAssets } = prepared;
  try {
    ctx.signal?.throwIfAborted();
    const created = await ctx.runner.create(input, [], undefined, "conversation", ctx.conversation.id, ctx.operationId);
    ctx.emit({ type: "progress", taskId: created.id, status: created.status, progress: created.progress });
    const choice = describeAliasChoice(resolution);
    const modeLabel = mode === "inspiration" && instrumental ? "纯音乐" : MUSIC_MODE_LABELS[mode];
    const sourcePart = sourceAssets.length
      ? `，源歌曲 ${sourceAssets.map((asset) => assetRef(asset.id)).join(" + ")}`
      : "";
    const summary = [
      `已提交音乐任务 ${created.id.slice(0, 8)}，模型 ${resolution.model}（${resolution.alias}）${choice ? `，${choice}` : ""}，`,
      `${modeLabel}${args.title?.trim() ? `《${args.title.trim()}》` : ""}${sourcePart}。`,
      "通常返回 2 个成品。",
    ].join("");
    return okResult(summary, {
      async: true,
      taskId: created.id,
      data: {
        model: resolution.model, alias: resolution.alias,
        usedFallback: resolution.usedFallback, ...(choice ? { aliasNote: choice } : {}),
        musicMode: mode,
        ...(args.title?.trim() ? { musicTitle: args.title.trim() } : {}),
        ...(args.tags?.trim() ? { musicTags: args.tags.trim() } : {}),
        musicInstrumental: instrumental,
        ...(sourceAssets.length ? { musicSourceAssetIds: sourceAssets.map((asset) => asset.id) } : {}),
      },
    });
  } catch (error) {
    return failResult(`提交音乐失败：${describeError(error)}`, "MUSIC_SUBMIT_FAILED");
  }
}

/**
 * 配音走的是异步任务表里的同步路径：TTS 一次请求就回 WAV。
 * 它和音乐同属 audio 类，但适配器不同；这里只挑 gemini-tts 的别名，
 * 不会把 Suno 渠道误当成配音渠道。
 */
export function prepareSpeechInput(ctx: AudioPreparationContext, args: GenerateSpeechArgs) {
  const ttsAliases = ctx.aliases.filter((item) => item.adapterType === "gemini-tts");
  if (!ttsAliases.length) {
    return failResult("还没有可用的语音渠道，请先到「模型设置」添加「词元流墟-语音」", "NO_SPEECH_CHANNEL");
  }
  const hint = args.modelHint?.trim();
  const requested = hint ? ctx.aliases.find((item) => item.alias === hint) : undefined;
  if (requested && requested.adapterType !== "gemini-tts") {
    return failResult(`${hint} 是音乐渠道，不能朗读文本；配音请用语音渠道的 alias`, "SPEECH_CHANNEL_MISMATCH");
  }
  const resolution = requested ?? ttsAliases.find((item) => item.alias === ctx.defaultAliases.speech) ?? ttsAliases[0]!;
  const channel = ctx.db.getChannel(resolution.channelId);
  if (!channel) return failResult("解析到的语音渠道不存在", "CHANNEL_NOT_FOUND");

  const normalizeVoice = (value: string | undefined, fallback: string) => {
    const input = value?.trim();
    if (!input) return fallback;
    const match = TTS_VOICES.find((voice) => voice.toLowerCase() === input.toLowerCase());
    return match ?? null;
  };
  const voice = normalizeVoice(args.voice, TTS_DEFAULT_VOICE);
  if (!voice) return failResult(`音色「${args.voice}」不存在。可用音色：${TTS_VOICES.join("、")}`, "TTS_VOICE_INVALID");
  const second = args.secondVoice?.trim() ? normalizeVoice(args.secondVoice, TTS_DEFAULT_VOICE) : null;
  if (args.secondVoice?.trim() && !second) {
    return failResult(`第二个音色「${args.secondVoice}」不存在。可用音色：${TTS_VOICES.join("、")}`, "TTS_VOICE_INVALID");
  }
  let text = args.text.trim();
  if (!text) return failResult("配音正文不能为空", "SPEECH_TEXT_REQUIRED");
  if (second) {
    try { text = formatTtsDialogue(text); }
    catch (error) { return failResult(describeError(error), "SPEECH_SPEAKERS_REQUIRED"); }
  }

  const input: GenerationInput = {
    channelId: channel.id,
    model: resolution.model,
    prompt: text,
    ttsVoice: voice,
    ttsStyle: args.style?.trim() || undefined,
    ttsLanguage: args.language?.trim() || undefined,
    ...(second ? {
      ttsSpeakers: [
        { speaker: "A", voice },
        { speaker: "B", voice: second },
      ],
    } : {}),
    timeoutMs: 300_000,
  };
  return { input, resolution, channel, voice, second };
}

export async function generateSpeech(ctx: ToolContext, args: GenerateSpeechArgs): Promise<ToolOutcome> {
  const prepared = prepareSpeechInput(ctx, args);
  if ("result" in prepared) return prepared;
  const { input, resolution, voice, second } = prepared;
  try {
    ctx.signal?.throwIfAborted();
    const created = await ctx.runner.create(input, [], undefined, "conversation", ctx.conversation.id, ctx.operationId);
    ctx.emit({ type: "progress", taskId: created.id, status: created.status, progress: created.progress });
    if (ctx.backgroundMedia) {
      return okResult("已提交配音任务，完成后会更新原卡片。", { async: true, taskId: created.id });
    }
    const task = await ctx.runner.waitFor(created.id, { timeoutMs: 360_000, signal: ctx.signal });
    const asset = task.assets.find((item) => item.mimeType.startsWith("audio/"));
    if (task.status !== "succeeded" || !asset) {
      return failResult(
        `配音失败：${task.errorMessage || task.errorCode || "没有生成音频"}`,
        task.errorCode ?? "SPEECH_FAILED",
      );
    }
    const duration = asset.duration ? `，${asset.duration.toFixed(1)} 秒` : "";
    return okResult(
      `配音完成${duration}，已保存 ${assetRef(asset.id)}。`,
      {
        taskId: task.id,
        assetId: asset.id,
        mimeType: asset.mimeType,
        data: {
          model: resolution.model,
          alias: resolution.alias,
          voice,
          ...(second ? { secondVoice: second } : {}),
          ...(args.style?.trim() ? { style: args.style.trim() } : {}),
          ...(args.language?.trim() ? { language: args.language.trim() } : {}),
        },
      },
    );
  } catch (error) {
    return failResult(`生成配音失败：${describeError(error)}`, "SPEECH_FAILED");
  }
}
