import { describe, expect, it } from "vitest";
import { readPromptClause, readPromptClauses, replacePromptClause } from "../src/shared/prompt-clauses";

describe("提示词片段（单维度编辑）", () => {
  it("读出已有片段", () => {
    const text = "老陈在揉面，景别：中景，蒸汽升腾";
    expect(readPromptClause(text, "景别")).toBe("中景");
    expect(readPromptClauses(text)).toEqual({ 景别: "中景" });
  });

  it("改景别只动那一段", () => {
    const text = "老陈在揉面，景别：中景，蒸汽升腾";
    expect(replacePromptClause(text, "景别", "全景")).toBe("老陈在揉面，景别：全景，蒸汽升腾");
  });

  it("清空某个维度会把片段和分隔符一起去掉", () => {
    expect(replacePromptClause("老陈在揉面，景别：中景，蒸汽升腾", "景别", "")).toBe("老陈在揉面，蒸汽升腾");
    expect(replacePromptClause("景别：中景，蒸汽升腾", "景别", "")).toBe("蒸汽升腾");
  });

  it("没有这个片段时补在末尾，分隔符跟着正文走", () => {
    expect(replacePromptClause("老陈在揉面", "景别", "中景")).toBe("老陈在揉面，景别：中景");
    expect(replacePromptClause("人物向前走；雨声渐起", "运镜", "横摇")).toBe("人物向前走；雨声渐起；运镜：横摇");
  });

  it("全角冒号也认", () => {
    expect(readPromptClause("主体，景别：近景", "景别")).toBe("近景");
    expect(replacePromptClause("主体，景别：近景", "景别", "特写")).toBe("主体，景别：特写");
  });

  it("没有片段时不会误伤正文", () => {
    const text = "镜头慢慢推上去，女孩回头";
    expect(replacePromptClause(text, "运镜", "")).toBe(text);
    expect(readPromptClause(text, "运镜")).toBeUndefined();
  });
});
