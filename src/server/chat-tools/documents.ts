import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import type { AppDatabase } from "../db.js";
import { extractMindImages, parseXmind, renderAiPresentation, type AiPresentation, type DocumentNode, type MindDocument, type MindImage } from "../mind-document.js";
import type { BrainToolSpec } from "../brain.js";
import { checkPresentation, paginatePresentation } from "../presentation-check.js";

const MAX_FILE = 20 * 1024 * 1024;
const nodeSchema: z.ZodType<DocumentNode> = z.lazy(() => z.object({ title: z.string().trim().min(1).max(2000), notes: z.string().max(10000).default(""), children: z.array(nodeSchema).max(500).default([]) }));
const schemas = {
  doc_list: z.object({}),
  doc_delete: z.object({ fileId: z.string().min(1) }),
  doc_read: z.object({ fileId: z.string().min(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(500).default(100), charOffset: z.number().int().min(0).optional(), charLimit: z.number().int().min(1).max(20000).default(12000) }),
  doc_search: z.object({ fileId: z.string().min(1), query: z.string().min(1).max(500), charOffset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20) }),
  doc_create: z.object({ kind: z.enum(["md", "txt", "csv", "json", "xmind"]), name: z.string().trim().min(1).max(120), content: z.string().max(2_000_000).optional(), nodes: nodeSchema.optional() }),
  doc_edit: z.object({ fileId: z.string().min(1), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i), edits: z.array(z.object({ find: z.string().min(1).max(20000), replace: z.string().max(100000) })).min(1).max(20) }),
  doc_convert: z.object({ fileId: z.string().min(1), to: z.enum(["pptx"]) }),
};
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
export const CHAT_DOCUMENT_TOOLS: BrainToolSpec[] = [
  { type: "function", function: { name: "doc_delete", description: "请求删除生成文件；只创建确认按钮，必须由用户点击确认后才会删除。", parameters: objectSchema({ fileId: { type: "string" } }, ["fileId"]) } },
  { type: "function", function: { name: "doc_list", description: "列出本聊天的已上传导图和已生成文件，返回文件 ID。", parameters: objectSchema({}) } },
  { type: "function", function: { name: "doc_read", description: "读取本会话文件内容，返回 SHA-256 版本号。默认按行分页；文本文件传 charOffset 可按字符分页并保留原始换行，适合长行和精确修改。", parameters: objectSchema({ fileId: { type: "string" }, offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 500 }, charOffset: { type: "integer", minimum: 0 }, charLimit: { type: "integer", minimum: 1, maximum: 20000 } }, ["fileId"]) } },
  { type: "function", function: { name: "doc_search", description: "在本会话 UTF-8 文本、Markdown、CSV 或 JSON 中搜索精确文字，返回位置、上下文和版本号；可按 nextCharOffset 翻页，用 doc_read 查看完整上下文。偏移按 UTF-16 代码单元计。", parameters: objectSchema({ fileId: { type: "string" }, query: { type: "string", minLength: 1, maxLength: 500 }, charOffset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, ["fileId", "query"]) } },
  { type: "function", function: { name: "doc_create", description: "根据用户要求创建新文件；xmind 传结构化 nodes，其余类型传完整字符串 content。不会覆盖已有文件。", parameters: objectSchema({ kind: { type: "string", enum: ["md", "txt", "csv", "json", "xmind"] }, name: { type: "string" }, content: { type: "string" }, nodes: { type: "object", description: "思维导图根节点：{title, notes?, children:[同结构的子节点]}" } }, ["kind", "name"]) } },
  { type: "function", function: { name: "doc_edit", description: "根据 doc_read 的 SHA-256 版本号，对本会话的 UTF-8 文本、Markdown、CSV 或 JSON 精确替换并创建新版本。每个 find 必须在当前内容中唯一匹配；先用 doc_read 读取。原文件不会覆盖。", parameters: objectSchema({ fileId: { type: "string" }, expectedSha256: { type: "string", description: "doc_read 返回的 sha256" }, edits: { type: "array", minItems: 1, maxItems: 20, items: objectSchema({ find: { type: "string", minLength: 1 }, replace: { type: "string" } }, ["find", "replace"]) } }, ["fileId", "expectedSha256", "edits"]) } },
  { type: "function", function: { name: "doc_convert", description: "将本会话 XMind 交由 AI 整理并生成可编辑 PPT。可解析的关联关系以文字参与规划；支持的主题图片作为独立页导入，启用看图时尝试理解部分图片。原布局与关系线样式不保留，应按工具结果告知用户实际情况。", parameters: objectSchema({ fileId: { type: "string" }, to: { type: "string", enum: ["pptx"] } }, ["fileId", "to"]) } },
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
  if (!/\.xmind$/i.test(doc.fileName)) throw new Error("暂不支持该文件格式");
  const original = db.getConversationDocumentFile(id);
  if (original) return { name: doc.fileName, bytes: original };
  const mind = JSON.parse(doc.content) as MindDocument;
  if (mind.format !== "xmind") throw new Error("导图内容无效");
  return { name: doc.fileName, mind };
}
function flatten(node: DocumentNode, depth = 0): string[] { return [`${"  ".repeat(depth)}- ${node.title}${node.notes ? `（备注：${node.notes}）` : ""}`, ...node.children.flatMap((child) => flatten(child, depth + 1))]; }
function countImageDescriptions(mind: MindDocument): number { const count = (node: DocumentNode): number => (node.imageDescription ? 1 : 0) + node.children.reduce((sum, child) => sum + count(child), 0); return mind.sheets.reduce((sum, root) => sum + count(root), 0); }
function decodeText(bytes: Buffer) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("文件不是有效的 UTF-8 文本，不能安全读取或修改"); }
}
function xmindTopic(item: DocumentNode): any { return { id: randomUUID(), class: "topic", title: item.title, ...(item.notes ? { notes: { plain: { content: item.notes } } } : {}), children: { attached: item.children.map(xmindTopic) } }; }
export async function executeChatDocumentTool(db: AppDatabase, conversationId: string, name: string, raw: string, planPresentation?: (mind: MindDocument, images: MindImage[]) => Promise<AiPresentation>, operationId?: string, visualReview?: (plan: AiPresentation, images: MindImage[]) => Promise<{ plan: AiPresentation; summary: string }>): Promise<ChatDocResult> {
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
      const uploads = db.listConversationDocuments(conversationId).filter((item) => /\.(xmind|txt|md|markdown|csv|json)$/i.test(item.fileName)).map((item) => ({ id: item.id, name: item.fileName, source: "上传" }));
      return { ok: true, summary: JSON.stringify({ files, uploads }) };
    }
    if (name === "doc_search") {
      const { fileId, query, charOffset, limit } = args as z.infer<typeof schemas.doc_search>;
      const file = source(db, conversationId, fileId);
      if (!file.bytes || !/\.(md|markdown|txt|csv|json)$/i.test(file.name)) throw new Error("当前仅支持搜索 UTF-8 文本、Markdown、CSV 和 JSON");
      const text = decodeText(file.bytes);
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
      if (!mind && !/\.(md|markdown|txt|csv|json)$/i.test(file.name)) throw new Error("当前不支持读取该格式");
      const sha256 = file.bytes ? createHash("sha256").update(file.bytes).digest("hex") : undefined;
      const text = !mind ? decodeText(file.bytes!) : "";
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
      const { fileId, expectedSha256, edits } = args as z.infer<typeof schemas.doc_edit>;
      const file = source(db, conversationId, fileId);
      if (!file.bytes || !/\.(md|markdown|txt|csv|json)$/i.test(file.name)) throw new Error("当前仅支持修改 UTF-8 文本、Markdown、CSV 和 JSON");
      if (createHash("sha256").update(file.bytes).digest("hex") !== expectedSha256.toLowerCase()) throw new Error("文件版本已变化，请重新读取后再修改");
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
      } else { if (a.content === undefined) throw new Error("生成文本文件需要 content"); if (a.kind === "json") JSON.parse(a.content); bytes = Buffer.from((a.kind === "csv" ? "\uFEFF" : "") + a.content, "utf8"); }
      const saved = save(db, conversationId, a.name, a.kind, bytes, operationId);
      return { ok: true, summary: `已创建 ${saved.name}，文件可下载。`, data: { fileId: saved.id, fileName: saved.name, byteSize: saved.byteSize } };
    }
    const a = args as z.infer<typeof schemas.doc_convert>; const file = source(db, conversationId, a.fileId);
    const mind = file.mind ?? (file.bytes && /\.xmind$/i.test(file.name) ? await parseXmind(file.bytes) : null);
    if (!mind) throw new Error("当前只支持 XMind 转 PPTX");
    if (!planPresentation) throw new Error("AI 幻灯片规划不可用，请检查对话模型后重试；没有生成文件。");
    const extracted = file.bytes ? await extractMindImages(file.bytes, mind) : { images: [], skipped: 0 };
    let presentation = paginatePresentation(await planPresentation(mind, extracted.images));
    if (presentation.slides.length + extracted.images.length > 200) throw new Error("包含图片的 PPT 超过 200 页，请分章节转换；没有生成文件。");
    const inserted = new Map<number, typeof presentation.slides>();
    extracted.images.forEach((image, imageIndex) => {
      const index = presentation.slides.findIndex((slide) => slide.sourceIds?.some((id) => id.startsWith(`${image.sourceId}.`) || id.startsWith(`${image.sourceId}-image.`)));
      const target = presentation.slides[index];
      if (target && ["content", "columns", "keypoint"].includes(target.layout) && target.lines.length <= 4 && target.imageIndex === undefined) {
        presentation.slides[index] = { ...target, layout: "illustrated", imageIndex }; return;
      }
      const after = index < 0 ? presentation.slides.length - 1 : index;
      const group = inserted.get(after) ?? [];
      group.push({ layout: "image", title: image.title.slice(0, 70), subtitle: "", lines: [], notes: `原导图主题图片：${image.title}`, imageIndex }); inserted.set(after, group);
    });
    presentation.slides = presentation.slides.flatMap((slide, index) => [slide, ...(inserted.get(index) ?? [])]);
    const visual = visualReview ? await visualReview(presentation, extracted.images) : { plan: presentation, summary: "未启用视觉检查" };
    presentation = visual.plan;
    const bytes = await renderAiPresentation(presentation, extracted.images);
    await checkPresentation(bytes, presentation);
    const saved = save(db, conversationId, file.name.replace(/\.xmind$/i, ""), "pptx", bytes, operationId);
    return { ok: true, summary: `AI 已整理导图，生成 ${saved.name}，共 ${presentation.slides.length} 页；来源文字和关联关系保存在演讲备注中。已提取 ${extracted.images.length} 张主题图片并放在相关内容附近${extracted.skipped ? `，${extracted.skipped} 张未能导入` : ""}；其中 ${countImageDescriptions(mind)} 张已由视觉模型观察，观察可能有误。${visual.summary}。原布局没有还原，请核对内容。${!file.bytes ? " 该旧附件未保存原文件，无法提取图片，请重新上传。" : ""}${mind.warnings.length ? ` ${mind.warnings.join(" ")}` : ""}`, data: { fileId: saved.id, fileName: saved.name, byteSize: saved.byteSize } };
  } catch (error) { return { ok: false, summary: error instanceof Error ? error.message : "文档操作失败" }; }
}
