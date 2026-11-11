import { assetRef, type Conversation, type EditImageArgs, type GenerateImageArgs } from "../../shared/agent-types.js";
import { midjourneyUsableButtons } from "../../shared/midjourney.js";
import { MAX_REFERENCE_IMAGES, type GenerationInput } from "../../shared/types.js";
import { describeAliasChoice, resolveAlias } from "../capabilities.js";
import type { AppDatabase, AssetRow } from "../db.js";
import { auditParameters, isParameterRejection, planParameterSalvage } from "../diagnose.js";
import { AppError, type ReferenceImageUpload } from "../tasks.js";
import { prepareImageBytes, REFERENCE_PROFILE } from "../vision.js";
import { attachmentAssets, resolveAssetRef, resolveImageRefs } from "./assets.js";
import { describeError, failResult, MEDIA_TASK_TIMEOUT_MS, okResult, type ToolContext, type ToolOutcome } from "./shared.js";

/** §16：`extraReferences` 上限和现有 MAX_REFERENCE_IMAGES 对齐 */
export const MAX_EXTRA_REFERENCES = 8;
/** 图片任务单次等待上限。图片是同步请求，正常几十秒；超过就该报错而不是一直挂着 */
export const IMAGE_TASK_TIMEOUT_MS = MEDIA_TASK_TIMEOUT_MS;
/** 等任务进入终态时再多给一点余量，让 TaskRunner 自己的超时先触发 */
export const IMAGE_WAIT_TIMEOUT_MS = IMAGE_TASK_TIMEOUT_MS + 60_000;

/**
 * 「这次到底用哪几张图」的统一兜底。
 *
 * 顺序是用户意图的优先级：
 * 1. 大脑显式写了 `imageRefs` —— 它已经按指令选好了；
 * 2. 本条消息附带的图 —— 用户说「这张/这几张」指的就是它们；
 * 3. 画布只有一张 —— 没有歧义，直接用；
 * 4. 画布多于一张 —— **不再默认主图/整组**，返回错误让大脑先 view_images 或 ask。
 */
function selectedImageAssets(
  db: AppDatabase,
  conversation: Conversation,
  explicitRefs: string[] | undefined,
  turnAttachmentIds: string[],
): { assets: AssetRow[]; source: "refs" | "attachments" | "canvas" | "none"; error?: string } {
  if (explicitRefs?.length) {
    const resolved = resolveImageRefs(db, conversation.id, explicitRefs);
    return resolved.error
      ? { assets: [], source: "refs", error: resolved.error }
      : { assets: resolved.assets, source: "refs" };
  }
  if (turnAttachmentIds.length) {
    const resolved = attachmentAssets(db, turnAttachmentIds);
    return resolved.error
      ? { assets: [], source: "attachments", error: resolved.error }
      : { assets: resolved.assets, source: "attachments" };
  }
  const canvas = db.canvasImages(conversation);
  if (canvas.length === 1) return { assets: canvas, source: "canvas" };
  if (canvas.length > 1) {
    return {
      assets: [],
      source: "none",
      error: `画布上有 ${canvas.length} 张图，不能默认挑一张。请先用 view_images 看清画面，再用 imageRefs 指定要用哪几张；拿不准就先 ask 用户`,
    };
  }
  return { assets: [], source: "none" };
}

export async function generateImage(
  ctx: ToolContext,
  args: GenerateImageArgs & Partial<EditImageArgs>,
  isEdit: boolean,
): Promise<ToolOutcome> {
  const resolution = resolveAlias(ctx.aliases, args.modelHint, "image", ctx.defaultAliases.image);
  if (!resolution) return failResult("还没有可用的生图渠道，请先到「渠道配置」添加", "NO_IMAGE_CHANNEL");
  const channel = ctx.db.getChannel(resolution.channelId);
  if (!channel) return failResult("解析到的生图渠道不存在", "CHANNEL_NOT_FOUND");

  if (!isEdit && args.fromScratch === true && args.imageRefs?.length) {
    return failResult("fromScratch 表示完全不参考任何图，不能同时指定 imageRefs；二选一", "INVALID_ARGS");
  }

  const uploads: ReferenceImageUpload[] = [];
  const notes: string[] = [];

  /**
   * 用哪几张图：显式 `imageRefs` → 本条消息附带的图 → 画布只有一张。
   *
   * 画布多于一张又没指定时**不再默认整组/主图**：那正是「改一张却动了两张」
   * 和「用户附了图却改了主图」的来源。让它失败并提示先 view_images / ask，
   * 多花一轮大脑调用，但不会花错一次生成的钱。
   */
  const selected = selectedImageAssets(ctx.db, ctx.conversation, args.imageRefs, ctx.turnAttachmentIds);
  if (isEdit && selected.error) return failResult(selected.error, "IMAGE_SELECTION_INVALID");
  if (!isEdit && args.fromScratch !== true && selected.error) {
    return failResult(selected.error, "IMAGE_SELECTION_INVALID");
  }

  const references: AssetRow[] = [];
  if (isEdit) references.push(...selected.assets);
  else if (args.fromScratch !== true) references.push(...selected.assets);
  if (isEdit && !references.length) {
    return failResult("现在没有可改的图。请先用 generate_image 画一张，或让用户上传/指定一张图", "NO_CANVAS");
  }
  // 显式选中的图必须全部可用：少一张就是在改另一组图
  const requiredCount = references.length;

  const extraRefs = isEdit ? args.extraReferences ?? [] : [];
  if (ctx.strictSubmission && extraRefs.length) {
    const extras = resolveImageRefs(ctx.db, ctx.conversation.id, extraRefs);
    if (extras.error) return failResult(extras.error, "IMAGE_SELECTION_INVALID");
  }
  for (const ref of extraRefs.slice(0, MAX_EXTRA_REFERENCES)) {
    const found = resolveAssetRef(ctx.db, ctx.conversation.id, ref);
    if (!found) { notes.push(`额外参考图 ${ref} 找不到，已跳过`); continue; }
    if (!found.asset.mimeType.startsWith("image/")) { notes.push(`${ref} 不是图片，已跳过`); continue; }
    // 去重要在限额**之前**判：大脑把已经选中的那张又写进 extraReferences 是常有的事
    if (references.some((item) => item.id === found.asset.id)) continue;
    if (references.length >= MAX_REFERENCE_IMAGES) {
      notes.push(`参考图已满 ${MAX_REFERENCE_IMAGES} 张，${ref} 已跳过`);
      continue;
    }
    references.push(found.asset);
  }

  if (channel.adapterType === "midjourney" && references.length > 1) {
    notes.push("Midjourney 图生图只使用第 1 张参考图");
  }
  for (const [index, reference] of references.entries()) {
    const prepared = await prepareImageBytes(ctx.db, reference, REFERENCE_PROFILE);
    if (!prepared) {
      // 选中/画布里的图坏了就硬失败；额外参考图坏了可以跳过，它本来只是补充
      if (index < requiredCount || ctx.strictSubmission) {
        return failResult(`${assetRef(reference.id)} 读取失败，没法按你选的这组图生成；可以换一张或重新上传`, "REFERENCE_IMAGE_MISSING");
      }
      notes.push(`额外参考图 ${assetRef(reference.id)} 读取失败，已跳过`);
      continue;
    }
    uploads.push({ bytes: prepared.bytes, mimeType: prepared.mimeType, fileName: prepared.fileName });
  }

  /**
   * 参数核对的基准：**补默认值之前**请求方真正写的值。
   *
   * 必须在这里取快照——`TaskRunner.create()` 会往 `input.imageSize` 里补默认值，
   * 之后再回头看「用户当初要了什么」就分不清「他要的」和「我们补的」，
   * 而这两者恰恰是参数核对面板要区分开的东西。
   */
  const requested: Record<string, unknown> = {
    size: args.size,
    aspectRatio: args.aspectRatio,
    imageSize: args.imageSize,
  };

  const input: GenerationInput = {
    channelId: channel.id,
    model: resolution.model,
    // 原话直发时用用户的原话，不用大脑改写过的版本
    prompt: ctx.verbatimPrompt ?? args.prompt,
    size: args.size,
    aspectRatio: args.aspectRatio,
    imageSize: args.imageSize,
    count: args.count ?? 1,
    outputFormat: args.outputFormat,
    timeoutMs: IMAGE_TASK_TIMEOUT_MS,
  };

  /**
   * 最多两趟：正常一趟，外加至多一次参数补救（需求.md 问题 1 的「自动补救重试」）。
   *
   * 补救会**真的再发一次请求**，也就是可能再计一次费，所以三处一起收紧：
   * 只有上游明确因参数拒绝（`isParameterRejection`）、有安全的兜底值可补
   * （`planParameterSalvage`）、且只补一次。
   */
  let salvageNote = "";
  for (let attempt = 0; ; attempt += 1) {
    let taskId: string;
    try {
      ctx.signal?.throwIfAborted();
      const created = await ctx.runner.create(input, uploads, undefined, "conversation", ctx.conversation.id, ctx.operationId);
      taskId = created.id;
      ctx.emit({ type: "progress", taskId, status: created.status, progress: created.progress });
      if (ctx.backgroundMedia) {
        const choice = describeAliasChoice(resolution);
        return okResult(`已提交${isEdit ? "改图" : "生图"}任务，完成后会更新原卡片。`, {
          async: true, taskId,
          data: { model: resolution.model, alias: resolution.alias, usedFallback: resolution.usedFallback, ...(choice ? { aliasNote: choice } : {}) },
        });
      }
    } catch (error) {
      return failResult(`提交失败：${describeError(error)}`, "SUBMIT_FAILED");
    }

    // 图片是同步请求，直接等完再回话：拿到真实产物后大脑才能说「画好了」，
    // 画布指针也才能在这一轮内挪到新图上（§10.1）
    let task;
    try {
      task = await ctx.runner.waitFor(taskId, { timeoutMs: IMAGE_WAIT_TIMEOUT_MS, signal: ctx.signal });
    } catch (error) {
      // 用户按了停止：请求早就发出去了，钱已经花了，上游会照常画完并落进生成历史。
      // 这时候说「生成失败」是错的——用户会重新生成一遍，白花第二笔。
      if (error instanceof AppError && error.code === "TASK_ABORTED") {
        return {
          result: {
            ok: false,
            error: "TASK_ABORTED",
            taskId,
            summary: "用户叫停了等待。这张图还在后台生成，画完会出现在「生成历史」里，不用重新生成",
          },
          terminal: false,
        };
      }
      return { result: { ok: false, summary: `等待生成结果失败：${describeError(error)}`, error: "TASK_WAIT_FAILED", taskId }, terminal: false };
    }
    ctx.emit({ type: "progress", taskId, status: task.status, progress: task.progress });

    // 参数核对用的是任务自己的 effectiveParameters——那是发送前就落库的脱敏请求体，
    // 所以「请求时写的」和「真正出网的」都拿得到，也不用新增任何采集
    const parameterNotes = auditParameters(channel.adapterType, requested, task.effectiveParameters);

    if (task.status === "succeeded" && task.assets.length) {
      const first = task.assets[0];
      const choice = describeAliasChoice(resolution);
      const summary = [
        `${isEdit ? "改图" : "生图"}完成，产物 ${assetRef(first.id)}（${task.model}${choice ? `，${choice}` : ""}）`,
        task.assets.length > 1 ? `，共 ${task.assets.length} 张` : "",
        "，已放进素材库（不会自动占用画布）。",
        salvageNote ? `${salvageNote}。` : "",
        notes.length ? `注意：${notes.join("；")}` : "",
      ].join("");
      // MJ 的四宫格结果带 U/V/R 按钮；塞进卡片 data，用户能在对话里直接继续操作
      const midjourneyButtons = midjourneyUsableButtons(task.remoteMeta?.midjourney?.buttons ?? []);
      return {
        result: {
          ok: true,
          summary,
          taskId,
          assetId: first.id,
          // 卡片靠它决定缩略图怎么渲染：图片走 <img>，视频走 <video>（需求.md 问题 3）
          mimeType: first.mimeType,
          data: {
            model: task.model,
            alias: resolution.alias,
            count: task.assets.length,
            usedFallback: resolution.usedFallback,
            ...(choice ? { aliasNote: choice } : {}),
            parameterNotes,
            ...(midjourneyButtons.length ? { midjourneyButtons, midjourneyTaskId: task.id } : {}),
          },
        },
        terminal: false,
        producedAssetId: first.id,
      };
    }

    const failure = task.errorMessage ?? task.errorCode ?? "上游没有返回结果";
    const salvage = !ctx.strictSubmission && attempt === 0 && isParameterRejection(task.errorCode, task.errorMessage)
      ? planParameterSalvage(channel.adapterType, task.effectiveParameters, ctx.db.getSetting("geminiImageSize"))
      : null;
    if (salvage) {
      salvageNote = salvage.note;
      Object.assign(input, salvage.patch);
      continue;
    }

    return {
      result: {
        ok: false,
        summary: `生成失败：${failure}${salvageNote ? `（${salvageNote}）` : ""}`,
        error: task.errorCode ?? "TASK_FAILED",
        taskId,
        data: { parameterNotes },
      },
      terminal: false,
    };
  }
}
