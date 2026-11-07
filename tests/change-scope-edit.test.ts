import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { AppDatabase } from "../src/server/db";
import { executeChatDocumentTool, saveWorkspaceDocument } from "../src/server/chat-tools/documents";
import { renderAiPresentation, type AiPresentation } from "../src/server/mind-document";
import { packPresentationProject } from "../src/server/presentation-project";

/** C：doc_edit 端到端接入 ChangeScope（文档 §7.4 的固定十页样例）。 */
const databases: AppDatabase[] = [];
async function makeDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "change-scope-edit-"));
  const db = new AppDatabase(dir);
  databases.push(db);
  return db;
}
afterEach(() => {
  while (databases.length) {
    const db = databases.pop()!;
    try { db.close(); } catch { /* 已关闭 */ }
  }
});
function makeConversation(db: AppDatabase): string {
  return db.createConversation({
    title: "C 验收", brainChannelId: "mock-channel", brainModel: "mock",
    videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false,
  }).id;
}
function makeSpec(db: AppDatabase, conversationId: string) {
  const created = db.specs.create({ conversationId });
  db.specs.update(created.specId, {
    pageCount: { kind: "exact", value: 10, evidence: { sourceMessageId: "m1", text: "10 页" } },
  }, "设定页数契约", "m1");
  return db.specs.setLifecycle(created.specId, "active");
}
const plan: AiPresentation = {
  title: "十页资料", theme: "blue",
  slides: Array.from({ length: 10 }, (_, index) => ({
    layout: "content" as const, title: `第 ${index + 1} 页`, subtitle: "",
    lines: [`原始事实 ${index + 1}`, "支撑条件"], notes: "来源原文", sourceIds: [`s-${index + 1}`],
  })),
};
function editPayload(fileId: string, expectedSha256: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    fileId, expectedSha256,
    pages: [{ page: 3, slide: { ...plan.slides[2], title: "改为对比结构" } }],
    ...extra,
  });
}

async function createSource(db: AppDatabase, conversationId: string) {
  const rendered = await renderAiPresentation(plan);
  const bytes = await packPresentationProject(rendered, plan, []);
  const saved = saveWorkspaceDocument(db, conversationId, "十页", "pptx", bytes, "op-create");
  return { saved, sha256: createHash("sha256").update(bytes).digest("hex") };
}

it("C12：只改第 3 页时视觉回调只收到原页码 [3]，报告记录未扩域的三集合", async () => {
  const db = await makeDb();
  const cid = makeConversation(db);
  makeSpec(db, cid);
  const source = await createSource(db, cid);
  const seen: Array<number[] | undefined> = [];
  const result = await executeChatDocumentTool(db, cid, "doc_edit", editPayload(source.saved.id, source.sha256),
    undefined, "op-edit", async (_p, _i, pageNumbers) => {
      seen.push(pageNumbers);
      return { plan: _p, summary: "视觉检查（spy）" };
    });
  expect(result.ok).toBe(true);
  expect(seen).toEqual([[3]]);
  const fileId = String((result.data as { fileId: string }).fileId);
  const report = db.getPresentationVersion(cid, fileId)?.report;
  expect(report?.checkSets).toMatchObject({
    contentPages: [3], auditPages: [3], visualPages: [3], widened: false,
  });
});

it("C13：整稿换色必须扩域到全部十页，且不按局部修改做非目标页对比", async () => {
  const db = await makeDb();
  const cid = makeConversation(db);
  makeSpec(db, cid);
  const source = await createSource(db, cid);
  const seen: Array<number[] | undefined> = [];
  const result = await executeChatDocumentTool(db, cid, "doc_edit",
    editPayload(source.saved.id, source.sha256, { design: { accent: "B23B2E" } }),
    undefined, "op-design", async (_p, _i, pageNumbers) => {
      seen.push(pageNumbers);
      return { plan: _p, summary: "视觉检查（spy）" };
    });
  expect(result.ok).toBe(true);
  expect(seen[0]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const fileId = String((result.data as { fileId: string }).fileId);
  expect(db.getPresentationVersion(cid, fileId)?.report.checkSets?.widened).toBe(true);
});
