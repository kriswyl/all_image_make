import { assetRef, type Conversation, type ConversationVideoRole, type GenerateVideoArgs } from "../../shared/agent-types.js";
import type { GenerationInput, KlingMediaType, SeedanceVideoMode, VideoMediaType, WanVideoMode } from "../../shared/types.js";
import { maxImagesForMode, referenceMediaLimits, supportedVideoModes, videoModeSpec } from "../../shared/video-modes.js";
import {
  VIDEO_DEFAULTS, videoModeLabel, type ConversationVideoMode,
} from "../../shared/video-capabilities.js";
import { describeAliasChoice, resolveAlias } from "../capabilities.js";
import type { AppDatabase, AssetRow } from "../db.js";
import { readReferenceVideoAsset, referenceVideoAssetError } from "../reference-video.js";
import type { ReferenceImageUpload } from "../tasks.js";
import { prepareImageBytes, videoInlineProfile } from "../vision.js";
import { attachmentAssets, resolveImageRefs } from "./assets.js";
import { describeError, failResult, MEDIA_TASK_TIMEOUT_MS, okResult, type ToolContext, type ToolOutcome } from "./shared.js";

export interface VideoSelection {
  mode: ConversationVideoMode;
  assets: AssetRow[];
  videos?: AssetRow[];
  roles: ConversationVideoRole[];
  notes: string[];
}

const VIDEO_MODE_ORDER: ConversationVideoMode[] = ["text-to-video", "first-frame", "first-last-frame", "reference"];

function modeListLabel(adapterType: string, model?: string) {
  return supportedVideoModes(adapterType, model).map((mode) => `${mode}（${videoModeLabel(mode, adapterType)}）`).join("、");
}

/**
 * 把 `generate_video` 的参数解析成「哪种模式 + 哪几张图 + 谁是首帧/尾帧/参考图」。
 *
 * 这是执行器和确认卡共用的**唯一**判断入口：卡片上写的必须就是真正提交的那份，
 * 否则用户点了「用这两张做首尾帧」，实际跑的却是别的组合。
 */
export function resolveVideoSelection(
  db: AppDatabase,
  conversation: Conversation,
  args: GenerateVideoArgs,
  adapterType: string,
  turnAttachmentIds: string[],
  model?: string,
  localVideoUploadConfigured = false,
): { selection?: VideoSelection; error?: string } {
  const supported = supportedVideoModes(adapterType, model);
  const requested = typeof args.mode === "string" ? args.mode.trim() : "";
  const requestedMode = requested ? requested as ConversationVideoMode : undefined;
  const videoRefs = args.videoRefs ?? [];
  if (requestedMode && !VIDEO_MODE_ORDER.includes(requestedMode)) {
    return { error: `视频模式 ${requested} 对话里不支持。可用的是：${modeListLabel(adapterType, model)}` };
  }
  if (requestedMode && !supported.includes(requestedMode)) {
    return { error: `这个视频模型不支持 ${videoModeLabel(requestedMode, adapterType)}。它支持：${modeListLabel(adapterType, model)}` };
  }
  const videos: AssetRow[] = [];
  if (videoRefs.length) {
    if ((requestedMode && requestedMode !== "reference") || args.imageFrom === "none") {
      return { error: "参考视频只能用于参考生视频；首帧和尾帧需要单独指定图片" };
    }
    const spec = videoModeSpec(adapterType, model ?? "", "reference");
    const limits = referenceMediaLimits(adapterType, model ?? "", spec);
    if (!limits.videos) return { error: "当前模型的参考生视频不接受参考视频，请选择支持的万相或 Seedance 渠道" };
    if (!localVideoUploadConfigured) return { error: "当前渠道未配置素材上传服务，请配置后重试，或选择已配置且支持参考视频的渠道" };
    const available = db.listConversationAssets(conversation.id).map(({ asset }) => asset);
    for (const ref of videoRefs) {
      const key = ref.trim().toLowerCase().replace(/^#/, "");
      const exact = available.find((asset) => asset.id.toLowerCase() === key);
      const matches = exact ? [exact] : key ? available.filter((asset) => asset.id.toLowerCase().startsWith(key)) : [];
      const asset = matches.length === 1 ? matches[0] : undefined;
      if (!asset?.mimeType.startsWith("video/")) return { error: `参考视频 ${ref} 不在本会话、编号不唯一或不是视频，请提供明确的素材 ID` };
      const problem = referenceVideoAssetError(asset, "reference");
      if (problem) return { error: `${asset.title || asset.fileName}：${problem}` };
      if (!videos.some((item) => item.id === asset.id)) videos.push(asset);
    }
    if (videos.length > limits.videos) return { error: `这个模型最多接受 ${limits.videos} 段参考视频（当前 ${videos.length} 段）` };
  }
  // 明确说「文生视频」时不需要图：画布上有几张都不该拦住一句纯文字的视频
  if (requestedMode === "text-to-video" || args.imageFrom === "none") {
    if (args.imageRefs?.length) {
      return { error: "文生视频不带图片，不能同时指定 imageRefs；要带图请用 first-frame / first-last-frame / reference" };
    }
    return { selection: { mode: "text-to-video", assets: [], roles: [], notes: [] } };
  }
  const explicitMode: Exclude<ConversationVideoMode, "text-to-video"> | undefined =
    requestedMode as Exclude<ConversationVideoMode, "text-to-video"> | undefined;

  let assets: AssetRow[] = [];
  if (args.imageRefs?.length) {
    const resolved = resolveImageRefs(db, conversation.id, args.imageRefs);
    if (resolved.error) return { error: resolved.error };
    assets = resolved.assets;
  } else if (!videos.length && turnAttachmentIds.length) {
    const resolved = attachmentAssets(db, turnAttachmentIds);
    if (resolved.error) return { error: resolved.error };
    assets = resolved.assets;
  } else if (!videos.length) {
    const canvas = db.canvasImages(conversation);
    if (canvas.length === 1) {
      // 只有一张时不存在选错的问题
      assets = canvas;
    } else if (canvas.length > 1 && args.imageFrom === "current") {
      return {
        error: `画布上有 ${canvas.length} 张图，不能默认挑一张。请先用 view_images 看清画面，再用 imageRefs 指定；拿不准就先 ask 用户`,
      };
    }
    // 没点名、也没明确要当前画布 → 当成纯文生视频，不要擅自把画布塞进去
  }

  let mode: ConversationVideoMode | undefined = videos.length ? "reference" : explicitMode;
  if (!mode) {
    if (!assets.length) mode = "text-to-video";
    // Grok 只有图生/文生两种，多张图就是参考图，不存在「首尾帧 vs 参考」的歧义
    else if (adapterType === "grok-video") mode = "reference";
    else if (assets.length === 1) mode = "first-frame";
    else {
      return {
        error: `这次要用 ${assets.length} 张图，但没说要哪种方式。首尾帧生视频和参考生视频都说得通，`
          + "请先用 ask 问用户（给出「首尾帧」「参考图」两个选项），再在 mode 里写清 first-last-frame 或 reference。",
      };
    }
  }
  if (!mode) return { error: "没有确定视频模式，请先问用户" };

  if (mode === "text-to-video") {
    if (assets.length) {
      return { error: "文生视频不带图片；要带图请用 first-frame / first-last-frame / reference" };
    }
    return { selection: { mode, assets: [], roles: [], notes: [] } };
  }

  if (!assets.length && !videos.length) {
    return { error: `${videoModeLabel(mode, adapterType)}需要先用 imageRefs 指定图片（或用 view_images 看清画布后指定）` };
  }
  if (mode === "reference") {
    const cap = maxImagesForMode(adapterType, model ?? "", mode);
    if (assets.length > cap) return { error: `${videoModeLabel(mode, adapterType)}最多用 ${cap} 张图，这次给了 ${assets.length} 张` };
  }
  if (mode === "first-frame" && assets.length !== 1) {
    return { error: `首帧生视频只接受 1 张图（这次 ${assets.length} 张）。两张请用 first-last-frame，多张参考请用 reference` };
  }
  if (mode === "first-last-frame") {
    if (assets.length !== 2) return { error: `首尾帧生视频必须正好 2 张图（先首帧、后尾帧），这次 ${assets.length} 张` };
    if (assets[0]!.id === assets[1]!.id) return { error: "首帧和尾帧不能是同一张图，请让用户换一张或改用参考生视频" };
  }

  const notes: string[] = [];
  if (mode === "reference") {
    // 参考图重复没有意义，去重能省体积；首尾帧不能去重（位置有语义，上面已单独拦）
    const unique: AssetRow[] = [];
    for (const asset of assets) {
      if (unique.some((item) => item.id === asset.id)) { notes.push(`${assetRef(asset.id)} 重复，已去重`); continue; }
      unique.push(asset);
    }
    assets = unique;
  }
  const roles: ConversationVideoRole[] = mode === "first-frame"
    ? ["first_frame"]
    : mode === "first-last-frame"
      ? ["first_frame", "last_frame"]
      : assets.map(() => "reference_image");
  const unused = Math.max(0, db.canvasImages(conversation).length - new Set(assets.map((asset) => asset.id)).size);
  if (unused > 0) notes.push(`画布上另外 ${unused} 张没有发给视频模型`);
  return { selection: { mode, assets, roles, notes, ...(videos.length ? { videos } : {}) } };
}

/** 卡片和工具结果里统一的人话角色名 */
export function roleLabel(role: ConversationVideoRole) {
  if (role === "first_frame") return "首帧";
  if (role === "last_frame") return "尾帧";
  return "参考图";
}

export async function generateVideo(ctx: ToolContext, args: GenerateVideoArgs): Promise<ToolOutcome> {
  const resolution = resolveAlias(ctx.aliases, args.modelHint, "video", ctx.defaultAliases.video);
  if (!resolution) return failResult("还没有可用的视频渠道，请先到「渠道配置」添加", "NO_VIDEO_CHANNEL");
  const channel = ctx.db.getChannel(resolution.channelId);
  if (!channel) return failResult("解析到的视频渠道不存在", "CHANNEL_NOT_FOUND");
  if (args.videoRefs?.length && args.modelHint && resolution.usedFallback) {
    return failResult("没有找到指定的视频模型，请确认要用哪个渠道和模型", "VIDEO_MODEL_NOT_FOUND");
  }

  const resolved = resolveVideoSelection(
    ctx.db, ctx.conversation, args, channel.adapterType, ctx.turnAttachmentIds, resolution.model, Boolean(channel.uploadEndpoint?.trim()),
  );
  if (!resolved.selection) return failResult(resolved.error ?? "这次视频用哪几张图没定下来", "VIDEO_SELECTION_INVALID");
  const selection = resolved.selection;
  if (selection.videos?.length && !ctx.confirmed) return failResult("上传参考视频前需要用户确认", "VIDEO_CONFIRMATION_REQUIRED");
  const defaults = VIDEO_DEFAULTS[channel.adapterType] ?? { duration: 5, resolution: "720p", audio: false };
  const input: GenerationInput = {
    channelId: channel.id,
    model: resolution.model,
    prompt: ctx.verbatimPrompt ?? args.prompt,
    duration: args.duration ?? defaults.duration,
    resolution: args.resolution ?? defaults.resolution,
    audio: args.audio ?? defaults.audio,
    // §8 规则 4：视频默认开提示词扩展，渠道自带的扩展比大脑自己改写更划算
    promptExtend: args.promptExtend ?? true,
  };
  const uploads: ReferenceImageUpload[] = [];

  if (selection.assets.length) {
    // 多张图一起发时按张数均分保守的图片预算，为其他素材留空间。
    const profile = videoInlineProfile(selection.assets.length);
    const prepared: Array<{ bytes: Buffer; mimeType: "image/png" | "image/jpeg" | "image/webp"; fileName: string }> = [];
    for (const [index, asset] of selection.assets.entries()) {
      const encoded = await prepareImageBytes(ctx.db, asset, profile);
      if (!encoded) {
        return failResult(
          `${assetRef(asset.id)} 读取失败，无法作为${selection.roles[index] === "first_frame" ? "首帧" : selection.roles[index] === "last_frame" ? "尾帧" : "参考图"}`,
          "REFERENCE_IMAGE_MISSING",
        );
      }
      prepared.push(encoded);
    }

    if (channel.adapterType === "grok-video") {
      // Grok 的请求体只吃 reference_images，没有首帧/尾帧的角色概念
      for (const item of prepared) {
        uploads.push({ bytes: item.bytes, mimeType: item.mimeType, fileName: item.fileName });
      }
    } else {
      const media = prepared.map((item, index) => {
        const dataUri = `data:${item.mimeType};base64,${item.bytes.toString("base64")}`;
        return { role: selection.roles[index]!, url: dataUri };
      });
      if (channel.adapterType === "seedance-video") {
        input.seedanceVideoMedia = media.map((item) => ({ type: "image_url", url: item.url, role: item.role }));
        input.seedanceVideoMode = selection.mode as SeedanceVideoMode;
        // Seedance 的首帧/首尾帧只接受自适应比例（见 VIDEO_HANDOFF.md）
        if (selection.mode === "first-frame" || selection.mode === "first-last-frame") input.ratio = "adaptive";
      } else if (channel.adapterType === "kling-video") {
        input.klingVideoMedia = media.map((item) => ({ type: item.role as KlingMediaType, url: item.url }));
        input.klingVideoMode = selection.mode;
        input.aspectRatio = input.aspectRatio ?? "16:9";
      } else {
        input.wanVideoMedia = media.map((item) => ({ type: item.role as VideoMediaType, url: item.url }));
        input.wanVideoMode = selection.mode as WanVideoMode;
      }
    }
  } else if (channel.adapterType === "wan-video") {
    input.wanVideoMode = selection.mode as WanVideoMode;
  } else if (channel.adapterType === "seedance-video") {
    input.seedanceVideoMode = selection.mode as SeedanceVideoMode;
  } else if (channel.adapterType === "kling-video") {
    input.klingVideoMode = "text-to-video";
    input.aspectRatio = input.aspectRatio ?? "16:9";
  }

  input.timeoutMs = MEDIA_TASK_TIMEOUT_MS;
  try {
    const referenceVideoUploads = [];
    for (const asset of selection.videos ?? []) {
      ctx.signal?.throwIfAborted();
      referenceVideoUploads.push(await readReferenceVideoAsset(asset, selection.mode));
    }
    ctx.signal?.throwIfAborted();
    const created = await ctx.runner.create({
      ...input,
      ...(referenceVideoUploads.length ? { referenceVideoUploads, referenceVideoUploadChannelVersion: channel.updatedAt } : {}),
    }, uploads, undefined, "conversation", ctx.conversation.id, ctx.operationId);
    ctx.emit({ type: "progress", taskId: created.id, status: created.status, progress: created.progress });
    const choice = describeAliasChoice(resolution);
    const references = [
      ...selection.assets.map((asset, index) => ({ assetId: asset.id, role: selection.roles[index]! })),
      ...(selection.videos ?? []).map((asset) => ({ assetId: asset.id, role: "reference_video" as const })),
    ];
    const mediaPart = references.length
      ? `${videoModeLabel(selection.mode, channel.adapterType)}，${references
        .map(({ assetId, role }) => `${assetRef(assetId)}（${role === "reference_video" ? "参考视频" : roleLabel(role)}）`).join("、")}`
      : "纯文生视频";
    const summary = [
      `已提交视频任务 ${created.id.slice(0, 8)}，模型 ${resolution.model}（${resolution.alias}）${choice ? `，${choice}` : ""}，`,
      `${input.duration} 秒 ${input.resolution}，`,
      mediaPart,
      selection.notes.length ? `（${selection.notes.join("；")}）` : "",
      "。视频要几分钟，完成后我会接着处理。",
    ].join("");
    return okResult(summary, {
      async: true,
      taskId: created.id,
      data: {
        model: resolution.model, alias: resolution.alias,
        usedFallback: resolution.usedFallback, ...(choice ? { aliasNote: choice } : {}),
        videoMode: selection.mode,
        videoInputs: references,
      },
    });
  } catch (error) {
    return failResult(`提交视频失败：${describeError(error)}`, "VIDEO_SUBMIT_FAILED");
  }
}
