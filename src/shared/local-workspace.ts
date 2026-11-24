export const WORKSPACE_MEDIA_DIRECTORY = "ChatCanvas 素材";

export interface LocalWorkspace {
  id: string;
  name: string;
  directory: string;
}

export interface WorkspaceSkillInfo {
  name: string;
  description: string;
}

export interface WorkspaceSkillDraft extends WorkspaceSkillInfo {
  id: string;
  instructions: string;
}

export interface WorkspaceImageReview {
  directory: string;
  focus?: string;
  items: Array<{ path: string; observation?: string; error?: string }>;
}
