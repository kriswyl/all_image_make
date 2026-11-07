import fs from "node:fs";
import path from "node:path";
import type { AppDatabase } from "./db.js";

/**
 * 工作区文件路径工具。从 chat-tools/documents.ts 抽出，供保存流程与 B 的候选/发布模块共用，
 * 避免 documents.ts ↔ document-publish.ts 形成循环依赖。安全语义保持不变：
 * 会话 ID 校验、根目录越界检查、符号链接拒绝。
 */
export function safeName(name: string, extension: string) {
  let base = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").trim().slice(0, 70) || "文档";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  if (!base.toLowerCase().endsWith(`.${extension}`)) base += `.${extension}`;
  return base;
}

export function workspaceDir(db: AppDatabase, conversationId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(conversationId) || !db.getConversation(conversationId)) throw new Error("会话不存在");
  const root = path.resolve(db.documentsDir);
  const dir = path.resolve(root, conversationId);
  if (path.dirname(dir).toLowerCase() !== root.toLowerCase()) throw new Error("文件路径越界");
  for (const part of [root, dir]) {
    if (!fs.existsSync(part)) fs.mkdirSync(part);
    if (fs.lstatSync(part).isSymbolicLink() || !fs.statSync(part).isDirectory()) throw new Error("工作目录不安全");
  }
  return dir;
}
