/**
 * 真实渠道跨轮验收：驱动正在运行的本机后端，逐轮发消息并读取真实产物。
 *
 * 会调用已配置的对话渠道并产生计费，必须同时显式给出：
 *   --real --i-authorize-billing
 * 只使用 tests/fixtures/presentation-contract 里的虚构资料，不上传真实文档。
 * 默认每轮最多等 900 秒（实测单轮完整生成约 9–10 分钟），总轮次可用 --rounds 限制以便控制预算。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { CONVERSATION } from "../tests/fixtures/presentation-contract/conversation.js";
import { CHAPTER_COUNT, SOURCE_MARKDOWN } from "../tests/fixtures/presentation-contract/sources.js";
import { EXPECTED } from "../tests/fixtures/presentation-contract/expected.js";

const args = process.argv.slice(2);
const real = args.includes("--real");
const authorized = args.includes("--i-authorize-billing");
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1] ?? fallback : fallback;
const api = option("--api", "http://127.0.0.1:17892");
const model = option("--model", "deepseek-v4.1-flash-1017");
// 实测真实渠道生成一份 10 页 PPT 约需 9–10 分钟，默认给足 15 分钟。
const timeoutMs = Number(option("--timeout", "900000"));
const maxRounds = Number(option("--rounds", "6"));

if (!real || !authorized) {
  console.error("真实渠道验收会产生计费。确认后请显式加上 --real --i-authorize-billing");
  console.error("离线评测请用：npm run eval:contract");
  process.exit(2);
}
if (!Number.isFinite(timeoutMs) || timeoutMs < 10000 || timeoutMs > 1800000) throw new Error("--timeout 必须在 10–1800 秒之间");

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const runStartedAt = new Date().toISOString();
const runStartMs = Date.now();
const output = path.resolve("artifacts", "presentation-contract-eval-real", new Date().toISOString().replace(/[:.]/g, "-"));
await fs.mkdir(output, { recursive: true });

type Envelope<T> = { ok: boolean; data?: T; error?: { message?: string } | string };
type FileRow = { id: string; name: string; byteSize?: number };
type RoundResult = {
  id: string; title: string; text: string; passed: boolean; durationMs: number;
  pptxFiles: number; latestPages: number | null; pagesExpected: number | null;
  readiness?: string; assistant?: string; detail?: string; error?: string;
  retries?: number; protocolFailure?: boolean;
};
/** 渠道偶发返回不可验证的 function call：服务端已自动重试一次仍失败时，只允许评测层再重试一轮。 */
const PROTOCOL_ERROR = /无法验证的工具调用|请重试或切换对话模型/;

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(`${api}${url}`, {
    method, headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json() as Envelope<T>;
  if (!response.ok || payload.ok === false || payload.data === undefined) {
    const message = typeof payload.error === "string" ? payload.error : payload.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`${method} ${url} 失败：${message}`);
  }
  return payload.data;
}

type View = { id: string; running?: boolean; messages?: Array<{ role: string; content?: string | null; toolName?: string }> };
const view = (id: string) => request<View & { running: boolean }>("GET", `/api/conversations/${id}`);
const files = (id: string) => request<FileRow[]>("GET", `/api/conversations/${id}/documents/files`);

/** 发下一句之前必须先等上一轮结束，否则后端会拒绝「上一条还在处理中」。 */
async function waitIdle(id: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await view(id)).running) return;
    await sleep(1000);
  }
  throw new Error(`上一轮在 ${timeoutMs / 1000}s 内仍未结束`);
}

async function waitForTurn(id: string, before: number): Promise<View> {
  const deadline = Date.now() + timeoutMs;
  await sleep(1500);
  while (Date.now() < deadline) {
    const current = await view(id);
    const added = (current.messages ?? []).slice(before);
    if (!current.running && added.some(message => message.role === "assistant" || message.role === "tool")) return current;
    await sleep(1000);
  }
  throw new Error(`本轮在 ${timeoutMs / 1000}s 内未结束`);
}

async function latestPptx(id: string): Promise<{ file: FileRow; pages: number; readiness?: string } | null> {
  const rows = (await files(id)).filter(file => /\.pptx$/i.test(file.name));
  if (!rows.length) return null;
  const file = rows[0]!;
  const response = await fetch(`${api}/api/conversations/${id}/documents/files/${file.id}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`下载 ${file.name} 失败：HTTP ${response.status}`);
  const zip = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
  const manifest = zip.file("chatcanvas/presentation.json");
  let pages = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length;
  if (manifest) {
    const project = JSON.parse(await manifest.async("string")) as { plan?: { slides?: unknown[] } };
    if (Array.isArray(project.plan?.slides)) pages = project.plan.slides.length;
  }
  let readiness: string | undefined;
  try {
    const status = await request<{ report?: { readiness?: string } }>("GET",
      `/api/conversations/${id}/documents/files/${file.id}/presentation-status`);
    readiness = status.report?.readiness;
  } catch { /* 旧版本可能没有报告端点数据 */ }
  return { file, pages, readiness };
}

console.log(`真实渠道跨轮验收 · ${api} · ${model} · 仅虚构资料（${CHAPTER_COUNT} 章）`);
console.log("警告：本次会调用已配置渠道并产生计费。");

const bootstrap = await request<{
  channels: Array<{ id: string; adapterType: string; enabled: boolean; hasKey: boolean; models: string[] }>;
  service: { version: string };
}>("GET", "/api/bootstrap");
const channel = bootstrap.channels.find(item => item.enabled && item.adapterType === "openai-chat" && item.models.includes(model) && item.hasKey);
if (!channel) throw new Error(`找不到已启用且有密钥、包含模型 ${model} 的对话渠道`);

const conversation = await request<{ id: string }>("POST", "/api/conversations", {
  title: `契约真实跨轮验收 ${new Date().toLocaleString()}`,
  brainChannelId: channel.id, brainModel: model, toolScope: "all", visionEnabled: false,
});
const conversationId = conversation.id;
console.log(`会话 ${conversationId}（渠道 ${channel.id}，版本 ${bootstrap.service.version}）`);

// 必须先把虚构资料放进会话，否则 doc_convert 拿不到 fileId，模型会一直回复「上传区是空的」。
const DOCUMENT_NAME = "虚构运营培训.md";
await request("POST", `/api/conversations/${conversationId}/documents`, {
  documents: [{ name: DOCUMENT_NAME, content: SOURCE_MARKDOWN }],
});
console.log(`已上传虚构资料《${DOCUMENT_NAME}》（${SOURCE_MARKDOWN.length} 字，不含任何真实文档）`);

/** 6 轮：第一轮只保存要求；之后逐轮验证页数与文件状态。 */
const rounds: Array<{ text: string; expectedPages: number | null; title: string }> = [
  { text: `${CONVERSATION[0].text}（资料已上传为《${DOCUMENT_NAME}》）`, expectedPages: null, title: "先保存要求，不生成 PPT" },
  { text: CONVERSATION[1].text, expectedPages: EXPECTED.totalPages, title: "开始，输出 10 页" },
  { text: CONVERSATION[2].text, expectedPages: EXPECTED.totalPages, title: "换风格，仍 10 页" },
  { text: CONVERSATION[3].text, expectedPages: EXPECTED.totalPages, title: "改第 3 页，仍 10 页" },
  { text: CONVERSATION[4].text, expectedPages: EXPECTED.revisedPages, title: "改成 12 页" },
  { text: "另做一份 8 页 PPT，含封面，直接生成", expectedPages: 8, title: "另做一份，不继承 12 页" },
];

const maxRoundRetries = Number(option("--max-round-retries", "1"));
if (!Number.isFinite(maxRoundRetries) || maxRoundRetries < 0 || maxRoundRetries > 2) throw new Error("--max-round-retries 只能是 0、1 或 2");

type RoundOutcome = { result: RoundResult; protocolFailure: boolean };
async function runRound(id: string, round: { text: string; expectedPages: number | null; title: string }, retries: number): Promise<RoundOutcome> {
  const started = Date.now();
  try {
    await waitIdle(conversationId);
    const before = (await view(conversationId)).messages?.length ?? 0;
    await request("POST", `/api/conversations/${conversationId}/messages`, { text: round.text });
    const settled = await waitForTurn(conversationId, before);
    const added = (settled.messages ?? []).slice(before);
    const assistant = added.filter(message => message.role === "assistant" && message.content).map(message => String(message.content)).join(" ").slice(0, 200);
    const pptx = await latestPptx(conversationId);
    const pages = pptx?.pages ?? null;
    let passed: boolean;
    let detail: string;
    if (round.expectedPages === null) {
      passed = pages === null;
      detail = passed ? "未产生 PPT，符合要求先保存" : `意外生成了 ${pages} 页 PPT`;
    } else {
      passed = pages === round.expectedPages;
      detail = passed ? `产物 ${pages} 页符合要求` : `期望 ${round.expectedPages} 页，实际 ${pages ?? "无产物"}`;
    }
    const protocolFailure = added.some(message => PROTOCOL_ERROR.test(String(message.content ?? "")));
    return {
      result: {
        id, text: round.text, title: round.title, passed, durationMs: Date.now() - started,
        pptxFiles: (await files(conversationId)).filter(file => /\.pptx$/i.test(file.name)).length,
        latestPages: pages, pagesExpected: round.expectedPages, readiness: pptx?.readiness,
        assistant, detail, retries, protocolFailure,
      },
      protocolFailure,
    };
  } catch (error) {
    return {
      result: {
        id, text: round.text, title: round.title, passed: false, durationMs: Date.now() - started,
        pptxFiles: 0, latestPages: null, pagesExpected: round.expectedPages,
        error: error instanceof Error ? error.message : String(error), retries,
      },
      protocolFailure: false,
    };
  }
}

const results: RoundResult[] = [];
const roundRetries: Array<{ id: string; attempt: number; reason: string }> = [];
for (const [index, round] of rounds.slice(0, maxRounds).entries()) {
  const id = `R${index + 1}`;
  const started = Date.now();
  let retries = 0;
  let outcome = await runRound(id, round, retries);
  // 只针对明确的渠道协议错误重试；页数不符、草稿、超时等真实失败不重试，避免掩盖缺陷。
  while (!outcome.result.passed && outcome.protocolFailure && retries < maxRoundRetries) {
    retries++;
    roundRetries.push({ id, attempt: retries, reason: "渠道返回无法验证的工具调用（服务端已自动重试一次）" });
    console.log(`RETRY  ${id}  渠道协议错误，重发同一指令（第 ${retries} 次）`);
    outcome = await runRound(id, round, retries);
  }
  const result = { ...outcome.result, retries, durationMs: Date.now() - started };
  results.push(result);
  console.log(`${result.passed ? "PASS" : "FAIL"}  ${id}  ${round.title}  ${result.detail ?? result.error}  (${result.durationMs}ms${retries ? `，重试 ${retries} 次` : ""})`);
}

const passed = results.filter(item => item.passed).length;
const report = {
  mode: "real", source: "synthetic-only", chapters: CHAPTER_COUNT,
  sourceSha256Prefix: createHash("sha256").update(SOURCE_MARKDOWN).digest("hex").slice(0, 12),
  // 第 11 节第 4 条要求记录环境、引擎、模型、约束、结果与未验证项。
  environment: {
    api, backendVersion: bootstrap.service.version, engine: "template",
    channelAdapter: channel.adapterType, desktopHotReload: true,
  },
  constraints: {
    pageCount: { kind: "exact", value: EXPECTED.totalPages, basis: "total", includesCover: true },
    revisedPageCount: EXPECTED.revisedPages, forkPageCount: 8,
    requiredCases: EXPECTED.visibleCasesRequired, requiredFacts: EXPECTED.visibleFactsRequired,
    visibleOnly: true, notesDoNotCount: true,
  },
  unverified: [
    "未做 WPS 像素级视觉检查：加载项在线但本轮未调用",
    "由脚本经本机 API 驱动同一后端，非人手在桌面窗口逐轮点击；会话与产物保留在桌面端可查看",
    "仅开发版热重载与 npm run build，未做桌面打包版回归",
    "未做不同渠道 / 模型的对照评测，也未做并发取消的进程级注入",
  ],
  api, model, channelId: channel.id, conversationId,
  startedAt: runStartedAt, finishedAt: new Date().toISOString(), durationMs: Date.now() - runStartMs,
  rounds: results, roundRetries,
  passed, failed: results.length - passed, allPassed: passed === results.length,
};
await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
console.log(`结果 ${passed}/${results.length} 通过；会话 ${conversationId} 保留在桌面端可供查看；报告 ${path.join(output, "report.json")}`);
if (report.failed) process.exitCode = 1;
