import { isTauriRuntime } from "./api";

/** 用系统浏览器打开外链：Tauri webview 会拦 window.open，桌面版走 shell 插件 */
export async function openExternal(url: string) {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
