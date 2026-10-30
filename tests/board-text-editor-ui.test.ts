// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { BoardNodeView, type BoardNodeViewProps } from "../src/client/board/BoardNodeView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("文本节点提供明确的编辑入口并能保存编辑后的内容", () => {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const commit = vi.fn();
  const props = {
    node: { id: "n1", ref: "n1", type: "text", title: "文本", text: "原文本" }, asset: null,
    editing: false, upstream: { textCount: 0, imageCount: 0 },
    onSelect: vi.fn(), onStartEdit: vi.fn(), onCommitText: commit, onCancelEdit: vi.fn(),
    onUpdateNode: vi.fn(), onPreview: vi.fn(), onPickImage: vi.fn(), onRemoveAsset: vi.fn(), onDelete: vi.fn(), onGenerate: vi.fn(), onStopTask: vi.fn(), onRetryTask: vi.fn(),
  } as unknown as BoardNodeViewProps;
  act(() => root.render(React.createElement(BoardNodeView, props)));
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="编辑文本"]')!.click());
  expect(props.onSelect).toHaveBeenCalled();
  expect(props.onStartEdit).toHaveBeenCalled();
  act(() => root.render(React.createElement(BoardNodeView, { ...props, editing: true })));
  const editor = container.querySelector<HTMLTextAreaElement>(".board-text-editor")!;
  expect(document.activeElement).toBe(editor);
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "修改后的文本");
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  act(() => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })));
  expect(commit).toHaveBeenCalledWith("修改后的文本");
  act(() => root.unmount()); container.remove();
});
