import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { AppDatabase } from "../src/server/db";
import { executeChatDocumentTool, readWorkspaceFile } from "../src/server/chat-tools/documents";

it("按读取的版本精确修改文本，保留原文件并拒绝不明确的修改", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-edit-")); const db = new AppDatabase(dir);
  try {
    const chat = db.createConversation({ title: "编辑", brainChannelId: "brain", brainModel: "mock", videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false });
    const other = db.createConversation({ title: "隔离", brainChannelId: "brain", brainModel: "mock", videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false });
    const original = await executeChatDocumentTool(db, chat.id, "doc_create", JSON.stringify({ kind: "md", name: "说明", content: "# 标题\r\n第一段\r\n第二段" }));
    const fileId = original.data!.fileId;
    const read = await executeChatDocumentTool(db, chat.id, "doc_read", JSON.stringify({ fileId, charOffset: 0 }));
    const content = JSON.parse(read.summary);
    expect(content.chunk).toBe("# 标题\r\n第一段\r\n第二段");
    expect(content.sha256).toMatch(/^[a-f0-9]{64}$/);
    const args = { fileId, expectedSha256: content.sha256, edits: [{ find: "第一段", replace: "修改后的第一段" }, { find: "第二段", replace: "修改后的第二段" }] };
    const edited = await executeChatDocumentTool(db, chat.id, "doc_edit", JSON.stringify(args));
    expect(edited.ok).toBe(true);
    expect(readWorkspaceFile(db, chat.id, fileId).bytes.toString()).toBe("# 标题\r\n第一段\r\n第二段");
    expect(readWorkspaceFile(db, chat.id, edited.data!.fileId).bytes.toString()).toBe("# 标题\r\n修改后的第一段\r\n修改后的第二段");
    expect((await executeChatDocumentTool(db, chat.id, "doc_edit", JSON.stringify({ ...args, expectedSha256: "0".repeat(64) }))).summary).toContain("版本已变化");
    expect((await executeChatDocumentTool(db, chat.id, "doc_edit", JSON.stringify({ ...args, edits: [{ find: "段", replace: "X" }] }))).summary).toContain("匹配多次");
    expect((await executeChatDocumentTool(db, other.id, "doc_edit", JSON.stringify(args))).ok).toBe(false);
  } finally { db.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

it("按字符分页支持长行并保护 UTF-8 BOM 和 JSON 格式", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-edit-json-")); const db = new AppDatabase(dir);
  try {
    const chat = db.createConversation({ title: "长文本", brainChannelId: "brain", brainModel: "mock", videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false });
    const created = await executeChatDocumentTool(db, chat.id, "doc_create", JSON.stringify({ kind: "json", name: "数据", content: JSON.stringify({ value: "字".repeat(22000), word: "旧" }) }));
    const fileId = created.data!.fileId;
    expect((await executeChatDocumentTool(db, chat.id, "doc_read", JSON.stringify({ fileId }))).summary).toContain("charOffset");
    const first = JSON.parse((await executeChatDocumentTool(db, chat.id, "doc_read", JSON.stringify({ fileId, charOffset: 0, charLimit: 10000 }))).summary);
    expect(first.nextCharOffset).toBe(10000);
    const second = JSON.parse((await executeChatDocumentTool(db, chat.id, "doc_read", JSON.stringify({ fileId, charOffset: first.nextCharOffset, charLimit: 20000 }))).summary);
    expect(second.chunk).toContain('"word":"旧"');
    const invalid = await executeChatDocumentTool(db, chat.id, "doc_edit", JSON.stringify({ fileId, expectedSha256: first.sha256, edits: [{ find: '"word":"旧"', replace: '"word":' }] }));
    expect(invalid.ok).toBe(false); expect(invalid.summary).toContain("JSON 无效");
    const csv = await executeChatDocumentTool(db, chat.id, "doc_create", JSON.stringify({ kind: "csv", name: "表", content: "名称,数量\r\n苹果,1" }));
    const csvRead = JSON.parse((await executeChatDocumentTool(db, chat.id, "doc_read", JSON.stringify({ fileId: csv.data!.fileId, charOffset: 0 }))).summary);
    const csvEdit = await executeChatDocumentTool(db, chat.id, "doc_edit", JSON.stringify({ fileId: csv.data!.fileId, expectedSha256: csvRead.sha256, edits: [{ find: "苹果,1", replace: "苹果,2" }] }));
    expect(readWorkspaceFile(db, chat.id, csvEdit.data!.fileId).bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
  } finally { db.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
