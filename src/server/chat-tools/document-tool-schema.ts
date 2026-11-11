import { z } from "zod";
import { aiPresentationSchema, type DocumentNode } from "../mind-document.js";
import type { BrainToolSpec } from "../brain.js";
import { cellEditSchema, matchRowsSchema, sheetSchema } from "./spreadsheet-document.js";
import { designSchema, ELEMENT_DESIGN_GUIDE } from "../presentation-elements.js";
import { slideContentSchema } from "../presentation-templates.js";

const nodeSchema: z.ZodType<DocumentNode> = z.lazy(() => z.object({ title: z.string().trim().min(1).max(2000), notes: z.string().max(10000).default(""), children: z.array(nodeSchema).max(500).default([]) }));
export const schemas = {
  doc_list: z.object({}),
  doc_delete: z.object({ fileId: z.string().min(1) }),
  doc_read: z.object({ fileId: z.string().min(1), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(500).default(100), charOffset: z.number().int().min(0).optional(), charLimit: z.number().int().min(1).max(20000).default(12000), sheetName: z.string().min(1).max(31).optional(), range: z.string().min(1).max(25).optional(), page: z.number().int().min(1).max(1000).optional() }),
  doc_search: z.object({ fileId: z.string().min(1), query: z.string().min(1).max(500), charOffset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(50).default(20) }),
  doc_create: z.object({ kind: z.enum(["md", "txt", "csv", "json", "xmind", "docx", "xlsx"]), name: z.string().trim().min(1).max(120), content: z.string().max(2_000_000).optional(), nodes: nodeSchema.optional(), sheets: z.array(sheetSchema).min(1).max(20).optional() }),
  doc_edit: z.object({ fileId: z.string().min(1), expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i), edits: z.array(z.object({ find: z.string().min(1).max(20000), replace: z.string().max(100000) })).min(1).max(20).optional(),
    /** Word 字符样式：只改命中文字的 run，不动段落与其它文字 */
    styles: z.array(z.object({
      find: z.string().min(1).max(2000),
      bold: z.boolean().optional(), italic: z.boolean().optional(), underline: z.boolean().optional(),
      color: z.string().regex(/^[0-9a-f]{6}$/i).optional(),
      fontSize: z.number().min(1).max(200).optional(),
    }).strict().refine(value => [value.bold, value.italic, value.underline, value.color, value.fontSize].filter(item => item !== undefined).length > 0, "每处样式至少要给 bold / italic / underline / color / fontSize 之一")).min(1).max(20).optional(),
    /** Word 表格：行列从 1 开始。改单元格文字，或增删行列（每条只能一种） */
    tables: z.array(z.object({
      find: z.string().min(1).max(500),
      cells: z.array(z.object({ row: z.number().int().min(1).max(100), col: z.number().int().min(1).max(20), text: z.string().max(2000) }).strict()).min(1).max(200).optional(),
      insertRows: z.object({ at: z.number().int().min(1).max(101), count: z.number().int().min(1).max(10) }).strict().optional(),
      deleteRows: z.object({ at: z.number().int().min(1).max(100), count: z.number().int().min(1).max(10) }).strict().optional(),
      insertCols: z.object({ at: z.number().int().min(1).max(21), count: z.number().int().min(1).max(10) }).strict().optional(),
      deleteCols: z.object({ at: z.number().int().min(1).max(20), count: z.number().int().min(1).max(10) }).strict().optional(),
    }).strict().refine(value => [value.cells, value.insertRows, value.deleteRows, value.insertCols, value.deleteCols].filter(Boolean).length === 1, "每条表格修改一次只能做一件事：cells，或一种增删行列")).min(1).max(10).optional(),
    /** Word 段落样式：只改命中段落的 pPr，不动文字与字符样式 */
    paragraphs: z.array(z.object({
      find: z.string().min(1).max(2000),
      align: z.enum(["left", "center", "right", "justify"]).optional(),
      lineSpacing: z.number().min(0.5).max(5).optional(),
      spaceBefore: z.number().min(0).max(500).optional(),
      spaceAfter: z.number().min(0).max(500).optional(),
      firstLineChars: z.number().min(0).max(20).optional(),
      indentLeft: z.number().min(0).max(500).optional(),
    }).strict().refine(value => [value.align, value.lineSpacing, value.spaceBefore, value.spaceAfter, value.firstLineChars, value.indentLeft].filter(item => item !== undefined).length > 0, "每处段落样式至少要给 align / lineSpacing / spaceBefore / spaceAfter / firstLineChars / indentLeft 之一")).min(1).max(20).optional(), cells: z.array(cellEditSchema).min(1).max(500).optional(), matchRows: matchRowsSchema.optional(), pages: z.array(z.object({
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
      /** 表格：行列从 1 开始。改文字，或增删行列（一次只能一种） */
      table: z.object({
        cells: z.array(z.object({ row: z.number().int().min(1).max(50), col: z.number().int().min(1).max(30), text: z.string().max(1000) }).strict()).min(1).max(60).optional(),
        insertRows: z.object({ at: z.number().int().min(1).max(31), count: z.number().int().min(1).max(10) }).strict().optional(),
        deleteRows: z.object({ at: z.number().int().min(1).max(30), count: z.number().int().min(1).max(10) }).strict().optional(),
        insertCols: z.object({ at: z.number().int().min(1).max(21), count: z.number().int().min(1).max(10) }).strict().optional(),
        deleteCols: z.object({ at: z.number().int().min(1).max(20), count: z.number().int().min(1).max(10) }).strict().optional(),
      }).strict().refine(value => [value.cells, value.insertRows, value.deleteRows, value.insertCols, value.deleteCols].filter(Boolean).length === 1, "table 一次只能给 cells 或一种增删行列操作").optional(),
    }).strict().refine(value => value.text !== undefined || value.fontSize !== undefined || value.color !== undefined || value.rect !== undefined || value.imageAssetId !== undefined || value.chart !== undefined || value.table !== undefined, "每个 objects 项至少要给 text、fontSize、color、rect、imageAssetId、chart 或 table 之一")).min(1).max(20).optional() }),
  doc_convert: z.object({ fileId: z.string().min(1), to: z.literal("pptx"), referenceFileId: z.string().min(1).optional(), coverAssetId: z.uuid().optional(),
    pageImages: z.array(z.object({ page: z.number().int().min(1).max(200), assetId: z.uuid() }).strict()).min(1).max(8).optional(),
    pageCount: z.number().int().min(1).max(200).optional(), pageCountEvidence: z.string().trim().min(1).max(140).optional(), design: designSchema.optional(),
    // D2：style 可以是主题 id（blue/magazine/mono/warm），也可以是一句风格描述（如「杂志风」）。
    style: z.string().trim().min(1).max(40).optional() }),
};
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });

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
export function normalizeDocInput(name: string, input: unknown): unknown {
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
  { type: "function", function: { name: "doc_edit", description: `先用 doc_read 获取文件的 SHA-256，或者直接使用上次 doc_edit 返回的同一新文件 ID 和 SHA-256。文本和 Word 用 edits 精确替换，每个 find 须唯一；改 Word 的字号/颜色/加粗用 styles:[{find,bold?,italic?,underline?,color?,fontSize?}]（落到包含该文字的 run）；改对齐/行距/段前后/缩进用 paragraphs:[{find,align?:left|center|right|justify,lineSpacing?:倍数,spaceBefore?:磅,spaceAfter?:磅,firstLineChars?:字符数,indentLeft?:磅}]（落到命中段落的 pPr）；两者可同时用，但都不要与 edits 同一次提交；改 Word 表格用 tables:[{find,cells?:[{row,col,text}],insertRows?:{at,count},deleteRows?:{at,count},insertCols?:{at,count},deleteCols?:{at,count}}]（find 是能唯一定位到那张表的表格内文字；行列从 1 开始，每条只能做一种操作，需单独提交；含合并单元格或嵌套表的表格会拒绝，增删列时总宽度保持不变）。Word 仅限段落内普通正文与表格，整篇重写用 doc_create。Excel 用 cells:[{sheet,address,value}] 修改指定单元格，null 清空。按 ID 批量处理用 matchRows，提供目标 sheet、column 和 ids（字符串，保留前导零）或 list（同会话 XLSX 的 fileId、sheet、column）；两边默认从第 2 行到末行，可指定 startRow/endRow。标红填 fontColor="FF0000"，默认只改 ID 字体；用户明确要整行时指定 colorColumns:{from,to}。只有用户要求写标记时才传 marker，默认使用「标记」表头和数值 1。直接用文件 ID 引用清单，无需逐格读出或转抄。PDF 只读。ChatCanvas 生成的 PPT 用 pages:[{page:从1开始,content:声明式内容}] 修改指定页——content 只填 layout 与该版式需要的字段（bullets 3–6 条；groups 用于 cards/comparison/process；table 等列表格；chart 给真实数字；kpi 给 metrics:[{label,value,note?}] 2–4 个；timeline 给 steps:[{title,detail?}] 3–6 个；quote 给 quote:{text,source?}），**不要填坐标、字号或颜色**，渲染器会按整稿主题排版。只有必须原样保留某个已有页面的自定义元素时才用 slide:完整新页面（这会绕过主题，尽量不用）。appendSlides 添加页面，order 调整顺序，design 修改主题。只想改某个已有对象的文字、字号、颜色、位置、配图或图表数据时用 objects:[{slide,elementId,text?,fontSize?,color?,rect?,imageAssetId?,chart?:{categories?,series?:[{name?,values}]},table?:{cells?:[{row,col,text}],insertRows?:{at,count},deleteRows?:{at,count},insertCols?:{at,count},deleteCols?:{at,count}}}]（文字沿用原字号与颜色，\n 分段；单位 pt / 6 位十六进制 / 英寸；imageAssetId 取本会话已有图片）：它只改这一个对象，其余页面和部件保持原样；objects 不能与 pages、appendSlides、order、design、imageAssetIds 同时使用。换图只支持图片对象；改图表只支持已有图表，且不能增删系列或分类（数据个数必须与分类数一致），会同时更新显示数据与内嵌数据表，工作簿结构异常时明确提示同步失败；改表格用 table.cells 指到具体行列（从 1 开始）换文字，或用 insertRows/deleteRows/insertCols/deleteCols 增删行列（at 从 1 开始，count 1–10，一次只能一种操作；行列各上限 30/20，含合并单元格的表格会拒绝）。图标、连线是复合对象，会明确拒绝。原文件不覆盖。现有图片索引取 doc_read 的 images。要把本会话生成或上传的图片放入页面，填 imageAssetIds（真实素材 ID）；这些图片按列表顺序接在原 images 之后，imageIndex 从原 images 的长度开始。外部 PPT 仅支持风格参考。${ELEMENT_DESIGN_GUIDE}`, parameters: z.toJSONSchema(schemas.doc_edit) as Record<string, unknown> } },
  { type: "function", function: { name: "presentation_spec_update", description: "记录本次 PPT 任务的明确要求（页数、必需保留的内容、风格），可只保存不生成。用户说「先不定，等下开始」「必须保留三个案例」「换成杂志风」或明确页数时调用。只传业务意图，不填写证据、文件哈希或引擎参数；服务端从当前用户消息回读原文校验。prepareOnly=true 表示只保存要求，不触发生成。", parameters: objectSchema({ intent: { type: "string", enum: ["create", "update", "fork"] }, specId: { type: "string" }, prepareOnly: { type: "boolean" }, pageCountText: { type: "string", maxLength: 200 }, requiredContent: { type: "array", items: { type: "string", maxLength: 500 }, maxItems: 20 }, styleText: { type: "string", maxLength: 500 } }, ["intent"]) } },
  { type: "function", function: { name: "doc_convert", description: "直接使用原上传的XMind、Markdown、文本或CSV策划并生成原生可编辑PPT；to 只能填 pptx。封面图片用 coverAssetId，正文配图用 pageImages:[{page,assetId}]，从第1页开始计数，封面计入。根据用户指定页或内容顺序分配图片，只填写本会话已有或生图成功返回的真实素材 ID。用户本轮明确要求总页数时填写 pageCount 和本轮逐字原话 pageCountEvidence；参考资料和历史任务的页数不算。转换失败后告知用户，禁止自行换源、创建替代骨架或反复调用。referenceFileId 引用本会话PPT的颜色字体；design 指定 background/text/accent（6位十六进制无#）及 fontFace；用户提到整体风格（如「杂志风」「极简」「暖色教学」）时填 style：magazine / mono / warm / blue，只想改单页颜色仍用 design。", parameters: z.toJSONSchema(schemas.doc_convert) } },
];

export type DocumentEditArgs = z.infer<typeof schemas.doc_edit>;
export type DocumentConvertArgs = z.infer<typeof schemas.doc_convert>;
