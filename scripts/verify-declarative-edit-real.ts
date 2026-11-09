/**
 * D2 收窄 doc_edit 之后的真实链路验收：先生成一份 8 页 PPT，再让它改其中一页。
 *
 * 要证明三件事：
 *  1. 修改页走的是声明式 content（`freeformPages` 不出现或为 0），没有退回整页元素；
 *  2. 页数不变、主题不变（不会「改一页换一套皮肤」）；
 *  3. 目标页真的变成了对应版式的渲染器元素（如 timeline-axis），而不是模型自画的坐标。
 *
 * 会调用真实渠道并产生计费，必须显式给出 --real --i-authorize-billing。
 * 只使用 tests/fixtures 里的虚构资料。
 */
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { SOURCE_MARKDOWN } from "../tests/fixtures/presentation-contract/sources.js";

const args = process.argv.slice(2);
const real = args.includes("--real");
const authorized = args.includes("--i-authorize-billing");
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1] ?? fallback : fallback;
const api = option("--api", "http://127.0.0.1:17892");
const model = option("--model", "deepseek-v4.1-flash-1017");
const timeoutMs = Number(option("--timeout", "900000"));
const pagesWanted = Number(option("--pages", "8"));

if (!real || !authorized) {
  console.error("真实链路验收会产生计费。确认后请显式加上 --real --i-authorize-billing");
  process.exit(2);
}
if (!Number.isFinite(timeoutMs) || timeoutMs < 10000 || timeoutMs > 1800000) throw new Error("--timeout 必须在 10–1800 秒之间");
if (!Number.isSafeInteger(pagesWanted) || pagesWanted < 4 || pagesWanted > 20) throw new Error("--pages 必须在 4–20 之间");

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const output = path.resolve("artifacts", "declarative-edit-real", new Date().toISOString().replace(/[:.]/g, "-"));
await fs.mkdir(output, { recursive: true });

type Envelope<T> = { ok: boolean; data?: T; error?: { message?: string } | string };
async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const response = await fetch(`${api}${url}`, {
    method, headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const payload = await response.json() as Envelope<T>;
  if (!response.ok || payload.ok === false || payload.data === undefined) {
    const message = typeof payload.error === "string" ? payload.error : payload.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`${method} ${url} 失败：${message}`);
  }
  return payload.data;
}

type Report = {
  readiness?: string; freeformPages?: number; overflowPages: number[];
  theme?: { id: string; name: string };
  capacity?: { truncatedPages: number[]; reflowedPages: number[] };
  deckPlan?: { pages: Array<{ page: number; layout: string }> };
};
type FileRow = { id: string; name: string };

const view = (id: string) => request<{ running: boolean; messages?: Array<{ role: string; content?: string | null }> }>("GET", `/api/conversations/${id}`);
const files = (id: string) => request<FileRow[]>("GET", `/api/conversations/${id}/documents/files`);
const status = (id: string, fileId: string) => request<{ report: Report; sha256: string }>("GET",
  `/api/conversations/${id}/documents/files/${fileId}/presentation-status`);

async function waitForTurn(id: string, before: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await sleep(1500);
  while (Date.now() < deadline) {
    const current = await view(id);
    const added = (current.messages ?? []).slice(before);
    if (!current.running && added.some(message => message.role === "assistant")) return;
    await sleep(1000);
  }
  throw new Error(`本轮在 ${timeoutMs / 1000}s 内未结束`);
}

async function deck(id: string, fileId: string): Promise<{ pages: number; plan: Array<{ ids: string[]; layout?: string }> }> {
  const response = await fetch(`${api}/api/conversations/${id}/documents/files/${fileId}`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`下载 PPT 失败：HTTP ${response.status}`);
  const zip = await JSZip.loadAsync(Buffer.from(await response.arrayBuffer()));
  const manifest = zip.file("chatcanvas/presentation.json");
  if (!manifest) return { pages: 0, plan: [] };
  const project = JSON.parse(await manifest.async("string")) as {
    plan?: { slides?: Array<{ layout?: string; elements?: Array<{ id: string }> }> };
  };
  const slides = project.plan?.slides ?? [];
  return {
    pages: slides.length,
    plan: slides.map(slide => ({ ids: (slide.elements ?? []).map(element => element.id), ...(slide.layout ? { layout: slide.layout } : {}) })),
  };
}

const bootstrap = await request<{ channels: Array<{ id: string; adapterType: string; enabled: boolean; hasKey: boolean; models: string[] }> }>("GET", "/api/bootstrap");
const channel = bootstrap.channels.find(item => item.enabled && item.adapterType === "openai-chat" && item.models.includes(model) && item.hasKey);
if (!channel) throw new Error(`找不到已启用且有密钥、包含模型 ${model} 的对话渠道`);

const conversation = await request<{ id: string }>("POST", "/api/conversations", {
  title: `声明式改页验收 ${new Date().toLocaleString()}`,
  brainChannelId: channel.id, brainModel: model, toolScope: "all", visionEnabled: false,
});
const conversationId = conversation.id;
const DOCUMENT = "虚构运营培训.md";
await request("POST", `/api/conversations/${conversationId}/documents`, { documents: [{ name: DOCUMENT, content: SOURCE_MARKDOWN }] });
console.log(`会话 ${conversationId} · 已上传虚构资料 ${SOURCE_MARKDOWN.length} 字`);

const steps: Array<{ name: string; text: string }> = [
  { name: "生成", text: `用《${DOCUMENT}》做一份 ${pagesWanted} 页 PPT，含封面，商务风格，直接生成。` },
  { name: "声明式改第 3 页", text: "把第 3 页改成时间轴，三个阶段：选点验证、小范围试点、全面推广；其余页面不要动。" },
];

const result: Record<string, unknown> = { conversationId, model, pagesWanted, steps: [] as unknown[] };
let before: { fileId: string; sha256: string; report: Report; pages: number } | undefined;

for (const step of steps) {
  const started = Date.now();
  const base = (await view(conversationId)).messages?.length ?? 0;
  await request("POST", `/api/conversations/${conversationId}/messages`, { text: step.text });
  await waitForTurn(conversationId, base);
  const rows = (await files(conversationId)).filter(file => /\.pptx$/i.test(file.name));
  if (!rows.length) throw new Error(`${step.name}：没有产出 PPT`);
  const file = rows[0]!;
  const current = await status(conversationId, file.id);
  const shape = await deck(conversationId, file.id);
  const entry = {
    step: step.name, fileId: file.id, name: file.name, durationMs: Date.now() - started,
    pages: shape.pages, theme: current.report.theme?.id ?? null,
    freeformPages: current.report.freeformPages ?? 0,
    capacity: current.report.capacity ?? null,
    readiness: current.report.readiness ?? null,
    layouts: current.report.deckPlan?.pages.map(page => page.layout) ?? [],
    page3Ids: shape.plan[2]?.ids ?? [],
  };
  (result.steps as unknown[]).push(entry);
  console.log(`${step.name}：${shape.pages} 页 · 主题 ${entry.theme} · freeform=${entry.freeformPages} · ${Math.round(entry.durationMs / 1000)}s`);

  if (step.name === "生成") {
    before = { fileId: file.id, sha256: current.sha256, report: current.report, pages: shape.pages };
    continue;
  }
  const checks = {
    newVersion: file.id !== before!.fileId,
    pagesUnchanged: shape.pages === before!.pages,
    themeInherited: Boolean(before!.report.theme?.id) && current.report.theme?.id === before!.report.theme?.id,
    declarativeEdit: (current.report.freeformPages ?? 0) === 0,
    renderedLayout: (shape.plan[2]?.ids ?? []).some(id => id === "timeline-axis" || id.startsWith("timeline-")),
  };
  result.checks = checks;
  result.passed = Object.values(checks).every(Boolean);
  console.log(`校验：${Object.entries(checks).map(([key, value]) => `${key}=${value ? "✓" : "✗"}`).join(" ")}`);
}

await fs.writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2));
console.log(`结果已写入 ${path.relative(process.cwd(), path.join(output, "result.json"))}`);
if (result.passed !== true) process.exitCode = 1;
