import { expect, it } from "vitest";
import JSZip from "jszip";
import { Jimp } from "jimp";
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

it("常见模型参数别名会被收敛：PPT 大小写、短文件 ID、text 对象和多余 lines", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ppt-normalize-")); const { context } = createApp({ dataDir: dir }); const db = context.db;
  try {
    const chat = db.createConversation({ title: "归一化", brainChannelId: "brain", brainModel: "mock", videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false });
    const source = await executeChatDocumentTool(db, chat.id, "doc_create", JSON.stringify({
      kind: "markdown", name: "资料", content: "# 库存\n库存数量12", nodes: { children: [] },
    }));
    expect(source.ok, source.summary).toBe(true);
    const created = await executeChatDocumentTool(db, chat.id, "doc_convert", JSON.stringify({ fileId: source.data!.fileId, to: "PPT" }), async () => ({ title: "库存", theme: "blue", slides: [slide] }));
    expect(created.ok, created.summary).toBe(true);
    const sha256 = createHash("sha256").update(readWorkspaceFile(db, chat.id, created.data!.fileId).bytes).digest("hex");
    const malformed = {
      fileId: created.data!.fileId.slice(0, 8), sha256, pages: [{ page: 1, slide: {
        ...slide, lines: ["这行不应触发元素页校验"], elements: [
          { ...slide.elements![0], style: undefined, text: { text: "库存方案", style: { fontSize: 28, bold: true } } },
          { ...slide.elements![1], style: undefined, text: { text: "库存数量12，按原始资料处理。", style: { fontSize: 24 } } },
        ],
      } }],
    };
    const edited = await executeChatDocumentTool(db, chat.id, "doc_edit", JSON.stringify(malformed));
    expect(edited.ok, edited.summary).toBe(true);
    const project = (await readPresentationProject(readWorkspaceFile(db, chat.id, edited.data!.fileId).bytes))!;
    expect(project.plan.slides[0]?.elements).toContainEqual(expect.objectContaining({ id: "body", text: "库存数量12，按原始资料处理。", style: expect.objectContaining({ fontSize: 24 }) }));
  } finally { db.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

it("文档目录可切换，旧记录按 base_dir 读取，版本清理保留最新和根文件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "docs-dir-"));
  const external = await fs.mkdtemp(path.join(os.tmpdir(), "docs-external-"));
  const { context } = createApp({ dataDir: dir }); const db = context.db;
  try {
    const chat = db.createConversation({ title: "目录", brainChannelId: "brain", brainModel: "mock", videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false });
    const custom = await fs.mkdtemp(path.join(external, "docs-"));
    expect(db.setDocumentsDir(custom)).toBe(custom);
    expect(db.documentsDir).toBe(custom);
    const folder = path.join(custom, chat.id); await fs.mkdir(folder, { recursive: true });
    const files: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      const name = `v${index + 1}.pptx`;
      await fs.writeFile(path.join(folder, name), `v${index + 1}`);
      const root = files[0];
      const saved = db.addWorkspaceDocument(chat.id, name, name.length, undefined, undefined, custom, root ? { familyId: root, parentId: files[files.length - 1] } : undefined);
      files.push(saved.id);
      expect(readWorkspaceFile(db, chat.id, saved.id).bytes.toString()).toBe(`v${index + 1}`);
    }
    expect(db.listWorkspaceDocuments(chat.id)).toHaveLength(4);
    db.pruneWorkspaceFamily(chat.id, files[0]!, 2);
    expect(db.listWorkspaceDocuments(chat.id)).toHaveLength(3);
    expect(db.getWorkspaceDocument(chat.id, files[0]!)).not.toBeNull();
    expect(db.getWorkspaceDocument(chat.id, files[1]!)).toBeNull();
    expect(db.getWorkspaceDocument(chat.id, files[3]!)).not.toBeNull();
  } finally {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(external, { recursive: true, force: true });
  }
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

it.each([false, true])("新建 PPT 保留三页并把聊天配图嵌入第二、三页（模板管线 %s）", async (templated) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ppt-page-images-"));
  const { app, context } = createApp({ dataDir: dir });
  const db = context.db;
  try {
    const chat = db.createConversation({ title: "配图", brainChannelId: "brain", brainModel: "mock", videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false });
    const source = await executeChatDocumentTool(db, chat.id, "doc_create", JSON.stringify({ kind: "md", name: "重庆", content: "# 重庆\n## 山城\n## 两江" }));
    const ids: string[] = [];
    for (const color of [0x334466ff, 0xaa8844ff, 0x556677ff]) {
      const bytes = await new Jimp({ width: 8, height: 8, color }).getBuffer("image/png");
      const result = (await request(app).post(`/api/conversations/${chat.id}/uploads`).attach("images", bytes, "配图.png").expect(201)).body.data;
      ids.push(result.sessionImages.at(-1).asset.id);
    }
    const plan: AiPresentation = { title: "重庆", theme: "blue", slides: [
      { layout: "cover", title: "重庆", subtitle: "", lines: [], notes: "", ...(templated ? {
        elements: [{ type: "text", id: "title", x: 1, y: 1, w: 5, h: 1, text: "重庆" }, { type: "image", id: "cover-image", x: 7, y: 1, w: 5, h: 5, imageIndex: 0 }],
      } : {}) },
      { ...slide, title: "山城" },
      { layout: "content", title: "两江", subtitle: "", lines: ["两江交汇"], notes: "" },
    ] };
    const args = { fileId: source.data!.fileId, to: "pptx", coverAssetId: ids[0], pageImages: [{ page: 2, assetId: ids[1] }, { page: 3, assetId: ids[2] }] };
    const result = await executeChatDocumentTool(db, chat.id, "doc_convert", JSON.stringify(args), async () => templated ? { plan, template: {
      draft: false, resume: false, fallbackPages: [], pendingPages: [], overflowPages: [], sourceLimitedPages: [], notesLimitedPages: [],
      unplacedImages: 0, planningFallback: false, audit: "complete", issues: [],
    } } : plan);
    expect(result.ok, result.summary).toBe(true);
    expect(result.summary).toContain("第 2、3 页");
    const bytes = readWorkspaceFile(db, chat.id, result.data!.fileId).bytes;
    const project = (await readPresentationProject(bytes))!;
    expect(project.plan.slides).toHaveLength(3);
    expect(project.plan.slides.map(item => item.elements?.filter(element => element.type === "image").map(element => element.imageIndex))).toEqual([[0], [1], [2]]);
    expect(project.plan.slides[1]?.elements).toContainEqual(expect.objectContaining({ id: "body", text: "库存数量12，按原始资料处理。" }));
    const zip = await JSZip.loadAsync(bytes);
    for (const number of [1, 2, 3]) expect(await zip.file(`ppt/slides/slide${number}.xml`)!.async("string")).toContain("<p:pic>");
    const outOfRange = await executeChatDocumentTool(db, chat.id, "doc_convert", JSON.stringify({ ...args, pageImages: [{ page: 4, assetId: ids[1] }] }), async () => plan);
    expect(outOfRange.summary).toContain("无法在第 4 页");
  } finally {
    context.agent.dispose();
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

