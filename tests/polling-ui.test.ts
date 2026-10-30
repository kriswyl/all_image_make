// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { usePolling } from "../src/client/hooks/usePolling";
import { api } from "../src/client/api";
import type { Task } from "../src/shared/types";

vi.mock("../src/client/api", () => ({ api: { task: vi.fn() } }));
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it("轮询无变化不更新状态，实际变化才更新且不让旧请求恢复已完成任务", async () => {
  vi.useFakeTimers();
  const pending = { id: "task-1", status: "running", progress: 20 } as Task;
  let current: Task[] = [];
  let setCurrent: React.Dispatch<React.SetStateAction<Task[]>> = () => undefined;
  function Harness() {
    const [tasks, setTasks] = useState<Task[]>([pending]);
    current = tasks; setCurrent = setTasks;
    usePolling(tasks[0] ?? null, setTasks);
    return null;
  }
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(React.createElement(Harness)));
  const initial = current;
  vi.mocked(api.task).mockResolvedValueOnce({ ...pending });
  await act(async () => { await vi.advanceTimersByTimeAsync(1800); });
  expect(current).toBe(initial);
  vi.mocked(api.task).mockResolvedValueOnce({ ...pending, progress: 45 });
  await act(async () => { await vi.advanceTimersByTimeAsync(1800); });
  expect(current).not.toBe(initial);
  expect(current[0]!.progress).toBe(45);
  let complete: (value: Task) => void = () => undefined;
  vi.mocked(api.task).mockReturnValueOnce(new Promise<Task>((resolve) => { complete = resolve; }));
  await act(async () => { await vi.advanceTimersByTimeAsync(1800); });
  act(() => setCurrent([{ ...pending, status: "succeeded", progress: 100 }]));
  await act(async () => { complete({ ...pending, progress: 50 }); await Promise.resolve(); });
  expect(current[0]!.status).toBe("succeeded");
  expect(current[0]!.progress).toBe(100);
  act(() => root.unmount()); container.remove();
});
