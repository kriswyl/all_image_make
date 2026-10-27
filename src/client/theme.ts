import { useSyncExternalStore } from "react";
import { isTauriRuntime } from "./api";

/**
 * 外观主题。
 *
 * 三档：跟随系统 / 浅色 / 深色。真正切换的是 `<html data-theme="dark">`，
 * 所有颜色都从 styles.css 的令牌走，组件不需要知道自己处在哪个主题里。
 *
 * 存储键故意和别的设置一样用 `yida.` 前缀；index.html 里有一段同名的内联脚本，
 * 在首屏 CSS 之前先把 data-theme 定好，避免深色用户每次启动都闪一下白底。
 */
export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "yida.theme";

/**
 * React 侧的主题订阅。
 *
 * 设置弹窗和标题栏按钮都要跟着「系统主题变化 / 另一处切换」一起更新，
 * 所以不在各自的组件里存一份 state，而是让 theme.ts 做唯一数据源。
 * 快照里带 revision，确保同一模式重复 apply 时 useSyncExternalStore 也能拿到新值。
 */
const themeListeners = new Set<() => void>();
let themeRevision = 0;

function emitThemeChange() {
  themeRevision += 1;
  for (const listener of themeListeners) listener();
}

function subscribeTheme(listener: () => void) {
  themeListeners.add(listener);
  return () => { themeListeners.delete(listener); };
}

function themeSnapshot() {
  const mode = readThemeMode();
  const resolved = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  return `${mode}|${resolved}|${themeRevision}`;
}

export function useTheme(): { mode: ThemeMode; resolved: ResolvedTheme } {
  const [mode, resolved] = useSyncExternalStore(subscribeTheme, themeSnapshot, themeSnapshot).split("|");
  return { mode: mode as ThemeMode, resolved: resolved as ResolvedTheme };
}

/** 存储里可能是旧版本、手改过的值，认不出来的都退回「跟随系统」 */
export function normalizeThemeMode(value: string | null | undefined): ThemeMode {
  return value === "light" || value === "dark" ? value : "system";
}

/** 纯函数：给定模式和系统偏好，算出最终要挂到页面上的主题 */
export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === "system") return systemPrefersDark ? "dark" : "light";
  return mode;
}

export function readThemeMode(): ThemeMode {
  try {
    return normalizeThemeMode(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** 地址栏 / 任务栏缩略图用的主题色，跟着页面底色走 */
function syncThemeColor(resolved: ResolvedTheme) {
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", resolved === "dark" ? "#111111" : "#f7f7f8");
}

/**
 * 把主题落到 DOM 上。
 *
 * `color-scheme` 不能省：原生滚动条、输入法候选框、日期选择器都靠它决定深浅；
 * 只改 CSS 变量的话，这些系统控件在深色主题里仍然是白底。
 *
 * 桌面版顺手把 Tauri 窗口的 theme 也切过去，原生对话框和系统菜单才会跟着变。
 * 「跟随系统」传 null，交还给 Windows 自己判断。
 */
let appliedWindowTheme: ThemeMode | null | undefined;

export function applyTheme(mode: ThemeMode) {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(mode, systemPrefersDark());
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  // theme-init.js 为了首帧防闪写了一条内联背景；主 CSS 到了就交还给令牌
  root.style.backgroundColor = "";
  syncThemeColor(resolved);
  emitThemeChange();

  if (isTauriRuntime()) {
    // 只在目标值真的变了才调 setTheme：setTheme(null) 可能反过来触发
    // prefers-color-scheme 变化，不加这个守卫，「跟随系统」会自己套自己。
    const target = mode === "system" ? null : mode;
    if (appliedWindowTheme !== target) {
      appliedWindowTheme = target;
      void import("@tauri-apps/api/window")
        .then(({ getCurrentWindow }) => getCurrentWindow().setTheme(target))
        .catch(() => undefined);
    }
  }
}

export function setThemeMode(mode: ThemeMode) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // 存不下只影响下次启动，当前这次切换仍然生效
  }
  applyTheme(mode);
}

type ThemeWindow = Window & { __chatCanvasThemeCleanup?: () => void };

/** 启动时调用一次：应用已保存的模式，并在「跟随系统」时监听系统主题变化 */
export function initTheme() {
  if (typeof window === "undefined") return;
  const themeWindow = window as ThemeWindow;
  // Vite 热更新会重新执行这个模块；先把上一次的监听摘掉，避免叠加
  themeWindow.__chatCanvasThemeCleanup?.();

  applyTheme(readThemeMode());

  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (readThemeMode() === "system") applyTheme("system");
  };
  query.addEventListener("change", onChange);
  themeWindow.__chatCanvasThemeCleanup = () => query.removeEventListener("change", onChange);
}
