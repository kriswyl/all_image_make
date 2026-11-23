import type { ChatMessage, Conversation } from "../../shared/agent-types";
import type { Asset } from "../../shared/types";

const roleLabels: Record<ChatMessage["role"], string> = { user: "用户", assistant: "助手", tool: "工具结果", system: "系统" };

/** 「上传了图片 xxx」这类消息是系统生成的记账文本，不是用户真正写的内容 */
const uploadRecord = /^上传了(?:图片|视频|音频|脚本文档|文件附件)\s/;

function messageIds(message: ChatMessage): string[] {
  return [...new Set([
    message.assetId, ...(message.assetRefs ?? []), message.videoFrames?.firstAssetId, message.videoFrames?.lastAssetId,
    message.toolResult?.assetId, ...(message.toolResult?.assetIds ?? []),
    ...(message.confirm?.videoInputs ?? []).map(({ assetId }) => assetId),
  ].filter((id): id is string => Boolean(id)))];
}

function attachmentNames(message: ChatMessage, lookupAsset?: (id: string) => Asset | undefined): string[] {
  const names = messageIds(message).flatMap((id) => {
    const asset = lookupAsset?.(id);
    return asset ? [asset.title || asset.fileName] : [];
  });
  names.push(...(message.documents ?? []).map((document) => document.name));
  return [...new Set(names)];
}

/** 只取用户能读的正文；工具卡没有正文时退回结果摘要，不把参数、ID、内部 JSON 带出去 */
function messageText(message: ChatMessage): string {
  const content = message.content?.trim() ?? "";
  if (content && !uploadRecord.test(content)) return content;
  if (message.role === "tool") return message.toolResult?.summary?.trim() ?? "";
  return "";
}

/**
 * 单条消息：正文 + 可还原的素材引用。
 *
 * 图片/视频/音频不能只留文件名，否则粘到输入框只剩一行「附件：xxx.png」。
 * 这里写成 ChatCanvas 自己的引用，Composer 粘贴时会从本地素材库取回原文件，
 * 图片直接挂成图片附件，音视频和文档也挂成待发文件。
 */
function referenceName(name: string): string {
  return encodeURIComponent(name.replace(/[\\/\u0000-\u001f]/g, "_").trim().slice(0, 255) || "file");
}

export function formatMessageForClipboard(messages: ChatMessage[], lookupAsset?: (id: string) => Asset | undefined): string {
  const text = messages.map(messageText).filter(Boolean).join("\n\n");
  const references: string[] = [];
  for (const message of messages) {
    for (const id of messageIds(message)) {
      const asset = lookupAsset?.(id);
      if (!asset) continue;
      if (/^(image|video|audio)\//.test(asset.mimeType)) {
        references.push(`chatcanvas://asset/${asset.id}/${referenceName(asset.title || asset.fileName)}`);
      }
    }
    for (const document of message.documents ?? []) {
      references.push(`chatcanvas://document/${message.conversationId}/${document.id}/${referenceName(document.name)}`);
    }
  }
  return [text, ...[...new Set(references)]].filter(Boolean).join("\n\n");
}

/** 整段会话：可读的角色对话，不包含消息 ID、计划、工具参数和诊断字段 */
export function formatChatForClipboard(messages: ChatMessage[], lookupAsset?: (id: string) => Asset | undefined,
  conversation?: Pick<Conversation, "title">): string {
  const blocks = messages.flatMap((message) => {
    if (message.role === "system") return [];
    const text = messageText(message);
    const attachments = attachmentNames(message, lookupAsset);
    if (!text && !attachments.length) return [];
    return [`**${roleLabels[message.role]}**`, text, ...(attachments.length ? [`附件：${attachments.join("、")}`] : [])]
      .filter(Boolean).join("\n");
  });
  return [conversation?.title ? `# ${conversation.title}` : "", ...blocks].filter(Boolean).join("\n\n");
}
