import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { createApp } from "../src/server/app";
import JSZip from "jszip";
import { extractMindImages, parseXmind, planMindSlides, renderAiPresentation, renderMindPptx } from "../src/server/mind-document";
import { planPresentationWithAi } from "../src/server/ai-presentation";
import { checkPresentation } from "../src/server/presentation-check";

describe("XMind 转 PPT", () => {
  it("解析多工作表、主题和备注，生成包含可编辑文字的 PPTX", async () => {
    const zip = new JSZip();
    zip.file("content.json", JSON.stringify([{ rootTopic: { title: "产品方案", children: { attached: [{ title: "市场分析", notes: { plain: { content: "讲解备注" } }, children: { attached: [{ title: "目标用户" }, { title: "竞争产品" }] } }] } } }, { rootTopic: { title: "第二张导图", children: { attached: [{ title: "下一步" }] } } }]));
    const doc = await parseXmind(await zip.generateAsync({ type: "nodebuffer" }));
    expect(doc.sheets).toHaveLength(2);
    const plan = planMindSlides(doc);
    expect(plan.map((slide) => slide.title)).toEqual(["产品方案", "市场分析", "第二张导图", "下一步"]);
    expect(plan[1]).toMatchObject({ lines: ["目标用户", "竞争产品"], notes: "讲解备注" });
    const ppt = await JSZip.loadAsync(await renderMindPptx(plan));
    const body = await ppt.file("ppt/slides/slide2.xml")!.async("string");
    expect(body).toContain("目标用户"); expect(body).toContain("竞争产品"); expect(body).toContain("<a:t>");
    expect(await ppt.file("ppt/notesSlides/notesSlide2.xml")!.async("string")).toContain("讲解备注");
  });
  it("对超长内容分页，不丢失节点", async () => {
    const text = "长".repeat(400);
    const slides = planMindSlides({ format: "xmind", warnings: [], sheets: [{ title: "主题", notes: "", children: [{ title: "章节", notes: "", children: [{ title: text, notes: "", children: [] }] }] }] });
    expect(slides.length).toBeGreaterThan(2);
    expect(slides.slice(1).flatMap((slide) => slide.lines).join("")).toBe(text);
  });
  it("聊天上传、拆页预览、PPT 下载及会话隔离", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mind-test-"));
    const { app, context } = createApp({ dataDir: dir });
    try {
      const makeConversation = () => context.db.createConversation({ title: "测试", brainChannelId: "brain", brainModel: "chat", videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false });
      const chat = makeConversation(); const other = makeConversation();
      const zip = new JSZip(); zip.file("content.json", JSON.stringify([{ rootTopic: { title: "产品", children: { attached: [{ title: "计划", children: { attached: [{ title: "研究" }] } }] } } }]));
      const file = await zip.generateAsync({ type: "nodebuffer" });
      const upload = await request(app).post(`/api/conversations/${chat.id}/mind-documents`).attach("file", file, "test.xmind").expect(201);
      const id = upload.body.data.messages.flatMap((message: { documents: Array<{ id: string }> }) => message.documents).at(-1).id;
      const plan = await request(app).get(`/api/conversations/${chat.id}/mind-documents/${id}/plan`).expect(200);
      expect(plan.body.data.slides.map((slide: { title: string }) => slide.title)).toEqual(["产品", "计划"]);
      expect(plan.body.data.sourceAvailable).toBe(true);
      const source = await request(app).get(`/api/conversations/${chat.id}/mind-documents/${id}/source`).buffer(true).parse((res, done) => { const chunks: Buffer[] = []; res.on("data", (chunk: Buffer) => chunks.push(chunk)); res.on("end", () => done(null, Buffer.concat(chunks))); }).expect(200);
      expect(source.body.equals(file)).toBe(true);
      const modified = plan.body.data.slides.map((slide: { title: string; lines: string[]; notes: string }, i: number) => i === 1 ? { ...slide, title: "调整后的计划", lines: ["新增内容"] } : slide);
      await request(app).put(`/api/conversations/${chat.id}/mind-documents/${id}/plan`).send({ slides: modified }).expect(200);
      expect((await request(app).get(`/api/conversations/${chat.id}/mind-documents/${id}/plan`).expect(200)).body.data.slides[1].title).toBe("调整后的计划");
      await request(app).put(`/api/conversations/${other.id}/mind-documents/${id}/plan`).send({ slides: modified }).expect(404);
      await request(app).get(`/api/conversations/${other.id}/mind-documents/${id}/plan`).expect(404);
      const response = await request(app).post(`/api/conversations/${chat.id}/mind-documents/${id}/pptx`).buffer(true).parse((res, done) => { const chunks: Buffer[] = []; res.on("data", (chunk: Buffer) => chunks.push(chunk)); res.on("end", () => done(null, Buffer.concat(chunks))); }).expect(200);
      expect(response.headers["content-type"]).toContain("presentationml");
      const output = await JSZip.loadAsync(response.body);
      const content = await output.file("ppt/slides/slide2.xml")!.async("string");
      expect(content).toContain("调整后的计划"); expect(content).toContain("新增内容");
    } finally { context.db.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });
  it("拒绝无效 XMind 文件", async () => { await expect(parseXmind(Buffer.from("bad"))).rejects.toThrow(/无法读取/); });
  it("保留主题图片并把关联关系作为来源交给 AI", async () => {
    const zip = new JSZip();
    zip.file("content.json", JSON.stringify([{ rootTopic: { id: "root", title: "项目", children: { attached: [{ id: "a", title: "设计", image: { src: "xap:resources/pic.png" } }, { id: "b", title: "生产" }] } }, relationships: [{ end1Id: "a", end2Id: "b", title: "协作" }] }]));
    zip.file("resources/pic.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aV8AAAAASUVORK5CYII=", "base64"));
    const source = await zip.generateAsync({ type: "nodebuffer" });
    const mind = await parseXmind(source);
    expect(mind.relationships?.[0]).toMatchObject({ fromTitle: "设计", toTitle: "生产", title: "协作" });
    const extracted = await extractMindImages(source, mind);
    expect(extracted.images).toHaveLength(1);
    const prompts: string[] = [];
    const plan = await planPresentationWithAi(mind, "转换", async (messages) => {
      const user = String(messages.at(-1)!.content); prompts.push(user);
      const parts = JSON.parse(user.slice(user.indexOf("素材（JSON 数据）：\n") + "素材（JSON 数据）：\n".length));
      return { content: JSON.stringify({ title: "项目", theme: "ink", slides: [{ layout: "content", title: "内容", subtitle: "", lines: ["导图内容"], notes: "", sourceIds: parts.map((p: { id: string }) => p.id) }] }), truncated: false };
    });
    expect(prompts.join("\n")).toContain("设计 ↔ 生产（协作）");
    plan.slides.push({ layout: "image", title: "设计", subtitle: "", lines: [], notes: "", imageIndex: 0 });
    const output = await renderAiPresentation(plan, extracted.images);
    await checkPresentation(output, plan);
    const ppt = await JSZip.loadAsync(output);
    expect(Object.keys(ppt.files).some((name) => name.startsWith("ppt/media/"))).toBe(true);
    expect(await ppt.file(`ppt/slides/slide${plan.slides.length}.xml`)!.async("string")).toContain("<p:pic>");
  });
  it("识别未导入的图片、附件和关系线并提示", async () => {
    const zip = new JSZip();
    zip.file("content.json", JSON.stringify([{ rootTopic: { title: "主题", image: { src: "xap:resources/image.png" } }, relationships: [{ end1Id: "a", end2Id: "b" }] }]));
    zip.file("resources/image.png", Buffer.from("image"));
    zip.file("attachments/data.pdf", Buffer.from("file"));
    const doc = await parseXmind(await zip.generateAsync({ type: "nodebuffer" }));
    expect(doc.warnings.join("\n")).toContain("检测到图片");
    expect(doc.warnings.join("\n")).toContain("检测到附件");
    expect(doc.warnings.join("\n")).toContain("检测到主题间关系线");
  });
  it("允许上传超过旧有 6 万字上限的导图", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mind-large-"));
    const { app, context } = createApp({ dataDir: dir });
    try {
      const chat = context.db.createConversation({ title: "大导图", brainChannelId: "brain", brainModel: "chat", videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false });
      const zip = new JSZip(); zip.file("content.json", JSON.stringify([{ rootTopic: { title: "主题", notes: { plain: { content: "资料".repeat(35000) } } } }]));
      await request(app).post(`/api/conversations/${chat.id}/mind-documents`).attach("file", await zip.generateAsync({ type: "nodebuffer" }), "large.xmind").expect(201);
    } finally { context.db.close(); await fs.rm(dir, { recursive: true, force: true }); }
  });
  it("读取旧版 XML 导图", async () => {
    const zip = new JSZip(); zip.file("content.xml", '<xmap-content><sheet><topic><title>主题</title><children><topics type="attached"><topic><title>章节</title><children><topics type="attached"><topic><title>内容</title></topic></topics></children></topic></topics></children></topic></sheet></xmap-content>');
    const doc = await parseXmind(await zip.generateAsync({ type: "nodebuffer" }));
    expect(planMindSlides(doc)[1]).toMatchObject({ title: "章节", lines: ["内容"] });
  });
});
