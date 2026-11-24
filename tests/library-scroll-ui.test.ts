// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { HistoryView } from "../src/client/views/HistoryView";
import { api } from "../src/client/api";
import type { Task } from "../src/shared/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("素材管理只在侧栏收起时显示页内分类与设置", async () => {
  const pages = vi.spyOn(api, "libraryPage").mockResolvedValue({ items: [], hasMore: false });
  const reveal = vi.spyOn(api, "revealMedia").mockResolvedValue({ opened: "fixture" });
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const props: React.ComponentProps<typeof HistoryView> = {
    channels: [], tasks: [], references: {} as never,
    onRefresh: vi.fn(), onDelete: vi.fn(), onDeleteSelected: vi.fn(), onClear: vi.fn(),
    onOpenAssetSettings: vi.fn(), onDiagnostics: vi.fn(), onImageTask: vi.fn(), onToast: vi.fn(),
  };
  const render = (controlsInSidebar: boolean) => act(async () => {
    root.render(React.createElement(HistoryView, { ...props, controlsInSidebar }));
  });
  const buttons = () => [...container.querySelectorAll("button")].map(button => button.textContent);
  try {
    await render(true);
    expect(container.querySelector(".filter-tabs")).toBeNull();
    expect(buttons()).toEqual(expect.arrayContaining(["清空记录", "清理失效"]));
    expect(buttons()).not.toContain("素材目录");
    expect(buttons()).not.toContain("设置");
    const search = container.querySelector('[aria-label="搜索素材和记录"]');
    expect(search).not.toBeNull();
    const more = container.querySelector<HTMLButtonElement>('[aria-label="更多素材操作"]')!;
    await act(async () => more.click());
    const openDirectory = container.querySelector<HTMLButtonElement>('[role="menuitem"]')!;
    expect(openDirectory.textContent).toBe("打开素材目录");
    await act(async () => openDirectory.click());
    expect(reveal).toHaveBeenCalledOnce();
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(more);

    await render(false);
    expect(container.querySelectorAll(".filter-tabs")).toHaveLength(2);
    expect(buttons()).toEqual(expect.arrayContaining(["素材", "生成记录", "图片", "设置"]));
    expect(container.querySelectorAll('[aria-label="更多素材操作"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="搜索素材和记录"]')).toBe(search);
    await act(async () => [...container.querySelectorAll("button")].find(button => button.textContent === "设置")!.click());
    expect(props.onOpenAssetSettings).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    container.remove();
    pages.mockRestore();
    reveal.mockRestore();
  }
});

it("删除素材后刷新已加载的所有分页，列表不会被清空", async () => {
  const tasks = Array.from({ length: 120 }, (_, index) => ({
    id: `task-${index}`, origin: "upload", prompt: `素材 ${index}`, model: "", channelName: "", status: "succeeded", createdAt: "2026-01-01T00:00:00Z",
    assets: [{ id: `asset-${index}`, title: `素材 ${index}`, fileName: `${index}.png`, mimeType: "image/png", url: `/asset/${index}`, createdAt: "2026-01-01T00:00:00Z" }],
  })) as Task[];
  let available = [...tasks];
  const pages = vi.spyOn(api, "libraryPage").mockImplementation(async ({ offset = 0 }) => ({ items: available.slice(offset, offset + 60), hasMore: offset + 60 < available.length }));
  vi.spyOn(api, "deleteLibraryAsset").mockImplementation(async (id) => { available = available.filter((task) => task.assets[0]?.id !== id); return { deleted: true }; });
  vi.spyOn(window, "confirm").mockReturnValue(true);
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  let currentTasks: Task[] = [];
  const render = () => root.render(React.createElement(HistoryView, {
    channels: [], tasks: currentTasks, references: {} as never,
    onRefresh: () => { currentTasks = [...currentTasks]; render(); },
    onDelete: vi.fn(), onDeleteSelected: vi.fn(), onClear: vi.fn(), onOpenAssetSettings: vi.fn(), onDiagnostics: vi.fn(), onImageTask: vi.fn(), onToast: vi.fn(),
  }));
  await act(async () => { render(); await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "素材")!.click(); await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(async () => { [...container.querySelectorAll("button")].find((button) => button.textContent === "加载更多")!.click(); });
  expect(container.querySelectorAll(".library-card-wrap")).toHaveLength(120);
  await act(async () => { (container.querySelectorAll<HTMLButtonElement>(".library-card-delete")[100]!).click(); });
  expect(container.querySelectorAll(".library-card-wrap")).toHaveLength(119);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(container.querySelectorAll(".library-card-wrap")).toHaveLength(119);
  expect(pages.mock.calls.some(([options]) => options.offset === 60)).toBe(true);
  act(() => root.unmount()); container.remove(); vi.restoreAllMocks();
});
