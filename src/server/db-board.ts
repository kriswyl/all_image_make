import type { DatabaseSync } from "node:sqlite";
import type { Asset } from "../shared/types.js";
import { BOARD_LIMITS, boardGroups, createEmptyBoardDoc, parseBoardDoc, parseBoardSelection, parseBoardUiState, parseBoardViewport, type BoardDoc, type BoardSummary, type BoardUiState, type BoardViewport } from "../shared/board.js";
import type { BoardRecord, AssetRow } from "./db.js";

type DbRow = Record<string, string | number | null>;
const now = () => new Date().toISOString();
function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

/** 画布文档、版本、素材链接和任务关联的存储。与主数据库共用连接。 */
export class BoardRepository {
  constructor(private readonly db: DatabaseSync, private readonly assetFromRow: (row: DbRow) => AssetRow, private readonly assetView: (asset: AssetRow) => Asset) {}

  private boardFromRow(row: DbRow): BoardRecord {
    let doc: BoardDoc;
    try {
      // 坏文档退回空板，不让一块坏数据把整个工作区打不开
      doc = parseBoardDoc(parseJson(row.doc_json, createEmptyBoardDoc()));
    } catch {
      doc = createEmptyBoardDoc();
    }
    return {
      id: String(row.id),
      title: String(row.title),
      doc,
      viewport: parseBoardViewport(parseJson(row.viewport_json, {})),
      selection: parseBoardSelection(parseJson(row.selection_json, [])),
      uiState: parseBoardUiState(parseJson(row.ui_state_json, {})),
      version: Number(row.version),
      threadId: String(row.thread_conversation_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  createBoardRecord(input: {
    id: string;
    title: string;
    threadConversationId: string;
    doc?: BoardDoc;
  }): BoardRecord {
    const at = now();
    const doc = input.doc ?? createEmptyBoardDoc();
    const docJson = JSON.stringify(doc);
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        INSERT INTO boards
        (id, title, doc_json, viewport_json, selection_json, ui_state_json, version,
         thread_conversation_id, created_at, updated_at)
        VALUES (?, ?, ?, '', '[]', '', 1, ?, ?, ?)
      `).run(input.id, input.title, docJson, input.threadConversationId, at, at);
      // 初始版本也进历史：第一次编辑后可以撤销回空板
      this.db.prepare(`
        INSERT OR IGNORE INTO board_history (id, board_id, version, doc_json, reason, created_at)
        VALUES (?, ?, 1, ?, 'create', ?)
      `).run(crypto.randomUUID(), input.id, docJson, at);
      this.replaceBoardAssetsUnsafe(input.id, doc);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getBoardRecord(input.id)!;
  }

  getBoardRecord(id: string): BoardRecord | null {
    const row = this.db.prepare("SELECT * FROM boards WHERE id = ?").get(id) as DbRow | undefined;
    return row ? this.boardFromRow(row) : null;
  }

  listBoardRecords(): BoardRecord[] {
    const rows = this.db.prepare("SELECT * FROM boards ORDER BY updated_at DESC").all() as DbRow[];
    return rows.map((row) => this.boardFromRow(row));
  }

  listBoardSummaries(): BoardSummary[] {
    return this.listBoardRecords().map((board) => ({
      id: board.id,
      title: board.title,
      nodeCount: board.doc.nodes.length,
      edgeCount: board.doc.edges.length,
      updatedAt: board.updatedAt,
      threadId: board.threadId,
    }));
  }

  getBoardByThread(threadId: string): BoardRecord | null {
    const row = this.db.prepare("SELECT * FROM boards WHERE thread_conversation_id = ?").get(threadId) as DbRow | undefined;
    return row ? this.boardFromRow(row) : null;
  }

  updateBoardTitle(id: string, title: string): BoardRecord | null {
    const at = now();
    const board = this.getBoardRecord(id);
    if (!board) return null;
    this.db.prepare("UPDATE boards SET title = ?, updated_at = ? WHERE id = ?").run(title, at, id);
    // 线程标题跟着板走，但线程本身不会出现在对话侧栏
    this.db.prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?").run(`无限画布 · ${title}`, at, board.threadId);
    return this.getBoardRecord(id);
  }

  /** 保存一次新版本：旧版本进历史，新文档落库，素材索引重建 */
  saveBoardSnapshot(input: {
    boardId: string;
    previousDoc: BoardDoc;
    doc: BoardDoc;
    viewport?: BoardViewport;
    version: number;
    reason: string;
  }): void {
    const at = now();
    const docJson = JSON.stringify(input.doc);
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        INSERT OR IGNORE INTO board_history (id, board_id, version, doc_json, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(), input.boardId, input.version - 1,
        JSON.stringify(input.previousDoc), input.reason, at,
      );
      if (input.viewport) {
        this.db.prepare(`
          UPDATE boards SET doc_json = ?, viewport_json = ?, version = ?, updated_at = ? WHERE id = ?
        `).run(docJson, JSON.stringify(input.viewport), input.version, at, input.boardId);
      } else {
        this.db.prepare(`
          UPDATE boards SET doc_json = ?, version = ?, updated_at = ? WHERE id = ?
        `).run(docJson, input.version, at, input.boardId);
      }
      // 撤销后重新编辑：未来快照作废，避免重做跳回一条已经不存在的分支
      this.db.prepare("DELETE FROM board_history WHERE board_id = ? AND version > ?")
        .run(input.boardId, input.version);
      // 新版本自身也要有快照，否则撤销到上一版之后没有东西可以重做。
      // 用 REPLACE：撤销后重新编辑时，同一版本号可能已经有一条旧分支的快照。
      this.db.prepare(`
        INSERT OR REPLACE INTO board_history (id, board_id, version, doc_json, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), input.boardId, input.version, docJson, input.reason, at);
      this.replaceBoardAssetsUnsafe(input.boardId, input.doc);
      this.trimBoardHistoryUnsafe(input.boardId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 撤销 / 重做：只移动版本指针，不动历史（未来版本要留给重做） */
  moveBoardVersion(input: {
    boardId: string;
    version: number;
    doc: BoardDoc;
    viewport?: BoardViewport;
  }): void {
    const at = now();
    this.db.exec("BEGIN");
    try {
      if (input.viewport) {
        this.db.prepare("UPDATE boards SET doc_json = ?, viewport_json = ?, version = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(input.doc), JSON.stringify(input.viewport), input.version, at, input.boardId);
      } else {
        this.db.prepare("UPDATE boards SET doc_json = ?, version = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(input.doc), input.version, at, input.boardId);
      }
      this.replaceBoardAssetsUnsafe(input.boardId, input.doc);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listBoardHistoryVersions(boardId: string): number[] {
    const rows = this.db.prepare(
      "SELECT version FROM board_history WHERE board_id = ? ORDER BY version ASC",
    ).all(boardId) as DbRow[];
    return rows.map((row) => Number(row.version));
  }

  listBoardHistoryEntries(boardId: string): Array<{ version: number; reason: string; createdAt: string }> {
    const rows = this.db.prepare(
      "SELECT version, reason, created_at FROM board_history WHERE board_id = ? ORDER BY version DESC",
    ).all(boardId) as DbRow[];
    return rows.map((row) => ({
      version: Number(row.version),
      reason: String(row.reason ?? ""),
      createdAt: String(row.created_at),
    }));
  }

  getBoardHistoryDoc(boardId: string, version: number): BoardDoc | null {
    const row = this.db.prepare(
      "SELECT doc_json FROM board_history WHERE board_id = ? AND version = ?",
    ).get(boardId, version) as DbRow | undefined;
    if (!row) return null;
    try {
      return parseBoardDoc(parseJson(row.doc_json, createEmptyBoardDoc()));
    } catch {
      return null;
    }
  }

  saveBoardViewport(boardId: string, viewport: BoardViewport): void {
    this.db.prepare("UPDATE boards SET viewport_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(viewport), now(), boardId);
  }

  /** 选中状态不碰 updated_at：点一下节点不该把无限画布顶到列表最前面 */
  saveBoardSelection(boardId: string, selection: string[]): void {
    this.db.prepare("UPDATE boards SET selection_json = ? WHERE id = ?")
      .run(JSON.stringify(selection), boardId);
  }

  saveBoardUiState(boardId: string, uiState: BoardUiState): void {
    this.db.prepare("UPDATE boards SET ui_state_json = ? WHERE id = ?")
      .run(JSON.stringify(uiState), boardId);
  }

  listBoardAssets(boardId: string): Asset[] {
    const rows = this.db.prepare(`
      SELECT assets.* FROM board_assets
      JOIN assets ON assets.id = board_assets.asset_id
      WHERE board_assets.board_id = ?
      ORDER BY assets.created_at ASC
    `).all(boardId) as DbRow[];
    const seen = new Set<string>();
    const result: Asset[] = [];
    for (const row of rows) {
      const id = String(row.id);
      if (seen.has(id)) continue;
      seen.add(id);
      result.push(this.assetView(this.assetFromRow(row)));
    }
    return result;
  }

  /** 上传后、文档保存前的临时链接；下一次保存会按文档重建并覆盖掉它 */
  insertBoardAssetLink(boardId: string, assetId: string, nodeId: string): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO board_assets (board_id, asset_id, node_id) VALUES (?, ?, ?)",
    ).run(boardId, assetId, nodeId);
  }

  findBoardAssetRefs(assetId: string): Array<{ boardId: string; nodeId: string }> {
    const rows = this.db.prepare(
      "SELECT board_id, node_id FROM board_assets WHERE asset_id = ?",
    ).all(assetId) as DbRow[];
    return rows.map((row) => ({ boardId: String(row.board_id), nodeId: String(row.node_id) }));
  }

  deleteBoardCascade(boardId: string): { threadId: string } | null {
    const board = this.getBoardRecord(boardId);
    if (!board) return null;
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM board_history WHERE board_id = ?").run(boardId);
      this.db.prepare("DELETE FROM board_assets WHERE board_id = ?").run(boardId);
      this.db.prepare("DELETE FROM board_tasks WHERE board_id = ?").run(boardId);
      this.db.prepare("DELETE FROM boards WHERE id = ?").run(boardId);
      this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(board.threadId);
      this.db.prepare("DELETE FROM conversation_documents WHERE conversation_id = ?").run(board.threadId);
      this.db.prepare("DELETE FROM conversation_shots WHERE conversation_id = ?").run(board.threadId);
      this.db.prepare("DELETE FROM conversation_characters WHERE conversation_id = ?").run(board.threadId);
      this.db.prepare("DELETE FROM conversation_scenes WHERE conversation_id = ?").run(board.threadId);
      this.db.prepare("DELETE FROM conversation_graph_positions WHERE conversation_id = ?").run(board.threadId);
      this.db.prepare("DELETE FROM brain_calls WHERE conversation_id = ?").run(board.threadId);
      this.db.prepare("DELETE FROM conversations WHERE id = ?").run(board.threadId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { threadId: board.threadId };
  }

  addBoardTaskRows(input: {
    taskId: string;
    boardId: string;
    configNodeId: string;
    resultNodeIds: string[];
    kind: string;
  }): void {
    if (!input.resultNodeIds.length) return;
    const at = now();
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO board_tasks
      (task_id, board_id, config_node_id, result_node_id, kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.db.exec("BEGIN");
    try {
      for (const resultNodeId of input.resultNodeIds) {
        insert.run(input.taskId, input.boardId, input.configNodeId, resultNodeId, input.kind, at);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listBoardTasksByTask(taskId: string): Array<{
    taskId: string; boardId: string; configNodeId: string; resultNodeId: string; kind: string; createdAt: string;
  }> {
    const rows = this.db.prepare(
      "SELECT * FROM board_tasks WHERE task_id = ? ORDER BY rowid ASC",
    ).all(taskId) as DbRow[];
    return rows.map((row) => ({
      taskId: String(row.task_id),
      boardId: String(row.board_id),
      configNodeId: String(row.config_node_id),
      resultNodeId: String(row.result_node_id),
      kind: String(row.kind),
      createdAt: String(row.created_at),
    }));
  }

  listBoardTasksByBoard(boardId: string): Array<{
    taskId: string; boardId: string; configNodeId: string; resultNodeId: string; kind: string; createdAt: string;
  }> {
    const rows = this.db.prepare(
      "SELECT * FROM board_tasks WHERE board_id = ? ORDER BY created_at ASC, rowid ASC",
    ).all(boardId) as DbRow[];
    return rows.map((row) => ({
      taskId: String(row.task_id),
      boardId: String(row.board_id),
      configNodeId: String(row.config_node_id),
      resultNodeId: String(row.result_node_id),
      kind: String(row.kind),
      createdAt: String(row.created_at),
    }));
  }

  deleteBoardTaskRows(taskId: string): void {
    this.db.prepare("DELETE FROM board_tasks WHERE task_id = ?").run(taskId);
  }

  private replaceBoardAssetsUnsafe(boardId: string, doc: BoardDoc): void {
    this.db.prepare("DELETE FROM board_assets WHERE board_id = ?").run(boardId);
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO board_assets (board_id, asset_id, node_id) VALUES (?, ?, ?)",
    );
    for (const node of doc.nodes) {
      if ((node.type === "image" || node.type === "video" || node.type === "audio") && node.assetId) {
        insert.run(boardId, node.assetId, node.id);
      }
    }
  }

  private trimBoardHistoryUnsafe(boardId: string): void {
    // 保留最新 50 个版本。offset 50 的那一行就是「第 51 新」，它及更老的都删
    const cutoff = this.db.prepare(
      "SELECT version FROM board_history WHERE board_id = ? ORDER BY version DESC LIMIT 1 OFFSET ?",
    ).get(boardId, BOARD_LIMITS.maxHistory) as DbRow | undefined;
    if (!cutoff) return;
    this.db.prepare("DELETE FROM board_history WHERE board_id = ? AND version <= ?")
      .run(boardId, Number(cutoff.version));
  }

  /**
   * 记一次大脑调用的 token 用量。
   *
   * 只记拿到 usage 的调用：中转站没回这个字段时（部分站点忽略 stream_options）
   * 不写 0，否则「记过 3 次」会变成一句假话。
   */
}
