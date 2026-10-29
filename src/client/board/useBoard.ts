/**
 * 无限画布的前端状态：文档、视口、选中、防抖保存、撤销重做。
 *
 * 服务端是版本的唯一真相；这里只做乐观更新。保存冲突不重放本地改动——
 * Agent 或另一个窗口可能已经改过同一块板，硬盖上去会丢东西。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "../api";
import {
  allocateNodeRef, applyBoardDeltaToDoc, boardGroups, BOARD_LIMITS, DEFAULT_BOARD_VIEWPORT, parseBoardDoc,
  type BoardAudioKind, type BoardDelta, type BoardDoc, type BoardEdge, type BoardEdgeKind, type BoardEdgeRole,
  type BoardGroup, type BoardNode, type BoardNodeType, type BoardView, type BoardViewport, type BoardVideoMode,
} from "../../shared/board";
import type { Asset, Task } from "../../shared/types";

const SAVE_DEBOUNCE_MS = 400;
const SELECTION_DEBOUNCE_MS = 250;
const VIEWPORT_DEBOUNCE_MS = 600;

type Toast = (kind: "success" | "error", message: string) => void;

function now() {
  return new Date().toISOString();
}

function newId(prefix: string): string {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`;
}

function defaultNode(type: BoardNodeType, ref: string, position: { x: number; y: number }): BoardNode {
  const base = {
    id: newId("node"),
    ref,
    x: Math.round(position.x),
    y: Math.round(position.y),
    createdAt: now(),
    updatedAt: now(),
  };
  if (type === "text") {
    return { ...base, type, width: 300, height: 170, title: "文本", text: "" };
  }
  if (type === "image") {
    return {
      ...base, type, width: 300, height: 310, title: "图片",
      assetId: null, source: "upload", status: "empty",
      prompt: "", useUpstreamText: true,
    };
  }
  if (type === "video") {
    return {
      ...base, type, width: 320, height: 320, title: "视频",
      assetId: null, source: "upload", status: "empty",
      prompt: "", useUpstreamText: true,
    };
  }
  if (type === "audio") {
    return {
      ...base, type, width: 320, height: 220, title: "音频",
      assetId: null, source: "generated", status: "empty",
      prompt: "", useUpstreamText: true, audioKind: "speech",
    };
  }
  return {
    ...base, type: "config", width: 330, height: 260, title: "配置节点",
    mode: "image", prompt: "", useUpstreamText: true, count: 1, status: "idle",
  };
}

export interface UseBoardResult {
  view: BoardView | null;
  loading: boolean;
  saving: boolean;
  /** 服务暂时不可用，正在后台重试保存（saving 已经结束，但改动还在本地） */
  retrying: boolean;
  selection: string[];
  viewport: BoardViewport;
  reload: () => Promise<void>;
  /** 合并 Agent 的增量；版本对不上 / 有本地未保存改动时返回 false，调用方应 reload */
  applyDelta: (delta: BoardDelta) => boolean;
  setSelection: (ids: string[]) => void;
  setViewport: (viewport: BoardViewport) => void;
  addNode: (type: BoardNodeType, position: { x: number; y: number }) => BoardNode | null;
  addImageNode: (asset: Asset, position?: { x: number; y: number }, title?: string) => BoardNode | null;
  updateNode: (nodeId: string, patch: Partial<BoardNode>) => void;
  updateNodeSilently: (nodeId: string, patch: Partial<BoardNode>) => void;
  removeNodes: (nodeIds: string[]) => void;
  duplicateNodes: (nodeIds: string[]) => string[];
  autoLayout: () => void;
  moveNodes: (updates: Array<{ id: string; x: number; y: number }>) => void;
  addEdge: (source: string, target: string, kind: BoardEdgeKind, role?: BoardEdgeRole) => boolean;
  updateEdge: (edgeId: string, patch: { role?: BoardEdgeRole | undefined }) => boolean;
  removeEdges: (edgeIds: string[]) => void;
  createGroup: (nodeIds: string[], title?: string) => BoardGroup | null;
  updateGroup: (groupId: string, patch: { title?: string; collapsed?: boolean }) => void;
  ungroup: (groupId: string) => void;
  generate: (nodeId: string, overrides?: {
    prompt?: string;
    model?: string;
    size?: string;
    imageSize?: string;
    quality?: string;
    negativePrompt?: string;
    aspectRatio?: string;
    seed?: number;
    style?: "auto" | "vivid" | "natural";
    background?: "auto" | "opaque" | "transparent";
    outputFormat?: "png" | "jpeg" | "webp";
    moderation?: "auto" | "low";
    count?: number;
    videoMode?: BoardVideoMode;
    durationSeconds?: number;
    resolution?: string;
    audio?: boolean;
    promptExtend?: boolean;
    watermark?: boolean;
    audioKind?: BoardAudioKind;
    voice?: string;
    ttsStyle?: string;
    instrumental?: boolean;
    musicTitle?: string;
    musicTags?: string;
    musicNegativeTags?: string;
  }) => Promise<{ taskId: string | null; kind: "image" | "video" | "text" | "audio"; resultNodeIds: string[] } | null>;
  cancelTask: (taskId: string) => Promise<void>;
  retryTask: (taskId: string) => Promise<void>;
  uploadAsset: (file: File, position?: { x: number; y: number }) => Promise<Asset | null>;
  removeAsset: (assetId: string) => Promise<void>;
  rename: (title: string) => Promise<void>;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  restoreVersion: (version: number) => Promise<void>;
  importTemplate: (templateId: string) => Promise<number | null>;
  flush: () => Promise<void>;
  ensureSaved: () => Promise<boolean>;
}

export function useBoard(
  boardId: string | null,
  onToast: Toast,
): UseBoardResult {
  const [view, setViewState] = useState<BoardView | null>(null);
  const [loading, setLoading] = useState(Boolean(boardId));
  const [saving, setSaving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const retryPendingRef = useRef(false);
  const retryFailuresRef = useRef(0);
  const retryToastAtRef = useRef(0);
  const [selection, setSelectionState] = useState<string[]>([]);
  const [viewport, setViewportState] = useState<BoardViewport>({ ...DEFAULT_BOARD_VIEWPORT });

  const viewRef = useRef<BoardView | null>(null);
  const selectionRef = useRef<string[]>([]);
  const viewportRef = useRef<BoardViewport>({ ...DEFAULT_BOARD_VIEWPORT });
  const localRevisionRef = useRef(0);
  const savingRef = useRef(false);
  const pendingRef = useRef<{ doc: BoardDoc; reason: string; boardId: string; baseVersion: number } | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const reloadSeqRef = useRef(0);
  /** 服务端临时故障后的重试间隔；正常保存是 0 */
  const retryDelayRef = useRef(0);
  /** 切板 / 卸载时先把旧板的未保存改动写掉；flush 定义在后面，用 ref 接住 */
  const flushRef = useRef<() => Promise<void>>(async () => undefined);
  const selectionTimerRef = useRef<number | null>(null);
  const viewportTimerRef = useRef<number | null>(null);
  const reconcilingRef = useRef(false);
  const toastRef = useRef(onToast);
  const boardIdRef = useRef(boardId);

  useEffect(() => { toastRef.current = onToast; }, [onToast]);
  useEffect(() => { boardIdRef.current = boardId; }, [boardId]);

  const setView = useCallback((next: BoardView) => {
    viewRef.current = next;
    setViewState(next);
    viewportRef.current = next.viewport;
    setViewportState(next.viewport);
    selectionRef.current = next.selection;
    setSelectionState(next.selection);
  }, []);

  const reload = useCallback(async () => {
    const id = boardIdRef.current;
    const sequence = ++reloadSeqRef.current;
    if (!id) {
      viewRef.current = null;
      setViewState(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const next = await api.board(id);
      // 用户在请求期间切了板：旧响应不能覆盖新板
      if (sequence !== reloadSeqRef.current) return;
      localRevisionRef.current = 0;
      pendingRef.current = null;
      retryDelayRef.current = 0;
      retryPendingRef.current = false;
      retryFailuresRef.current = 0;
      retryToastAtRef.current = 0;
      setRetrying(false);
      setView(next);
    } catch (error) {
      if (sequence !== reloadSeqRef.current) return;
      toastRef.current("error", error instanceof Error ? error.message : "无限画布加载失败");
      viewRef.current = null;
      setViewState(null);
    } finally {
      if (sequence === reloadSeqRef.current) setLoading(false);
    }
  }, [setView]);

  const applyDelta = useCallback((delta: BoardDelta): boolean => {
    const current = viewRef.current;
    if (!current || current.id !== delta.boardId) return false;
    // 本地还有没保存的改动 / 正在保存时，增量合并会丢掉用户刚敲的内容；交给上层整份 reload
    if (pendingRef.current || savingRef.current || current.version !== delta.baseVersion) return false;

    const doc = applyBoardDeltaToDoc(current.doc, delta);
    const nodeIds = new Set(doc.nodes.map((node) => node.id));
    localRevisionRef.current = 0;
    pendingRef.current = null;
    retryPendingRef.current = false;
    retryFailuresRef.current = 0;
    retryToastAtRef.current = 0;
    retryDelayRef.current = 0;
    setRetrying(false);
    setView({
      ...current,
      doc,
      version: delta.version,
      selection: current.selection.filter((id) => nodeIds.has(id)),
      canUndo: true,
      canRedo: false,
    });
    return true;
  }, [setView]);

  useEffect(() => {
    void reload();
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      if (selectionTimerRef.current) window.clearTimeout(selectionTimerRef.current);
      if (viewportTimerRef.current) window.clearTimeout(viewportTimerRef.current);
      // 切到另一块板之前，把旧板最后 400ms 里的改动写掉
      void flushRef.current();
    };
  }, [boardId, reload]);

  const flush = useCallback(async (): Promise<void> => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (savingRef.current || !pendingRef.current) return;
    const pending = pendingRef.current;
    pendingRef.current = null;
    const revision = localRevisionRef.current;
    const pendingBoardId = pending.boardId;
    const stillCurrent = () => boardIdRef.current === pendingBoardId;
    savingRef.current = true;
    setSaving(true);
    try {
      // 注意：视口走单独的 /viewport 接口，不跟文档一起提交。
      // 这样切板时旧板保存的不会把新板的视口写进旧板。
      const saved = await api.saveBoard(pendingBoardId, {
        doc: pending.doc,
        baseVersion: pending.baseVersion,
        reason: pending.reason,
      });
      if (stillCurrent() && viewRef.current) {
        if (localRevisionRef.current === revision) {
          // 视口 / 选中可能在这 400ms 里又被用户改过，不能拿服务端返回值盖掉
          setView({
            ...saved,
            viewport: viewportRef.current,
            selection: selectionRef.current,
          });
          localRevisionRef.current = 0;
        } else {
          // 保存期间又有本地改动：只吸收版本号，文档继续用本地的，下一次 flush 接着写
          const merged = {
            ...viewRef.current,
            version: saved.version,
            canUndo: saved.canUndo,
            canRedo: saved.canRedo,
          };
          viewRef.current = merged;
          setViewState(merged);
        }
      }
      retryDelayRef.current = 0;
      if (retryPendingRef.current) {
        // 只失败一次（常见于 dev 服务重启）时不打扰用户；连续失败过才提示恢复
        if (retryFailuresRef.current >= 2) toastRef.current("success", "连接已恢复，改动已保存");
        retryPendingRef.current = false;
        retryFailuresRef.current = 0;
        retryToastAtRef.current = 0;
        setRetrying(false);
      }
      // 同一块板还有未保存的改动：下一次保存要用服务端刚返回的版本号
      const after = pendingRef.current as { doc: BoardDoc; reason: string; boardId: string; baseVersion: number } | null;
      if (after && after.boardId === pendingBoardId) {
        pendingRef.current = { ...after, baseVersion: saved.version };
      }
    } catch (error) {
      if (stillCurrent()) {
        if (error instanceof ApiError && error.code === "BOARD_VERSION_CONFLICT") {
          const current = (error.details as { board?: BoardView } | undefined)?.board;
          if (current) {
            localRevisionRef.current = 0;
            pendingRef.current = null;
            setView(current);
          } else {
            await reload();
          }
          retryPendingRef.current = false;
          retryFailuresRef.current = 0;
          retryToastAtRef.current = 0;
          setRetrying(false);
          toastRef.current("error", "无限画布已在别处更新，已重新加载");
        } else if (!(error instanceof ApiError) || error.status >= 500) {
          // 服务端重启 / 网络临时故障：本地改动先留着，指数退避重试。
          // 不能在这时 reload——那会把刚拿到的生成结果和用户没保存的编辑一起冲掉。
          if (!pendingRef.current) pendingRef.current = pending;
          retryPendingRef.current = true;
          retryFailuresRef.current += 1;
          setRetrying(true);
          retryDelayRef.current = Math.min(
            10_000,
            Math.max(2_000, retryDelayRef.current ? retryDelayRef.current * 2 : 2_000),
          );
          // 第一次失败通常只是 dev 服务在重启；连续失败两次以上才弹提示，且 20 秒内不刷屏
          const now = Date.now();
          if (retryFailuresRef.current >= 2 && now - retryToastAtRef.current > 20_000) {
            retryToastAtRef.current = now;
            toastRef.current("error", error instanceof ApiError ? `保存暂未成功：${error.message}，正在重试…` : "无法连接本地服务，正在重试保存…");
          }
        } else {
          retryPendingRef.current = false;
          retryFailuresRef.current = 0;
          retryToastAtRef.current = 0;
          setRetrying(false);
          toastRef.current("error", error instanceof Error ? error.message : "保存失败");
          // 400 / 404 通常是文档真的不合法；重新拉一次，避免一直拿坏数据重试
          await reload();
        }
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
      // 哪怕已经切到新板，旧板剩下的改动也要继续写完
      if (pendingRef.current) {
        // 保留退避时间：连续失败时下一次会等更久，成功时才在成功分支清零
        const delay = retryDelayRef.current;
        saveTimerRef.current = window.setTimeout(() => void flush(), delay);
      }
    }
  }, [reload, setView]);

  flushRef.current = flush;

  /** 外部操作前等待在途保存结束；失败时保留本地改动，不允许后续操作覆盖它。 */
  const ensureSaved = useCallback(async (): Promise<boolean> => {
    const boardId = boardIdRef.current;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && boardIdRef.current === boardId) {
      if (savingRef.current) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
        continue;
      }
      if (!pendingRef.current) return true;
      await flush();
      if (retryPendingRef.current) return false;
    }
    return false;
  }, [flush]);

  const scheduleSave = useCallback((immediate = false) => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    if (immediate) {
      saveTimerRef.current = window.setTimeout(() => void flush(), 0);
      return;
    }
    saveTimerRef.current = window.setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  }, [flush]);

  const applyLocal = useCallback((mutator: (doc: BoardDoc) => BoardDoc, reason: string, immediate = false) => {
    const current = viewRef.current;
    if (!current) return;
    const doc = mutator(current.doc);
    localRevisionRef.current += 1;
    pendingRef.current = { doc, reason, boardId: current.id, baseVersion: current.version };
    const next = { ...current, doc, canUndo: true, canRedo: false };
    viewRef.current = next;
    setViewState(next);
    scheduleSave(immediate);
  }, [scheduleSave]);

  const setSelection = useCallback((ids: string[]) => {
    const nodeIds = new Set(viewRef.current?.doc.nodes.map((node) => node.id) ?? []);
    const next = [...new Set(ids)].filter((id) => nodeIds.has(id));
    selectionRef.current = next;
    setSelectionState(next);
    // 捕获当前板 id：600ms 内切板时，旧板的选中不能写到新板上
    const boardId = boardIdRef.current;
    if (!boardId) return;
    if (selectionTimerRef.current) window.clearTimeout(selectionTimerRef.current);
    selectionTimerRef.current = window.setTimeout(() => {
      void api.saveBoardSelection(boardId, next).catch(() => undefined);
    }, SELECTION_DEBOUNCE_MS);
  }, []);

  const setViewport = useCallback((next: BoardViewport) => {
    viewportRef.current = next;
    setViewportState(next);
    const boardId = boardIdRef.current;
    if (!boardId) return;
    if (viewportTimerRef.current) window.clearTimeout(viewportTimerRef.current);
    viewportTimerRef.current = window.setTimeout(() => {
      void api.saveBoardViewport(boardId, next).catch(() => undefined);
    }, VIEWPORT_DEBOUNCE_MS);
  }, []);

  const addNode = useCallback((type: BoardNodeType, position: { x: number; y: number }) => {
    const current = viewRef.current;
    if (!current) return null;
    if (current.doc.nodes.length >= BOARD_LIMITS.maxNodes) {
      toastRef.current("error", `一块无限画布最多 ${BOARD_LIMITS.maxNodes} 个节点`);
      return null;
    }
    const { ref, nextRef } = allocateNodeRef(current.doc);
    const node = defaultNode(type, ref, position);
    applyLocal((doc) => ({
      ...doc,
      nextRef,
      nodes: [...doc.nodes, node],
    }), `add:${type}`);
    return node;
  }, [applyLocal]);

  const addImageNode = useCallback((asset: Asset, position?: { x: number; y: number }, title?: string) => {
    const current = viewRef.current;
    if (!current) return null;
    if (current.doc.nodes.length >= BOARD_LIMITS.maxNodes) {
      toastRef.current("error", `一块无限画布最多 ${BOARD_LIMITS.maxNodes} 个节点`);
      return null;
    }
    const { ref, nextRef } = allocateNodeRef(current.doc);
    const base = defaultNode("image", ref, position ?? {
      x: 160 + (current.doc.nodes.length % 6) * 36,
      y: 160 + (current.doc.nodes.length % 6) * 36,
    });
    const node: BoardNode = {
      ...base,
      type: "image",
      title: (title || asset.fileName.replace(/\.[^.]+$/, "") || "图片").slice(0, 80),
      assetId: asset.id,
      source: "upload",
      status: "succeeded",
      naturalWidth: undefined,
      naturalHeight: undefined,
    } as BoardNode;
    applyLocal((doc) => ({ ...doc, nextRef, nodes: [...doc.nodes, node] }), "add:image");
    return node;
  }, [applyLocal]);

  const updateNode = useCallback((nodeId: string, patch: Partial<BoardNode>) => {
    applyLocal((doc) => ({
      ...doc,
      nodes: doc.nodes.map((node) => node.id === nodeId
        ? { ...node, ...patch, id: node.id, ref: node.ref, type: node.type, updatedAt: now() } as BoardNode
        : node),
    }), "update");
  }, [applyLocal]);

  /** 拖拽过程中的临时位置：不写历史、不触发保存 */
  const updateNodeSilently = useCallback((nodeId: string, patch: Partial<BoardNode>) => {
    const current = viewRef.current;
    if (!current) return;
    const nextDoc = {
      ...current.doc,
      nodes: current.doc.nodes.map((node) => node.id === nodeId
        ? { ...node, ...patch, id: node.id, ref: node.ref, type: node.type } as BoardNode
        : node),
    };
    const next = { ...current, doc: nextDoc };
    viewRef.current = next;
    setViewState(next);
  }, []);

  const removeNodes = useCallback((nodeIds: string[]) => {
    const ids = new Set(nodeIds);
    if (!ids.size) return;
    applyLocal((doc) => ({
      ...doc,
      nodes: doc.nodes.filter((node) => !ids.has(node.id)),
      edges: doc.edges.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target)),
      // 分组只剩空壳时一起删掉，避免留下指向已删节点的分组
      groups: boardGroups(doc)
        .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((nodeId) => !ids.has(nodeId)) }))
        .filter((group) => group.nodeIds.length > 0),
    }), "delete", true);
    setSelection(selectionRef.current.filter((id) => !ids.has(id)));
  }, [applyLocal, setSelection]);

  const createGroup = useCallback((nodeIds: string[], title?: string) => {
    const current = viewRef.current;
    if (!current) return null;
    const nodeIdsSet = new Set(current.doc.nodes.map((node) => node.id));
    const picked = [...new Set(nodeIds)].filter((id) => nodeIdsSet.has(id));
    if (picked.length < 2) {
      toastRef.current("error", "至少选中两个节点才能编组");
      return null;
    }
    const existing = boardGroups(current.doc)
      .map((group) => ({ ...group, nodeIds: group.nodeIds.filter((id) => !picked.includes(id)) }))
      .filter((group) => group.nodeIds.length > 0);
    if (existing.length >= BOARD_LIMITS.maxGroups) {
      toastRef.current("error", `一块无限画布最多 ${BOARD_LIMITS.maxGroups} 个分组`);
      return null;
    }
    const group: BoardGroup = {
      id: newId("group"),
      title: (title || `分组 ${existing.length + 1}`).slice(0, 80),
      nodeIds: picked,
      collapsed: false,
    };
    applyLocal((doc) => ({ ...doc, groups: [...existing, group] }), "group:create", true);
    return group;
  }, [applyLocal]);

  const updateGroup = useCallback((groupId: string, patch: { title?: string; collapsed?: boolean }) => {
    applyLocal((doc) => ({
      ...doc,
      groups: boardGroups(doc).map((group) => group.id === groupId ? { ...group, ...patch } : group),
    }), "group:update", true);
  }, [applyLocal]);

  const ungroup = useCallback((groupId: string) => {
    applyLocal((doc) => ({
      ...doc,
      groups: boardGroups(doc).filter((group) => group.id !== groupId),
    }), "group:delete", true);
  }, [applyLocal]);

  /** 复制一批节点（含它们之间的连线）；生成状态和任务 id 不复制，避免两个节点抢同一个任务 */
  const duplicateNodes = useCallback((nodeIds: string[]) => {
    const current = viewRef.current;
    if (!current) return [];
    const wanted = new Set(nodeIds);
    const sourceNodes = current.doc.nodes.filter((node) => wanted.has(node.id));
    if (!sourceNodes.length) return [];
    const room = BOARD_LIMITS.maxNodes - current.doc.nodes.length;
    if (room <= 0) {
      toastRef.current("error", `一块无限画布最多 ${BOARD_LIMITS.maxNodes} 个节点`);
      return [];
    }
    const picked = sourceNodes.slice(0, room);
    const at = now();
    let nextRef = current.doc.nextRef;
    const idMap = new Map<string, string>();
    const allocatedNodes: BoardNode[] = [];
    const clones: BoardNode[] = picked.map((node) => {
      const allocated = allocateNodeRef({ nodes: [...current.doc.nodes, ...allocatedNodes], nextRef });
      nextRef = allocated.nextRef;
      const id = newId("node");
      idMap.set(node.id, id);
      const base = structuredClone(node);
      const clone = {
        ...base,
        id,
        ref: allocated.ref,
        x: base.x + 48,
        y: base.y + 48,
        createdAt: at,
        updatedAt: at,
      } as BoardNode;
      let result: BoardNode = clone;
      if (clone.type === "image" || clone.type === "video") {
        result = { ...clone, taskId: undefined, status: clone.assetId ? "succeeded" : "empty", error: undefined } as BoardNode;
      } else if (clone.type === "config") {
        result = { ...clone, lastTaskId: undefined, status: "idle", error: undefined } as BoardNode;
      }
      allocatedNodes.push(result);
      return result;
    });
    const clonedEdges = current.doc.edges
      .filter((edge) => idMap.has(edge.source) && idMap.has(edge.target))
      .map((edge) => ({
        ...edge,
        id: newId("edge"),
        source: idMap.get(edge.source)!,
        target: idMap.get(edge.target)!,
      }));
    // 整组都被复制时，把分组关系也带过去；只复制部分成员时不建半截分组
    const clonedGroups: BoardGroup[] = boardGroups(current.doc)
      .filter((group) => group.nodeIds.every((nodeId) => idMap.has(nodeId)))
      .map((group) => ({
        id: newId("group"),
        title: `${group.title} 副本`.slice(0, 80),
        nodeIds: group.nodeIds.map((nodeId) => idMap.get(nodeId)!),
        collapsed: group.collapsed,
      }));
    applyLocal((doc) => ({
      ...doc,
      nextRef,
      nodes: [...doc.nodes, ...clones],
      edges: [...doc.edges, ...clonedEdges],
      groups: [...boardGroups(doc), ...clonedGroups],
    }), "duplicate", true);
    const ids = clones.map((node) => node.id);
    setSelection(ids);
    return ids;
  }, [applyLocal, setSelection]);

  /** 按依赖层级从左到右排列：根节点在最左，配置节点在中间，结果节点在右边 */
  const autoLayout = useCallback(() => {
    const current = viewRef.current;
    if (!current || current.doc.nodes.length < 2) return;
    const doc = current.doc;
    const depth = new Map<string, number>(doc.nodes.map((node) => [node.id, 0]));
    // 图里可能有被删了一半的边 / 未来导入的环；迭代 n 轮就停，不会死循环
    for (let round = 0; round < doc.nodes.length; round += 1) {
      let changed = false;
      for (const edge of doc.edges) {
        const from = depth.get(edge.source);
        const to = depth.get(edge.target);
        if (from === undefined || to === undefined) continue;
        if (to < from + 1) {
          depth.set(edge.target, from + 1);
          changed = true;
        }
      }
      if (!changed) break;
    }
    const columns = new Map<number, BoardNode[]>();
    for (const node of doc.nodes) {
      const level = depth.get(node.id) ?? 0;
      const bucket = columns.get(level);
      if (bucket) bucket.push(node);
      else columns.set(level, [node]);
    }
    const levels = [...columns.keys()].sort((left, right) => left - right);
    const startX = Math.min(...doc.nodes.map((node) => node.x));
    const startY = Math.min(...doc.nodes.map((node) => node.y));
    const positions = new Map<string, { x: number; y: number }>();
    let cursorX = startX;
    for (const level of levels) {
      const nodes = columns.get(level)!;
      nodes.sort((left, right) => left.y - right.y || left.x - right.x);
      let cursorY = startY;
      const columnWidth = Math.max(...nodes.map((node) => node.width));
      for (const node of nodes) {
        positions.set(node.id, { x: Math.round(cursorX), y: Math.round(cursorY) });
        cursorY += node.height + 40;
      }
      cursorX += columnWidth + 90;
    }
    applyLocal((latest) => ({
      ...latest,
      nodes: latest.nodes.map((node) => {
        const position = positions.get(node.id);
        return position ? { ...node, ...position, updatedAt: now() } : node;
      }),
    }), "auto-layout", true);
  }, [applyLocal]);

  const moveNodes = useCallback((updates: Array<{ id: string; x: number; y: number }>) => {
    if (!updates.length) return;
    const byId = new Map(updates.map((item) => [item.id, item]));
    applyLocal((doc) => ({
      ...doc,
      nodes: doc.nodes.map((node) => {
        const update = byId.get(node.id);
        return update ? { ...node, x: update.x, y: update.y, updatedAt: now() } : node;
      }),
    }), "move", true);
  }, [applyLocal]);

  const addEdge = useCallback((source: string, target: string, kind: BoardEdgeKind, role?: BoardEdgeRole) => {
    const current = viewRef.current;
    if (!current) return false;
    if (source === target) return false;
    if (current.doc.edges.some((edge) => edge.source === source && edge.target === target && edge.kind === kind)) return false;
    const edge: BoardEdge = {
      id: newId("edge"),
      source,
      target,
      kind,
      ...(role ? { role } : {}),
    };
    // 先在本地校验一次环 / 类型 / 重复，避免服务端拒绝后整份文档被重载、把未保存的改动一起冲掉
    try {
      parseBoardDoc({ ...current.doc, edges: [...current.doc.edges, edge] });
    } catch (error) {
      toastRef.current("error", error instanceof Error ? error.message : "这条连线不合法");
      return false;
    }
    applyLocal((doc) => ({ ...doc, edges: [...doc.edges, edge] }), "connect", true);
    return true;
  }, [applyLocal]);

  const updateEdge = useCallback((edgeId: string, patch: { role?: BoardEdgeRole | undefined }) => {
    const current = viewRef.current;
    if (!current) return false;
    const nextDoc: BoardDoc = {
      ...current.doc,
      edges: current.doc.edges.map((edge) => edge.id === edgeId
        ? { ...edge, ...patch } as BoardEdge
        : edge),
    };
    // 角色可能让这条连线变非法（例如把文本线改成首帧），先在本地拦下
    try {
      parseBoardDoc(nextDoc);
    } catch (error) {
      toastRef.current("error", error instanceof Error ? error.message : "这个角色不能用在当前连线上");
      return false;
    }
    applyLocal(() => nextDoc, "edge:role", true);
    return true;
  }, [applyLocal]);

  const removeEdges = useCallback((edgeIds: string[]) => {
    const ids = new Set(edgeIds);
    if (!ids.size) return;
    applyLocal((doc) => ({ ...doc, edges: doc.edges.filter((edge) => !ids.has(edge.id)) }), "disconnect", true);
  }, [applyLocal]);

  const uploadAsset = useCallback(async (file: File, position?: { x: number; y: number }) => {
    if (!boardIdRef.current) return null;
    try {
      const asset = await api.uploadBoardAsset(boardIdRef.current, file);
      // 服务端已经写好文件；插入节点后保存文档，正式建立引用。
      // 节点标题用用户原来的文件名，而不是服务端生成的 uuid 文件名。
      addImageNode(asset, position, file.name.replace(/\.[^.]+$/, ""));
      return asset;
    } catch (error) {
      toastRef.current("error", error instanceof Error ? error.message : "上传失败");
      return null;
    }
  }, [addImageNode]);

  const removeAsset = useCallback(async (assetId: string) => {
    if (!boardIdRef.current) return;
    try {
      const next = await api.deleteBoardAsset(boardIdRef.current, assetId);
      localRevisionRef.current = 0;
      pendingRef.current = null;
      setView(next);
    } catch (error) {
      toastRef.current("error", error instanceof Error ? error.message : "移除素材失败");
    }
  }, [setView]);

  const rename = useCallback(async (title: string) => {
    if (!boardIdRef.current) return;
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const next = await api.renameBoard(boardIdRef.current, trimmed);
      setView(next);
    } catch (error) {
      toastRef.current("error", error instanceof Error ? error.message : "重命名失败");
    }
  }, [setView]);

  /**
   * 在配置节点上生成图片。
   *
   * 先 flush：服务端按最新文档聚合上游，不能让它读到 400ms 前的旧提示词。
   * 提交成功后服务端已经写好结果占位节点，后续由 reconcileTasks 轮询回填。
   */
  const generate = useCallback(async (nodeId: string, overrides?: {
    prompt?: string;
    model?: string;
    size?: string;
    imageSize?: string;
    quality?: string;
    negativePrompt?: string;
    aspectRatio?: string;
    seed?: number;
    style?: "auto" | "vivid" | "natural";
    background?: "auto" | "opaque" | "transparent";
    outputFormat?: "png" | "jpeg" | "webp";
    moderation?: "auto" | "low";
    count?: number;
    videoMode?: BoardVideoMode;
    durationSeconds?: number;
    resolution?: string;
    audio?: boolean;
    promptExtend?: boolean;
    watermark?: boolean;
    audioKind?: BoardAudioKind;
    voice?: string;
    ttsStyle?: string;
    instrumental?: boolean;
    musicTitle?: string;
    musicTags?: string;
    musicNegativeTags?: string;
  }) => {
    if (!boardIdRef.current) return null;
    await flush();
    const current = viewRef.current;
    if (!current) return null;
    try {
      const result = await api.generateBoardNode(current.id, {
        nodeId,
        ...(overrides ? { overrides } : {}),
      });
      pendingRef.current = null;
      localRevisionRef.current = 0;
      setView({
        ...result.board,
        // 提交期间用户可能拖了画布；视口和选中不跟服务端返回值走
        viewport: viewportRef.current,
        selection: selectionRef.current,
      });
      return {
        taskId: result.task?.id ?? null,
        kind: result.kind,
        resultNodeIds: result.resultNodeIds,
      };
    } catch (error) {
      toastRef.current("error", error instanceof Error ? error.message : "提交生成失败");
      return null;
    }
  }, [flush, setView]);

  /**
   * 轮询进行中的任务，把结果写回占位节点。
   *
   * 服务端刻意不在任务完成回调里改文档：那样会和用户正在编辑的文档抢版本。
   * 这里只合并 status / assetId / error，不碰位置、文本和 prompt。
   */
  const reconcileTasks = useCallback(async () => {
    const current = viewRef.current;
    if (!current || reconcilingRef.current) return;
    const boardId = current.id;
    const groups = new Map<string, BoardNode[]>();
    for (const node of current.doc.nodes) {
      if ((node.type !== "image" && node.type !== "video" && node.type !== "audio")
        || node.status !== "loading" || !node.taskId) continue;
      const bucket = groups.get(node.taskId);
      if (bucket) bucket.push(node);
      else groups.set(node.taskId, [node]);
    }
    if (!groups.size) return;

    reconcilingRef.current = true;
    try {
      const updates = new Map<string, Partial<BoardNode>>();
      for (const [taskId, nodes] of groups) {
        let task: Task;
        try {
          task = await api.task(taskId);
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) {
            for (const node of nodes) {
              updates.set(node.id, { status: "cancelled", error: "任务记录不存在" } as Partial<BoardNode>);
            }
            const config = current.doc.nodes.find((node) => node.type === "config" && node.lastTaskId === taskId);
            if (config) updates.set(config.id, { status: "cancelled", error: "任务记录不存在" } as Partial<BoardNode>);
          }
          continue;
        }
        if (!["succeeded", "failed", "cancelled", "expired"].includes(task.status)) continue;
        // 一个任务可能出多张：按结果节点 ref 的数值顺序对应 assets 顺序
        nodes.sort((left, right) => left.ref.localeCompare(right.ref, undefined, { numeric: true }));
        const resultType = nodes[0]?.type;
        const prefix = resultType === "video" ? "video/" : resultType === "audio" ? "audio/" : "image/";
        const outputs = task.assets.filter((asset) => asset.mimeType.startsWith(prefix));
        const kindLabel = resultType === "video" ? "视频" : resultType === "audio" ? "音频" : "图片";
        nodes.forEach((node, index) => {
          if (task.status === "succeeded" && outputs[index]) {
            updates.set(node.id, {
              assetId: outputs[index]!.id,
              source: "generated",
              status: "succeeded",
              error: undefined,
            } as Partial<BoardNode>);
          } else {
            const status = task.status === "cancelled" ? "cancelled" : "failed";
            updates.set(node.id, {
              status,
              error: task.errorMessage ?? (task.status === "succeeded" ? `上游没有返回${kindLabel}` : "生成失败"),
            } as Partial<BoardNode>);
          }
        });
        const config = current.doc.nodes.find((node) => node.type === "config" && node.lastTaskId === taskId);
        if (config) {
          const ok = task.status === "succeeded" && outputs.length >= nodes.length;
          updates.set(config.id, {
            status: ok ? "succeeded" : task.status === "cancelled" ? "cancelled" : "failed",
            error: ok
              ? undefined
              : task.errorMessage ?? (task.status === "succeeded"
                ? `上游只返回了 ${outputs.length}/${nodes.length} 个${kindLabel}`
                : "生成失败"),
          } as Partial<BoardNode>);
        }
      }
      if (!updates.size || viewRef.current?.id !== boardId) return;
      applyLocal((doc) => ({
        ...doc,
        nodes: doc.nodes.map((node) => updates.has(node.id)
          ? { ...node, ...updates.get(node.id), updatedAt: now() } as BoardNode
          : node),
      }), "generate:result", true);
    } finally {
      reconcilingRef.current = false;
    }
  }, [applyLocal]);

  // 只要有 loading 的图片节点就每 1.5s 问一次任务状态；完成 / 关板后自动停
  const loadingTaskKey = (view?.doc.nodes ?? [])
    .filter((node) => (node.type === "image" || node.type === "video" || node.type === "audio")
      && node.status === "loading" && Boolean(node.taskId))
    .map((node) => (node.type === "image" || node.type === "video" || node.type === "audio" ? node.taskId : ""))
    .filter(Boolean)
    .sort()
    .join(",");

  useEffect(() => {
    if (!loadingTaskKey) return;
    let cancelled = false;
    const tick = () => { if (!cancelled) void reconcileTasks(); };
    tick();
    const timer = window.setInterval(tick, 1500);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [loadingTaskKey, reconcileTasks]);

  const cancelTask = useCallback(async (taskId: string) => {
    if (!boardIdRef.current) return;
    try {
      const task = await api.cancelBoardTask(boardIdRef.current, taskId);
      // 任务刚好已经成功：不要把它标成「已停止」，交给 reconcile 写回结果
      if (task.status === "succeeded") return;
      applyLocal((doc) => ({
        ...doc,
        nodes: doc.nodes.map((node) => {
          if ((node.type === "image" || node.type === "video" || node.type === "audio") && node.taskId === taskId) {
            return { ...node, status: "cancelled", error: "已停止", updatedAt: now() } as BoardNode;
          }
          if (node.type === "config" && node.lastTaskId === taskId) {
            return { ...node, status: "cancelled", error: "已停止", updatedAt: now() } as BoardNode;
          }
          return node;
        }),
      }), "generate:cancel", true);
    } catch (error) {
      toastRef.current("error", error instanceof Error ? error.message : "停止失败");
    }
  }, [applyLocal]);

  const retryTask = useCallback(async (taskId: string) => {
    if (!boardIdRef.current) return;
    try {
      const result = await api.retryBoardTask(boardIdRef.current, taskId);
      const resultIds = new Set(result.resultNodeIds);
      applyLocal((doc) => ({
        ...doc,
        nodes: doc.nodes.map((node) => {
          if (resultIds.has(node.id)) {
            return {
              ...node,
              taskId: result.task.id,
              status: "loading",
              assetId: null,
              error: undefined,
              updatedAt: now(),
            } as BoardNode;
          }
          if (node.type === "config" && node.lastTaskId === taskId) {
            return {
              ...node,
              lastTaskId: result.task.id,
              status: "loading",
              error: undefined,
              updatedAt: now(),
            } as BoardNode;
          }
          return node;
        }),
      }), "generate:retry", true);
    } catch (error) {
      toastRef.current("error", error instanceof Error ? error.message : "重试失败");
    }
  }, [applyLocal]);

  const importTemplate = useCallback(async (templateId: string) => {
    if (!boardIdRef.current || !viewRef.current) return null;
    // 模板会写进当前文档；先把本地改动落库再导入，避免冲突把其中一边冲掉
    await flush();
    if (!viewRef.current) return null;
    try {
      const result = await api.importTemplateToBoard(boardIdRef.current, templateId);
      pendingRef.current = null;
      localRevisionRef.current = 0;
      setView({
        ...result.board,
        viewport: viewportRef.current,
        selection: selectionRef.current,
      });
      return result.addedNodes;
    } catch (error) {
      toastRef.current("error", error instanceof Error ? error.message : "导入模板失败");
      return null;
    }
  }, [flush, setView]);

  const undo = useCallback(async () => {
    if (!boardIdRef.current || !viewRef.current) return;
    await flush();
    if (!viewRef.current) return;
    try {
      const next = await api.undoBoard(boardIdRef.current, viewRef.current.version);
      setView(next);
    } catch (error) {
      toastRef.current("error", error instanceof Error ? error.message : "撤销失败");
    }
  }, [flush, setView]);

  const redo = useCallback(async () => {
    if (!boardIdRef.current || !viewRef.current) return;
    await flush();
    if (!viewRef.current) return;
    try {
      const next = await api.redoBoard(boardIdRef.current, viewRef.current.version);
      setView(next);
    } catch (error) {
      toastRef.current("error", error instanceof Error ? error.message : "重做失败");
    }
  }, [flush, setView]);

  const restoreVersion = useCallback(async (version: number) => {
    if (!boardIdRef.current || !viewRef.current) return;
    // 先把当前未保存的改动落库，恢复操作才有一条可撤销的“恢复前”快照
    await flush();
    if (!viewRef.current) return;
    try {
      const next = await api.restoreBoardVersion(boardIdRef.current, version, viewRef.current.version);
      setView(next);
      toastRef.current("success", `已恢复到版本 ${version}`);
    } catch (error) {
      toastRef.current("error", error instanceof Error ? error.message : "恢复历史版本失败");
    }
  }, [flush, setView]);

  // 离开页面 / 窗口切到后台时把最后的改动写掉
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") void flush();
    };
    const onBeforeUnload = () => { void flush(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      void flush();
    };
  }, [flush]);

  return useMemo(() => ({
    view,
    loading,
    saving,
    retrying,
    selection,
    viewport,
    reload,
    applyDelta,
    setSelection,
    setViewport,
    addNode,
    addImageNode,
    updateNode,
    updateNodeSilently,
    removeNodes,
    duplicateNodes,
    autoLayout,
    moveNodes,
    addEdge,
    updateEdge,
    removeEdges,
    createGroup,
    updateGroup,
    ungroup,
    generate,
    cancelTask,
    retryTask,
    uploadAsset,
    removeAsset,
    rename,
    undo,
    redo,
    restoreVersion,
    importTemplate,
    flush,
    ensureSaved,
  }), [
    view, loading, saving, retrying, selection, viewport,
    reload, applyDelta, setSelection, setViewport, addNode, addImageNode, updateNode, updateNodeSilently,
    removeNodes, duplicateNodes, autoLayout, moveNodes, addEdge, updateEdge, removeEdges,
    createGroup, updateGroup, ungroup, generate, cancelTask, retryTask,
    uploadAsset, removeAsset, rename, undo, redo, restoreVersion, importTemplate, flush, ensureSaved,
  ]);
}
