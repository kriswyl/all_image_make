/**
 * 生成前的确认闸门：该不该问、卡片上显示什么、确认后的参数怎么合并。
 *
 * 这里不碰 SSE，也不执行工具；`agent.ts` 只负责决定何时调用。
 */
import type { AppDatabase } from "./db.js";
import { buildCapabilityAliases, resolveAlias } from "./capabilities.js";
import type { VideoSelection } from "./agent-tools.js";
import { asBool, asNumber, asString } from "./agent-plan.js";
import type {
  AgentToolName,
  ConfirmPreview,
  ConfirmVideoInput,
  Conversation,
  PlannedCall,
  VideoConfirmPolicy,
} from "../shared/agent-types.js";

/**
 * 视频和音乐确认闸门（§13.1）。
 *
 * `isContinuation` 的含义是「这次生成是链条上的后续步骤」：同一条用户消息里
 * 先画了图再生成视频（round > 0），或者视频/音乐是自动续跑触发的。
 * 所以「一句话先生图再生视频」会问，「直接说生成个视频」不会问。
 */
export function shouldConfirm(tool: AgentToolName, isContinuation: boolean, policy: VideoConfirmPolicy): boolean {
  if (tool !== "generate_video" && tool !== "generate_music") return false;
  if (policy === "always") return true;
  if (policy === "never") return false;
  return isContinuation;
}

/**
 * 用户在确认卡片上能调的旋钮。
 *
 * 刻意不含 `alias` / `model`：模型是大脑按用户那句话选的，卡片上那行是**结果展示**。
 */
const CONFIRM_OVERRIDABLE_ARGS = ["prompt", "duration", "resolution", "audio", "promptExtend"] as const;

export function mergeConfirmArgs(
  tool: AgentToolName | null,
  stored: Record<string, unknown>,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!override || tool !== "generate_video") return stored;
  const merged = { ...stored };
  for (const key of CONFIRM_OVERRIDABLE_ARGS) {
    const value = override[key];
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    merged[key] = value;
  }
  return merged;
}

/**
 * 确认时把卡片上显示的选图结果写回参数。
 *
 * 新卡片有 `videoInputs`，直接照抄；升级前的卡片只有 `referenceAssetId`，
 * 按「画布主图当首帧」补成 `imageRefs`，不要让老卡片点不下去。
 */
export function withConfirmedVideoSelection(
  args: Record<string, unknown>,
  preview: ConfirmPreview | null,
): Record<string, unknown> {
  if (!preview || (preview.reason !== "video_policy")) return args;
  const hasRefs = Array.isArray(args.imageRefs) && args.imageRefs.length > 0;
  if (preview.videoInputs?.length) {
    if (hasRefs) return args;
    return {
      ...args,
      imageRefs: preview.videoInputs.map((item) => item.assetId),
      ...(preview.mode ? { mode: preview.mode } : {}),
    };
  }
  if (!preview.referenceAssetId || hasRefs) return args;
  return {
    ...args,
    imageRefs: [preview.referenceAssetId],
    ...(preview.adapterType === "grok-video" ? { mode: "reference" } : {}),
  };
}

export function buildConfirmPreview(
  db: AppDatabase,
  conversation: Conversation,
  calls: PlannedCall[],
  reason: ConfirmPreview["reason"],
  selection: VideoSelection | undefined,
  consistency: "character" | "style" | undefined,
  defaultAliases: { image?: string; video?: string; music?: string; speech?: string },
): ConfirmPreview {
  const aliases = buildCapabilityAliases(db.listChannels());
  const first = calls[0]!;
  const args = first.args;
  // 模型类目跟着**要跑的那件事**走，不是跟着卡片的由来走
  const isVideo = first.tool === "generate_video";
  const isMusic = first.tool === "generate_music";
  const kind = isVideo ? "video" : isMusic ? "audio" : "image";
  // 音乐虽然和语音同属 audio 任务，默认值要取音乐那一份
  const defaultAlias = isVideo
    ? defaultAliases.video
    : isMusic ? defaultAliases.music : defaultAliases.image;
  const aliasResolution = resolveAlias(aliases, asString(args.modelHint), kind, defaultAlias);
  const channel = aliasResolution ? db.getChannel(aliasResolution.channelId) : null;
  const canvasImages = db.canvasImages(conversation);
  // 视频卡片按**真正选中的那几张**渲染
  const videoInputs: ConfirmVideoInput[] | undefined = isVideo && selection
    ? selection.assets.map((asset, index) => ({ assetId: asset.id, role: selection.roles[index]! }))
    : undefined;
  const imageUsesCanvas = !isVideo && !isMusic && Boolean(canvasImages[0]) && args.fromScratch !== true;
  const mode = isVideo && selection ? selection.mode : asString(args.mode);
  return {
    reason,
    prompt: asString(args.prompt) ?? "",
    model: aliasResolution?.model
      ?? (isVideo ? "（还没有配置视频渠道）" : isMusic ? "（还没有配置音乐渠道）" : "（还没有配置生图渠道）"),
    channelName: channel?.name ?? "",
    ...(channel ? { adapterType: channel.adapterType } : {}),
    ...(mode ? { mode } : {}),
    ...(asNumber(args.duration) !== undefined ? { duration: asNumber(args.duration) } : {}),
    ...(asString(args.resolution) ? { resolution: asString(args.resolution) } : {}),
    ...(asBool(args.audio) !== undefined ? { audio: asBool(args.audio) } : {}),
    ...(asBool(args.promptExtend) !== undefined ? { promptExtend: asBool(args.promptExtend) } : {}),
    ...(isMusic ? (() => {
      const known = ["inspiration", "custom", "cover", "mashup", "sound", "playlist", "sample"] as const;
      const rawMode = asString(args.mode)?.toLowerCase();
      const musicMode = (known as readonly string[]).includes(rawMode ?? "")
        ? rawMode as typeof known[number]
        : asString(args.tags) || asString(args.title) ? "custom" : "inspiration";
      const sourceRefs = Array.isArray(args.sourceAssetRefs)
        ? args.sourceAssetRefs.filter((ref): ref is string => typeof ref === "string")
        : undefined;
      return {
        musicMode,
        ...(asString(args.title) ? { musicTitle: asString(args.title) } : {}),
        ...(asString(args.tags) ? { musicTags: asString(args.tags) } : {}),
        ...(asBool(args.instrumental) !== undefined ? { musicInstrumental: asBool(args.instrumental) } : {}),
        ...(sourceRefs?.length ? { musicSourceAssetRefs: sourceRefs } : {}),
        ...(asNumber(args.tempo) !== undefined ? { musicTempo: asNumber(args.tempo) } : {}),
        ...(asString(args.key) ? { musicKey: asString(args.key) } : {}),
        ...(asBool(args.loop) !== undefined ? { musicLoop: asBool(args.loop) } : {}),
      };
    })() : {}),
    ...(videoInputs !== undefined ? { videoInputs } : {}),
    ...(videoInputs?.length
      ? { referenceAssetId: videoInputs[0]!.assetId, referenceCount: videoInputs.length }
      : imageUsesCanvas
        ? { referenceAssetId: canvasImages[0]!.id, ...(canvasImages.length > 1 ? { referenceCount: canvasImages.length } : {}) }
        : {}),
    ...(calls.length > 1 ? { count: calls.length } : {}),
    ...(calls.length > 1 && consistency ? { consistency } : {}),
    message: reason === "session_limit"
      ? calls.length > 1
        ? consistency
          ? `这个会话已经提交过 ${conversation.taskCount} 个生成任务了，这次要生成 ${calls.length} 张图：先生成第 1 张基准图，再以它为准并行生成其余 ${calls.length - 1} 张（共 ${calls.length} 笔费用）。确认继续吗？`
          : `这个会话已经提交过 ${conversation.taskCount} 个生成任务了，这次要一次提交 ${calls.length} 个任务并行跑（就是 ${calls.length} 笔费用）。确认继续吗？`
        : `这个会话已经提交过 ${conversation.taskCount} 个生成任务了，确认继续吗？`
      : isMusic
        ? "接下来要生成音乐：一次会出 2 首，耗时 1 到 5 分钟，也会产生费用。确认一下参数："
        : "接下来要生成视频：耗时几分钟，也会产生费用。确认一下参数：",
  };
}
