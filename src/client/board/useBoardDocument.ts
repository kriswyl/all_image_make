import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../api";
import { applyBoardDeltaToDoc, DEFAULT_BOARD_VIEWPORT, type BoardDelta, type BoardDoc, type BoardView, type BoardViewport } from "../../shared/board";

const SAVE_DEBOUNCE_MS = 400;
const SELECTION_DEBOUNCE_MS = 250;
const VIEWPORT_DEBOUNCE_MS = 600;

type Toast = (kind: "success" | "error", message: string) => void;
type PendingBoardSave = { doc: BoardDoc; reason: string; boardId: string; baseVersion: number };

/** Owns the board snapshot, optimistic edits, and the versioned save queue. */
export function useBoardDocument(boardId: string | null, onToast: Toast) {
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
  const pendingRef = useRef<PendingBoardSave | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const reloadSeqRef = useRef(0);
  /** 服务端临时故障后的重试间隔；正常保存是 0 */
  const retryDelayRef = useRef(0);
  /** 切板 / 卸载时先把旧板的未保存改动写掉；flush 定义在后面，用 ref 接住 */
  const flushRef = useRef<() => Promise<void>>(async () => undefined);
  const selectionTimerRef = useRef<number | null>(null);
  const viewportTimerRef = useRef<number | null>(null);
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
      const after = pendingRef.current as PendingBoardSave | null;
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

  const updateLocalDocument = useCallback((mutator: (doc: BoardDoc) => BoardDoc) => {
    const current = viewRef.current;
    if (!current) return;
    const next = { ...current, doc: mutator(current.doc) };
    viewRef.current = next;
    setViewState(next);
  }, []);

  const adoptSavedView = useCallback((next: BoardView, keepInteraction = false) => {
    pendingRef.current = null;
    localRevisionRef.current = 0;
    setView(keepInteraction ? { ...next, viewport: viewportRef.current, selection: selectionRef.current } : next);
  }, [setView]);

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

  return {
    view, loading, saving, retrying, selection, viewport,
    viewRef, boardIdRef, selectionRef, toastRef,
    reload, applyDelta, setView, setSelection, setViewport,
    applyLocal, updateLocalDocument, adoptSavedView, flush, ensureSaved,
  };
}
