// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { expect, it, vi } from "vitest";

vi.mock("../src/client/api", () => ({
  isTauriRuntime: () => false,
  api: { bootstrap: vi.fn().mockResolvedValue({ channels: [], tasks: [], service: { assetsPath: "", defaultAssetsPath: "", dataPath: "" } }) },
}));
vi.mock("../src/client/views/GenerateView", () => ({ GenerateView: () => React.createElement("div", null, "生成工作区") }));
vi.mock("../src/client/ChatView", () => ({ ChatView: () => React.createElement("div", { "data-chat-page": true }, "对话页面") }));
vi.mock("../src/client/board/BoardWorkspace", () => ({ BoardWorkspace: (props: { sidebarHost: HTMLElement | null; onOpenMenu: () => void; onBoardSelected: () => void }) => React.createElement("div", null,
  React.createElement("button", { "data-sidebar-toggle": true, onClick: props.onOpenMenu }, "画布菜单"),
  props.sidebarHost ? createPortal(React.createElement("div", null,
    React.createElement("button", { onClick: props.onBoardSelected }, "选择画布")), props.sidebarHost) : null,
) }));
vi.mock("../src/client/hooks/usePolling", () => ({ useImageTaskEvents: () => undefined, usePolling: () => undefined }));
vi.mock("../src/client/theme", () => ({ useTheme: () => ({ mode: "light", resolved: "light" }), setThemeMode: () => undefined }));
import { App } from "../src/client/App";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("画布临时侧栏选画布自动收起，固定后保持展开，切换对话恢复原有侧栏偏好", async () => {
  window.localStorage.clear();
  window.localStorage.setItem("yida.welcome-dismissed", "1");
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const snapshotTransition = vi.fn();
  (document as Document & { startViewTransition?: unknown }).startViewTransition = snapshotTransition;
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(App)); await Promise.resolve(); });
  const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)!;
  await act(async () => { button("无限画布").click(); });
  const shell = container.querySelector(".app-shell")!;
  expect(shell.classList.contains("is-sidebar-hidden")).toBe(true);
  expect(snapshotTransition).not.toHaveBeenCalled();
  await act(async () => { button("画布菜单").click(); });
  expect(shell.classList.contains("is-board-sidebar-overlay")).toBe(true);
  await act(async () => { button("选择画布").click(); });
  expect(shell.classList.contains("is-sidebar-hidden")).toBe(true);
  await act(async () => { button("画布菜单").click(); });
  await act(async () => { container.querySelector(".workspace")!.dispatchEvent(new Event("pointerdown", { bubbles: true })); });
  expect(shell.classList.contains("is-sidebar-hidden")).toBe(true);
  await act(async () => { button("画布菜单").click(); });
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(shell.classList.contains("is-sidebar-hidden")).toBe(true);
  await act(async () => { button("画布菜单").click(); });
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="固定侧边栏"]')!.click(); });
  expect(shell.classList.contains("is-board-sidebar-overlay")).toBe(false);
  await act(async () => { button("选择画布").click(); });
  expect(shell.classList.contains("is-sidebar-hidden")).toBe(false);
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="取消固定侧边栏"]')!.click(); });
  expect(shell.classList.contains("is-board-sidebar-overlay")).toBe(true);
  await act(async () => { button("新建对话").click(); });
  expect(container.querySelector('[data-chat-page="true"]')).not.toBeNull();
  expect(shell.classList.contains("is-sidebar-hidden")).toBe(false);
  act(() => root.unmount()); container.remove();
});
