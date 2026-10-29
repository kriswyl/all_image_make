import type { AppDatabase, BoardRecord } from "./db.js";
import type { BoardView } from "../shared/board.js";
import { AppError } from "./tasks.js";

export function boardView(db: AppDatabase, board: BoardRecord): BoardView {
  const versions = db.listBoardHistoryVersions(board.id);
  const nodeIds = new Set(board.doc.nodes.map((node) => node.id));
  return {
    id: board.id,
    title: board.title,
    doc: board.doc,
    viewport: board.viewport,
    // 撤销 / 外部修改后，选中集合里可能还留着已经被删掉的节点
    selection: board.selection.filter((id) => nodeIds.has(id)),
    uiState: board.uiState,
    version: board.version,
    threadId: board.threadId,
    canUndo: versions.some((version) => version < board.version),
    canRedo: versions.some((version) => version > board.version),
  };
}

export function requireBoard(db: AppDatabase, id: string): BoardRecord {
  const board = db.getBoardRecord(id);
  if (!board) throw new AppError("BOARD_NOT_FOUND", "无限画布不存在", 404);
  return board;
}
