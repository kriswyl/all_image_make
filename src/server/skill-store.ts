import type { DatabaseSync } from "node:sqlite";
import type { ImageSkillChat, ImageSkillHistory, ImageSkillTarget, SampleAnalysis, SampleField, SavedImageSkill, SkillReferenceSet } from "../shared/skills.js";
import type { Asset } from "../shared/types.js";

export interface SampleReference {
  sample: Asset;
  name: string;
  analysis: SampleAnalysis;
  fields: SampleField[];
}

export interface StoredImageSkillRun {
  id: string;
  conversationId: string;
  skillId: string;
  version: number;
  subjectId: string;
  sourceConversationId: string;
  target: ImageSkillTarget & { channelVersion: string };
  requirements: string;
  reusableRules?: string;
  savedSkillId?: string;
  confirmed: boolean;
  items: Array<SampleReference & { operationId: string; error: string | null; taskId?: string }>;
}

export interface StoredImageSkillChat extends ImageSkillChat {
  turns: Array<{ user: string; agent: string }>;
}

export class SkillStore {
  readonly activeChats = new Set<string>();

  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS skill_runs (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS skill_runs_conversation ON skill_runs(conversation_id, skill_id, updated_at);
      CREATE TABLE IF NOT EXISTS skill_sample_analysis (fingerprint TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS skill_reference_sets (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        name TEXT NOT NULL, payload TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS image_skill_chats (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS saved_image_skills (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    `);
  }

  get(conversationId: string, runId: string): StoredImageSkillRun | undefined {
    const row = this.db.prepare("SELECT payload FROM skill_runs WHERE id=? AND conversation_id=?").get(runId, conversationId);
    return row ? JSON.parse(String(row.payload)) as StoredImageSkillRun : undefined;
  }

  latest(conversationId: string, skillId: string) {
    const row = this.db.prepare("SELECT payload FROM skill_runs WHERE conversation_id=? AND skill_id=? ORDER BY updated_at DESC, rowid DESC LIMIT 1").get(conversationId, skillId);
    return row ? JSON.parse(String(row.payload)) as StoredImageSkillRun : undefined;
  }

  history(conversationId: string, skillId: string): ImageSkillHistory[] {
    return this.db.prepare(`SELECT id,updated_at,json_extract(payload,'$.target.model') AS model,json_array_length(payload,'$.items') AS count
      FROM skill_runs WHERE conversation_id=? AND skill_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 30`).all(conversationId, skillId)
      .map((row) => ({ id: String(row.id), model: String(row.model), count: Number(row.count), updatedAt: String(row.updated_at) }));
  }

  save(run: StoredImageSkillRun) {
    this.db.prepare(`INSERT INTO skill_runs(id,conversation_id,skill_id,payload,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at`)
      .run(run.id, run.conversationId, run.skillId, JSON.stringify(run), new Date().toISOString());
  }

  analysis(fingerprint: string): SampleAnalysis | undefined {
    const row = this.db.prepare("SELECT payload FROM skill_sample_analysis WHERE fingerprint=?").get(fingerprint);
    return row ? JSON.parse(String(row.payload)) as SampleAnalysis : undefined;
  }

  saveAnalysis(fingerprint: string, analysis: SampleAnalysis) {
    this.db.prepare("INSERT OR IGNORE INTO skill_sample_analysis(fingerprint,payload) VALUES(?,?)").run(fingerprint, JSON.stringify(analysis));
  }

  listReferences(): Array<SkillReferenceSet & { conversationId: string }> {
    return this.db.prepare(`SELECT id,name,conversation_id,json_array_length(payload) AS count
      FROM skill_reference_sets ORDER BY updated_at DESC, rowid DESC`).all()
      .map((row) => ({ id: String(row.id), name: String(row.name), conversationId: String(row.conversation_id), count: Number(row.count) }));
  }

  references(id: string): { name: string; conversationId: string; samples: SampleReference[] } | undefined {
    const row = this.db.prepare("SELECT name,conversation_id,payload FROM skill_reference_sets WHERE id=?").get(id);
    return row ? { name: String(row.name), conversationId: String(row.conversation_id), samples: JSON.parse(String(row.payload)) as SampleReference[] } : undefined;
  }

  saveReferences(id: string, conversationId: string, name: string, samples: SampleReference[]) {
    this.db.prepare("INSERT INTO skill_reference_sets(id,conversation_id,name,payload,updated_at) VALUES(?,?,?,?,?)")
      .run(id, conversationId, name, JSON.stringify(samples), new Date().toISOString());
  }

  deleteReferences(id: string) {
    this.db.prepare("DELETE FROM skill_reference_sets WHERE id=?").run(id);
  }

  taskId(conversationId: string, operationId: string): string | undefined {
    const row = this.db.prepare("SELECT id FROM tasks WHERE owner_conversation_id=? AND agent_operation_id=? LIMIT 1").get(conversationId, operationId);
    return row ? String(row.id) : undefined;
  }

  chat(conversationId: string): StoredImageSkillChat | undefined {
    const row = this.db.prepare("SELECT payload FROM image_skill_chats WHERE conversation_id=?").get(conversationId);
    return row ? JSON.parse(String(row.payload)) as StoredImageSkillChat : undefined;
  }

  saveChat(conversationId: string, chat: StoredImageSkillChat) {
    this.db.prepare(`INSERT INTO image_skill_chats(conversation_id,payload) VALUES(?,?)
      ON CONFLICT(conversation_id) DO UPDATE SET payload=excluded.payload`).run(conversationId, JSON.stringify(chat));
  }

  clearChat(conversationId: string) {
    this.db.prepare("DELETE FROM image_skill_chats WHERE conversation_id=?").run(conversationId);
  }

  savedSkills(): SavedImageSkill[] {
    return this.db.prepare("SELECT payload FROM saved_image_skills ORDER BY rowid DESC").all()
      .map((row) => JSON.parse(String(row.payload)) as SavedImageSkill);
  }

  savedSkill(id: string): SavedImageSkill | undefined {
    const row = this.db.prepare("SELECT payload FROM saved_image_skills WHERE id=?").get(id);
    return row ? JSON.parse(String(row.payload)) as SavedImageSkill : undefined;
  }

  publishSkill(run: StoredImageSkillRun, skill: SavedImageSkill) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO saved_image_skills(id,payload) VALUES(?,?)").run(skill.id, JSON.stringify(skill));
      this.save({ ...run, savedSkillId: skill.id });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
