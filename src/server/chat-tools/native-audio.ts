import { z } from "zod";
import { buildConfirmPreview } from "../agent-confirm.js";
import { generateMusicSchema, generateSpeechSchema, prepareMusicInput, prepareSpeechInput, type ToolContext } from "../agent-tools.js";
import { describeZodIssues } from "../agent-tools/shared.js";
import type { BrainToolSpec } from "../brain.js";
import type { PreparedToolConfirmation } from "./registry.js";

/**
 * 聊天侧的音乐参数只做「加法」，不重新声明父 schema 里已有的字段。
 *
 * 踩过的坑（用户截图报「音乐参数无效，请检查模式、歌词和源歌曲」）：这里曾经把
 * mode / instrumental / loop 抄一遍再 `.strict()`，等于把 `generateMusicSchema` 上留的
 * 容错（mode 的 `.catch(undefined)`、布尔字段的 looseBoolean）全盖掉了。大脑偶尔会把
 * mode 写成枚举外的词、把布尔写成字符串或者多塞一个字段，父 schema 本来能收拾掉，
 * 子 schema 一覆盖就整轮校验失败——用户看到的是一句「参数无效」，而参数其实一个都不缺。
 *
 * 所以这里的规矩是：新增字段可以，重声明父字段不行；未知字段直接丢掉，不拦。
 */
export const nativeMusicParamsSchema = generateMusicSchema.extend({
  /** 大脑有时按 Suno 工作台的叫法把自定义歌词写进 lyrics，语义等同 prompt */
  lyrics: z.string().trim().max(5000).describe("自定义/翻唱模式的歌词，等同于 prompt，二选一即可").optional(),
});
/** 配音同理：不 strict，多出来的字段 strip 掉即可，别让整轮调用失败 */
export const nativeSpeechParamsSchema = generateSpeechSchema;

export const nativeAudioSpecs = {
  generate_music: {
    type: "function",
    function: {
      name: "generate_music",
      description: "生成音乐或音效。只有用户明确要求时单独调用并等待确认。自定义歌词需要 tags。翻唱指定一首已有会话歌曲并提供歌词，省略歌词时沿用原词。混音指定同一渠道的两首不同会话歌曲。音效可设置 tempo、key、loop。词元流墟 v6 创作支持 45/60 秒目标时长，自定义歌词可设置 0 到 1 的 styleWeight 和 weirdness。",
      parameters: z.toJSONSchema(nativeMusicParamsSchema),
    },
  },
  generate_speech: {
    type: "function",
    function: {
      name: "generate_speech",
      description: "按用户要求朗读正文或生成双人配音。单独调用并等待确认。双人对话逐行用 A：、B：标记，并分别填写 voice、secondVoice；不要把指令写入正文。",
      parameters: z.toJSONSchema(nativeSpeechParamsSchema),
    },
  },
} satisfies Record<string, BrainToolSpec>;

export function prepareNativeAudio(ctx: ToolContext, tool: keyof typeof nativeAudioSpecs, raw: string): PreparedToolConfirmation | { error: string } {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return { error: "音频参数不是有效 JSON" }; }
  if (tool === "generate_music") {
    const parsed = nativeMusicParamsSchema.safeParse(value);
    if (!parsed.success) return { error: `音乐参数无效（${describeZodIssues(parsed.error)}），请检查模式、歌词和源歌曲` };
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

  const parsed = nativeSpeechParamsSchema.safeParse(value);
  if (!parsed.success) return { error: `配音参数无效（${describeZodIssues(parsed.error)}），请检查正文、音色和语言` };
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
