import JSZip from "jszip";
import { expect, it } from "vitest";
import { renderAiPresentation, type AiPresentation } from "../src/server/mind-document";
import { checkPresentation, paginatePresentation } from "../src/server/presentation-check";

const plan: AiPresentation = { title: "主题", theme: "blue", slides: [{ layout: "process", title: "操作流程", subtitle: "", lines: ["长句".repeat(30), "另一个步骤"], notes: "来源原文：原始说明" }] };

it("长流程内容拆行分页并保留原文备注", async () => {
  const paginated = paginatePresentation(plan);
  expect(paginated.slides.flatMap((slide) => slide.lines).join("")).toBe(plan.slides[0]!.lines.join(""));
  expect(paginated.slides[0]!.notes).toContain("原始说明");
  expect(paginated.slides.flatMap((slide) => slide.lines).every((line) => Array.from(line).length <= 18)).toBe(true);
  await expect(checkPresentation(await renderAiPresentation(paginated), paginated)).resolves.toBeUndefined();
});

it("生成文件缺页时拒绝发布", async () => {
  const bytes = await renderAiPresentation(plan);
  const archive = await JSZip.loadAsync(bytes);
  archive.remove("ppt/slides/slide1.xml");
  await expect(checkPresentation(await archive.generateAsync({ type: "nodebuffer" }), plan)).rejects.toThrow(/页数/);
});

it("实际 PPTX 元素超出画布边界时拒绝发布", async () => {
  const bytes = await renderAiPresentation(plan);
  const archive = await JSZip.loadAsync(bytes);
  const slide = await archive.file("ppt/slides/slide1.xml")!.async("string");
  archive.file("ppt/slides/slide1.xml", slide.replace('<a:off x="731520"', '<a:off x="13000000"'));
  await expect(checkPresentation(await archive.generateAsync({ type: "nodebuffer" }), plan)).rejects.toThrow(/超出页面边界/);
});
