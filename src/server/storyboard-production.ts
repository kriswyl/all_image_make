import crypto from "node:crypto";
import { allocateNodeRef, directInputLinks, parseBoardDoc, type BoardDoc, type BoardNode } from "../shared/board.js";
import { boardMentionLabel } from "../shared/board-mentions.js";
import type { StoryboardMediaRole, StoryboardProduction, StoryboardProject, StoryboardProjectData } from "../shared/storyboard-project.js";
import type { AppDatabase, BoardRecord } from "./db.js";
import { AppError } from "./app-error.js";
import { assertDocAssets } from "./board.js";
import { requireBoard } from "./board-core.js";
import { resolveStoryboardSelection } from "./storyboard-selection.js";

type Shot = StoryboardProjectData["shots"][number];
type MediaNode = Extract<BoardNode, { type: StoryboardMediaRole }>;

function isShotMedia(node: BoardNode, projectId: string, shotId: string): node is MediaNode {
  return node.type !== "text" && node.type !== "config" && node.storyboard?.projectId === projectId
    && node.storyboard.shotId === shotId && node.storyboard.role === node.type;
}

export function storyboardShotAsset(db: AppDatabase, nodes: BoardNode[], projectId: string, shot: Shot, role: StoryboardMediaRole) {
  const pinned = shot.delivery?.[role];
  const latest = pinned ? undefined : [...nodes].reverse().find((node): node is MediaNode => Boolean(isShotMedia(node, projectId, shot.id) && node.type === role && node.assetId));
  const assetId = pinned?.assetId ?? latest?.assetId;
  const asset = assetId ? db.getAsset(assetId) : null;
  return asset?.mimeType.startsWith(`${role}/`) ? asset : null;
}

function shotReferences(doc: BoardDoc, project: StoryboardProject, shotId: string) {
  const { characters, scenes, props } = resolveStoryboardSelection(project.data, new Set([shotId]));
  const expected = new Map([
    ...characters.map(({ name, assetId }) => [`角色 · ${name}`.slice(0, 80), assetId] as const),
    ...scenes.map(({ name, assetId }) => [`场景 · ${name}`.slice(0, 80), assetId] as const),
    ...props.map(({ name, assetId }) => [`道具 · ${name}`.slice(0, 80), assetId] as const),
  ]);
  return doc.nodes.flatMap((target) => {
    if (!isShotMedia(target, project.id, shotId) || target.type !== "image") return [];
    return directInputLinks(doc, target.id).flatMap(({ node, edge }) => {
      if (node.type !== "image" || node.storyboard || !expected.has(node.title) || edge.role !== "reference") return [];
      const assetId = expected.get(node.title) ?? null;
      return [{ edge, node, target, assetId, outdated: Boolean(assetId && assetId !== node.assetId) }];
    });
  });
}

export function getStoryboardProduction(db: AppDatabase, project: StoryboardProject, board: BoardRecord): StoryboardProduction {
  const boards = db.listBoardRecords().filter((item) => item.doc.nodes.some((node) => node.storyboard?.projectId === project.id));
  return {
    id: project.id, name: project.data.name, revision: project.revision,
    boards: boards.map(({ id, title }) => ({ id, title })),
    shots: project.data.shots.map((shot) => {
      let references: StoryboardProduction["shots"][number]["references"] = [];
      try {
        references = shotReferences(board.doc, project, shot.id).map(({ node, assetId, outdated }) => ({ title: node.title, nodeId: node.id, expected: Boolean(assetId), outdated }));
      } catch (error) { if (!(error instanceof AppError) || error.code !== "STORYBOARD_VARIANT_MISSING") throw error; }
      return { id: shot.id, scene: shot.scene, title: shot.prompt, duration: shot.duration, references, delivery: shot.delivery,
        nodes: board.doc.nodes.filter((node): node is MediaNode => isShotMedia(node, project.id, shot.id)).map((node) => ({
          id: node.id, title: node.title || node.ref, role: node.type, assetId: node.assetId, status: node.status,
          pinned: Boolean(node.assetId && shot.delivery?.[node.type]?.assetId === node.assetId),
        })) };
    }),
  };
}

export function pinStoryboardDelivery(db: AppDatabase, project: StoryboardProject, input: { shotId: string; role: StoryboardMediaRole; boardId: string; nodeId: string | null }) {
  const shot = project.data.shots.find((item) => item.id === input.shotId);
  if (!shot) throw new AppError("STORYBOARD_SHOT_NOT_FOUND", "镜头不存在", 404);
  let delivery = { ...shot.delivery };
  if (input.nodeId) {
    const board = requireBoard(db, input.boardId);
    const node = board.doc.nodes.find(({ id }) => id === input.nodeId);
    if (!node || !isShotMedia(node, project.id, shot.id) || node.type !== input.role || !node.assetId || node.status !== "succeeded"
      || !db.getAsset(node.assetId)?.mimeType.startsWith(`${input.role}/`)) {
      throw new AppError("STORYBOARD_DELIVERY_INVALID", "这个节点没有属于当前镜头的可交付素材", 400);
    }
    delivery = { ...delivery, [input.role]: { assetId: node.assetId, nodeId: node.id, boardId: board.id } };
  } else delete delivery[input.role];
  const saved = db.updateStoryboardProject(project.id, project.revision, {
    ...project.data, shots: project.data.shots.map((item) => item.id === shot.id ? { ...item, delivery } : item),
  });
  if (!saved) throw new AppError("STORYBOARD_CONFLICT", "分镜已更改，请刷新后重试", 409);
  return saved;
}

export function syncStoryboardReferences(db: AppDatabase, project: StoryboardProject, board: BoardRecord, shotIds: string[]) {
  const updates = [...new Map(shotIds.flatMap((id) => shotReferences(board.doc, project, id))
    .filter((item) => item.outdated && item.assetId).map((item) => [item.edge.id, item])).values()];
  if (!updates.length) return 0;
  const at = new Date().toISOString();
  const added = new Map<string, MediaNode>();
  const replacements = new Map<string, string>();
  const prompts = new Map<string, Map<string, string>>();
  let nextRef = board.doc.nextRef;
  for (const { edge, node, assetId, target } of updates) {
    const key = `${node.id}:${assetId}`;
    let replacement = added.get(key);
    if (!replacement) {
      const allocation = allocateNodeRef({ nodes: [...board.doc.nodes, ...added.values()], nextRef });
      nextRef = allocation.nextRef;
      replacement = { ...node, id: `node-${crypto.randomUUID()}`, ref: allocation.ref, assetId,
        x: node.x, y: node.y - node.height - 28, taskId: undefined, status: "succeeded", source: "library",
        imageResultGroup: undefined, naturalWidth: undefined, naturalHeight: undefined, resultIndex: undefined,
        createdAt: at, updatedAt: at };
      added.set(key, replacement);
    }
    replacements.set(edge.id, replacement.id);
    const labels = prompts.get(target.id) ?? new Map<string, string>();
    labels.set(boardMentionLabel(node)!, boardMentionLabel(replacement)!);
    prompts.set(target.id, labels);
  }
  const doc = parseBoardDoc({ ...board.doc, nextRef, nodes: [...board.doc.nodes.map((node) => {
    const labels = prompts.get(node.id);
    if (!("prompt" in node) || !labels || !node.prompt) return node;
    return { ...node, prompt: node.prompt.replace(/@图片\d+/g, (token) => labels.has(token.slice(1)) ? `@${labels.get(token.slice(1))}` : token) };
  }), ...added.values()], edges: board.doc.edges.map((edge) => replacements.has(edge.id) ? { ...edge, source: replacements.get(edge.id)! } : edge) });
  assertDocAssets(db, board.id, doc, [...added.values()].flatMap((node) => node.assetId ? [node.assetId] : []));
  db.saveBoardSnapshot({ boardId: board.id, previousDoc: board.doc, doc, version: board.version + 1, reason: "storyboard:references" });
  return replacements.size;
}
