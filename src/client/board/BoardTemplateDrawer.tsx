import { useCallback, useEffect, useRef, useState } from "react";
import { History, LayoutTemplate, LoaderCircle, Pencil, Trash2, X } from "lucide-react";
import type { CanvasTemplateSummary } from "../../shared/canvas-template";
import { api } from "../api";
import { historyTime } from "./board-history";

export function BoardTemplateDrawer({
  open, onClose, onImport, onBoardsChanged, onToast,
}: {
  open: boolean;
  onClose: () => void;
  onImport: (id: string) => Promise<number | null>;
  onBoardsChanged: () => Promise<unknown>;
  onToast: (kind: "success" | "error", message: string) => void;
}) {
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templates, setTemplates] = useState<CanvasTemplateSummary[]>([]);
  const [importingTemplateId, setImportingTemplateId] = useState<string | null>(null);
  const [renamingTemplateId, setRenamingTemplateId] = useState<string | null>(null);
  const [templateNameDraft, setTemplateNameDraft] = useState("");
  const [migratingStoryboards, setMigratingStoryboards] = useState(false);
  const [cleaningStoryboards, setCleaningStoryboards] = useState(false);
  const requestRef = useRef(0);
  const toastRef = useRef(onToast);
  useEffect(() => { toastRef.current = onToast; }, [onToast]);

  const refreshTemplates = useCallback(async () => {
    const request = ++requestRef.current;
    setTemplatesLoading(true);
    try {
      const next = await api.templates();
      if (request === requestRef.current) setTemplates(next);
    } catch (error) {
      if (request === requestRef.current) toastRef.current("error", error instanceof Error ? error.message : "模板列表加载失败");
    } finally {
      if (request === requestRef.current) setTemplatesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void refreshTemplates();
  }, [open, refreshTemplates]);

  const importTemplate = useCallback(async (template: CanvasTemplateSummary) => {
    setImportingTemplateId(template.id);
    try {
      const added = await onImport(template.id);
      if (added !== null) {
        onToast("success", `已导入模板「${template.name}」：新增 ${added} 个节点`);
        onClose();
        await refreshTemplates();
      }
    } finally {
      setImportingTemplateId(null);
    }
  }, [onClose, onImport, onToast, refreshTemplates]);

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
      await onBoardsChanged();
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
  }, [onBoardsChanged, onToast, refreshTemplates]);

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

  if (!open) return null;
  return (
    <aside className="board-asset-drawer board-template-drawer" aria-label="画布模板">
      <header className="board-asset-head">
        <div>
          <strong>画布模板</strong>
          <span>对话和分镜生成的模板 · 导入后不会自动生成</span>
        </div>
        <button type="button" className="icon-button compact" aria-label="关闭模板抽屉" onClick={onClose}>
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
  );
}
