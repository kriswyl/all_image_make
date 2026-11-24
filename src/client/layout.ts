export const NAVIGATION_RAIL_WIDTH = 56;
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 300;
export const SIDEBAR_DEFAULT_WIDTH = 260;
export const MIN_WORKSPACE_WIDTH = 620;
export const SIDEBAR_OVERLAY_BREAKPOINT = NAVIGATION_RAIL_WIDTH + SIDEBAR_MIN_WIDTH + MIN_WORKSPACE_WIDTH + 22;

export function sidebarWidthLimit(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth < SIDEBAR_OVERLAY_BREAKPOINT) return SIDEBAR_MAX_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, viewportWidth - NAVIGATION_RAIL_WIDTH - MIN_WORKSPACE_WIDTH - 22));
}

export function clampSidebarWidth(viewportWidth: number, desired: number): number {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(sidebarWidthLimit(viewportWidth), Number.isFinite(desired) ? desired : SIDEBAR_DEFAULT_WIDTH));
}
