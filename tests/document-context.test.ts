import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppDatabase } from "../src/server/db";
import { collectTurnDocuments } from "../src/server/agent-context";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("脚本文档上下文", () => {
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
