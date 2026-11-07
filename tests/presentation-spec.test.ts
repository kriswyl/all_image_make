import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { AppDatabase } from "../src/server/db";
import { resolvePresentationSpec, runPresentationSpecUpdate } from "../src/server/chat-tools/presentation-spec-tool";
import { chooseTargetPages, pageCountSatisfies, parsePageCountIntent, totalize } from "../src/shared/presentation-spec";

const databases: AppDatabase[] = [];
async function makeDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "presentation-spec-"));
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

const parse = (text: string) => parsePageCountIntent(text, "m1")?.constraint;
function makeConversation(db: AppDatabase): string {
  return db.createConversation({
    title: "跨轮回溯验收", brainChannelId: "mock-channel", brainModel: "mock",
    videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false,
  }).id;
}

it("A01/A06 回归：页数语义解析与干扰项过滤", () => {
  expect(parse("把 18 章资料做成 10 页，含封面")).toMatchObject({ kind: "exact", value: 10 });
  expect(parse("做成十页")).toMatchObject({ kind: "exact", value: 10 });
  expect(parse("不超过 10 页")).toMatchObject({ kind: "max", value: 10 });
  expect(parse("至少 8 页")).toMatchObject({ kind: "min", value: 8 });
  expect(parse("8 到 12 页")).toMatchObject({ kind: "range", min: 8, max: 12 });
  expect(parse("资料共 18 页，做成 10 页")).toMatchObject({ kind: "exact", value: 10 });
  expect(parse("第 3 页单独说明，做成 10 页")).toMatchObject({ kind: "exact", value: 10 });
  expect(parse("约 10 页")).toBeUndefined();
  expect(parse("10 页左右")).toBeUndefined();
  expect(parse("随便做一下")).toBeUndefined();
});

it("A02 前置：18 章按批次数估计为 19 页时，契约仍收敛到 10 页", () => {
  const constraint = parse("18 章做成 10 页，含封面")!;
  expect(chooseTargetPages(constraint, 19)).toBe(10);
  expect(pageCountSatisfies(constraint, 10)).toBe(true);
  expect(pageCountSatisfies(constraint, 30)).toBe(false);
  const body = parsePageCountIntent("正文 10 页，另加封面", "m1")!;
  expect(body.basis).toBe("body");
  expect(totalize(body.constraint, body.basis)).toMatchObject({ kind: "exact", value: 11 });
});

it("A02：先保存要求、下一轮「开始」继承同一契约与页数", async () => {
  const db = await makeDb();
  const first = runPresentationSpecUpdate(db, "c1", "18 章做成 10 页，含封面，先不生成", "m1", JSON.stringify({ intent: "create", prepareOnly: true }));
  expect(first.ok).toBe(true);
  const specId = String(first.data!.specId);
  expect(db.specs.get(specId)?.lifecycle).toBe("prepared");

  const inherited = resolvePresentationSpec(db, "c1", "开始", "m2");
  expect(inherited.spec?.specId).toBe(specId);
  expect(inherited.conflict).toBeUndefined();
  const constraint = totalize(inherited.spec!.pageCount!, inherited.spec!.pageCountBasis);
  expect(chooseTargetPages(constraint, 19)).toBe(10);
});

it("A02 补强：第二轮只说「开始」时，契约工具从上一轮消息回溯 10 页", async () => {
  const db = await makeDb();
  const conversationId = makeConversation(db);
  db.appendMessage({ conversationId, role: "user", content: "把这份 18 章文档整理成 10 页 PPT，含封面，先不生成" });
  const result = runPresentationSpecUpdate(db, conversationId, "开始", "m2", JSON.stringify({ intent: "create" }));
  expect(result.ok).toBe(true);
  const spec = db.specs.get(String(result.data!.specId))!;
  expect(spec.pageCount).toMatchObject({ kind: "exact", value: 10 });
  expect(spec.pageCount?.evidence.text).toContain("10 页");

  // 已有 PPT 产物后，新任务不再回溯上一份的页数。
  const other = makeConversation(db);
  db.appendMessage({ conversationId: other, role: "user", content: "做成 10 页" });
  db.addWorkspaceDocument(other, "旧的成品.pptx", 10);
  const fresh = runPresentationSpecUpdate(db, other, "开始", "m3", JSON.stringify({ intent: "create" }));
  expect(db.specs.get(String(fresh.data!.specId))?.pageCount).toBeUndefined();
});

it("A03：制作完成后换风格继承页数与必需内容，并追加 revision", async () => {
  const db = await makeDb();
  const first = runPresentationSpecUpdate(db, "c1", "做成 10 页，必须保留三个案例", "m1", JSON.stringify({ intent: "create", prepareOnly: true }));
  const specId = String(first.data!.specId);
  const before = db.specs.get(specId)!;
  expect(before.pageCount).toMatchObject({ kind: "exact", value: 10 });

  const changed = runPresentationSpecUpdate(db, "c1", "换成杂志风", "m2", JSON.stringify({ intent: "update", specId, styleText: "杂志风" }));
  expect(Number(changed.data!.specRevision)).toBe(before.revision + 1);
  const after = db.specs.get(specId)!;
  expect(after.pageCount).toMatchObject({ kind: "exact", value: 10 });
  expect(after.styleRequest?.text).toBe("杂志风");
  expect(resolvePresentationSpec(db, "c1", "开始", "m3").spec?.specId).toBe(specId);
});

it("A04：另做一份不继承上一份的 10 页；多个候选目标时不盲选", async () => {
  const db = await makeDb();
  const first = runPresentationSpecUpdate(db, "c1", "做成 10 页", "m1", JSON.stringify({ intent: "create", prepareOnly: true }));
  const firstId = String(first.data!.specId);
  const fork = resolvePresentationSpec(db, "c1", "另做一份 12 页", "m2");
  expect(fork.spec?.specId).not.toBe(firstId);
  expect(fork.spec?.pageCount).toMatchObject({ kind: "exact", value: 12 });

  const db2 = await makeDb();
  db2.specs.create({ conversationId: "c2", reason: "第一份" });
  db2.specs.create({ conversationId: "c2", reason: "第二份" });
  const ambiguous = resolvePresentationSpec(db2, "c2", "把这份资料整理一下", "m3");
  expect(ambiguous.conflict).toBeTruthy();
  expect(ambiguous.spec).toBeNull();
});

it("A05：修改页数追加 revision，旧 revision 不被改写", async () => {
  const db = await makeDb();
  const spec = db.specs.create({ conversationId: "c1" });
  const first = db.specs.update(spec.specId, {
    pageCount: { kind: "exact", value: 10, evidence: { sourceMessageId: "m1", text: "10 页" } },
  }, "用户指定页数", "m1");
  const second = db.specs.update(spec.specId, {
    pageCount: { kind: "exact", value: 12, evidence: { sourceMessageId: "m2", text: "12 页" } },
  }, "用户改成 12 页", "m2");
  expect(second.revision).toBe(first.revision + 1);
  expect(db.specs.atRevision(spec.specId, first.revision)?.pageCount).toMatchObject({ kind: "exact", value: 10 });
  expect(db.specs.get(spec.specId)?.pageCount).toMatchObject({ kind: "exact", value: 12 });
});

it("A11：活跃引用存在时 prune 不删除 family 版本", async () => {
  const db = await makeDb();
  db.specs.registerFamilyRef({ familyId: "f1", conversationId: "c1", owner: "op1", kind: "running" });
  expect(db.specs.hasActiveFamilyRef("f1")).toBe(true);
  expect(db.pruneWorkspaceFamily("c1", "f1", 3)).toEqual([]);
  db.specs.releaseFamilyRef("op1");
  expect(db.specs.hasActiveFamilyRef("f1")).toBe(false);
});
