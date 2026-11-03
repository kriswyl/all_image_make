export async function waitForWpsFiles(
  read: () => Promise<{ ready: number; total: number }>,
  signal: AbortSignal,
  onProgress: (ready: number, total: number) => void,
  pauseMs = 1000,
  maxAttempts = 90,
): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal.aborted) throw new Error("已关闭预览");
    const progress = await read();
    if (signal.aborted) throw new Error("已关闭预览");
    onProgress(progress.ready, progress.total);
    if (progress.total > 0 && progress.ready === progress.total) return;
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new Error("已关闭预览")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, pauseMs);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  throw new Error("等待 WPS 导出预览超时，请检查 WPS 是否有未处理的提示窗口");
}
