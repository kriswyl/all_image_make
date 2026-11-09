import { PresentationPaused } from "../presentation-execution.js";
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import type { AppDatabase } from "../db.js";
import { aiPresentationSchema, extractMindImages, parseXmind, renderAiPresentation, type AiPresentation, type DocumentNode, type MindDocument, type MindImage } from "../mind-document.js";
import type { BrainToolSpec } from "../brain.js";
import { checkPresentation, paginatePresentation } from "../presentation-check.js";
import { markdownToDocx, markdownToMind } from "./markdown.js";
import { editDocxText, readDocxText } from "./word-document.js";
import { cellEditSchema, createXlsx, editXlsx, matchAndEditXlsx, matchRowsSchema, readXlsx, sheetSchema } from "./spreadsheet-document.js";
import { readPdfPage } from "./pdf-document.js";
import { designSchema, resolveElements, ELEMENT_DESIGN_GUIDE, type PresentationDesign } from "../presentation-elements.js";
import { readPresentationProject, packPresentationProject, readPresentationStyle } from "../presentation-project.js";
import { isImageAsset } from "../../shared/types.js";
import { prepareImageBytes, REFERENCE_PROFILE } from "../vision.js";
import type { TemplatePresentation } from "../presentation-workflow.js";
import type { TemplateReport, VisualReviewMetrics } from "../../shared/presentation-report.js";
import { placePresentationImages, renderContentSlide, slideContentSchema, validSlideContent } from "../presentation-templates.js";
import { checkPresentationContract } from "../presentation-contract-check.js";
import { patchPresentationObjects } from "../presentation-object-patch.js";
import { carryDeckReport } from "../presentation-deck-carry.js";
import { getTheme } from "../../shared/presentation-theme.js";
import { createCandidateDocument, publishDocument } from "../document-publish.js";
import { deriveChangeScope, resolveCheckSets, type CheckSets } from "../../shared/change-scope.js";

const MAX_FILE = 20 * 1024 * 1024;
/**
 * 渲染器生成页的签名：只认我们渲染器才会产出的组合。
 * 不能只看 `title`/`table` 这类通用 id，模型自定义元素也会用它们。
 */
function hasRendererElements(slide: { elements?: Array<{ id: string }> }): boolean {
  const ids = (slide.elements ?? []).map(element => element.id);
  const has = (prefix: string) => ids.some(id => id.startsWith(prefix));
  return ids.includes("accent-rule") || ids.includes("cover-rule") || ids.includes("timeline-axis")
    || ids.includes("quote-bar") || has("kpi-") || (ids.includes("panel-0") && ids.includes("heading-0"));
}
const nodeSchema: z.ZodType<DocumentNode> = z.lazy(() => z.object({ title: z.string().trim().min(1).max(2000), notes: z.string().max(10000).default(""), children: z.array(nodeSchema).max(500).default([]) }));
const schemas = {
  doc_list: z.object({}),
  doc_delete: z.object({ fileId: z.string().min(1) }),
  doc_read: z.object({ fileId: z.string().min(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(500).default(100), charOffset: z.number().int().min(0).optional(), charLimit: z.number().int().min(1).max(20000).default(12000), sheetName: z.string().min(1).max(31).optional(), range: z.string().min(1).max(25).optional(), page: z.number().int().min(1).max(1000).optional() }),
  doc_search: z.object({ fileId: z.string().min(1), query: z.string().min(1).max(500), charOffset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20) }),
  doc_create: z.object({ kind: z.enum(["md", "txt", "csv", "json", "xmind", "docx", "xlsx"]), name: z.string().trim().min(1).max(120), content: z.string().max(2_000_000).optional(), nodes: nodeSchema.optional(), sheets: z.array(sheetSchema).min(1).max(20).optional() }),
  doc_edit: z.object({ fileId: z.string().min(1), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i), edits: z.array(z.object({ find: z.string().min(1).max(20000), replace: z.string().max(100000) })).min(1).max(20).optional(), cells: z.array(cellEditSchema).min(1).max(500).optional(), matchRows: matchRowsSchema.optional(), pages: z.array(z.object({
      page: z.number().int().min(1).max(200),
      /** 声明式内容（推荐）：只给结构与文字，坐标由渲染器按主题算。 */
      content: slideContentSchema.optional(),
      /** 遗留通道：整页元素自带坐标，会绕过主题，仅在必须保留原元素时使用。 */
      slide: aiPresentationSchema.shape.slides.element.omit({ box: true }).optional(),
    }).strict()).min(1).max(30).optional(), appendSlides: z.array(aiPresentationSchema.shape.slides.element.omit({ box: true })).min(1).max(30).optional(), imageAssetIds: z.array(z.uuid()).min(1).max(8).optional(), order: z.array(z.number().int().min(1).max(200)).min(1).max(200).optional(), design: designSchema.optional(),
    /** M2：对象级原位补丁。只改指定文本框/普通形状的字号、颜色、位置、尺寸，不重排整稿。 */
    objects: z.array(z.object({
      slide: z.number().int().min(1).max(200),
      elementId: z.string().min(1).max(80),
      /** 替换文本框内容，\n 分段；沿用原段落与首个 run 的字号颜色 */
      text: z.string().trim().min(1).max(6000).optional(),
      fontSize: z.number().positive().max(200).optional(),
      color: z.string().regex(/^[0-9a-f]{6}$/i).optional(),
      rect: z.object({ x: z.number().min(0).max(20), y: z.number().min(0).max(20), w: z.number().positive().max(20), h: z.number().positive().max(20) }).strict().optional(),
      /** 换图：本会话内的图片素材 ID，会新增媒体部件并改这一页的关系指向 */
      imageAssetId: z.uuid().optional(),
      /** 改图表数据：只更新显示缓存，内嵌数据表不随之更新 */
      chart: z.object({
        categories: z.array(z.string().trim().min(1).max(100)).min(1).max(40).optional(),
        series: z.array(z.object({ name: z.string().trim().min(1).max(100).optional(), values: z.array(z.number().finite()).min(1).max(40) }).strict()).min(1).max(8).optional(),
      }).strict().refine(value => value.categories !== undefined || value.series !== undefined, "chart 至少要给 categories 或 series").optional(),
    }).strict().refine(value => value.text !== undefined || value.fontSize !== undefined || value.color !== undefined || value.rect !== undefined || value.imageAssetId !== undefined || value.chart !== undefined, "每个 objects 项至少要给 text、fontSize、color、rect、imageAssetId 或 chart 之一")).min(1).max(20).optional() }),
  doc_convert: z.object({ fileId: z.string().min(1), to: z.literal("pptx"), referenceFileId: z.string().min(1).optional(), coverAssetId: z.uuid().optional(),
    pageImages: z.array(z.object({ page: z.number().int().min(1).max(200), assetId: z.uuid() }).strict()).min(1).max(8).optional(),
    pageCount: z.number().int().min(1).max(200).optional(), pageCountEvidence: z.string().trim().min(1).max(140).optional(), design: designSchema.optional(),
    // D2：style 可以是主题 id（blue/magazine/mono/warm），也可以是一句风格描述（如「杂志风」）。
    style: z.string().trim().min(1).max(40).optional() }),
};
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

/** Accept the file IDs models commonly shorten from doc_read / doc_list output. */
function resolveDocumentId(db: AppDatabase, conversationId: string, id: string) {
  if (db.getWorkspaceDocument(conversationId, id)) return id;
  const upload = db.getConversationDocument(id);
  if (upload?.conversationId === conversationId) return id;
  const ids = [...new Set([
    ...db.listWorkspaceDocuments(conversationId).map(item => item.id),
    ...db.listConversationDocuments(conversationId).map(item => item.id),
  ])];
  const matches = ids.filter(item => item.startsWith(id));
  return matches.length === 1 ? matches[0]! : id;
}

function textLike(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(item => textLike(item) ?? "").join("");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return textLike(record.text ?? record.content ?? record.value ?? record.runs);
  }
  return undefined;
}

function normalizeColor(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/^#/, "").toUpperCase() : value;
}

function normalizeTextElement(element: unknown) {
  if (!element || typeof element !== "object") return;
  const item = element as Record<string, any>;
  if (!item.type && item.text !== undefined) item.type = "text";
  if (item.type !== "text") return;
  const nestedStyle = item.text && typeof item.text === "object" ? item.text.style : undefined;
  const text = textLike(item.text);
  if (text !== undefined) item.text = text;
  if (item.style === undefined && nestedStyle) item.style = nestedStyle;
  if (item.style && typeof item.style === "object") item.style.color = normalizeColor(item.style.color);
  if (item.fill !== undefined) item.fill = normalizeColor(item.fill);
  if (item.color !== undefined) item.color = normalizeColor(item.color);
  if (item.line && typeof item.line === "object") item.line.color = normalizeColor(item.line.color);
}

function normalizeSlide(slide: unknown) {
  if (!slide || typeof slide !== "object") return;
  const item = slide as Record<string, any>;
  if (Array.isArray(item.elements)) item.elements.forEach(normalizeTextElement);
  if (Array.isArray(item.elements) && !item.elements.length && Array.isArray(item.lines)) delete item.elements;
  // A model that copies an old slide often leaves both forms behind. The element
  // representation is the authoritative one; the old lines array only trips validation.
  if ((Array.isArray(item.elements) && item.elements.length) || item.box) delete item.lines;
}

/**
 * Models occasionally emit obvious JSON-level aliases rather than the exact tool schema:
 * `to: "PPT"`, a `text` object carrying its own style, or a shortened file ID. Normalize
 * only those structural aliases; keep the schema strict for everything else.
 */
function normalizeDocInput(name: string, input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const args = JSON.parse(JSON.stringify(input)) as Record<string, any>;
  if (name === "doc_create") {
    if (typeof args.kind === "string") {
      const kind = args.kind.trim().toLowerCase().replace(/^\./, "");
      args.kind = kind === "markdown" ? "md" : kind === "text" ? "txt" : kind === "word" || kind === "doc" ? "docx" : kind === "excel" ? "xlsx" : kind;
    }
    if (args.kind !== "xmind") delete args.nodes;
    if (args.content && typeof args.content === "object") {
      const content = textLike(args.content);
      if (content !== undefined) args.content = content;
    }
    if (args.kind === "xmind" && args.nodes && typeof args.nodes === "object" && !Array.isArray(args.nodes) && args.nodes.title === undefined && typeof args.name === "string") {
      args.nodes.title = args.name;
    }
  }
  if (name === "doc_convert") {
    if (typeof args.to === "string") {
      const to = args.to.trim().toLowerCase().replace(/^\./, "");
      if (to === "pptx" || to === "ppt" || to === "presentation" || to === "powerpoint") args.to = "pptx";
    }
    if (args.design && typeof args.design === "object") {
      for (const key of ["background", "text", "accent"]) args.design[key] = normalizeColor(args.design[key]);
    }
  }
  if (name === "doc_edit") {
    if (args.expectedSha256 === undefined) args.expectedSha256 = args.sha256 ?? args.sha ?? args.version;
    if (typeof args.expectedSha256 === "string") args.expectedSha256 = args.expectedSha256.trim().toLowerCase();
    if (typeof args.imageAssetIds === "string") args.imageAssetIds = [args.imageAssetIds];
    if (Array.isArray(args.pages)) args.pages.forEach((page: unknown) => {
      if (page && typeof page === "object") normalizeSlide((page as Record<string, any>).slide);
    });
    if (Array.isArray(args.appendSlides)) args.appendSlides.forEach(normalizeSlide);
    if (args.design && typeof args.design === "object") {
      for (const key of ["background", "text", "accent"]) args.design[key] = normalizeColor(args.design[key]);
    }
  }
  return args;
}

export const CHAT_DOCUMENT_TOOLS: BrainToolSpec[] = [
  { type: "function", function: { name: "doc_delete", description: "请求删除生成文件；只创建确认按钮，必须由用户点击确认后才会删除。", parameters: objectSchema({ fileId: { type: "string" } }, ["fileId"]) } },
  { type: "function", function: { name: "doc_list", description: "列出本聊天的上传和生成文件，返回文件 ID。", parameters: objectSchema({}) } },
  { type: "function", function: { name: "doc_read", description: "读取本会话文件与 SHA-256。Word 读正文；Excel 只填 fileId 列工作表，再填 sheetName、range（例如 A1:H20，最多 500 格）读取地址和值；PDF 填 page（从 1 开始）读取单页文字。PPT 返回本应用可编辑源方案、元素 ID 及图片索引，外部 PPT 返回风格。文字可按行 offset/limit 或按字符 charOffset/charLimit 分页，有 nextOffset、nextCharOffset 或 nextPage 时按需继续，不能把首批当成全文。", parameters: z.toJSONSchema(schemas.doc_read, { io: "input" }) } },
  { type: "function", function: { name: "doc_search", description: "在本会话文本、Word正文或PPT可编辑源方案中搜索精确文字/元素ID，返回位置、上下文和版本号；可按nextCharOffset翻页，再doc_read读取上下文。偏移按UTF-16代码单元计。", parameters: objectSchema({ fileId: { type: "string" }, query: { type: "string", minLength: 1, maxLength: 500 }, charOffset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["fileId", "query"]) } },
  { type: "function", function: { name: "doc_create", description: "创建新文件。XMind 传结构化 nodes；Word 传 Markdown 正文 content；Excel 传 sheets:[{name,rows:[[单元格,...],...]}]，单元格可填字符串、数字、布尔、null 或 {formula}，公式由 Excel/WPS 打开后计算；其他类型传文本 content。", parameters: objectSchema({ kind: { type: "string", enum: ["md", "txt", "csv", "json", "xmind", "docx", "xlsx"] }, name: { type: "string" }, content: { type: "string", description: "docx 传 Markdown，会按标题/列表/表格/代码块转成 Word 排版" }, sheets: { type: "array", minItems: 1, maxItems: 20, items: z.toJSONSchema(sheetSchema) }, nodes: { type: "object", description: "仅在 kind=xmind 时使用。根节点必须有 title；notes 可选；children 可递归", properties: { title: { type: "string", minLength: 1, maxLength: 2000 }, notes: { type: "string", maxLength: 10000 }, children: { type: "array", items: { type: "object" }, maxItems: 500 } }, required: ["title"], additionalProperties: false } }, ["kind", "name"]) } },
  { type: "function", function: { name: "doc_edit", description: `先用 doc_read 获取文件的 SHA-256，或者直接使用上次 doc_edit 返回的同一新文件 ID 和 SHA-256。文本和 Word 用 edits 精确替换，每个 find 须唯一；Word 仅限段落内普通正文，整篇重写用 doc_create。Excel 用 cells:[{sheet,address,value}] 修改指定单元格，null 清空。按 ID 批量处理用 matchRows，提供目标 sheet、column 和 ids（字符串，保留前导零）或 list（同会话 XLSX 的 fileId、sheet、column）；两边默认从第 2 行到末行，可指定 startRow/endRow。标红填 fontColor="FF0000"，默认只改 ID 字体；用户明确要整行时指定 colorColumns:{from,to}。只有用户要求写标记时才传 marker，默认使用「标记」表头和数值 1。直接用文件 ID 引用清单，无需逐格读出或转抄。PDF 只读。ChatCanvas 生成的 PPT 用 pages:[{page:从1开始,content:声明式内容}] 修改指定页——content 只填 layout 与该版式需要的字段（bullets 3–6 条；groups 用于 cards/comparison/process；table 等列表格；chart 给真实数字；kpi 给 metrics:[{label,value,note?}] 2–4 个；timeline 给 steps:[{title,detail?}] 3–6 个；quote 给 quote:{text,source?}），**不要填坐标、字号或颜色**，渲染器会按整稿主题排版。只有必须原样保留某个已有页面的自定义元素时才用 slide:完整新页面（这会绕过主题，尽量不用）。appendSlides 添加页面，order 调整顺序，design 修改主题。只想改某个已有对象的文字、字号、颜色、位置、配图或图表数据时用 objects:[{slide,elementId,text?,fontSize?,color?,rect?,imageAssetId?,chart?:{categories?,series?:[{name?,values}]}}]（文字沿用原字号与颜色，\n 分段；单位 pt / 6 位十六进制 / 英寸；imageAssetId 取本会话已有图片）：它只改这一个对象，其余页面和部件保持原样；objects 不能与 pages、appendSlides、order、design、imageAssetIds 同时使用。换图只支持图片对象；改图表只支持已有图表，且不能增删系列或分类（数据个数必须与分类数一致），只更新显示数据、内嵌数据表不会跟着改。表格、图标、连线是复合对象，会明确拒绝。原文件不覆盖。现有图片索引取 doc_read 的 images。要把本会话生成或上传的图片放入页面，填 imageAssetIds（真实素材 ID）；这些图片按列表顺序接在原 images 之后，imageIndex 从原 images 的长度开始。外部 PPT 仅支持风格参考。${ELEMENT_DESIGN_GUIDE}`, parameters: z.toJSONSchema(schemas.doc_edit) as Record<string, unknown> } },
  { type: "function", function: { name: "presentation_spec_update", description: "记录本次 PPT 任务的明确要求（页数、必需保留的内容、风格），可只保存不生成。用户说「先不定，等下开始」「必须保留三个案例」「换成杂志风」或明确页数时调用。只传业务意图，不填写证据、文件哈希或引擎参数；服务端从当前用户消息回读原文校验。prepareOnly=true 表示只保存要求，不触发生成。", parameters: objectSchema({ intent: { type: "string", enum: ["create", "update", "fork"] }, specId: { type: "string" }, prepareOnly: { type: "boolean" }, pageCountText: { type: "string", maxLength: 200 }, requiredContent: { type: "array", items: { type: "string", maxLength: 500 }, maxItems: 20 }, styleText: { type: "string", maxLength: 500 } }, ["intent"]) } },
  { type: "function", function: { name: "doc_convert", description: "直接使用原上传的XMind、Markdown、文本或CSV策划并生成原生可编辑PPT；to 只能填 pptx。封面图片用 coverAssetId，正文配图用 pageImages:[{page,assetId}]，从第1页开始计数，封面计入。根据用户指定页或内容顺序分配图片，只填写本会话已有或生图成功返回的真实素材 ID。用户本轮明确要求总页数时填写 pageCount 和本轮逐字原话 pageCountEvidence；参考资料和历史任务的页数不算。转换失败后告知用户，禁止自行换源、创建替代骨架或反复调用。referenceFileId 引用本会话PPT的颜色字体；design 指定 background/text/accent（6位十六进制无#）及 fontFace；用户提到整体风格（如「杂志风」「极简」「暖色教学」）时填 style：magazine / mono / warm / blue，只想改单页颜色仍用 design。", parameters: z.toJSONSchema(schemas.doc_convert) } },
];
export type ChatDocResult = { ok: boolean; summary: string; paused?: boolean; uiData?: { presentation?: TemplateReport; workflow?: { runId: string; calls: number; tokens: number; usageMissing: boolean } }; data?: { fileId: string; fileName: string; byteSize: number; sha256?: string; pendingDelete?: boolean } };

function templateSummary(report: TemplateReport) {
  return [
    report.reason,
    report.planningFallback ? "已按原始章节编排" : "",
    report.fallbackPages.length ? `含 ${report.fallbackPages.length} 张精简页` : "",
    report.pendingPages.length ? `有 ${report.pendingPages.length} 页待补全` : "",
    report.audit === "complete" ? "已进行 AI 内容审校" : report.audit === "partial" ? "已进行部分 AI 内容审校" : "未审校",
    report.resume ? "发送「继续 PPT」可从断点续做" : "",
  ].filter(Boolean).join("。") + "。";
}

export function readWorkspaceFile(db: AppDatabase, conversationId: string, fileId: string) {
  const entry = db.getWorkspaceDocument(conversationId, fileId); if (!entry) throw new Error("文件不存在或不属于当前会话");
  const root = path.resolve((entry as { baseDir?: string }).baseDir || db.documentsDir);
  const dir = path.resolve(root, conversationId); const full = path.join(dir, entry.name);
  const stat = fs.lstatSync(full);
  if (path.dirname(full).toLowerCase() !== dir.toLowerCase() || stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE) throw new Error("文件路径不安全或文件超过大小限制");
  return { ...entry, bytes: fs.readFileSync(full), full };
}
export type ContractCheckContext = {
  plan: AiPresentation;
  baselinePlan?: AiPresentation;
  targets?: number[];
  expectedSpecId?: string;
  expectedSpecRevision?: number;
  /** B：用户明确要求「检查完成再交付」时传 before_publish，默认走 Spec 的策略。 */
  visualPolicy?: "background" | "before_publish";
  /** A：本次执行绑定的契约版本；缺省时才回退到「会话当前活动契约」。 */
  specRef?: { specId: string; specRevision: number };
  /** 素材身份绑定：assetId → imageIndex，供门禁核对「是不是用户指定的那张」。 */
  assetBindings?: Array<{ assetId: string; imageIndex: number }>;
  visualReview?: { status: "complete" | "running" | "unavailable"; blocking?: string[] };
  /** C：由服务端推导的三个检查集合，写进报告供性能验收核对。 */
  checkSets?: CheckSets;
  /** C：视觉阶段实际用量（模型调用页数、缓存命中、WPS 导出页数与耗时）。 */
  visualMetrics?: VisualReviewMetrics;
};

export function saveWorkspaceDocument(db: AppDatabase, conversationId: string, name: string, ext: string, bytes: Buffer, operationId?: string, report?: TemplateReport, lineage?: { familyId?: string; parentId?: string }, contract?: ContractCheckContext) {
  // B：正式发布幂等。getByOperation 只认 published，晚到结果不会把候选误当成成功产物。
  if (operationId) {
    const previous = db.getWorkspaceDocumentByOperation(conversationId, operationId);
    if (previous) {
      const stored = readWorkspaceFile(db, conversationId, previous.id);
      if (report) db.addPresentationVersion(previous.id, createHash("sha256").update(stored.bytes).digest("hex"), report);
      // 幂等重放也必须返回磁盘上的最终报告，调用方不能拿检查前的报告宣布完成。
      const storedReport = db.getPresentationVersion(conversationId, previous.id)?.report ?? report;
      return {
        ...previous,
        ...(storedReport ? { report: storedReport } : {}),
        disposition: (storedReport && !storedReport.draft ? "ready" : "draft") as "ready" | "draft",
      };
    }
  }
  if (bytes.length > MAX_FILE) throw new Error("单个文件不能超过 20 MB");
  // 候选仍计入磁盘容量配额，防止用隐藏状态绕过限制。
  const allFiles = db.listWorkspaceDocuments(conversationId, { includeCandidates: true });
  if (allFiles.length >= 200 || allFiles.reduce((sum, file) => sum + file.byteSize, 0) + bytes.length > 200 * 1024 * 1024) throw new Error("会话文档数量或总容量已达上限");

  // 只认本次执行绑定的那一版契约：保存时重新 findActive 会在「制作中另开任务」时校验错对象。
  const spec = contract && ext === "pptx"
    ? (contract.specRef
      ? db.specs.ownedRevision(conversationId, contract.specRef.specId, contract.specRef.specRevision)
      : db.specs.findActive(conversationId))
    : null;
  // 1. 创建候选：只属于工作流产物，不进入用户文件版本链。
  const created = createCandidateDocument(db, {
    conversationId, name, ext, bytes, operationId,
    owner: operationId ?? "ad-hoc",
    ...(spec ? { specId: spec.specId, specRevision: spec.revision } : {}),
  });

  // 2. 统一硬检查（A 门禁），结果持久化成 validationId 供 publish 复核。
  let effectiveReport = report;
  let validationId: string | null = null;
  let validationOk = true;
  if (contract && ext === "pptx" && spec) {
    const checked = checkPresentationContract(db.specs, {
      conversationId, spec, plan: contract.plan, bytes, report,
      baselinePlan: contract.baselinePlan, targets: contract.targets,
      expectedSpecId: contract.expectedSpecId, expectedSpecRevision: contract.expectedSpecRevision,
    });
    if (checked.blocking.length) throw new Error(`文档契约校验未通过：${checked.blocking.map(item => item.detail).join("；")}`);
    if (checked.validation) {
      const validation = checked.validation;
      validationId = validation.validationId;
      validationOk = validation.ok;
      const failures = validation.failures.map(item => item.detail).join("；");
      const base: TemplateReport = report ?? {
        draft: false, resume: false, fallbackPages: [], pendingPages: [], overflowPages: [],
        sourceLimitedPages: [], notesLimitedPages: [], unplacedImages: 0,
        planningFallback: false, audit: "unavailable", issues: [],
      };
      const at = new Date().toISOString();
      effectiveReport = {
        ...base,
        draft: !validation.ok, resume: !validation.ok, ...(failures ? { reason: failures } : {}),
        contractValidation: validation.validationId,
        specRef: { specId: spec.specId, specRevision: spec.revision },
        readiness: validation.readiness, visibleCoverage: validation.visibleCoverage,
        ...(contract.checkSets ? { checkSets: {
          contentPages: contract.checkSets.contentPages, auditPages: contract.checkSets.auditPages,
          visualPages: contract.checkSets.visualPages, widened: contract.checkSets.widened,
          reason: contract.checkSets.reason,
        } } : {}),
        ...(contract.visualMetrics ? { metrics: {
          visual: {
            pages: contract.visualMetrics.pages, modelCalls: contract.visualMetrics.modelCalls,
            cacheHits: contract.visualMetrics.cacheHits, modelMs: contract.visualMetrics.modelMs,
          },
          wps: contract.visualMetrics.wps,
        } } : {}),
        ...(validation.ok
          ? { usableReadyAt: at, requiredWorkCompletedAt: at }
          : { draftReadyAt: at }),
      };
    }
  }

  // 3. publish 是唯一把 state 改为 published 的入口；失败的必需约束只走显式 draft 分支。
  const published = publishDocument(db, {
    conversationId,
    operationId: created.operationId,
    candidateId: created.id,
    expectedCandidateSha256: created.sha256,
    ...(spec ? { specId: spec.specId, specRevision: spec.revision } : {}),
    validationId,
    disposition: validationOk ? "ready" : "draft",
    // 策略以 Spec 为准；未传时不能再默认「直接发布」。
    ...((contract?.visualPolicy ?? spec?.visualPolicy) ? { visualPolicy: (contract?.visualPolicy ?? spec!.visualPolicy) } : {}),
    ...(contract?.visualReview ? { visualReview: contract.visualReview } : {}),
    ...(effectiveReport ? { report: effectiveReport } : {}),
    lineage,
  });
  if (contract && ext === "pptx" && spec) db.specs.bindFamilyOnly(spec.specId, published.familyId);
  const saved = db.getWorkspaceDocument(conversationId, published.fileId);
  if (!saved) throw new Error("发布后找不到正式文件");
  // 把门禁算出的最终报告和处置结果一起返回：
  // 否则调用方会拿「检查前的报告」去宣布完成，而数据库里其实是草稿。
  return {
    ...saved,
    ...(effectiveReport ? { report: effectiveReport } : {}),
    disposition: (validationOk ? "ready" : "draft") as "ready" | "draft",
  };
}
function source(db: AppDatabase, conversationId: string, rawId: string): { name: string; bytes?: Buffer; mind?: MindDocument } {
  const id = resolveDocumentId(db, conversationId, rawId);
  const item = db.getWorkspaceDocument(conversationId, id);
  if (item) return readWorkspaceFile(db, conversationId, id);
  const doc = db.getConversationDocument(id);
  if (!doc || doc.conversationId !== conversationId) throw new Error("文件不存在或不属于当前会话");
  if (/\.(txt|md|markdown|csv|json)$/i.test(doc.fileName)) return { name: doc.fileName, bytes: Buffer.from(doc.content, "utf8") };
  if (/\.(pptx|docx|xlsx|pdf)$/i.test(doc.fileName)) {
    const bytes = db.getConversationDocumentFile(id);
    if (!bytes) throw new Error("附件原文件不可用，请重新上传");
    return { name: doc.fileName, bytes };
  }
  if (!/\.xmind$/i.test(doc.fileName)) throw new Error("暂不支持该文件格式");
  const original = db.getConversationDocumentFile(id);
  if (original) return { name: doc.fileName, bytes: original };
  const mind = JSON.parse(doc.content) as MindDocument;
  if (mind.format !== "xmind") throw new Error("导图内容无效");
  return { name: doc.fileName, mind };
}

async function readPptImage(db: AppDatabase, conversationId: string, id: string, label = "PPT 配图") {
  const asset = db.listConversationAssets(conversationId).find(entry => entry.asset.id === id)?.asset;
  if (!asset || !isImageAsset(asset)) throw new Error(`${label}素材必须是本会话内的图片，请从生成结果或附件中选择`);
  const maxBytes = 4 * 1024 * 1024;
  const image = await prepareImageBytes(db, asset, { ...REFERENCE_PROFILE, maxBytes });
  if (!image || image.mimeType === "image/webp" || image.bytes.length > maxBytes) throw new Error("图片读取失败，请选择 4 MB 内的 PNG 或 JPEG");
  return image;
}
function flatten(node: DocumentNode, depth = 0): string[] { return [`${"  ".repeat(depth)}- ${node.title}${node.notes ? `（备注：${node.notes}）` : ""}`, ...node.children.flatMap((child) => flatten(child, depth + 1))]; }
function countImageDescriptions(mind: MindDocument): number { const count = (node: DocumentNode): number => (node.imageDescription ? 1 : 0) + node.children.reduce((sum, child) => sum + count(child), 0); return mind.sheets.reduce((sum, root) => sum + count(root), 0); }
/** 统一取文本：docx 走 Word 解析，其余按 UTF-8 */
async function textOf(file: { name: string; bytes?: Buffer }) {
  if (!file.bytes) throw new Error("文件内容不可用");
  if (/\.docx$/i.test(file.name)) return readDocxText(file.bytes);
  if (/\.pptx$/i.test(file.name)) {
    const project = await readPresentationProject(file.bytes);
    return JSON.stringify(project ? { ...project.plan, images: project.images.map((image, imageIndex) => ({ imageIndex, title: image.title })), editable: true } : { ...await readPresentationStyle(file.bytes), editable: false }, null, 2);
  }
  return decodeText(file.bytes);
}
function decodeText(bytes: Buffer) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("文件不是有效的 UTF-8 文本，不能安全读取或修改"); }
}
function xmindTopic(item: DocumentNode): any { return { id: randomUUID(), class: "topic", title: item.title, ...(item.notes ? { notes: { plain: { content: item.notes } } } : {}), children: { attached: item.children.map(xmindTopic) } }; }
export async function executeChatDocumentTool(db: AppDatabase, conversationId: string, name: string, raw: string, planPresentation?: (mind: MindDocument, images: MindImage[], design?: PresentationDesign, sourceFingerprint?: string, coverAssetId?: string, pageCount?: number, pageCountEvidence?: string, style?: string) => Promise<AiPresentation | TemplatePresentation>, operationId?: string, visualReview?: (plan: AiPresentation, images: Array<{ title: string; data: string }>, pageNumbers?: number[]) => Promise<{ plan: AiPresentation; summary: string; metrics?: VisualReviewMetrics }>): Promise<ChatDocResult> {
  try {
    if (!(name in schemas)) throw new Error("未知工具");
    let input: unknown; try { input = JSON.parse(raw); } catch { throw new Error("参数必须是有效 JSON"); }
    input = normalizeDocInput(name, input);
    const schema = schemas[name as keyof typeof schemas]; const parsed = schema.safeParse(input);
    if (!parsed.success) throw new Error(`参数不合法：${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("；")}`);
    const args = parsed.data;
    if (name === "doc_delete") {
      const a = args as z.infer<typeof schemas.doc_delete>;
      const file = db.getWorkspaceDocument(conversationId, resolveDocumentId(db, conversationId, a.fileId));
      if (!file) throw new Error("文件不存在或不属于当前会话");
      return { ok: true, summary: `尚未删除 ${file.name}；请用户在工具卡点击确认删除。`, data: { fileId: file.id, fileName: file.name, byteSize: file.byteSize, pendingDelete: true } };
    }
    if (name === "doc_list") {
      const files = db.listWorkspaceDocuments(conversationId).map((item) => ({ id: item.id, name: item.name, bytes: item.byteSize }));
      const uploads = db.listConversationDocuments(conversationId).filter((item) => /\.(xmind|txt|md|markdown|csv|json|pptx|docx|xlsx|pdf)$/i.test(item.fileName)).map((item) => ({ id: item.id, name: item.fileName, source: "上传" }));
      return { ok: true, summary: JSON.stringify({ files, uploads }) };
    }
    if (name === "doc_search") {
      const { fileId, query, charOffset, limit } = args as z.infer<typeof schemas.doc_search>;
      const file = source(db, conversationId, fileId);
      if (!file.bytes || !/\.(md|markdown|txt|csv|json|docx|pptx)$/i.test(file.name)) throw new Error("当前仅支持搜索文本、Word正文及PPT源方案");
      const text = await textOf(file);
      const matches: Array<{ charOffset: number; contextStart: number; context: string }> = [];
      let cursor = charOffset;
      while (matches.length < limit) {
        const at = text.indexOf(query, cursor);
        if (at < 0) break;
        let start = Math.max(0, at - 120), end = Math.min(text.length, at + query.length + 120);
        if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!)) start--;
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end++;
        matches.push({ charOffset: at, contextStart: start, context: text.slice(start, end) });
        cursor = at + query.length;
      }
      const nextCharOffset = matches.length === limit && text.indexOf(query, cursor) !== -1 ? cursor : null;
      return { ok: true, summary: JSON.stringify({ name: file.name, sha256: createHash("sha256").update(file.bytes).digest("hex"), query, matches, nextCharOffset }) };
    }
    if (name === "doc_read") {
      const { fileId, offset, limit, charOffset, charLimit, sheetName, range, page } = args as z.infer<typeof schemas.doc_read>;
      const file = source(db, conversationId, fileId);
      const sha256 = file.bytes ? createHash("sha256").update(file.bytes).digest("hex") : undefined;
      if (/\.xlsx$/i.test(file.name) && file.bytes) {
        const workbook = await readXlsx(file.bytes, sheetName, range);
        return { ok: true, summary: JSON.stringify({ name: file.name, sha256, ...workbook }) };
      }
      const pdf = /\.pdf$/i.test(file.name) && file.bytes ? await readPdfPage(file.bytes, page ?? 1) : undefined;
      const pdfInfo = pdf ? { page: pdf.page, totalPages: pdf.totalPages, nextPage: pdf.nextPage, warning: pdf.warning } : {};
      const mind = file.mind ?? (/\.xmind$/i.test(file.name) && file.bytes ? await parseXmind(file.bytes) : null);
      if (!mind && !pdf && !/\.(md|markdown|txt|csv|json|docx|pptx)$/i.test(file.name)) throw new Error("当前不支持读取该格式");
      const text = mind ? "" : pdf ? pdf.text : await textOf(file);
      if (charOffset !== undefined) {
        if (mind) throw new Error("导图请使用按行分页读取");
        let end = Math.min(text.length, charOffset + charLimit);
        if (end < text.length && end > charOffset && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end = end - 1 === charOffset ? end + 1 : end - 1;
        const chunk = text.slice(charOffset, end);
        const nextCharOffset = charOffset + chunk.length < text.length ? charOffset + chunk.length : null;
        return { ok: true, summary: JSON.stringify({ name: file.name, sha256, ...pdfInfo, charOffset, chunk, nextCharOffset, remainingChars: Math.max(0, text.length - charOffset - chunk.length) }) };
      }
      const lines = mind ? mind.sheets.flatMap((sheet) => flatten(sheet)) : text.split(/\r?\n/);
      const selected: string[] = []; let chars = 0; let i = offset;
      for (; i < lines.length && selected.length < limit; i++) { const line = lines[i]!; if (line.length > 20000) throw new Error(`第 ${i + 1} 行超过 20000 字，请使用 charOffset 按字符分页读取`); if (chars + line.length > 20000) break; selected.push(line); chars += line.length; }
      return { ok: true, summary: JSON.stringify({ name: file.name, sha256, warning: mind?.warnings, ...pdfInfo, offset, lines: selected, nextOffset: i < lines.length ? i : null, remaining: Math.max(0, lines.length - i) }) };
    }
    if (name === "doc_edit") {
      const { fileId, expectedSha256, edits, cells, matchRows, pages, appendSlides, imageAssetIds, order, design, objects } = args as z.infer<typeof schemas.doc_edit>;
      const resolvedFileId = resolveDocumentId(db, conversationId, fileId);
      const parentDocument = db.getWorkspaceDocument(conversationId, resolvedFileId);
      const lineage = parentDocument ? { familyId: parentDocument.familyId, parentId: parentDocument.id } : undefined;
      const file = source(db, conversationId, fileId);
      if (!file.bytes) throw new Error("文件原文不可用");
      if (!/\.(md|markdown|txt|csv|json|pptx|docx|xlsx)$/i.test(file.name)) throw new Error("当前仅支持修改文本、Word、Excel 及 ChatCanvas 生成的 PPT");
      const currentSha256 = createHash("sha256").update(file.bytes).digest("hex");
      if (currentSha256 !== expectedSha256.toLowerCase()) throw new Error(`文件版本已变化，请重新读取后再修改（当前 SHA-256：${currentSha256}）`);
      const office = /\.(docx|xlsx)$/i.exec(file.name)?.[1]?.toLowerCase();
      if (office) {
        if (pages || appendSlides || imageAssetIds || order || design) throw new Error("Word/Excel 不接受 PPT 页面参数");
        let bytes: Buffer;
        let summary: string;
        if (office === "docx") {
          if (!edits || cells || matchRows) throw new Error("Word 请提供 edits 段落内文字替换列表");
          bytes = await editDocxText(file.bytes, edits);
          summary = `已完成 ${edits.length} 处正文替换。`;
        } else if (matchRows) {
          if (edits || cells) throw new Error("批量匹配与逐格修改请分别提交");
          const list = matchRows.list ? source(db, conversationId, matchRows.list.fileId) : undefined;
          if (list && (!list.bytes || !/\.xlsx$/i.test(list.name))) throw new Error("ID 清单需要是当前会话的 Excel (.xlsx) 文件");
          const result = await matchAndEditXlsx(file.bytes, matchRows, list?.bytes);
          const { scannedRows, requestedIds, matchedIds, matchedRows, unmatched, skippedCells } = result.report;
          summary = `已扫描 ${scannedRows} 行，${requestedIds} 个不同 ID 中命中 ${matchedIds} 个，共 ${matchedRows} 行；未找到 ${unmatched.length} 个。`;
          if (unmatched.length) {
            const sample: string[] = [];
            let chars = 0;
            for (const id of unmatched) {
              if (chars + id.length > 6000) break;
              sample.push(JSON.stringify(id));
              chars += id.length + 3;
            }
            if (sample.length) summary += `未找到的 ID${sample.length < unmatched.length ? `（前 ${sample.length} 个）` : ""}：${sample.join("、")}。`;
          }
          if (skippedCells) summary += `有 ${skippedCells} 个非空单元格因公式、合并或非普通 ID 值跳过。`;
          if (!result.bytes) return { ok: true, summary: `${summary}没有匹配行，未生成修改版。` };
          bytes = result.bytes;
          if (matchRows.fontColor) summary += matchRows.colorColumns ? "已为命中行的指定列设置字体颜色。" : "已为命中的 ID 设置字体颜色。";
          if (matchRows.marker) summary += `已写入「${matchRows.marker.header ?? "标记"}」列。`;
        } else {
          if (!cells || edits) throw new Error("Excel 请提供 cells 单元格修改列表或 matchRows 批量匹配参数");
          bytes = await editXlsx(file.bytes, cells);
          summary = `已完成 ${cells.length} 个单元格修改。请用 Excel 或 WPS 打开并重新计算公式。`;
        }
        const base = file.name.replace(/^(?:\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-(?:\d+-)?)+/, "").replace(/(?:-修改版)*\.(docx|xlsx)$/i, "");
        const saved = saveWorkspaceDocument(db, conversationId, `${base}-修改版`, office, bytes, operationId, undefined, lineage ?? { familyId: `attachment:${resolvedFileId}` });
        const sha256 = createHash("sha256").update(readWorkspaceFile(db, conversationId, saved.id).bytes).digest("hex");
        return { ok: true, summary: `${summary}另存为 ${saved.name}，原文件保留。`, data: { fileId: saved.id, fileName: saved.name, byteSize: saved.byteSize, sha256 } };
      }
      if (cells || matchRows) throw new Error("cells 和 matchRows 仅适用于 Excel 文件");
      if (/\.pptx$/i.test(file.name)) {
        if (edits) throw new Error("PPT 请使用 pages/appendSlides/order/design/objects，不支持对压缩包做文本替换");
        if (!pages && !appendSlides && !order && !design && !objects) throw new Error("请指定要修改的页面、对象或主题");
        const project = await readPresentationProject(file.bytes);
        if (!project) throw new Error("此 PPT 没有 ChatCanvas 可编辑源方案；可以作为风格参考，不能声称已保真修改外部文件");
        const baseName = file.name.replace(/^(?:\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-(?:\d+-)?)+/, "").replace(/(?:-修改版)*\.pptx$/i, "");
        // M2：对象级原位补丁。不重新渲染整稿，非目标部件逐字节保留。
        if (objects) {
          if (pages || appendSlides || order || design || imageAssetIds) throw new Error("objects 只能单独使用：它只改指定对象的样式或位置，不能和整页修改、换主题、新增配图混用");
          // 换图要先把会话素材读成 data URL；其余补丁原样透传。
          const patchList = [];
          for (const object of objects) {
            const image = object.imageAssetId ? await readPptImage(db, conversationId, object.imageAssetId) : undefined;
            patchList.push({
              slide: object.slide, elementId: object.elementId,
              ...(object.text !== undefined ? { text: object.text } : {}),
              ...(object.fontSize !== undefined ? { fontSize: object.fontSize } : {}),
              ...(object.color !== undefined ? { color: object.color } : {}),
              ...(object.rect !== undefined ? { rect: object.rect } : {}),
              ...(image ? { image: { data: `${image.mimeType};base64,${image.bytes.toString("base64")}` } } : {}),
              ...(object.chart !== undefined ? { chart: object.chart } : {}),
            });
          }
          const patched = await patchPresentationObjects(file.bytes, project.plan, patchList, project.images);
          const rejected = patched.report.rejected;
          if (rejected.length) throw new Error(`第 ${rejected[0]!.slide} 页 ${rejected[0]!.elementId} 无法原位修改：${rejected[0]!.reason}`);
          await checkPresentation(patched.bytes, patched.plan);
          const carried = carryDeckReport({
            plan: patched.plan,
            parentReport: db.getPresentationVersion(conversationId, resolvedFileId)?.report,
            parentPlan: project.plan,
            touched: [],
          });
          // 补丁成功但文字可能放不下：写进报告让用户和后续视觉检查都看得见。
          for (const warning of patched.report.warnings) {
            const detail = `第 ${warning.slide} 页 ${warning.elementId} ${warning.detail}`.slice(0, 180);
            if (carried && !carried.issues.some(issue => issue.page === warning.slide && issue.detail === detail)) {
              carried.issues.push({ page: warning.slide, detail });
            }
          }
          const saved = saveWorkspaceDocument(db, conversationId, `${baseName}-修改版`, "pptx", patched.bytes, operationId, carried, lineage,
            { plan: patched.plan, checkSets: { contentPages: [], auditPages: [], visualPages: [], widened: false, reason: "只改对象样式或位置，未重排页面", effects: [] }, ...(carried?.specRef ? { specRef: carried.specRef } : {}) });
          db.pruneWorkspaceFamily(conversationId, parentDocument?.familyId ?? saved.familyId, 3);
          const sha256 = createHash("sha256").update(readWorkspaceFile(db, conversationId, saved.id).bytes).digest("hex");
          const ops = patched.report.applied.flatMap(item => item.operations).length;
          return {
            ok: true,
            summary: `已原位修改 ${patched.report.applied.length} 个对象（${ops} 项属性），只改第 ${[...new Set(patched.report.applied.map(item => item.slide))].join("、")} 页，其余页面和部件保持原样；新版本 ${saved.name}，原文件保留。${patched.report.warnings.length ? ` 注意：${patched.report.warnings.slice(0, 2).map(item => `第 ${item.slide} 页 ${item.elementId}：${item.detail}`).join("；")}` : ""}`,
            data: { fileId: saved.id, fileName: saved.name, byteSize: saved.byteSize, sha256 },
          };
        }
        const carriedThemeId = db.getPresentationVersion(conversationId, resolvedFileId)?.report.theme?.id;
        const images = [...project.images];
        if (imageAssetIds) {
          if (new Set(imageAssetIds).size !== imageAssetIds.length || images.length + imageAssetIds.length > 200) throw new Error("PPT 配图不能重复，图片目录最多容纳 200 张");
          const used = new Set([
            ...(pages ?? []).flatMap(edit => edit.content
              ? [edit.content.imageIndex].filter((index): index is number => index !== undefined)
              : edit.slide ? [edit.slide].flatMap(slide => slide.elements
                ? slide.elements.flatMap(element => element.type === "image" ? [element.imageIndex] : [])
                : slide.layout === "image" || slide.layout === "illustrated" ? [slide.imageIndex!] : []) : []),
            ...(appendSlides ?? []).flatMap(slide => slide.elements
              ? slide.elements.flatMap(element => element.type === "image" ? [element.imageIndex] : [])
              : slide.layout === "image" || slide.layout === "illustrated" ? [slide.imageIndex!] : []),
          ]);
          if (imageAssetIds.some((_, index) => !used.has(images.length + index))) throw new Error("每张新增配图都需在修改的页面上引用对应 imageIndex");
          for (const id of imageAssetIds) {
            const image = await readPptImage(db, conversationId, id);
            images.push({ title: `会话素材 ${id}`, data: `${image.mimeType};base64,${image.bytes.toString("base64")}` });
          }
        }
        let plan = structuredClone(project.plan);
        const theme = getTheme(carriedThemeId);
        const imageIndexes = images.map((_, index) => index);
        const touched = new Set<number>();
        let freeformPages = 0;
        // D2：容量诊断。截断的页要能点名，否则模型会以为改完了其实丢了字。
        const trimmedPages: number[] = [], reflowedPages: number[] = [];
        const capacityIssues: Array<{ page: number; detail: string }> = [];
        for (const edit of pages ?? []) {
          const original = plan.slides[edit.page - 1];
          if (!original || touched.has(edit.page)) throw new Error("修改页码不存在或重复");
          if (Boolean(edit.content) === Boolean(edit.slide)) throw new Error(`第 ${edit.page} 页必须且只能提供 content 或 slide 之一`);
          touched.add(edit.page);
          if (edit.content) {
            // 声明式：只收结构与文字，坐标与样式统一由渲染器按主题计算。
            if (!validSlideContent(edit.content, imageIndexes)) throw new Error(`第 ${edit.page} 页的 content 与本页版式不匹配，请补齐该版式需要的字段`);
            const rendered = renderContentSlide(edit.content, plan.design ?? {}, original.sourceIds ?? [], "", undefined, edit.content.imageIndex, theme);
            plan.slides[edit.page - 1] = { ...rendered.slide, notes: rendered.slide.notes || original.notes, sourceIds: original.sourceIds ?? [] };
            if (rendered.capacity.truncated.length) {
              trimmedPages.push(edit.page);
              for (const issue of rendered.capacity.issues.slice(0, 2)) {
                capacityIssues.push({ page: edit.page, detail: `${issue.slot}：${issue.detail}`.slice(0, 180) });
              }
            }
            if (rendered.capacity.reflowed.length) reflowedPages.push(edit.page);
            continue;
          }
          // 遗留通道：整页元素自带坐标、绕过主题。
          // 由渲染器生成的页不允许被改回自由元素，否则「确定性排版」会被逐步侵蚀。
          if (hasRendererElements(original)) {
            throw new Error(`第 ${edit.page} 页由渲染器生成，请改用 content 声明版式与文字（不要自称已保留元素）`);
          }
          freeformPages++;
          plan.slides[edit.page - 1] = { ...edit.slide!, notes: edit.slide!.notes || original.notes, sourceIds: edit.slide!.sourceIds ?? original.sourceIds };
        }
        if (appendSlides) plan.slides.push(...appendSlides);
        if (order) {
          if (order.length !== plan.slides.length || new Set(order).size !== plan.slides.length || order.some((page) => page > plan.slides.length)) throw new Error("order 必须是全部页面编号各出现一次的排列");
          plan.slides = order.map((page) => plan.slides[page - 1]!);
        }
        if (design) {
          const before = { accent: plan.theme === "blue" ? "286D9C" : "2A716B", text: plan.theme === "blue" ? "142A43" : "1C232B", background: "FAFAF8", fontFace: "Microsoft YaHei", ...plan.design };
          const recolor = (color?: string) => {
            if (!color) return color;
            for (const key of ["accent", "text", "background"] as const) if (design[key] && color.toUpperCase() === before[key].toUpperCase()) return design[key];
            return color;
          };
          plan.slides = plan.slides.map((slide) => ({ ...slide, ...(slide.background ? { background: recolor(slide.background) } : {}), ...(resolveElements(slide) ? { box: undefined, elements: resolveElements(slide)!.map((element) => {
            if (element.type === "text") return { ...element, style: { ...element.style, ...(element.style?.color ? { color: recolor(element.style.color) } : {}), ...(design.fontFace && (!element.style?.fontFace || element.style.fontFace === before.fontFace) ? { fontFace: design.fontFace } : {}) } };
            if (element.type === "shape") return { ...element, fill: recolor(element.fill), ...(element.line ? { line: { ...element.line, color: recolor(element.line.color) } } : {}) };
            if (element.type === "icon" || element.type === "connector") return { ...element, color: recolor(element.color) };
            return element;
          }) } : {}) }));
          plan.design = { ...plan.design, ...design };
        }
        plan = paginatePresentation(aiPresentationSchema.parse(plan));
        // C：ChangeScope 只能由服务端按操作参数推导；共享主题/资源/页序/页数变化自动扩域到全稿。
        const changeScope = deriveChangeScope({
          fileId: resolvedFileId,
          sha256: createHash("sha256").update(file.bytes).digest("hex"),
          totalPages: project.plan.slides.length,
          pages: [...touched],
          appendSlides: appendSlides?.length,
          order: Boolean(order), design: Boolean(design),
          imageAssetIds: imageAssetIds?.length,
        });
        const checkSets = resolveCheckSets(changeScope, plan.slides.length);
        const visual = visualReview
          ? await visualReview(plan, images, checkSets.visualPages)
          : { plan, summary: "未启用视觉检查" };
        plan = visual.plan;
        const rendered = await renderAiPresentation(plan, images); await checkPresentation(rendered, plan);
        const bytes = await packPresentationProject(rendered, plan, images);
        const base = baseName;
        // A：只有未扩域的局部页修改才做非目标页结构化对比；整稿换色/重排会影响全部页面。
        const localOnly = !checkSets.widened && Boolean(pages?.length);
        // 修改入口不重新生成整稿，但原报告的整稿职责计划必须继承下去，
        // 否则结构要求（如「保留 N 个案例」）在修改版上会退化成「未知」。
        const carriedReport = carryDeckReport({
          plan,
          parentReport: db.getPresentationVersion(conversationId, resolvedFileId)?.report,
          parentPlan: project.plan,
          touched: [...touched],
        });
        // 记录遗留通道用量：>0 表示仍有页面绕过渲染器与主题。
        if (freeformPages) {
          if (carriedReport) carriedReport.freeformPages = freeformPages;
          else console.warn(`doc_edit 第 ${[...touched].join("、")} 页使用整页元素且原文件无报告，主题一致性无法核对`);
        }
        // D2：把容量结果并进报告。本次重排过的页一律先清空旧结论 ——
        // 旧记录描述的是上一版页面，留着会变成「第 3 页还在截断」的错误提示。
        if (touched.size && carriedReport) {
          const keep = (items: number[]) => items.filter(item => !touched.has(item));
          carriedReport.capacity = {
            truncatedPages: [...new Set([...keep(carriedReport.capacity?.truncatedPages ?? []), ...trimmedPages])].sort((a, b) => a - b),
            reflowedPages: [...new Set([...keep(carriedReport.capacity?.reflowedPages ?? []), ...reflowedPages])].sort((a, b) => a - b),
            issues: [
              ...(carriedReport.capacity?.issues ?? []).filter(issue => !touched.has(issue.page)),
              ...capacityIssues.filter((issue, index) => capacityIssues.findIndex(item => item.page === issue.page && item.detail === issue.detail) === index),
            ],
          };
        }
        if (!carriedReport && trimmedPages.length) {
          console.warn(`doc_edit 第 ${trimmedPages.join("、")} 页内容超出容量已压缩，原文件无报告可写`);
        }
        // 修改入口按「这份文件当初绑定的契约版本」校验，不取家族当前 revision。
        const boundSpecRef = carriedReport?.specRef;
        const saved = saveWorkspaceDocument(db, conversationId, `${base}-修改版`, "pptx", bytes, operationId, carriedReport, lineage,
          {
            plan, checkSets,
            ...(boundSpecRef ? { specRef: boundSpecRef } : {}),
            ...(localOnly ? { baselinePlan: project.plan, targets: [...touched] } : {}),
            ...(visual.metrics ? { visualMetrics: visual.metrics } : {}),
          });
        db.pruneWorkspaceFamily(conversationId, parentDocument?.familyId ?? saved.familyId, 3);
        const sha256 = createHash("sha256").update(readWorkspaceFile(db, conversationId, saved.id).bytes).digest("hex");
        return { ok: true, summary: `已生成可继续编辑的新版本 ${saved.name}，共 ${plan.slides.length} 页；原文件保留。${visual.summary}${trimmedPages.length ? ` 第 ${trimmedPages.join("、")} 页内容超出容量已压缩（原文在备注），建议改写更短或拆页。` : ""}`, data: { fileId: saved.id, fileName: saved.name, byteSize: saved.byteSize, sha256 } };
      }
      if (!/\.(md|markdown|txt|csv|json)$/i.test(file.name)) throw new Error("当前仅支持修改文本类文件及 ChatCanvas 生成的 PPT");
      if (!edits || pages || appendSlides || imageAssetIds || order || design) throw new Error("文本文件请提供 edits 精确替换列表");
      if (file.bytes.length > 2_000_000) throw new Error("文本文件超过 2 MB，当前无法安全修改");
      let text = decodeText(file.bytes);
      for (const [index, edit] of edits.entries()) {
        const first = text.indexOf(edit.find);
        if (first < 0) throw new Error(`第 ${index + 1} 处修改未找到原文，请重新读取文件`);
        if (text.indexOf(edit.find, first + 1) !== -1) throw new Error(`第 ${index + 1} 处原文匹配多次，请提供更多上下文以确定位置`);
        text = text.slice(0, first) + edit.replace + text.slice(first + edit.find.length);
        if (Buffer.byteLength(text, "utf8") > 2_000_000) throw new Error("修改后的文本超过 2 MB");
      }
      const ext = path.extname(file.name).slice(1).toLowerCase();
      if (ext === "json") { try { JSON.parse(text); } catch { throw new Error("修改后的 JSON 无效，未创建文件"); } }
      const bom = file.bytes.length >= 3 && file.bytes[0] === 0xef && file.bytes[1] === 0xbb && file.bytes[2] === 0xbf;
      const bytes = Buffer.from(`${bom ? "\uFEFF" : ""}${text}`, "utf8");
      const saved = saveWorkspaceDocument(db, conversationId, file.name.replace(/\.[^.]+$/, "") + "-修改版", ext, bytes, operationId, undefined, lineage);
      db.pruneWorkspaceFamily(conversationId, parentDocument?.familyId ?? saved.familyId, 3);
      return { ok: true, summary: `已完成 ${edits.length} 处精确修改，生成新文件 ${saved.name}；原文件已保留。`, data: { fileId: saved.id, fileName: saved.name, byteSize: saved.byteSize } };
    }
    if (name === "doc_create") {
      const a = args as z.infer<typeof schemas.doc_create>; let bytes: Buffer;
      if (a.kind === "xmind") {
        if (!a.nodes) throw new Error("生成 XMind 需要 nodes 主题树");
        const zip = new JSZip(); zip.file("content.json", JSON.stringify([{ id: randomUUID(), class: "sheet", title: a.nodes.title, rootTopic: xmindTopic(a.nodes) }])); zip.file("metadata.json", JSON.stringify({ creator: { name: "ChatCanvas" } })); zip.file("manifest.json", JSON.stringify({ "file-entries": { "content.json": {}, "metadata.json": {} } })); bytes = await zip.generateAsync({ type: "nodebuffer" }); await parseXmind(bytes);
      } else if (a.kind === "docx") {
        if (a.content === undefined) throw new Error("生成 Word 需要 content（Markdown 正文）");
        bytes = await markdownToDocx(a.content, a.name);
      } else if (a.kind === "xlsx") {
        if (!a.sheets || a.content !== undefined) throw new Error("生成 Excel 需要 sheets（工作表与单元格数据）");
        bytes = await createXlsx(a.sheets);
      } else { if (a.content === undefined) throw new Error("生成文本文件需要 content"); if (a.kind === "json") JSON.parse(a.content); bytes = Buffer.from((a.kind === "csv" ? "\uFEFF" : "") + a.content, "utf8"); }
      const saved = saveWorkspaceDocument(db, conversationId, a.name, a.kind, bytes, operationId);
      return { ok: true, summary: `已创建 ${saved.name}，文件可下载。`, data: { fileId: saved.id, fileName: saved.name, byteSize: saved.byteSize } };
    }
    const a = args as z.infer<typeof schemas.doc_convert>; const file = source(db, conversationId, a.fileId);
    const mind = file.mind
      ?? (file.bytes && /\.xmind$/i.test(file.name) ? await parseXmind(file.bytes) : null)
      ?? (file.bytes && /\.(md|markdown|txt|csv)$/i.test(file.name) ? markdownToMind(await textOf(file), file.name.replace(/\.[^.]+$/, "")) : null);
    if (!mind) throw new Error("当前支持 XMind、Markdown、文本与 CSV 转 PPTX");
    if (!planPresentation) throw new Error("AI 幻灯片规划不可用，请检查对话模型后重试；没有生成文件。");
    // 只有 xmind 是 zip、才有主题图片；Markdown 来源没有可提取的图片
    const extracted = file.bytes && /\.xmind$/i.test(file.name) ? await extractMindImages(file.bytes, mind) : { images: [], skipped: 0 };
    let reference: PresentationDesign | undefined;
    let referenceHash = "";
    if (a.referenceFileId) {
      const ref = source(db, conversationId, a.referenceFileId);
      if (!ref.bytes || !/\.pptx$/i.test(ref.name)) throw new Error("风格参考必须是本会话的 PPTX 文件");
      referenceHash = createHash("sha256").update(ref.bytes).digest("hex");
      reference = (await readPresentationStyle(ref.bytes)).design;
    }
    const design = a.design || reference ? { ...reference, ...a.design } : undefined;
    const fingerprint = createHash("sha256").update(file.bytes ?? JSON.stringify(mind)).update(referenceHash);
    let cover: { title: string; data: string } | undefined;
    if (a.coverAssetId) {
      const image = await readPptImage(db, conversationId, a.coverAssetId, "封面");
      cover = { title: "封面图片", data: `${image.mimeType};base64,${image.bytes.toString("base64")}` };
      fingerprint.update("\0cover\0").update(a.coverAssetId).update(image.bytes);
    }
    const pageAssets: Array<{ title: string; data: string }> = [];
    const mapped = a.pageImages ?? [];
    if (new Set(mapped.map(item => `${item.page}:${item.assetId}`)).size !== mapped.length) throw new Error("同一页不能重复放入同一张配图");
    const indexes = new Map<string, number>();
    for (const { assetId } of mapped) {
      if (indexes.has(assetId)) continue;
      const image = await readPptImage(db, conversationId, assetId);
      indexes.set(assetId, extracted.images.length + Number(Boolean(cover)) + pageAssets.length);
      pageAssets.push({ title: `会话素材 ${assetId}`, data: `${image.mimeType};base64,${image.bytes.toString("base64")}` });
      fingerprint.update("\0page-image\0").update(assetId).update(image.bytes);
    }
    if (mapped.length) fingerprint.update(JSON.stringify(mapped));
    const placements = mapped.map(({ page, assetId }) => ({ page, imageIndex: indexes.get(assetId)! }));
    const imageSummary = mapped.length ? `已放置 ${mapped.length} 张指定配图，涉及第 ${[...new Set(mapped.map(item => item.page))].sort((a, b) => a - b).join("、")} 页。` : "";
    const planned = await planPresentation(mind, extracted.images, design, fingerprint.digest("hex"), a.coverAssetId, a.pageCount, a.pageCountEvidence, a.style);
    if ("template" in planned) {
      const { plan: basePlan, template } = planned;
      const summary = templateSummary(template);
      const uiData = { presentation: template };
      if (!basePlan) return { ok: false, paused: true, summary: `PPT 已暂停，当前尚无可导出的正文页。${summary}`, uiData };
      const plan = placePresentationImages(basePlan, placements);
      const images = [...extracted.images, ...(cover ? [cover] : []), ...pageAssets];
      const rendered = await renderAiPresentation(plan, images);
      await checkPresentation(rendered, plan);
      const bytes = await packPresentationProject(rendered, plan, images);
      const snapshot = template.resume && operationId
        ? `${operationId}:draft:${createHash("sha256").update(JSON.stringify({ plan, template })).digest("hex")}`
        : operationId;
      const base = file.name.replace(/\.[^.]+$/, "");
      const runFamily = operationId ? `ppt-run:${operationId.split(":draft:")[0]}` : undefined;
      // 素材身份：把「哪张 asset 落在哪个 imageIndex」记下来，门禁才不会拿图片数量冒充指定素材。
      const assetBindings = [...indexes.entries()].map(([assetId, imageIndex]) => ({ assetId, imageIndex }));
      const saved = saveWorkspaceDocument(db, conversationId, template.draft ? `草稿-${base}` : base, "pptx", bytes, snapshot, template, runFamily ? { familyId: runFamily } : undefined,
        { plan, ...(template.specRef ? { specRef: template.specRef } : {}), ...(assetBindings.length ? { assetBindings } : {}) });
      if (runFamily) db.pruneWorkspaceFamily(conversationId, runFamily, 3);
      // 门禁可能把文件判成草稿；工具结果、UI 和工作流都必须看这一份最终报告，
      // 不然会出现「数据库是草稿、聊天显示完成、断点已清」。
      const finalReport = saved.report ?? template;
      const paused = Boolean(finalReport.resume || saved.disposition === "draft");
      // 活跃引用保护：暂停/待补全的 PPT 家族在断点期间不能被 keep=3 清掉，
      // 完成时由调用方释放（agent 清理断点的同一处）。
      const runOwner = `ppt-run:${(operationId ?? snapshot ?? "").split(":draft:")[0]}`;
      if (runFamily) {
        if (paused) db.specs.registerFamilyRef({ familyId: runFamily, conversationId, owner: runOwner, kind: "paused" });
        else db.specs.releaseFamilyRef(runOwner);
      }
      const headline = saved.disposition === "draft"
        ? (finalReport.resume ? "PPT 草稿已导出" : "PPT 已导出，但未达到可用成品")
        : "PPT 已导出";
      return {
        ok: true, paused,
        summary: `${headline}，共 ${plan.slides.length} 页。${summary}${cover ? "指定封面图已嵌入。" : ""}${imageSummary}${extracted.images.length ? `已观察 ${countImageDescriptions(mind)}/${extracted.images.length} 张原图的内容。` : ""}${extracted.skipped ? `有 ${extracted.skipped} 张源文件图片未能提取。` : ""}${finalReport.reason ? ` 尚未满足：${finalReport.reason}` : ""}`,
        uiData: { ...uiData, presentation: finalReport },
        data: { fileId: saved.id, fileName: saved.name, byteSize: saved.byteSize },
      };
    }
    let presentation = paginatePresentation(planned);
    if (design) presentation.design = design;
    const inserted = new Map<number, typeof presentation.slides>();
    extracted.images.forEach((image, imageIndex) => {
      if (presentation.slides.some((slide) => resolveElements(slide)?.some((element) => element.type === "image" && element.imageIndex === imageIndex))) return;
      const index = presentation.slides.findIndex((slide) => slide.sourceIds?.some((id) => id.startsWith(`${image.sourceId}.`) || id.startsWith(`${image.sourceId}-image.`)));
      const target = presentation.slides[index];
      if (target && !target.elements && !target.box && ["content", "columns", "keypoint"].includes(target.layout) && target.lines.length <= 4 && target.imageIndex === undefined) {
        presentation.slides[index] = { ...target, layout: "illustrated", imageIndex }; return;
      }
      const after = index < 0 ? presentation.slides.length - 1 : index;
      const group = inserted.get(after) ?? [];
      group.push({ layout: "image", title: image.title.slice(0, 70), subtitle: "", lines: [], notes: `原导图主题图片：${image.title}`, imageIndex }); inserted.set(after, group);
    });
    presentation.slides = presentation.slides.flatMap((slide, index) => [slide, ...(inserted.get(index) ?? [])]);
    const images: Array<{ title: string; data: string }> = [...extracted.images];
    if (cover) {
      const first = presentation.slides[0]!;
      const foreground = design?.background && design.text ? design.text : "FFFFFF";
      presentation.slides[0] = {
        ...first, layout: "cover", background: design?.background && design.text ? design.background : "142A43", box: undefined,
        notes: [first.notes, `会话封面素材 ID ${a.coverAssetId}`].filter(Boolean).join("\n"),
        elements: [
          { id: "cover-title", type: "text", x: 0.8, y: 1.15, w: 5.3, h: 2.7, text: first.title, style: { fontSize: first.title.length > 34 ? 25 : 32, bold: true, color: foreground, valign: "middle" } },
          ...(first.subtitle ? [{ id: "cover-subtitle", type: "text" as const, x: 0.8, y: 4, w: 5.3, h: 2.5, text: first.subtitle, style: { fontSize: first.subtitle.length > 80 ? 16 : 19, color: foreground } }] : []),
          { id: "cover-image", type: "image", x: 6.55, y: 0.75, w: 5.95, h: 5.95, imageIndex: images.length, fit: "contain" },
        ],
      };
      images.push(cover);
    }
    images.push(...pageAssets);
    presentation = placePresentationImages(presentation, placements);
    if (presentation.slides.length > 200) throw new Error("包含图片的 PPT 超过 200 页，请分章节转换；没有生成文件。");
    const visual = visualReview ? await visualReview(presentation, images) : { plan: presentation, summary: "未启用视觉检查" };
    presentation = visual.plan;
    const rendered = await renderAiPresentation(presentation, images);
    await checkPresentation(rendered, presentation);
    const bytes = await packPresentationProject(rendered, presentation, images);
    const saved = saveWorkspaceDocument(db, conversationId, file.name.replace(/\.[^.]+$/, ""), "pptx", bytes, operationId, undefined, undefined, { plan: presentation });
    return { ok: true, summary: `AI 已整理导图，生成 ${saved.name}，共 ${presentation.slides.length} 页。${cover ? "指定图片已嵌入封面。" : ""}${imageSummary}来源文字和关联关系保存在演讲备注中。已提取 ${extracted.images.length} 张主题图片并放在相关内容附近${extracted.skipped ? `，${extracted.skipped} 张未能导入` : ""}；其中 ${countImageDescriptions(mind)} 张已由视觉模型观察，观察可能有误。${visual.summary}。原布局没有还原，请核对内容。${!file.bytes ? " 该旧附件未保存原文件，无法提取图片，请重新上传。" : ""}${mind.warnings.length ? ` ${mind.warnings.join(" ")}` : ""}`, data: { fileId: saved.id, fileName: saved.name, byteSize: saved.byteSize } };
  } catch (error) {
    if (error instanceof PresentationPaused) throw error;
    return { ok: false, summary: error instanceof Error ? error.message : "文档操作失败" };
  }
}
