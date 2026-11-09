import JSZip from "jszip";
import { expect, it } from "vitest";
import { renderAiPresentation, type AiPresentation } from "../src/server/mind-document";
import { buildObjectMap, expectedObjectNames, resolveObjectBinding } from "../src/server/presentation-object-map";

/** M1：导出后对象映射。所有断言只看 OOXML，不看 pptxgenjs 内部数组。 */

const page = (title: string, elements: AiPresentation["slides"][number]["elements"]): AiPresentation["slides"][number] =>
  ({ layout: "content", title, subtitle: "", lines: [], notes: "", sourceIds: [], elements });

const plan: AiPresentation = {
  title: "对象映射", theme: "blue",
  slides: [
    page("复合对象页", [
      { type: "text", id: "t-title", x: 0.8, y: 0.7, w: 8, h: 0.9, text: "复合对象", style: { fontSize: 30 } },
      { type: "shape", id: "s-bar", shape: "roundRect", x: 0.8, y: 1.7, w: 2, h: 0.16, fill: "286D9C" },
      { type: "icon", id: "ic-target", icon: "target", x: 0.8, y: 2.4, w: 0.6, h: 0.6 },
      { type: "icon", id: "ic-check", icon: "check", x: 1.7, y: 2.4, w: 0.6, h: 0.6 },
      { type: "text", id: "t-a", x: 3, y: 3.4, w: 2, h: 0.5, text: "起点" },
      { type: "text", id: "t-b", x: 8.4, y: 3.4, w: 2, h: 0.5, text: "终点" },
      { type: "connector", id: "cn-1", from: "t-a", to: "t-b", label: "关联", arrow: true },
    ]),
    page("表格图表页", [
      { type: "table", id: "tb-1", x: 0.8, y: 1.6, w: 5.6, h: 2.2, rows: [["阶段", "结果"], ["选点", "3 个"], ["试点", "1 个"]], header: true },
      { type: "chart", id: "ch-1", x: 6.8, y: 1.6, w: 5.4, h: 2.6, chartType: "bar", categories: ["一季度", "二季度"], series: [{ name: "覆盖", values: [3, 5] }] },
    ]),
  ],
};

async function repack(bytes: Buffer, mutate: (zip: JSZip) => Promise<void> | void): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes);
  await mutate(zip);
  return zip.generateAsync({ type: "nodebuffer" });
}
const xmlOf = async (zip: JSZip, name: string) => zip.file(name)!.async("string");

it("O01：每个逻辑元素都能按名字定位，复合对象带齐子对象", async () => {
  const bytes = await renderAiPresentation(plan);
  const map = await buildObjectMap(bytes, plan);
  expect(map.issues).toEqual([]);
  expect(map.bindings).toHaveLength(9);

  const byId = (id: string) => map.bindings.find(binding => binding.logicalElementId === id)!;
  expect(byId("t-title").objects.map(object => object.role)).toEqual(["text"]);
  expect(byId("s-bar").objects.map(object => object.role)).toEqual(["shape"]);
  // 图标是复合对象：圆环 + 圆心必须都在，缺一个就不能原位改
  expect(byId("ic-target").objects.map(object => object.role).sort()).toEqual(["dot", "ring"]);
  expect(byId("ic-check").objects.map(object => object.role).sort()).toEqual(["stroke-0", "stroke-1"]);
  // 连线：至少一段 + 唯一标签
  const connector = byId("cn-1");
  expect(connector.objects.filter(object => object.role === "label")).toHaveLength(1);
  expect(connector.objects.filter(object => object.role.startsWith("segment-")).length).toBeGreaterThanOrEqual(1);
  // 页码归属正确
  expect(byId("tb-1").slide).toBe(2);
  expect(byId("tb-1").slidePart).toBe("ppt/slides/slide2.xml");
});

it("O02：定位成功返回唯一对象；不存在的 id 明确报缺失", async () => {
  const bytes = await renderAiPresentation(plan);
  const map = await buildObjectMap(bytes, plan);
  const binding = resolveObjectBinding(map, 1, "cn-1");
  expect(binding.logicalElementId).toBe("cn-1");
  expect(binding.objects.every(object => /^\d+$/.test(object.shapeId))).toBe(true);
  expect(() => resolveObjectBinding(map, 1, "不存在")).toThrow(/找不到/);
});

it("O03：同名对象出现两次时拒绝定位，不按相似度猜", async () => {
  const bytes = await renderAiPresentation(plan);
  // 把图标的圆心改名成标题的名字，制造同名
  const duplicated = await repack(bytes, async zip => {
    const xml = await xmlOf(zip, "ppt/slides/slide1.xml");
    zip.file("ppt/slides/slide1.xml", xml.replace(/name="ic-target-dot"/, 'name="t-title"'));
  });
  const map = await buildObjectMap(duplicated, plan);
  expect(map.issues.some(issue => issue.detail.includes("同名对象出现 2 次"))).toBe(true);
  expect(() => resolveObjectBinding(map, 1, "t-title")).toThrow(/同名对象/);
});

it("O04：复合对象少一个子形状时判为不完整，拒绝原位修改", async () => {
  const bytes = await renderAiPresentation(plan);
  const broken = await repack(bytes, async zip => {
    const xml = await xmlOf(zip, "ppt/slides/slide1.xml");
    zip.file("ppt/slides/slide1.xml", xml.replace(/name="ic-target-dot"/, 'name="stray-shape"'));
  });
  const map = await buildObjectMap(broken, plan);
  const issue = map.issues.find(item => item.objectName === "ic-target-dot")!;
  expect(issue.detail).toContain("缺少子对象");
  expect(() => resolveObjectBinding(map, 1, "ic-target")).toThrow(/缺少子对象/);
});

it("O05：文件被外部改过时，旧指纹的映射直接失效", async () => {
  const bytes = await renderAiPresentation(plan);
  await expect(buildObjectMap(bytes, plan, { expectedFingerprint: "0".repeat(64) })).rejects.toThrow(/外部修改/);
});

it("O06：页序以 presentation.xml 的 sldIdLst 为准，不靠 slideN 的数字顺序", async () => {
  const bytes = await renderAiPresentation(plan);
  // 交换两页的部件内容，同时交换 sldIdLst 顺序：结果应与原稿一致。
  // 只按 slideN 数字顺序读的实现会把计划第 1 页对到第 2 页的内容，全部报缺失。
  const reordered = await repack(bytes, async zip => {
    const first = await xmlOf(zip, "ppt/slides/slide1.xml");
    const second = await xmlOf(zip, "ppt/slides/slide2.xml");
    zip.file("ppt/slides/slide1.xml", second);
    zip.file("ppt/slides/slide2.xml", first);
    const xml = await xmlOf(zip, "ppt/presentation.xml");
    const ids = [...xml.matchAll(/<p:sldId\b[^>]*\/>/g)].map(match => match[0]);
    expect(ids).toHaveLength(2);
    zip.file("ppt/presentation.xml", xml.replace(ids.join(""), [ids[1]!, ids[0]!].join("")));
  });
  const map = await buildObjectMap(reordered, plan);
  expect(map.issues).toEqual([]);
  expect(map.bindings.find(binding => binding.slide === 1)!.slidePart).toBe("ppt/slides/slide2.xml");
  expect(map.bindings.find(binding => binding.logicalElementId === "tb-1")!.slide).toBe(2);
});

it("O07：子对象命名规则可单独核对（图表/图片/连线标签）", () => {
  expect(expectedObjectNames({ type: "text", id: "t", x: 0, y: 0, w: 1, h: 1, text: "x" } as never)).toEqual({ names: ["t"], exact: true });
  expect(expectedObjectNames({ id: "cn", type: "connector", from: "a", to: "b", label: "L" } as never)).toEqual({ names: ["cn-segment-"], exact: false });
  expect(expectedObjectNames({ id: "ic", type: "icon", icon: "trend", x: 0, y: 0, w: 1, h: 1 } as never).names)
    .toEqual(["ic-stroke-0", "ic-stroke-1", "ic-stroke-2"]);
});
