import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { AppDatabase } from "../src/server/db";
import { executeChatDocumentTool, readWorkspaceFile } from "../src/server/chat-tools/documents";

it("搜索长文并分页定位，读取上下文后安全生成修改版", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-search-"));
  const db = new AppDatabase(dir);
  try {
    const options = { brainChannelId: "brain", brainModel: "mock", videoConfirmPolicy: "auto_only" as const, visionEnabled: false, verbatimPrompt: false };
    const chat = db.createConversation({ ...options, title: "搜索" });
    const other = db.createConversation({ ...options, title: "隔离" });
    const content = `开头😀${"长".repeat(21000)}第一处目标\r\n${"中".repeat(500)}第二处目标`;
    const file = await executeChatDocumentTool(db, chat.id, "doc_create", JSON.stringify({ kind: "txt", name: "长文", content }));
    const fileId = file.data!.fileId;
    const search = async (charOffset = 0) => JSON.parse((await executeChatDocumentTool(db, chat.id, "doc_search", JSON.stringify({ fileId, query: "目标", charOffset, limit: 1 }))).summary);
    const first = await search();
    expect(first.matches).toHaveLength(1);
    expect(first.matches[0].context).toContain("第一处目标");
    expect(first.nextCharOffset).toBe(first.matches[0].charOffset + 2);
    const second = await search(first.nextCharOffset);
    expect(second.matches[0].context).toContain("第二处目标");
    expect(second.nextCharOffset).toBeNull();
    const read = JSON.parse((await executeChatDocumentTool(db, chat.id, "doc_read", JSON.stringify({ fileId, charOffset: second.matches[0].contextStart, charLimit: 1000 }))).summary);
    expect(read.chunk).toContain("第二处目标");
    expect(read.sha256).toBe(second.sha256);
    const edit = await executeChatDocumentTool(db, chat.id, "doc_edit", JSON.stringify({ fileId, expectedSha256: read.sha256, edits: [{ find: "第二处目标", replace: "更新内容" }] }));
    expect(edit.ok).toBe(true);
    expect(readWorkspaceFile(db, chat.id, edit.data!.fileId).bytes.toString()).toBe(content.replace("第二处目标", "更新内容"));
    expect((await executeChatDocumentTool(db, other.id, "doc_search", JSON.stringify({ fileId, query: "目标" }))).ok).toBe(false);
    expect((await executeChatDocumentTool(db, chat.id, "doc_search", JSON.stringify({ fileId, query: "" }))).ok).toBe(false);
  } finally { db.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
