import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, LoaderCircle } from "lucide-react";
import type { TaskStatus } from "../shared/types";

/**
 * 任务状态的展示基础件。
 *
 * 图片工作台和视频工作台之前各写了一份，音乐工作台原本会是第三份。
 * 从这里开始只留一份：加一个状态只改这里。
 */
export const terminalStatuses: TaskStatus[] = ["succeeded", "failed", "cancelled", "expired"];

export const statusLabels: Record<TaskStatus, string> = {
  queued: "排队中", validating: "校验中", submitting: "提交中", running: "生成中", succeeded: "已完成",
  failed: "失败", cancelled: "已取消", expired: "已超时",
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  return (
    <span className={`status-badge ${status}`}>
      {!terminalStatuses.includes(status) ? <LoaderCircle className="spin" size={13} />
        : status === "succeeded" ? <CheckCircle2 size={13} />
          : <AlertCircle size={13} />}
      {statusLabels[status]}
    </span>
  );
}

export function LoadingScreen({ compact = false }: { compact?: boolean }) {
  return <div className={compact ? "loading-compact" : "loading-screen"}><LoaderCircle className="spin" size={24} /><span>加载中</span></div>;
}

export function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value));
}

export function formatDuration(seconds: number) {
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

export function optionalNumber(value: string) {
  if (!value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function usePersistentState<T>(key: string, initialValue: T, prefix = "vector-image:generation-draft:") {
  const storageKey = `${prefix}${key}`;
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(storageKey);
      return stored === null ? initialValue : JSON.parse(stored) as T;
    } catch {
      return initialValue;
    }
  });
  useEffect(() => {
    try { window.localStorage.setItem(storageKey, JSON.stringify(value)); }
    catch { /* 存储不可用时表单依然可用 */ }
  }, [storageKey, value]);
  return [value, setValue] as const;
}
