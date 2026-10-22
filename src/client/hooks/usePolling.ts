import { useEffect } from "react";
import { api } from "../api";
import type { Task } from "../../shared/types";
import { terminalStatuses } from "../task-ui";

/** 轮询未完成的任务，直到进入终态 */
export function usePolling(task: Task | null, setTasks: React.Dispatch<React.SetStateAction<Task[]>>) {
  useEffect(() => {
    if (!task || terminalStatuses.includes(task.status)) return;
    const timer = window.setInterval(() => {
      void api.task(task.id).then((updated) => {
        setTasks((current) => [updated, ...current.filter((item) => item.id !== updated.id)]);
      }).catch(() => undefined);
    }, 1800);
    return () => window.clearInterval(timer);
  }, [task?.id, task?.status, setTasks]);
}
