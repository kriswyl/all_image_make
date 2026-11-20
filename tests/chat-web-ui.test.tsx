// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { ToolCard } from "../src/client/chat/ToolCard";
import type { ChatMessage } from "../src/shared/agent-types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("联网工具卡显示进度，展开后可以打开实际来源并查看切换原因", () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const message: ChatMessage = {
    id: "search", conversationId: "chat", seq: 1, role: "assistant", status: "pending",
    toolName: "web_search", toolArgs: { query: "模型参考图限制" }, content: "正在搜索网页 · Firecrawl Keyless",
    assetRefs: [], documents: [], createdAt: "2026-11-20T00:00:00Z",
    plan: null, toolResult: null, confirm: null, taskId: null, assetId: null, errorMessage: null,
  };
  try {
    act(() => root.render(<ToolCard message={message} result={null} />));
    expect(host.textContent).toContain("正在搜索网页 · Firecrawl Keyless");
    const result: ChatMessage = { ...message, id: "result", seq: 2, role: "tool", status: "ok",
      content: "找到 1 条搜索结果，尚未读取原文",
      toolResult: { ok: true, summary: "找到 1 条搜索结果，尚未读取原文", data: { web: {
        provider: "tavily", attempts: [{ provider: "firecrawl", error: "HTTP 429" }],
        sources: [{ url: "https://docs.example.com/video", title: "模型文档", snippet: "参考图参数" }],
      } } },
    };
    act(() => root.render(<ToolCard message={{ ...message, content: "", status: "ok" }} result={result} />));
    act(() => host.querySelector<HTMLButtonElement>(".tool-pill")!.click());
    expect(host.textContent).toContain("联网服务 · Tavily");
    expect(host.textContent).toContain("Firecrawl Keyless · HTTP 429");
    expect(host.textContent).toContain("尚未读取原文");
    const citation = host.querySelector(".tool-card-web-sources a");
    expect(citation?.getAttribute("href")).toBe("https://docs.example.com/video");
    expect(citation?.textContent).toBe("模型文档");
  } finally {
    act(() => root.unmount());
  }
});
