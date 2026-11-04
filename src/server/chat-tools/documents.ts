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
import { markdownToDocx, markdownToMind, readDocxText } from "./markdown.js";
import { designSchema, resolveElements, ELEMENT_DESIGN_GUIDE, type PresentationDesign } from "../presentation-elements.js";
import { readPresentationProject, packPresentationProject, readPresentationStyle } from "../presentation-project.js";
import { isImageAsset } from "../../shared/types.js";
import { prepareImageBytes, REFERENCE_PROFILE } from "../vision.js";

const MAX_FILE = 20 * 1024 * 1024;
const nodeSchema: z.ZodType<DocumentNode> = z.lazy(() => z.object({ title: z.string().trim().min(1).max(2000), notes: z.string().max(10000).default(""), children: z.array(nodeSchema).max(500).default([]) }));
const schemas = {
  doc_list: z.object({}),
  doc_delete: z.object({ fileId: z.string().min(1) }),
  doc_read: z.object({ fileId: z.string().min(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(500).default(100), charOffset: z.number().int().min(0).optional(), charLimit: z.number().int().min(1).max(20000).default(12000) }),
  doc_search: z.object({ fileId: z.string().min(1), query: z.string().min(1).max(500), charOffset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20) }),
  doc_create: z.object({ kind: z.enum(["md", "txt", "csv", "json", "xmind", "docx"]), name: z.string().trim().min(1).max(120), content: z.string().max(2_000_000).optional(), nodes: nodeSchema.optional() }),
  doc_edit: z.object({ fileId: z.string().min(1), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i), edits: z.array(z.object({ find: z.string().min(1).max(20000), replace: z.string().max(100000) })).min(1).max(20).optional(), pages: z.array(z.object({ page: z.number().int().min(1).max(200), slide: aiPresentationSchema.shape.slides.element.omit({ box: true }) }).strict()).min(1).max(30).optional(), appendSlides: z.array(aiPresentationSchema.shape.slides.element.omit({ box: true })).min(1).max(30).optional(), order: z.array(z.number().int().min(1).max(200)).min(1).max(200).optional(), design: designSchema.optional() }),
  doc_convert: z.object({ fileId: z.string().min(1), to: z.literal("pptx"), referenceFileId: z.string().min(1).optional(), coverAssetId: z.uuid().optional(), design: designSchema.optional() }),
};
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
export const CHAT_DOCUMENT_TOOLS: BrainToolSpec[] = [
  { type: "function", function: { name: "doc_delete", description: "请求删除生成文件；只创建确认按钮，必须由用户点击确认后才会删除。", parameters: objectSchema({ fileId: { type: "string" } }, ["fileId"]) } },
  { type: "function", function: { name: "doc_list", description: "列出本聊天的已上传导图和已生成文件，返回文件 ID。", parameters: objectSchema({}) } },
  { type: "function", function: { name: "doc_read", description: "读取本会话文件内容与 SHA-256 版本号；PPT返回本应用可编辑源方案、稳定元素ID及图片索引，外部PPT返回风格参考信息。按行分页offset/limit，按字符分页charOffset/charLimit；存在nextOffset/nextCharOffset时需继续读取，不能把第一页当成全文。", parameters: objectSchema({ fileId: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 500 }, charOffset: { type: "integer", minimum: 0 }, charLimit: { type: "integer", minimum: 1, maximum: 20000 } }, ["fileId"]) } },
  { type: "function", function: { name: "doc_search", description: "在本会话文本、Word正文或PPT可编辑源方案中搜索精确文字/元素ID，返回位置、上下文和版本号；可按nextCharOffset翻页，再doc_read读取上下文。偏移按UTF-16代码单元计。", parameters: objectSchema({ fileId: { type: "string" }, query: { type: "string", minLength: 1, maxLength: 500 }, charOffset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["fileId", "query"]) } },
  { type: "function", function: { name: "doc_create", description: "根据用户要求创建新文件；xmind 传结构化 nodes，docx 传 Markdown 正文（按标题/列表/表格/代码块转成 Word 排版），其余类型传纯文本内容。不会覆盖已有文件。", parameters: objectSchema({ kind: { type: "string", enum: ["md", "txt", "csv", "json", "xmind", "docx"] }, name: { type: "string" }, content: { type: "string", description: "docx 传 Markdown，会按标题/列表/表格/代码块转成 Word 排版" }, nodes: { type: "object", description: "思维导图根节点：{title, notes?, children:[同结构的子节点]}" } }, ["kind", "name"]) } },
  { type: "function", function: { name: "doc_edit", description: `先doc_read获取SHA-256版本号。文本类用edits精确替换，每个find须唯一。ChatCanvas生成的PPT用pages:[{page:从1开始,slide:完整新页面}]修改指定页，可用appendSlides添加页面，order给所有页面编号的排列（包含新加页）调整顺序，design修改主题。原文件不覆盖。保留未要求修改的事实和来源；图片索引取doc_read中的images目录。外部PPT仅支持风格参考。${ELEMENT_DESIGN_GUIDE}`, parameters: z.toJSONSchema(schemas.doc_edit) as Record<string, unknown> } },
  { type: "function", function: { name: "doc_convert", description: "直接使用原上传的XMind、Markdown、文本或CSV完整阅读、策划并生成原生可编辑PPT；不要先概括成新MD再转换，避免丢失原文细节。转换器内置阅读、设计及审校，失败应依据具体错误修正要求，不要反复改换源格式重试。referenceFileId引用本会话PPT颜色字体参考；design指定background/text/accent（6位十六进制无#）及fontFace。用户指定封面图时，coverAssetId 填本会话真实图片的完整 ID；需要先生成时，等生成工具返回成功的 assetIds 后再转换。支持原生图文、表格、图表与关联线，不还原原布局样式。", parameters: z.toJSONSchema(schemas.doc_convert) } },
];
export type ChatDocResult = { ok: boolean; summary: string; data?: { fileId: string; fileName: string; byteSize: number; pendingDelete?: boolean } };

function safeName(name: string, extension: string) {
  let base = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").trim().slice(0, 70) || "文档";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)) base = `_${base}`;
  if (!base.toLowerCase().endsWith(`.${extension}`)) base += `.${extension}`;
  return base;
}
function workspaceDir(db: AppDatabase, conversationId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(conversationId) || !db.getConversation(conversationId)) throw new Error("会话不存在");
  const root = path.resolve(db.dataDir, "documents");
  const dir = path.resolve(root, conversationId);
  if (path.dirname(dir).toLowerCase() !== root.toLowerCase()) throw new Error("文件路径越界");
  for (const part of [root, dir]) { if (!fs.existsSync(part)) fs.mkdirSync(part); if (fs.lstatSync(part).isSymbolicLink() || !fs.statSync(part).isDirectory()) throw new Error("工作目录不安全"); }
  return dir;
}
export function readWorkspaceFile(db: AppDatabase, conversationId: string, fileId: string) {
  const entry = db.getWorkspaceDocument(conversationId, fileId); if (!entry) throw new Error("文件不存在或不属于当前会话");
  const dir = workspaceDir(db, conversationId); const full = path.join(dir, entry.name);
  const stat = fs.lstatSync(full);
  if (path.dirname(full).toLowerCase() !== dir.toLowerCase() || stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE) throw new Error("文件路径不安全或文件超过大小限制");
  return { ...entry, bytes: fs.readFileSync(full), full };
}
function save(db: AppDatabase, conversationId: string, name: string, ext: string, bytes: Buffer, operationId?: string) {
  if (operationId) {
    const previous = db.getWorkspaceDocumentByOperation(conversationId, operationId);
    if (previous) { readWorkspaceFile(db, conversationId, previous.id); return previous; }
  }
  if (bytes.length > MAX_FILE) throw new Error("单个文件不能超过 20 MB");
  const files = db.listWorkspaceDocuments(conversationId);
  if (files.length >= 200 || files.reduce((sum, file) => sum + file.byteSize, 0) + bytes.length > 200 * 1024 * 1024) throw new Error("会话文档数量或总容量已达上限");
  const dir = workspaceDir(db, conversationId); const safe = safeName(name, ext);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let i = 0; i < 1000; i++) {
    const candidate = `${stamp}-${i ? `${i}-` : ""}${safe}`; const full = path.join(dir, candidate);
    const temporary = path.join(dir, `.pending-${randomUUID()}`);
    try {
      fs.writeFileSync(temporary, bytes, { flag: "wx" });
      // 硬链接只在目标不存在时成功；先写完临时文件，再原子发布，避免覆盖和半文件。
      fs.linkSync(temporary, full);
      try { return db.addWorkspaceDocument(conversationId, candidate, bytes.length, operationId); }
      catch (error) { fs.rmSync(full, { force: true }); throw error; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    } finally { fs.rmSync(temporary, { force: true }); }
  }
  throw new Error("无法创建文件，请稍后重试");
}
function source(db: AppDatabase, conversationId: string, id: string): { name: string; bytes?: Buffer; mind?: MindDocument } {
  const item = db.getWorkspaceDocument(conversationId, id);
  if (item) return readWorkspaceFile(db, conversationId, id);
  const doc = db.getConversationDocument(id);
  if (!doc || doc.conversationId !== conversationId) throw new Error("文件不存在或不属于当前会话");
  if (/\.(txt|md|markdown|csv|json)$/i.test(doc.fileName)) return { name: doc.fileName, bytes: Buffer.from(doc.content, "utf8") };
  if (/\.pptx$/i.test(doc.fileName)) { const bytes = db.getConversationDocumentFile(id); if (!bytes) throw new Error("参考PPT原文件不可用，请重新上传"); return { name: doc.fileName, bytes }; }
  if (!/\.xmind$/i.test(doc.fileName)) throw new Error("暂不支持该文件格式");
  const original = db.getConversationDocumentFile(id);
  if (original) return { name: doc.fileName, bytes: original };
  const mind = JSON.parse(doc.content) as MindDocument;
  if (mind.format !== "xmind") throw new Error("导图内容无效");
  return { name: doc.fileName, mind };
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
export async function executeChatDocumentTool(db: AppDatabase, conversationId: string, name: string, raw: string, planPresentation?: (mind: MindDocument, images: MindImage[], design?: PresentationDesign, sourceFingerprint?: string, coverAssetId?: string) => Promise<AiPresentation>, operationId?: string, visualReview?: (plan: AiPresentation, images: Array<{ title: string; data: string }>) => Promise<{ plan: AiPresentation; summary: string }>): Promise<ChatDocResult> {
  try {
    if (!(name in schemas)) throw new Error("未知工具");
    let input: unknown; try { input = JSON.parse(raw); } catch { throw new Error("参数必须是有效 JSON"); }
    const schema = schemas[name as keyof typeof schemas]; const parsed = schema.safeParse(input);
    if (!parsed.success) throw new Error(`参数不合法：${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("；")}`);
    const args = parsed.data;
    if (name === "doc_delete") {
      const a = args as z.infer<typeof schemas.doc_delete>;
      const file = db.getWorkspaceDocument(conversationId, a.fileId);
      if (!file) throw new Error("文件不存在或不属于当前会话");
      return { ok: true, summary: `尚未删除 ${file.name}；请用户在工具卡点击确认删除。`, data: { fileId: file.id, fileName: file.name, byteSize: file.byteSize, pendingDelete: true } };
    }
    if (name === "doc_list") {
      const files = db.listWorkspaceDocuments(conversationId).map((item) => ({ id: item.id, name: item.name, bytes: item.byteSize }));
      const uploads = db.listConversationDocuments(conversationId).filter((item) => /\.(xmind|txt|md|markdown|csv|json|pptx)$/i.test(item.fileName)).map((item) => ({ id: item.id, name: item.fileName, source: "上传" }));
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
      const { fileId, offset, limit, charOffset, charLimit } = args as z.infer<typeof schemas.doc_read>; const file = source(db, conversationId, fileId);
      const mind = file.mind ?? (/\.xmind$/i.test(file.name) && file.bytes ? await parseXmind(file.bytes) : null);
      if (!mind && !/\.(md|markdown|txt|csv|json|docx|pptx)$/i.test(file.name)) throw new Error("当前不支持读取该格式");
      const sha256 = file.bytes ? createHash("sha256").update(file.bytes).digest("hex") : undefined;
      const text = mind ? "" : await textOf(file);
      if (charOffset !== undefined) {
        if (mind) throw new Error("导图请使用按行分页读取");
        let end = Math.min(text.length, charOffset + charLimit);
        if (end < text.length && end > charOffset && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end = end - 1 === charOffset ? end + 1 : end - 1;
        const chunk = text.slice(charOffset, end);
        const nextCharOffset = charOffset + chunk.length < text.length ? charOffset + chunk.length : null;
        return { ok: true, summary: JSON.stringify({ name: file.name, sha256, charOffset, chunk, nextCharOffset, remainingChars: Math.max(0, text.length - charOffset - chunk.length) }) };
      }
      const lines = mind ? mind.sheets.flatMap((sheet) => flatten(sheet)) : text.split(/\r?\n/);
      const selected: string[] = []; let chars = 0; let i = offset;
      for (; i < lines.length && selected.length < limit; i++) { const line = lines[i]!; if (line.length > 20000) throw new Error(`第 ${i + 1} 行超过 20000 字，请使用 charOffset 按字符分页读取`); if (chars + line.length > 20000) break; selected.push(line); chars += line.length; }
      return { ok: true, summary: JSON.stringify({ name: file.name, sha256, offset, lines: selected, nextOffset: i < lines.length ? i : null, remaining: Math.max(0, lines.length - i), warning: mind?.warnings }) };
    }
    if (name === "doc_edit") {
      const { fileId, expectedSha256, edits, pages, appendSlides, order, design } = args as z.infer<typeof schemas.doc_edit>;
      const file = source(db, conversationId, fileId);
      if (!file.bytes) throw new Error("文件原文不可用");
      if (!/\.(md|markdown|txt|csv|json|pptx)$/i.test(file.name)) throw new Error("当前仅支持修改文本类文件及 ChatCanvas 生成的 PPT");
      if (createHash("sha256").update(file.bytes).digest("hex") !== expectedSha256.toLowerCase()) throw new Error("文件版本已变化，请重新读取后再修改");
      if (/\.pptx$/i.test(file.name)) {
        if (edits) throw new Error("PPT 请使用 pages/appendSlides/order/design，不支持对压缩包做文本替换");
        if (!pages && !appendSlides && !order && !design) throw new Error("请指定要修改的页面或主题");
        const project = await readPresentationProject(file.bytes);
        if (!project) throw new Error("此 PPT 没有 ChatCanvas 可编辑源方案；可以作为风格参考，不能声称已保真修改外部文件");
        let plan = structuredClone(project.plan);
        const touched = new Set<number>();
        for (const edit of pages ?? []) {
          const original = plan.slides[edit.page - 1];
          if (!original || touched.has(edit.page)) throw new Error("修改页码不存在或重复");
          touched.add(edit.page);
          plan.slides[edit.page - 1] = { ...edit.slide, notes: edit.slide.notes || original.notes, sourceIds: edit.slide.sourceIds ?? original.sourceIds };
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
        const visual = visualReview ? await visualReview(plan, project.images) : { plan, summary: "未启用视觉检查" };
        plan = visual.plan;
        const rendered = await renderAiPresentation(plan, project.images); await checkPresentation(rendered, plan);
        const bytes = await packPresentationProject(rendered, plan, project.images);
        const saved = save(db, conversationId, file.name.replace(/\.pptx$/i, "") + "-修改版", "pptx", bytes, operationId);
        return { ok: true, summary: `已生成可继续编辑的新版本 ${saved.name}，共 ${plan.slides.length} 页；原文件保留。${visual.summary}`, data: { fileId: saved.id, fileName: saved.name, byteSize: saved.byteSize } };
      }
      if (!/\.(md|markdown|txt|csv|json)$/i.test(file.name)) throw new Error("当前仅支持修改文本类文件及 ChatCanvas 生成的 PPT");
      if (!edits || pages || appendSlides || order || design) throw new Error("文本文件请提供 edits 精确替换列表");
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
      const saved = save(db, conversationId, file.name.replace(/\.[^.]+$/, "") + "-修改版", ext, bytes, operationId);
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
      } else { if (a.content === undefined) throw new Error("生成文本文件需要 content"); if (a.kind === "json") JSON.parse(a.content); bytes = Buffer.from((a.kind === "csv" ? "\uFEFF" : "") + a.content, "utf8"); }
      const saved = save(db, conversationId, a.name, a.kind, bytes, operationId);
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
      const asset = db.listConversationAssets(conversationId).find(({ asset }) => asset.id === a.coverAssetId)?.asset;
      if (!asset || !isImageAsset(asset)) throw new Error("封面素材必须是本会话内的图片，请选择已有图片后继续制作 PPT。");
      const image = await prepareImageBytes(db, asset, { ...REFERENCE_PROFILE, maxBytes: 4 * 1024 * 1024 });
      if (!image || image.mimeType === "image/webp" || image.bytes.length > 4 * 1024 * 1024) {
        throw new Error("封面图片读取失败或格式不受支持，请选择 4 MB 内的 PNG 或 JPEG 后继续制作 PPT。");
      }
      cover = { title: "封面图片", data: `${image.mimeType};base64,${image.bytes.toString("base64")}` };
      fingerprint.update("\0cover\0").update(asset.id).update(image.bytes);
    }
    let presentation = paginatePresentation(await planPresentation(mind, extracted.images, design, fingerprint.digest("hex"), a.coverAssetId));
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
    if (presentation.slides.length > 200) throw new Error("包含图片的 PPT 超过 200 页，请分章节转换；没有生成文件。");
    const visual = visualReview ? await visualReview(presentation, images) : { plan: presentation, summary: "未启用视觉检查" };
    presentation = visual.plan;
    const rendered = await renderAiPresentation(presentation, images);
    await checkPresentation(rendered, presentation);
    const bytes = await packPresentationProject(rendered, presentation, images);
    const saved = save(db, conversationId, file.name.replace(/\.[^.]+$/, ""), "pptx", bytes, operationId);
    return { ok: true, summary: `AI 已整理导图，生成 ${saved.name}，共 ${presentation.slides.length} 页。${cover ? "指定图片已嵌入封面。" : ""}来源文字和关联关系保存在演讲备注中。已提取 ${extracted.images.length} 张主题图片并放在相关内容附近${extracted.skipped ? `，${extracted.skipped} 张未能导入` : ""}；其中 ${countImageDescriptions(mind)} 张已由视觉模型观察，观察可能有误。${visual.summary}。原布局没有还原，请核对内容。${!file.bytes ? " 该旧附件未保存原文件，无法提取图片，请重新上传。" : ""}${mind.warnings.length ? ` ${mind.warnings.join(" ")}` : ""}`, data: { fileId: saved.id, fileName: saved.name, byteSize: saved.byteSize } };
  } catch (error) {
    if (error instanceof PresentationPaused) throw error;
    return { ok: false, summary: error instanceof Error ? error.message : "文档操作失败" };
  }
}
