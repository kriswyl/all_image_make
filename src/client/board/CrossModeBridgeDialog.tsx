/**
 * 跨模式桥：把图片从一个工作区送到另一个。
 *
 * - to-board：分镜 / 其他来源的素材 → 无限画布的图片节点；
 * - to-canvas：无限画布里选中的图片 → 某个普通对话的参考图组。
 *
 * 只负责选目标 + 调接口；目标列表和结果都由服务端决定。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Image as ImageIcon, LayoutGrid, LoaderCircle, Plus, X } from "lucide-react";
import { api } from "../api";
import type { BoardSummary } from "../../shared/board";
import type { ConversationSummary } from "../../shared/agent-types";

export interface BridgeAssetItem {
  assetId: string;
  title?: string;
  prompt?: string;
}

interface Target {
  id: string;
  title: string;
  subtitle: string;
}

export function CrossModeBridgeDialog({
  mode, items, onClose, onToast, onDone,
}: {
  mode: "to-board" | "to-canvas";
  items: BridgeAssetItem[];
  onClose: () => void;
  onToast: (kind: "success" | "error", message: string) => void;
  onDone?: (targetId: string) => void;
}) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        if (mode === "to-board") {
          const boards = await api.boards();
          if (cancelled) return;
          setTargets(boards.map((board: BoardSummary) => ({
            id: board.id,
            title: board.title,
            subtitle: `${board.nodeCount} 个节点`,
          })));
        } else {
          const conversations = await api.conversations();
          if (cancelled) return;
          setTargets(conversations.map((conversation: ConversationSummary) => ({
            id: conversation.id,
            title: conversation.title || "未命名对话",
            subtitle: `${conversation.canvasAssetIds?.length ?? 0} 张参考图`,
          })));
        }
      } catch (error) {
        if (!cancelled) onToast("error", error instanceof Error ? error.message : "目标列表加载失败");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [mode, onToast]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const sendToBoard = async (target: Target) => {
    setBusy(target.id);
    try {
      const result = await api.addAssetsToBoard(target.id, items);
      const skipped = result.skipped ? `，跳过 ${result.skipped} 个（已在画布或素材不可用）` : "";
      onToast("success", `已加入《${target.title}》：新增 ${result.added.length} 个素材节点${skipped}`);
      onDone?.(result.board.id);
      onClose();
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "加入无限画布失败");
    } finally {
      setBusy(null);
    }
  };

  const createAndSend = async () => {
    setBusy("__new__");
    try {
      const board = await api.createBoard({ title: "素材画布" });
      const result = await api.addAssetsToBoard(board.id, items);
      onToast("success", `已新建《${board.title}》，加入 ${result.added.length} 个素材节点`);
      onDone?.(board.id);
      onClose();
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "新建无限画布失败");
    } finally {
      setBusy(null);
    }
  };

  const sendToCanvas = async (target: Target) => {
    setBusy(target.id);
    try {
      const result = await api.appendConversationCanvas(target.id, items.map((item) => item.assetId));
      const skipped = result.skipped ? `，跳过 ${result.skipped} 张（重复或超过 8 张上限）` : "";
      onToast("success", `已加入《${target.title}》的参考图组：${result.added.length} 张${skipped}`);
      onDone?.(target.id);
      onClose();
    } catch (error) {
      onToast("error", error instanceof Error ? error.message : "加入参考图组失败");
    } finally {
      setBusy(null);
    }
  };

  const title = mode === "to-board" ? "加入无限画布" : "加入参考图组";
  const hint = mode === "to-board"
    ? "将素材作为节点加入无限画布，并保留标题和提示词。"
    : "会把选中的图片追加到对话的参考图组，最多 8 张。";

  return createPortal(
    <div className="board-bridge-overlay" role="presentation" onClick={() => { if (!busy) onClose(); }}>
      <section
        className="board-bridge-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="board-bridge-head">
          <div>
            <strong>{title}</strong>
            <span>{hint}</span>
          </div>
          <button type="button" className="icon-button compact" aria-label="关闭" onClick={onClose} disabled={Boolean(busy)}>
            <X size={14} />
          </button>
        </header>

        <div className="board-bridge-summary">
          <ImageIcon size={13} />
          <span>将加入 {items.length} 个素材</span>
        </div>

        <div className="board-bridge-list">
          {loading ? (
            <p className="board-bridge-empty"><LoaderCircle size={13} className="spin" />正在读取目标…</p>
          ) : null}
          {!loading && targets.map((target) => (
            <button
              key={target.id}
              type="button"
              className="board-bridge-target"
              disabled={Boolean(busy)}
              onClick={() => mode === "to-board" ? void sendToBoard(target) : void sendToCanvas(target)}
            >
              {mode === "to-board" ? <LayoutGrid size={14} /> : <ImageIcon size={14} />}
              <span className="board-bridge-target-text">
                <strong>{target.title}</strong>
                <em>{target.subtitle}</em>
              </span>
              {busy === target.id ? <LoaderCircle size={13} className="spin" /> : <ArrowRight size={13} />}
            </button>
          ))}
          {!loading && !targets.length ? (
            <p className="board-bridge-empty">
              {mode === "to-board" ? "还没有无限画布，下面新建一块。" : "还没有普通对话，先创建一个对话。"}
            </p>
          ) : null}
        </div>

        {mode === "to-board" ? (
          <footer className="board-bridge-foot">
            <button type="button" className="primary-button compact" disabled={Boolean(busy)} onClick={() => void createAndSend()}>
              {busy === "__new__" ? <LoaderCircle size={12} className="spin" /> : <Plus size={12} />}
              新建无限画布并加入
            </button>
          </footer>
        ) : null}
      </section>
    </div>,
    document.body,
  );
}
