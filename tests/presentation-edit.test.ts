import { expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createHash } from "node:crypto";
import { createApp } from "../src/server/app";
import { executeChatDocumentTool, readWorkspaceFile } from "../src/server/chat-tools/documents";
import { readPresentationProject } from "../src/server/presentation-project";
import { renderAiPresentation, type AiPresentation } from "../src/server/mind-document";

const slide: AiPresentation["slides"][number] = { layout: "content", title: "库存方案", subtitle: "", lines: [], notes: "来源原文：库存数量12", sourceIds: ["s1-1.1"], elements: [
  { id: "title", type: "text", x: 0.8, y: 0.5, w: 11, h: 0.8, text: "库存方案", style: { fontSize: 28, bold: true } },
  { id: "body", type: "text", x: 0.8, y: 2, w: 11, h: 2, text: "库存数量12，按原始资料处理。", style: { fontSize: 20 } },
] };

it("聊天生成PPT可读取元素、按页修改并继续修改新版本，原件与来源保留", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ppt-edit-")); const { context } = createApp({ dataDir: dir }); const db = context.db;
  try {
    const chat = db.createConversation({ title: "编辑", brainChannelId: "brain", brainModel: "mock", videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false });
    const source = await executeChatDocumentTool(db, chat.id, "doc_create", JSON.stringify({ kind: "md", name: "资料", content: "# 库存\n库存数量12" }));
    const created = await executeChatDocumentTool(db, chat.id, "doc_convert", JSON.stringify({ fileId: source.data!.fileId, to: "pptx" }), async () => ({ title: "库存", theme: "blue", slides: [slide] }));
    expect(created.ok, created.summary).toBe(true);
    const original = readWorkspaceFile(db, chat.id, created.data!.fileId).bytes;
    const read = JSON.parse((await executeChatDocumentTool(db, chat.id, "doc_read", JSON.stringify({ fileId: created.data!.fileId, charOffset: 0 }))).summary);
    expect(read.chunk).toContain('"id": "body"'); expect(read.chunk).toContain('"editable": true');
    const changed = structuredClone(slide); changed.elements![1] = { ...changed.elements![1]!, type: "text", id: "body", x: 0.8, y: 2.3, w: 11, h: 2, text: "库存数量12，按原始资料处理。", style: { fontSize: 24 } }; changed.notes = ""; delete changed.sourceIds;
    const args = { fileId: created.data!.fileId, expectedSha256: read.sha256, pages: [{ page: 1, slide: changed }], appendSlides: [{ ...slide, title: "附录" }], order: [2,1] };
    const edited = await executeChatDocumentTool(db, chat.id, "doc_edit", JSON.stringify(args));
    expect(edited.ok, edited.summary).toBe(true);
    expect(readWorkspaceFile(db, chat.id, created.data!.fileId).bytes.equals(original)).toBe(true);
    const project = await readPresentationProject(readWorkspaceFile(db, chat.id, edited.data!.fileId).bytes);
    expect(project!.plan.slides[1]!.notes).toBe(slide.notes); expect(project!.plan.slides[1]!.sourceIds).toEqual(slide.sourceIds);
    expect(project!.plan.slides[1]!.elements![1]).toMatchObject({ y: 2.3, style: { fontSize: 24 } });
    const second = await executeChatDocumentTool(db, chat.id, "doc_edit", JSON.stringify({ fileId: edited.data!.fileId, expectedSha256: createHash("sha256").update(readWorkspaceFile(db, chat.id, edited.data!.fileId).bytes).digest("hex"), design: { accent: "1F3A5F" } }));
    expect(second.ok, second.summary).toBe(true);
    expect((await readPresentationProject(readWorkspaceFile(db, chat.id, second.data!.fileId).bytes))!.plan.design?.accent).toBe("1F3A5F");
    expect((await executeChatDocumentTool(db, chat.id, "doc_edit", JSON.stringify({ ...args, expectedSha256: "0".repeat(64) }))).summary).toContain("版本已变化");
    expect((await executeChatDocumentTool(db, chat.id, "doc_edit", JSON.stringify({ ...args, order: [1,1] }))).ok).toBe(false);
    expect((await executeChatDocumentTool(db, chat.id, "doc_edit", JSON.stringify({ ...args, pages: [{ page: 5, slide }] }))).ok).toBe(false);
  } finally { db.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

it("PPT参考上传、列表、读取和转换主题能串通，并受会话隔离", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ppt-ref-")); const { app, context } = createApp({ dataDir: dir }); const db = context.db;
  try {
    const chat = db.createConversation({ title: "参考", brainChannelId: "brain", brainModel: "mock", videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false });
    const other = db.createConversation({ title: "隔离", brainChannelId: "brain", brainModel: "mock", videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false });
    const bytes = await renderAiPresentation({ title: "参考", theme: "blue", slides: [slide] });
    const upload = await request(app).post(`/api/conversations/${chat.id}/mind-documents`).attach("file", bytes, "brand.pptx").expect(201);
    const referenceFileId = upload.body.data.messages.flatMap((message: any) => message.documents).at(-1).id;
    const source = await executeChatDocumentTool(db, chat.id, "doc_create", JSON.stringify({ kind: "csv", name: "数量", content: "名称,数量\n库存,12" }));
    const listed = await executeChatDocumentTool(db, chat.id, "doc_list", "{}"); expect(listed.summary).toContain(referenceFileId);
    const ref = JSON.parse((await executeChatDocumentTool(db, chat.id, "doc_read", JSON.stringify({ fileId: referenceFileId, charOffset: 0 }))).summary);
    expect(ref.chunk).toContain('"editable": false');
    let design: unknown;
    const converted = await executeChatDocumentTool(db, chat.id, "doc_convert", JSON.stringify({ fileId: source.data!.fileId, referenceFileId, to: "pptx", design: { accent: "1F3A5F" } }), async (_mind, _images, chosen) => { design = chosen; return { title: "库存", theme: "blue", slides: [slide] }; });
    expect(converted.ok, converted.summary).toBe(true); expect(design).toMatchObject({ accent: "1F3A5F" });
    expect((await executeChatDocumentTool(db, other.id, "doc_read", JSON.stringify({ fileId: referenceFileId }))).ok).toBe(false);
    expect((await executeChatDocumentTool(db, chat.id, "doc_edit", JSON.stringify({ fileId: referenceFileId, expectedSha256: ref.sha256, pages: [{ page: 1, slide }] }))).summary).toContain("没有 ChatCanvas 可编辑源方案");
  } finally { db.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

