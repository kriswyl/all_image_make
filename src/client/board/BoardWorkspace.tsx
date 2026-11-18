/**
 * 无限画布工作区：独立于对话的整页画布和侧栏画布列表。
 *
 * 侧栏列表 portal 到 App 的「最近」位置，和对话列表复用同一套视觉，
 * 但两者的数据、线程、素材完全独立。
 */
import { LoadingIndicator } from "../ui/LoadingIndicator";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Activity, Clapperboard, Image as ImageIcon, Menu, Plus, Redo2, Search, Trash2, Undo2,
} from "lucide-react";
import { api, isTauriRuntime } from "../api";
import { confirmGeneration } from "../generation-confirm";
import { AssetLightbox } from "../chat/AssetLightbox";
import { extractVideoLastFrame } from "../chat/video-frame";
import { BoardNodeVersions } from "./BoardNodeVersions";
import { DiagnosticDialog } from "../dialogs/DiagnosticDialog";
import {
  BOARD_LIMITS, createBoardExport, type BoardAgentUiState, type BoardDelta, type BoardNode, type BoardSummary,
} from "../../shared/board";
import type { Asset, Task } from "../../shared/types";
import { referenceVideoDurationRange } from "../../shared/video-modes";
import { BoardAgentPanel } from "./BoardAgentPanel";
import { BoardCanvas } from "./BoardCanvas";
import { BoardHistoryDrawer } from "./BoardHistoryDrawer";
import { BoardTemplateDrawer } from "./BoardTemplateDrawer";
import { BoardMaterialDialog } from "./BoardMaterialDialog";
import { BoardNodeSearch } from "./BoardNodeSearch";
import { BoardTaskPanel } from "./BoardTaskPanel";
import { BoardProductionPanel } from "./BoardProductionPanel";
import { BoardProjectMenu } from "./BoardProjectMenu";
import { BoardRunReview } from "./BoardRunReview";
import { BoardTemplateInputDialog, BoardTemplateSaveDialog } from "./BoardWorkflowTemplate";
import { StoryboardReview } from "../chat/StoryboardReview";
import type { CanvasTemplate } from "../../shared/canvas-template";
import { CrossModeBridgeDialog, type BridgeAssetItem } from "./CrossModeBridgeDialog";
import { BoardInspector, type BoardImageAlias, type BoardVideoAlias } from "./BoardInspector";
import { useBoard } from "./useBoard";
import { planBoardRun } from "./board-run";
import type { BoardRunStep } from "./board-run";
import { matchModelAlias } from "../../shared/model-alias";
import { useBoardRun } from "./useBoardRun";
import "./board-production.css";

const CURRENT_BOARD_KEY = "yida.board-current";

function readCurrentBoard(): string {
  try { return window.localStorage.getItem(CURRENT_BOARD_KEY) ?? ""; } catch { return ""; }
}

function writeCurrentBoard(id: string) {
  try { window.localStorage.setItem(CURRENT_BOARD_KEY, id); } catch { /* 忽略 */ }
}

function readMediaDuration(url: string, kind: "audio" | "video"): Promise<number> {
  return new Promise((resolve, reject) => {
    const element = document.createElement(kind);
    const timer = window.setTimeout(() => finish(new Error("读取素材时长超时")), 15000);
    function finish(error?: Error) {
      const duration = element.duration;
      window.clearTimeout(timer);
      element.removeAttribute("src");
      if (error) reject(error); else resolve(duration);
    }
    element.preload = "metadata";
    element.onloadedmetadata = () => Number.isFinite(element.duration) ? finish() : finish(new Error("无法读取素材时长"));
    element.onerror = () => finish(new Error("无法读取素材，请检查文件是否有效"));
    element.src = api.assetUrl(url);
  });
}

function BoardSidebar({
  host, boards, activeId, loading, filter, onSelect, onCreate, onDelete,
}: {
  host: HTMLElement | null;
  boards: BoardSummary[];
  activeId: string | null;
  loading: boolean;
  filter: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}) {
  if (!host) return null;
  return createPortal(
    <div className="sidebar-group">
      <div className="sidebar-group-title">
        <span>我的画布</span>
        <button type="button" className="sidebar-group-add" aria-label="新建无限画布" data-tooltip="新建无限画布" onClick={onCreate}>
          <Plus size={13} />
        </button>
      </div>
      <div className="sidebar-conv-list">
        {loading && !boards.length ? (
          <div className="board-sidebar-empty"><LoadingIndicator variant="dots" size={24} />加载中…</div>
        ) : null}
        {boards.map((item) => (
          <div key={item.id} className={`sidebar-conv ${item.id === activeId ? "is-active" : ""}`}>
            <button
              type="button"
              className="sidebar-conv-main"
              onClick={() => onSelect(item.id)}
              aria-label={`${item.title}，${item.nodeCount} 个节点`}
            >
              <span className="sidebar-conv-title">{item.title}</span>
              <span className="board-sidebar-meta">{item.nodeCount} 节点</span>
            </button>
            <button
              type="button"
              className="icon-button compact danger sidebar-conv-del"
              aria-label="删除无限画布"
              data-tooltip="删除无限画布"
              onClick={() => onDelete(item.id)}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {!loading && !boards.length ? (
          <div className="board-sidebar-empty">{filter.trim() ? "没有匹配的画布" : "还没有无限画布"}</div>
        ) : null}
      </div>
    </div>,
    host,
  );
}

export function BoardWorkspace({
  sidebarHost, onOpenMenu, onBoardSelected, sidebarOpen, sidebarFilter = "", onToast,
}: {
  sidebarHost: HTMLElement | null;
  onBoardSelected: () => void;
  sidebarOpen: boolean;
  sidebarFilter?: string;
  /** 顶栏「菜单」：展开侧边栏，让用户选对话 / 其他工作区 */
  onOpenMenu: () => void;
  onToast: (kind: "success" | "error", message: string) => void;
}) {
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [boardsLoading, setBoardsLoading] = useState(true);
  // 先不拿 localStorage 里的 id 发请求：那个 id 可能已经被删了。
  // 等 boards 列表回来、确认它还在，再设成当前板。
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [assets, setAssets] = useState<Map<string, Asset>>(new Map());
  const [versionNodeId, setVersionNodeId] = useState<string | null>(null);
  const [diagnosticTask, setDiagnosticTask] = useState<Task | null>(null);
  const [extractingFrame, setExtractingFrame] = useState(false);
  const [imageAliases, setImageAliases] = useState<BoardImageAlias[]>([]);
  const [videoAliases, setVideoAliases] = useState<BoardVideoAlias[]>([]);
  const [audioAliases, setAudioAliases] = useState<BoardImageAlias[]>([]);
  const [defaultImageAlias, setDefaultImageAlias] = useState("");
  const [defaultVideoAlias, setDefaultVideoAlias] = useState("");
  const [defaultSpeechAlias, setDefaultSpeechAlias] = useState("");
  const [defaultMusicAlias, setDefaultMusicAlias] = useState("");
  const [preview, setPreview] = useState<Asset | null>(null);
  const [agentUi, setAgentUi] = useState<BoardAgentUiState | undefined>(undefined);
  const [assetDrawerOpen, setAssetDrawerOpen] = useState(false);
  const [assetTargetId, setAssetTargetId] = useState<string | null>(null);
  const [referenceTargetId, setReferenceTargetId] = useState<string | null>(null);
  const [assetSearch, setAssetSearch] = useState("");
  const [assetType, setAssetType] = useState<"all" | "image" | "video" | "audio">("all");
  const [historyBoardId, setHistoryBoardId] = useState<string | null>(null);
  const historyOpen = historyBoardId !== null && historyBoardId === currentId;
  const [bridgeItems, setBridgeItems] = useState<BridgeAssetItem[] | null>(null);
  const [templateDrawerOpen, setTemplateDrawerOpen] = useState(false);
  const [commandPanel, setCommandPanel] = useState<"tasks" | "search" | "production" | null>(null);
  const [reviewProject, setReviewProject] = useState<string | null>(null);
  const [templateDraft, setTemplateDraft] = useState<{ id: string; nodes: BoardNode[] } | null>(null);
  const [templateInput, setTemplateInput] = useState<{ boardId: string; template: CanvasTemplate } | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ boardId: string; nodeId: string } | null>(null);
  const [runPanelVersion, setRunPanelVersion] = useState(0);
  const [runDraft, setRunDraft] = useState<{ boardId: string; steps: BoardRunStep[] } | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const uploadTargetRef = useRef<string | null>(null);
  /** React StrictMode 在开发环境会把挂载 effect 跑两遍；不能因此建两块空板 */
  const initializedRef = useRef(false);

  const board = useBoard(currentId, onToast);
  const runError = useCallback((message: string) => onToast("error", message), [onToast]);
  const productionRun = useBoardRun(currentId, board, runError);
  const projectIds = [...new Set((board.view?.doc.nodes ?? []).flatMap((node) => node.storyboard ? [node.storyboard.projectId] : []))];
  const activeViewRef = useRef(board.view);
  activeViewRef.current = board.view;

  const refreshBoards = useCallback(async () => {
    setBoardsLoading(true);
    try {
      const next = await api.boards();
      setBoards(next);
      return next;
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "无限画布列表加载失败");
      return [];
    } finally {
      setBoardsLoading(false);
    }
  }, [onToast]);

  const createBoard = useCallback(async (closeAfter = false) => {
    try {
      const created = await api.createBoard({ title: "未命名无限画布" });
      setCurrentId(created.id);
      writeCurrentBoard(created.id);
      await refreshBoards();
      if (closeAfter) onBoardSelected();
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "新建无限画布失败");
    }
  }, [onToast, refreshBoards, onBoardSelected]);

  const removeBoard = useCallback(async (id: string) => {
    const target = boards.find((item) => item.id === id);
    const detail = target ? `「${target.title}」（${target.nodeCount} 个节点）` : "这块无限画布";
    if (!window.confirm(`删除${detail}？画板和它的助手对话会一起删除，素材文件不会被删除。`)) return;
    try {
      await api.deleteBoard(id);
      const rest = boards.filter((item) => item.id !== id);
      setBoards(rest);
      if (currentId !== id) return;
      if (rest.length) {
        setCurrentId(rest[0]!.id);
        writeCurrentBoard(rest[0]!.id);
      } else {
        // 最后一块被删掉：立刻建一块空的，避免工作区停在「无限画布不存在」
        await createBoard();
      }
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "删除无限画布失败");
    }
  }, [boards, createBoard, currentId, onToast]);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    void (async () => {
      const list = await refreshBoards();
      if (!list.length) {
        await createBoard();
        return;
      }
      const saved = readCurrentBoard();
      const target = list.find((item) => item.id === saved) ?? list[0]!;
      setCurrentId(target.id);
      writeCurrentBoard(target.id);
    })();
    // 只在进入工作区时做一次初始化；之后由用户操作驱动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (currentId) writeCurrentBoard(currentId);
  }, [currentId]);

  // 检查器的模型 / 尺寸列表：能力清单只包含启用渠道，和生成时解析的是同一份
  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.capabilities(), api.settings()]).then(([capabilities, settings]) => {
      if (cancelled) return;
      const map = (kind: "image" | "video" | "audio") => capabilities.aliases
        .filter((alias) => alias.kind === kind)
        .map((alias) => ({
          alias: alias.alias,
          model: alias.model,
          channelName: alias.channelName,
          channelId: alias.channelId,
          adapterType: alias.adapterType,
          localVideoUploadConfigured: alias.localVideoUploadConfigured,
        }));
      setImageAliases(map("image"));
      setVideoAliases(map("video"));
      setAudioAliases(map("audio"));
      setDefaultImageAlias(settings.defaultImageAlias ?? "");
      setDefaultVideoAlias(settings.defaultVideoAlias ?? "");
      setDefaultSpeechAlias(settings.defaultSpeechAlias ?? "");
      setDefaultMusicAlias(settings.defaultMusicAlias ?? "");
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!currentId) {
      setAssets(new Map());
      return;
    }
    let cancelled = false;
    void api.boardAssets(currentId).then((list) => {
      if (cancelled) return;
      setAssets(new Map(list.map((asset) => [asset.id, asset])));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [currentId]);

  useEffect(() => {
    if (!board.view) {
      setTitleDraft("");
      return;
    }
    setTitleDraft(board.view.title);
  }, [board.view?.id, board.view?.title]);

  useEffect(() => { setHistoryBoardId(null); }, [currentId]);

  // 侧栏的节点数 / 标题跟着文档走；不重新请求列表，避免拖节点时整个侧栏闪一下
  useEffect(() => {
    // 切板时把浮窗位置换成新板保存的那一份；同一块板内由 panel 自己维护
    setAgentUi(board.view?.uiState.agent);
  }, [board.view?.id]);

  useEffect(() => {
    if (!board.view) return;
    const { id, title, doc } = board.view;
    setBoards((current) => current.map((item) => item.id === id
      ? { ...item, title, nodeCount: doc.nodes.length, edgeCount: doc.edges.length, updatedAt: new Date().toISOString() }
      : item));
  }, [board.view?.id, board.view?.title, board.view?.version, board.view?.doc.nodes.length, board.view?.doc.edges.length]);

  // 画布上的素材可能来自上传 / 生成；按文档里的 assetId 集合拉一次素材表。
  // 依赖的是 id 集合而不是 assets 本身：某张素材真的查不到时不能每轮都重拉，否则会死循环。
  const assetKey = useMemo(() => board.view
    ? [...new Set(board.view.doc.nodes
      .filter((node): node is Extract<BoardNode, { type: "image" | "video" | "audio" }> =>
        node.type === "image" || node.type === "video" || node.type === "audio")
      .map((node) => node.assetId)
      .filter((id): id is string => Boolean(id)))].sort().join(",")
    : "", [board.view?.doc]);

  useEffect(() => {
    if (!currentId || !assetKey) return;
    let cancelled = false;
    void api.boardAssets(currentId).then((list) => {
      if (cancelled) return;
      setAssets((current) => {
        const next = new Map(current);
        for (const asset of list) next.set(asset.id, asset);
        return next;
      });
    }).catch(() => undefined);
    return () => { cancelled = true; };
    // version 变化 = 生成结果刚保存完，board_assets 已重建；重新拉一次才能显示新图
  }, [assetKey, board.view?.version, currentId]);

  const selectedImageAssets = useMemo(() => {
    if (!board.view) return [];
    const seen = new Set<string>();
    const list: Asset[] = [];
    for (const id of board.selection) {
      const node = board.view.doc.nodes.find((item) => item.id === id);
      if (!node || node.type !== "image" || !node.assetId || seen.has(node.assetId)) continue;
      const asset = assets.get(node.assetId);
      if (!asset) continue;
      seen.add(node.assetId);
      list.push(asset);
    }
    return list;
  }, [assets, board.selection, board.view]);

  /** 素材抽屉只列出当前文档真的引用到的素材，避免显示已经删掉的节点留下的缓存 */
  const boardAssets = useMemo(() => {
    if (!board.view) return [];
    const seen = new Set<string>();
    const list: Asset[] = [];
    for (const node of board.view.doc.nodes) {
      if ((node.type !== "image" && node.type !== "video" && node.type !== "audio") || !node.assetId) continue;
      if (seen.has(node.assetId)) continue;
      seen.add(node.assetId);
      const asset = assets.get(node.assetId);
      if (asset) list.push(asset);
    }
    return list;
  }, [assets, board.view?.doc]);

  const pickImage = useCallback((nodeId: string | null) => {
    if (nodeId) {
      setReferenceTargetId(null);
      setAssetTargetId(nodeId);
      setAssetSearch("");
      const node = board.view?.doc.nodes.find((item) => item.id === nodeId);
      setAssetType(node?.type === "video" || node?.type === "audio" ? node.type : "image");
      setAssetDrawerOpen(true);
      return;
    }
    uploadTargetRef.current = null;
    if (fileInputRef.current) {
      fileInputRef.current.accept = "image/png,image/jpeg,image/webp";
      fileInputRef.current.multiple = true;
      fileInputRef.current.click();
    }
  }, [board.view]);

  const uploadMediaIntoNode = (nodeId: string) => {
    uploadTargetRef.current = nodeId;
    if (fileInputRef.current) {
      const target = board.view?.doc.nodes.find((node) => node.id === nodeId);
      fileInputRef.current.accept = target?.type === "video" ? "video/mp4,video/webm" : "image/png,image/jpeg,image/webp";
      fileInputRef.current.multiple = false;
      fileInputRef.current.click();
    }
  };

  const handleFiles = useCallback(async (files: File[], position?: { x: number; y: number }, targetNodeId: string | null = null) => {
    if (!files.length || !currentId) return;
    for (const [index, file] of files.entries()) {
      const targetId = index === 0 ? targetNodeId : null;
      if (targetId) {
        const target = board.view?.doc.nodes.find((node) => node.id === targetId);
        if (!target || (target.type !== "image" && target.type !== "video") || target.status === "loading") return;
        if (!file.type.startsWith(`${target.type}/`)) {
          onToast("error", target.type === "video" ? "请选择视频文件" : "请选择图片文件");
          return;
        }
        try {
          const asset = await api.uploadBoardAsset(currentId, file);
          const latest = activeViewRef.current;
          if (latest?.id !== currentId) return;
          setAssets((current) => new Map(current).set(asset.id, asset));
          const updatedTarget = latest.doc.nodes.find((node) => node.id === targetId);
          if (updatedTarget?.type !== target.type || updatedTarget.status === "loading" || updatedTarget.assetId !== target.assetId) {
            onToast("success", "图片已上传到素材库");
            return;
          }
          board.updateNode(targetId, { assetId: asset.id, source: "upload", status: "succeeded", error: undefined });
        } catch (error) {
          onToast("error", error instanceof Error ? error.message : "上传失败");
        }
      } else {
        const asset = await board.uploadAsset(file, position);
        if (asset) setAssets((current) => new Map(current).set(asset.id, asset));
      }
    }
  }, [board, currentId, onToast]);

  const exportBoard = useCallback(async (mode: "package" | "json") => {
    if (!board.view) return;
    const stamp = new Date().toISOString().slice(0, 10);
    const stem = (board.view.title || "无限画布").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
    const fileName = `${stem}-${stamp}.chatcanvas.${mode === "package" ? "zip" : "json"}`;
    try {
      if (!await board.ensureSaved()) throw new Error("请等待画布保存后再导出");
      const blob = mode === "package" ? await api.exportBoardPackage(board.view.id)
        : new Blob([JSON.stringify(createBoardExport(board.view.title, board.view.doc), null, 2)], { type: "application/json" });
      if (isTauriRuntime()) {
        const [{ save }, { writeFile }] = await Promise.all([
          import("@tauri-apps/plugin-dialog"),
          import("@tauri-apps/plugin-fs"),
        ]);
        const destination = await save({
          title: "导出无限画布",
          defaultPath: fileName,
          filters: [{ name: mode === "package" ? "画布工程包" : "画布结构", extensions: [mode === "package" ? "zip" : "json"] }],
        });
        if (!destination) return;
        await writeFile(destination, new Uint8Array(await blob.arrayBuffer()));
        onToast("success", "无限画布已导出");
      } else {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = fileName;
        anchor.style.display = "none";
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
        onToast("success", "无限画布已导出");
      }
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "导出失败");
    }
  }, [board.view, board.ensureSaved, onToast]);

  const importBoardFile = useCallback(async (file: File) => {
    try {
      if (/\.zip$/i.test(file.name)) {
        const result = await api.importBoardPackage(file);
        await refreshBoards();
        setCurrentId(result.board.id);
        onToast("success", `已导入 ${result.boards} 块画布和 ${result.media} 份素材`);
        return;
      }
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("文件不是合法的 JSON");
      }
      const result = await api.importBoard(parsed);
      await refreshBoards();
      setCurrentId(result.board.id);
      writeCurrentBoard(result.board.id);
      onToast("success", result.missingAssets.length
        ? `已导入，但有 ${result.missingAssets.length} 个素材在这台机器上找不到，相关节点已清空`
        : "无限画布已导入");
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "导入失败");
    }
  }, [onToast, refreshBoards]);

  const toggleHistory = useCallback(() => {
    setAssetDrawerOpen(false);
    setReferenceTargetId(null);
    setTemplateDrawerOpen(false);
    setHistoryBoardId((openId) => openId === currentId ? null : currentId);
  }, [currentId]);

  const toggleTemplates = useCallback(() => {
    setAssetDrawerOpen(false);
    setReferenceTargetId(null);
    setHistoryBoardId(null);
    setTemplateDrawerOpen((open) => !open);
  }, []);

  const reloadBoard = useCallback(() => { void board.reload(); }, [board.reload]);

  const handleBoardDelta = useCallback((delta?: BoardDelta) => {
    // 版本对不上 / 有本地未保存改动时，增量不能硬套，退回整份 reload
    if (!delta || !board.applyDelta(delta)) reloadBoard();
  }, [board.applyDelta, reloadBoard]);

  const generateNode = useCallback(async (nodeId: string) => {
    if (board.submitting) { onToast("error", "正在提交上一项生成，请稍候"); return; }
    const target = board.view?.doc.nodes.find((node) => node.id === nodeId);
    if (!target || target.type === "text") return;
    const kind = target.type === "config" ? target.mode : target.type;
    const label = kind === "video" ? "视频" : kind === "audio" ? "音频" : kind === "text" ? "文本" : "图片";
    const count = kind === "image" && (target.type === "config" || target.type === "image")
      ? target.count ?? 1 : 1;
    const model = target.model?.trim() || "当前默认模型";
    if (kind === "video" && board.view) {
      const alias = videoAliases.find((item) => item.alias === (target.model || defaultVideoAlias)) ?? videoAliases[0];
      const nodes = board.view.doc.edges.filter((edge) => edge.kind === "input" && edge.target === nodeId)
        .map((edge) => board.view!.doc.nodes.find((item) => item.id === edge.source))
        .filter((item): item is Extract<BoardNode, { type: "audio" | "video" }> => Boolean(item && (item.type === "audio" || item.type === "video")));
      try {
        for (const item of nodes) {
          const asset = item.assetId ? assets.get(item.assetId) : undefined;
          if (!asset) throw new Error(`节点 ${item.ref} 没有可用素材`);
          const duration = await readMediaDuration(asset.url, item.type);
          const { min, max } = item.type === "audio" && alias?.adapterType !== "minimax-video" ? { min: 0, max: 15 }
            : referenceVideoDurationRange(alias?.adapterType === "kling-video" ? "motion-control" : "reference", undefined, alias?.adapterType);
          if (duration <= 0 || duration < min || duration > max) throw new Error(`节点 ${item.ref} 的${item.type === "audio" ? "音频" : "视频"}时长须为 ${min}–${max} 秒`);
        }
      } catch (error) { onToast("error", error instanceof Error ? error.message : "读取素材失败"); return; }
    }
    const hasReferenceVideo = kind === "video" && board.view?.doc.edges.some((edge) => edge.kind === "input" && edge.target === nodeId && board.view?.doc.nodes.some((item) => item.id === edge.source && item.type === "video" && item.assetId));
    const detail = hasReferenceVideo ? "参考视频将上传到渠道图床，上传后可通过公网访问。" : count > 1 ? `将提交 ${count} 次独立生图请求` : undefined;
    if (!confirmGeneration({ kind: `${label}生成`, model, detail })) return;
    const inPlace = target.type !== "config";
    const result = await board.generate(nodeId);
    if (!result) return;
    if (result.kind === "text") {
      onToast("success", "文本已生成，结果节点在配置节点右侧");
    } else if (result.kind === "image" && result.resultNodeIds.length > 1) {
      const submitted = result.taskIds?.length ?? result.resultNodeIds.length;
      const failed = result.resultNodeIds.length - submitted;
      if (failed > 0) onToast("error", `已提交 ${submitted} 次，${failed} 次提交失败，请查看对应卡片`);
      else onToast("success", inPlace ? `已提交 ${submitted} 次，首张回填当前卡片，其余排在右侧` : `已提交 ${submitted} 次，结果排在配置节点右侧`);
    } else if (inPlace) {
      onToast("success", `已提交${result.kind === "video" ? "视频" : result.kind === "audio" ? "音频" : "图片"}任务，结果会回填当前节点`);
    } else if (result.kind === "video") {
      onToast("success", "已提交视频任务，结果会出现在配置节点右侧");
    } else if (result.kind === "audio") {
      onToast("success", "已提交音频任务，结果会出现在配置节点右侧");
    } else {
      onToast("success", `已提交 ${result.resultNodeIds.length} 张，结果会出现在配置节点右侧`);
    }
  }, [board, onToast, assets, videoAliases, defaultVideoAlias]);

  const extractFrame = useCallback(async (nodeId: string, createNext = false) => {
    if (extractingFrame || !board.view || !currentId) return;
    const node = board.view.doc.nodes.find((item) => item.id === nodeId);
    const asset = node?.type === "video" && node.assetId ? assets.get(node.assetId) : null;
    if (!node || node.type !== "video" || !asset) { onToast("error", "视频素材不存在"); return; }
    if (board.view.doc.nodes.length + (createNext ? 2 : 1) > BOARD_LIMITS.maxNodes) { onToast("error", "画布节点空间不足"); return; }
    setExtractingFrame(true);
    try {
      if (!await board.ensureSaved()) throw new Error("画布尚未保存，请稍后再试");
      const file = await extractVideoLastFrame(asset, 0);
      const frame = await api.uploadBoardAsset(currentId, file);
      const image = board.addImageNode(frame, { x: node.x + node.width + 100, y: node.y }, `${node.title || node.ref} · 尾帧`);
      if (!image) throw new Error("无法添加尾帧节点，请检查画布节点数量");
      setAssets((current) => new Map(current).set(frame.id, frame));
      if (createNext) {
        const next = board.addNode("video", { x: image.x + image.width + 96, y: image.y });
        if (!next || !board.addEdge(image.id, next.id, "input", "first-frame")) throw new Error("已提取尾帧，请手动连接下一镜");
        board.updateNode(next.id, { title: "下一镜", model: node.model, videoMode: "first-frame" });
        setFocusRequest({ boardId: currentId, nodeId: next.id });
        onToast("success", "已创建下一镜并连接尾帧作为首帧");
        return;
      }
      board.setSelection([image.id]);
      onToast("success", "已提取尾帧。请将它连接到下一镜视频并设为首帧；若已有首帧连线，先移除原连线。");
    } catch (error) { onToast("error", error instanceof Error ? error.message : "提取尾帧失败"); }
    finally { setExtractingFrame(false); }
  }, [assets, board, currentId, extractingFrame, onToast]);

  const handleFrameRequest = useCallback((request: { boardId: string; requestId: string; videoAssetId: string }) => {
    void (async () => {
      try {
        if (request.boardId !== currentId) return;
        if (!(await api.claimBoardFrame(request.boardId, request.requestId)).claimed) return;
        const asset = assets.get(request.videoAssetId);
        if (!asset || !asset.mimeType.startsWith("video/")) throw new Error("视频素材不存在或未加载");
        const file = await extractVideoLastFrame(asset, 0);
        const frame = await api.uploadBoardAsset(request.boardId, file);
        if (!await board.ensureSaved()) throw new Error("画布有未保存的修改，暂不能连接尾帧");
        setAssets((items) => new Map(items).set(frame.id, frame));
        await api.completeBoardFrame(request.boardId, request.requestId, { assetId: frame.id });
      } catch (error) {
        await api.completeBoardFrame(request.boardId, request.requestId, { error: error instanceof Error ? error.message : "尾帧提取失败" }).catch(() => undefined);
      }
    })();
  }, [assets, currentId, board]);

  const deleteNode = useCallback((nodeId: string) => {
    const node = board.view?.doc.nodes.find((item) => item.id === nodeId);
    if (node && (node.type === "image" || node.type === "video" || node.type === "audio") && node.assetId) {
      if (!window.confirm("删除这个节点？素材本身不会被删除。")) return;
    }
    board.removeNodes([nodeId]);
  }, [board]);

  const retryBoardTask = useCallback(async (taskId: string) => {
    try {
      const task = await api.task(taskId);
      if (confirmGeneration({ kind: "生成", model: task.model, channel: task.channelName, retry: true })) await board.retryTask(taskId);
    } catch (error) { onToast("error", error instanceof Error ? error.message : "读取任务失败"); }
  }, [board, onToast]);

  function startRun(ids: string[], mode: "selection" | "downstream") {
    if (!board.view || board.submitting || productionRun.running) {
      onToast("error", "已有任务正在提交，请等待或暂停现有计划");
      return;
    }
    const doc = board.view.doc;
    const steps = planBoardRun(doc, ids, mode).map((step) => {
      if (step.kind === "text") return step;
      const node = doc.nodes.find(({ id }) => id === step.nodeId);
      const music = node && "audioKind" in node && node.audioKind === "music";
      const candidates = step.kind === "image" ? imageAliases : step.kind === "video" ? videoAliases
        : audioAliases.filter((entry) => entry.adapterType === (music ? "suno-music" : "gemini-tts"));
      const fallback = step.kind === "image" ? defaultImageAlias : step.kind === "video" ? defaultVideoAlias : music ? defaultMusicAlias : defaultSpeechAlias;
      const model = matchModelAlias(candidates, step.model) ?? matchModelAlias(candidates, fallback) ?? candidates[0];
      return model ? { ...step, model: model.alias, modelLabel: model.model, channelId: model.channelId, channelName: model.channelName } : step;
    });
    if (!steps.length) { onToast("error", "所选范围内没有就绪的生成节点，请检查提示词和节点状态"); return; }
    const outstanding = productionRun.run?.steps.some(({ state }) => ["pending", "waiting", "choosing", "unknown"].includes(state));
    if (outstanding && !window.confirm("新计划会替换当前计划。已提交的任务仍可在请求记录里查看。继续？")) return;
    setRunDraft({ boardId: board.view.id, steps });
  }

  function locateNode(nodeId: string) {
    if (currentId) setFocusRequest({ boardId: currentId, nodeId });
  }

  function createResultBranch(nodeId: string) {
    const node = board.view?.doc.nodes.find((item) => item.id === nodeId);
    if (!node || node.type !== "image" || !node.assetId) return;
    const next = board.addNode("image", { x: node.x + node.width + 96, y: node.y + 65 });
    if (!next || !board.addEdge(node.id, next.id, "input", "reference")) return;
    board.updateNode(next.id, { title: `${node.title || "图片"} · 分支`.slice(0, 80), model: node.model });
    locateNode(next.id);
  }

  async function openNodeDiagnostic(id: string) {
    try { setDiagnosticTask(await api.task(id)); }
    catch (error) { runError(error instanceof Error ? error.message : "读取请求诊断失败"); }
  }

  async function retryRunTasks(taskIds: string[]) {
    if (productionRun.running || board.submitting) { runError("请先暂停计划并等当前提交结束"); return; }
    const safe: string[] = [];
    for (const id of taskIds) {
      try {
        const task = await api.task(id);
        if (taskIds.length === 1 || !["SUBMISSION_UNKNOWN", "REQUEST_TIMEOUT", "REQUEST_NETWORK_ERROR"].includes(task.errorCode ?? "")) safe.push(id);
      } catch (error) { onToast("error", error instanceof Error ? error.message : "任务读取失败"); }
    }
    if (safe.length < taskIds.length) onToast("error", "未确认上游结果的请求已跳过，请查看诊断后单独确认重试");
    if (!safe.length || !confirmGeneration({ kind: "画布生成", model: "沿用原任务", retry: true,
      detail: safe.length === 1 ? "请先核对渠道记录，确认需要补发这 1 项。" : `将重试 ${safe.length} 项。` })) return;
    const replacements = new Map<string, string>();
    for (const id of safe) {
      const result = await board.retryTask(id);
      if (result) replacements.set(id, result.taskId);
    }
    productionRun.applyRetries(replacements);
  }

  const rename = useCallback(() => {
    const value = titleDraft.trim();
    if (!value || !board.view || value === board.view.title) return;
    void board.rename(value).then(() => void refreshBoards());
  }, [board, refreshBoards, titleDraft]);

  const saveStatus = board.retrying ? "保存失败，重试中" : board.saving ? "保存中" : board.submitting ? "提交中" : null;

  return (
    <div className="board-workspace">
      <BoardSidebar
        host={sidebarHost}
        boards={boards.filter((item) => item.title.toLowerCase().includes(sidebarFilter.trim().toLowerCase()))}
        activeId={currentId}
        loading={boardsLoading}
        filter={sidebarFilter}
        onSelect={(id) => { setCurrentId(id); onBoardSelected(); }}
        onCreate={() => void createBoard(true)}
        onDelete={(id) => void removeBoard(id)}
      />

      <header className="board-topbar">
        <button type="button" className="board-back" data-sidebar-toggle onClick={onOpenMenu} aria-expanded={sidebarOpen} title={sidebarOpen ? "关闭工作区菜单" : "打开工作区菜单"} aria-label={sidebarOpen ? "关闭工作区菜单" : "打开工作区菜单"}>
          <Menu size={14} /><span>菜单</span>
        </button>
        <div className="board-topbar-identity">
          <input
            className="board-title"
            aria-label="画布名称"
            value={titleDraft}
            maxLength={80}
            placeholder="未命名无限画布"
            onChange={(event) => setTitleDraft(event.target.value)}
            onBlur={rename}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") { setTitleDraft(board.view?.title ?? ""); event.currentTarget.blur(); }
            }}
          />
          {saveStatus ? <span className="board-save-state" role="status" aria-label={saveStatus} title={saveStatus}>
            <LoadingIndicator variant="dots" size={24} /><span className="board-save-label">{saveStatus}</span>
          </span> : null}
        </div>
        <div className="board-topbar-actions">
          <div className="board-topbar-undo" role="group" aria-label="撤销与重做">
            <button type="button" className="secondary-button compact board-topbar-icon" disabled={!board.view?.canUndo} onClick={() => void board.undo()} title="撤销（Ctrl/Cmd + Z）" aria-label="撤销">
              <Undo2 size={15} />
            </button>
            <button type="button" className="secondary-button compact board-topbar-icon" disabled={!board.view?.canRedo} onClick={() => void board.redo()} title="重做（Ctrl/Cmd + Shift + Z）" aria-label="重做">
              <Redo2 size={15} />
            </button>
          </div>
          <button
            type="button"
            className={`secondary-button compact ${assetDrawerOpen ? "is-on" : ""}`}
            onClick={() => {
              setHistoryBoardId(null);
              setTemplateDrawerOpen(false);
              setAssetTargetId(null);
              setReferenceTargetId(null);
              setAssetSearch("");
              setAssetType("all");
              setAssetDrawerOpen((open) => !open);
            }}
            title="查看这块无限画布用到的素材"
            aria-label="素材"
          >
            <ImageIcon size={12} /><span>素材{boardAssets.length ? ` ${boardAssets.length}` : ""}</span>
          </button>
          <button type="button" className={`secondary-button compact board-topbar-icon ${commandPanel === "search" ? "is-on" : ""}`} title="查找节点" aria-label="查找节点"
            onClick={() => setCommandPanel((panel) => panel === "search" ? null : "search")}><Search size={14} /></button>
          <button type="button" className={`secondary-button compact ${commandPanel === "tasks" ? "is-on" : ""}`} title="画布任务" aria-label="画布任务"
            onClick={() => setCommandPanel((panel) => panel === "tasks" ? null : "tasks")}><Activity size={14} /><span>任务</span></button>
          {projectIds.length ? <button type="button" className={`secondary-button compact ${commandPanel === "production" ? "is-on" : ""}`} title="分镜制作" aria-label="分镜制作"
            onClick={() => setCommandPanel((panel) => panel === "production" ? null : "production")}><Clapperboard size={14} /><span>制作</span></button> : null}
          <BoardProjectMenu hasBoard={Boolean(board.view)} onHistory={toggleHistory} onTemplates={toggleTemplates}
            onImport={() => importInputRef.current?.click()} onExport={(mode) => void exportBoard(mode)} />
        </div>
      </header>

      <div className="board-stage">
        <BoardCanvas
          board={board}
          assets={assets}
          onPickImage={pickImage}
          onUploadMediaIntoNode={uploadMediaIntoNode}
          onUploadFiles={(files, position) => void handleFiles(files, position)}
          onPreviewAsset={setPreview}
          onDeleteNode={deleteNode}
          onCompareVersions={setVersionNodeId}
          onExtractFrame={(nodeId) => void extractFrame(nodeId)}
          onRun={startRun}
          focusRequest={focusRequest}
          onAddToReferenceGroup={selectedImageAssets.length ? () => setBridgeItems(selectedImageAssets.map((asset) => ({
            assetId: asset.id, title: asset.fileName.replace(/\.[^.]+$/, ""),
          }))) : undefined}
          onSaveTemplate={(ids) => {
            if (board.view) setTemplateDraft({ id: board.view.id, nodes: board.view.doc.nodes.filter((node) => ids.includes(node.id)) });
          }}
          renderNodeSettings={(selectedNode, locate) => board.view && (
            <BoardInspector
              view={board.view}
              node={selectedNode}
              submitting={board.submitting}
              assets={assets}
              imageAliases={imageAliases}
              defaultImageAlias={defaultImageAlias}
              videoAliases={videoAliases}
              defaultVideoAlias={defaultVideoAlias}
              audioAliases={audioAliases}
              defaultSpeechAlias={defaultSpeechAlias}
              defaultMusicAlias={defaultMusicAlias}
              onUpdateNode={board.updateNode}
              onUpdateEdge={(edgeId, patch) => { board.updateEdge(edgeId, patch); }}
              onConnectReference={(source, targetId, role) => board.addEdge(source.id, targetId, "input", role)}
              onLocateReference={locate}
              onRemoveReference={(edgeId) => board.removeEdges([edgeId])}
              onPickReference={(nodeId) => {
                setAssetTargetId(null);
                setReferenceTargetId(nodeId);
                setAssetSearch("");
                setAssetType("image");
                setAssetDrawerOpen(true);
              }}
              onDeleteNode={deleteNode}
              onPreview={setPreview}
              onPickImage={pickImage}
              onUploadMediaIntoNode={uploadMediaIntoNode}
              onRemoveAsset={(nodeId) => board.updateNode(nodeId, { assetId: null, status: "empty" } as Partial<BoardNode>)}
              onGenerate={(nodeId) => void generateNode(nodeId)}
              onStopTask={(taskId) => void board.cancelTask(taskId)}
              onRetryTask={(taskId) => void retryBoardTask(taskId)}
              onExtractFrame={(nodeId) => void extractFrame(nodeId)}
              onCompareVersions={setVersionNodeId}
              onDiagnostic={(id) => void openNodeDiagnostic(id)}
              onNextShot={(id) => void extractFrame(id, true)}
              onBranch={createResultBranch}
              onApplyStyle={(preset, nodeIds) => board.applyStyle(preset, nodeIds)}
              onClose={() => board.setSelection([])}
            />
          )}
        />
        {currentId && board.view?.id === currentId && commandPanel === "search" ? <BoardNodeSearch key={currentId} doc={board.view.doc}
          onLocate={locateNode} onClose={() => setCommandPanel(null)} /> : null}
        {currentId && board.view?.id === currentId && commandPanel === "tasks" ? <BoardTaskPanel key={`${currentId}:${runPanelVersion}`} boardId={currentId} nodes={board.view.doc.nodes} selection={board.selection}
          run={productionRun.run} running={productionRun.running} onPause={productionRun.pause} onResume={productionRun.resume} onChoose={productionRun.choose}
          onLocate={locateNode} onRetry={(ids) => void retryRunTasks(ids)} onStop={(id) => void board.cancelTask(id)} onClose={() => setCommandPanel(null)} /> : null}
        {currentId && board.view?.id === currentId && commandPanel === "production" ? <BoardProductionPanel key={currentId} boardId={currentId} boardVersion={board.view.version} projectIds={projectIds}
          onLocate={locateNode} onClose={() => setCommandPanel(null)} onBeforeWrite={board.ensureSaved}
          onSwitch={(id) => { void board.ensureSaved().then((ok) => { if (ok) setCurrentId(id); else runError("请等待画布保存后再切换"); }); }}
          onReview={(id) => { void board.ensureSaved().then((ok) => { if (ok) setReviewProject(id); else runError("请等待画布保存后再打开分镜审阅"); }); }}
          onRun={(ids) => startRun(ids, "selection")}
          onSync={(id, revision, shotIds) => board.updateDocumentOnServer(async (boardId, boardVersion) => {
            const result = await api.syncStoryboardReferences(id, boardId, { revision, boardVersion, shotIds });
            onToast("success", result.updated ? `已更新 ${result.updated} 处镜头引用` : "所选镜头引用已是最新");
            return result.board;
          })} /> : null}
      </div>

      {reviewProject ? <StoryboardReview id={reviewProject} onClose={() => { setReviewProject(null); if (!productionRun.running) void board.ensureSaved().then((ok) => { if (ok) void board.reload(); }); }}
        onToast={(kind, message) => onToast(kind === "ok" ? "success" : "error", message)}
        onImport={(templateId) => { void board.importTemplate(templateId).then((count) => {
          if (count !== null) { setReviewProject(null); onToast("success", `已导入 ${count} 个分镜节点`); }
        }); }} /> : null}
      {runDraft && runDraft.boardId === currentId ? <BoardRunReview steps={runDraft.steps} onClose={() => setRunDraft(null)} onStart={(steps, concurrency) => {
        productionRun.start(steps, concurrency);
        setRunDraft(null);
        setRunPanelVersion((version) => version + 1);
        setCommandPanel("tasks");
      }} /> : null}
      {templateDraft && templateDraft.id === currentId ? <BoardTemplateSaveDialog title={board.view?.title ?? ""} nodes={templateDraft.nodes} onClose={() => setTemplateDraft(null)}
        onSave={async (name, inputIds, outputIds) => {
          if (!await board.ensureSaved()) throw new Error("请等待画布保存后重试");
          await api.saveBoardSelectionTemplate(templateDraft.id, { name, nodeIds: templateDraft.nodes.map(({ id }) => id), inputIds, outputIds });
          setTemplateDraft(null);
          setTemplateDrawerOpen(true);
          onToast("success", "流程模板已保存");
        }} /> : null}
      {templateInput && templateInput.boardId === currentId ? <BoardTemplateInputDialog template={templateInput.template} assets={boardAssets} onClose={() => setTemplateInput(null)}
        onImport={async (values) => {
          const count = await board.importTemplate(templateInput.template.id, values);
          if (count === null) return false;
          setTemplateInput(null);
          setTemplateDrawerOpen(false);
          onToast("success", `已导入 ${count} 个流程节点`);
          return true;
        }} /> : null}

      <input
        ref={fileInputRef}
        className="file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          const targetId = uploadTargetRef.current;
          uploadTargetRef.current = null;
          if (files.length) void handleFiles(targetId ? files.slice(0, 1) : files, undefined, targetId);
        }}
      />

      <input
        ref={importInputRef}
        className="file-input"
        type="file"
        accept=".zip,.json,application/zip,application/json"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importBoardFile(file);
        }}
      />

      {board.view ? (
        <BoardAgentPanel
          key={board.view.threadId}
          threadId={board.view.threadId}
          initialUiState={agentUi ?? board.view.uiState.agent}
          onUiStateChange={(agent) => {
            if (!board.view) return;
            setAgentUi(agent);
            void api.saveBoardUiState(board.view.id, { agent }).catch(() => undefined);
          }}
          onToast={onToast}
          onBoardDelta={handleBoardDelta}
          onFrameRequest={handleFrameRequest}
          onBeforeSend={async () => { if (!await board.ensureSaved()) throw new Error("画布尚未保存，请稍后再发送给助手"); }}
          onImportTemplate={(id, name) => {
            void (async () => {
              const added = await board.importTemplate(id);
              if (added !== null) onToast("success", `已导入分镜「${name}」：新增 ${added} 个节点`);
            })();
          }}
        />
      ) : null}

      {bridgeItems?.length ? (
        <CrossModeBridgeDialog
          mode="to-canvas"
          items={bridgeItems}
          onClose={() => setBridgeItems(null)}
          onToast={onToast}
        />
      ) : null}

      <BoardTemplateDrawer
        open={templateDrawerOpen}
        onClose={() => setTemplateDrawerOpen(false)}
        onImport={board.importTemplate}
          onConfigure={(id) => {
            if (currentId) void api.template(id).then((template) => setTemplateInput({ boardId: currentId, template }))
              .catch((error) => runError(error instanceof Error ? error.message : "读取流程模板失败"));
          }}
        onBoardsChanged={refreshBoards}
        onToast={onToast}
      />

      {currentId ? (
        <BoardHistoryDrawer
          key={currentId}
          open={historyOpen}
          boardId={currentId}
          onClose={() => setHistoryBoardId(null)}
          onRestore={board.restoreVersion}
          onToast={onToast}
        />
      ) : null}

      {versionNodeId && currentId ? <BoardNodeVersions boardId={currentId} nodeId={versionNodeId} onClose={() => setVersionNodeId(null)} onApply={async (task, asset) => {
        const current = board.view?.doc.nodes.find((item) => item.id === versionNodeId);
        if (!current || current.type === "text" || current.type === "config" || current.status === "loading") throw new Error("节点不存在或正在生成");
        if (!await board.ensureSaved()) throw new Error("画布尚未保存，请稍后重试");
        await api.linkBoardAsset(currentId, asset.id);
        setAssets((items) => new Map(items).set(asset.id, asset));
        board.updateNode(versionNodeId, { assetId: asset.id, taskId: task.id, status: "succeeded" } as Partial<BoardNode>);
        onToast("success", "已切换节点素材；提示词和参数保持当前设置");
      }} /> : null}
      {diagnosticTask ? createPortal(<DiagnosticDialog task={diagnosticTask} onClose={() => setDiagnosticTask(null)} />, document.body) : null}
      {assetDrawerOpen ? <BoardMaterialDialog board={board} currentId={currentId} boardAssets={boardAssets} assetSearch={assetSearch} setAssetSearch={setAssetSearch} assetType={assetType} setAssetType={setAssetType} setAssets={setAssets} targetNodeId={assetTargetId}
        onUseReferenceImage={referenceTargetId ? async (asset) => {
          if (!currentId || !asset.mimeType.startsWith("image/")) return false;
          if (!await board.ensureSaved()) throw new Error("画布尚未保存，请稍后重试");
          if (activeViewRef.current?.id !== currentId) return false;
          await api.linkBoardAsset(currentId, asset.id);
          const latest = activeViewRef.current;
          if (latest?.id !== currentId) return false;
          const target = latest.doc.nodes.find((item) => item.id === referenceTargetId);
          if (!(target?.type === "video" || (target?.type === "config" && target.mode === "video"))) throw new Error("视频节点已变更，请重新选择");
          const inputCount = latest.doc.edges.filter((edge) => edge.kind === "input" && edge.target === target.id).length;
          const added = board.addImageNode(asset, { x: target.x - 400, y: target.y + 180 * inputCount }, undefined, target.id);
          if (!added) return false;
          setAssets((items) => new Map(items).set(asset.id, asset));
          return true;
        } : undefined}
        onPreview={setPreview} previewOpen={Boolean(preview)} onClose={() => { setAssetDrawerOpen(false); setAssetTargetId(null); setReferenceTargetId(null); }} onToast={onToast} /> : null}

      {preview ? (
        <AssetLightbox
          assetId={preview.id}
          asset={preview}
          onClose={() => setPreview(null)}
          onToast={(kind, text) => onToast(kind === "ok" ? "success" : "error", text)}
        />
      ) : null}
    </div>
  );
}
