// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { UpdateStatus } from "../src/client/UpdateStatus";
import { openExternal } from "../src/client/external";

vi.mock("../src/client/api", () => ({ isTauriRuntime: () => true }));
vi.mock("../src/client/external", () => ({ openExternal: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/client/updater", () => ({
  checkForUpdate: vi.fn().mockRejectedValue(new Error("网络不可用")),
  isPortableBuild: vi.fn().mockResolvedValue(false),
  downloadUpdate: vi.fn(), installUpdate: vi.fn(), prepareForUpdate: vi.fn(), relaunchApp: vi.fn(),
}));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.clearAllMocks(); });

it("检查失败时仍可从 Gitee 发布页手动下载", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(UpdateStatus)); });
  await act(async () => { container.querySelector<HTMLButtonElement>(".update-trigger")!.click(); });
  expect(container.textContent).toContain("网络不可用");
  const link = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("前往 Gitee 下载"));
  expect(link).toBeTruthy();
  await act(async () => { link!.click(); });
  expect(openExternal).toHaveBeenCalledWith("https://gitee.com/cqgsdx_0/chatcanvas-releases/releases");
  act(() => root.unmount());
  container.remove();
});
