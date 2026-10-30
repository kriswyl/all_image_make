// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AssistantBubble } from "../src/client/chat/MessageBubble";
import { api } from "../src/client/api";
import type { ChatMessage } from "../src/shared/agent-types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.restoreAllMocks());

it("代码块可复制，HTML 在隔离的 iframe 中按需运行", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
  vi.spyOn(api, "createHtmlPreview").mockResolvedValue({ id: "preview-id" });
  const html = "<!DOCTYPE html>\n<html><body>你好</body></html>";
  act(() => root.render(React.createElement(AssistantBubble, { message: { content: `\`\`\`html\n${html}\n\`\`\``, status: "ok" } as ChatMessage })));
  const buttons = [...container.querySelectorAll("button")];
  await act(async () => { buttons.find((button) => button.textContent?.includes("复制"))!.click(); });
  expect(copy).toHaveBeenCalledWith(html);
  expect(container.querySelector("iframe")).toBeNull();
  await act(async () => { buttons.find((button) => button.textContent?.includes("运行预览"))!.click(); });
  const frame = container.querySelector("iframe")!;
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
  expect(frame.getAttribute("src")).toContain("/api/html-previews/preview-id");
  act(() => root.unmount());
  container.remove();
});
