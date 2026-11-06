import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { executeChatDocumentTool, readWorkspaceFile } from "../src/server/chat-tools/documents";
import { markdownToMind, readDocxText } from "../src/server/chat-tools/markdown";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function temp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-docx-"));
  const { context } = createApp({ dataDir: dir });
  cleanups.push(async () => { context.db.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const conversation = context.db.createConversation({
    title: "文档", brainChannelId: "brain", brainModel: "mock", videoConfirmPolicy: "auto_only",
    visionEnabled: false, verbatimPrompt: false,
  });
  return { db: context.db, id: conversation.id };
}

const MARKDOWN = [
  "# 产品规划",
  "",
  "正文里有 **加粗** 和 `代码`。",
  "",
  "- 列表一",
  "- 列表二",
  "",
  "| 名称 | 数量 |",
  "| --- | --- |",
  "| A | 1 |",
].join("\n");

describe("Word 文档", () => {
  it("Markdown 生成 docx，再读回来还是那些结构", async () => {
    const { db, id } = await temp();
    const created = await executeChatDocumentTool(db, id, "doc_create", JSON.stringify({ kind: "docx", name: "方案", content: MARKDOWN }));
    expect(created.ok).toBe(true);
    const file = readWorkspaceFile(db, id, created.data!.fileId);
    expect(file.name.endsWith(".docx")).toBe(true);

    const text = await readDocxText(file.bytes);
    expect(text).toContain("# 产品规划");
    expect(text).toContain("正文里有");
    expect(text).toContain("加粗");
    expect(text).toContain("列表一");
    expect(text).toContain("| 名称 | 数量 |");
  });

  it("doc_read 能读 docx，并给出 sha256", async () => {
    const { db, id } = await temp();
    const created = await executeChatDocumentTool(db, id, "doc_create", JSON.stringify({ kind: "docx", name: "纪要", content: "# 会议纪要\n\n- 议题一" }));
    const read = await executeChatDocumentTool(db, id, "doc_read", JSON.stringify({ fileId: created.data!.fileId }));
    expect(read.ok).toBe(true);
    const payload = JSON.parse(read.summary);
    expect(payload.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(payload.lines.join("\n")).toContain("会议纪要");
  });

  it("doc_edit 拒绝用旧版本哈希修改 Word", async () => {
    const { db, id } = await temp();
    const created = await executeChatDocumentTool(db, id, "doc_create", JSON.stringify({ kind: "docx", name: "方案", content: "# 标题" }));
    const edited = await executeChatDocumentTool(db, id, "doc_edit", JSON.stringify({ fileId: created.data!.fileId, expectedSha256: "0".repeat(64), edits: [{ find: "标题", replace: "新标题" }] }));
    expect(edited.ok).toBe(false);
    expect(edited.summary).toContain("文件版本已变化");
  });
});

describe("Markdown 大纲转导图结构", () => {
  it("一级标题当根，二级当章节，列表挂到章节下", () => {
    const mind = markdownToMind("# 季度规划\n\n## 背景\n- 现状\n- 问题\n\n## 目标\n- 增长", "默认");
    const root = mind.sheets[0]!;
    expect(root.title).toBe("季度规划");
    expect(root.children.map((item) => item.title)).toEqual(["背景", "目标"]);
    expect(root.children[0]!.children.map((item) => item.title)).toEqual(["现状", "问题"]);
  });

  it("没有标题时按段落兜底，不会产出空导图", () => {
    const mind = markdownToMind("第一段内容\n\n第二段内容", "兜底");
    const root = mind.sheets[0]!;
    expect(root.children.length).toBeGreaterThan(0);
    expect(root.children[0]!.title.length).toBeGreaterThan(0);
  });
});

describe("Markdown 转 PPT", () => {
  it("doc_convert 接受 Markdown，走同一套 PPT 流水线", async () => {
    const { db, id } = await temp();
    const source = await executeChatDocumentTool(db, id, "doc_create", JSON.stringify({ kind: "md", name: "大纲", content: "# 产品规划\n\n## 背景\n- 现状\n\n## 目标\n- 增长" }));
    const converted = await executeChatDocumentTool(
      db, id, "doc_convert", JSON.stringify({ fileId: source.data!.fileId, to: "pptx" }),
      async (mind) => ({
        title: mind.sheets[0]!.title,
        theme: "ink" as const,
        slides: [
          { layout: "cover" as const, title: mind.sheets[0]!.title, subtitle: "", lines: [], notes: "" },
          { layout: "content" as const, title: "背景", subtitle: "", lines: ["现状"], notes: "" },
        ],
      }),
    );
    expect(converted.ok).toBe(true);
    expect(converted.data!.fileName.endsWith(".pptx")).toBe(true);
    expect(converted.summary).toContain("2 页");
  });
});

describe("渠道不支持工具时的标记", () => {
  it("置位后能读回来，用来跳过后续的工具定义", async () => {
    const { db, id } = await temp();
    expect(db.getConversation(id)!.toolsUnsupported).toBe(false);
    db.updateConversation(id, { toolsUnsupported: true });
    expect(db.getConversation(id)!.toolsUnsupported).toBe(true);
  });
});
