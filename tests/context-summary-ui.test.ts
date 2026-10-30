// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextSummaryControl } from "../src/client/chat/ContextSummaryControl";
import type { ConversationView } from "../src/shared/agent-types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(React.createElement(ContextSummaryControl, {
    view: { id: "chat", contextBudget: 350000, contextSummary: null } as ConversationView,
    onBudgetChange: vi.fn(), onCompress: vi.fn(),
  })));
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe("上下文设置浮层", () => {
  it("点外部会关闭，即使外部控件阻止事件冒泡", () => {
    const trigger = container.querySelector<HTMLButtonElement>(".context-summary-trigger")!;
    act(() => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".context-summary-panel")).not.toBeNull();
    const outside = document.createElement("button");
    outside.addEventListener("pointerdown", (event) => event.stopPropagation());
    document.body.appendChild(outside);
    act(() => outside.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".context-summary-panel")).toBeNull();
    outside.remove();
  });

  it("点面板内部保持打开，关闭按钮和 Esc 都能收起", () => {
    const trigger = container.querySelector<HTMLButtonElement>(".context-summary-trigger")!;
    act(() => trigger.click());
    const input = container.querySelector("input")!;
    act(() => input.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(container.querySelector(".context-summary-panel")).not.toBeNull();
    act(() => container.querySelector<HTMLButtonElement>(".context-summary-close")!.click());
    expect(container.querySelector(".context-summary-panel")).toBeNull();
    act(() => trigger.click());
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector(".context-summary-panel")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
