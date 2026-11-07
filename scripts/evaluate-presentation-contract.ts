/**
 * 文档契约跨轮评测。
 *
 * 默认离线：只用本地 SQLite + 确定性模块 + 虚构资料，不联网、不调用模型、不产生计费。
 * --api <url>：额外检查正在运行的本机后端与对话渠道是否就绪，不发起任何生成请求。
 * 真实渠道的 6 轮生成会消耗额度，必须由用户在桌面窗口显式执行或另行授权，本脚本不自动发起。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { AppDatabase } from "../src/server/db.js";
import { resolvePresentationSpec, runPresentationSpecUpdate } from "../src/server/chat-tools/presentation-spec-tool.js";
import { checkPresentationContract } from "../src/server/presentation-contract-check.js";
import { saveWorkspaceDocument } from "../src/server/chat-tools/documents.js";
import { renderAiPresentation, type AiPresentation } from "../src/server/mind-document.js";
import { packPresentationProject, readPresentationProject } from "../src/server/presentation-project.js";
import { chooseTargetPages, totalize, type PresentationSpec } from "../src/shared/presentation-spec.js";
import { CHAPTERS, CHAPTER_COUNT, REQUIRED_FACTS, SOURCE_MARKDOWN } from "../tests/fixtures/presentation-contract/sources.js";
import { ALL_REQUIRED_TEXT, REQUIREMENTS } from "../tests/fixtures/presentation-contract/requirements.js";
import { CONVERSATION, NEUTRAL_MESSAGES } from "../tests/fixtures/presentation-contract/conversation.js";
import { EXPECTED } from "../tests/fixtures/presentation-contract/expected.js";

type CaseResult = { id: string; title: string; passed: boolean; details: Record<string, unknown>; error?: string };
const cases: CaseResult[] = [];
const args = process.argv.slice(2);
const apiIndex = args.indexOf("--api");
const apiUrl = apiIndex >= 0 ? args[apiIndex + 1] ?? "http://127.0.0.1:17892" : undefined;

const output = path.resolve("artifacts", "presentation-contract-eval", new Date().toISOString().replace(/[:.]/g, "-"));
await fs.mkdir(output, { recursive: true });

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "presentation-contract-eval-"));
const db = new AppDatabase(dir);
const conversationId = db.createConversation({
  title: "契约跨轮评测", brainChannelId: "offline-fixture", brainModel: "offline-fixture",
  videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false,
}).id;

function planOf(pages: number, options: { hideInNotes?: boolean; changedPage?: number } = {}): AiPresentation {
  const all = ALL_REQUIRED_TEXT;
  return {
    title: "虚构运营培训", theme: "blue",
    slides: Array.from({ length: pages }, (_, index) => {
      const page = index + 1;
      // 必需事实集中在第 1 页；修改第 3 页时不会误删它们。
      const lines = index === 0
        ? (options.hideInNotes ? ["页面只有占位文字"] : [...all])
        : options.changedPage === page ? ["这一页被修改"] : [`第 ${page} 页正文`];
      return {
        layout: "content" as const,
        title: `第 ${page} 页`, subtitle: "", lines,
        notes: options.hideInNotes ? `来源原文\n${all.join("\n")}` : "",
        sourceIds: [`s-${page}`],
      };
    }),
  };
}

async function pack(plan: AiPresentation): Promise<Buffer> {
  const bytes = await renderAiPresentation(plan);
  return packPresentationProject(bytes, plan, []);
}

async function runCase(id: string, title: string, fn: () => Record<string, unknown> | Promise<Record<string, unknown>>) {
  try {
    const details = await fn();
    cases.push({ id, title, passed: true, details });
  } catch (error) {
    cases.push({ id, title, passed: false, details: {}, error: error instanceof Error ? error.message : String(error) });
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

/** exact/min/max 才有单值；range 只用于断言存在，不在这里取值。 */
function pageValue(spec?: PresentationSpec | null): number | undefined {
  const constraint = spec?.pageCount;
  return constraint && constraint.kind !== "range" ? constraint.value : undefined;
}

/** 第一轮：只保存要求，不生成任何文件。 */
let specId = "";
let preparedRevision = 0;
await runCase("C01", "第一轮保存 prepared 契约，不触发生成", () => {
  const first = runPresentationSpecUpdate(db, conversationId, CONVERSATION[0].text, CONVERSATION[0].messageId,
    JSON.stringify({ intent: "create", prepareOnly: true, requiredContent: [...REQUIREMENTS.requiredCases, ...REQUIREMENTS.requiredFacts] }));
  assert(first.ok, `工具返回失败：${first.summary}`);
  specId = String(first.data!.specId);
  // 工具只接收「用户确实说过」的文本（避免模型把执行要点当页面要求）。
  // 这里模拟用户已经逐字确认过这些事实，直接写入已确认契约，用于测量门禁本身。
  db.specs.update(specId, {
    requiredContent: [...REQUIREMENTS.requiredCases, ...REQUIREMENTS.requiredFacts].map((item, index) => ({
      id: `required-${index + 1}`,
      evidence: { sourceMessageId: CONVERSATION[0].messageId, text: item },
      description: item, placement: "visible" as const, sourceRefs: [], verification: "deterministic" as const,
    })),
  }, "评测：写入已逐字确认的必需内容", CONVERSATION[0].messageId);
  const spec = db.specs.get(specId)!;
  preparedRevision = spec.revision;
  assert(spec.lifecycle === "prepared", "契约应为 prepared");
  assert(pageValue(spec) === EXPECTED.totalPages, `页数应为 ${EXPECTED.totalPages}`);
  assert(db.listWorkspaceDocuments(conversationId).length === 0, "prepared 阶段不应产生文件");
  return { specId, revision: spec.revision, lifecycle: spec.lifecycle, pageCount: pageValue(spec) };
});

/** 第二轮：开始，页数按契约收敛并产出可用成品。 */
let firstFileId = "";
await runCase("C02", "第二轮「开始」继承契约，18 章仍输出 10 页", async () => {
  const inherited = resolvePresentationSpec(db, conversationId, CONVERSATION[1].text, CONVERSATION[1].messageId);
  assert(inherited.spec?.specId === specId, "未继承同一契约");
  const constraint = totalize(inherited.spec!.pageCount!, inherited.spec!.pageCountBasis);
  const pages = chooseTargetPages(constraint, EXPECTED.chapterEstimate);
  assert(pages === EXPECTED.totalPages, `18 章估计 ${EXPECTED.chapterEstimate} 页，契约应收敛到 ${EXPECTED.totalPages}，实际 ${pages}`);
  db.specs.setLifecycle(specId, "active");
  const plan = planOf(pages);
  const bytes = await pack(plan);
  assert((await readPresentationProject(bytes))?.plan.slides.length === pages, "打包后的可编辑方案页数不符");
  const saved = saveWorkspaceDocument(db, conversationId, "培训-初版", "pptx", bytes, "op-c02", undefined, undefined, { plan });
  const report = db.getPresentationVersion(conversationId, saved.id)!.report;
  assert(report.readiness === "ready", `应为可用成品，实际 ${report.readiness}`);
  assert(report.draft === false, "不应标为草稿");
  assert(report.contractValidation, "应记录 validationId");
  assert(report.visibleCoverage?.satisfied === ALL_REQUIRED_TEXT.length, "必需内容应全部可见");
  firstFileId = saved.id;
  return { pages, readiness: report.readiness, visibleCoverage: report.visibleCoverage, fileId: saved.id };
});

/** 第三轮：换风格追加 revision，页数不变。 */
await runCase("C03", "第三轮换风格追加 revision，页数保持 10", () => {
  const changed = runPresentationSpecUpdate(db, conversationId, CONVERSATION[2].text, CONVERSATION[2].messageId,
    JSON.stringify({ intent: "update", specId, styleText: "杂志风" }));
  assert(changed.ok, "换风格工具调用失败");
  const spec = db.specs.get(specId)!;
  assert(spec.revision > preparedRevision, "换风格应追加 revision");
  assert(pageValue(spec) === EXPECTED.totalPages, "换风格不应改变页数");
  assert(spec.styleRequest?.text === "杂志风", "风格要求未记录");
  assert(resolvePresentationSpec(db, conversationId, "开始", "m-x").spec?.specId === specId, "换风格后仍应继承同一任务");
  return { revision: spec.revision, pageCount: pageValue(spec), style: spec.styleRequest?.text };
});

/** 第四轮：只改第 3 页，其他页不得变化。 */
await runCase("C04", "第四轮只改第 3 页，非目标页不变", async () => {
  const baseline = planOf(EXPECTED.totalPages);
  const changed = planOf(EXPECTED.totalPages, { changedPage: EXPECTED.localEditTargets[0] });
  const checked = checkPresentationContract(db.specs, {
    conversationId, spec: db.specs.get(specId)!, plan: changed, bytes: Buffer.from("c04"),
    baselinePlan: baseline, targets: EXPECTED.localEditTargets,
  });
  assert(checked.blocking.length === 0, `非目标页被误判改动：${JSON.stringify(checked.blocking)}`);
  const saved = saveWorkspaceDocument(db, conversationId, "培训-改第3页", "pptx", await pack(changed), "op-c04", undefined, undefined,
    { plan: changed, baselinePlan: baseline, targets: EXPECTED.localEditTargets });
  assert(db.getPresentationVersion(conversationId, saved.id)!.report.readiness === "ready", "局部修改应保持可用");
  return { targets: EXPECTED.localEditTargets, fileId: saved.id };
});

/** 第五轮：改成 12 页，旧版本仍可下载。 */
await runCase("C05", "第五轮改成 12 页，旧版本保留", async () => {
  const changed = runPresentationSpecUpdate(db, conversationId, CONVERSATION[4].text, CONVERSATION[4].messageId,
    JSON.stringify({ intent: "update", specId, pageCountText: "12 页" }));
  assert(changed.ok, "改页数失败");
  const spec = db.specs.get(specId)!;
  assert(pageValue(spec) === EXPECTED.revisedPages, "页数未更新为 12");
  assert(pageValue(db.specs.atRevision(specId, preparedRevision)) === EXPECTED.totalPages, "旧 revision 被改写");
  const plan = planOf(EXPECTED.revisedPages);
  const saved = saveWorkspaceDocument(db, conversationId, "培训-12页", "pptx", await pack(plan), "op-c05", undefined, undefined, { plan });
  const files = db.listWorkspaceDocuments(conversationId);
  assert(files.some(file => file.id === firstFileId), `初版文件应仍可下载；first=${firstFileId}，当前=${files.map(file => file.id).join(",")}`);
  return { pages: EXPECTED.revisedPages, revision: spec.revision, files: files.length, oldFileRetained: true };
});

/** 第六轮：另做一份，不继承 12 页。 */
await runCase("C06", "第六轮另做一份，分叉不继承约束", () => {
  const fork = resolvePresentationSpec(db, conversationId, CONVERSATION[5].text, CONVERSATION[5].messageId);
  assert(fork.spec?.specId !== specId, "分叉误继承原 specId");
  assert(fork.spec?.pageCount === undefined, "分叉不应继承 12 页约束");
  return { forkSpecId: fork.spec?.specId, inheritedPageCount: fork.spec?.pageCount ?? null };
});

/** 负面用例：备注不算覆盖、非目标页变化、外部改动、中性聊天。 */
// C06 分叉会收尾主契约；负面用例需要重新把带必需内容的契约设为当前执行任务。
db.specs.setLifecycle(specId, "active");
await runCase("N01", "必需内容只放备注时必须判为草稿", async () => {
  const plan = planOf(EXPECTED.totalPages, { hideInNotes: true });
  const saved = saveWorkspaceDocument(db, conversationId, "培训-仅备注", "pptx", await pack(plan), "op-n01", undefined, undefined, { plan });
  const report = db.getPresentationVersion(conversationId, saved.id)!.report;
  assert(report.readiness === "draft", "备注覆盖不能被判为可用成品");
  assert(report.visibleCoverage?.satisfied === 0, "可见覆盖应为 0");
  return { readiness: report.readiness, satisfied: report.visibleCoverage?.satisfied };
});

await runCase("N02", "未授权页面变化必须阻止发布", () => {
  const baseline = planOf(EXPECTED.totalPages);
  const changed = planOf(EXPECTED.totalPages, { changedPage: 7 });
  const checked = checkPresentationContract(db.specs, {
    conversationId, spec: db.specs.get(specId)!, plan: changed, bytes: Buffer.from("n02"),
    baselinePlan: baseline, targets: [3],
  });
  assert(checked.blocking.some(item => item.code === "SCOPE_VIOLATION"), "未授权改动未被阻断");
  return { blocking: checked.blocking.map(item => item.code) };
});

await runCase("N03", "外部软件改动 OOXML 部件后拒绝读回源方案", async () => {
  const bytes = await pack(planOf(EXPECTED.totalPages));
  const zip = await JSZip.loadAsync(bytes);
  zip.file("ppt/slides/slide1.xml", "<p:sld xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\">外部改动</p:sld>");
  const modified = await zip.generateAsync({ type: "nodebuffer" });
  let rejected = false;
  try { await readPresentationProject(modified); }
  catch (error) { rejected = /已在外部修改/.test(error instanceof Error ? error.message : ""); }
  assert(rejected, "外部改动未被 contentFingerprint 拒绝");
  return { rejected };
});

await runCase("N04", "普通聊天不意外创建契约", () => {
  const created = NEUTRAL_MESSAGES.filter(message => resolvePresentationSpec(db, "neutral-chat", message, "m-n").spec !== null);
  assert(created.length === 0, `中性消息误创建契约：${created.join("、")}`);
  return { checked: NEUTRAL_MESSAGES.length };
});

/** 可选：只检查本机后端是否就绪，不发起生成请求。 */
let apiStatus: Record<string, unknown> | undefined;
if (apiUrl) {
  try {
    const response = await fetch(`${apiUrl}/api/bootstrap`, { signal: AbortSignal.timeout(5000) });
    const body = await response.json() as {
      ok?: boolean;
      data?: { channels?: Array<{ enabled?: boolean; adapterType?: string; models?: string[] }>; service?: unknown };
    };
    const channels = body.data?.channels ?? [];
    const chat = channels.filter(channel => channel.enabled && channel.adapterType === "openai-chat");
    apiStatus = { reachable: response.ok && body.ok === true, channels: channels.length, chatChannels: chat.length, service: body.data?.service };
  } catch (error) {
    apiStatus = { reachable: false, error: error instanceof Error ? error.message : String(error) };
  }
}

const passed = cases.filter(item => item.passed).length;
const failed = cases.length - passed;
const report = {
  mode: "offline", source: "synthetic-only", chapters: CHAPTER_COUNT,
  sourceHash: createHash("sha256").update(SOURCE_MARKDOWN).digest("hex").slice(0, 12),
  requiredFacts: REQUIRED_FACTS.length, startedAt: new Date().toISOString(),
  api: apiStatus, cases, passed, failed, allPassed: failed === 0,
};
await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));

console.log(`文档契约跨轮评测 · 离线 · ${CHAPTER_COUNT} 章虚构资料`);
for (const item of cases) console.log(`${item.passed ? "PASS" : "FAIL"}  ${item.id}  ${item.title}${item.error ? `  → ${item.error}` : ""}`);
if (apiStatus) console.log(`后端连通性：${JSON.stringify(apiStatus)}`);
console.log(`结果 ${passed}/${cases.length} 通过，报告 ${path.join(output, "report.json")}`);
if (failed) process.exitCode = 1;
db.close();
await fs.rm(dir, { recursive: true, force: true });
