import { isTauriRuntime } from "./api";

/**
 * 对话完成时的桌面提示。
 *
 * 只在窗口失焦或最小化时触发：闪任务栏 + 换一个「1」的 overlay 图标，
 * 用户回到窗口后清掉。浏览器预览里没有这些能力，直接跳过。
 */
export async function notifyCompletion(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const [focused, minimized] = await Promise.all([win.isFocused(), win.isMinimized()]);
    if (focused && !minimized) return;
    await win.requestUserAttention(UserAttentionType.Critical);
    const response = await fetch("/attention-badge.png");
    if (response.ok) {
      await win.setOverlayIcon(new Uint8Array(await response.arrayBuffer()));
    }
  } catch {
    // 提示失败不影响对话本身
  }
}

/** 用户回到窗口 / 开始新操作时清掉任务栏角标 */
export async function clearCompletionBadge(): Promise<void> {
  if (!isTauriRuntime()) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setOverlayIcon(undefined);
  } catch {
    // 忽略
  }
}
