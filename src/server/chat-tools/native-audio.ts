import { z } from "zod";
import { buildConfirmPreview } from "../agent-confirm.js";
import { generateMusicSchema, generateSpeechSchema, prepareMusicInput, prepareSpeechInput, type ToolContext } from "../agent-tools.js";
import type { BrainToolSpec } from "../brain.js";
import type { PreparedToolConfirmation } from "./registry.js";

const musicSchema = generateMusicSchema.extend({
  mode: z.enum(["inspiration", "custom", "cover", "mashup", "sound", "playlist", "sample"]).optional(),
  instrumental: z.boolean().optional(),
  loop: z.boolean().optional(),
}).strict();
const speechSchema = generateSpeechSchema.strict();

export const nativeAudioSpecs = {
  generate_music: {
    type: "function",
    function: {
      name: "generate_music",
      description: "生成音乐或音效。只有用户明确要求时单独调用并等待确认。自定义歌词需要 tags。翻唱指定一首已有会话歌曲并提供歌词，省略歌词时沿用原词。混音指定同一渠道的两首不同会话歌曲。音效可设置 tempo、key、loop。词元流墟 v6 创作支持 45/60 秒目标时长，自定义歌词可设置 0 到 1 的 styleWeight 和 weirdness。",
      parameters: z.toJSONSchema(musicSchema),
    },
  },
  generate_speech: {
    type: "function",
    function: {
      name: "generate_speech",
      description: "按用户要求朗读正文或生成双人配音。单独调用并等待确认。双人对话逐行用 A：、B：标记，并分别填写 voice、secondVoice；不要把指令写入正文。",
      parameters: z.toJSONSchema(speechSchema),
    },
  },
} satisfies Record<string, BrainToolSpec>;

export function prepareNativeAudio(ctx: ToolContext, tool: keyof typeof nativeAudioSpecs, raw: string): PreparedToolConfirmation | { error: string } {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { error: "音频参数不是有效 JSON" }; }
  if (tool === "generate_music") {
    const parsed = musicSchema.safeParse(value);
    if (!parsed.success) return { error: "音乐参数无效，请检查模式、歌词和源歌曲" };
    const prepared = prepareMusicInput({ ...ctx, strictSubmission: true }, parsed.data);
    if ("result" in prepared) return { error: prepared.result.summary };
    const { input, resolution, channel, mode, instrumental, sourceAssets } = prepared;
    if (sourceAssets.length && mode !== "cover" && mode !== "mashup") {
      return { error: "指定源歌曲时请选择翻唱或混音模式" };
    }
    const args = {
      ...parsed.data, modelHint: resolution.alias, prompt: input.prompt, mode, instrumental,
      sourceAssetRefs: sourceAssets.map(asset => asset.id),
      targetDuration: input.musicTargetDuration,
      styleWeight: input.musicStyleWeight,
      weirdness: input.musicWeirdness,
      ...(input.musicSoundConfigs ? input.musicSoundConfigs : {}),
    };
    const preview = buildConfirmPreview(ctx.db, ctx.conversation, [{ tool, args }], "native_audio", undefined, undefined, ctx.defaultAliases);
    return { args, preview, target: { kind: "audio", channelId: channel.id, channelVersion: channel.updatedAt, model: resolution.model } };
  }

  const parsed = speechSchema.safeParse(value);
  if (!parsed.success) return { error: "配音参数无效，请检查正文、音色和语言" };
  const prepared = prepareSpeechInput(ctx, parsed.data);
  if ("result" in prepared) return { error: prepared.result.summary };
  const { input, resolution, channel, voice, second } = prepared;
  return {
    args: { ...parsed.data, modelHint: resolution.alias, text: input.prompt, voice, secondVoice: second ?? undefined },
    preview: {
      reason: "native_audio", prompt: input.prompt, model: resolution.model, channelName: channel.name,
      message: "配音会使用所选语音渠道并产生费用，请核对正文和音色。",
      speechVoice: voice, speechSecondVoice: second ?? undefined, speechStyle: input.ttsStyle, speechLanguage: input.ttsLanguage,
    },
    target: { kind: "audio", channelId: channel.id, channelVersion: channel.updatedAt, model: resolution.model },
  };
}
