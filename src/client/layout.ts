/**
 * 窗口布局的纯计算部分。抽出来是为了能单测：
 * 系统缩放 / 用户把窗口拉窄时，侧栏不能继续吃掉主区宽度。
 */
export const SIDEBAR_MIN_WIDTH = 190;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 236;
/** 主区最小可用宽度：低于它就容易触发两栏塌陷与大片空白 */
export const MIN_WORKSPACE_WIDTH = 620;

/** 当前视口下侧栏允许的最大宽度 */
export function sidebarWidthLimit(viewportWidth: number): number {
  const safe = Number.isFinite(viewportWidth) ? viewportWidth : SIDEBAR_DEFAULT_WIDTH + MIN_WORKSPACE_WIDTH;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, safe - MIN_WORKSPACE_WIDTH));
}

/** 拖拽或读取 localStorage 后都过一遍，保证主区至少留 MIN_WORKSPACE_WIDTH */
export function clampSidebarWidth(viewportWidth: number, desired: number): number {
  const limit = sidebarWidthLimit(viewportWidth);
  const safeDesired = Number.isFinite(desired) ? desired : SIDEBAR_DEFAULT_WIDTH;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(limit, safeDesired));
}
