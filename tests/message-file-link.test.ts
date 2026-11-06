// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { AssistantBubble } from "../src/client/chat/MessageBubble";
import type { ChatMessage } from "../src/shared/agent-types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("助手正文里的会话文件 ID 链接会走下载，而不是当成相对地址打开", async () => {
  const files = vi.spyOn(api, "workspaceFiles").mockResolvedValue([{ id: "7dbfe86d-8f0c-4740-b396-c25e0dbc564a", name: "升级版.pptx", byteSize: 1, createdAt: "2026-11-05T08:40:50.000Z" }]);
  const download = vi.spyOn(api, "downloadWorkspaceFile").mockResolvedValue(true);
  const message = {
    id: "m1", conversationId: "chat-1", seq: 1, role: "assistant", status: "ok", content: "下载：[升级版](7dbfe86d-8f0c-4740-b396-c25e0dbc564a)",
    createdAt: "2026-11-05T08:40:50.000Z", documents: [], assetRefs: [], videoFrames: undefined, toolResult: null,
  } as unknown as ChatMessage;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(AssistantBubble, { message })));
    const link = host.querySelector("a.chat-file-link") as HTMLAnchorElement | null;
    expect(link?.textContent).toContain("升级版");
    await act(async () => { link?.click(); });
    expect(files).toHaveBeenCalledWith("chat-1");
    expect(download).toHaveBeenCalledWith("chat-1", "7dbfe86d-8f0c-4740-b396-c25e0dbc564a", "升级版.pptx");
  } finally {
    act(() => root.unmount());
    host.remove();
    files.mockRestore();
    download.mockRestore();
  }
});
