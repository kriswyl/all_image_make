import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { AppDatabase } from "../src/server/db";
import { checkPresentationContract, visibleText } from "../src/server/presentation-contract-check";
import { saveWorkspaceDocument } from "../src/server/chat-tools/documents";
import type { AiPresentation } from "../src/server/mind-document";
import type { PresentationSpec } from "../src/shared/presentation-spec";

const databases: AppDatabase[] = [];
async function makeDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "presentation-contract-"));
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

const FACT = "示例事实 F01 数值 100";
function makePlan(pages: number, options: { visible?: string; notes?: string; changedPage?: number } = {}): AiPresentation {
  return {
    title: "培训", theme: "blue",
    slides: Array.from({ length: pages }, (_, index) => ({
      layout: "content" as const,
      title: `第 ${index + 1} 页`,
      subtitle: "",
      lines: [index + 1 === options.changedPage ? "这一页被意外改动" : options.visible ?? FACT],
      notes: options.notes ?? "",
      sourceIds: [`s-${index + 1}`],
    })),
  };
}

async function makeSpec(db: AppDatabase, conversationId: string, options: { pages?: number; required?: string; active?: boolean } = {}): Promise<PresentationSpec> {
  let spec = db.specs.create({ conversationId });
  spec = db.specs.update(spec.specId, {
    ...(options.pages ? { pageCount: { kind: "exact", value: options.pages, evidence: { sourceMessageId: "m1", text: `${options.pages} 页` } } } : {}),
    ...(options.required ? { requiredContent: [{
      id: "r1", evidence: { sourceMessageId: "m1", text: options.required },
      description: options.required, placement: "visible" as const, sourceRefs: [],
      verification: "deterministic" as const,
    }] } : {}),
  }, "设定测试契约", "m1");
  if (options.active) spec = db.specs.setLifecycle(spec.specId, "active");
  return spec;
}

const bytes = () => Buffer.from("pptx-placeholder");
function makeConversation(db: AppDatabase): string {
  return db.createConversation({
    title: "验收", brainChannelId: "mock-channel", brainModel: "mock",
    videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false,
  }).id;
}

it("A01 回归：没有任务契约时门禁不拦截，保持既有产物行为", async () => {
  const db = await makeDb();
  const result = checkPresentationContract(db.specs, {
    conversationId: "c1", spec: null, plan: makePlan(10), bytes: bytes(),
  });
  expect(result.validation).toBeNull();
  expect(result.blocking).toEqual([]);
});

it("A07：页数不符合契约时判为草稿，且门禁结果可持久化复核", async () => {
  const db = await makeDb();
  const spec = await makeSpec(db, "c1", { pages: 10, required: FACT });
  const result = checkPresentationContract(db.specs, {
    conversationId: "c1", spec, plan: makePlan(12), bytes: bytes(),
  });
  expect(result.validation?.ok).toBe(false);
  expect(result.validation?.readiness).toBe("draft");
  expect(result.validation?.failures.some(item => item.code === "PAGE_COUNT")).toBe(true);
  const stored = db.specs.getValidation(result.validation!.validationId)!;
  expect(stored.specRevision).toBe(spec.revision);
  expect(stored.ok).toBe(false);
});

it("A08：必需内容只出现在备注不算可见覆盖", async () => {
  const db = await makeDb();
  const spec = await makeSpec(db, "c1", { pages: 2, required: FACT });
  const plan = makePlan(2, { visible: "无关键数值", notes: `来源原文\n${FACT}` });
  expect(visibleText(plan)).not.toContain(FACT.replace(/\s/g, ""));
  const result = checkPresentationContract(db.specs, { conversationId: "c1", spec, plan, bytes: bytes() });
  expect(result.validation?.failures.some(item => item.code === "REQUIRED_NOT_VISIBLE")).toBe(true);
  expect(result.validation?.visibleCoverage.satisfied).toBe(0);
});

it("A07：修改范围外的页面发生变化必须阻止发布", async () => {
  const db = await makeDb();
  const spec = await makeSpec(db, "c1", { pages: 10 });
  const baseline = makePlan(10);
  const changed = makePlan(10, { changedPage: 7 });
  const result = checkPresentationContract(db.specs, {
    conversationId: "c1", spec, plan: changed, bytes: bytes(), baselinePlan: baseline, targets: [3],
  });
  expect(result.blocking.some(item => item.code === "SCOPE_VIOLATION")).toBe(true);
});

it("A01 回归：页数与必需内容都满足时判为可用", async () => {
  const db = await makeDb();
  const spec = await makeSpec(db, "c1", { pages: 10, required: FACT });
  const result = checkPresentationContract(db.specs, {
    conversationId: "c1", spec, plan: makePlan(10), bytes: bytes(),
  });
  expect(result.validation?.ok).toBe(true);
  expect(result.validation?.readiness).toBe("ready");
  expect(result.validation?.visibleCoverage.satisfied).toBe(1);
});

it("A07 出口回归：saveWorkspaceDocument 在契约不满足时把文件标成草稿", async () => {
  const db = await makeDb();
  const conversationId = makeConversation(db);
  await makeSpec(db, conversationId, { pages: 10, active: true });
  const saved = saveWorkspaceDocument(db, conversationId, "培训", "pptx", bytes(), undefined, undefined, undefined, { plan: makePlan(12) });
  const version = db.getPresentationVersion(conversationId, saved.id);
  expect(version?.report.draft).toBe(true);
  expect(version?.report.reason).toContain("总页数");
});

it("A07 出口回归：范围或归属失败不允许以草稿绕过，直接阻止保存", async () => {
  const db = await makeDb();
  const conversationId = makeConversation(db);
  const spec = await makeSpec(db, conversationId, { pages: 10, active: true });
  const baseline = makePlan(10);
  const changed = makePlan(10, { changedPage: 5 });
  expect(() => saveWorkspaceDocument(db, conversationId, "培训", "pptx", bytes(), undefined, undefined, undefined,
    { plan: changed, baselinePlan: baseline, targets: [3], expectedSpecId: spec.specId })).toThrow(/契约校验未通过/);
});
