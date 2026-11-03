// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { WpsPreview } from "../src/client/chat/WpsPreview";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("WPS 预览等待响应时仍可关闭，也能通过 Esc 退出", async () => {
  const pending = vi.spyOn(api, "wpsPreviewStatus").mockReturnValue(new Promise(() => {}));
  const host = document.createElement("div"); document.body.appendChild(host);
  const root = createRoot(host); const close = vi.fn();
  try {
    act(() => root.render(React.createElement(WpsPreview, { conversationId: "chat", fileId: "file", name: "test.pptx", onClose: close })));
    const start = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("开始预览"))!;
    await act(async () => { start.click(); });
    const button = document.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!;
    expect(button.disabled).toBe(false);
    act(() => button.click()); expect(close).toHaveBeenCalledTimes(1);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(close).toHaveBeenCalledTimes(2);
  } finally { act(() => root.unmount()); host.remove(); pending.mockRestore(); }
});
