/**
 * 大脑调用与上下文构建。
 *
 * 负责：找对话渠道、发 chat completions、流式回推、视觉被拒后的自愈、
 * 以及把系统提示词 / 历史消息 / 附件拼成一份请求。
 * 不负责工具执行和确认闸门。
 */
import type { AppDatabase, AssetRow } from "./db.js";
import type { KeyStore } from "./key-store.js";
import { AppError } from "./tasks.js";
import { callBrain, type BrainContentPart, type BrainMessage, type BrainResult } from "./brain.js";
import { buildCapabilityAliases, buildCapabilityManifest, markVisionUnsupported } from "./capabilities.js";
import { assetThumbDataUri } from "./vision.js";
import { MAX_VISION_IMAGES } from "./agent-constants.js";
import { buildSystemPrompt } from "./agent-prompt.js";
import { collectTurnDocuments, renderDocumentContext, toBrainMessage, type BuiltContext } from "./agent-context.js";
import { isFatalBrainError, isVisionError } from "./agent-brain-errors.js";
import { isVisionBlocked } from "./agent-vision.js";
import { assetRef, type AgentStreamEvent, type Conversation } from "../shared/agent-types.js";
import { isImageAsset } from "../shared/types.js";

export interface BrainHost {
  db: AppDatabase;
  sessionKeys: KeyStore;
  broadcast(conversationId: string, event: AgentStreamEvent): void;
}

export class BrainRunner {
  constructor(private readonly host: BrainHost) {}

  requireBrain(conversation: Conversation) {
    const channel = this.host.db.getChannel(conversation.brainChannelId);
    if (!channel || !channel.enabled) {
      throw new AppError("BRAIN_UNAVAILABLE", "这个会话的大脑渠道不存在或已被停用，请到渠道配置里检查", 400);
    }
    if (channel.adapterType !== "openai-chat") {
      throw new AppError("BRAIN_UNAVAILABLE", `渠道「${channel.name}」不是对话适配器，不能作为大脑`, 400);
    }
    const key = this.host.sessionKeys.get(channel.id) || (channel.secretEnv ? process.env[channel.secretEnv] ?? "" : "");
    if (!key && channel.authType !== "none") {
      throw new AppError("CHANNEL_AUTH_FAILED", `渠道「${channel.name}」没有可用的 API Key`, 400);
    }
    return { channel, key };
  }

  async callBrainRaw(
    conversation: Conversation,
    messages: BrainMessage[],
    controller: AbortController,
    conversationId: string,
    options: { silent?: boolean } = {},
  ): Promise<BrainResult> {
    const { channel, key } = this.requireBrain(conversation);
    const result = await callBrain({
      channel, key, model: conversation.brainModel, messages,
      signal: controller.signal,
      onDelta: options.silent ? undefined : (delta) => {
        if (delta.reasoning) this.host.broadcast(conversationId, { type: "reasoning", text: delta.reasoning });
        if (delta.content) this.host.broadcast(conversationId, { type: "token", text: delta.content });
      },
    });
    // 解析重试、身份纠正这些额外调用也走这里，所以记在这里就是「真实花了多少」
    if (result.usage) this.host.db.recordBrainCall(conversationId, result.usage);
    return result;
  }

  /**
   * 带两条自救路径的大脑调用（§15）：
   * 视觉被拒 → 拉黑这个模型并改用纯文字重试；其余临时故障 → 原样重试一次。
   */
  async callBrainWithRecovery(
    conversation: Conversation,
    built: BuiltContext,
    controller: AbortController,
  ): Promise<BrainResult> {
    try {
      return await this.callBrainRaw(conversation, built.messages, controller, conversation.id);
    } catch (error) {
      if (built.visionAttached && isVisionError(error)) {
        this.degradeVision(conversation, error);
        const retry = await this.buildBrainMessages({ ...conversation, visionEnabled: false }, []);
        return this.callBrainRaw(conversation, retry.messages, controller, conversation.id);
      }
      if (isFatalBrainError(error) || controller.signal.aborted) throw error;
      return this.callBrainRaw(conversation, built.messages, controller, conversation.id);
    }
  }

  /** 视觉自愈（§11.5）：这个渠道+模型不吃图，记进 settings，以后不再试 */
  degradeVision(conversation: Conversation, error: unknown) {
    markVisionUnsupported(this.host.db, conversation.brainChannelId, conversation.brainModel);
    this.host.db.updateConversation(conversation.id, { visionEnabled: false });
    const note = this.host.db.appendMessage({
      conversationId: conversation.id, role: "system",
      content: `当前大脑模型（${conversation.brainModel}）不接受图片输入，已切换为纯文字模式。改图时会看不到原图，描述请尽量具体；也可以在会话设置里换一个支持视觉的模型。`,
    });
    this.host.broadcast(conversation.id, { type: "message", message: note });
    void error;
  }

  buildBrainMessages(conversation: Conversation, turnAttachmentIds: string[]): Promise<BuiltContext> {
    return this.assemble(conversation, turnAttachmentIds);
  }

  async assemble(conversation: Conversation, turnAttachmentIds: string[]): Promise<BuiltContext> {
    const db = this.host.db;
    const aliases = buildCapabilityAliases(db.listChannels());
    const manifest = buildCapabilityManifest(aliases);
    const canvasImages = db.canvasImages(conversation);
    const hasTurnAttachments = turnAttachmentIds.length > 0;
    // 翻唱 / 混音要引用本会话里带 Suno custom_id 的歌
    const songs = db.listConversationAssets(conversation.id)
      .map((entry) => entry.asset)
      .filter((asset) => asset.mimeType.startsWith("audio/") && Boolean(asset.remoteClipId))
      .map((asset) => ({ id: asset.id, title: asset.title, tags: asset.tags }));

    const history = db.listMessages(conversation.id);
    const messages: BrainMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt(
          manifest, conversation, canvasImages, hasTurnAttachments, songs,
          db.listStoryboardShots(conversation.id), db.listConversationDocuments(conversation.id),
        ),
      },
    ];
    // 脚本文档只在「这一轮刚传进来」时灌全文；插在文档提示和用户指令之间
    const documentContext = renderDocumentContext(collectTurnDocuments(db, conversation.id));
    let lastUserIndex = -1;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index]!.role === "user") { lastUserIndex = index; break; }
    }
    for (const [index, item] of history.entries()) {
      if (index === lastUserIndex && documentContext) messages.push({ role: "user", content: documentContext });
      const converted = toBrainMessage(item);
      if (converted) messages.push(converted);
    }

    /**
     * 视觉附件：
     * - 用户这条消息附带了图 → 附它们（用户说「这张」指的就是这些，不是画布主图）；
     * - 没有附带、画布只有一张 → 附这一张；
     * - 画布多于一张且没有附带 → 不附，大脑需要时自己调 view_images。
     */
    const visionAssets: AssetRow[] = [];
    if (hasTurnAttachments) {
      for (const id of turnAttachmentIds) {
        const asset = db.getAsset(id);
        if (asset && isImageAsset(asset)) visionAssets.push(asset);
      }
    } else if (canvasImages.length === 1) {
      visionAssets.push(canvasImages[0]!);
    }

    let visionAttached = false;
    if (conversation.visionEnabled && !isVisionBlocked(db, conversation) && visionAssets.length) {
      const capped = visionAssets.slice(0, MAX_VISION_IMAGES);
      const parts: BrainContentPart[] = [{
        type: "text",
        text: hasTurnAttachments
          ? `[本条消息附带的图片] 用户这句话里的「这张图」「这几张」指下面这些，不要改用画布主图。工具里引用它们用 #编号。${visionAssets.length > capped.length ? `（超过 ${MAX_VISION_IMAGES} 张，只附了前 ${capped.length} 张）` : ""}`
          : `[当前画布] 画布上只有这一张图 ${assetRef(capped[0]!.id)}。用户说「这张图」「刚才那张」指的就是它。`,
      }];
      for (const [index, asset] of capped.entries()) {
        const dataUri = await assetThumbDataUri(db, asset);
        if (!dataUri) continue;
        parts.push({
          type: "text",
          text: `${assetRef(asset.id)}${hasTurnAttachments ? `（附带的第 ${index + 1} 张）` : ""}`,
        });
        parts.push({ type: "image_url", image_url: { url: dataUri } });
        visionAttached = true;
      }
      if (visionAttached) messages.push({ role: "user", content: parts });
    }
    return { messages, visionAttached };
  }
}
