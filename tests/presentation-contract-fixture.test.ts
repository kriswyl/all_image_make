import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { AppDatabase } from "../src/server/db";
import { resolvePresentationSpec, runPresentationSpecUpdate } from "../src/server/chat-tools/presentation-spec-tool";
import { checkPresentationContract } from "../src/server/presentation-contract-check";
import { saveWorkspaceDocument } from "../src/server/chat-tools/documents";
import { chooseTargetPages, totalize, type PresentationSpec } from "../src/shared/presentation-spec";
import type { AiPresentation } from "../src/server/mind-document";
import { CHAPTERS, CHAPTER_COUNT, REQUIRED_FACTS, SOURCE_MARKDOWN } from "./fixtures/presentation-contract/sources";
import { ALL_REQUIRED_TEXT, REQUIREMENTS } from "./fixtures/presentation-contract/requirements";
import { CONVERSATION, NEUTRAL_MESSAGES } from "./fixtures/presentation-contract/conversation";
import { EXPECTED } from "./fixtures/presentation-contract/expected";

const databases: AppDatabase[] = [];
async function makeDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "presentation-fixture-"));
  const db = new AppDatabase(dir);
  databases.push(db);
  return { db, dir };
}
afterEach(() => {
  while (databases.length) {
    const db = databases.pop()!;
    try { db.close(); } catch { /* 已关闭 */ }
  }
});

function makeConversation(db: AppDatabase): string {
  return db.createConversation({
    title: "契约验收", brainChannelId: "mock-channel", brainModel: "mock",
    videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false,
  }).id;
}

function planOf(pages: number, text = ALL_REQUIRED_TEXT[0]!): AiPresentation {
  return {
    title: "虚构运营培训", theme: "blue",
    slides: Array.from({ length: pages }, (_, index) => ({
      layout: "content" as const, title: `第 ${index + 1} 页`, subtitle: "",
      lines: [text], notes: "", sourceIds: [`s-${index + 1}`],
    })),
  };
}

const constraintOf = (spec: PresentationSpec) => totalize(spec.pageCount!, spec.pageCountBasis);

it("fixture 自洽：18 章、必需事实都在源资料里，期望页数与章节数解耦", () => {
  expect(CHAPTERS).toHaveLength(CHAPTER_COUNT);
  expect((SOURCE_MARKDOWN.match(/^## /gm) ?? [])).toHaveLength(CHAPTER_COUNT);
  for (const fact of REQUIRED_FACTS) expect(SOURCE_MARKDOWN).toContain(fact);
  expect(EXPECTED.totalPages).toBeLessThan(EXPECTED.chapterEstimate);
  expect(REQUIREMENTS.pageCount.value).toBe(EXPECTED.totalPages);
});

it("A02/A03/A05：固定消息序列里要求只提一次，后续开始、换风格、改页数都正确继承", async () => {
  const { db } = await makeDb();
  const first = runPresentationSpecUpdate(db, "c1", CONVERSATION[0].text, CONVERSATION[0].messageId,
    JSON.stringify({ intent: "create", prepareOnly: true, requiredContent: REQUIREMENTS.requiredCases }));
  expect(first.ok).toBe(true);
  const specId = String(first.data!.specId);
  const prepared = db.specs.get(specId)!;
  expect(prepared.lifecycle).toBe("prepared");
  expect(constraintOf(prepared)).toMatchObject({ kind: "exact", value: EXPECTED.totalPages });

  const started = resolvePresentationSpec(db, "c1", CONVERSATION[1].text, CONVERSATION[1].messageId);
  expect(started.spec?.specId).toBe(specId);
  expect(chooseTargetPages(constraintOf(started.spec!), EXPECTED.chapterEstimate)).toBe(EXPECTED.totalPages);

  const styled = runPresentationSpecUpdate(db, "c1", CONVERSATION[2].text, CONVERSATION[2].messageId,
    JSON.stringify({ intent: "update", specId, styleText: "杂志风" }));
  expect(Number(styled.data!.specRevision)).toBeGreaterThan(prepared.revision);
  expect(constraintOf(db.specs.get(specId)!)).toMatchObject({ value: EXPECTED.totalPages });

  const edited = resolvePresentationSpec(db, "c1", CONVERSATION[3].text, CONVERSATION[3].messageId);
  expect(edited.spec?.specId).toBe(specId);
  expect(constraintOf(edited.spec!)).toMatchObject({ value: EXPECTED.totalPages });

  const revised = runPresentationSpecUpdate(db, "c1", CONVERSATION[4].text, CONVERSATION[4].messageId,
    JSON.stringify({ intent: "update", specId, pageCountText: "12 页" }));
  expect(db.specs.get(specId)!.pageCount).toMatchObject({ value: EXPECTED.revisedPages });
  expect(db.specs.atRevision(specId, Number(styled.data!.specRevision))!.pageCount).toMatchObject({ value: EXPECTED.totalPages });
  expect(Number(revised.data!.specRevision)).toBeGreaterThan(Number(styled.data!.specRevision));

  const fork = resolvePresentationSpec(db, "c1", CONVERSATION[5].text, CONVERSATION[5].messageId);
  if (EXPECTED.forkMustNotInherit) {
    expect(fork.created).toBe(true);
    expect(fork.spec?.specId).toBeTruthy();
    expect(fork.spec?.specId).not.toBe(specId);
    expect(fork.spec?.pageCount).toBeUndefined();
  }
});

it("A09：并发改 Spec 后旧执行不能发布；validation 绑定具体文件哈希", async () => {
  const { db } = await makeDb();
  let spec = db.specs.create({ conversationId: "c1" });
  spec = db.specs.update(spec.specId, {
    pageCount: { kind: "exact", value: 10, evidence: { sourceMessageId: "m1", text: "10 页" } },
  }, "指定页数", "m1");
  const stale = spec.revision;
  spec = db.specs.update(spec.specId, {
    pageCount: { kind: "exact", value: 12, evidence: { sourceMessageId: "m5", text: "12 页" } },
  }, "并发改成 12 页", "m5");

  const oldExecution = checkPresentationContract(db.specs, {
    conversationId: "c1", spec, plan: planOf(10), bytes: Buffer.from("bytes-v1"), expectedSpecRevision: stale,
  });
  expect(oldExecution.blocking.some(item => item.code === "SPEC_REVISION")).toBe(true);

  const fresh = checkPresentationContract(db.specs, {
    conversationId: "c1", spec, plan: planOf(12), bytes: Buffer.from("bytes-v2"),
    expectedSpecRevision: spec.revision,
  });
  expect(fresh.validation?.fileSha256).not.toBe(oldExecution.validation?.fileSha256);
  expect(db.specs.getValidation(fresh.validation!.validationId)!.specRevision).toBe(spec.revision);
});

it("A09：同一 operationId 的晚到结果复用已有文件，不重复产生版本", async () => {
  const { db } = await makeDb();
  const conversationId = makeConversation(db);
  db.specs.setLifecycle(db.specs.create({ conversationId }).specId, "active");
  const operationId = "op-late-result";
  const first = saveWorkspaceDocument(db, conversationId, "培训", "pptx", Buffer.from("a"), operationId, undefined, undefined, { plan: planOf(10) });
  const second = saveWorkspaceDocument(db, conversationId, "培训", "pptx", Buffer.from("b"), operationId, undefined, undefined, { plan: planOf(10) });
  expect(second.id).toBe(first.id);
  expect(db.listWorkspaceDocuments(conversationId)).toHaveLength(1);
});

it("A10：重启后契约仍在；旧断点按绑定 revision 恢复；模型漏调 Spec 工具时从当前消息补齐", async () => {
  const { db, dir } = await makeDb();
  const spec = db.specs.create({ conversationId: "c1" });
  const withPages = db.specs.update(spec.specId, {
    pageCount: { kind: "exact", value: 10, evidence: { sourceMessageId: "m1", text: "10 页" } },
  }, "指定页数", "m1");
  databases.pop()!.close();
  const reopened = new AppDatabase(dir);
  databases.push(reopened);
  expect(reopened.specs.get(spec.specId)?.pageCount).toMatchObject({ value: 10 });

  const resumed = resolvePresentationSpec(reopened, "c1", CONVERSATION[6].text, CONVERSATION[6].messageId,
    { specId: spec.specId, specRevision: withPages.revision });
  expect(resumed.spec?.revision).toBe(withPages.revision);

  const fallback = resolvePresentationSpec(reopened, "c2", "做成 8 页", "m8");
  expect(fallback.spec?.pageCount).toMatchObject({ value: 8 });
  for (const message of NEUTRAL_MESSAGES) {
    expect(resolvePresentationSpec(reopened, "c3", message, "m9").spec).toBeNull();
  }
});

it("A12：必需内容只在备注时标草稿；普通文本文件不受 PPT 门禁影响", async () => {
  const { db } = await makeDb();
  const conversationId = makeConversation(db);
  let spec = db.specs.create({ conversationId });
  spec = db.specs.update(spec.specId, {
    pageCount: { kind: "exact", value: 10, evidence: { sourceMessageId: "m1", text: "10 页" } },
    requiredContent: ALL_REQUIRED_TEXT.map((text, index) => ({
      id: `r${index}`, evidence: { sourceMessageId: "m1", text }, description: text,
      placement: "visible" as const, sourceRefs: [], verification: "deterministic" as const,
    })),
  }, "固定必需内容", "m1");
  db.specs.setLifecycle(spec.specId, "active");

  const hidden = planOf(10, "页面只有占位文字");
  hidden.slides.forEach(slide => { slide.notes = `来源原文\n${ALL_REQUIRED_TEXT.join("\n")}`; });
  const saved = saveWorkspaceDocument(db, conversationId, "培训", "pptx", Buffer.from("hidden"), undefined, undefined, undefined, { plan: hidden });
  const report = db.getPresentationVersion(conversationId, saved.id)!.report;
  expect(report.draft).toBe(true);
  expect(report.readiness).toBe("draft");
  expect(report.visibleCoverage?.satisfied).toBe(0);
  expect(report.contractValidation).toBeTruthy();

  const textFile = saveWorkspaceDocument(db, conversationId, "说明", "txt", Buffer.from("普通文本"), undefined);
  expect(db.getPresentationVersion(conversationId, textFile.id)).toBeNull();
});
