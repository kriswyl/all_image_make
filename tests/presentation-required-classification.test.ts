import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { AppDatabase } from "../src/server/db";
import { runPresentationSpecUpdate } from "../src/server/chat-tools/presentation-spec-tool";
import { checkPresentationContract } from "../src/server/presentation-contract-check";
import type { AiPresentation } from "../src/server/mind-document";
import type { TemplateReport } from "../src/shared/presentation-report";

/**
 * 真实链路暴露的问题：「必须保留三个案例」「先不生成」被当成页面正文要求逐字匹配，
 * 导致产物永久停在草稿。结构要求走职责计划，过程指令不落库。
 */
const databases: AppDatabase[] = [];
async function makeDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "presentation-required-"));
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
const bytes = () => Buffer.from("pptx-placeholder");
const sha = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
function makePlan(pages = 10): AiPresentation {
  return {
    title: "培训", theme: "blue",
    slides: Array.from({ length: pages }, (_, index) => ({
      layout: "content" as const, title: `第 ${index + 1} 页`, subtitle: "",
      lines: ["示例事实"], notes: "", sourceIds: [`s-${index + 1}`],
    })),
  };
}
function makeReport(casePages: number | null): TemplateReport {
  const base: TemplateReport = {
    draft: false, resume: false, fallbackPages: [], pendingPages: [], overflowPages: [],
    sourceLimitedPages: [], notesLimitedPages: [], unplacedImages: 0,
    planningFallback: false, audit: "unavailable", issues: [],
  };
  if (casePages === null) return base;
  const pages = Array.from({ length: 10 }, (_, index) => ({
    page: index + 1,
    role: index < casePages ? "case" : "claim",
    layout: index < casePages ? "cards" : "bullets",
    fitsRole: true,
  }));
  return { ...base, deckPlan: { pages, repeatedRuns: [] } };
}

it("E01：案例数量要求进结构约束，过程指令不落库，正文必需内容为空", async () => {
  const db = await makeDb();
  const text = "做成 10 页，必须保留三个案例，先不生成";
  const result = runPresentationSpecUpdate(db, "c1", text, "m1", JSON.stringify({
    intent: "create", prepareOnly: true, requiredContent: ["必须保留三个案例", "先不生成"],
  }));
  expect(result.ok).toBe(true);
  const spec = db.specs.get(String((result.data as { specId: string }).specId))!;
  expect(spec.structure).toEqual([
    expect.objectContaining({ kind: "case_count", value: 3 }),
  ]);
  expect(spec.requiredContent).toEqual([]);
});

it("E02：可逐字验证的事实仍进 requiredContent，同时保留结构约束", async () => {
  const db = await makeDb();
  const text = "做成 10 页，正文要出现「示例订单量 100」，必须保留两个案例";
  const result = runPresentationSpecUpdate(db, "c1", text, "m1", JSON.stringify({
    intent: "create", requiredContent: ["示例订单量 100", "必须保留两个案例"],
  }));
  const spec = db.specs.get(String((result.data as { specId: string }).specId))!;
  expect(spec.requiredContent.map(item => item.description)).toEqual(["示例订单量 100"]);
  expect(spec.structure).toEqual([expect.objectContaining({ kind: "case_count", value: 2 })]);
});

it("E03：没有明确要求句时仍坚持逐字回读，模型推断不会升级成硬约束", async () => {
  const db = await makeDb();
  const result = runPresentationSpecUpdate(db, "c1", "做成 8 页", "m1", JSON.stringify({
    intent: "create", requiredContent: ["模型自己推断出的某个事实"],
  }));
  const spec = db.specs.get(String((result.data as { specId: string }).specId))!;
  expect(spec.requiredContent).toEqual([]);
  expect(spec.structure).toEqual([]);
});

it("E07：模型自己总结的执行要点不会被当成必需内容（真实链路复现）", async () => {
  const db = await makeDb();
  const text = "做成 10 页，必须保留三个案例";
  const result = runPresentationSpecUpdate(db, "c1", text, "m1", JSON.stringify({
    intent: "create",
    requiredContent: [
      "18 个虚构模块（F01–F18）归纳压缩进 10 页",
      "保留免责说明：全部数值与岗位均为虚构验收资料",
      "必须保留三个案例",
    ],
  }));
  const spec = db.specs.get(String((result.data as { specId: string }).specId))!;
  expect(spec.requiredContent).toEqual([]);
  expect(spec.structure).toEqual([expect.objectContaining({ kind: "case_count", value: 3 })]);
});

it("E08：整句任务指令不会被当成页面必需内容（真实链路复现）", async () => {
  const db = await makeDb();
  const text = "把这份 18 章文档整理成 10 页 PPT，含封面，必须保留三个案例";
  const result = runPresentationSpecUpdate(db, "c1", text, "m1", JSON.stringify({
    intent: "create", prepareOnly: true,
    requiredContent: [
      "把这份 18 章文档整理成 10 页 PPT",
      "含封面",
      "必须保留三个案例",
    ],
  }));
  expect(result.ok).toBe(true);
  const spec = db.specs.get(String((result.data as { specId: string }).specId))!;
  // 整句指令描述的是「做什么」，不会逐字出现在页面上；封面由 cover 字段表达。
  expect(spec.requiredContent).toEqual([]);
  expect(spec.cover).toBe("include");
  expect(spec.structure).toEqual([expect.objectContaining({ kind: "case_count", value: 3 })]);
});

it("E10：只写「封面」两字也归到 cover，不进必需内容（真实链路复现）", async () => {
  const db = await makeDb();
  const text = "做成 8 页 PPT，含封面，封面计入总页数";
  const result = runPresentationSpecUpdate(db, "c1", text, "m1", JSON.stringify({
    intent: "create", requiredContent: ["封面", "封面计入总页数"],
  }));
  expect(result.ok).toBe(true);
  const spec = db.specs.get(String((result.data as { specId: string }).specId))!;
  expect(spec.requiredContent).toEqual([]);
  expect(spec.cover).toBe("include");
});

it("E09：引号内原话照收，即使外层句子带「保留」等指令词", async () => {
  const db = await makeDb();
  const text = "做成 6 页，请务必保留这句「所有数值均为虚构」";
  const result = runPresentationSpecUpdate(db, "c1", text, "m1", JSON.stringify({
    intent: "create", requiredContent: ["请务必保留这句「所有数值均为虚构」"],
  }));
  const spec = db.specs.get(String((result.data as { specId: string }).specId))!;
  expect(spec.requiredContent.map(item => item.description)).toEqual(["所有数值均为虚构"]);
});

it("E04：职责计划里的案例页数满足要求时判可用，不足时明确失败", async () => {
  const db = await makeDb();
  const create = (value: number) => db.specs.create({
    conversationId: "c1",
    structure: [{ kind: "case_count", value, evidence: { sourceMessageId: "m1", text: "必须保留三个案例" } }],
  });
  const enough = checkPresentationContract(db.specs, {
    conversationId: "c1", spec: create(3), plan: makePlan(), bytes: bytes(), report: makeReport(3),
  });
  expect(enough.validation?.ok).toBe(true);
  expect(enough.validation?.failures).toEqual([]);
  expect(enough.validation?.visibleCoverage.satisfied).toBe(1);

  const short = checkPresentationContract(db.specs, {
    conversationId: "c1", spec: create(3), plan: makePlan(), bytes: bytes(), report: makeReport(2),
  });
  expect(short.validation?.ok).toBe(false);
  expect(short.validation?.failures.some(item => item.code === "STRUCTURE_CASE_COUNT")).toBe(true);
});

it("E05：缺少任何证据时明确未通过，未验证不能当成满足", async () => {
  const db = await makeDb();
  const spec = db.specs.create({
    conversationId: "c1",
    structure: [{ kind: "case_count", value: 3, evidence: { sourceMessageId: "m1", text: "必须保留三个案例" } }],
  });
  const result = checkPresentationContract(db.specs, {
    conversationId: "c1", spec, plan: makePlan(), bytes: bytes(), report: makeReport(null),
  });
  expect(result.validation?.ok).toBe(false);
  expect(result.validation?.readiness).toBe("draft");
  expect(result.validation?.failures.map(item => item.code)).toContain("STRUCTURE_UNVERIFIED");
  expect(result.validation?.visibleCoverage).toMatchObject({ required: 1, satisfied: 0, unknown: 1 });
});

it("E06：证据绑定原消息而不是模型改写后的描述", async () => {
  const db = await makeDb();
  const text = "做成 10 页，必须保留三个案例";
  const result = runPresentationSpecUpdate(db, "c1", text, "msg-42", JSON.stringify({
    intent: "create", requiredContent: ["必须保留三个案例"],
  }));
  const spec = db.specs.get(String((result.data as { specId: string }).specId))!;
  expect(spec.structure[0]?.evidence.sourceMessageId).toBe("msg-42");
  expect(text).toContain(spec.structure[0]!.evidence.text);
});
