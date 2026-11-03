import { expect, it } from "vitest";
import JSZip from "jszip";
import { aiPresentationSchema, renderAiPresentation, renderMindPptx, type AiPresentation } from "../src/server/mind-document";
import { checkPresentation, paginatePresentation, wrapPresentationLine } from "../src/server/presentation-check";
import { resolveElements, validateElements, layoutIssues, connectorRoute, type PresentationElement } from "../src/server/presentation-elements";
import { applyElementPatches, reviewRenderedPresentation } from "../src/server/presentation-visual-review";
import { packPresentationProject, readPresentationProject, readPresentationStyle } from "../src/server/presentation-project";

const image = { title: "参考", data: "image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aV8AAAAASUVORK5CYII=" };
const title: PresentationElement = { id: "title", type: "text", x: 0.7, y: 0.5, w: 12, h: 0.8, text: "页面主张", style: { fontSize: 28, bold: true } };
const body: PresentationElement = { id: "body", type: "text", x: 0.8, y: 1.7, w: 5, h: 2, text: "关键事实与条件", style: { fontSize: 20 } };
const plan = (elements: PresentationElement[]): AiPresentation => ({ title: "演示", theme: "blue", slides: [{ layout: "content", title: "页面主张", subtitle: "", lines: [], notes: "来源原文：事实", sourceIds: ["s1.1"], elements }] });

it("自由图文、数据卡、表格、可编辑图表和关联线均进入真实OOXML", async () => {
  const elements: PresentationElement[] = [title, body,
    { id: "picture", type: "image", x: 7, y: 1.6, w: 5, h: 3, imageIndex: 0 },
    { id: "card", type: "shape", shape: "roundRect", x: 7, y: 5, w: 5, h: 1.2, fill: "DDEAF2" },
    { id: "data", type: "text", x: 7.2, y: 5.2, w: 4.6, h: 0.8, text: "原始数据 42", style: { fontSize: 24 } },
    { id: "relation", type: "connector", from: "body", to: "picture", label: "相关", arrow: false },
  ];
  const deck = plan(elements);
  deck.slides.push({ layout: "content", title: "表格", subtitle: "", lines: [], notes: "", elements: [{ id: "table", type: "table", x: 0.8, y: 1, w: 11, h: 4, header: true, rows: [["项目", "第一季度", "第二季度", "备注"], ["甲", "12", "24", "原文"], ["乙", "20", "30", "条件"]] }] });
  deck.slides.push({ layout: "content", title: "数据", subtitle: "", lines: [], notes: "", elements: [{ id: "chart", type: "chart", x: 0.8, y: 1, w: 11, h: 5, chartType: "bar", categories: ["甲", "乙"], series: [{ name: "数量", values: [12, 24] }] }] });
  const bytes = await renderAiPresentation(deck, [image]); await checkPresentation(bytes, deck);
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
  expect(xml).toContain('name="body"'); expect(xml).toContain("<p:pic>"); expect(xml).toContain("相关");
  expect(await zip.file("ppt/slides/slide2.xml")!.async("string")).toContain("<a:tbl>");
  expect(Object.keys(zip.files).some((name) => /^ppt\/charts\/chart.*\.xml$/.test(name))).toBe(true);
  expect(Object.keys(zip.files).some((name) => name.endsWith(".xlsx"))).toBe(true);
  const project = await readPresentationProject(await packPresentationProject(bytes, deck, [image]));
  expect(project?.plan).toEqual(deck); expect(project?.images[0]?.data).toBe(image.data);
});

it("约束布局为三列卡片计算坐标，ID保持稳定，分页不丢元素页", async () => {
  const deck = plan([]); delete deck.slides[0]!.elements;
  deck.slides[0]!.box = { x: 0.8, y: 1.8, w: 11.7, h: 3, layout: { direction: "row", gap: 0.3, children: [1,2,3].map((n) => ({ flex: 1, element: { id: `card-${n}`, type: "text", x: 0, y: 0, w: 1, h: 1, text: `卡片${n}` } })) } };
  const resolved = resolveElements(deck.slides[0]!)!;
  resolved.forEach((item) => { if (item.type !== "connector") expect(item.w).toBeCloseTo(3.7); });
  expect(paginatePresentation(deck).slides[0]!.elements).toEqual(resolved);
  const bytes = await renderAiPresentation(deck); await checkPresentation(bytes, deck);
});

it("宽文本框相交但短标签实际文字不相交时，不错误阻止生成", () => {
  const label: PresentationElement = { id: "label", type: "text", x: 1, y: 2, w: 2.25, h: 0.65, text: "订单量", style: { fontSize: 20, valign: "middle" } };
  const value: PresentationElement = { id: "value", type: "text", x: 3.15, y: 2, w: 8.95, h: 0.65, text: "不能直接推断利润。", style: { fontSize: 20, valign: "middle" } };
  expect(layoutIssues([label, value])).toEqual([]);
});

it("跨越中间卡片的无方向关联线自动绕行，不穿过中间卡片正文", async () => {
  const cards: PresentationElement[] = [0,1,2].map((n) => ({ id: `node-${n}`, type: "shape", shape: "roundRect", x: 1 + n * 4, y: 2.5, w: 3, h: 1.6 }));
  const edge: PresentationElement = { id: "relation", type: "connector", from: "node-2", to: "node-0", arrow: false };
  const points = connectorRoute(cards, edge);
  expect(points).toHaveLength(4); expect(points[1]!.y).toBeGreaterThan(4.1);
  const deck = plan([...cards, edge]); await checkPresentation(await renderAiPresentation(deck), deck);
});

it("拒绝越界、重复ID、不存在图片、悬空连线、无效表格及图表数据", () => {
  for (const elements of [
    [title, { ...body, x: 13 }], [title, { ...body, id: "title" }],
    [{ id: "pic", type: "image", x: 0, y: 0, w: 1, h: 1, imageIndex: 1 }],
    [body, { id: "edge", type: "connector", from: "body", to: "missing" }],
    [{ id: "t", type: "table", x: 1, y: 1, w: 5, h: 3, rows: [["a", "b"], ["c"]] }],
    [{ id: "c", type: "chart", x: 1, y: 1, w: 5, h: 3, chartType: "bar", categories: ["a"], series: [{ name: "n", values: [1,2] }] }],
  ]) expect(() => validateElements(elements as PresentationElement[], 1)).toThrow();
  expect(() => resolveElements({ elements: [body], box: { x: 1, y: 1, w: 1, h: 1, layout: { direction: "row", children: [{ element: body }] } } })).toThrow(/不能同时/);
});

it("元素补丁只修改指定ID的样式和几何，非法补丁原子拒绝", () => {
  const changed = applyElementPatches([title, body], [{ op: "move", id: "body", dx: 0.2, dy: 0.1 }]);
  expect(changed[1]).toMatchObject({ x: 1, y: 1.8, text: "关键事实与条件" });
  expect(body).toMatchObject({ x: 0.8, y: 1.7 });
  for (const patches of [[{ op: "resize", id: "body", fontSize: 8 }], [{ op: "move", id: "body", dx: 20 }], [{ op: "style", id: "body", text: "偷换事实" }], [{ op: "move", id: "nope", dx: 0.1 }], [{ op: "move", id: "body", dx: 0.1 }, { op: "move", id: "body", dx: 0.1 }]]) expect(() => applyElementPatches([title, body], patches)).toThrow();
});

it("拥挤文字扩大文本框后实际重新序列化和复查，不删改正文", async () => {
  const dense: PresentationElement = { ...body, h: 0.15 };
  expect(layoutIssues([title, dense]).length).toBeGreaterThan(0);
  const renders: Buffer[] = []; let reviews = 0;
  const result = await reviewRenderedPresentation(plan([title, dense]), [], async (bytes) => { renders.push(bytes); return [Buffer.from(String(renders.length))]; }, async () => ({ content: JSON.stringify(++reviews === 1 ? { issues: ["文字高度不足"], patches: [{ op: "resize", id: "body", h: 1 }] } : { issues: [] }), truncated: false }));
  expect(renders).toHaveLength(2); expect(result.summary).toContain("全部 1 页");
  expect(result.plan.slides[0]!.elements?.[1]).toMatchObject({ h: 1, text: "关键事实与条件" });
  const first = await (await JSZip.loadAsync(renders[0]!)).file("ppt/slides/slide1.xml")!.async("string");
  const second = await (await JSZip.loadAsync(renders[1]!)).file("ppt/slides/slide1.xml")!.async("string");
  expect(first).not.toEqual(second); expect(result.plan.slides[0]!.sourceIds).toEqual(["s1.1"]);
});

it("最多两次修补且最后复查，仍然拥挤时报告具体页和元素", async () => {
  const result = await reviewRenderedPresentation(plan([title, { ...body, h: 0.1 }]), [], async () => [Buffer.from("png")], async () => ({ content: JSON.stringify({ issues: ["正文太挤"], patches: [{ op: "move", id: "body", dx: 0.1 }] }), truncated: false }));
  // Different geometry changes the cache fingerprint; persistent issues cannot pass as successful.
  expect(result.summary).toContain("仍有 1 页"); expect(result.summary).toContain("body");
});

it("参考主题读取颜色与字体，不把整套母版当作已导入", async () => {
  const bytes = await renderAiPresentation(plan([title, body])); const zip = await JSZip.loadAsync(bytes);
  const theme = await zip.file("ppt/theme/theme1.xml")!.async("string");
  zip.file("ppt/theme/theme1.xml", theme.replace(/(<a:accent1>\s*<a:srgbClr val=")[^"]+/, '$11F3A5F'));
  const style = await readPresentationStyle(await zip.generateAsync({ type: "nodebuffer" }));
  expect(style.design.accent).toBe("1F3A5F"); expect(style.warning).toContain("不复制原母版");
});

it("发现Office外部修改时拒绝用过期源方案重建，并保留生成文件品牌色参考", async () => {
  const deck = { ...plan([title, body]), design: { accent: "1F3A5F" } };
  const bytes = await packPresentationProject(await renderAiPresentation(deck), deck, []);
  expect((await readPresentationStyle(bytes)).design.accent).toBe("1F3A5F");
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
  zip.file("ppt/slides/slide1.xml", xml.replace("关键事实与条件", "用户手工修改"));
  await expect(readPresentationProject(await zip.generateAsync({ type: "nodebuffer" }))).rejects.toThrow(/已在外部修改/);
});

it("保留旧模板和旧七行计划的实际内容，标点优先折行", async () => {
  const old: AiPresentation = { title: "旧", theme: "ink", slides: [{ layout: "columns", title: "旧标题", subtitle: "", notes: "旧备注", lines: ["正文一", "正文二"] }] };
  await checkPresentation(await renderAiPresentation(old), old);
  const zip = await JSZip.loadAsync(await renderMindPptx([{ title: "旧标题", lines: ["一","二","三","四","五","六","七"], notes: "旧备注" }]));
  expect(await zip.file("ppt/slides/slide1.xml")!.async("string")).toContain("七");
  const text = "第一句先解释条件，然后说明操作步骤，最后保留注意事项。";
  const wrapped = wrapPresentationLine(text, 18); expect(wrapped.join("")).toBe(text); expect(wrapped[0]).toMatch(/，$/);
  expect(aiPresentationSchema.parse(old)).toEqual(old);
});

it("元素页不能把正文留在被忽略的lines中，浅色品牌背景不会抹掉旧封面文字", async () => {
  expect(() => resolveElements({ elements: [body], lines: ["不应被隐藏"] })).toThrow(/不能被隐藏/);
  const deck: AiPresentation = { title: "封面", theme: "blue", design: { background: "FFFFFF" }, slides: [{ layout: "cover", title: "封面", subtitle: "说明", lines: [], notes: "" }] };
  const zip = await JSZip.loadAsync(await renderAiPresentation(deck));
  const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
  expect(xml).toContain('<a:srgbClr val="142A43"'); expect(xml).toContain("封面");
});
