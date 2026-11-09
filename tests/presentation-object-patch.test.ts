import JSZip from "jszip";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { XMLParser } from "fast-xml-parser";
import { renderAiPresentation, type AiPresentation } from "../src/server/mind-document";
import { patchPresentationObjects } from "../src/server/presentation-object-patch";
import { packPresentationProject, readPresentationProject } from "../src/server/presentation-project";
import { AppDatabase } from "../src/server/db";
import { executeChatDocumentTool, saveWorkspaceDocument } from "../src/server/chat-tools/documents";

/** M2：限定原位补丁。断言同时看 OOXML、plan 同步和部件差异。 */

const plan: AiPresentation = {
  title: "原位补丁", theme: "blue",
  slides: [{
    layout: "content", title: "补丁页", subtitle: "", lines: [], notes: "", sourceIds: ["s1"],
    elements: [
      { type: "text", id: "t-title", x: 0.8, y: 0.7, w: 8, h: 0.9, text: "标题", style: { fontSize: 30, color: "243443" } },
      { type: "shape", id: "s-bar", shape: "roundRect", x: 0.8, y: 1.8, w: 2.4, h: 0.2, fill: "286D9C" },
      { type: "icon", id: "ic-1", icon: "target", x: 0.8, y: 2.4, w: 0.6, h: 0.6 },
      { type: "text", id: "t-body", x: 1.8, y: 2.4, w: 9, h: 1.2, text: "正文说明", style: { fontSize: 18 } },
      { type: "table", id: "tb-1", x: 0.8, y: 4, w: 5.6, h: 2, rows: [["阶段", "结果"], ["选点", "3 个"]], header: true },
      { type: "connector", id: "cn-1", from: "t-body", to: "tb-1" },
    ],
  }],
};

const slideXml = async (bytes: Buffer) => (await JSZip.loadAsync(bytes)).file("ppt/slides/slide1.xml")!.async("string");

it("P01：改字号 / 文字颜色 / 位置，plan 与 OOXML 同步，其它部件不动", async () => {
  const bytes = await renderAiPresentation(plan);
  const result = await patchPresentationObjects(bytes, plan, [{
    slide: 1, elementId: "t-title", fontSize: 24, color: "B23B2E", rect: { x: 1, y: 2, w: 6, h: 1 },
  }]);

  expect(result.report.applied).toEqual([{ slide: 1, elementId: "t-title", operations: ["fontSize", "color", "rect"] }]);
  expect(result.report.rejected).toEqual([]);
  // 只有目标页变化，其余部件逐字节一致
  expect(result.report.changedParts).toEqual(["ppt/slides/slide1.xml"]);
  expect(result.report.unchangedParts).toBeGreaterThan(5);

  const xml = await slideXml(result.bytes);
  expect(xml).toContain('sz="2400"');
  expect(xml).toContain('val="B23B2E"');
  expect(xml).toContain(`x="${Math.round(1 * 914400)}"`);
  expect(xml).toContain(`cx="${Math.round(6 * 914400)}"`);
  // 其它元素没被顺手改掉
  expect(xml).toContain('sz="1800"');

  // plan 同步：补丁后读回的可编辑源方案应等于新 plan
  const updated = result.plan.slides[0]!.elements!.find(element => element.id === "t-title")!;
  expect(updated).toMatchObject({ x: 1, y: 2, w: 6, h: 1 });
  expect(updated.type === "text" && updated.style?.fontSize).toBe(24);
  expect(updated.type === "text" && updated.style?.color).toBe("B23B2E");
  const project = (await readPresentationProject(result.bytes))!;
  expect(project.plan.slides[0]!.elements).toEqual(result.plan.slides[0]!.elements);
});

it("P02：普通形状改填充色与位置，只动 spPr", async () => {
  const bytes = await renderAiPresentation(plan);
  const result = await patchPresentationObjects(bytes, plan, [{
    slide: 1, elementId: "s-bar", color: "2A716B", rect: { x: 2, y: 2.2, w: 3, h: 0.3 },
  }]);
  expect(result.report.applied[0]!.operations).toEqual(["color", "rect"]);
  const xml = await slideXml(result.bytes);
  expect(xml).toContain('val="2A716B"');
  const shape = result.plan.slides[0]!.elements!.find(element => element.id === "s-bar")!;
  expect(shape.type === "shape" && shape.fill).toBe("2A716B");
  expect(shape).toMatchObject({ x: 2, y: 2.2, w: 3, h: 0.3 });
});

it("P03：复合对象与依赖对象一律拒绝，返回原文件不产生半成品", async () => {
  const bytes = await renderAiPresentation(plan);
  const result = await patchPresentationObjects(bytes, plan, [
    { slide: 1, elementId: "ic-1", color: "B23B2E" },
    { slide: 1, elementId: "tb-1", rect: { x: 1, y: 4, w: 5, h: 2 } },
    { slide: 1, elementId: "cn-1", rect: { x: 1, y: 1, w: 1, h: 1 } },
  ]);
  expect(result.report.applied).toEqual([]);
  expect(result.report.rejected.map(item => item.reason)).toEqual([
    expect.stringContaining("复合或依赖对象"),
    expect.stringContaining("复合或依赖对象"),
    expect.stringContaining("复合或依赖对象"),
  ]);
  // 全部被拒时原样返回，不写半成品
  expect(result.bytes).toBe(bytes);
});

it("P04：id 不存在或参数不合法时明确拒绝", async () => {
  const bytes = await renderAiPresentation(plan);
  const result = await patchPresentationObjects(bytes, plan, [
    { slide: 1, elementId: "不存在", fontSize: 20 },
    { slide: 1, elementId: "t-body", fontSize: 0 },
    { slide: 1, elementId: "t-body", color: "#FF0000" },
  ]);
  expect(result.report.rejected.map(item => item.reason)).toEqual([
    "计划里没有这个元素",
    expect.stringContaining("1–200pt"),
    expect.stringContaining("6 位十六进制"),
  ]);
});

it("P05：box / lines 页没有稳定元素列表，补丁不能声称 plan 仍有效", async () => {
  const boxed: AiPresentation = {
    title: "布局页", theme: "blue",
    slides: [{
      layout: "content", title: "布局页", subtitle: "", lines: [], notes: "", sourceIds: [],
      box: { x: 0.8, y: 1.6, w: 11.7, h: 4.6, layout: { direction: "row", gap: 0.2, children: [
        { flex: 1, element: { type: "text", id: "b-1", x: 0, y: 0, w: 1, h: 1, text: "左" } },
        { flex: 1, element: { type: "text", id: "b-2", x: 0, y: 0, w: 1, h: 1, text: "右" } },
      ] } },
    }],
  };
  const bytes = await renderAiPresentation(boxed);
  const result = await patchPresentationObjects(bytes, boxed, [{ slide: 1, elementId: "b-1", rect: { x: 1, y: 1, w: 2, h: 0.6 } }]);
  expect(result.report.applied).toEqual([]);
  expect(result.report.rejected[0]!.reason).toContain("不是元素页");
});

/** doc_edit 入口：objects 必须能真正走到原生补丁，而不是重新渲染整稿。 */
const databases: AppDatabase[] = [];
afterEach(() => {
  while (databases.length) { const db = databases.pop()!; try { db.close(); } catch { /* 已关闭 */ } }
});
async function source() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "object-patch-"));
  const db = new AppDatabase(dir);
  databases.push(db);
  const conversationId = db.createConversation({
    title: "对象补丁", brainChannelId: "mock-channel", brainModel: "mock",
    videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false,
  }).id;
  // 必须打成可编辑源方案，否则 doc_edit 会当作外部 PPT 拒绝
  const bytes = await packPresentationProject(await renderAiPresentation(plan), plan, []);
  const saved = saveWorkspaceDocument(db, conversationId, "补丁源文件", "pptx", bytes, "op-source");
  return { db, conversationId, fileId: saved.id, sha256: createHash("sha256").update(bytes).digest("hex") };
}

it("P06：doc_edit 的 objects 走原位补丁，页数不变、plan 同步", async () => {
  const { db, conversationId, fileId, sha256 } = await source();
  const result = await executeChatDocumentTool(db, conversationId, "doc_edit", JSON.stringify({
    fileId, expectedSha256: sha256,
    objects: [{ slide: 1, elementId: "t-title", fontSize: 26, color: "b23b2e" }],
  }), undefined, "op-object");
  expect(result.ok).toBe(true);
  expect(result.summary).toContain("原位修改 1 个对象");
  expect(result.summary).toContain("其余页面和部件保持原样");

  const { readWorkspaceFile } = await import("../src/server/chat-tools/documents");
  const bytes = readWorkspaceFile(db, conversationId, String(result.data!.fileId)).bytes;
  const project = (await readPresentationProject(bytes))!;
  expect(project.plan.slides).toHaveLength(1);
  const element = project.plan.slides[0]!.elements!.find(item => item.id === "t-title")!;
  expect(element.type === "text" && element.style?.fontSize).toBe(26);
  expect(element.type === "text" && element.style?.color).toBe("B23B2E");
});

it("P07：objects 不能和整页修改混用；不可补丁的对象如实报错", async () => {
  const { db, conversationId, fileId, sha256 } = await source();
  const mixed = await executeChatDocumentTool(db, conversationId, "doc_edit", JSON.stringify({
    fileId, expectedSha256: sha256,
    objects: [{ slide: 1, elementId: "t-title", fontSize: 26 }],
    design: { accent: "B23B2E" },
  }), undefined, "op-mixed");
  expect(mixed.ok).toBe(false);
  expect(mixed.summary).toContain("只能单独使用");

  const composite = await executeChatDocumentTool(db, conversationId, "doc_edit", JSON.stringify({
    fileId, expectedSha256: sha256,
    objects: [{ slide: 1, elementId: "ic-1", color: "b23b2e" }],
  }), undefined, "op-composite");
  expect(composite.ok).toBe(false);
  expect(composite.summary).toContain("复合或依赖对象");
});

it("P08：替换文字内容只改 <a:t>，字号颜色沿用，plan 同步", async () => {
  const bytes = await renderAiPresentation(plan);
  const result = await patchPresentationObjects(bytes, plan, [{ slide: 1, elementId: "t-title", text: "改后的标题" }]);
  expect(result.report.applied[0]!.operations).toEqual(["text"]);
  expect(result.report.changedParts).toEqual(["ppt/slides/slide1.xml"]);

  const xml = await slideXml(result.bytes);
  expect(xml).toContain("<a:t>改后的标题</a:t>");
  expect(xml).not.toContain("<a:t>标题</a:t>");
  // 原字号与颜色仍在（沿用 rPr）
  expect(xml).toContain('sz="3000"');
  expect(xml).toContain('val="243443"');
  const element = result.plan.slides[0]!.elements!.find(item => item.id === "t-title")!;
  expect(element.type === "text" && element.text).toBe("改后的标题");
});

it("P09：多段文字按段写入，段数与换行一致", async () => {
  const bytes = await renderAiPresentation(plan);
  const result = await patchPresentationObjects(bytes, plan, [{ slide: 1, elementId: "t-body", text: "第一行\n第二行" }]);
  const xml = await slideXml(result.bytes);
  expect(xml).toContain("<a:t>第一行</a:t>");
  expect(xml).toContain("<a:t>第二行</a:t>");
  // 只看被改的那个形状块，别把标题页其它段落算进来
  const body = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g)!.find(sp => sp.includes('name="t-body"'))!;
  const paragraphs = body.match(/<a:p>[\s\S]*?<\/a:p>/g) ?? [];
  expect(paragraphs.filter(paragraph => /<a:t>[^<]/.test(paragraph))).toHaveLength(2);
  const element = result.plan.slides[0]!.elements!.find(item => item.id === "t-body")!;
  expect(element.type === "text" && element.text).toBe("第一行\n第二行");
});

it("P10：文字里有 XML 特殊字符时正确转义，读回仍是原文", async () => {
  const bytes = await renderAiPresentation(plan);
  const value = "A < B & \"C\" > D";
  const result = await patchPresentationObjects(bytes, plan, [{ slide: 1, elementId: "t-body", text: value }]);
  const xml = await slideXml(result.bytes);
  expect(xml).toContain("&lt;");
  expect(xml).toContain("&amp;");
  expect(xml).toContain("&quot;");
  const parsed = new XMLParser({ ignoreAttributes: false, processEntities: true }).parse(xml) as Record<string, unknown>;
  expect(JSON.stringify(parsed)).toContain(value.replace(/"/g, "\\\""));
});

it("P11：形状没有文字，改文字要明确拒绝；文字没变化也不假装改过", async () => {
  const bytes = await renderAiPresentation(plan);
  const shape = await patchPresentationObjects(bytes, plan, [{ slide: 1, elementId: "s-bar", text: "不该生效" }]);
  expect(shape.report.rejected[0]!.reason).toContain("文字补丁只适用于文本框");

  const same = await patchPresentationObjects(bytes, plan, [{ slide: 1, elementId: "t-title", text: "标题" }]);
  expect(same.report.applied).toEqual([]);
  expect(same.report.rejected[0]!.reason).toContain("没有变化");
});

it("P12：doc_edit 改文字同样走原位补丁，读回的源方案文字已更新", async () => {
  const { db, conversationId, fileId, sha256 } = await source();
  const result = await executeChatDocumentTool(db, conversationId, "doc_edit", JSON.stringify({
    fileId, expectedSha256: sha256,
    objects: [{ slide: 1, elementId: "t-body", text: "改写后的正文\n第二段" }],
  }), undefined, "op-text");
  expect(result.ok).toBe(true);
  const { readWorkspaceFile } = await import("../src/server/chat-tools/documents");
  const project = (await readPresentationProject(readWorkspaceFile(db, conversationId, String(result.data!.fileId)).bytes))!;
  const element = project.plan.slides[0]!.elements!.find(item => item.id === "t-body")!;
  expect(element.type === "text" && element.text).toBe("改写后的正文\n第二段");
});

it("P13：文字改长后放不进文本框要给出警告，但不擅自缩字号", async () => {
  const bytes = await renderAiPresentation(plan);
  const long = "这是一段被刻意写得很长的正文，用来验证补丁之后的容量诊断是否生效。".repeat(12);
  const result = await patchPresentationObjects(bytes, plan, [{ slide: 1, elementId: "t-body", text: long }]);
  expect(result.report.applied).toHaveLength(1);
  expect(result.report.warnings).toHaveLength(1);
  const warning = result.report.warnings[0]!;
  expect(warning.elementId).toBe("t-body");
  expect(warning.detail).toContain("文字放不下");
  expect(warning.detail).toContain("建议改短");
  // 明确没有替用户缩字号：字号仍是原来的 18pt
  expect(await slideXml(result.bytes)).toContain('sz="1800"');
  // plan 里保留用户给的原文，不做静默截断
  const element = result.plan.slides[0]!.elements!.find(item => item.id === "t-body")!;
  expect(element.type === "text" && element.text).toBe(long);
});

it("P14：正常长度或不改文字时不产生警告", async () => {
  const bytes = await renderAiPresentation(plan);
  const short = await patchPresentationObjects(bytes, plan, [{ slide: 1, elementId: "t-body", text: "一句正常的正文" }]);
  expect(short.report.warnings).toEqual([]);
  const style = await patchPresentationObjects(bytes, plan, [{ slide: 1, elementId: "t-body", fontSize: 20 }]);
  expect(style.report.warnings).toEqual([]);
});

it("P15：doc_edit 把溢出写进摘要与报告问题列表", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "object-patch-warn-"));
  const db = new AppDatabase(dir);
  databases.push(db);
  const conversationId = db.createConversation({
    title: "溢出警告", brainChannelId: "mock-channel", brainModel: "mock",
    videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false,
  }).id;
  const bytes = await packPresentationProject(await renderAiPresentation(plan), plan, []);
  const source = saveWorkspaceDocument(db, conversationId, "溢出源文件", "pptx", bytes, "op-source", {
    draft: false, resume: false, fallbackPages: [], pendingPages: [], overflowPages: [],
    sourceLimitedPages: [], notesLimitedPages: [], unplacedImages: 0, planningFallback: false,
    audit: "unavailable", issues: [],
  });
  const long = "把正文写得很长很长，长到按当前字号一定放不进这个文本框。".repeat(15);
  const result = await executeChatDocumentTool(db, conversationId, "doc_edit", JSON.stringify({
    fileId: source.id, expectedSha256: createHash("sha256").update(bytes).digest("hex"),
    objects: [{ slide: 1, elementId: "t-body", text: long }],
  }), undefined, "op-warn");
  expect(result.ok).toBe(true);
  expect(result.summary).toContain("文字可能超出文本框");
  const report = db.getPresentationVersion(conversationId, String(result.data!.fileId))!.report;
  expect(report.issues.some(issue => issue.page === 1 && issue.detail.includes("文字放不下"))).toBe(true);
});

/** 1×1 PNG，足够作为真实媒体部件走通换图链路。 */
const PNG = "image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JPEG = `image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]).toString("base64")}`;

const imagePlan: AiPresentation = {
  title: "换图", theme: "blue",
  slides: [{
    layout: "content", title: "配图页", subtitle: "", lines: [], notes: "", sourceIds: [],
    elements: [
      { type: "text", id: "t-1", x: 0.8, y: 0.7, w: 5, h: 0.9, text: "配图页", style: { fontSize: 28 } },
      { type: "image", id: "img-1", imageIndex: 0, x: 6.4, y: 1.6, w: 5, h: 3.4, fit: "cover" },
    ],
  }],
};

const xmlOfPart = async (bytes: Buffer, name: string) => (await JSZip.loadAsync(bytes)).file(name)!.async("string");

it("Q01：换图新增媒体与关系、改 blip 指向，plan 的 imageIndex 指向新图", async () => {
  const bytes = await packPresentationProject(await renderAiPresentation(imagePlan, [{ title: "原图", data: PNG }]), imagePlan, [{ title: "原图", data: PNG }]);
  const result = await patchPresentationObjects(bytes, imagePlan, [{ slide: 1, elementId: "img-1", image: { data: PNG } }], [{ title: "原图", data: PNG }]);
  expect(result.report.rejected).toEqual([]);
  expect(result.report.applied[0]!.operations).toEqual(["image"]);
  expect(result.report.changedParts).toContain("ppt/slides/slide1.xml");
  expect(result.report.changedParts).toContain("ppt/slides/_rels/slide1.xml.rels");
  expect(result.report.changedParts.some(name => name.startsWith("ppt/media/patch-"))).toBe(true);
  // png 已经声明过，Content_Types 不该被动
  expect(result.report.changedParts).not.toContain("[Content_Types].xml");

  const block = (await xmlOfPart(result.bytes, "ppt/slides/slide1.xml")).match(/<p:pic>[\s\S]*?<\/p:pic>/)![0];
  const relId = /r:embed="(rId\d+)"/.exec(block)![1]!;
  const rels = await xmlOfPart(result.bytes, "ppt/slides/_rels/slide1.xml.rels");
  expect(rels).toContain(`Id="${relId}"`);
  expect(rels).toMatch(new RegExp(`Id="${relId}"[^>]*Target="\\.\\./media/patch-[0-9a-f]{12}\\.png"`));
  // 新图接在项目图片末尾
  const image = result.plan.slides[0]!.elements!.find(item => item.id === "img-1")!;
  expect(image.type === "image" && image.imageIndex).toBe(1);
  expect(result.images).toHaveLength(2);
});

it("Q02：换成本文件未声明过的格式时补 Content_Types，且不改已有声明", async () => {
  const packed = await packPresentationProject(await renderAiPresentation(imagePlan, [{ title: "原图", data: PNG }]), imagePlan, [{ title: "原图", data: PNG }]);
  // 故意去掉 jpeg 声明，模拟只有 png 的文件
  const stripped = await (async () => {
    const zip = await JSZip.loadAsync(packed);
    const ct = await zip.file("[Content_Types].xml")!.async("string");
    zip.file("[Content_Types].xml", ct.replace(/<Default Extension="jpe?g"[^>]*\/>/g, ""));
    return zip.generateAsync({ type: "nodebuffer" });
  })();
  const result = await patchPresentationObjects(stripped, imagePlan, [{ slide: 1, elementId: "img-1", image: { data: JPEG } }], [{ title: "原图", data: PNG }]);
  expect(result.report.rejected).toEqual([]);
  expect(result.report.changedParts).toContain("[Content_Types].xml");
  const ct = await xmlOfPart(result.bytes, "[Content_Types].xml");
  expect(ct).toMatch(/<Default Extension="jpeg" ContentType="image\/jpeg"\/>/);
  // 原有的 png 声明没被删改
  expect(ct).toMatch(/<Default Extension="png" ContentType="image\/png"\/>/);
});

it("Q03：非图片对象换图、非法图片数据都明确拒绝", async () => {
  const bytes = await packPresentationProject(await renderAiPresentation(imagePlan, [{ title: "原图", data: PNG }]), imagePlan, [{ title: "原图", data: PNG }]);
  const wrongType = await patchPresentationObjects(bytes, imagePlan, [{ slide: 1, elementId: "t-1", image: { data: PNG } }], []);
  expect(wrongType.report.rejected[0]!.reason).toContain("只有图片对象能换图");
  const badData = await patchPresentationObjects(bytes, imagePlan, [{ slide: 1, elementId: "img-1", image: { data: "not-an-image" } }], []);
  expect(badData.report.rejected[0]!.reason).toContain("data URL");
});

it("Q04：doc_edit 换图用会话素材 ID，素材不存在时明确报错", async () => {
  const { db, conversationId, fileId, sha256 } = await source();
  const missing = await executeChatDocumentTool(db, conversationId, "doc_edit", JSON.stringify({
    fileId, expectedSha256: sha256,
    objects: [{ slide: 1, elementId: "t-title", imageAssetId: "00000000-0000-4000-8000-000000000000" }],
  }), undefined, "op-image-missing");
  expect(missing.ok).toBe(false);
  expect(missing.summary).toContain("素材必须是本会话内的图片");
});
