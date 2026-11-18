import { allocateNodeRef, boardGroups, type BoardDoc, type BoardNode } from "../../shared/board";
import { boardMentionLabel } from "../../shared/board-mentions";

/** Reapply edits made while generation was reserving result nodes on the server. */
export function mergeBoardEdits(base: BoardDoc, local: BoardDoc, saved: BoardDoc): BoardDoc {
  const nodes = mergeItems(base.nodes, local.nodes, saved.nodes);
  const baseIds = new Set(base.nodes.map(({ id }) => id));
  const savedIds = new Set(saved.nodes.map(({ id }) => id));
  const usedRefs = new Set(nodes.filter(({ id }) => savedIds.has(id)).map(({ ref }) => ref));
  const renamed = new Map<string, [string, string]>();
  let nextRef = Math.max(local.nextRef, saved.nextRef);
  for (const [index, node] of nodes.entries()) {
    if (baseIds.has(node.id) || savedIds.has(node.id) || !usedRefs.has(node.ref)) continue;
    const allocated = allocateNodeRef({ nodes, nextRef });
    nextRef = allocated.nextRef;
    const updated = { ...node, ref: allocated.ref } as BoardNode;
    nodes[index] = updated;
    const before = boardMentionLabel(node);
    const after = boardMentionLabel(updated);
    if (before && after) renamed.set(node.id, [before, after]);
  }

  const nodeIds = new Set(nodes.map(({ id }) => id));
  const edges = mergeItems(base.edges, local.edges, saved.edges)
    .filter(({ source, target }) => nodeIds.has(source) && nodeIds.has(target));
  const groups = mergeItems(boardGroups(base), boardGroups(local), boardGroups(saved))
    .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => nodeIds.has(id)) }))
    .filter((group) => group.nodeIds.length);
  return {
    ...saved, nextRef, edges, groups,
    nodes: nodes.map((node) => {
      if (!("prompt" in node) || !node.prompt || !renamed.size) return node;
      const labels = new Map(edges.filter((edge) => edge.kind === "input" && edge.target === node.id)
        .flatMap((edge) => { const entry = renamed.get(edge.source); return entry ? [entry] : []; }));
      const prompt = node.prompt.replace(/@(图片|视频|音频)\d+/g, (token) => {
        const label = labels.get(token.slice(1));
        return label ? `@${label}` : token;
      });
      return { ...node, prompt };
    }),
  };
}

function mergeItems<T extends { id: string }>(base: T[], local: T[], saved: T[]): T[] {
  const baseById = new Map(base.map((item) => [item.id, item]));
  const localById = new Map(local.map((item) => [item.id, item]));
  const savedIds = new Set(saved.map(({ id }) => id));
  return [
    ...saved.flatMap((remote) => {
      const before = baseById.get(remote.id);
      if (!before) return [remote];
      const edited = localById.get(remote.id);
      if (!edited) return [];
      const changes = Object.keys({ ...before, ...edited }).flatMap((key) => {
        const field = key as keyof T;
        return JSON.stringify(before[field]) === JSON.stringify(edited[field]) ? [] : [[key, edited[field]] as const];
      });
      return changes.length ? [{ ...remote, ...Object.fromEntries(changes) }] : [remote];
    }),
    ...local.filter(({ id }) => !baseById.has(id) && !savedIds.has(id)),
  ];
}
