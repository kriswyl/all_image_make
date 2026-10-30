import { describe, expect, it } from "vitest";
import { storyboardProjectDataSchema } from "../src/shared/storyboard-project";
import { storyboardCsv } from "../src/client/chat/StoryboardPreview";

describe("分镜表导出", () => {
  it("保留镜头顺序和字段，转义逗号引号并防止表格公式执行", () => {
    const data = storyboardProjectDataSchema.parse({ name: "短剧", characters: [], scenes: [], shots: [
      { id: "a", prompt: '="危险",画面', dialogue: '他说"你好"', duration: 3 },
      { id: "b", prompt: "第二镜", duration: 5 },
    ] });
    const csv = storyboardCsv(data);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain(`"'=""危险"",画面"`);
    expect(csv).toContain(`"他说""你好"""`);
    expect(csv.indexOf("第二镜")).toBeGreaterThan(csv.indexOf("危险"));
  });
});
