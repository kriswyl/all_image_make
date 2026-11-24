import { createContext, useContext, type ReactNode } from "react";
import type { View } from "./app-shared";

const WorkspaceActivity = createContext(true);

export function useWorkspaceActive() {
  return useContext(WorkspaceActivity);
}

/** Hide inactive views without tearing down their drafts, scroll containers or task subscriptions. */
export function WorkspaceSurface({ view, active, children }: { view: View; active: boolean; children: ReactNode }) {
  return <WorkspaceActivity.Provider value={active}>
    <section className="workspace-surface" data-view={view} hidden={!active} inert={!active}>{children}</section>
  </WorkspaceActivity.Provider>;
}
