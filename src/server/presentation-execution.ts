import type { BrainToolCall } from "./brain.js";

export class PresentationPaused extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** Deduplicate only equivalent submissions. Conflicting results need a fresh response. */
export function readPresentationSubmission(calls: BrainToolCall[]): string | undefined {
  if (!calls.length) return undefined;
  if (calls.some(call => call.name !== "submit_presentation_result")) return undefined;
  const first = calls[0]!.arguments;
  return calls.every(call => call.arguments.trim() === first.trim()) ? first : undefined;
}

export interface PresentationResume {
  engine?: "legacy" | "template";
  operationId: string;
  args: string;
  request: string;
  currentRequest?: string;
  targetPages?: number;
  channelFingerprint: string;
  sourceFingerprint?: string;
  calls: number;
  tokens: number;
  usageMissing: boolean;
}

/** Old checkpoints without an engine were produced by legacy. New tasks default to templates. */
export function presentationEngine(resume?: Pick<PresentationResume,"engine"> | null, configured = process.env.CHATCANVAS_PPT_ENGINE): "template" | "legacy" {
  return resume ? resume.engine ?? "legacy" : configured === "legacy" ? "legacy" : "template";
}
