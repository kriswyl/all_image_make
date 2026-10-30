/**
 * 无限画布画布：平移 / 缩放 / 框选 / 拖拽 / 缩放节点 / 连线 / 删除。
 *
 * 和分镜画布是两套组件：这里只认 BoardDoc 里的 nodes / edges，不认镜头语义。
 * P0 只建立 input 连线；result 连线留给 P1 的结果节点。
 */
import {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import {
  AudioLines, ChevronDown, ChevronUp, ClipboardPaste, Copy, Image as ImageIcon, LayoutGrid, Map as MapIcon,
  Maximize2, Mic, Music2, Plus, SlidersHorizontal, Trash2, Type, Ungroup, Upload, Video, ZoomIn, ZoomOut,
} from "lucide-react";
import {
  boardGroups, BOARD_LIMITS, directUpstreamImages, directUpstreamText,
  type BoardGroup, type BoardNode, type BoardNodeType,
} from "../../shared/board";
import type { Asset } from "../../shared/types";
import type { UseBoardResult } from "./useBoard";
import { BoardNodeView } from "./BoardNodeView";
import { BoardMinimap } from "./BoardMinimap";
import { useBoardMinimap } from "./useBoardMinimap";
import { clampScale, edgePath, edgeClass, rectsIntersect, nodesBounds } from "./board-geometry";

interface PositionPatch {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface DragState {
  pointerId: number;
  ids: string[];
  startX: number;
  startY: number;
  origins: Map<string, { x: number; y: number }>;
  moved: boolean;
  last: Map<string, { x: number; y: number }>;
}

interface ResizeState {
  pointerId: number;
  id: string;
  startX: number;
  startY: number;
  origin: { x: number; y: number; width: number; height: number };
  last: { width: number; height: number };
}

interface PanState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
  /** 单击空白（没有拖动）时清掉选中；空格 / 中键拖动不平移选择 */
  clearOnClick: boolean;
}

interface MarqueeState {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  additive: boolean;
  initial: string[];
}

interface ConnectState {
  pointerId: number;
  sourceId: string;
  sourceType: BoardNodeType;
  pointerX: number;
  pointerY: number;
}

interface GroupDragState {
  pointerId: number;
  groupId: string;
  startX: number;
  startY: number;
  origins: Map<string, { x: number; y: number }>;
  last: Map<string, { x: number; y: number }>;
  moved: boolean;
}

export function BoardCanvas({
  board, assets, onPickImage, onUploadFiles, onPreviewAsset, onGenerate, onStopTask, onRetryTask,
}: {
  board: UseBoardResult;
  assets: Map<string, Asset>;
  onPickImage: (nodeId: string | null) => void;
  onUploadFiles: (files: File[], position: { x: number; y: number }) => void;
  onPreviewAsset: (asset: Asset) => void;
  onGenerate: (nodeId: string) => void;
  onStopTask: (taskId: string) => void;
  onRetryTask: (taskId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [localPositions, setLocalPositions] = useState<Record<string, PositionPatch>>({});
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [spacePressed, setSpacePressed] = useState(false);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const [connect, setConnect] = useState<ConnectState | null>(null);
  const [connectMenu, setConnectMenu] = useState<{ x: number; y: number; worldX: number; worldY: number; sourceId: string; sourceType: BoardNode["type"] } | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [minimapOpen, setMinimapOpen] = useState(true);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    worldX: number;
    worldY: number;
  } | null>(null);
  /** 复制的是节点 id；粘贴时再深拷贝一次，连续粘贴会依次偏移 */
  const clipboardRef = useRef<string[]>([]);
  const [clipboardSize, setClipboardSize] = useState(0);

  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const panRef = useRef<PanState | null>(null);
  const marqueeRef = useRef<MarqueeState | null>(null);
  const connectRef = useRef<ConnectState | null>(null);
  const groupDragRef = useRef<GroupDragState | null>(null);
  const fittedBoardRef = useRef<string | null>(null);
  const spacePressedRef = useRef(false);

  const view = board.view;
  const doc = view?.doc ?? null;
  const viewport = board.viewport;

  const nodes = useMemo<BoardNode[]>(() => {
    if (!doc) return [];
    return doc.nodes.map((node) => {
      const patch = localPositions[node.id];
      return patch ? { ...node, ...patch } as BoardNode : node;
    });
  }, [doc, localPositions]);

  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const groups = useMemo(() => (doc ? boardGroups(doc) : []), [doc]);
  const collapsedNodeIds = useMemo(() => new Set(
    groups.filter((group) => group.collapsed).flatMap((group) => group.nodeIds),
  ), [groups]);
  /** 折叠分组里的节点不参与渲染 / 框选 / 连线，但仍留在文档里 */
  const visibleNodes = useMemo(
    () => nodes.filter((node) => !collapsedNodeIds.has(node.id)),
    [collapsedNodeIds, nodes],
  );
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const groupBounds = useMemo(() => {
    const result = new Map<string, { x: number; y: number; width: number; height: number }>();
    for (const group of groups) {
      const members = group.nodeIds
        .map((id) => nodeMap.get(id))
        .filter((node): node is BoardNode => Boolean(node));
      const bounds = nodesBounds(members);
      if (bounds) result.set(group.id, bounds);
    }
    return result;
  }, [groups, nodeMap]);
  /**
   * 画布没有固定边界：这里只是画布层的尺寸，用来给 SVG 一个坐标系。
   * 负坐标的节点 / 连线靠 overflow: visible 正常显示，平移本身不设上限。
   */
  const worldWidth = useMemo(
    () => Math.max(1200, size.width, ...nodes.map((node) => node.x + node.width + 1200)),
    [nodes, size.width],
  );
  const worldHeight = useMemo(
    () => Math.max(900, size.height, ...nodes.map((node) => node.y + node.height + 900)),
    [nodes, size.height],
  );
  const { contentBounds, minimapBounds, minimapLayout } = useBoardMinimap(nodes, viewport, size);

  const fit = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    const width = element.clientWidth;
    const height = element.clientHeight;
    if (!width || !height) return;
    if (!contentBounds) {
      board.setViewport({ x: 80, y: 80, scale: 1 });
      return;
    }
    const fitted = Math.min(
      1.05,
      (width - 120) / (contentBounds.width + 240),
      (height - 120) / (contentBounds.height + 240),
    );
    const scale = clampScale(Math.max(0.3, fitted));
    board.setViewport({
      scale,
      x: (width - contentBounds.width * scale) / 2 - contentBounds.x * scale,
      y: (height - contentBounds.height * scale) / 2 - contentBounds.y * scale,
    });
  }, [board, contentBounds]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      setSize({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    setSize({ width: element.clientWidth, height: element.clientHeight });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!view || !size.width || !size.height) return;
    if (fittedBoardRef.current === view.id) return;
    fittedBoardRef.current = view.id;
    const frame = requestAnimationFrame(fit);
    return () => cancelAnimationFrame(frame);
  }, [fit, size, view]);

  const toWorld = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - viewport.x) / viewport.scale,
      y: (clientY - rect.top - viewport.y) / viewport.scale,
    };
  }, [viewport]);

  const worldCenter = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 200, y: 200 };
    return toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }, [toWorld]);

  // 原生 wheel 监听：React 的 onWheel 在部分内核上是 passive 的，拦不住页面滚动
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const ratio = Math.exp(-event.deltaY * 0.0012);
      const nextScale = clampScale(viewport.scale * ratio);
      const scaleRatio = nextScale / viewport.scale;
      board.setViewport({
        scale: nextScale,
        x: px - (px - viewport.x) * scaleRatio,
        y: py - (py - viewport.y) * scaleRatio,
      });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [board, viewport]);

  const zoomBy = useCallback((factor: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const px = (rect?.width ?? 0) / 2;
    const py = (rect?.height ?? 0) / 2;
    const nextScale = clampScale(viewport.scale * factor);
    const scaleRatio = nextScale / viewport.scale;
    board.setViewport({
      scale: nextScale,
      x: px - (px - viewport.x) * scaleRatio,
      y: py - (py - viewport.y) * scaleRatio,
    });
  }, [board, viewport]);

  const removeSelected = useCallback(() => {
    if (selectedEdgeId) {
      board.removeEdges([selectedEdgeId]);
      setSelectedEdgeId(null);
      return;
    }
    if (!board.selection.length) return;
    const selected = board.selection.map((id) => nodeMap.get(id)).filter((node): node is BoardNode => Boolean(node));
    const withAssets = selected.filter((node) =>
      (node.type === "image" || node.type === "video" || node.type === "audio") && node.assetId);
    if (withAssets.length && !window.confirm(`删除 ${selected.length} 个节点？其中有 ${withAssets.length} 个已经绑定了素材。素材本身不会被删除。`)) return;
    board.removeNodes(board.selection);
  }, [board, nodeMap, selectedEdgeId]);

  const copySelection = useCallback(() => {
    if (!board.selection.length) return;
    clipboardRef.current = [...board.selection];
    setClipboardSize(board.selection.length);
  }, [board.selection]);

  const pasteClipboard = useCallback(() => {
    if (!clipboardRef.current.length) return;
    const ids = board.duplicateNodes(clipboardRef.current);
    if (ids.length) {
      clipboardRef.current = ids;
      setClipboardSize(ids.length);
    }
  }, [board]);

  useEffect(() => {
    const isEditable = (target: EventTarget | null) => {
      const element = target instanceof HTMLElement ? target : null;
      if (!element) return false;
      if (element.isContentEditable) return true;
      return Boolean(element.closest("input, textarea, select, [contenteditable='true']"));
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditable(event.target)) return;
      if (event.code === "Space") {
        event.preventDefault();
        spacePressedRef.current = true;
        setSpacePressed(true);
        return;
      }
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        removeSelected();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) void board.redo();
        else void board.undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        void board.redo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        board.setSelection(visibleNodes.map((node) => node.id));
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "g" && board.selection.length >= 2) {
        event.preventDefault();
        board.createGroup(board.selection);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && board.selection.length) {
        event.preventDefault();
        copySelection();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v" && clipboardRef.current.length) {
        // 没有节点剪贴板时不拦截：把 Ctrl+V 留给「粘贴系统剪贴板里的图片」
        event.preventDefault();
        pasteClipboard();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d" && board.selection.length) {
        event.preventDefault();
        const ids = board.duplicateNodes(board.selection);
        if (ids.length) {
          clipboardRef.current = ids;
          setClipboardSize(ids.length);
        }
        return;
      }
      if (event.key === "Escape") {
        board.setSelection([]);
        setSelectedEdgeId(null);
        setConnect(null);
        setConnectMenu(null);
        connectRef.current = null;
        setMarquee(null);
        marqueeRef.current = null;
        setAddMenuOpen(false);
        setContextMenu(null);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        spacePressedRef.current = false;
        setSpacePressed(false);
      }
    };
    const onBlur = () => {
      spacePressedRef.current = false;
      setSpacePressed(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [board, copySelection, pasteClipboard, removeSelected, visibleNodes]);

  // 从系统剪贴板粘图片：上传成素材并直接落成节点，位置放在当前视口中心
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith("image/"));
      if (!files.length) return;
      event.preventDefault();
      onUploadFiles(files, worldCenter());
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [onUploadFiles, worldCenter]);

  const beginCanvasPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    setAddMenuOpen(false);
    setContextMenu(null);
    if (!(event.target as HTMLElement).closest(".board-context-menu")) setConnectMenu(null);
    if (event.button === 2) return;
    const target = event.target as HTMLElement;
    const overNode = Boolean(target.closest("[data-board-node], [data-board-group]"));
    const modifier = event.shiftKey || event.metaKey || event.ctrlKey;
    // 默认拖动空白 = 平移；按住 Shift / Ctrl / Cmd 才框选。空格和中键仍然随时可平移。
    const wantsPan = spacePressedRef.current || event.button === 1 || (event.button === 0 && !overNode && !modifier);
    if (wantsPan) {
      event.preventDefault();
      panRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: viewport.x,
        originY: viewport.y,
        moved: false,
        clearOnClick: event.button === 0 && !spacePressedRef.current && !overNode && !modifier,
      };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
      setDragging(true);
      return;
    }
    if (event.button !== 0 || overNode) return;
    const world = toWorld(event.clientX, event.clientY);
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    const initial = additive ? board.selection : [];
    if (!additive) board.setSelection([]);
    setSelectedEdgeId(null);
    const state: MarqueeState = {
      pointerId: event.pointerId,
      startX: world.x,
      startY: world.y,
      currentX: world.x,
      currentY: world.y,
      additive,
      initial,
    };
    marqueeRef.current = state;
    setMarquee(state);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
  };

  const moveCanvasPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan && pan.pointerId === event.pointerId) {
      const dx = event.clientX - pan.startX;
      const dy = event.clientY - pan.startY;
      if (!pan.moved && Math.abs(dx) + Math.abs(dy) >= 3) pan.moved = true;
      board.setViewport({
        ...viewport,
        x: pan.originX + dx,
        y: pan.originY + dy,
      });
      return;
    }
    const current = marqueeRef.current;
    if (current && current.pointerId === event.pointerId) {
      const world = toWorld(event.clientX, event.clientY);
      const next = { ...current, currentX: world.x, currentY: world.y };
      marqueeRef.current = next;
      setMarquee(next);
    }
  };

  const endCanvasPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (panRef.current?.pointerId === event.pointerId) {
      const pan = panRef.current;
      panRef.current = null;
      setDragging(false);
      if (pan.clearOnClick && !pan.moved) {
        board.setSelection([]);
        setSelectedEdgeId(null);
      }
      return;
    }
    const current = marqueeRef.current;
    if (current && current.pointerId === event.pointerId) {
      const rect = {
        x: Math.min(current.startX, current.currentX),
        y: Math.min(current.startY, current.currentY),
        width: Math.abs(current.currentX - current.startX),
        height: Math.abs(current.currentY - current.startY),
      };
      const hits = visibleNodes
        .filter((node) => rectsIntersect(rect, node))
        .map((node) => node.id);
      board.setSelection([...new Set([...current.initial, ...hits])]);
      marqueeRef.current = null;
      setMarquee(null);
    }
  };

  const beginNodeDrag = (event: ReactPointerEvent<HTMLElement>, node: BoardNode) => {
    if (event.button !== 0 || spacePressedRef.current) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, select, a, [data-board-port], [data-board-resize]")) return;
    event.stopPropagation();
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    let nextSelection = [...board.selection];
    if (additive) {
      if (nextSelection.includes(node.id)) nextSelection = nextSelection.filter((id) => id !== node.id);
      else nextSelection = [...nextSelection, node.id];
    } else if (!nextSelection.includes(node.id)) {
      nextSelection = [node.id];
    }
    board.setSelection(nextSelection);
    setSelectedEdgeId(null);
    setEditingTextId(null);
    const ids = nextSelection.length ? nextSelection : [node.id];
    const origins = new Map<string, { x: number; y: number }>();
    for (const id of ids) {
      const item = nodeMap.get(id);
      if (item) origins.set(id, { x: item.x, y: item.y });
    }
    dragRef.current = {
      pointerId: event.pointerId,
      ids,
      startX: event.clientX,
      startY: event.clientY,
      origins,
      moved: false,
      last: new Map(origins),
    };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
  };

  const moveNodeDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = (event.clientX - drag.startX) / viewport.scale;
    const dy = (event.clientY - drag.startY) / viewport.scale;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    drag.moved = true;
    const patch: Record<string, PositionPatch> = {};
    const last = new Map<string, { x: number; y: number }>();
    for (const id of drag.ids) {
      const origin = drag.origins.get(id);
      if (!origin) continue;
      const next = { x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) };
      patch[id] = next;
      last.set(id, next);
    }
    drag.last = last;
    setLocalPositions((current) => ({ ...current, ...patch }));
  };

  const endNodeDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (!drag.moved) return;
    board.moveNodes([...drag.last.entries()].map(([id, position]) => ({ id, ...position })));
    setLocalPositions((current) => {
      const next = { ...current };
      for (const id of drag.ids) delete next[id];
      return next;
    });
  };

  const beginGroupDrag = (event: ReactPointerEvent<HTMLElement>, group: BoardGroup) => {
    if (event.button !== 0 || spacePressedRef.current) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, input, textarea, select, a")) return;
    event.preventDefault();
    event.stopPropagation();
    const origins = new Map<string, { x: number; y: number }>();
    for (const id of group.nodeIds) {
      const node = nodeMap.get(id);
      if (node) origins.set(id, { x: node.x, y: node.y });
    }
    if (!origins.size) return;
    groupDragRef.current = {
      pointerId: event.pointerId,
      groupId: group.id,
      startX: event.clientX,
      startY: event.clientY,
      origins,
      last: new Map(origins),
      moved: false,
    };
    board.setSelection([...origins.keys()]);
    setSelectedEdgeId(null);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
  };

  const moveGroupDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = groupDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = (event.clientX - drag.startX) / viewport.scale;
    const dy = (event.clientY - drag.startY) / viewport.scale;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
    drag.moved = true;
    const patch: Record<string, PositionPatch> = {};
    const last = new Map<string, { x: number; y: number }>();
    for (const [id, origin] of drag.origins) {
      const next = { x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) };
      patch[id] = next;
      last.set(id, next);
    }
    drag.last = last;
    setLocalPositions((current) => ({ ...current, ...patch }));
  };

  const endGroupDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const drag = groupDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    groupDragRef.current = null;
    if (drag.moved) {
      board.moveNodes([...drag.last.entries()].map(([id, position]) => ({ id, ...position })));
    }
    setLocalPositions((current) => {
      const next = { ...current };
      for (const id of drag.origins.keys()) delete next[id];
      return next;
    });
  };

  const beginResize = (event: ReactPointerEvent<HTMLSpanElement>, node: BoardNode) => {
    event.preventDefault();
    event.stopPropagation();
    resizeRef.current = {
      pointerId: event.pointerId,
      id: node.id,
      startX: event.clientX,
      startY: event.clientY,
      origin: { x: node.x, y: node.y, width: node.width, height: node.height },
      last: { width: node.width, height: node.height },
    };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
  };

  const moveResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const width = Math.min(BOARD_LIMITS.maxNodeWidth, Math.max(BOARD_LIMITS.minNodeWidth, resize.origin.width + (event.clientX - resize.startX) / viewport.scale));
    const height = Math.min(BOARD_LIMITS.maxNodeHeight, Math.max(BOARD_LIMITS.minNodeHeight, resize.origin.height + (event.clientY - resize.startY) / viewport.scale));
    resize.last = { width: Math.round(width), height: Math.round(height) };
    setLocalPositions((current) => ({ ...current, [resize.id]: resize.last }));
  };

  const endResize = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const resize = resizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    board.updateNode(resize.id, { width: resize.last.width, height: resize.last.height } as Partial<BoardNode>);
    setLocalPositions((current) => {
      const next = { ...current };
      delete next[resize.id];
      return next;
    });
  };

  const beginConnect = (event: ReactPointerEvent<HTMLSpanElement>, node: BoardNode) => {
    event.preventDefault();
    event.stopPropagation();
    setConnectMenu(null);
    const pointer = toWorld(event.clientX, event.clientY);
    const state: ConnectState = {
      pointerId: event.pointerId,
      sourceId: node.id,
      sourceType: node.type,
      pointerX: pointer.x,
      pointerY: pointer.y,
    };
    connectRef.current = state;
    setConnect(state);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 忽略 */ }
  };

  const moveConnect = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const state = connectRef.current;
    if (!state || state.pointerId !== event.pointerId) return;
    const pointer = toWorld(event.clientX, event.clientY);
    const next = { ...state, pointerX: pointer.x, pointerY: pointer.y };
    connectRef.current = next;
    setConnect(next);
  };

  const endConnect = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const state = connectRef.current;
    connectRef.current = null;
    setConnect(null);
    if (!state) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-board-node]");
    const targetId = target?.getAttribute("data-board-node-id");
    const targetNode = targetId ? nodeMap.get(targetId) : null;
    if (!targetNode) {
      if (event.type !== "pointercancel" && containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
          const point = toWorld(event.clientX, event.clientY);
          setConnectMenu({ x: Math.max(0, Math.min(event.clientX - rect.left, rect.width - 200)), y: Math.max(0, Math.min(event.clientY - rect.top, rect.height - 220)), worldX: point.x, worldY: point.y, sourceId: state.sourceId, sourceType: state.sourceType });
        }
      }
      return;
    }
    if (targetNode.type === "text") return;
    // 音频只吃文本；把图片拖过去直接不连，避免服务端拒绝一次后整份文档重载
    if (targetNode.type === "audio" && state.sourceType !== "text") return;
    // 视频 / 配置视频的图片连线默认「自动」角色，由服务端按张数 / 后续选择推断；生图则固定参考图
    const targetMode = targetNode.type === "config" ? targetNode.mode : targetNode.type;
    const role = state.sourceType === "text"
      ? "text"
      : targetMode === "video"
        ? undefined
        : "reference";
    const added = board.addEdge(state.sourceId, targetNode.id, "input", role);
    if (!added) return;
    board.setSelection([targetNode.id]);
  };

  const sourceNode = connect ? nodeMap.get(connect.sourceId) : null;
  const connectPath = sourceNode && connect
    ? `M ${sourceNode.x + sourceNode.width} ${sourceNode.y + sourceNode.height / 2} L ${connect.pointerX} ${connect.pointerY}`
    : null;

  const openContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const target = event.target as HTMLElement;
    if (target.closest(".board-canvas-controls, .board-minimap, .board-add-menu, .board-context-menu")) return;
    if (target.closest("[data-board-group], .board-group-frame")) return;
    const nodeId = target.closest<HTMLElement>("[data-board-node-id]")?.getAttribute("data-board-node-id");
    if (nodeId && !board.selection.includes(nodeId)) board.setSelection([nodeId]);
    const world = toWorld(event.clientX, event.clientY);
    setAddMenuOpen(false);
    setContextMenu({
      x: Math.min(window.innerWidth - 210, event.clientX),
      y: Math.min(window.innerHeight - 430, event.clientY),
      worldX: world.x,
      worldY: world.y,
    });
  };

  const handleDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-board-node], [data-board-group], .board-group-frame, .board-canvas-controls, .board-minimap, .board-context-menu, .board-add-menu")) return;
    const world = toWorld(event.clientX, event.clientY);
    const node = board.addNode("text", { x: world.x - 150, y: world.y - 60 });
    if (node) board.setSelection([node.id]);
    setContextMenu(null);
  };

  if (!view || !doc) {
    return (
      <div className="board-canvas is-loading" ref={containerRef}>
        <div className="board-empty">
          <SlidersHorizontal size={24} />
          <strong>{board.loading ? "正在打开无限画布…" : "无限画布还没有加载"}</strong>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`board-canvas ${dragging ? "is-dragging" : ""} ${connect ? "is-connecting" : ""} ${spacePressed ? "is-pan-ready" : ""}`}
      style={{
        backgroundPosition: `${viewport.x}px ${viewport.y}px`,
        backgroundSize: `${Math.max(10, 24 * viewport.scale)}px ${Math.max(10, 24 * viewport.scale)}px`,
      }}
      onPointerDown={beginCanvasPointer}
      onPointerMove={moveCanvasPointer}
      onPointerUp={endCanvasPointer}
      onPointerCancel={endCanvasPointer}
      onDoubleClick={handleDoubleClick}
      onContextMenu={openContextMenu}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
      onDrop={(event) => {
        event.preventDefault();
        const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith("image/"));
        if (!files.length) return;
        onUploadFiles(files, toWorld(event.clientX, event.clientY));
      }}
    >
      <div
        className="board-world"
        style={{
          width: worldWidth,
          height: worldHeight,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
        }}
      >
        {groups.filter((group) => !group.collapsed).map((group) => {
          const bounds = groupBounds.get(group.id);
          if (!bounds) return null;
          return (
            <section
              key={group.id}
              className="board-group-frame"
              style={{
                left: bounds.x - 24,
                top: bounds.y - 52,
                width: bounds.width + 48,
                height: bounds.height + 76,
              }}
            >
              <header
                className="board-group-head"
                onPointerDown={(event) => beginGroupDrag(event, group)}
                onPointerMove={moveGroupDrag}
                onPointerUp={endGroupDrag}
                onPointerCancel={endGroupDrag}
              >
                <strong>{group.title}</strong>
                <em>{group.nodeIds.length} 个节点</em>
                <button
                  type="button"
                  title="折叠分组"
                  aria-label="折叠分组"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => { board.updateGroup(group.id, { collapsed: true }); board.setSelection([]); }}
                >
                  <ChevronUp size={13} />
                </button>
                <button
                  type="button"
                  title="解散分组"
                  aria-label="解散分组"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={() => board.ungroup(group.id)}
                >
                  <Ungroup size={13} />
                </button>
              </header>
            </section>
          );
        })}

        <svg className="board-edges" width={worldWidth} height={worldHeight} aria-hidden="true">
          {doc.edges.map((edge) => {
            const source = nodeMap.get(edge.source);
            const target = nodeMap.get(edge.target);
            if (!source || !target) return null;
            if (!visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target)) return null;
            const d = edgePath(source, target);
            return (
              <g key={edge.id} className={`board-edge ${edgeClass(edge)} ${selectedEdgeId === edge.id ? "is-selected" : ""}`}>
                <path
                  d={d}
                  className="board-edge-hit"
                  onPointerDown={(event) => { event.stopPropagation(); setSelectedEdgeId(edge.id); board.setSelection([]); }}
                />
                <path d={d} className="board-edge-line" />
              </g>
            );
          })}
          {connectPath ? <path d={connectPath} className="board-edge-line is-preview" /> : null}
        </svg>

        {visibleNodes.map((node) => {
          const selected = board.selection.includes(node.id);
          const asset = (node.type === "image" || node.type === "video" || node.type === "audio") && node.assetId
            ? assets.get(node.assetId) ?? null
            : null;
          const upstream = node.type === "text"
            ? { textCount: 0, imageCount: 0 }
            : {
              textCount: directUpstreamText(doc, node.id).length,
              imageCount: directUpstreamImages(doc, node.id).length,
            };
          return (
            <article
              key={node.id}
              className={`board-node is-${node.type} ${selected ? "is-selected" : ""}`}
              data-board-node
              data-board-node-id={node.id}
              data-board-node-kind={node.type}
              style={{ left: node.x, top: node.y, width: node.width, height: node.height }}
              onPointerDown={(event) => beginNodeDrag(event, node)}
              onPointerMove={moveNodeDrag}
              onPointerUp={endNodeDrag}
              onPointerCancel={endNodeDrag}
            >
              <BoardNodeView
                node={node}
                asset={asset}
                editing={editingTextId === node.id}
                upstream={upstream}
                onStartEdit={() => setEditingTextId(node.id)}
                onCommitText={(text) => {
                  board.updateNode(node.id, { text } as Partial<BoardNode>);
                  setEditingTextId(null);
                }}
                onCancelEdit={() => setEditingTextId(null)}
                onUpdateNode={(patch) => board.updateNode(node.id, patch)}
                onPreview={onPreviewAsset}
                onSelect={() => board.setSelection([node.id])}
                onPickImage={onPickImage}
                onRemoveAsset={(nodeId) => {
                  const item = nodeMap.get(nodeId);
                  if (item?.type === "image") board.updateNode(nodeId, { assetId: null, status: "empty" } as Partial<BoardNode>);
                }}
                onDelete={(nodeId) => board.removeNodes([nodeId])}
                onGenerate={onGenerate}
                onStopTask={onStopTask}
                onRetryTask={onRetryTask}
              />

              {node.type !== "config" ? (
                <span
                  className="board-port is-output"
                  data-board-port
                  title="拖到图片 / 视频 / 音频 / 配置节点左侧，作为它的输入"
                  onPointerDown={(event) => beginConnect(event, node)}
                  onPointerMove={moveConnect}
                  onPointerUp={endConnect}
                  onPointerCancel={endConnect}
                />
              ) : null}
              {node.type === "config" || node.type === "image" || node.type === "video" || node.type === "audio" ? (
                <span className="board-port is-input" data-board-port aria-hidden="true" />
              ) : null}

              <span
                className="board-resize"
                data-board-resize
                title="拖动调整大小"
                onPointerDown={(event) => beginResize(event, node)}
                onPointerMove={moveResize}
                onPointerUp={endResize}
                onPointerCancel={endResize}
              />
            </article>
          );
        })}

        {groups.filter((group) => group.collapsed).map((group) => {
          const bounds = groupBounds.get(group.id);
          if (!bounds) return null;
          const width = Math.max(240, Math.min(360, bounds.width));
          return (
            <article
              key={group.id}
              className="board-group-card"
              data-board-group
              style={{ left: bounds.x, top: bounds.y, width, height: 96 }}
              onPointerDown={(event) => beginGroupDrag(event, group)}
              onPointerMove={moveGroupDrag}
              onPointerUp={endGroupDrag}
              onPointerCancel={endGroupDrag}
              onDoubleClick={(event) => {
                event.stopPropagation();
                board.updateGroup(group.id, { collapsed: false });
              }}
            >
              <div className="board-group-card-head">
                <ChevronDown size={14} />
                <strong>{group.title}</strong>
              </div>
              <div className="board-group-card-meta">
                <span>{group.nodeIds.length} 个节点已折叠</span>
                <div className="board-group-card-actions">
                  <button
                    type="button"
                    title="展开分组"
                    aria-label="展开分组"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => board.updateGroup(group.id, { collapsed: false })}
                  >
                    <ChevronDown size={13} />
                  </button>
                  <button
                    type="button"
                    title="解散分组"
                    aria-label="解散分组"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => board.ungroup(group.id)}
                  >
                    <Ungroup size={13} />
                  </button>
                </div>
              </div>
            </article>
          );
        })}

        {marquee ? (
          <div
            className="board-marquee"
            style={{
              left: Math.min(marquee.startX, marquee.currentX),
              top: Math.min(marquee.startY, marquee.currentY),
              width: Math.abs(marquee.currentX - marquee.startX),
              height: Math.abs(marquee.currentY - marquee.startY),
            }}
          />
        ) : null}
      </div>

      {!nodes.length ? (
        <div className="board-empty">
          <SlidersHorizontal size={24} />
          <strong>这块无限画布还是空的</strong>
          <span>双击空白处加文本；左下角“＋”可添加图片、视频、配音和音乐。</span>
        </div>
      ) : null}

      {minimapOpen ? <BoardMinimap nodes={nodes} bounds={minimapBounds} layout={minimapLayout} viewport={viewport} size={size} onViewportChange={board.setViewport} /> : null}

      {connectMenu ? (
        <div className="board-context-menu" style={{ left: connectMenu.x, top: connectMenu.y }} role="menu" aria-label="添加并连接节点" onPointerDown={(event) => event.stopPropagation()}>
          {([
            ...(connectMenu.sourceType === "config" ? [["text", "文本"]] as const : []),
            ["image", "图片"], ["video", "视频"],
            ...(connectMenu.sourceType === "text" || connectMenu.sourceType === "config" ? [["audio", "音频"]] as const : []),
            ...(connectMenu.sourceType !== "config" ? [["config", "配置"]] as const : []),
          ] as ReadonlyArray<readonly ["text" | "image" | "video" | "audio" | "config", string]>).map(([type, label]) => (
            <button type="button" role="menuitem" key={type} onClick={() => {
              const node = board.addNode(type, { x: connectMenu.worldX, y: connectMenu.worldY });
              if (node) {
                const kind = connectMenu.sourceType === "config" ? "result" : "input";
                const role = kind === "result" ? undefined : connectMenu.sourceType === "text" ? "text" : connectMenu.sourceType === "image" && type !== "video" ? "reference" : undefined;
                if (board.addEdge(connectMenu.sourceId, node.id, kind, role)) board.setSelection([node.id]);
              }
              setConnectMenu(null);
            }}><Plus size={13} /><span>{label}</span></button>
          ))}
        </div>
      ) : null}

      {contextMenu ? (
        <div
          className="board-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
          aria-label="画布操作"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" onClick={() => {
            board.addNode("text", { x: contextMenu.worldX, y: contextMenu.worldY });
            setContextMenu(null);
          }}>
            <Type size={13} /><span>加文本节点</span>
          </button>
          <button type="button" role="menuitem" onClick={() => {
            board.addNode("image", { x: contextMenu.worldX, y: contextMenu.worldY });
            setContextMenu(null);
          }}>
            <ImageIcon size={13} /><span>加图片节点（可直接生成）</span>
          </button>
          <button type="button" role="menuitem" onClick={() => {
            board.addNode("video", { x: contextMenu.worldX, y: contextMenu.worldY });
            setContextMenu(null);
          }}>
            <Video size={13} /><span>加视频节点</span>
          </button>
          <button type="button" role="menuitem" onClick={() => {
            const node = board.addNode("audio", { x: contextMenu.worldX, y: contextMenu.worldY });
            if (node) board.updateNode(node.id, { audioKind: "speech", title: "配音" } as Partial<BoardNode>);
            setContextMenu(null);
          }}>
            <Mic size={13} /><span>加配音节点（TTS）</span>
          </button>
          <button type="button" role="menuitem" onClick={() => {
            const node = board.addNode("audio", { x: contextMenu.worldX, y: contextMenu.worldY });
            if (node) board.updateNode(node.id, { audioKind: "music", title: "音乐" } as Partial<BoardNode>);
            setContextMenu(null);
          }}>
            <Music2 size={13} /><span>加音乐节点</span>
          </button>
          <button type="button" role="menuitem" onClick={() => {
            board.addNode("config", { x: contextMenu.worldX, y: contextMenu.worldY });
            setContextMenu(null);
          }}>
            <SlidersHorizontal size={13} /><span>加配置节点（汇总多张参考）</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { onPickImage(null); setContextMenu(null); }}>
            <Upload size={13} /><span>上传图片</span>
          </button>
          <button type="button" role="menuitem" disabled={board.selection.length < 2} onClick={() => { board.createGroup(board.selection); setContextMenu(null); }}>
            <Ungroup size={13} /><span>把选中节点编组</span>
          </button>
          <span className="board-context-sep" />
          <button type="button" role="menuitem" disabled={!board.selection.length} onClick={() => { copySelection(); setContextMenu(null); }}>
            <Copy size={13} /><span>复制</span>
          </button>
          <button type="button" role="menuitem" disabled={!clipboardSize} onClick={() => { pasteClipboard(); setContextMenu(null); }}>
            <ClipboardPaste size={13} /><span>粘贴</span>
          </button>
          <button type="button" role="menuitem" disabled={!board.selection.length} onClick={() => {
            const ids = board.duplicateNodes(board.selection);
            if (ids.length) {
              clipboardRef.current = ids;
              setClipboardSize(ids.length);
            }
            setContextMenu(null);
          }}>
            <Copy size={13} /><span>原地复制一份</span>
          </button>
          <span className="board-context-sep" />
          <button type="button" role="menuitem" onClick={() => { board.autoLayout(); setContextMenu(null); }}>
            <LayoutGrid size={13} /><span>自动排版</span>
          </button>
          <button type="button" role="menuitem" onClick={() => { fit(); setContextMenu(null); }}>
            <Maximize2 size={13} /><span>适应窗口</span>
          </button>
          <button type="button" role="menuitem" disabled={!board.selection.length} onClick={() => { removeSelected(); setContextMenu(null); }}>
            <Trash2 size={13} /><span>删除选中</span>
          </button>
        </div>
      ) : null}

      <div className="board-canvas-controls" onPointerDown={(event) => event.stopPropagation()}>
        <button type="button" title="缩小" aria-label="缩小" onClick={() => zoomBy(1 / 1.18)}>
          <ZoomOut size={14} />
        </button>
        <span>{Math.round(viewport.scale * 100)}%</span>
        <button type="button" title="放大" aria-label="放大" onClick={() => zoomBy(1.18)}>
          <ZoomIn size={14} />
        </button>
        <button type="button" title="适应窗口" aria-label="适应窗口" onClick={fit}>
          <Maximize2 size={14} />
        </button>
        <button
          type="button"
          className={minimapOpen ? "is-on" : ""}
          title={minimapOpen ? "关闭小地图" : "打开小地图"}
          aria-label="小地图"
          onClick={() => setMinimapOpen((open) => !open)}
        >
          <MapIcon size={14} />
        </button>
        <button type="button" title="自动排版" aria-label="自动排版" onClick={() => board.autoLayout()}>
          <LayoutGrid size={14} />
        </button>
        <span className="board-controls-divider" />
        <button
          type="button"
          className={`board-add-trigger ${addMenuOpen ? "is-on" : ""}`}
          title="添加节点（包括配音和音乐）"
          aria-label="添加节点（包括配音和音乐）"
          onClick={() => setAddMenuOpen((open) => !open)}
        >
          <Plus size={14} />
        </button>
        {addMenuOpen ? (
          <div className="board-add-menu" role="menu" aria-label="添加节点">
            <button type="button" role="menuitem" onPointerDown={(event) => event.stopPropagation()} onClick={() => { board.addNode("text", worldCenter()); setAddMenuOpen(false); }}>
              <Type size={14} /><span>文本</span><em>提示词 / 文案</em>
            </button>
            <button type="button" role="menuitem" onPointerDown={(event) => event.stopPropagation()} onClick={() => { board.addNode("image", worldCenter()); setAddMenuOpen(false); }}>
              <ImageIcon size={14} /><span>图片</span><em>写提示词生成，或上传</em>
            </button>
            <button type="button" role="menuitem" onPointerDown={(event) => event.stopPropagation()} onClick={() => { board.addNode("video", worldCenter()); setAddMenuOpen(false); }}>
              <Video size={14} /><span>视频</span><em>文生视频 / 图片首帧</em>
            </button>
            <button type="button" role="menuitem" onPointerDown={(event) => event.stopPropagation()} onClick={() => {
              const node = board.addNode("audio", worldCenter());
              if (node) board.updateNode(node.id, { audioKind: "speech", title: "配音" } as Partial<BoardNode>);
              setAddMenuOpen(false);
            }}>
              <Mic size={14} /><span>配音（TTS）</span><em>文本转语音</em>
            </button>
            <button type="button" role="menuitem" onPointerDown={(event) => event.stopPropagation()} onClick={() => {
              const node = board.addNode("audio", worldCenter());
              if (node) board.updateNode(node.id, { audioKind: "music", title: "音乐" } as Partial<BoardNode>);
              setAddMenuOpen(false);
            }}>
              <Music2 size={14} /><span>音乐</span><em>Suno 生成歌曲 / 纯音乐</em>
            </button>
            <button type="button" role="menuitem" onPointerDown={(event) => event.stopPropagation()} onClick={() => { board.addNode("config", worldCenter()); setAddMenuOpen(false); }}>
              <SlidersHorizontal size={14} /><span>配置</span><em>汇总多张参考图再生成</em>
            </button>
            <button type="button" role="menuitem" onPointerDown={(event) => event.stopPropagation()} onClick={() => { onPickImage(null); setAddMenuOpen(false); }}>
              <Upload size={14} /><span>上传图片</span><em>直接拖进画布也行</em>
            </button>
          </div>
        ) : null}
      </div>

      <div className="board-canvas-hint" aria-hidden="true">
        <span>拖动空白平移 · Shift / Ctrl 拖动框选 · 双击空白加文本</span>
        <span>滚轮缩放 · 右键菜单 · Ctrl/Cmd + C / V 复制粘贴</span>
      </div>
    </div>
  );
}
