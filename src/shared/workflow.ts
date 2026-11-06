export type WorkflowStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
export interface WorkflowRun {
  id: string; conversationId: string; capability: string; version: number; inputFingerprint: string;
  status: WorkflowStatus; reason: string | null; calls: number; tokens: number; usageMissing: boolean;
  artifactId: string | null; createdAt: string; updatedAt: string;
}
export interface WorkflowStep {
  id: string; status: "completed"; attempts: number; artifactHash: string; updatedAt: string;
}
