/**
 * 把对话里生成的模板导入无限画布。
 *
 * 只负责选目标板 / 新建板；模板实例化在服务端完成，不会自动触发生成。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, LayoutGrid, LoaderCircle, Plus, X } from "lucide-react";
import { api } from "../api";
import type { BoardSummary } from "../../shared/board";

export function TemplateImportDialog({
  templateId, templateName, templateDescription, onClose, onToast, onImported,
}: {
  templateId: string;
  templateName: string;
  templateDescription?: string;
  onClose: () => void;
  onToast: (kind: "success" | "error", message: string) => void;
  onImported?: (boardId: string) => void;
}) {
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.boards().then((list) => {
      if (!cancelled) setBoards(list);
    }).catch((error: unknown) => {
      if (!cancelled) onToast("error", error instanceof Error ? error.message : "无限画布列表加载失败");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [onToast]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const importInto = async (board: BoardSummary) => {
    setBusy(board.id);
    try {
      const result = await api.importTemplateToBoard(board.id, templateId);
      onToast("success", `已把模板「${templateName}」导入《${board.title}》：新增 ${result.addedNodes} 个节点`);
      onImported?.(result.board.id);
      onClose();
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "导入模板失败");
    } finally {
      setBusy(null);
    }
  };

  const createAndImport = async () => {
    setBusy("__new__");
    try {
      const board = await api.createBoardFromTemplate(templateId, templateName);
      onToast("success", `已新建《${board.title}》并导入模板`);
      onImported?.(board.id);
      onClose();
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "新建并导入模板失败");
    } finally {
      setBusy(null);
    }
  };

  return createPortal(
    <div className="board-bridge-overlay" role="presentation" onClick={() => { if (!busy) onClose(); }}>
      <section
        className="board-bridge-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="导入画布模板"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="board-bridge-head">
          <div>
            <strong>导入画布模板</strong>
            <span>{templateDescription || "模板只排节点和提示词，不会自动生成图片或视频。"}</span>
          </div>
          <button type="button" className="icon-button compact" aria-label="关闭" onClick={onClose} disabled={Boolean(busy)}>
            <X size={14} />
          </button>
        </header>

        <div className="board-bridge-summary">
          <LayoutGrid size={13} />
          <span>模板「{templateName}」</span>
        </div>

        <div className="board-bridge-list">
          {loading ? <p className="board-bridge-empty"><LoaderCircle size={13} className="spin" />正在读取无限画布…</p> : null}
          {!loading && boards.map((board) => (
            <button
              key={board.id}
              type="button"
              className="board-bridge-target"
              disabled={Boolean(busy)}
              onClick={() => void importInto(board)}
            >
              <LayoutGrid size={14} />
              <span className="board-bridge-target-text">
                <strong>{board.title}</strong>
                <em>{board.nodeCount} 个节点</em>
              </span>
              {busy === board.id ? <LoaderCircle size={13} className="spin" /> : <ArrowRight size={13} />}
            </button>
          ))}
          {!loading && !boards.length ? (
            <p className="board-bridge-empty">还没有无限画布，下面新建一块。</p>
          ) : null}
        </div>

        <footer className="board-bridge-foot">
          <button type="button" className="primary-button compact" disabled={Boolean(busy)} onClick={() => void createAndImport()}>
            {busy === "__new__" ? <LoaderCircle size={12} className="spin" /> : <Plus size={12} />}
            新建无限画布并导入
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
