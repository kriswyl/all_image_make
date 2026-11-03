import { expect, it } from "vitest";
import { describeMindImages } from "../src/server/mind-image-vision";
import type { MindDocument, MindImage } from "../src/server/mind-document";

it("图片观察绑定来源节点，失败时保留之前的结果", async () => {
  const mind: MindDocument = { format: "xmind", warnings: [], sheets: [{ title: "根", notes: "", children: [{ title: "同名", notes: "", children: [] }, { title: "同名", notes: "", children: [] }] }] };
  const images: MindImage[] = [1, 2].map((n) => ({ sourceId: `s1-${n}`, title: "同名", data: "image/png;base64,AA==" }));
  let calls = 0; const reports: string[] = [];
  await describeMindImages(mind, images, async (messages) => {
    calls++;
    expect(JSON.stringify(messages)).toContain("data:image/png;base64,AA==");
    if (calls === 2) throw new Error("不支持视觉");
    return { content: "可见流程图", truncated: false };
  }, (message) => reports.push(message));
  expect(mind.sheets[0]!.children[0]!.imageDescription).toBe("可见流程图");
  expect(mind.sheets[0]!.children[1]!.imageDescription).toBeUndefined();
  expect(reports.join(" ")).toContain("保留原图");
});
