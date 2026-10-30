// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { HistoryView } from "../src/client/views/HistoryView";
import { api } from "../src/client/api";
import type { Task } from "../src/shared/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    onDelete: vi.fn(), onDeleteSelected: vi.fn(), onClear: vi.fn(), onOpenAssetSettings: vi.fn(), onDiagnostics: vi.fn(), onToast: vi.fn(),
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
