import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { AppDatabase } from "../src/server/db";
import { checkPresentationContract } from "../src/server/presentation-contract-check";
import { executeChatDocumentTool, readWorkspaceFile, saveWorkspaceDocument } from "../src/server/chat-tools/documents";
import { boundSpecRefFromReport, resolveContractSpec } from "../src/server/presentation-contract-resolution";
import { revisePresentation } from "../src/server/presentation-revision";
import { renderAiPresentation, type AiPresentation } from "../src/server/mind-document";
import { packPresentationProject } from "../src/server/presentation-project";
import { cleanupExpiredCandidates, completePendingVisualCheck, PublishPending, reconcilePendingVisualChecks } from "../src/server/document-publish";
import type { TemplateReport } from "../src/shared/presentation-report";
import type { PresentationSpec } from "../src/shared/presentation-spec";

/**
 * 跨入口回归：不再只分别调用单个模块，而是串起
 * 生成 → 修改 → 切换任务 → 补做 → 检查 → 发布。
 * 同时钉住四组验收边界（契约绑定 / 视觉等待 / 证据核验 / 状态回传）。
 */
const databases: AppDatabase[] = [];
async function makeDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "presentation-cross-"));
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
function cid(db: AppDatabase) {
  return db.createConversation({
    title: "跨入口", brainChannelId: "mock", brainModel: "mock",
    videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false,
  }).id;
}
const evidence = { sourceMessageId: "m1", text: "10 页" };
const pageCount = (value: number) => ({ kind: "exact" as const, value, evidence });
function plan(pages = 10): AiPresentation {
  return {
    title: "培训", theme: "blue",
    slides: Array.from({ length: pages }, (_, index) => ({
      layout: "content" as const, title: `第 ${index + 1} 页`, subtitle: "",
      lines: [`普通正文 ${index + 1}：交付周期从 30 天压缩到 12 天`],
      notes: index === 2 ? "来源原文\n第 3 页的原始来源事实，用于补做与审校。" : "",
      sourceIds: [`s-${index + 1}`],
    })),
  };
}
const bytes = () => Buffer.from("pptx-placeholder");
const baseReport = (): TemplateReport => ({
  draft: false, resume: false, fallbackPages: [], pendingPages: [], overflowPages: [],
  sourceLimitedPages: [], notesLimitedPages: [], unplacedImages: 0,
  planningFallback: false, audit: "unavailable", issues: [],
});
function activeSpec(db: AppDatabase, conversationId: string, value = 10, visualPolicy: "background" | "before_publish" = "background") {
  const spec = db.specs.create({ conversationId, pageCount: pageCount(value), visualPolicy });
  db.specs.setLifecycle(spec.specId, "active");
  return db.specs.get(spec.specId)!;
}
const sha = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");

// ── ① 契约绑定 ───────────────────────────────────────────────────────────
it("H01：显式绑定不存在 / 越权 / 版本失效都必须拒绝，不能静默转为无契约", async () => {
  const db = await makeDb();
  const c = cid(db);
  const spec = activeSpec(db, c);
  const other = activeSpec(db, cid(db));
  const cases: Array<{ label: string; specRef: { specId: string; specRevision: number } }> = [
    { label: "不存在", specRef: { specId: "missing-spec", specRevision: 1 } },
    { label: "越权", specRef: { specId: other.specId, specRevision: other.revision } },
    { label: "版本失效", specRef: { specId: spec.specId, specRevision: spec.revision + 99 } },
  ];
  for (const item of cases) {
    expect(() => saveWorkspaceDocument(db, c, `拒绝-${item.label}`, "pptx", bytes(), `op-reject-${item.label}`, undefined, undefined,
      { plan: plan(), specRef: item.specRef }), item.label).toThrow(/拒绝发布/);
  }
  expect(db.listWorkspaceDocuments(c)).toHaveLength(0);
  expect(db.listWorkspaceDocuments(c, { includeCandidates: true })).toHaveLength(0);
});

it("H02：只有真正没有绑定的旧文件才走 active 兼容路径，且仍产生可信检查结果", async () => {
  const db = await makeDb();
  const c = cid(db);
  const spec = activeSpec(db, c);
  // 旧形态：只带 expectedSpec*，同样视为显式绑定；不再误用 findActive 的别份契约。
  const saved = saveWorkspaceDocument(db, c, "旧文件", "pptx", bytes(), "op-legacy", undefined, undefined,
    { plan: plan(), expectedSpecId: spec.specId, expectedSpecRevision: spec.revision });
  expect(saved.disposition).toBe("ready");
  expect(db.getPublishLog(c, "op-legacy")?.validationId).toBeTruthy();
  expect(resolveContractSpec(db, c, {}).spec?.specId).toBe(spec.specId);
  expect(resolveContractSpec(db, c, { specRef: { specId: spec.specId, specRevision: spec.revision } }).source).toBe("bound");
});

it("H03：文件绑定的契约失效时，补做入口在读取阶段就拒绝", async () => {
  const db = await makeDb();
  const c = cid(db);
  const report = { ...baseReport(), specRef: { specId: "gone", specRevision: 7 } };
  expect(() => boundSpecRefFromReport(db, c, report)).toThrow(/拒绝发布/);
});

// ── ④ 状态回传 ───────────────────────────────────────────────────────────
it("H04：整页编辑被门禁判草稿时，工具结果如实回传最终报告与三态", async () => {
  const db = await makeDb();
  const c = cid(db);
  const deck = plan();
  const rendered = await renderAiPresentation(deck);
  const packed = await packPresentationProject(rendered, deck, []);
  const source = saveWorkspaceDocument(db, c, "十页", "pptx", packed, "op-source", baseReport());
  activeSpec(db, c, 12);
  const result = await executeChatDocumentTool(db, c, "doc_edit", JSON.stringify({
    fileId: source.id, expectedSha256: sha(packed),
    pages: [{ page: 3, content: { page: 3, title: "三项关键指标", layout: "kpi", metrics: [{ label: "覆盖率", value: "92%" }, { label: "周转", value: "3 天" }] } }],
  }), undefined, "op-edit");
  expect(result.ok).toBe(true);
  expect(result.uiData?.presentation?.draft).toBe(true);
  expect(result.uiData?.documentStatus).toMatchObject({ fileProduced: true, downloadableDraft: true, taskCompleted: false, disposition: "draft" });
  expect(result.summary).toContain("草稿可下载，任务未完成");
  expect(result.summary).toContain("总页数");
  // 数据库里的报告与回传一致，不会「聊天说完成、库里是草稿」。
  expect(db.getPresentationVersion(c, String(result.data!.fileId))?.report.reason).toBe(result.uiData?.presentation?.reason);
});

// ── ③ 证据核验 ───────────────────────────────────────────────────────────
it("H05：素材绑定覆盖封面、图片身份与哈希，并真正传到门禁", async () => {
  const db = await makeDb();
  const c = cid(db);
  const created = db.specs.create({ conversationId: c });
  const spec = db.specs.update(created.specId, {
    requiredAssets: [{ assetId: "cover-1", sha256: "cover-hash", evidence }],
  }, "指定封面素材", "m1");
  const deck = plan(2);
  deck.slides[0] = {
    ...deck.slides[0]!, layout: "cover",
    elements: [{ id: "cover-image", type: "image", x: 6, y: 1, w: 5, h: 5, imageIndex: 0, fit: "contain" as const }],
  };
  const good = saveWorkspaceDocument(db, c, "带封面", "pptx", bytes(), "op-cover", undefined, undefined, {
    plan: deck, specRef: { specId: spec.specId, specRevision: spec.revision },
    assetBindings: [{ assetId: "cover-1", imageIndex: 0, sha256: "cover-hash", cover: true }],
  });
  expect(good.disposition).toBe("ready");
  const bad = saveWorkspaceDocument(db, c, "换图", "pptx", Buffer.from("other"), "op-cover-bad", undefined, undefined, {
    plan: deck, specRef: { specId: spec.specId, specRevision: spec.revision },
    assetBindings: [{ assetId: "cover-1", imageIndex: 0, sha256: "wrong-hash", cover: true }],
  });
  expect(bad.disposition).toBe("draft");
  expect(bad.report?.reason).toContain("哈希");
});

it("H06：语义核验绑定候选哈希 + revision + 要求 ID，文件改变后失效，可信结论可解除 unknown", async () => {
  const db = await makeDb();
  const c = cid(db);
  const item = {
    id: "r1", evidence, description: "保留三个案例的结论", placement: "visible" as const,
    sourceRefs: [], verification: "semantic" as const,
  };
  const spec = db.specs.create({ conversationId: c, requiredContent: [item] });
  const buffer = bytes();
  const input = { conversationId: c, spec, plan: plan(), bytes: buffer };
  const before = checkPresentationContract(db.specs, input);
  expect(before.validation?.failures.map(f => f.code)).toContain("REQUIRED_UNKNOWN");
  expect(before.validation?.visibleCoverage.unknown).toBe(1);

  // 可信核验方给出「正文证据 + 来源」的结论，unknown 才能解除。
  const verdict = {
    requiredId: "r1", status: "satisfied" as const,
    evidence: "案例 A：交付周期从 30 天压缩到 12 天", sourceRef: "s-1", verifiedBy: "content-audit" as const,
  };
  const after = checkPresentationContract(db.specs, { ...input, requirementVerifications: [verdict] });
  expect(after.validation?.ok).toBe(true);
  expect(after.validation?.visibleCoverage.satisfied).toBe(1);
  const records = db.specs.listRequirementVerifications(spec.specId, spec.revision, sha(buffer));
  expect(records).toEqual(expect.arrayContaining([
    expect.objectContaining({ requiredId: "r1", status: "satisfied", method: "content-audit", fileSha256: sha(buffer) }),
  ]));
  // 同一文件的历史核验结论也保留，可回溯「从 unknown 到 satisfied」的过程。
  expect(records.some(item => item.status === "unverified")).toBe(true);

  // 字节一变，旧结论查不到，重新变成 unknown，不会被旧证据放行。
  const changed = checkPresentationContract(db.specs, { ...input, bytes: Buffer.from("changed") });
  expect(changed.validation?.failures.map(f => f.code)).toContain("REQUIRED_UNKNOWN");
  // 新哈希下不存在任何 satisfied 结论（检查器自己写的 unverified 不算放行证据）。
  expect(db.specs.listRequirementVerifications(spec.specId, spec.revision, sha(Buffer.from("changed")))
    .filter(item => item.status === "satisfied")).toEqual([]);
});

it("H07：原话可确定性核验；案例结论不能只靠逐字出现或角色标签通过", async () => {
  const db = await makeDb();
  const quote = "所有数值均为虚构";
  const spec = db.specs.create({
    conversationId: "c1",
    requiredContent: [
      { id: "r1", evidence, description: quote, placement: "visible" as const, sourceRefs: [], verification: "semantic" as const },
      { id: "r2", evidence, description: "保留三个案例的结论", placement: "visible" as const, sourceRefs: [], verification: "semantic" as const },
    ],
  });
  const deck = plan(3);
  deck.slides[0] = { ...deck.slides[0]!, lines: [quote, "保留三个案例的结论"] };
  const checked = checkPresentationContract(db.specs, { conversationId: "c1", spec, plan: deck, bytes: bytes() });
  const methods = db.specs.listRequirementVerifications(spec.specId, spec.revision, sha(bytes()));
  expect(methods.find(item => item.requiredId === "r1")?.method).toBe("verbatim");
  expect(methods.find(item => item.requiredId === "r2")?.status).toBe("unverified");
  expect(checked.validation?.failures.some(item => item.code === "REQUIRED_UNKNOWN")).toBe(true);
});

// ── ② 视觉等待与续行 ────────────────────────────────────────────────────
it("H08：等待不是 failed；候选受保护、可重启恢复，检查完成后只发布一次同一候选", async () => {
  const db = await makeDb();
  const c = cid(db);
  const spec = activeSpec(db, c, 10, "before_publish");
  const source = await executeChatDocumentTool(db, c, "doc_create", JSON.stringify({ kind: "md", name: "资料", content: "# 标题\n正文" }));
  const result = await executeChatDocumentTool(db, c, "doc_convert", JSON.stringify({ fileId: source.data!.fileId, to: "pptx" }),
    async () => plan(), "op-wait", async p => ({ plan: p, summary: "未启用看图", status: "unavailable" as const }),
    { specRef: { specId: spec.specId, specRevision: spec.revision } });
  expect(result.paused).toBe(true);
  expect(result.ok).toBe(false); // 文件尚未交付
  expect(result.summary).toContain("等待视觉检查");
  expect(result.pendingVisualCheck).toBeTruthy();
  const candidateId = result.pendingVisualCheck!.candidateId;
  const candidate = db.getCandidateByOperation(c, "op-wait")!;
  expect(candidate.meta?.pendingPublish).toBeTruthy();
  expect(candidate.meta?.visualCheck?.status).toBe("waiting");
  expect(db.getPublishLog(c, "op-wait")).toBeNull();
  expect(db.listWorkspaceDocuments(c)).not.toContainEqual(expect.objectContaining({ id: candidateId }));

  // 活跃候选不被 TTL 清理；重启恢复能重新排队。
  expect(cleanupExpiredCandidates(db, Date.now() + 25 * 3600_000)).not.toContain(candidateId);
  expect(reconcilePendingVisualChecks(db).resumed).toContain(candidateId);

  const published = completePendingVisualCheck(db, {
    conversationId: c, candidateId, status: "complete", source: "wps-render", summary: "WPS 已核验 10/10 页",
  });
  expect(published?.fileId).toBe(candidateId);
  expect(db.listWorkspaceDocuments(c).map(file => file.id)).toContain(candidateId);
  expect(db.getPublishLog(c, "op-wait")?.publishedId).toBe(candidateId);
  expect(db.listPendingVisualPublishes()).toHaveLength(0);
  // 重复回调不会再加版本。
  expect(completePendingVisualCheck(db, {
    conversationId: c, candidateId, status: "complete", source: "wps-render",
  })).toBeNull();
  expect(db.listWorkspaceDocuments(c).filter(file => file.id === candidateId)).toHaveLength(1);
  expect(db.getPresentationVersion(c, candidateId)?.report.draft).toBe(false);
});

it("H09：正常调用带回真实检查完成状态时，一次发布，不进入等待", async () => {
  const db = await makeDb();
  const c = cid(db);
  const spec = activeSpec(db, c, 10, "before_publish");
  const saved = saveWorkspaceDocument(db, c, "已检查", "pptx", bytes(), "op-checked", undefined, undefined, {
    plan: plan(), specRef: { specId: spec.specId, specRevision: spec.revision },
    visualPolicy: "before_publish", visualReview: { status: "complete", blocking: [] },
  });
  expect(saved.disposition).toBe("ready");
  expect(db.listWorkspaceDocuments(c, { includeCandidates: true })).toHaveLength(1);
});

// ── 跨入口主链路 ─────────────────────────────────────────────────────────
it("H10：生成 → 修改 → 切换任务 → 补做 → 检查 → 发布，全程按文件绑定的契约", async () => {
  const db = await makeDb();
  const c = cid(db);
  const specA = activeSpec(db, c, 10);
  const binding = { specId: specA.specId, specRevision: specA.revision };

  // 1. 生成：显式绑定 specA，报告写入 specRef。
  const deck = plan();
  const rendered = await renderAiPresentation(deck);
  const packed = await packPresentationProject(rendered, deck, []);
  const first = saveWorkspaceDocument(db, c, "十页", "pptx", packed, "op-gen", {
    ...baseReport(), fallbackPages: [3], issues: [{ page: 3, detail: "第 3 页待补做" }],
  }, undefined, { plan: deck, specRef: binding });
  expect(first.report?.specRef).toEqual(binding);

  // 2. 修改：整页编辑继承文件绑定的 specA。
  const edited = await executeChatDocumentTool(db, c, "doc_edit", JSON.stringify({
    fileId: first.id, expectedSha256: sha(packed),
    pages: [{ page: 2, content: { page: 2, title: "第 2 页修改版", layout: "bullets", bullets: ["修改后的正文：交付周期 12 天"] } }],
  }), undefined, "op-edit-chain");
  expect(edited.ok).toBe(true);
  const editedId = String(edited.data!.fileId);
  expect(db.getPresentationVersion(c, editedId)?.report.specRef).toEqual(binding);

  // 3. 切换任务：另一份 PPT 的要求变成会话当前 active（12 页）。
  const specB = activeSpec(db, c, 12);
  expect(db.specs.findActive(c)?.specId).toBe(specB.specId);

  // 4. 补做旧文件第 3 页：必须仍按 specA 校验，不能被 specB 拦住。
  const editedBytes = readWorkspaceFile(db, c, editedId).bytes;
  const call = async () => ({
    content: JSON.stringify({ page: 3, title: "第 3 页补做", layout: "bullets", bullets: ["补做正文：来源原文里的关键事实"] }),
    truncated: false,
  });
  const redo = await revisePresentation(db, c, editedId, sha(editedBytes), { kind: "page", page: 3 }, call, new AbortController().signal);
  expect(redo).not.toBeNull();
  const redoReport = db.getPresentationVersion(c, redo!.id)!.report;
  expect(redoReport.specRef).toEqual(binding);
  expect(redoReport.draft).toBe(false);
  expect(redoReport.fallbackPages).not.toContain(3);

  // 5-6. 检查完成后发布同一候选，且只发一次。
  const pendingSpec = activeSpec(db, c, 10, "before_publish");
  let pendingError: PublishPending | null = null;
  try {
    saveWorkspaceDocument(db, c, "待检查", "pptx", Buffer.from("final-candidate"), "op-final", undefined, undefined, {
      plan: plan(), specRef: { specId: pendingSpec.specId, specRevision: pendingSpec.revision },
    });
  } catch (error) { pendingError = error as PublishPending; }
  expect(pendingError).toBeInstanceOf(PublishPending);
  const finished = completePendingVisualCheck(db, {
    conversationId: c, candidateId: pendingError!.candidateId,
    status: "complete", source: "wps-render", summary: "WPS 已核验",
  });
  expect(finished?.fileId).toBe(pendingError!.candidateId);
  expect(db.getPublishLog(c, "op-final")?.disposition).toBe("ready");
});
