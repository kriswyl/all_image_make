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
