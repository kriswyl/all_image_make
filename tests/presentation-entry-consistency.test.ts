import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { AppDatabase } from "../src/server/db";
import { checkPresentationContract } from "../src/server/presentation-contract-check";
import { saveWorkspaceDocument } from "../src/server/chat-tools/documents";
import { resolvePresentationSpec, runPresentationSpecUpdate } from "../src/server/chat-tools/presentation-spec-tool";
import type { AiPresentation } from "../src/server/mind-document";

/** GPT 审查发现的「入口之间数据传递与状态一致性」问题，逐条钉住。 */
const databases: AppDatabase[] = [];
async function makeDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "presentation-entry-"));
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

function planWith(pages: number, options: { titleOnlyFact?: string } = {}): AiPresentation {
  return {
    title: "培训", theme: "blue",
    slides: Array.from({ length: pages }, (_, index) => ({
      layout: "content" as const,
      title: index === 0 ? options.titleOnlyFact ?? `第 ${index + 1} 页` : `第 ${index + 1} 页`,
      subtitle: "", lines: ["示例事实"], notes: "", sourceIds: [`s-${index + 1}`],
    })),
  };
}
const bytes = () => Buffer.from("pptx-placeholder");
function makeConversation(db: AppDatabase): string {
  return db.createConversation({
    title: "入口一致性", brainChannelId: "mock-channel", brainModel: "mock",
    videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false,
  }).id;
}

it("G01：模型传来的 specId 不能跨会话修改契约", async () => {
  const db = await makeDb();
  const created = db.specs.create({ conversationId: "c1", pageCount: { kind: "exact", value: 8, evidence: { sourceMessageId: "m1", text: "8 页" } } });
  const result = runPresentationSpecUpdate(db, "c2", "改成 12 页", "m9", JSON.stringify({
    intent: "update", specId: created.specId, pageCountText: undefined,
  }));
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("不属于当前会话");
  // 原契约没有被改动
  const untouched = db.specs.get(created.specId)!;
  expect(untouched.revision).toBe(1);
  expect(untouched.pageCount).toMatchObject({ value: 8 });
});

it("G02：已有 10 页要求时，本轮「改成 12 页」是新 revision，而不是丢弃", async () => {
  const db = await makeDb();
  const first = runPresentationSpecUpdate(db, "c1", "做成 10 页", "m1", JSON.stringify({ intent: "create", prepareOnly: true }));
  expect(first.ok).toBe(true);
  const specId = String((first.data as { specId: string }).specId);
  const resolved = resolvePresentationSpec(db, "c1", "改成 12 页", "m2");
  expect(resolved.conflict).toBeUndefined();
  expect(resolved.spec?.specId).toBe(specId);
  expect(resolved.spec?.pageCount).toMatchObject({ kind: "exact", value: 12 });
  expect(resolved.spec?.revision).toBe(2);
  // 旧 revision 仍可回溯
  expect(db.specs.atRevision(specId, 1)?.pageCount).toMatchObject({ value: 10 });
});

it("G03：两份待制作要求时，「开始」不能盲选其中一份", async () => {
  const db = await makeDb();
  runPresentationSpecUpdate(db, "c1", "做成 10 页", "m1", JSON.stringify({ intent: "create", prepareOnly: true }));
  runPresentationSpecUpdate(db, "c1", "另做一份 8 页的", "m2", JSON.stringify({ intent: "fork", prepareOnly: true }));
  expect(db.specs.listPrepared("c1").length).toBe(2);
  const resolved = resolvePresentationSpec(db, "c1", "开始", "m3");
  expect(resolved.spec).toBeNull();
  expect(resolved.conflict).toContain("多份");
});

it("G04：「重做第 3 页」是修改，不是新任务", async () => {
  const db = await makeDb();
  const first = runPresentationSpecUpdate(db, "c1", "做成 10 页", "m1", JSON.stringify({ intent: "create", prepareOnly: true, requiredContent: ["示例事实"] }));
  const specId = String((first.data as { specId: string }).specId);
  const resolved = resolvePresentationSpec(db, "c1", "重做第 3 页", "m2");
  expect(resolved.created ?? false).toBe(false);
  expect(resolved.spec?.specId).toBe(specId);
});

it("G05：发布校验用执行绑定的那一版契约，不看会话当前的 active", async () => {
  const db = await makeDb();
  const c1 = makeConversation(db);
  let spec = db.specs.create({ conversationId: c1, pageCount: { kind: "exact", value: 10, evidence: { sourceMessageId: "m1", text: "10 页" } } });
  spec = db.specs.setLifecycle(spec.specId, "active");
  const bound = { specId: spec.specId, specRevision: spec.revision };
  // 制作过程中用户把要求改成 12 页：active 现在是 revision 2
  db.specs.update(spec.specId, { pageCount: { kind: "exact", value: 12, evidence: { sourceMessageId: "m2", text: "12 页" } } }, "改页数", "m2");
  // 本次执行仍按绑定的 10 页发布，不应被新 revision 卡住
  const saved = saveWorkspaceDocument(db, c1, "十页", "pptx", bytes(), "op-bound", undefined, undefined, { plan: planWith(10), specRef: bound });
  expect(db.specs.get(spec.specId)?.revision).toBeGreaterThan(bound.specRevision);
  expect(saved.report?.draft).toBe(false);
  expect(saved.disposition).toBe("ready");
});

it("G06：门禁判成草稿时，保存结果必须带回 disposition 与最终报告", async () => {
  const db = await makeDb();
  const c1 = makeConversation(db);
  const spec = db.specs.setLifecycle(db.specs.create({
    conversationId: c1, pageCount: { kind: "exact", value: 12, evidence: { sourceMessageId: "m1", text: "12 页" } },
  }).specId, "active");
  const saved = saveWorkspaceDocument(db, c1, "十页", "pptx", bytes(), "op-draft", undefined, undefined,
    { plan: planWith(10), specRef: { specId: spec.specId, specRevision: spec.revision } });
  expect(saved.disposition).toBe("draft");
  expect(saved.report?.draft).toBe(true);
  expect(saved.report?.reason).toContain("总页数");
  // 数据库里的报告与返回值一致，不能一边说完成一边存草稿
  expect(db.getPresentationVersion(c1, saved.id)?.report.draft).toBe(true);
});

it("G07：标题里有、元素里没画出来的内容不算可见（模型元素页）", async () => {
  const db = await makeDb();
  const plan = planWith(3);
  // 元素页：title 只在元数据里，正文元素只有占位文字
  plan.slides[0] = {
    layout: "content", title: "示例事实 42", subtitle: "", notes: "", sourceIds: ["s-1"], lines: [],
    elements: [{ type: "text", id: "body", x: 1, y: 1, w: 6, h: 2, text: "与要求无关的正文", style: { fontSize: 20 } }],
  };
  const spec = db.specs.create({
    conversationId: "c1",
    requiredContent: [{
      id: "r1", evidence: { sourceMessageId: "m1", text: "必须出现示例事实 42" },
      description: "示例事实 42", placement: "visible" as const, sourceRefs: [], verification: "deterministic" as const,
    }],
  });
  const checked = checkPresentationContract(db.specs, { conversationId: "c1", spec, plan, bytes: bytes() });
  expect(checked.validation?.ok).toBe(false);
  expect(checked.validation?.failures.map(item => item.code)).toContain("REQUIRED_NOT_VISIBLE");
});

it("G08：「检查完成再交付」写进 Spec，并传到发布层", async () => {
  const db = await makeDb();
  const result = runPresentationSpecUpdate(db, "c1", "做成 10 页，视觉检查完成再交付", "m1",
    JSON.stringify({ intent: "create", prepareOnly: true }));
  expect(result.ok).toBe(true);
  const spec = db.specs.get(String((result.data as { specId: string }).specId))!;
  expect(spec.visualPolicy).toBe("before_publish");
  expect(result.summary).toContain("视觉检查");
});
