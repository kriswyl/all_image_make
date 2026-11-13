// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextSummaryControl } from "../src/client/chat/ContextSummaryControl";
import { Composer } from "../src/client/chat/Composer";
import type { ConversationView } from "../src/shared/agent-types";
import type { Asset } from "../src/shared/types";

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

  it("普通聊天显示工具和模型调用预算", () => {
    act(() => root.render(React.createElement(ContextSummaryControl, {
      view: { id: "chat", kind: "chat", chatMode: "chat", contextBudget: 350000, contextSummary: null } as ConversationView,
      onBudgetChange: vi.fn(), onChatLimitsChange: vi.fn(), onCompress: vi.fn(),
    })));
    act(() => container.querySelector<HTMLButtonElement>(".context-summary-trigger")!.click());
    expect(container.querySelector<HTMLInputElement>('[aria-label="工具调用轮数"]')?.value).toBe("16");
    expect(container.querySelector<HTMLInputElement>('[aria-label="模型调用上限"]')?.value).toBe("500");
    expect(container.querySelector<HTMLInputElement>('[aria-label="处理时间上限"]')?.value).toBe("30");
    expect(container.querySelector<HTMLInputElement>('[aria-label="本轮 token 上限"]')?.value).toBe("0");
  });

  it("统一助手在对话设置里关闭工具，旧会话有待确认时不能切换", () => {
    const onToolScopeChange = vi.fn();
    const render = (view: Partial<ConversationView>) => act(() => root.render(React.createElement(ContextSummaryControl, {
      view: { id: "chat", kind: "chat", ...view } as ConversationView,
      onBudgetChange: vi.fn(), onCompress: vi.fn(), onToolScopeChange,
    })));
    render({ toolScope: "all", status: "idle" });
    const trigger = container.querySelector<HTMLButtonElement>(".context-summary-trigger")!;
    expect(trigger.textContent).toBe("对话设置");
    act(() => trigger.click());
    act(() => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
    expect(onToolScopeChange).toHaveBeenCalledWith("conversation");
    render({ toolScope: null, status: "awaiting_confirmation" });
    const upgrade = () => [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "启用统一助手")!;
    expect(upgrade().disabled).toBe(true);
    render({ toolScope: null, status: "idle" });
    act(() => upgrade().click());
    expect(onToolScopeChange).toHaveBeenLastCalledWith("all");
  });

  it("在对话设置中单独修改看图偏好", () => {
    const onVisionChange = vi.fn();
    act(() => root.render(React.createElement(ContextSummaryControl, {
      view: { id: "chat", kind: "chat", toolScope: "all", visionEnabled: true } as ConversationView,
      onToolScopeChange: vi.fn(), onBudgetChange: vi.fn(), onCompress: vi.fn(), onVisionChange,
    })));
    act(() => container.querySelector<HTMLButtonElement>(".context-summary-trigger")!.click());
    const label = [...container.querySelectorAll("label")].find(item => item.textContent === "允许助手看图");
    const toggle = label!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(toggle.checked).toBe(true);
    act(() => toggle.click());
    expect(onVisionChange).toHaveBeenCalledWith(false);
  });

  it("仅在输入框有图片时显示看图提示", () => {
    const render = (attached: boolean) => act(() => root.render(React.createElement(Composer, {
      running: false, onSend: vi.fn(), onInterrupt: vi.fn(), imageVisionWarning: "当前模型不接受图片输入",
      plainAttachments: true,
      canvasItems: attached ? [{ asset: { id: "photo", fileName: "photo.png", mimeType: "image/png", url: "/photo.png" } as Asset, index: 0 }] : [],
    })));
    render(false);
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(picker, "files", { value: [new File(["abc"], "notes.txt", { type: "text/plain" })] });
    act(() => picker.dispatchEvent(new Event("change", { bubbles: true })));
    expect(container.textContent).toContain("notes.txt");
    expect(container.querySelector(".composer-image-warning")).toBeNull();
    render(true);
    expect(container.querySelector(".composer-image-warning")?.textContent).toBe("当前模型不接受图片输入");
  });

  it("选中音视频后可在没有文字时发送", () => {
    const onSend = vi.fn();
    act(() => root.render(React.createElement(Composer, {
      running: false, onSend, onInterrupt: vi.fn(),
    })));
    const picker = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const send = container.querySelector<HTMLButtonElement>('[aria-label="发送"]')!;
    expect(send.disabled).toBe(true);
    const files = [new File(["audio"], "旁白.m4a"), new File(["video"], "预览.mp4")];
    Object.defineProperty(picker, "files", { value: files });
    act(() => picker.dispatchEvent(new Event("change", { bubbles: true })));
    expect(container.textContent).toContain("旁白.m4a");
    expect(container.textContent).toContain("预览.mp4");
    expect(send.disabled).toBe(false);
    act(() => send.click());
    expect(onSend).toHaveBeenCalledWith("", files, []);
  });
});
