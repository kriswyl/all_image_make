/**
 * 生成一份「原位补丁后」的虚构 PPT，供 WPS 回归使用（不涉及任何用户文件）。
 *
 * 用途：M2 的验收要证明补丁后的文件仍能被 WPS 正常打开和导出。
 * 输出：artifacts/presentation-eval/object-patch.pptx
 */
import fs from "node:fs/promises";
import path from "node:path";
import { renderAiPresentation, type AiPresentation } from "../src/server/mind-document.js";
import { packPresentationProject } from "../src/server/presentation-project.js";
import { patchPresentationObjects } from "../src/server/presentation-object-patch.js";

const plan: AiPresentation = {
  title: "补丁后虚构验收", theme: "blue",
  slides: Array.from({ length: 3 }, (_, index) => ({
    layout: "content" as const, title: `虚构第 ${index + 1} 页`, subtitle: "", lines: [], notes: "", sourceIds: [],
    elements: [
      { type: "text" as const, id: "t-title", x: 0.8, y: 0.7, w: 9, h: 0.9, text: `虚构验收第 ${index + 1} 页`, style: { fontSize: 30, color: "243443" } },
      { type: "shape" as const, id: "s-bar", shape: "roundRect" as const, x: 0.8, y: 1.75, w: 2.4, h: 0.16, fill: "286D9C" },
      { type: "icon" as const, id: "ic-1", icon: "target" as const, x: 0.8, y: 2.3, w: 0.6, h: 0.6 },
      { type: "text" as const, id: "t-body", x: 1.8, y: 2.3, w: 10.4, h: 2.6, text: "仅用于验证本机排版与导出，不包含任何用户资料。", style: { fontSize: 18 } },
    ],
  })),
};

const bytes = await packPresentationProject(await renderAiPresentation(plan), plan, []);
const patched = await patchPresentationObjects(bytes, plan, [
  { slide: 1, elementId: "t-title", fontSize: 26, color: "B23B2E", rect: { x: 1, y: 0.8, w: 9.4, h: 1 } },
  { slide: 2, elementId: "s-bar", color: "2A716B", rect: { x: 1, y: 1.8, w: 3, h: 0.24 } },
  // 文字也要一起验：只改 <a:t>，字号颜色沿用
  { slide: 3, elementId: "t-body", text: "原位补丁改了这句话\n第二段也一起改" },
]);
if (patched.report.rejected.length) throw new Error(`补丁被拒：${JSON.stringify(patched.report.rejected)}`);

const dir = path.resolve("artifacts", "presentation-eval");
await fs.mkdir(dir, { recursive: true });
const output = path.join(dir, "object-patch.pptx");
await fs.writeFile(output, patched.bytes);
console.log(JSON.stringify({
  output,
  applied: patched.report.applied.length,
  changedParts: patched.report.changedParts,
  unchangedParts: patched.report.unchangedParts,
  pages: patched.plan.slides.length,
}, null, 2));
