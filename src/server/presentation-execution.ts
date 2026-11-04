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
  operationId: string;
  args: string;
  request: string;
  channelFingerprint: string;
  sourceFingerprint?: string;
  calls: number;
  tokens: number;
  usageMissing: boolean;
}
