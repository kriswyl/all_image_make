/**
 * C 性能验收（文档 §7.4）：在已有十页 PPT 上**只改一页**，核对视觉检查页集合与真实耗时。
 *
 * 与完整跨轮验收不同，这个脚本不重新生成整份文档，只在指定会话里发一条局部修改指令，
 * 因此单次成本约为一次 doc_edit + 一次视觉模型调用。会调用已配置渠道并产生计费，必须显式授权：
 *   --i-authorize-billing
 *
 * 用法：
 *   npm run eval:local-visual -- --conversation <会话ID> --page 3 --repeat 3 --i-authorize-billing
 * 可选：--file <fileId> 指定基线版本（默认取该会话最新 pptx）、--text 自定义指令。
 */
import fs from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const authorized = args.includes("--i-authorize-billing");
if (!authorized) {
  console.error("本脚本会调用已配置渠道并产生计费。确认后请显式加上 --i-authorize-billing");
  process.exit(2);
}
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1] ?? fallback : fallback;
const api = option("--api", "http://127.0.0.1:17892");
const conversationId = option("--conversation", "");
const page = Number(option("--page", "3"));
const repeat = Number(option("--repeat", "1"));
const timeoutMs = Number(option("--timeout", "600000"));
const fileId = option("--file", "");
/** 多轮验收时逐轮改不同页：模型会正确拒绝「把已满足的页再导出一次」，重复同一页会拿不到新版本。 */
const pages = option("--pages", page ? String(page) : "3")
  .split(",").map(item => Number(item.trim())).filter(item => Number.isSafeInteger(item) && item > 0);
const textTemplate = option("--text", "");
const textFor = (targetPage: number) => textTemplate
  ? textTemplate.replace(/\{page\}/g, String(targetPage))
  : `把第 ${targetPage} 页改成卡片结构，其余页保持完全不变`;
if (!pages.length) throw new Error("--pages 至少要有一个有效页码");
if (!/^[0-9a-f-]{36}$/i.test(conversationId)) throw new Error("请用 --conversation 指定一个有效会话 ID");
if (!Number.isSafeInteger(page) || page < 1) throw new Error("--page 必须是正整数");
if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 5) throw new Error("--repeat 只能是 1–5");
if (!Number.isFinite(timeoutMs) || timeoutMs < 10000 || timeoutMs > 1800000) throw new Error("--timeout 必须在 10–1800 秒之间");

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const output = path.resolve("artifacts", "presentation-local-visual", new Date().toISOString().replace(/[:.]/g, "-"));
await fs.mkdir(output, { recursive: true });

type Envelope<T> = { ok: boolean; data?: T; error?: { message?: string } | string };
async function request<T>(method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${api}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json() as Envelope<T>;
  if (!response.ok || !payload.ok) {
    const detail = typeof payload.error === "string" ? payload.error : payload.error?.message;
    throw new Error(`${method} ${route} 失败：HTTP ${response.status} ${detail ?? ""}`);
  }
  return payload.data as T;
}

type ConversationView = { running?: boolean; messages?: Array<{ role: string; content?: string | null; toolName?: string }> };
type FileRow = { id: string; name: string; byteSize?: number };
type StatusReport = {
  report?: {
    readiness?: string;
    checkSets?: { contentPages: number[]; auditPages: number[]; visualPages: number[]; widened: boolean; reason: string };
    metrics?: {
      visual: { pages: number[]; modelCalls: number; cacheHits: number; modelMs: number };
      wps: { renders: number; exportedPages: number; renderMs: number };
    };
    visualReview?: { status?: string; summary?: string };
  };
};

async function conversation(): Promise<ConversationView> {
  return request<ConversationView>("GET", `/api/conversations/${conversationId}`);
}
async function waitIdle() {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await conversation()).running) return;
    await sleep(1500);
  }
  throw new Error(`上一轮在 ${timeoutMs / 1000}s 内仍未结束`);
}
async function pptxFiles(): Promise<FileRow[]> {
  return (await request<FileRow[]>("GET", `/api/conversations/${conversationId}/documents/files`)).filter(file => /\.pptx$/i.test(file.name));
}
async function statusOf(id: string): Promise<StatusReport["report"]> {
  const payload = await request<StatusReport>("GET", `/api/conversations/${conversationId}/documents/files/${id}/presentation-status`);
  return payload.report;
}
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

// 1. 开启会话看图；否则视觉回调会直接返回「未启用看图」，测不到真实耗时。
const before = await conversation();
await request("PATCH", `/api/conversations/${conversationId}`, { visionEnabled: true });
console.log(`会话 ${conversationId}：已开启看图，共 ${(before.messages ?? []).length} 条历史消息`);

// 2. 选择基线版本：默认最新 pptx，并确认页数。
const baseFiles = await pptxFiles();
if (!baseFiles.length) throw new Error("会话里没有 pptx，请先在桌面端生成一份十页 PPT");
const baseline = fileId ? baseFiles.find(file => file.id === fileId) : baseFiles[0];
if (!baseline) throw new Error("找不到指定的基线版本");
const baseReport = await statusOf(baseline.id);
console.log(`基线：${baseline.name}（readiness=${baseReport?.readiness ?? "未知"}）`);

const rounds: Array<Record<string, unknown>> = [];
for (let attempt = 1; attempt <= repeat; attempt++) {
  const targetPage = pages[(attempt - 1) % pages.length]!;
  const started = Date.now();
  await waitIdle();
  const beforeIds = new Set((await pptxFiles()).map(file => file.id));
  const beforeMessages = (await conversation()).messages?.length ?? 0;
  await request("POST", `/api/conversations/${conversationId}/messages`, { text: textFor(targetPage) });
  const deadline = Date.now() + timeoutMs;
  let settled = await conversation();
  while (Date.now() < deadline) {
    settled = await conversation();
    const added = (settled.messages ?? []).slice(beforeMessages);
    if (!settled.running && added.some(message => message.role === "assistant" || message.role === "tool")) break;
    await sleep(1500);
  }
  if (settled.running) throw new Error(`第 ${attempt} 次修改在 ${timeoutMs / 1000}s 内未结束`);
  const durationMs = Date.now() - started;

  // 必须核对本轮**新增**的版本。模型会正确拒绝「把已满足的页再导出一次」，
  // 此时读旧产物会把历史耗时误报成本轮结果（假通过）。
  const files = await pptxFiles();
  const added = files.filter(file => !beforeIds.has(file.id));
  if (!added.length) {
    rounds.push({
      attempt, page: targetPage, passed: false, noNewVersion: true, durationMs,
      detail: "本轮没有产生新的 pptx：模型判断当前页面已满足要求，或未调用 doc_edit",
    });
    console.log(`#${attempt} SKIP  未产生新版本（不计入成功样本）  总耗时=${durationMs}ms`);
    continue;
  }
  const latest = added[0]!;
  const report = await statusOf(latest.id);
  const checkSets = report?.checkSets;
  const metrics = report?.metrics;
  const visualPages = metrics?.visual.pages ?? checkSets?.visualPages ?? [];
  const localOnly = Array.isArray(visualPages) && visualPages.length > 0 && visualPages.every(item => item === targetPage);
  rounds.push({
    attempt, page: targetPage, durationMs, file: latest.name, readiness: report?.readiness ?? null,
    checkSets: checkSets ?? null, metrics: metrics ?? null,
    visualReview: report?.visualReview ?? null, localOnly,
  });
  console.log(`#${attempt} ${localOnly ? "PASS" : "FAIL"}  目标页=${targetPage} 视觉页=${JSON.stringify(visualPages)} 模型调用=${metrics?.visual.modelCalls ?? "-"} 缓存命中=${metrics?.visual.cacheHits ?? "-"} 模型=${metrics?.visual.modelMs ?? "-"}ms WPS导出=${metrics?.wps.exportedPages ?? "-"}页/${metrics?.wps.renderMs ?? "-"}ms 总耗时=${durationMs}ms`);
}

const measured = rounds.filter(round => round.localOnly).length;
// 中位数只统计真正产生新版本且满足局部检查的样本，避免「模型拒绝重复生成」的短耗时拉低结果。
const samples = rounds.filter(round => round.localOnly);
const report = {
  mode: "real", kind: "local-visual", api, conversationId, pages, textTemplate: textTemplate || null,
  baseline: { id: baseline.id, name: baseline.name, readiness: baseReport?.readiness ?? null },
  rounds,
  attempts: rounds.length, passed: measured, failed: rounds.length - measured,
  noNewVersion: rounds.filter(round => round.noNewVersion).length,
  allLocalOnly: measured === rounds.length,
  medianDurationMs: samples.length ? median(samples.map(round => Number(round.durationMs))) : null,
  medianModelMs: samples.length ? median(samples.map(round => Number((round.metrics as { visual?: { modelMs?: number } })?.visual?.modelMs ?? 0))) : null,
  medianWpsMs: samples.length ? median(samples.map(round => Number((round.metrics as { wps?: { renderMs?: number } })?.wps?.renderMs ?? 0))) : null,
  unverified: [
    "只验证单页局部修改；共享主题/页序/页数的扩域由单元与离线评测覆盖",
    "WPS 仍导出整份文件，exportedPages 如实记录，不宣称 Office 只处理一页",
  ],
  at: new Date().toISOString(),
};
// 「模型拒绝重复生成」不算脚本失败；只有产出了新版本却没满足局部检查才算。
const realFailures = rounds.filter(round => !round.localOnly && !round.noNewVersion).length;
await fs.writeFile(path.join(output, "report.json"), JSON.stringify({ ...report, realFailures }, null, 2));
console.log(`结果 ${measured}/${rounds.length} 次满足「只检查指定页」；${report.noNewVersion ? `${report.noNewVersion} 次因页面已满足未产新版本；` : ""}中位总耗时 ${report.medianDurationMs ?? "-"}ms；报告 ${path.join(output, "report.json")}`);
if (realFailures) process.exitCode = 1;
