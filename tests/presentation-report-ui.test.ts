// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { PresentationFileReport } from "../src/client/chat/PresentationFileReport";
import type { TemplateReport } from "../src/shared/presentation-report";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("文件报告列出精简页，补做请求使用文件版本校验值", async () => {
  const report: TemplateReport = {
    draft: false, resume: false, fallbackPages: [3], pendingPages: [], overflowPages: [5],
    sourceLimitedPages: [], notesLimitedPages: [], unplacedImages: 0, planningFallback: false, audit: "unavailable", issues: [],
  };
  const sha256 = "a".repeat(64);
  const status = vi.spyOn(api, "presentationStatus").mockResolvedValue({ sha256, report, visual: { status: "unavailable", summary: "未检查 · WPS 未启动" } });
  const update = vi.spyOn(api, "updatePresentation").mockResolvedValue({ fileId: "revision" });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(PresentationFileReport, { conversationId: "chat", fileId: "original", initial: report, canUseModel: true })));
    expect(host.querySelector("summary")?.textContent).toContain("1 页精简");
    expect(host.querySelector("summary")?.textContent).toContain("未审校");
    const repair = [...host.querySelectorAll("button")].find(button => button.textContent === "补做第 3 页")!;
    await act(async () => { repair.click(); });
    expect(update).toHaveBeenCalledWith("chat", "original", { kind: "page", page: 3, sha256 });
    expect(host.textContent).toContain("部分文字移至备注 · 5");
    expect(host.textContent).toContain("未检查 · WPS 未启动");
  } finally {
    act(() => root.unmount());
    host.remove();
    status.mockRestore();
    update.mockRestore();
  }
});

it("契约门禁后的文件区分可用状态、视觉状态与正文可见覆盖", async () => {
  const report: TemplateReport = {
    draft: false, resume: false, fallbackPages: [], pendingPages: [], overflowPages: [],
    sourceLimitedPages: [], notesLimitedPages: [], unplacedImages: 0, planningFallback: false,
    audit: "complete", issues: [], readiness: "ready", contractValidation: "validation-1",
    visibleCoverage: { required: 3, satisfied: 3, unknown: 0 },
    usableReadyAt: "2026-11-07T06:00:00.000Z",
  };
  const status = vi.spyOn(api, "presentationStatus").mockResolvedValue({
    sha256: "b".repeat(64), report, visual: { status: "unavailable", summary: "未检查" },
  });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(React.createElement(PresentationFileReport, { conversationId: "chat", fileId: "original", initial: report, canUseModel: true })));
    expect(host.querySelector("summary")?.textContent).toContain("可用成品");
    expect(host.textContent).toContain("正文可见覆盖 · 3/3");
    expect(host.textContent).toContain("视觉检查 · 未完成");
    expect(host.textContent).toContain("首次可用");
  } finally {
    act(() => root.unmount());
    host.remove();
    status.mockRestore();
  }
});
