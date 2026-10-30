import { useEffect, useRef } from "react";
import { api } from "../api";
import type { Task } from "../../shared/types";
import { terminalStatuses } from "../task-ui";

/** 轮询未完成的任务，直到进入终态 */
export function usePolling(task: Task | null, setTasks: React.Dispatch<React.SetStateAction<Task[]>>) {
  useEffect(() => {
    if (!task || terminalStatuses.includes(task.status)) return;
    let disposed = false;
    let inFlight = false;
    const timer = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void api.task(task.id).then((updated) => {
        if (disposed) return;
        setTasks((current) => {
          const index = current.findIndex((item) => item.id === updated.id);
          if (index < 0 || JSON.stringify(current[index]) === JSON.stringify(updated)) return current;
          // 较慢的旧请求不能把已完成的任务覆盖成进行中。
          if (terminalStatuses.includes(current[index]!.status) && !terminalStatuses.includes(updated.status)) return current;
          const next = current.slice();
          next[index] = updated;
          return next;
        });
      }).catch(() => undefined).finally(() => { inFlight = false; });
    }, 1800);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [task?.id, task?.status, setTasks]);
}

/** 订阅公共任务事件；重连和新任务加入时补查，断线时低频兜底。 */
export function useImageTaskEvents(tasks: Task[], setTasks: React.Dispatch<React.SetStateAction<Task[]>>) {
  const pendingIds = tasks.filter((task) => !terminalStatuses.includes(task.status)).map((task) => task.id).sort().join(",");
  const pendingRef = useRef(pendingIds);
  pendingRef.current = pendingIds;
  const revisions = useRef(new Map<string, number>());
  const syncRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let disposed = false;
    let connected = false;
    const applyTask = (updated: Task) => {
      setTasks((current) => {
        const index = current.findIndex((item) => item.id === updated.id);
        if (index < 0 || JSON.stringify(current[index]) === JSON.stringify(updated)) return current;
        const next = current.slice();
        next[index] = updated;
        return next;
      });
    };
    const sync = () => {
      for (const id of pendingRef.current ? pendingRef.current.split(",") : []) {
        const revision = revisions.current.get(id) ?? 0;
        void api.task(id).then((task) => {
          if (!disposed && (revisions.current.get(id) ?? 0) === revision) {
            revisions.current.set(id, revision + 1);
            applyTask(task);
          }
        }).catch(() => undefined);
      }
    };
    syncRef.current = sync;
    const close = api.openTaskStream({
      onTask: (task) => {
        if (!pendingRef.current.split(",").includes(task.id)) return;
        revisions.current.set(task.id, (revisions.current.get(task.id) ?? 0) + 1);
        applyTask(task);
      },
      onOpen: () => { connected = true; sync(); },
      onError: () => { connected = false; },
    });
    const fallback = window.setInterval(() => { if (!connected) sync(); }, 10000);
    return () => { disposed = true; syncRef.current = () => undefined; window.clearInterval(fallback); close(); };
  }, [setTasks]);

  // 创建响应和 SSE 事件可能交错：新任务进入列表时补查一次。
  useEffect(() => { if (pendingIds) syncRef.current(); }, [pendingIds]);
}
