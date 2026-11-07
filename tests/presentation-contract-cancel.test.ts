import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { AppDatabase } from "../src/server/db";
import { markdownToMind } from "../src/server/chat-tools/markdown";
import { saveWorkspaceDocument } from "../src/server/chat-tools/documents";
import { PresentationPaused } from "../src/server/presentation-execution";
import { runTemplatePresentation } from "../src/server/presentation-workflow";

/** A09 补测：真实取消 / 晚到结果不能把中断草稿升级成可用成品。 */
const databases: AppDatabase[] = [];
async function makeDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "presentation-cancel-"));
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
    title: "取消验收", brainChannelId: "mock-channel", brainModel: "mock",
    videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false,
  }).id;
}
async function makeSpec(db: AppDatabase, conversationId: string, pages: number) {
  const created = db.specs.create({ conversationId });
  db.specs.update(created.specId, {
    pageCount: { kind: "exact", value: pages, evidence: { sourceMessageId: "m1", text: `${pages} 页` } },
  }, "设定页数契约", "m1");
  return db.specs.setLifecycle(created.specId, "active");
}

const chapters = Array.from({ length: 6 }, (_, index) => `模块${index + 1}：要点 ${index + 1}`);
const markdown = ["# 虚构培训", ...chapters.flatMap(title => [`## ${title}`, "需核对输入完整性并记录结果。"])].join("\n");
const mind = markdownToMind(markdown, "虚构培训");
const PAGES = 7;

type Call = Parameters<typeof runTemplatePresentation>[1];
function makeCall(options: { cancelAtPage?: number; abort?: () => void } = {}): Call {
  return async messages => {
    const instruction = String(messages[0]?.content);
    const input = JSON.parse(String(messages[1]?.content)) as {
      catalog?: Array<{ id: number }>; pages?: Array<{ page: number; title: string }>;
    };
    if (instruction.includes("总策划")) {
      return { content: JSON.stringify({
        title: "虚构培训", audience: "学员", objective: "掌握要点",
        pages: (input.catalog ?? []).map((row, index) => ({
          title: chapters[index] ?? `模块${index + 1}`, goal: "讲清本模块要点", batchIds: [row.id],
        })),
      }), truncated: false };
    }
    if (instruction.includes("审校") || !input.pages) return { content: JSON.stringify({ issues: [] }), truncated: false };
    if (options.cancelAtPage && input.pages.some(page => page.page === options.cancelAtPage)) {
      options.abort?.();
      throw new PresentationPaused("用户取消");
    }
    return { content: JSON.stringify({ pages: input.pages.map(page => ({
      page: page.page, title: page.title, layout: "bullets",
      bullets: [`要点 ${page.page}，需核对输入完整性`], notes: "按原文核对",
    })) }), truncated: false };
  };
}

async function cancelledRun(options: { abort?: () => void } = {}) {
  const cache = new Map<string, string>();
  const controller = new AbortController();
  if (options.abort) {
    // 让 signal 在内容批次中途真正进入 aborted 状态。
    const original = options.abort;
    options.abort = () => { controller.abort(); original(); };
  }
  // 有封面时正文页码从 2 起、每批最多 3 页；在第二批（页 5）取消才能留下部分产物。
  return runTemplatePresentation(mind, makeCall({ cancelAtPage: 5, abort: options.abort }), {
    request: `做成 ${PAGES} 页，封面计入总页数`, scope: "cancel-injection-test", images: [],
    signal: controller.signal,
    get: key => cache.get(key) ?? null,
    set: (key, value) => { cache.set(key, value); },
  });
}

it("A09-取消：中断后模板报告必须保持草稿与待补全标记", async () => {
  const result = await cancelledRun();
  expect(result.template.draft).toBe(true);
  expect(result.template.resume).toBe(true);
  expect(result.template.reason).toContain("用户取消");
  expect(result.template.pendingPages.length + result.template.fallbackPages.length).toBeGreaterThan(0);
});

it("A09-取消：中断草稿即使页数符合契约，也不得升级为可用成品", async () => {
  const result = await cancelledRun();
  expect(result.plan).not.toBeNull();
  const db = await makeDb();
  const conversationId = makeConversation(db);
  const spec = await makeSpec(db, conversationId, PAGES);
  const saved = saveWorkspaceDocument(db, conversationId, "取消草稿", "pptx",
    Buffer.from("cancelled-draft"), "op-cancel-1", result.template, undefined, { plan: result.plan! });
  const version = db.getPresentationVersion(conversationId, saved.id);
  expect(version?.report.draft).toBe(true);
  expect(version?.report.readiness).not.toBe("ready");
  expect(version?.report.usableReadyAt).toBeUndefined();
  expect(db.specs.get(spec.specId)?.revision).toBe(spec.revision);
});

it("A09-取消：晚到结果复用 operationId，不新增版本也不覆盖草稿状态", async () => {
  const result = await cancelledRun();
  const db = await makeDb();
  const conversationId = makeConversation(db);
  await makeSpec(db, conversationId, PAGES);
  const first = saveWorkspaceDocument(db, conversationId, "取消草稿", "pptx",
    Buffer.from("cancelled-draft"), "op-cancel-late", result.template, undefined, { plan: result.plan! });
  const late = saveWorkspaceDocument(db, conversationId, "晚到结果", "pptx",
    Buffer.from("late-arrival"), "op-cancel-late", undefined, undefined, { plan: result.plan! });
  expect(late.id).toBe(first.id);
  const version = db.getPresentationVersion(conversationId, first.id);
  expect(version?.report.draft).toBe(true);
  expect(version?.report.readiness).not.toBe("ready");
});

it("A09-取消：signal 真 aborted 时中断通过异常传播，调用方可捕获", async () => {
  const controller = new AbortController();
  const cache = new Map<string, string>();
  const promise = runTemplatePresentation(mind, makeCall({ cancelAtPage: 5, abort: () => controller.abort() }), {
    request: `做成 ${PAGES} 页，封面计入总页数`, scope: "abort-signal-test", images: [],
    signal: controller.signal,
    get: key => cache.get(key) ?? null,
    set: (key, value) => { cache.set(key, value); },
  });
  await expect(promise).rejects.toThrow();
  expect(controller.signal.aborted).toBe(true);
});
