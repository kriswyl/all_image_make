import type { DatabaseSync } from "node:sqlite";
import { boardGroups, createEmptyBoardDoc, parseBoardDoc, type BoardDoc } from "../shared/board.js";
import type { CanvasTemplate, CanvasTemplateSummary } from "../shared/canvas-template.js";
import { now, parseJson, type DbRow } from "./db-row.js";

export type CreateCanvasTemplateInput = {
  id: string;
  name: string;
  description: string;
  source: CanvasTemplate["source"];
  conversationId?: string | null;
  doc: BoardDoc;
};

export class CanvasTemplateRepository {
  constructor(private readonly db: DatabaseSync) {}

  // ── 无限画布（FREE_CANVAS_PLAN.md） ─────────────────────────────────────────

  createCanvasTemplate(input: CreateCanvasTemplateInput): CanvasTemplate {
    const at = now();
    this.db.prepare(`
      INSERT INTO canvas_templates (id, name, description, source, conversation_id, doc_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.id, input.name, input.description, input.source,
      input.conversationId ?? null, JSON.stringify(input.doc), at,
    );
    return {
      id: input.id,
      name: input.name,
      description: input.description,
      source: input.source,
      doc: input.doc,
      createdAt: at,
    };
  }

  getCanvasTemplate(id: string): CanvasTemplate | null {
    const row = this.db.prepare("SELECT * FROM canvas_templates WHERE id = ?").get(id) as DbRow | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      name: String(row.name),
      description: String(row.description ?? ""),
      source: String(row.source ?? "agent") as CanvasTemplate["source"],
      doc: parseBoardDoc(parseJson(row.doc_json, createEmptyBoardDoc())),
      createdAt: String(row.created_at),
    };
  }

  findCanvasTemplateByConversation(conversationId: string, source?: CanvasTemplate["source"]): CanvasTemplate | null {
    const row = this.db.prepare(`
      SELECT id FROM canvas_templates
      WHERE conversation_id = ? ${source ? "AND source = ?" : ""}
      ORDER BY created_at DESC LIMIT 1
    `).get(...(source ? [conversationId, source] : [conversationId])) as DbRow | undefined;
    return row ? this.getCanvasTemplate(String(row.id)) : null;
  }

  updateCanvasTemplate(id: string, patch: { name?: string; description?: string }): CanvasTemplate | null {
    const current = this.getCanvasTemplate(id);
    if (!current) return null;
    const name = patch.name?.trim() ? patch.name.trim().slice(0, 80) : current.name;
    const description = patch.description === undefined ? current.description : patch.description.trim().slice(0, 500);
    this.db.prepare("UPDATE canvas_templates SET name = ?, description = ? WHERE id = ?")
      .run(name, description, id);
    return this.getCanvasTemplate(id);
  }

  deleteCanvasTemplate(id: string): boolean {
    this.db.prepare("DELETE FROM storyboard_template_assets WHERE template_id = ?").run(id);
    const result = this.db.prepare("DELETE FROM canvas_templates WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  listCanvasTemplateSummaries(limit = 50): CanvasTemplateSummary[] {
    const rows = this.db.prepare(
      "SELECT * FROM canvas_templates ORDER BY created_at DESC LIMIT ?",
    ).all(Math.min(200, Math.max(1, limit))) as DbRow[];
    return rows.map((row) => {
      const doc = parseBoardDoc(parseJson(row.doc_json, createEmptyBoardDoc()));
      return {
        id: String(row.id),
        name: String(row.name),
        description: String(row.description ?? ""),
        source: String(row.source ?? "agent") as CanvasTemplate["source"],
        nodeCount: doc.nodes.length,
        groupCount: boardGroups(doc).length,
        createdAt: String(row.created_at),
      };
    });
  }

  setStoryboardTemplateAssets(templateId: string, entries: Array<{ nodeId: string; assetId: string }>) {
    const statement = this.db.prepare("INSERT INTO storyboard_template_assets (template_id, node_id, asset_id) VALUES (?, ?, ?)");
    for (const entry of entries) statement.run(templateId, entry.nodeId, entry.assetId);
  }

  getStoryboardTemplateAssets(templateId: string): Map<string, string> {
    const rows = this.db.prepare("SELECT node_id, asset_id FROM storyboard_template_assets WHERE template_id = ?").all(templateId) as DbRow[];
    return new Map(rows.map((row) => [String(row.node_id), String(row.asset_id)]));
  }
}
