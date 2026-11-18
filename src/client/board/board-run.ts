import { composeConfigPrompt, type AudioBoardNode, type BoardDoc, type BoardGeneratorNode, type ImageBoardNode, type VideoBoardNode } from "../../shared/board";

export type BoardRunStepState = "pending" | "submitting" | "waiting" | "choosing" | "succeeded" | "failed" | "blocked" | "unknown";
export interface BoardRunStep {
  nodeId: string;
  title: string;
  kind: "image" | "video" | "audio" | "text";
  model?: string;
  modelLabel?: string;
  channelId?: string;
  channelName?: string;
  requestCount: number;
  dependencies: string[];
  state: BoardRunStepState;
  resultIds?: string[];
  taskIds?: string[];
  detail?: string;
}

export interface BoardRun {
  boardId: string;
  steps: BoardRunStep[];
  createdAt: string;
  concurrency?: number;
}

export function planBoardRun(doc: BoardDoc, nodeIds: readonly string[], mode: "selection" | "downstream"): BoardRunStep[] {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const { source, target } of doc.edges) {
    outgoing.set(source, [...(outgoing.get(source) ?? []), target]);
    incoming.set(target, [...(incoming.get(target) ?? []), source]);
  }
  const selected = new Set(nodeIds);
  if (mode === "downstream") {
    for (const id of selected) for (const target of outgoing.get(id) ?? []) selected.add(target);
  }
  const results = new Set(doc.edges.filter(({ kind }) => kind === "result").map(({ target }) => target));
  const nodes = doc.nodes.filter((node): node is BoardGeneratorNode => selected.has(node.id)
    && node.type !== "text" && !results.has(node.id) && node.status !== "loading" && Boolean(composeConfigPrompt(doc, node).trim()));
  const runnable = new Set(nodes.map(({ id }) => id));
  return nodes.map((node) => {
    const upstream = new Set(incoming.get(node.id));
    const dependencies = new Set<string>();
    for (const id of upstream) {
      if (runnable.has(id)) dependencies.add(id);
      else if (results.has(id)) for (const source of incoming.get(id) ?? []) upstream.add(source);
    }
    const kind = node.type === "config" ? node.mode : node.type;
    return { nodeId: node.id, title: node.title || node.ref, kind, model: node.model,
      requestCount: kind === "image" && (node.type === "image" || node.type === "config") ? node.count ?? 1 : 1,
      dependencies: [...dependencies], state: "pending" };
  });
}

export function refreshBoardRun(run: BoardRun, doc: BoardDoc): BoardRun {
  const nodes = new Map(doc.nodes.map((node) => [node.id, node]));
  const failed = new Set<BoardRunStepState>(["failed", "blocked", "unknown"]);
  const byId = new Map(run.steps.map((step) => [step.nodeId, step]));
  const steps = run.steps.map((step): BoardRunStep => {
    if (step.state === "pending" && step.dependencies.some((id) => failed.has(byId.get(id)?.state ?? "pending"))) {
      return { ...step, state: "blocked", detail: "上游未完成" };
    }
    if (step.state !== "waiting") return step;
    const outputs = (step.resultIds ?? []).map((id) => nodes.get(id)).filter((node): node is ImageBoardNode | VideoBoardNode | AudioBoardNode => Boolean(node && node.type !== "text" && node.type !== "config"));
    if (outputs.some((node) => node.status === "loading" && node.taskId && step.taskIds?.includes(node.taskId))) return step;
    const usable = outputs.filter((node) => node.status === "succeeded" && node.assetId && node.taskId && step.taskIds?.includes(node.taskId));
    const needsChoice = step.kind === "image" && step.resultIds?.includes(step.nodeId) && usable.length > 0
      && (usable.length > 1 || usable[0]?.id !== step.nodeId)
      && run.steps.some((candidate) => candidate.dependencies.includes(step.nodeId));
    if (needsChoice) return { ...step, state: "choosing", detail: "在画布选择主图后确认" };
    if (usable.length > 0) return { ...step, state: "succeeded", detail: usable.length < (step.resultIds?.length ?? 0) ? `${usable.length} 份可用，其余结果失败或已移除` : undefined };
    return { ...step, state: "failed", detail: outputs.find((node) => node.error)?.error || "任务没有可用结果" };
  });
  return steps.some((step, i) => step !== run.steps[i]) ? { ...run, steps } : run;
}

export function nextBoardRunStep(run: BoardRun) {
  const complete = new Set(run.steps.filter(({ state }) => state === "succeeded").map(({ nodeId }) => nodeId));
  const active = new Map<string | undefined, number>();
  for (const { state, channelId } of run.steps) if (state === "waiting" || state === "submitting") active.set(channelId, (active.get(channelId) ?? 0) + 1);
  return run.steps.find((step) => step.state === "pending" && step.dependencies.every((id) => complete.has(id))
    && (active.get(step.channelId) ?? 0) < (run.concurrency ?? 2));
}
