// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Diagnostic, Task } from "../src/shared/types";
import { APP_VERSION } from "../src/shared/app-config";
import { DiagnosticDialog } from "../src/client/dialogs/DiagnosticDialog";
import { formatDiagnosticCopy } from "../src/client/dialogs/diagnostic-copy";

const { diagnostics, copy } = vi.hoisted(() => ({ diagnostics: vi.fn(), copy: vi.fn() }));
vi.mock("../src/client/api", () => ({ api: { diagnostics } }));
vi.mock("../src/client/clipboard", () => ({ copyTextToClipboard: copy }));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const startedAt = "2026-11-21T08:18:42.000Z";
const task: Task = {
  id: "b1995eb8-full-id", channelId: "channel-1", channelName: "词元流墟视频", model: "wan3.0-video",
  prompt: "私密提示词", status: "failed", progress: null, effectiveParameters: null, attemptCount: 1,
  errorCode: "REQUEST_NETWORK_ERROR", errorMessage: "私密失败信息", upstreamTaskId: "remote-task-xyz",
  assets: [], createdAt: startedAt, startedAt, finishedAt: "2026-11-21T08:23:45.000Z",
};
const entries: Diagnostic[] = [
  {
    id: "stage1", taskId: task.id, createdAt: startedAt, httpStatus: null, durationMs: 302892,
    request: { url: "https://relay.invalid/create", headers: { Authorization: "request-creds" }, body: { images: ["https://cdn.invalid/reference.png?sig=media-creds"] } },
    response: {
      request_id: "request-id-123", payload: "上游原文", credential: "response-creds",
      message: JSON.stringify({ prompt: task.prompt, api_key: "nested-creds", url: "https://cdn.invalid/output.png?token=source-creds", text: `提示词是${task.prompt}` }),
      data: "data:image/png;base64,AAAA",
    },
    trace: { phase: "upstream", outcome: "failed", startedAt, timeoutMs: 800000,
      error: { code: "REQUEST_NETWORK_ERROR", message: task.errorMessage!, causeCode: "UND_ERR_HEADERS_TIMEOUT" } },
  },
  {
    id: "stage2", taskId: task.id, createdAt: startedAt, httpStatus: 400, durationMs: 10,
    request: { method: "POST" }, response: { message: JSON.stringify({ request_id: "relay-error-xyz", error: { message: "真实响应" } }) },
  },
];

it("diagnostic summary copies actionable identifiers and timing with sensitive sections opt-in", async () => {
  diagnostics.mockResolvedValue(entries);
  copy.mockResolvedValue(undefined);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<DiagnosticDialog task={task} onClose={() => undefined} />); });
    const button = [...container.querySelectorAll("button")].find((item) => item.textContent === "复制诊断摘要")!;
    await act(async () => { button.click(); });
    const summary = copy.mock.calls[0]![0] as string;
    for (const fact of [APP_VERSION, task.id, task.channelName, task.model, "未收到 HTTP 响应", "HTTP 400", "302892 ms", "800 秒",
      "UND_ERR_HEADERS_TIMEOUT", "request-id-123", "relay-error-xyz", "remote-task-xyz"]) expect(summary).toContain(fact);
    expect(summary).not.toMatch(/私密|上游原文|cdn\.invalid|relay\.invalid|creds|AAAA/);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("已复制到剪贴板");

    const details = container.querySelector("details")!;
    await act(async () => {
      details.open = true;
      details.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
      button.click();
    });
    await act(async () => { button.click(); });
    expect(copy.mock.calls.at(-1)?.[0]).toContain(task.prompt);
    expect(copy.mock.calls.at(-1)?.[0]).not.toContain("上游原文");
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
  }
});

it("allows separate media and response opt-ins, keeping credentials out of both", () => {
  const response = formatDiagnosticCopy(task, entries, { prompt: false, mediaLinks: false, response: true });
  expect(response).toContain("上游原文");
  expect(response).not.toMatch(/私密|cdn\.invalid|creds|AAAA/);
  const everything = formatDiagnosticCopy(task, entries, { prompt: true, mediaLinks: true, response: true });
  expect(everything).toContain("https://cdn.invalid/reference.png");
  expect(everything).toContain("https://cdn.invalid/output.png");
  expect(everything).not.toMatch(/creds|AAAA|relay\.invalid/);
});
