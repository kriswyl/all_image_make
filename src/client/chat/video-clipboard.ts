import type { Asset } from "../../shared/types";
import { copyTextToClipboard } from "../clipboard";

// 系统剪贴板保存素材引用，ChatCanvas 在粘贴时从本地素材库读取原视频或音频。
// 旧版复制的是 chatcanvas://video/…，继续识别，避免升级后旧剪贴板内容失效。
const mediaReference = /^chatcanvas:\/\/(?:asset|video|audio)\/([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\/([^\s/]+)$/i;
// 会话/文档 ID 由服务端校验归属；这里只负责把一行引用拆开
const documentReference = /^chatcanvas:\/\/document\/([^\s/]+)\/([^\s/]+)\/([^\s/]+)$/i;

export function copyChatMedia(asset: Asset) {
  const name = asset.title?.replace(/[\\/\u0000-\u001f]/g, "_").trim().slice(0, 255) || asset.fileName;
  return copyTextToClipboard(`chatcanvas://asset/${asset.id}/${encodeURIComponent(name)}`);
}

/** 兼容旧调用名；音频和视频都走同一套引用 */
export const copyChatVideo = copyChatMedia;

function referenceFromMatch(match: RegExpExecArray): Pick<Asset, "url" | "fileName" | "mimeType"> | null {
  let fileName: string;
  try { fileName = decodeURIComponent(match[2]!); } catch { return null; }
  if (!fileName || fileName.length > 255 || /[\\/\u0000-\u001f]/.test(fileName)) return null;
  return { url: `/api/assets/${match[1]}/file`, fileName, mimeType: "" };
}

export function readChatMediaReference(text: string): Pick<Asset, "url" | "fileName" | "mimeType"> | null {
  const match = mediaReference.exec(text.trim());
  return match ? referenceFromMatch(match) : null;
}

/**
 * 一条复制的消息里可能同时有正文和多张图片/音视频。
 * 引用各自独占一行；其余行原样保留，粘贴时插回输入框。
 */
export interface ChatDocumentReference {
  conversationId: string;
  documentId: string;
  fileName: string;
}

export function readChatReferences(text: string): {
  media: Array<Pick<Asset, "url" | "fileName" | "mimeType">>;
  documents: ChatDocumentReference[];
  text: string;
} {
  const media: Array<Pick<Asset, "url" | "fileName" | "mimeType">> = [];
  const documents: ChatDocumentReference[] = [];
  const remaining: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const mediaMatch = mediaReference.exec(trimmed);
    const mediaReferenceValue = mediaMatch ? referenceFromMatch(mediaMatch) : null;
    if (mediaReferenceValue) { media.push(mediaReferenceValue); continue; }
    const documentMatch = documentReference.exec(trimmed);
    if (documentMatch) {
      let fileName: string;
      try { fileName = decodeURIComponent(documentMatch[3]!); } catch { fileName = ""; }
      if (fileName && fileName.length <= 255 && !/[\\/\u0000-\u001f]/.test(fileName)) {
        documents.push({ conversationId: documentMatch[1]!, documentId: documentMatch[2]!, fileName });
        continue;
      }
    }
    remaining.push(line);
  }
  return { media, documents, text: remaining.join("\n").trim() };
}

export function readChatMediaReferences(text: string): { references: Array<Pick<Asset, "url" | "fileName" | "mimeType">>; text: string } {
  const { media, text: remaining } = readChatReferences(text);
  return { references: media, text: remaining };
}

/** 兼容旧调用名；音频和视频都走同一套引用 */
export const readChatVideoReference = readChatMediaReference;
