import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { AppDatabase } from "../src/server/db";
import { createCandidateDocument, cleanupExpiredCandidates, publishDocument, reconcileCandidates, PublishPending } from "../src/server/document-publish";
import { saveWorkspaceDocument } from "../src/server/chat-tools/documents";
import type { AiPresentation } from "../src/server/mind-document";
import type { PresentationSpec } from "../src/shared/presentation-spec";

/** B 阶段：候选隐藏、统一发布、幂等、晚到结果、恢复对账。 */
const databases: AppDatabase[] = [];
async function makeDb() {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "document-publish-"));
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
    title: "B 验收", brainChannelId: "mock-channel", brainModel: "mock",
    videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false,
  }).id;
}
async function makeSpec(db: AppDatabase, conversationId: string, pages = 10): Promise<PresentationSpec> {
  const created = db.specs.create({ conversationId });
  db.specs.update(created.specId, {
    pageCount: { kind: "exact", value: pages, evidence: { sourceMessageId: "m1", text: `${pages} 页` } },
  }, "设定页数契约", "m1");
  return db.specs.setLifecycle(created.specId, "active");
}
function makePlan(pages: number, changedPage?: number): AiPresentation {
  return {
    title: "培训", theme: "blue",
    slides: Array.from({ length: pages }, (_, index) => ({
      layout: "content" as const, title: `第 ${index + 1} 页`, subtitle: "",
      lines: [index + 1 === changedPage ? "这一页被意外改动" : "示例事实 F01 数值 100"],
      notes: "", sourceIds: [`s-${index + 1}`],
    })),
  };
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function makeValidation(db: AppDatabase, spec: PresentationSpec, fileSha256: string, options: { ok?: boolean; failures?: Array<{ code: string; detail: string }> } = {}) {
  const ok = options.ok ?? true;
  return db.specs.saveValidation({
    specId: spec.specId, specRevision: spec.revision, fileSha256,
    ok, readiness: ok ? "ready" : "draft",
    failures: options.failures ?? [],
    visibleCoverage: { required: 0, satisfied: 0, unknown: 0 },
  });
}

it("B01：候选默认对用户隐藏，只能通过内部读取获得，且不计入 getByOperation", async () => {
  const db = await makeDb();
  const cid = makeConversation(db);
  const created = createCandidateDocument(db, { conversationId: cid, name: "中间稿", ext: "pptx", bytes: Buffer.from("draft"), operationId: "op-b01" });
  expect(db.listWorkspaceDocuments(cid).some(file => file.id === created.id)).toBe(false);
  expect(db.getWorkspaceDocument(cid, created.id)).toBeNull();
  expect(db.getWorkspaceDocumentByOperation(cid, "op-b01")).toBeNull();
  const withCandidates = db.listWorkspaceDocuments(cid, { includeCandidates: true });
  expect(withCandidates.some(file => file.id === created.id && file.state === "candidate")).toBe(true);
  expect(db.getAnyWorkspaceDocument(cid, created.id)?.id).toBe(created.id);
  expect(db.getCandidateByOperation(cid, "op-b01")?.id).toBe(created.id);
});

it("B02：publish 是唯一转为 published 的入口，正式版本号在发布时分配", async () => {
  const db = await makeDb();
  const cid = makeConversation(db);
  const spec = await makeSpec(db, cid);
  const bytes = Buffer.from("ready-bytes");
  const created = createCandidateDocument(db, { conversationId: cid, name: "成品", ext: "pptx", bytes, operationId: "op-b02", specId: spec.specId, specRevision: spec.revision });
  const validation = makeValidation(db, spec, created.sha256);
  const result = publishDocument(db, {
    conversationId: cid, operationId: created.operationId, candidateId: created.id,
    expectedCandidateSha256: created.sha256, specId: spec.specId, specRevision: spec.revision,
    validationId: validation.validationId, disposition: "ready",
  });
  expect(result.version).toBe(1);
  const listed = db.listWorkspaceDocuments(cid);
  expect(listed).toHaveLength(1);
  expect(listed[0]!.state).toBe("published");
  expect(db.getWorkspaceDocumentByOperation(cid, "op-b02")?.id).toBe(result.fileId);
  expect(db.getPublishLog(cid, "op-b02")?.publishedId).toBe(result.fileId);
  expect(db.listCandidateDocuments()).toHaveLength(0);
  const second = createCandidateDocument(db, { conversationId: cid, name: "第二版", ext: "pptx", bytes: Buffer.from("v2"), operationId: "op-b02-v2", specId: spec.specId, specRevision: spec.revision });
  const validation2 = makeValidation(db, spec, second.sha256);
  const result2 = publishDocument(db, {
    conversationId: cid, operationId: second.operationId, candidateId: second.id,
    expectedCandidateSha256: second.sha256, specId: spec.specId, specRevision: spec.revision,
    validationId: validation2.validationId, disposition: "ready",
    lineage: { familyId: result.familyId, parentId: result.fileId },
  });
  expect(result2.version).toBe(2);
  expect(result2.familyId).toBe(result.familyId);
});

it("B03：候选与正式发布幂等键分离，晚到结果不刷版本", async () => {
  const db = await makeDb();
  const cid = makeConversation(db);
  await makeSpec(db, cid);
  const first = saveWorkspaceDocument(db, cid, "培训", "pptx", Buffer.from("first"), "op-late", undefined, undefined, { plan: makePlan(10) });
  const late = saveWorkspaceDocument(db, cid, "晚到结果", "pptx", Buffer.from("late"), "op-late", undefined, undefined, { plan: makePlan(10) });
  expect(late.id).toBe(first.id);
  expect(db.listWorkspaceDocuments(cid)).toHaveLength(1);
  expect(db.listWorkspaceDocuments(cid, { includeCandidates: true })).toHaveLength(1);
  expect(db.getPublishLog(cid, "op-late")).not.toBeNull();
  // 同操作、同字节的候选创建幂等；字节变化则旧候选作废。
  const c1 = createCandidateDocument(db, { conversationId: cid, name: "候选", ext: "txt", bytes: Buffer.from("same"), operationId: "op-candidate" });
  const c2 = createCandidateDocument(db, { conversationId: cid, name: "候选", ext: "txt", bytes: Buffer.from("same"), operationId: "op-candidate" });
  expect(c2.id).toBe(c1.id);
});

it("B04：候选字节变化后旧 validation 不能用于发布", async () => {
  const db = await makeDb();
  const cid = makeConversation(db);
  const spec = await makeSpec(db, cid);
  const created = createCandidateDocument(db, { conversationId: cid, name: "候选", ext: "pptx", bytes: Buffer.from("original"), operationId: "op-b04", specId: spec.specId, specRevision: spec.revision });
  const validation = makeValidation(db, spec, created.sha256);
  fs.writeFileSync(created.full, Buffer.from("tampered"));
  expect(() => publishDocument(db, {
    conversationId: cid, operationId: created.operationId, candidateId: created.id,
    expectedCandidateSha256: created.sha256, specId: spec.specId, specRevision: spec.revision,
    validationId: validation.validationId, disposition: "ready",
  })).toThrow(/候选内容已变化/);
  expect(db.listWorkspaceDocuments(cid)).toHaveLength(0);
});

it("B05：安全/归属失败不允许用 draft 绕过，必需约束失败只能显式进 draft", async () => {
  const db = await makeDb();
  const cid = makeConversation(db);
  const spec = await makeSpec(db, cid);
  const created = createCandidateDocument(db, { conversationId: cid, name: "候选", ext: "pptx", bytes: Buffer.from("b05"), operationId: "op-b05", specId: spec.specId, specRevision: spec.revision });
  const validation = makeValidation(db, spec, created.sha256, { ok: false, failures: [{ code: "SCOPE_VIOLATION", detail: "未授权页面变化" }] });
  expect(() => publishDocument(db, {
    conversationId: cid, operationId: created.operationId, candidateId: created.id,
    expectedCandidateSha256: created.sha256, specId: spec.specId, specRevision: spec.revision,
    validationId: validation.validationId, disposition: "draft",
  })).toThrow(/不能以草稿绕过/);
  const draftValidation = makeValidation(db, spec, created.sha256, { ok: false, failures: [{ code: "PAGE_COUNT", detail: "页数不符" }] });
  const result = publishDocument(db, {
    conversationId: cid, operationId: created.operationId, candidateId: created.id,
    expectedCandidateSha256: created.sha256, specId: spec.specId, specRevision: spec.revision,
    validationId: draftValidation.validationId, disposition: "draft",
  });
  expect(result.disposition).toBe("draft");
  expect(db.listWorkspaceDocuments(cid)).toHaveLength(1);
});

it("B06：before_publish 未完成视觉检查时阻塞，background 默认放行", async () => {
  const db = await makeDb();
  const cid = makeConversation(db);
  const spec = await makeSpec(db, cid);
  const created = createCandidateDocument(db, { conversationId: cid, name: "候选", ext: "pptx", bytes: Buffer.from("b06"), operationId: "op-b06", specId: spec.specId, specRevision: spec.revision });
  const validation = makeValidation(db, spec, created.sha256);
  const input = {
    conversationId: cid, operationId: created.operationId, candidateId: created.id,
    expectedCandidateSha256: created.sha256, specId: spec.specId, specRevision: spec.revision,
    validationId: validation.validationId, disposition: "ready" as const,
  };
  expect(() => publishDocument(db, { ...input, visualPolicy: "before_publish" })).toThrow(PublishPending);
  expect(db.listWorkspaceDocuments(cid)).toHaveLength(0);
  const result = publishDocument(db, { ...input, visualPolicy: "before_publish", visualReview: { status: "complete", blocking: [] } });
  expect(result.disposition).toBe("ready");
  // 默认 background：另一份候选不需要视觉检查结论即可交付。
  const second = createCandidateDocument(db, { conversationId: cid, name: "候选2", ext: "pptx", bytes: Buffer.from("b06-2"), operationId: "op-b06-2", specId: spec.specId, specRevision: spec.revision });
  const validation2 = makeValidation(db, spec, second.sha256);
  expect(publishDocument(db, {
    conversationId: cid, operationId: second.operationId, candidateId: second.id,
    expectedCandidateSha256: second.sha256, specId: spec.specId, specRevision: spec.revision,
    validationId: validation2.validationId, disposition: "ready",
  }).disposition).toBe("ready");
});

it("B07：TTL 只清理已终止且无引用的候选，活跃引用与租约必须保留", async () => {
  const db = await makeDb();
  const cid = makeConversation(db);
  const expired = createCandidateDocument(db, { conversationId: cid, name: "过期", ext: "txt", bytes: Buffer.from("x"), operationId: "op-expired", ttlMs: -1 });
  const leased = createCandidateDocument(db, { conversationId: cid, name: "租约", ext: "txt", bytes: Buffer.from("y"), operationId: "op-leased", lease: "run-1", ttlMs: -1 });
  const protectedCandidate = createCandidateDocument(db, { conversationId: cid, name: "活跃", ext: "txt", bytes: Buffer.from("z"), operationId: "op-active", ttlMs: -1 });
  db.specs.registerFamilyRef({ familyId: protectedCandidate.id, conversationId: cid, owner: "run-active", kind: "running" });
  const removed = cleanupExpiredCandidates(db);
  expect(removed).toContain(expired.id);
  expect(removed).not.toContain(leased.id);
  expect(removed).not.toContain(protectedCandidate.id);
  expect(fs.existsSync(expired.full)).toBe(false);
  expect(fs.existsSync(leased.full)).toBe(true);
  expect(fs.existsSync(protectedCandidate.full)).toBe(true);
});

it("B08：重启对账清理磁盘字节已丢失的候选登记，不重复增加版本", async () => {
  const db = await makeDb();
  const cid = makeConversation(db);
  const created = createCandidateDocument(db, { conversationId: cid, name: "孤儿", ext: "txt", bytes: Buffer.from("orphan"), operationId: "op-orphan" });
  fs.rmSync(created.full, { force: true });
  const result = reconcileCandidates(db);
  expect(result.removedOrphans).toContain(created.id);
  expect(db.getCandidateById(cid, created.id)).toBeNull();
  expect(db.listWorkspaceDocuments(cid)).toHaveLength(0);
});

it("B09：无任务契约的普通文档也经过统一 publish，报告绑定文件哈希", async () => {
  const db = await makeDb();
  const cid = makeConversation(db);
  const bytes = Buffer.from("plain-text");
  const saved = saveWorkspaceDocument(db, cid, "说明", "txt", bytes, "op-plain");
  expect(db.listWorkspaceDocuments(cid).map(file => file.id)).toEqual([saved.id]);
  expect(db.getPublishLog(cid, "op-plain")?.candidateSha256).toBe(sha(bytes));
  expect(db.getPublishLog(cid, "op-plain")?.validationId).toBeNull();
});

it("B10：硬检查 blocking 时中间稿留在候选区，不进入用户版本链", async () => {
  const db = await makeDb();
  const cid = makeConversation(db);
  await makeSpec(db, cid);
  expect(() => saveWorkspaceDocument(db, cid, "越范围", "pptx", Buffer.from("blocked"), "op-blocked", undefined, undefined, {
    plan: makePlan(10, 7), baselinePlan: makePlan(10), targets: [3],
  })).toThrow(/文档契约校验未通过/);
  expect(db.listWorkspaceDocuments(cid)).toHaveLength(0);
  expect(db.getPublishLog(cid, "op-blocked")).toBeNull();
  expect(db.listWorkspaceDocuments(cid, { includeCandidates: true }).some(file => file.state === "candidate")).toBe(true);
});

it("B12：用户要求检查完成再交付时，候选等待检查而不产生正式版本", async () => {
  const db = await makeDb();
  const cid = makeConversation(db);
  await makeSpec(db, cid);
  expect(() => saveWorkspaceDocument(db, cid, "待检查", "pptx", Buffer.from("pending"), "op-before", undefined, undefined, {
    plan: makePlan(10), visualPolicy: "before_publish",
  })).toThrow(PublishPending);
  expect(db.listWorkspaceDocuments(cid)).toHaveLength(0);
  expect(db.getPublishLog(cid, "op-before")).toBeNull();
  expect(db.listWorkspaceDocuments(cid, { includeCandidates: true }).some(file => file.state === "candidate")).toBe(true);
  // 视觉检查完成后用同一操作继续交付，不重复增加版本。
  const saved = saveWorkspaceDocument(db, cid, "待检查", "pptx", Buffer.from("pending"), "op-before", undefined, undefined, {
    plan: makePlan(10), visualPolicy: "before_publish", visualReview: { status: "complete", blocking: [] },
  });
  expect(db.listWorkspaceDocuments(cid).map(file => file.id)).toEqual([saved.id]);
  expect(db.getPublishLog(cid, "op-before")?.disposition).toBe("ready");
});

it("B11：迁移后直接登记的历史文件默认 published，仍可下载", async () => {
  const db = await makeDb();
  const cid = makeConversation(db);
  const legacy = db.addWorkspaceDocument(cid, "legacy.txt", 4, "op-legacy");
  const listed = db.listWorkspaceDocuments(cid);
  expect(listed.map(file => file.id)).toContain(legacy.id);
  expect(listed.find(file => file.id === legacy.id)?.state).toBe("published");
  expect(db.getWorkspaceDocumentByOperation(cid, "op-legacy")?.id).toBe(legacy.id);
});
