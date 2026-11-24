// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { createPortal } from "react-dom";
import { expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ chatMounts: 0, chatUnmounts: 0 }));
vi.mock("../src/client/api", () => ({
  isTauriRuntime: () => false,
  api: { bootstrap: vi.fn().mockResolvedValue({ channels: [], tasks: [], service: { assetsPath: "", defaultAssetsPath: "", dataPath: "" } }) },
}));
vi.mock("../src/client/views/GenerateView", () => ({ GenerateView: () => React.createElement("div", null, "生成工作区") }));
vi.mock("../src/client/ChatView", () => ({ ChatView: (props: { sidebarHost: HTMLElement | null }) => {
  const [draft, setDraft] = React.useState("");
  React.useEffect(() => { fixture.chatMounts++; return () => { fixture.chatUnmounts++; }; }, []);
  return React.createElement("div", { "data-chat-page": true },
    React.createElement("textarea", { value: draft, onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value) }),
    React.createElement("div", { "data-chat-scroll": true }, "运行中的会话"),
    props.sidebarHost ? createPortal(React.createElement("div", null, "真实会话组件的挂载点"), props.sidebarHost) : null);
} }));
vi.mock("../src/client/VideoGenerateView", () => ({ VideoGenerateView: () => React.createElement("div", null, "视频工作区") }));
vi.mock("../src/client/views/HistoryView", () => ({
  ClearHistoryDialog: () => null,
  HistoryView: (props: { navigation: { mode: string; kind: string } }) => React.createElement("output", { "data-library-mode": true }, `${props.navigation.mode}/${props.navigation.kind}`),
}));
vi.mock("../src/client/board/BoardWorkspace", () => ({ BoardWorkspace: (props: { sidebarHost: HTMLElement | null; onOpenMenu: () => void; onBoardSelected: () => void }) => React.createElement("div", null,
  React.createElement("button", { "data-sidebar-toggle": true, onClick: props.onOpenMenu }, "画布菜单"),
  props.sidebarHost ? createPortal(React.createElement("div", null,
    React.createElement("button", { onClick: props.onBoardSelected }, "选择画布")), props.sidebarHost) : null,
) }));
vi.mock("../src/client/hooks/usePolling", () => ({ usePublicTaskEvents: () => undefined, usePolling: () => undefined }));
vi.mock("../src/client/theme", () => ({ useTheme: () => ({ mode: "light", resolved: "light" }), setThemeMode: () => undefined }));
import { App } from "../src/client/App";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("画布从一级导航打开目录，临时模式可收起，固定后保持展开", async () => {
  window.localStorage.clear();
  window.localStorage.setItem("yida.welcome-dismissed", "1");
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const snapshotTransition = vi.fn();
  (document as Document & { startViewTransition?: unknown }).startViewTransition = snapshotTransition;
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(App)); await Promise.resolve(); });
  const button = (label: string) => [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label)!;
  await act(async () => { button("无限画布").click(); });
  const shell = container.querySelector(".app-shell")!;
  expect(shell.classList.contains("is-sidebar-hidden")).toBe(false);
  expect(snapshotTransition).not.toHaveBeenCalled();
  expect(shell.classList.contains("is-context-overlay")).toBe(true);
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
  expect(shell.classList.contains("is-context-overlay")).toBe(false);
  await act(async () => { button("选择画布").click(); });
  expect(shell.classList.contains("is-sidebar-hidden")).toBe(false);
  await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="取消固定侧边栏"]')!.click(); });
  expect(shell.classList.contains("is-context-overlay")).toBe(true);
  await act(async () => { button("对话").click(); });
  expect(container.querySelector('[data-chat-page="true"]')).not.toBeNull();
  expect(shell.classList.contains("is-sidebar-hidden")).toBe(false);
  act(() => root.unmount()); container.remove();
});

it("导航、折叠与窄窗口调整共用同一个聊天页面和侧栏挂载点", async () => {
  localStorage.clear();
  localStorage.setItem("yida.welcome-dismissed", "1");
  fixture.chatMounts = 0;
  fixture.chatUnmounts = 0;
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const initialWidth = window.innerWidth;
  const rail = (label: string) => container.querySelector<HTMLButtonElement>(`.navigation-rail button[aria-label="${label}"]`)!;
  const panel = () => container.querySelector<HTMLElement>("#context-sidebar")!;
  const item = (label: string) => Array.from(panel().querySelectorAll("button")).find(button => button.textContent?.trim() === label)!;
  try {
    await act(async () => root.render(React.createElement(App)));
    expect(rail("AI 创作").getAttribute("aria-current")).toBe("page");
    const shell = container.querySelector<HTMLElement>(".app-shell")!;
    expect(shell.classList.contains("is-sidebar-hidden")).toBe(true);
    await act(async () => rail("对话").click());
    const chat = container.querySelector<HTMLElement>('[data-view="chat"]')!;
    const draft = chat.querySelector<HTMLTextAreaElement>("textarea")!;
    const scroll = chat.querySelector<HTMLElement>("[data-chat-scroll]")!;
    const chatHost = panel().querySelector(".context-portal");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(draft, "正在写的对话草稿");
      draft.dispatchEvent(new Event("input", { bubbles: true }));
      scroll.scrollTop = 240;
      rail("AI 创作").click();
    });
    expect(chat.hidden).toBe(true);
    expect(shell.classList.contains("is-context-overlay")).toBe(true);
    expect(panel().hasAttribute("inert")).toBe(false);
    await act(async () => item("视频生成").click());
    expect(container.querySelector<HTMLElement>('[data-view="video"]')?.hidden).toBe(false);
    expect(panel().hasAttribute("inert")).toBe(true);
    await act(async () => rail("AI 创作").click());
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(panel().hasAttribute("inert")).toBe(true);
    await act(async () => rail("素材管理").click());
    await act(async () => { item("素材").click(); item("视频").click(); });
    expect(container.querySelector("output")?.textContent).toBe("assets/video");
    await act(async () => rail("AI 创作").click());
    expect(item("视频生成").getAttribute("aria-current")).toBe("page");
    await act(async () => rail("模型设置").click());
    expect([...panel().querySelectorAll(".context-links button")].map(button => button.textContent)).toEqual(["应用设置"]);
    expect(container.querySelector('[data-view="channels"] .page-header-actions')?.textContent).toContain("按模型快速配置");
    expect(container.querySelector('[data-view="channels"] .page-header-actions')?.textContent).toContain("添加渠道");
    await act(async () => rail("对话").click());
    expect(chat.hidden).toBe(false);
    expect(chat.querySelector("textarea")).toBe(draft);
    expect(draft.value).toBe("正在写的对话草稿");
    expect(scroll.scrollTop).toBe(240);
    expect(panel().querySelector(".context-portal")).toBe(chatHost);
    await act(async () => rail("收起侧边栏").click());
    expect(panel().hasAttribute("inert")).toBe(true);
    expect(chat.hidden).toBe(false);
    await act(async () => rail("展开侧边栏").click());
    const resizer = panel().querySelector('[role="separator"]')!;
    await act(async () => resizer.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(container.querySelector<HTMLElement>(".app-shell")!.style.getPropertyValue("--sidebar-width")).toBe("272px");
    await act(async () => {
      Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 768 });
      window.dispatchEvent(new Event("resize"));
    });
    await act(async () => rail("对话").click());
    expect(container.querySelector(".app-shell")!.classList.contains("is-context-overlay")).toBe(true);
    expect(panel().querySelector('[role="separator"]')).toBeNull();
    expect(chat.querySelector("textarea")).toBe(draft);
    expect(fixture.chatMounts).toBe(1);
    expect(fixture.chatUnmounts).toBe(0);
  } finally {
    act(() => root.unmount());
    container.remove();
    Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: initialWidth });
    localStorage.clear();
  }
});
