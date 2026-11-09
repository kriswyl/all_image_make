import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { AppDatabase } from "../src/server/db";
import { executeChatDocumentTool, saveWorkspaceDocument } from "../src/server/chat-tools/documents";
import { renderAiPresentation, type AiPresentation } from "../src/server/mind-document";
import { packPresentationProject } from "../src/server/presentation-project";
import type { TemplateReport } from "../src/shared/presentation-report";

/** D2：doc_edit 收窄入参 —— 声明式 content 优先，整页元素只作遗留通道。 */
const databases: AppDatabase[] = [];
async function makeDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "presentation-declarative-"));
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
    title: "声明式修改", brainChannelId: "mock-channel", brainModel: "mock",
    videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false,
  }).id;
}
const plan: AiPresentation = {
  title: "十页资料", theme: "blue",
  slides: Array.from({ length: 10 }, (_, index) => ({
    layout: "content" as const, title: `第 ${index + 1} 页`, subtitle: "",
    lines: [`原始事实 ${index + 1}`], notes: "来源原文", sourceIds: [`s-${index + 1}`],
  })),
};

/** 源文件带一份 magazine 主题报告，用来验证「修改页沿用整稿主题」。 */
async function createSource(db: AppDatabase, conversationId: string, extra: Partial<TemplateReport> = {}) {
  const rendered = await renderAiPresentation(plan);
  const bytes = await packPresentationProject(rendered, plan, []);
  const report: TemplateReport = {
    draft: false, resume: false, fallbackPages: [], pendingPages: [], overflowPages: [],
    sourceLimitedPages: [], notesLimitedPages: [], unplacedImages: 0,
    planningFallback: false, audit: "unavailable", issues: [],
    theme: { id: "magazine", name: "杂志风", description: "测试用杂志风" },
    ...extra,
  };
  const saved = saveWorkspaceDocument(db, conversationId, "十页", "pptx", bytes, "op-create", report);
  return { saved, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const edit = (fileId: string, sha256: string, pages: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ fileId, expectedSha256: sha256, pages, ...extra });

it("N01：声明式 content 修改单页，坐标由渲染器按整稿主题生成", async () => {
  const db = await makeDb();
  const conversationId = makeConversation(db);
  const source = await createSource(db, conversationId);

  const result = await executeChatDocumentTool(db, conversationId, "doc_edit",
    edit(source.saved.id, source.sha256, [{
      page: 3,
      content: {
        page: 3, title: "三项关键指标", layout: "kpi",
        metrics: [{ label: "覆盖率", value: "92%" }, { label: "周转", value: "3 天" }],
      },
    }]), undefined, "op-declarative");
  expect(result.ok).toBe(true);

  const version = db.getPresentationVersion(conversationId, String(result.data!.fileId))!;
  const slide = JSON.parse(JSON.stringify(version.report)) as TemplateReport;
  expect(slide.freeformPages).toBeUndefined();
  // 报告仍带原主题，说明修改没有换皮肤
  expect(version.report.theme?.id).toBe("magazine");
});

it("N02：content 与 slide 只能二选一，缺一个或都给都拒绝", async () => {
  const db = await makeDb();
  const conversationId = makeConversation(db);
  const source = await createSource(db, conversationId);

  const both = await executeChatDocumentTool(db, conversationId, "doc_edit",
    edit(source.saved.id, source.sha256, [{
      page: 3,
      content: { page: 3, title: "结论", layout: "bullets", bullets: ["一"] },
      slide: { ...plan.slides[2] },
    }]), undefined, "op-both");
  expect(both.ok).toBe(false);
  expect(both.summary).toContain("只能提供");

  const neither = await executeChatDocumentTool(db, conversationId, "doc_edit",
    edit(source.saved.id, source.sha256, [{ page: 3 }]), undefined, "op-neither");
  expect(neither.ok).toBe(false);
  expect(neither.summary).toContain("只能提供");
});

it("N03：content 与版式不匹配时明确拒绝，不静默降级", async () => {
  const db = await makeDb();
  const conversationId = makeConversation(db);
  const source = await createSource(db, conversationId);

  const result = await executeChatDocumentTool(db, conversationId, "doc_edit",
    edit(source.saved.id, source.sha256, [{
      page: 3,
      content: { page: 3, title: "指标页", layout: "kpi", bullets: ["只有一个指标"] },
    }]), undefined, "op-invalid");
  expect(result.ok).toBe(false);
  expect(result.summary).toContain("content");
});

it("N04：渲染器生成的页不允许被改回整页元素", async () => {
  const db = await makeDb();
  const conversationId = makeConversation(db);
  const source = await createSource(db, conversationId);

  // 先把第 3 页改成声明式指标卡（渲染器元素）
  const first = await executeChatDocumentTool(db, conversationId, "doc_edit",
    edit(source.saved.id, source.sha256, [{
      page: 3,
      content: { page: 3, title: "指标页", layout: "kpi", metrics: [{ label: "覆盖", value: "92%" }, { label: "周转", value: "3 天" }] },
    }]), undefined, "op-renderer-1");
  expect(first.ok).toBe(true);
  const sha = String(first.data!.sha256 ?? "");

  // 再用整页元素覆盖同一页，必须被拒，并提示改用 content
  const second = await executeChatDocumentTool(db, conversationId, "doc_edit",
    edit(String(first.data!.fileId), sha, [{ page: 3, slide: { ...plan.slides[2], title: "整页元素改法" } }]),
    undefined, "op-renderer-2");
  expect(second.ok).toBe(false);
  expect(second.summary).toContain("content");
});

it("N06：重排过的页要清掉旧的容量结论，不能留着上一版的截断记录", async () => {
  const db = await makeDb();
  const conversationId = makeConversation(db);
  // 上一版第 3 页是表格且被压缩过
  const source = await createSource(db, conversationId, {
    capacity: {
      truncatedPages: [3, 7], reflowedPages: [],
      issues: [{ page: 3, detail: "table：单元格超过 12 字，已压缩并保留原文到备注" }],
    },
  });

  const result = await executeChatDocumentTool(db, conversationId, "doc_edit",
    edit(source.saved.id, source.sha256, [{
      page: 3,
      content: { page: 3, title: "阶段路径", layout: "timeline", steps: [{ title: "选点" }, { title: "试点" }, { title: "推广" }] },
    }]), undefined, "op-stale");
  expect(result.ok).toBe(true);

  const version = db.getPresentationVersion(conversationId, String(result.data!.fileId))!;
  // 第 3 页已经不是表格，旧的截断结论必须消失；没动过的第 7 页保留
  expect(version.report.capacity?.truncatedPages).toEqual([7]);
  expect(version.report.capacity?.issues.some(issue => issue.page === 3)).toBe(false);
});

it("N05：声明式修改只动目标页，其余页字节级保持", async () => {
  const db = await makeDb();
  const conversationId = makeConversation(db);
  const source = await createSource(db, conversationId);

  const result = await executeChatDocumentTool(db, conversationId, "doc_edit",
    edit(source.saved.id, source.sha256, [{
      page: 5,
      content: { page: 5, title: "阶段路径", layout: "timeline", steps: [{ title: "选点" }, { title: "试点" }, { title: "推广" }] },
    }]), undefined, "op-local");
  expect(result.ok).toBe(true);

  const { readPresentationProject } = await import("../src/server/presentation-project");
  const { readWorkspaceFile } = await import("../src/server/chat-tools/documents");
  const before = (await readPresentationProject(readWorkspaceFile(db, conversationId, source.saved.id).bytes))!;
  const after = (await readPresentationProject(readWorkspaceFile(db, conversationId, String(result.data!.fileId)).bytes))!;
  const untouched = (plan: AiPresentation, skip: number) => plan.slides.filter((_, index) => index !== skip);
  expect(untouched(after.plan, 4)).toEqual(untouched(before.plan, 4));
  // 目标页确实被重排成了时间轴
  const ids = (after.plan.slides[4]?.elements ?? []).map(element => element.id);
  expect(ids).toContain("timeline-axis");
});
