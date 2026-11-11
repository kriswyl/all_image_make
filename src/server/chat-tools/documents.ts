import { PresentationPaused } from "../presentation-execution.js";
import path from "node:path";
import JSZip from "jszip";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import type { AppDatabase } from "../db.js";
import { parseXmind, type DocumentNode } from "../mind-document.js";
import { markdownToDocx } from "./markdown.js";
import { readDocxText } from "./word-document.js";
import { createXlsx, readXlsx } from "./spreadsheet-document.js";
import { readPdfPage } from "./pdf-document.js";
import { readPresentationProject, readPresentationStyle } from "../presentation-project.js";
import { PublishPending } from "../document-publish.js";
import { schemas, normalizeDocInput, type DocumentEditArgs, type DocumentConvertArgs } from "./document-tool-schema.js";
import { documentSource, readWorkspaceFile, resolveDocumentId, saveWorkspaceDocument } from "./document-workspace.js";
import { finalDocumentResult, type ChatDocResult } from "./document-result.js";
import { convertPresentationDocument, editPresentationDocument, type ExecuteDocumentOptions, type PlanPresentation, type ReviewPresentation } from "./document-presentation.js";
import { decodeText, editTextDocument } from "./document-text.js";
import { editWordDocument, editSpreadsheetDocument } from "./document-office-edit.js";

export { CHAT_DOCUMENT_TOOLS } from "./document-tool-schema.js";
export { readWorkspaceFile, saveWorkspaceDocument, type ContractCheckContext } from "./document-workspace.js";
export { documentStatusOf, type ChatDocResult, type DocumentStatus, type PendingVisualCheck } from "./document-result.js";
export type { VisualReviewOutcome, ExecuteDocumentOptions } from "./document-presentation.js";

function flatten(node: DocumentNode, depth = 0): string[] { return [`${"  ".repeat(depth)}- ${node.title}${node.notes ? `（备注：${node.notes}）` : ""}`, ...node.children.flatMap((child) => flatten(child, depth + 1))]; }
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
function xmindTopic(item: DocumentNode): any { return { id: randomUUID(), class: "topic", title: item.title, ...(item.notes ? { notes: { plain: { content: item.notes } } } : {}), children: { attached: item.children.map(xmindTopic) } }; }
export async function executeChatDocumentTool(
  db: AppDatabase,
  conversationId: string,
  name: string,
  raw: string,
  planPresentation?: PlanPresentation,
  operationId?: string,
  visualReview?: ReviewPresentation,
  options?: ExecuteDocumentOptions,
): Promise<ChatDocResult> {
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
      const file = documentSource(db, conversationId, fileId);
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
      const file = documentSource(db, conversationId, fileId);
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
      const editArgs = args as DocumentEditArgs;
      const { fileId, expectedSha256, edits, styles, paragraphs, tables, cells, matchRows, pages, appendSlides, imageAssetIds, order, design } = editArgs;
      const resolvedFileId = resolveDocumentId(db, conversationId, fileId);
      const parentDocument = db.getWorkspaceDocument(conversationId, resolvedFileId);
      const lineage = parentDocument ? { familyId: parentDocument.familyId, parentId: parentDocument.id } : undefined;
      const file = documentSource(db, conversationId, fileId);
      if (!file.bytes) throw new Error("文件原文不可用");
      if (!/\.(md|markdown|txt|csv|json|pptx|docx|xlsx)$/i.test(file.name)) throw new Error("当前仅支持修改文本、Word、Excel 及 ChatCanvas 生成的 PPT");
      const currentSha256 = createHash("sha256").update(file.bytes).digest("hex");
      if (currentSha256 !== expectedSha256.toLowerCase()) throw new Error(`文件版本已变化，请重新读取后再修改（当前 SHA-256：${currentSha256}）`);
      const office = /\.(docx|xlsx)$/i.exec(file.name)?.[1]?.toLowerCase();
      if (office) {
        if (pages || appendSlides || imageAssetIds || order || design) throw new Error("Word/Excel 不接受 PPT 页面参数");
        const edited = office === "docx"
          ? await editWordDocument(file.bytes, { edits, styles, paragraphs, tables, cells, matchRows })
          : await editSpreadsheetDocument(file.bytes, { edits, cells, matchRows }, listId => {
            const list = documentSource(db, conversationId, listId);
            if (!list.bytes || !/\.xlsx$/i.test(list.name)) throw new Error("ID 清单需要是当前会话的 Excel (.xlsx) 文件");
            return list.bytes;
          });
        const { bytes, summary } = edited;
        if (!bytes) return { ok: true, summary };
        const base = file.name.replace(/^(?:\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z-(?:\d+-)?)+/, "").replace(/(?:-修改版)*\.(docx|xlsx)$/i, "");
        const saved = saveWorkspaceDocument(db, conversationId, `${base}-修改版`, office, bytes, operationId, undefined, lineage ?? { familyId: `attachment:${resolvedFileId}` });
        const sha256 = createHash("sha256").update(readWorkspaceFile(db, conversationId, saved.id).bytes).digest("hex");
        return finalDocumentResult(saved, { headline: `${summary}另存为 ${saved.name}，原文件保留`, sha256 });
      }
      if (cells || matchRows) throw new Error("cells 和 matchRows 仅适用于 Excel 文件");
      if (/\.pptx$/i.test(file.name)) {
        return await editPresentationDocument(db, conversationId, { name: file.name, bytes: file.bytes }, {
          args: editArgs, resolvedFileId, lineage, operationId, visualReview,
        });
      }
      if (!/\.(md|markdown|txt|csv|json)$/i.test(file.name)) throw new Error("当前仅支持修改文本类文件及 ChatCanvas 生成的 PPT");
      if (!edits || pages || appendSlides || imageAssetIds || order || design) throw new Error("文本文件请提供 edits 精确替换列表");
      const ext = path.extname(file.name).slice(1).toLowerCase();
      const bytes = editTextDocument(file.bytes, edits, ext);
      const saved = saveWorkspaceDocument(db, conversationId, file.name.replace(/\.[^.]+$/, "") + "-修改版", ext, bytes, operationId, undefined, lineage);
      db.pruneWorkspaceFamily(conversationId, parentDocument?.familyId ?? saved.familyId, 3);
      return finalDocumentResult(saved, { headline: `已完成 ${edits.length} 处精确修改，生成新文件 ${saved.name}；原文件已保留` });
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
      return finalDocumentResult(saved, { headline: `已创建 ${saved.name}，文件可下载` });
    }
    return await convertPresentationDocument(db, conversationId, args as DocumentConvertArgs, {
      planPresentation, operationId, visualReview, specRef: options?.specRef,
    });
  } catch (error) {
    if (error instanceof PresentationPaused) throw error;
    if (error instanceof PublishPending) {
      // 等待不是失败：execution 记为 paused，并检查队列随后发布同一候选。
      return {
        ok: false, paused: true,
        summary: `候选已产出，正在等待视觉检查：${error.message}。检查完成后会自动发布同一候选，无需重新生成。`,
        pendingVisualCheck: { candidateId: error.candidateId, operationId: error.operationId },
      };
    }
    return { ok: false, summary: error instanceof Error ? error.message : "文档操作失败" };
  }
}
