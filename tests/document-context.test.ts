import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/server/db";
import { collectTurnDocuments, renderDocumentContext, renderDocumentIndex } from "../src/server/agent-context";
import { documentSource } from "../src/server/chat-tools/document-workspace";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("脚本文档上下文", () => {
  it("普通聊天只放入导图引用，避免大导图直接占满上下文", () => {
    const doc = { id: "doc-1", conversationId: "chat", fileName: "大导图.xmind", content: "导图正文".repeat(20000), charCount: 80000, createdAt: "" };
    const plain = renderDocumentContext([doc], true)!;
    expect(plain).toContain("doc-1");
    expect(plain).toContain("doc_read");
    expect(plain).not.toContain("导图正文");
  });
  it("纯文本文档也带文件 ID，模型不必拿文件名猜 fileId", () => {
    const doc = { id: "doc-txt-1", conversationId: "chat", fileName: "1-洗稿提示词.txt", content: "按这个指南改写。", charCount: 8, createdAt: "" };
    const context = renderDocumentContext([doc])!;
    expect(context).toContain("文件 ID：doc-txt-1");
    expect(context).toContain("文件名不是 ID");
    expect(context).toContain("按这个指南改写。");
  });

  it("旧对话把文件名当 fileId 传给 doc_read 时按同名文件解析", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-doc-id-"));
    const db = new AppDatabase(dataDir);
    cleanups.push(async () => {
      db.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const conversation = db.createConversation({
      title: "文件名兜底", brainChannelId: "brain", brainModel: "mock-chat",
      videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
    });
    const document = db.addConversationDocument(conversation.id, "1-洗稿提示词.txt", "按这个指南改写。");
    expect(documentSource(db, conversation.id, "1-洗稿提示词.txt").bytes?.toString("utf8")).toBe("按这个指南改写。");
    expect(documentSource(db, conversation.id, document.id).bytes?.toString("utf8")).toBe("按这个指南改写。");
    // 同名文件有两份时不能猜，否则会读到错误版本
    db.addConversationDocument(conversation.id, "1-洗稿提示词.txt", "另一个版本。");
    expect(() => documentSource(db, conversation.id, "1-洗稿提示词.txt")).toThrow("文件不存在或不属于当前会话");
  });

  it("常驻文件索引包含上传件与生成件的 ID，不依赖刚上传那一轮", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-doc-index-"));
    const db = new AppDatabase(dataDir);
    cleanups.push(async () => {
      db.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const conversation = db.createConversation({
      title: "文件索引", brainChannelId: "brain", brainModel: "mock-chat",
      videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
    });
    const uploaded = db.addConversationDocument(conversation.id, "1-洗稿提示词.txt", "指南正文");
    const index = renderDocumentIndex(db, conversation.id);
    expect(index).toContain("《1-洗稿提示词.txt》");
    expect(index).toContain(`文件 ID：${uploaded.id}`);
    expect(index).toContain("文件 ID");
  });

  it("上一轮空正文失败后，下一轮只发「重试」也会带上最近的脚本文档", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-doc-context-"));
    const db = new AppDatabase(dataDir);
    cleanups.push(async () => {
      db.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const conversation = db.createConversation({
      title: "文档重试", brainChannelId: "brain", brainModel: "mock-chat",
      videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
    });
    const document = db.addConversationDocument(conversation.id, "剧情.md", "第一场：公园长椅。");
    db.appendMessage({
      conversationId: conversation.id, role: "user",
      content: "上传了脚本文档 《剧情.md》",
      documents: [{ id: document.id, name: document.fileName, charCount: document.charCount }],
    });
    db.appendMessage({ conversationId: conversation.id, role: "user", content: "这个" });
    db.appendMessage({
      conversationId: conversation.id, role: "assistant", status: "error",
      content: "（大脑没有返回内容，请再发一次。）", errorMessage: "大脑返回了空内容",
    });
    db.appendMessage({ conversationId: conversation.id, role: "user", content: "重试" });

    const documents = collectTurnDocuments(db, conversation.id);
    expect(documents.map((item) => item.fileName)).toEqual(["剧情.md"]);
    expect(documents[0]!.content).toContain("公园长椅");
  });

  it("正常成功后不会把旧文档重复灌进下一轮", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-doc-context-ok-"));
    const db = new AppDatabase(dataDir);
    cleanups.push(async () => {
      db.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const conversation = db.createConversation({
      title: "文档正常", brainChannelId: "brain", brainModel: "mock-chat",
      videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
    });
    const document = db.addConversationDocument(conversation.id, "剧情.md", "第一场。");
    db.appendMessage({
      conversationId: conversation.id, role: "user", content: "上传了脚本文档",
      documents: [{ id: document.id, name: document.fileName, charCount: document.charCount }],
    });
    db.appendMessage({ conversationId: conversation.id, role: "user", content: "拆成分镜" });
    db.appendMessage({ conversationId: conversation.id, role: "assistant", content: "拆好了。" });
    db.appendMessage({ conversationId: conversation.id, role: "user", content: "继续" });

    expect(collectTurnDocuments(db, conversation.id)).toEqual([]);
  });
});
