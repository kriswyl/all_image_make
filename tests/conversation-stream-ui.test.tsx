// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { useConversationStream } from "../src/client/chat/useConversationStream";
import type { ConversationStatus, ConversationView } from "../src/shared/agent-types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => vi.restoreAllMocks());

it("切换会话后忽略旧流的正文、完成事件和重连回调", () => {
  const streams = new Map<string, Parameters<typeof api.openConversationStream>[1]>();
  const closed = vi.fn();
  vi.spyOn(api, "openConversationStream").mockImplementation((id, handlers) => {
    streams.set(id, handlers);
    return () => closed(id);
  });
  const reloadView = vi.fn(async (_id: string) => undefined);
  const reloadList = vi.fn(async () => undefined);
  const toast = vi.fn();
  let current!: { draft: string; status: ConversationStatus };
  function Harness({ activeId }: { activeId: string }) {
    const activeIdRef = useRef(activeId);
    activeIdRef.current = activeId;
    const [, setView] = useState<ConversationView | null>(null);
    const [status, setStatus] = useState<ConversationStatus>("idle");
    const { draft } = useConversationStream({ activeId, activeIdRef, setView, setStatus, reloadView, reloadList, toast });
    current = { draft, status };
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    act(() => root.render(<Harness activeId="a" />));
    const old = streams.get("a")!;
    act(() => old.onEvent({ type: "text_token", text: "旧正文" }));
    expect(current.draft).toBe("旧正文");
    act(() => root.render(<Harness activeId="b" />));
    expect(closed).toHaveBeenCalledWith("a");
    const next = streams.get("b")!;
    act(() => {
      next.onEvent({ type: "status", status: "running" });
      next.onEvent({ type: "text_token", text: "新正文" });
      old.onEvent({ type: "text_token", text: "迟到正文" });
      old.onEvent({ type: "done", status: "idle" });
      old.onOpen?.();
    });
    expect(current).toEqual({ draft: "新正文", status: "running" });
    expect(reloadView.mock.calls).toEqual([["a"], ["b"]]);
    expect(reloadList).not.toHaveBeenCalled();
    act(() => next.onEvent({ type: "done", status: "idle" }));
    expect(current).toEqual({ draft: "", status: "idle" });
    expect(reloadView).toHaveBeenLastCalledWith("b");
    expect(reloadList).toHaveBeenCalledTimes(1);
  } finally { act(() => root.unmount()); }
});
