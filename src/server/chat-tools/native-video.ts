import { z } from "zod";
import type { ChatVideoFrames, Conversation } from "../../shared/agent-types.js";
import { VIDEO_DEFAULTS } from "../../shared/video-capabilities.js";
import { buildConfirmPreview } from "../agent-confirm.js";
import { generateVideoSchema, resolveVideoSelection } from "../agent-tools.js";
import { describeZodIssues } from "../agent-tools/shared.js";
import type { BrainToolSpec } from "../brain.js";
import { buildCapabilityAliases, resolveAlias } from "../capabilities.js";
import type { AppDatabase } from "../db.js";
import { resolveNativeImageRefs } from "./native-image.js";

/**
 * 和 native-audio 同一条规矩：只做加法，不重声明父 schema 的字段（重声明会把
 * `.catch(undefined)` / looseBoolean 这些容错盖掉，一个脏字段就让整轮调用失败）。
 *
 * mode 是**故意收窄**的：原生流程只支持这 4 种，video-edit / video-extend 在视频工作台里跑。
 * 收窄的同时补回 `.catch(undefined)`——大脑写出别的值时按「不指定」处理、由后端按素材判断，
 * 而不是把用户的一次请求整条打回去。
 */
const schema = generateVideoSchema.omit({ imageFrom: true }).extend({
  mode: z.enum(["text-to-video", "first-frame", "first-last-frame", "reference"]).optional().catch(undefined),
});

export const nativeVideoSpec: BrainToolSpec = {
  type: "function",
  function: {
    name: "generate_video",
    description: "用户明确要求生成视频时单独调用并等待确认。需要参考原视频时用 mode=reference 和 videoRefs（填写会话内真实素材 ID），参考图另填 imageRefs。单个目标明确时直接填 ID，多段且指代不明时先询问。首尾帧按顺序提供图片。MiniMax H3 的参考音频用 audioRefs，需搭配参考图或视频。",
    parameters: z.toJSONSchema(schema),
  },
};

export function prepareNativeVideo(db: AppDatabase, conversation: Conversation, raw: string, attachments: string[], defaultAlias?: string, frames?: ChatVideoFrames) {
  let input: unknown;
  try { input = JSON.parse(raw); } catch { return { error: "视频参数不是有效 JSON" } as const; }
  const parsed = schema.safeParse(input);
  if (!parsed.success) return { error: `视频参数无效（${describeZodIssues(parsed.error)}），请检查提示词、模式、时长和参考素材` } as const;
  const args = frames ? {
    ...parsed.data,
    mode: frames.lastAssetId ? "first-last-frame" as const : "first-frame" as const,
    imageRefs: frames.lastAssetId ? [frames.firstAssetId, frames.lastAssetId] : [frames.firstAssetId],
  } : parsed.data;
  const resolution = resolveAlias(buildCapabilityAliases(db.listChannels()), args.modelHint, "video", defaultAlias);
  const channel = resolution && db.getChannel(resolution.channelId);
  if (!resolution || !channel) return { error: "当前没有可用的视频渠道" } as const;
  if ((args.videoRefs?.length || args.audioRefs?.length) && args.modelHint && resolution.usedFallback) return { error: "没有找到指定的视频模型，请确认要用哪个渠道和模型" } as const;
  const refs = args.imageRefs?.length ? args.imageRefs : args.mode === "text-to-video" || args.videoRefs?.length ? [] : attachments;
  const picked = resolveNativeImageRefs(db, conversation.id, refs);
  if (picked.error) return { error: picked.error } as const;
  const explicit = { ...args, modelHint: resolution.alias, imageRefs: picked.assets.map(asset => asset.id) };
  const selected = resolveVideoSelection(db, { ...conversation, canvasAssetIds: [] }, explicit, channel.adapterType, [], resolution.model, Boolean(channel.uploadEndpoint?.trim()));
  if (!selected.selection) return { error: selected.error ?? "请明确视频模式和参考素材" } as const;
  const defaults = VIDEO_DEFAULTS[channel.adapterType] ?? { duration: 5, resolution: "720p", audio: false };
  const frozen = {
    ...explicit, mode: selected.selection.mode,
    ...(selected.selection.videos?.length ? { videoRefs: selected.selection.videos.map(asset => asset.id) } : {}),
    ...(selected.selection.audios?.length ? { audioRefs: selected.selection.audios.map(asset => asset.id) } : {}),
    prompt: conversation.verbatimPrompt ? db.lastUserText(conversation.id) ?? args.prompt : args.prompt,
    duration: args.duration ?? defaults.duration,
    resolution: args.resolution ?? defaults.resolution,
    audio: args.audio ?? defaults.audio,
    promptExtend: args.promptExtend ?? true,
  };
  const preview = buildConfirmPreview(db, conversation, [{ tool: "generate_video", args: frozen }],
    "video_policy", selected.selection, undefined, { video: defaultAlias });
  return {
    args: frozen, preview,
    target: { kind: "video", channelId: channel.id, channelVersion: channel.updatedAt, model: resolution.model } as const,
  } as const;
}
