/**
 * 无限画布工作区：独立于对话的整页画布 + 右侧检查器 + 侧栏无限画布列表。
 *
 * 侧栏列表 portal 到 App 的「最近」位置，和对话列表复用同一套视觉，
 * 但两者的数据、线程、素材完全独立。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bot, Check, Download, FileUp, History, Image as ImageIcon, LayoutTemplate, LoaderCircle, Menu,
  Pencil, Plus, Redo2, Trash2, Undo2, Upload, X,
} from "lucide-react";
import { api, isTauriRuntime } from "../api";
import { confirmGeneration } from "../generation-confirm";
import { AssetLightbox } from "../chat/AssetLightbox";
import {
  createBoardExport, type BoardAgentUiState, type BoardDelta, type BoardNode, type BoardSummary,
} from "../../shared/board";
import type { CanvasTemplateSummary } from "../../shared/canvas-template";
import type { Asset } from "../../shared/types";
import { BoardAgentPanel } from "./BoardAgentPanel";
import { BoardCanvas } from "./BoardCanvas";
import { BoardMaterialDialog } from "./BoardMaterialDialog";
import { CrossModeBridgeDialog, type BridgeAssetItem } from "./CrossModeBridgeDialog";
import { BoardInspector, type BoardImageAlias, type BoardVideoAlias } from "./BoardInspector";
import { useBoard } from "./useBoard";

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

function historyReasonLabel(reason: string): string {
  if (!reason || reason === "manual" || reason === "update") return reason === "update" ? "编辑节点" : "手动保存";
  if (reason === "import") return "导入";
  if (reason === "auto-layout") return "自动排版";
  if (reason === "delete") return "删除节点";
  if (reason === "duplicate") return "复制节点";
  if (reason === "move") return "移动节点";
  if (reason === "connect") return "新增连线";
  if (reason === "disconnect") return "删除连线";
  if (reason === "generate:result") return "生成结果回填";
  if (reason === "generate:retry") return "重试生成";
  if (reason === "generate:cancel") return "停止生成";
  if (reason.startsWith("add:")) return "添加节点";
  if (reason.startsWith("generate:")) return `生成 ${reason.slice("generate:".length)}`;
  if (reason.startsWith("agent:")) return "无限画布助手修改";
  if (reason.startsWith("restore:")) return `恢复自版本 ${reason.slice("restore:".length)}`;
  if (reason.startsWith("asset:")) return "移除素材";
  if (reason.startsWith("edge:")) return "修改连线角色";
  if (reason.startsWith("group:")) return "分组调整";
  return reason.slice(0, 40);
}

function historyTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function BoardSidebar({
  host, boards, activeId, loading, onSelect, onCreate, onDelete,
}: {
  host: HTMLElement | null;
  boards: BoardSummary[];
  activeId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
}) {
  if (!host) return null;
  return createPortal(
    <div className="sidebar-group">
      <div className="sidebar-group-title">
        <span>无限画布</span>
        <button type="button" className="sidebar-group-add" aria-label="新建无限画布" data-tooltip="新建无限画布" onClick={onCreate}>
          <Plus size={13} />
        </button>
      </div>
      <div className="sidebar-conv-list">
        {loading && !boards.length ? (
          <div className="board-sidebar-empty"><LoaderCircle size={12} className="spin" />加载中…</div>
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
          <div className="board-sidebar-empty">还没有无限画布</div>
        ) : null}
      </div>
    </div>,
    host,
  );
}

export function BoardWorkspace({
  sidebarHost, onOpenMenu, onToast,
}: {
  sidebarHost: HTMLElement | null;
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
  const [imageAliases, setImageAliases] = useState<BoardImageAlias[]>([]);
  const [videoAliases, setVideoAliases] = useState<BoardVideoAlias[]>([]);
  const [audioAliases, setAudioAliases] = useState<BoardImageAlias[]>([]);
  const [defaultImageAlias, setDefaultImageAlias] = useState("");
  const [defaultVideoAlias, setDefaultVideoAlias] = useState("");
  const [defaultSpeechAlias, setDefaultSpeechAlias] = useState("");
  const [defaultMusicAlias, setDefaultMusicAlias] = useState("");
  const [preview, setPreview] = useState<Asset | null>(null);
  const [agentOpen, setAgentOpen] = useState(true);
  const [agentUi, setAgentUi] = useState<BoardAgentUiState | undefined>(undefined);
  const [assetDrawerOpen, setAssetDrawerOpen] = useState(false);
  const [assetTargetId, setAssetTargetId] = useState<string | null>(null);
  const [assetSearch, setAssetSearch] = useState("");
  const [assetType, setAssetType] = useState<"all" | "image" | "video" | "audio">("all");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [bridgeItems, setBridgeItems] = useState<BridgeAssetItem[] | null>(null);
  const [templateDrawerOpen, setTemplateDrawerOpen] = useState(false);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templates, setTemplates] = useState<CanvasTemplateSummary[]>([]);
  const [importingTemplateId, setImportingTemplateId] = useState<string | null>(null);
  const [renamingTemplateId, setRenamingTemplateId] = useState<string | null>(null);
  const [templateNameDraft, setTemplateNameDraft] = useState("");
  const [migratingStoryboards, setMigratingStoryboards] = useState(false);
  const [cleaningStoryboards, setCleaningStoryboards] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<Array<{
    version: number; reason: string; createdAt: string; current: boolean;
  }>>([]);
  const [restoringVersion, setRestoringVersion] = useState<number | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const uploadTargetRef = useRef<string | null>(null);
  /** React StrictMode 在开发环境会把挂载 effect 跑两遍；不能因此建两块空板 */
  const initializedRef = useRef(false);

  const board = useBoard(currentId, onToast);

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

  const createBoard = useCallback(async () => {
    try {
      const created = await api.createBoard({ title: "未命名无限画布" });
      setCurrentId(created.id);
      writeCurrentBoard(created.id);
      await refreshBoards();
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "新建无限画布失败");
    }
  }, [onToast, refreshBoards]);

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

  useEffect(() => {
    // 切板后历史列表属于上一块板，关掉抽屉，下一次打开再拉
    setHistoryOpen(false);
    setHistoryEntries([]);
  }, [currentId]);

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

  const selectedNode = useMemo(() => {
    if (!board.view || board.selection.length !== 1) return null;
    const id = board.selection[0];
    return board.view.doc.nodes.find((node) => node.id === id) ?? null;
  }, [board.selection, board.view]);

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
      setAssetTargetId(nodeId);
      setAssetSearch("");
      const node = board.view?.doc.nodes.find((item) => item.id === nodeId);
      setAssetType(node?.type === "video" || node?.type === "audio" ? node.type : "image");
      setAssetDrawerOpen(true);
      return;
    }
    uploadTargetRef.current = nodeId;
    fileInputRef.current?.click();
  }, [board.view]);

  const handleFiles = useCallback(async (files: File[], position?: { x: number; y: number }) => {
    if (!files.length || !currentId) return;
    for (const [index, file] of files.entries()) {
      const targetId = index === 0 ? uploadTargetRef.current : null;
      if (targetId) {
        try {
          const asset = await api.uploadBoardAsset(currentId!, file);
          setAssets((current) => new Map(current).set(asset.id, asset));
          board.updateNode(targetId, { assetId: asset.id, source: "upload", status: "succeeded" } as Partial<BoardNode>);
        } catch (error) {
          onToast("error", error instanceof Error ? error.message : "上传失败");
        }
      } else {
        const asset = await board.uploadAsset(file, position);
        if (asset) setAssets((current) => new Map(current).set(asset.id, asset));
      }
    }
    uploadTargetRef.current = null;
  }, [board, currentId, onToast]);

  const exportBoard = useCallback(async () => {
    if (!board.view) return;
    const data = createBoardExport(board.view.title, board.view.doc);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const stamp = new Date().toISOString().slice(0, 10);
    const stem = (board.view.title || "无限画布").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60);
    const fileName = `${stem}-${stamp}.chatcanvas.json`;
    try {
      if (isTauriRuntime()) {
        const [{ save }, { writeFile }] = await Promise.all([
          import("@tauri-apps/plugin-dialog"),
          import("@tauri-apps/plugin-fs"),
        ]);
        const destination = await save({
          title: "导出无限画布",
          defaultPath: fileName,
          filters: [{ name: "无限画布", extensions: ["json"] }],
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
  }, [board.view, onToast]);

  const importBoardFile = useCallback(async (file: File) => {
    try {
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

  const refreshHistory = useCallback(async () => {
    const id = currentId;
    if (!id) return;
    setHistoryLoading(true);
    try {
      const result = await api.boardHistory(id);
      setHistoryEntries(result.entries);
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "创作历史加载失败");
    } finally {
      setHistoryLoading(false);
    }
  }, [currentId, onToast]);

  const toggleHistory = useCallback(() => {
    setAssetDrawerOpen(false);
    setTemplateDrawerOpen(false);
    setHistoryOpen((open) => {
      if (!open) void refreshHistory();
      return !open;
    });
  }, [refreshHistory]);

  const refreshTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    try {
      setTemplates(await api.templates());
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "模板列表加载失败");
    } finally {
      setTemplatesLoading(false);
    }
  }, [onToast]);

  const toggleTemplates = useCallback(() => {
    setAssetDrawerOpen(false);
    setHistoryOpen(false);
    setTemplateDrawerOpen((open) => {
      if (!open) void refreshTemplates();
      return !open;
    });
  }, [refreshTemplates]);

  const importTemplate = useCallback(async (template: CanvasTemplateSummary) => {
    setImportingTemplateId(template.id);
    try {
      const added = await board.importTemplate(template.id);
      if (added !== null) {
        onToast("success", `已导入模板「${template.name}」：新增 ${added} 个节点`);
        setTemplateDrawerOpen(false);
        await refreshTemplates();
      }
    } finally {
      setImportingTemplateId(null);
    }
  }, [board, onToast, refreshTemplates]);

  const commitTemplateRename = useCallback(async (template: CanvasTemplateSummary) => {
    const name = templateNameDraft.trim();
    setRenamingTemplateId(null);
    if (!name || name === template.name) return;
    try {
      await api.updateTemplate(template.id, { name });
      await refreshTemplates();
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "重命名模板失败");
    }
  }, [onToast, refreshTemplates, templateNameDraft]);

  const removeTemplate = useCallback(async (template: CanvasTemplateSummary) => {
    if (!window.confirm(`删除模板「${template.name}」？已经导入画布的节点不受影响。`)) return;
    try {
      await api.deleteTemplate(template.id);
      await refreshTemplates();
      onToast("success", "模板已删除");
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "删除模板失败");
    }
  }, [onToast, refreshTemplates]);

  const migrateStoryboards = useCallback(async () => {
    if (!window.confirm("把旧分镜迁移成无限画布？会包含角色 / 场景设定参考；上一次迁移生成的旧版画布会升级重建，旧分镜数据仍在。")) return;
    setMigratingStoryboards(true);
    try {
      const result = await api.migrateStoryboards({ replaceExisting: true });
      await refreshTemplates();
      await refreshBoards();
      const failed = result.failed.length ? `，${result.failed.length} 个失败` : "";
      onToast(
        result.failed.length ? "error" : "success",
        `已迁移 ${result.migrated.length} 个会话${result.skipped ? `，跳过 ${result.skipped} 个已迁移` : ""}${failed}；新画布已出现在侧栏`,
      );
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "迁移旧分镜失败");
    } finally {
      setMigratingStoryboards(false);
    }
  }, [onToast, refreshBoards, refreshTemplates]);

  const cleanupStoryboards = useCallback(async () => {
    if (!window.confirm("删除已迁移会话的旧分镜表？迁移画布和模板不受影响，但旧分镜入口的数据将无法恢复。")) return;
    setCleaningStoryboards(true);
    try {
      const result = await api.cleanupStoryboards();
      onToast("success", `已清理 ${result.cleaned.length} 个会话的旧分镜${result.skipped ? `，跳过 ${result.skipped} 个` : ""}`);
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "清理旧分镜失败");
    } finally {
      setCleaningStoryboards(false);
    }
  }, [onToast]);

  const restoreHistory = useCallback(async (version: number) => {
    if (!window.confirm(`恢复到版本 ${version}？当前内容会作为新版本保留在历史里，可以撤销。`)) return;
    setRestoringVersion(version);
    try {
      await board.restoreVersion(version);
      await refreshHistory();
    } finally {
      setRestoringVersion(null);
    }
  }, [board, refreshHistory]);

  const reloadBoard = useCallback(() => { void board.reload(); }, [board.reload]);

  const handleBoardDelta = useCallback((delta?: BoardDelta) => {
    // 版本对不上 / 有本地未保存改动时，增量不能硬套，退回整份 reload
    if (!delta || !board.applyDelta(delta)) reloadBoard();
  }, [board.applyDelta, reloadBoard]);

  const generateNode = useCallback(async (nodeId: string) => {
    const target = board.view?.doc.nodes.find((node) => node.id === nodeId);
    if (!target || target.type === "text") return;
    const kind = target.type === "config" ? target.mode : target.type;
    const label = kind === "video" ? "视频" : kind === "audio" ? "音频" : kind === "text" ? "文本" : "图片";
    const count = target.type === "config" && kind === "image" ? target.count : 1;
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
          const min = item.type === "audio" ? 0 : alias?.adapterType === "kling-video" ? 3 : 1;
          const max = item.type === "audio" ? 15 : alias?.adapterType === "kling-video" ? 30 : 15;
          if (duration <= 0 || duration < min || duration > max) throw new Error(`节点 ${item.ref} 的${item.type === "audio" ? "音频" : "视频"}时长须为 ${min}–${max} 秒`);
        }
      } catch (error) { onToast("error", error instanceof Error ? error.message : "读取素材失败"); return; }
    }
    const hasReferenceVideo = kind === "video" && board.view?.doc.edges.some((edge) => edge.kind === "input" && edge.target === nodeId && board.view?.doc.nodes.some((item) => item.id === edge.source && item.type === "video" && item.assetId));
    const detail = hasReferenceVideo ? "参考视频将上传到渠道图床，上传后可通过公网访问。" : count > 1 ? `请求数量：${count} 张` : undefined;
    if (!confirmGeneration({ kind: `${label}生成`, model, detail })) return;
    const inPlace = target.type !== "config";
    const result = await board.generate(nodeId);
    if (!result) return;
    if (result.kind === "text") {
      onToast("success", "文本已生成，结果节点在配置节点右侧");
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

  const rename = useCallback(() => {
    const value = titleDraft.trim();
    if (!value || !board.view || value === board.view.title) return;
    void board.rename(value).then(() => void refreshBoards());
  }, [board, refreshBoards, titleDraft]);

  return (
    <div className="board-workspace">
      <BoardSidebar
        host={sidebarHost}
        boards={boards}
        activeId={currentId}
        loading={boardsLoading}
        onSelect={(id) => { setCurrentId(id); }}
        onCreate={() => void createBoard()}
        onDelete={(id) => void removeBoard(id)}
      />

      <header className="board-topbar">
        <button type="button" className="board-back" onClick={onOpenMenu} title="打开工作区菜单" aria-label="打开工作区菜单">
          <Menu size={14} /><span>菜单</span>
        </button>
        <input
          className="board-title"
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
        <div className="board-topbar-actions">
          <button
            type="button"
            className={`secondary-button compact ${historyOpen ? "is-on" : ""}`}
            onClick={toggleHistory}
            title="查看创作历史"
          >
            <History size={12} /><span className="board-history-label">创作历史</span>
          </button>
          <button
            type="button"
            className={`secondary-button compact ${templateDrawerOpen ? "is-on" : ""}`}
            onClick={toggleTemplates}
            title="查看对话里生成过的画布模板"
          >
            <LayoutTemplate size={12} /><span>模板</span>
          </button>
          <button
            type="button"
            className="secondary-button compact"
            disabled={!selectedImageAssets.length}
            title={selectedImageAssets.length
              ? "把选中的图片加入某个对话的参考图组"
              : "先选中至少一个已经绑定图片的节点"}
            onClick={() => setBridgeItems(selectedImageAssets.map((asset) => ({
              assetId: asset.id,
              title: asset.fileName.replace(/\.[^.]+$/, ""),
            })))}
          >
            <ImageIcon size={12} /><span>参考图组</span>
          </button>
          <button type="button" className="secondary-button compact" disabled={!board.view?.canUndo} onClick={() => void board.undo()} title="撤销（Ctrl/Cmd + Z）">
            <Undo2 size={12} /><span>撤销</span>
          </button>
          <button type="button" className="secondary-button compact" disabled={!board.view?.canRedo} onClick={() => void board.redo()} title="重做（Ctrl/Cmd + Shift + Z）">
            <Redo2 size={12} /><span>重做</span>
          </button>
          <span className={`board-save-state ${board.saving || board.retrying ? "is-saving" : ""}`}>
            {board.retrying
              ? <><LoaderCircle size={11} className="spin" />重试中</>
              : board.saving
                ? <><LoaderCircle size={11} className="spin" />保存中</>
                : <><Check size={11} />已保存</>}
          </span>
          <button
            type="button"
            className={`secondary-button compact board-action-primary ${assetDrawerOpen ? "is-on" : ""}`}
            onClick={() => {
              setHistoryOpen(false);
              setTemplateDrawerOpen(false);
              setAssetTargetId(null);
              setAssetDrawerOpen((open) => !open);
            }}
            title="查看这块无限画布用到的素材"
          >
            <ImageIcon size={12} /><span>素材{boardAssets.length ? ` ${boardAssets.length}` : ""}</span>
          </button>
          <button type="button" className="secondary-button compact board-action-primary" onClick={() => pickImage(null)} title="上传图片到无限画布">
            <Upload size={12} /><span>上传图片</span>
          </button>
          <button
            type="button"
            className="secondary-button compact"
            title="导入无限画布（JSON）"
            aria-label="导入无限画布"
            onClick={() => importInputRef.current?.click()}
          >
            <FileUp size={13} /><span>导入</span>
          </button>
          <button
            type="button"
            className="secondary-button compact"
            title="导出无限画布（JSON）"
            aria-label="导出无限画布"
            onClick={() => void exportBoard()}
          >
            <Download size={13} /><span>导出</span>
          </button>
          <button
            type="button"
            className={`secondary-button compact board-action-primary ${agentOpen ? "is-on" : ""}`}
            onClick={() => setAgentOpen((open) => !open)}
            title={agentOpen ? "收起无限画布助手" : "打开无限画布助手"}
          >
            <Bot size={12} /><span>助手</span>
          </button>
        </div>
      </header>

      <div className="board-stage">
        <BoardCanvas
          board={board}
          assets={assets}
          onPickImage={pickImage}
          onUploadFiles={(files, position) => void handleFiles(files, position)}
          onPreviewAsset={setPreview}
          onGenerate={(nodeId) => void generateNode(nodeId)}
          onStopTask={(taskId) => void board.cancelTask(taskId)}
          onRetryTask={(taskId) => void retryBoardTask(taskId)}
        />
        {selectedNode ? (
          <BoardInspector
            view={board.view!}
            node={selectedNode}
            selectedCount={board.selection.length}
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
            onDeleteNode={deleteNode}
            onPreview={setPreview}
            onPickImage={pickImage}
            onRemoveAsset={(nodeId) => board.updateNode(nodeId, { assetId: null, status: "empty" } as Partial<BoardNode>)}
            onGenerate={(nodeId) => void generateNode(nodeId)}
            onStopTask={(taskId) => void board.cancelTask(taskId)}
            onRetryTask={(taskId) => void retryBoardTask(taskId)}
            onClose={() => board.setSelection([])}
          />
        ) : null}
      </div>

      <input
        ref={fileInputRef}
        className="file-input"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length) void handleFiles(files);
        }}
      />

      <input
        ref={importInputRef}
        className="file-input"
        type="file"
        accept=".json,application/json"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importBoardFile(file);
        }}
      />

      {agentOpen && board.view ? (
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
          onBeforeSend={() => board.flush()}
          onClose={() => setAgentOpen(false)}
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

      {templateDrawerOpen ? (
        <aside className="board-asset-drawer board-template-drawer" aria-label="画布模板">
          <header className="board-asset-head">
            <div>
              <strong>画布模板</strong>
              <span>对话和分镜生成的模板 · 导入后不会自动生成</span>
            </div>
            <button type="button" className="icon-button compact" aria-label="关闭模板抽屉" onClick={() => setTemplateDrawerOpen(false)}>
              <X size={14} />
            </button>
          </header>
          <div className="board-template-list">
            {templatesLoading ? (
              <p className="board-asset-empty"><LoaderCircle size={12} className="spin" />正在读取模板…</p>
            ) : null}
            {!templatesLoading && templates.map((template) => (
              <article key={template.id} className="board-template-row">
                <span className="board-template-icon"><LayoutTemplate size={15} /></span>
                <div className="board-template-main">
                  {renamingTemplateId === template.id ? (
                    <input
                      value={templateNameDraft}
                      autoFocus
                      maxLength={80}
                      aria-label="模板名称"
                      onChange={(event) => setTemplateNameDraft(event.target.value)}
                      onBlur={() => void commitTemplateRename(template)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") {
                          setRenamingTemplateId(null);
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  ) : (
                    <strong
                      title={`${template.name}${template.description ? `\n${template.description}` : ""}`}
                      onDoubleClick={() => {
                        setRenamingTemplateId(template.id);
                        setTemplateNameDraft(template.name);
                      }}
                    >
                      {template.name}
                    </strong>
                  )}
                  <span>
                    {template.source === "storyboard" ? "分镜" : template.source === "import" ? "导入" : "对话"}
                    {" · "}{template.nodeCount} 节点
                    {template.groupCount ? ` · ${template.groupCount} 分组` : ""}
                  </span>
                  <time>{historyTime(template.createdAt)}</time>
                </div>
                <div className="board-template-actions">
                  <button
                    type="button"
                    className="icon-button compact"
                    title="重命名模板"
                    aria-label="重命名模板"
                    onClick={() => {
                      setRenamingTemplateId(template.id);
                      setTemplateNameDraft(template.name);
                    }}
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    type="button"
                    className="icon-button compact danger"
                    title="删除模板"
                    aria-label="删除模板"
                    onClick={() => void removeTemplate(template)}
                  >
                    <Trash2 size={11} />
                  </button>
                  <button
                    type="button"
                    className="secondary-button compact"
                    disabled={importingTemplateId !== null}
                    onClick={() => void importTemplate(template)}
                  >
                    {importingTemplateId === template.id ? <LoaderCircle size={11} className="spin" /> : null}
                    放入画布
                  </button>
                </div>
              </article>
            ))}
            {!templatesLoading && !templates.length ? (
              <p className="board-asset-empty">
                还没有模板。在对话里让助手「做一个画布模板」或「拆成分镜」，生成后点工具卡上的「导入无限画布」；也可以在这里再次导入。
              </p>
            ) : null}
          </div>
          <footer className="board-template-foot">
            <span>旧分镜入口已隐藏，可以迁移成画布继续使用；原数据不会删除。</span>
            <div className="board-template-foot-actions">
              <button
                type="button"
                className="secondary-button compact"
                disabled={migratingStoryboards || cleaningStoryboards}
                onClick={() => void migrateStoryboards()}
              >
                {migratingStoryboards ? <LoaderCircle size={11} className="spin" /> : <History size={11} />}
                迁移旧分镜
              </button>
              <button
                type="button"
                className="secondary-button compact is-danger"
                disabled={migratingStoryboards || cleaningStoryboards}
                onClick={() => void cleanupStoryboards()}
              >
                {cleaningStoryboards ? <LoaderCircle size={11} className="spin" /> : <Trash2 size={11} />}
                删除旧分镜数据
              </button>
            </div>
          </footer>
        </aside>
      ) : null}

      {historyOpen ? (
        <aside className="board-asset-drawer board-history-drawer" aria-label="创作历史">
          <header className="board-asset-head">
            <div>
              <strong>创作历史</strong>
              <span>{historyEntries.length} 个版本 · 最多保留 50 个</span>
            </div>
            <button type="button" className="icon-button compact" aria-label="关闭创作历史" onClick={() => setHistoryOpen(false)}>
              <X size={14} />
            </button>
          </header>
          <div className="board-history-list">
            {historyLoading ? (
              <p className="board-asset-empty"><LoaderCircle size={12} className="spin" />正在读取历史…</p>
            ) : null}
            {!historyLoading && historyEntries.map((entry) => (
              <article key={entry.version} className={`board-history-row ${entry.current ? "is-current" : ""}`}>
                <div className="board-history-main">
                  <div>
                    <strong>版本 {entry.version}</strong>
                    {entry.current ? <em>当前</em> : null}
                  </div>
                  <span>{historyReasonLabel(entry.reason)}</span>
                  <time>{historyTime(entry.createdAt)}</time>
                </div>
                {entry.current ? null : (
                  <button
                    type="button"
                    className="secondary-button compact"
                    disabled={restoringVersion !== null}
                    onClick={() => void restoreHistory(entry.version)}
                  >
                    {restoringVersion === entry.version ? <LoaderCircle size={11} className="spin" /> : null}
                    恢复
                  </button>
                )}
              </article>
            ))}
            {!historyLoading && !historyEntries.length ? (
              <p className="board-asset-empty">还没有历史版本。第一次修改后这里会出现快照。</p>
            ) : null}
          </div>
        </aside>
      ) : null}

      {assetDrawerOpen ? <BoardMaterialDialog board={board} currentId={currentId} boardAssets={boardAssets} assetSearch={assetSearch} setAssetSearch={setAssetSearch} assetType={assetType} setAssetType={setAssetType} setAssets={setAssets} targetNodeId={assetTargetId} onPreview={setPreview} onClose={() => { setAssetDrawerOpen(false); setAssetTargetId(null); }} onToast={onToast} /> : null}

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
