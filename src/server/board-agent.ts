/**
 * 无限画布 Agent 的读 / 批量写。
 *
 * - `describeBoard`：把文档压成一段可读文本，进系统提示词和 board_read；
 * - `applyBoardOps`：在文档副本上执行一批 op，校验通过后只保存一次；
 * - `previewBoardOps`：在确认卡上提前算出「会删掉什么」。
 *
 * 这里不调用生成；生成在 board.ts 的 generateBoardConfig。
 */
import crypto from "node:crypto";
import type { AppDatabase, BoardRecord } from "./db.js";
import { AppError } from "./tasks.js";
import {
  allocateNodeRef, BOARD_LIMITS, boardGroups, BoardValidationError, directUpstreamImages, directUpstreamText, parseBoardDoc,
  type BoardDoc, type BoardEdge, type BoardNode, type ConfigBoardNode,
} from "../shared/board.js";
import { arrangePositions } from "../shared/board-layout.js";
import type { BoardOp } from "../shared/board-ops.js";
import { VIDEO_MODE_LABELS } from "../shared/video-capabilities.js";
import { assertDocAssets } from "./board.js";

function atNow() {
  return new Date().toISOString();
}

function boardOrThrow(db: AppDatabase, boardId: string): BoardRecord {
  const board = db.getBoardRecord(boardId);
  if (!board) throw new AppError("BOARD_NOT_FOUND", "无限画布不存在", 404);
  return board;
}

function statusLabel(status: string): string {
  if (status === "succeeded") return "已生成";
  if (status === "loading") return "生成中";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已停止";
  if (status === "empty") return "未生成";
  return "空闲";
}

function previewText(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function nodeLine(node: BoardNode, doc: BoardDoc): string {
  const head = `- ${node.ref} ${node.type === "text" ? "文本" : node.type === "image" ? "图片" : node.type === "video" ? "视频" : node.type === "audio" ? "音频" : "配置"}`;
  const title = node.title && node.title !== node.ref ? `「${node.title}」` : "";
  if (node.type === "text") {
    return `${head}${title} @(${Math.round(node.x)},${Math.round(node.y)}) · ${previewText(node.text) || "（空文本）"}`;
  }
  if (node.type === "image" || node.type === "video" || node.type === "audio") {
    return `${head}${title} @(${Math.round(node.x)},${Math.round(node.y)}) · ${statusLabel(node.status)}${node.assetId ? "" : " · 无素材"}${node.prompt ? ` · 提示词：${previewText(node.prompt)}` : ""}${node.model ? ` · 模型：${node.model}` : ""}`;
  }
  const texts = directUpstreamText(doc, node.id).length;
  const images = directUpstreamImages(doc, node.id).length;
  const video = node.mode === "video"
    ? ` · ${node.videoMode ? VIDEO_MODE_LABELS[node.videoMode] : "视频方式自动"}${node.durationSeconds ? ` ${node.durationSeconds}s` : ""}${node.resolution ? ` ${node.resolution}` : ""}`
    : "";
  const modeLabel = node.mode === "video" ? "生视频" : node.mode === "text" ? "生文本" : node.mode === "audio" ? `生音频（${node.audioKind === "music" ? "音乐" : "配音"}）` : "生图";
  return `${head}${title} @(${Math.round(node.x)},${Math.round(node.y)}) · ${modeLabel}${video} · 上游 ${texts} 段文本 / ${images} 张图 · ${statusLabel(node.status)}`;
}

function edgeLabel(edge: BoardEdge): string {
  if (edge.kind === "result") return "结果";
  if (edge.role === "text") return "文本";
  if (edge.role === "first-frame") return "首帧";
  if (edge.role === "last-frame") return "尾帧";
  if (edge.role === "reference") return "参考";
  return "自动";
}

export interface DescribeBoardOptions {
  scope?: "selection" | "viewport" | "all";
  depth?: number;
  nodeRefs?: string[];
  limit?: number;
}

/** 系统提示词 / board_read 共用的一份紧凑描述 */
export function describeBoard(board: BoardRecord, options: DescribeBoardOptions = {}): string {
  const doc = board.doc;
  if (!doc.nodes.length) return "无限画布还是空的（0 个节点）。可以用 board_apply 添加文本 / 图片 / 配置节点。";
  const limit = Math.min(60, Math.max(1, options.limit ?? 40));
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));
  const byRef = new Map(doc.nodes.map((node) => [node.ref, node]));
  const selectedRefs = board.selection
    .map((id) => byId.get(id)?.ref)
    .filter((ref): ref is string => Boolean(ref));

  let roots: BoardNode[] = [];
  if (options.nodeRefs?.length) {
    roots = options.nodeRefs.map((ref) => byRef.get(ref)).filter((node): node is BoardNode => Boolean(node));
  } else if (options.scope !== "all") {
    const scope = options.scope ?? "selection";
    if (scope === "selection" && board.selection.length) {
      roots = board.selection.map((id) => byId.get(id)).filter((node): node is BoardNode => Boolean(node));
    } else {
      // 没有选中时退回视口附近：没有画布尺寸，按 1600×1000 的可视世界近似
      const scale = board.viewport.scale || 1;
      const left = -board.viewport.x / scale;
      const top = -board.viewport.y / scale;
      const right = left + 1600 / scale;
      const bottom = top + 1000 / scale;
      roots = doc.nodes.filter((node) => node.x < right && node.x + node.width > left
        && node.y < bottom && node.y + node.height > top);
    }
  }
  if (!roots.length) roots = doc.nodes;

  const included = new Set<string>(roots.map((node) => node.id));
  if ((options.depth ?? 1) > 0) {
    for (const edge of doc.edges) {
      if (included.has(edge.source) || included.has(edge.target)) {
        if (byId.has(edge.source)) included.add(edge.source);
        if (byId.has(edge.target)) included.add(edge.target);
      }
    }
  }

  const nodes = doc.nodes
    .filter((node) => included.has(node.id))
    .sort((left, right) => {
      const leftSelected = board.selection.includes(left.id) ? 0 : 1;
      const rightSelected = board.selection.includes(right.id) ? 0 : 1;
      if (leftSelected !== rightSelected) return leftSelected - rightSelected;
      if (left.y !== right.y) return left.y - right.y;
      return left.x - right.x;
    })
    .slice(0, limit);

  const shownIds = new Set(nodes.map((node) => node.id));
  const edges = doc.edges.filter((edge) => shownIds.has(edge.source) && shownIds.has(edge.target));
  const allGroups = boardGroups(doc);
  const header = [
    `无限画布：${doc.nodes.length} 个节点，${doc.edges.length} 条连线，${allGroups.length} 个分组；当前选中 ${selectedRefs.length ? selectedRefs.join("、") : "无"}；显示 ${nodes.length} 个节点。`,
  ];
  const lines = nodes.map((node) => nodeLine(node, doc));
  const edgeLines = edges.map((edge) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    return source && target ? `- ${source.ref} -> ${target.ref}（${edgeLabel(edge)}）` : null;
  }).filter((line): line is string => Boolean(line));
  const groupLines = allGroups
    .filter((group) => group.nodeIds.some((id) => shownIds.has(id)))
    .map((group) => {
      const refs = group.nodeIds.map((id) => byId.get(id)?.ref).filter(Boolean);
      return `- 分组「${group.title}」：${refs.join("、")}${group.collapsed ? "（已折叠）" : ""}`;
    });
  return [
    ...header,
    ...lines,
    ...(edgeLines.length ? ["连线：", ...edgeLines] : []),
    ...(groupLines.length ? ["分组：", ...groupLines] : []),
  ].join("\n");
}

export interface BoardOpsResult {
  board: BoardRecord;
  summary: string;
  data: {
    created: Array<{ tempId: string; id: string; ref: string; type: string }>;
    updated: string[];
    deleted: string[];
    connections: number;
  };
}

/** 在文档副本上执行一批 op；任意一条失败整批不落地 */
export function applyBoardOps(db: AppDatabase, boardId: string, ops: BoardOp[]): BoardOpsResult {
  const board = boardOrThrow(db, boardId);
  const doc: BoardDoc = structuredClone(board.doc);
  const at = atNow();
  const tempToRef = new Map<string, string>();
  const created: BoardOpsResult["data"]["created"] = [];
  const updated = new Set<string>();
  const deleted = new Set<string>();
  let connections = 0;
  let nextRef = doc.nextRef;
  const allowedAssets = new Set<string>();

  const byRef = () => new Map(doc.nodes.map((node) => [node.ref, node]));
  const resolve = (value: string): string => {
    if (tempToRef.has(value)) return tempToRef.get(value)!;
    if (!byRef().has(value)) throw new AppError("BOARD_OP_INVALID", `节点 ${value} 不存在`, 400);
    return value;
  };
  const nodeOf = (ref: string): BoardNode => {
    const node = byRef().get(ref);
    if (!node) throw new AppError("BOARD_OP_INVALID", `节点 ${ref} 不存在`, 400);
    return node;
  };

  for (const [index, op] of ops.entries()) {
    try {
      if (op.op === "add_node") {
        if (doc.nodes.length >= 200) throw new AppError("BOARD_NODE_LIMIT", "无限画布节点已达上限", 400);
        const allocated = allocateNodeRef({ nodes: doc.nodes, nextRef });
        nextRef = allocated.nextRef;
        if (tempToRef.has(op.tempId)) throw new AppError("BOARD_OP_INVALID", `tempId ${op.tempId} 重复`, 400);
        tempToRef.set(op.tempId, allocated.ref);
        const base = {
          id: `node-${crypto.randomUUID()}`,
          ref: allocated.ref,
          x: op.x,
          y: op.y,
          width: op.width ?? (op.type === "text" ? 300 : op.type === "config" ? 330 : 280),
          height: op.height ?? (op.type === "text" ? 170 : op.type === "config" ? 260 : 210),
          title: op.title?.slice(0, 80) ?? (op.type === "text" ? "文本" : op.type === "config" ? "配置节点" : op.type === "video" ? "视频" : op.type === "audio" ? "音频" : "图片"),
          createdAt: at,
          updatedAt: at,
        };
        let node: BoardNode;
        if (op.type === "text") {
          node = { ...base, type: "text", text: op.text ?? "" };
        } else if (op.type === "config") {
          node = {
            ...base, type: "config",
            mode: op.config?.mode ?? "image",
            prompt: op.config?.prompt ?? "",
            useUpstreamText: op.config?.useUpstreamText ?? true,
            count: op.config?.count ?? 1,
            status: "idle",
            ...(op.config ?? {}),
          } as ConfigBoardNode;
        } else {
          const media = {
            ...base,
            type: op.type,
            assetId: op.assetRef ?? null,
            source: op.assetRef && op.type === "image" ? "library" as const : "upload" as const,
            status: op.assetRef ? "succeeded" as const : "empty" as const,
            ...(op.text ? { prompt: op.text } : {}),
            ...(op.config ?? {}),
          };
          node = media as BoardNode;
        }
        doc.nodes.push(node);
        created.push({ tempId: op.tempId, id: node.id, ref: node.ref, type: node.type });
        continue;
      }

      if (op.op === "update_node") {
        const ref = resolve(op.nodeRef);
        const node = nodeOf(ref);
        const patch = op.patch;
        const next = {
          ...node,
          ...patch,
          id: node.id,
          ref: node.ref,
          type: node.type,
          updatedAt: at,
        } as BoardNode;
        doc.nodes = doc.nodes.map((item) => item.id === node.id ? next : item);
        updated.add(ref);
        continue;
      }

      if (op.op === "set_asset") {
        const ref = resolve(op.nodeRef);
        const node = nodeOf(ref);
        if (node.type !== "image" && node.type !== "video" && node.type !== "audio") throw new AppError("BOARD_OP_INVALID", `${ref} 不是素材节点`, 400);
        if (node.status === "loading") throw new AppError("BOARD_OP_INVALID", `${ref} 正在生成`, 409);
        const asset = db.getAsset(op.assetId);
        const task = asset && db.getTaskRow(asset.taskId);
        const linked = asset && db.findBoardAssetRefs(asset.id).some((entry) => entry.boardId === boardId);
        const isPublic = task?.libraryScope === "public" || (task?.libraryScope === "legacy" && db.listLibraryTaskViews().some((item) => item.id === task.id));
        if (!asset || (!linked && !isPublic)) throw new AppError("BOARD_ASSET_INVALID", "素材不存在或不属于公共素材库和当前画布", 403);
        if (!asset.mimeType.startsWith(`${node.type}/`)) throw new AppError("BOARD_ASSET_INVALID", "素材类型与节点不匹配", 400);
        allowedAssets.add(asset.id);
        doc.nodes = doc.nodes.map((item) => item.id === node.id ? { ...node, assetId: asset.id, source: node.type === "image" ? "library" : "upload", status: "succeeded", taskId: undefined, error: undefined, updatedAt: at } as BoardNode : item);
        updated.add(ref); continue;
      }

      if (op.op === "connect") {
        const fromRef = resolve(op.from);
        const toRef = resolve(op.to);
        const source = nodeOf(fromRef);
        const target = nodeOf(toRef);
        const kind = op.kind ?? "input";
        if (doc.edges.some((edge) => edge.source === source.id && edge.target === target.id && edge.kind === kind)) {
          throw new AppError("BOARD_OP_INVALID", `${fromRef} -> ${toRef} 已经有同类连线`, 400);
        }
        doc.edges.push({
          id: `edge-${crypto.randomUUID()}`,
          source: source.id,
          target: target.id,
          kind,
          ...(op.role ? { role: op.role } : {}),
        });
        connections += 1;
        continue;
      }

      if (op.op === "disconnect") {
        const fromRef = resolve(op.from);
        const toRef = resolve(op.to);
        const source = nodeOf(fromRef);
        const target = nodeOf(toRef);
        doc.edges = doc.edges.filter((edge) => {
          if (edge.source !== source.id || edge.target !== target.id) return true;
          return op.kind ? edge.kind !== op.kind : false;
        });
        continue;
      }

      if (op.op === "move_node") {
        const ref = resolve(op.nodeRef);
        const node = nodeOf(ref);
        doc.nodes = doc.nodes.map((item) => item.id === node.id
          ? { ...item, x: op.x, y: op.y, updatedAt: at }
          : item);
        updated.add(ref);
        continue;
      }

      if (op.op === "arrange") {
        // 同一批里可能既给 n3 又给 tempId，resolve 之后去重，避免同一个节点被排两次
        const refs = [...new Set(op.nodeRefs.map(resolve))];
        const nodes = refs.map(nodeOf);
        const positions = arrangePositions(nodes, {
          axis: op.axis,
          ...(op.columns ? { columns: op.columns } : {}),
          ...(op.gap == null ? {} : { gap: op.gap }),
          ...(op.origin ? { origin: op.origin } : {}),
        });
        const moved = new Map(nodes.map((node, index) => [node.id, positions[index]!]));
        doc.nodes = doc.nodes.map((item) => {
          const next = moved.get(item.id);
          return next ? { ...item, x: next.x, y: next.y, updatedAt: at } : item;
        });
        for (const ref of refs) updated.add(ref);

        if (op.group) {
          const title = op.group.trim();
          const ids = nodes.map((node) => node.id);
          const idSet = new Set(ids);
          const groups = boardGroups(doc);
          let target = groups.find((group) => group.title === title);
          if (!target) {
            if (groups.length >= BOARD_LIMITS.maxGroups) {
              throw new AppError("BOARD_GROUP_LIMIT", `画布最多 ${BOARD_LIMITS.maxGroups} 个分组`, 400);
            }
            target = { id: `group-${crypto.randomUUID()}`, title, nodeIds: [], collapsed: false };
            groups.push(target);
          }
          // 一个节点只能属于一个分组：先从别的组里摘掉，再并进目标组
          const merged = groups.map((group) => group === target
            ? group
            : { ...group, nodeIds: group.nodeIds.filter((nodeId) => !idSet.has(nodeId)) });
          target.nodeIds = [...new Set([...target.nodeIds, ...ids])];
          doc.groups = merged.filter((group) => group.nodeIds.length > 0);
        }
        continue;
      }

      if (op.op === "delete_node") {
        const ref = resolve(op.nodeRef);
        const node = nodeOf(ref);
        doc.nodes = doc.nodes.filter((item) => item.id !== node.id);
        doc.edges = doc.edges.filter((edge) => edge.source !== node.id && edge.target !== node.id);
        doc.groups = boardGroups(doc)
          .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((nodeId) => nodeId !== node.id) }))
          .filter((group) => group.nodeIds.length > 0);
        deleted.add(ref);
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw new AppError(error.code, `第 ${index + 1} 条 ${op.op} 失败：${error.message}`, error.status);
      }
      throw error;
    }
  }

  let parsed: BoardDoc;
  try {
    parsed = parseBoardDoc({ ...doc, nextRef });
  } catch (error) {
    if (error instanceof BoardValidationError) {
      throw new AppError("BOARD_OPS_INVALID", `这批操作会让无限画布不合法：${error.message}`, 400);
    }
    throw error;
  }
  assertDocAssets(db, boardId, parsed, [...allowedAssets]);

  const parts = [
    created.length ? `新增 ${created.map((item) => `${item.ref}（${item.type}，tempId=${item.tempId}）`).join("、")}` : "",
    updated.size ? `更新 ${[...updated].join("、")}` : "",
    deleted.size ? `删除 ${[...deleted].join("、")}` : "",
    connections ? `连线 ${connections} 条` : "",
  ].filter(Boolean);
  const summary = `成功：${parts.join("；") || "没有实际改动"}；共 ${ops.length} 条 op。`;

  db.saveBoardSnapshot({
    boardId,
    previousDoc: board.doc,
    doc: parsed,
    version: board.version + 1,
    reason: `agent: ${summary}`.slice(0, 200),
  });

  return {
    board: boardOrThrow(db, boardId),
    summary,
    data: { created, updated: [...updated], deleted: [...deleted], connections },
  };
}

export interface BoardOpsPreview {
  needsConfirm: boolean;
  deleteNodes: number;
  deleteWithAssets: number;
  summary: string;
  message: string;
}

export function previewBoardOps(db: AppDatabase, boardId: string, ops: BoardOp[]): BoardOpsPreview {
  const board = boardOrThrow(db, boardId);
  const byRef = new Map(board.doc.nodes.map((node) => [node.ref, node]));
  const deletes = ops.filter((op) => op.op === "delete_node");
  let deleteWithAssets = 0;
  for (const op of deletes) {
    if (op.op !== "delete_node") continue;
    const node = byRef.get(op.nodeRef);
    if (!node) continue;
    if ((node.type === "image" || node.type === "video" || node.type === "audio") && node.assetId) deleteWithAssets += 1;
    if (node.type === "config" && node.lastTaskId) deleteWithAssets += 1;
  }
  const deleteNodes = deletes.length;
  const virtualAssets = new Map(board.doc.nodes.flatMap((node) => node.type === "image" || node.type === "video" || node.type === "audio" ? [[node.ref, node.assetId] as const] : []));
  let replacements = 0;
  for (const op of ops) {
    if (op.op !== "set_asset" || !virtualAssets.has(op.nodeRef)) continue;
    const previous = virtualAssets.get(op.nodeRef);
    if (previous && previous !== op.assetId) replacements++;
    virtualAssets.set(op.nodeRef, op.assetId);
  }
  const needsConfirm = replacements > 0 || (deleteNodes > 0 && (deleteWithAssets > 0 || deleteNodes >= 3));
  return {
    needsConfirm,
    deleteNodes,
    deleteWithAssets,
    summary: [deleteNodes ? `删除 ${deleteNodes} 个节点（其中 ${deleteWithAssets} 个有生成结果）` : "", replacements ? `替换 ${replacements} 个节点素材` : ""].filter(Boolean).join("；") || "无删除",
    message: `这次将${[deleteNodes ? `删除 ${deleteNodes} 个节点` : "", replacements ? `替换 ${replacements} 个节点的素材` : ""].filter(Boolean).join("，")}。原素材文件不会被删除。确认执行吗？`,
  };
}
