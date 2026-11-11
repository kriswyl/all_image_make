import { createHash } from "node:crypto";
import type { AppDatabase } from "../db.js";
import { aiPresentationSchema, extractMindImages, parseXmind, renderAiPresentation, type AiPresentation, type DocumentNode, type MindDocument, type MindImage } from "../mind-document.js";
import { checkPresentation, paginatePresentation } from "../presentation-check.js";
import { markdownToMind } from "./markdown.js";
import { resolveElements, type PresentationDesign } from "../presentation-elements.js";
import { readPresentationProject, packPresentationProject, readPresentationStyle } from "../presentation-project.js";
import { isImageAsset } from "../../shared/types.js";
import { prepareImageBytes, REFERENCE_PROFILE } from "../vision.js";
import type { TemplatePresentation } from "../presentation-workflow.js";
import type { TemplateReport, VisualReviewMetrics } from "../../shared/presentation-report.js";
import { placePresentationImages, renderContentSlide, validSlideContent } from "../presentation-templates.js";
import { patchPresentationObjects } from "../presentation-object-patch.js";
import { carryDeckReport } from "../presentation-deck-carry.js";
import { getTheme } from "../../shared/presentation-theme.js";
import { type SpecBinding } from "../presentation-contract-resolution.js";
import { deriveChangeScope, resolveCheckSets } from "../../shared/change-scope.js";
import type { DocumentEditArgs, DocumentConvertArgs } from "./document-tool-schema.js";
import { documentSource, readWorkspaceFile, saveWorkspaceDocument } from "./document-workspace.js";
import { finalDocumentResult, type ChatDocResult } from "./document-result.js";
import { decodeText } from "./document-text.js";

/** 视觉阶段的真实结论：complete 才允许在 before_publish 下直接交付，不能只传一句 summary。 */
export type VisualReviewOutcome = {
  plan: AiPresentation;
  summary: string;
  metrics?: VisualReviewMetrics;
  status?: "complete" | "partial" | "unavailable";
  blocking?: string[];
  checkedPages?: number[];
};
export type ExecuteDocumentOptions = {
  /** 本次执行绑定的契约版本；legacy 生成入口也要显式带上，不靠保存时重新猜。 */
  specRef?: SpecBinding;
};
export type PlanPresentation = (mind: MindDocument, images: MindImage[], design?: PresentationDesign, sourceFingerprint?: string, coverAssetId?: string, pageCount?: number, pageCountEvidence?: string, style?: string) => Promise<AiPresentation | TemplatePresentation>;
export type ReviewPresentation = (plan: AiPresentation, images: Array<{ title: string; data: string }>, pageNumbers?: number[]) => Promise<VisualReviewOutcome>;

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

/**
 * 把视觉阶段的真实结论转成发布层可接受的证据。
 * 没有结论时不伪造 status：before_publish 会进入等待，由后台检查完成后发布同一候选。
 */
function publishVisualEvidence(visual?: VisualReviewOutcome) {
  if (!visual?.status) return undefined;
  if (visual.status === "complete" && !visual.blocking?.length) return { status: "complete" as const, blocking: [] as string[] };
  return {
    status: visual.status === "unavailable" ? "unavailable" as const : "running" as const,
    blocking: visual.blocking ?? [],
  };
}

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

async function readPptImage(db: AppDatabase, conversationId: string, id: string, label = "PPT 配图") {
  const asset = db.listConversationAssets(conversationId).find(entry => entry.asset.id === id)?.asset;
  if (!asset || !isImageAsset(asset)) throw new Error(`${label}素材必须是本会话内的图片，请从生成结果或附件中选择`);
  const maxBytes = 4 * 1024 * 1024;
  const image = await prepareImageBytes(db, asset, { ...REFERENCE_PROFILE, maxBytes });
  if (!image || image.mimeType === "image/webp" || image.bytes.length > maxBytes) throw new Error("图片读取失败，请选择 4 MB 内的 PNG 或 JPEG");
  return image;
}

function countImageDescriptions(mind: MindDocument): number { const count = (node: DocumentNode): number => (node.imageDescription ? 1 : 0) + node.children.reduce((sum, child) => sum + count(child), 0); return mind.sheets.reduce((sum, root) => sum + count(root), 0); }

export async function editPresentationDocument(
  db: AppDatabase,
  conversationId: string,
  file: { name: string; bytes: Buffer },
  input: {
    args: DocumentEditArgs;
    resolvedFileId: string;
    lineage?: { familyId: string; parentId: string };
    operationId?: string;
    visualReview?: ReviewPresentation;
  },
): Promise<ChatDocResult> {
  const { args, resolvedFileId, lineage, operationId, visualReview } = input;
  const { edits, pages, appendSlides, imageAssetIds, order, design, objects } = args;
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
        ...(object.table !== undefined ? { table: object.table } : {}),
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
    db.pruneWorkspaceFamily(conversationId, lineage?.familyId ?? saved.familyId, 3);
    const sha256 = createHash("sha256").update(readWorkspaceFile(db, conversationId, saved.id).bytes).digest("hex");
    const ops = patched.report.applied.flatMap(item => item.operations).length;
    const warnings = patched.report.warnings.length
      ? ` 注意：${patched.report.warnings.slice(0, 2).map(item => `第 ${item.slide} 页 ${item.elementId}：${item.detail}`).join("；")}` : "";
    return finalDocumentResult(saved, {
      headline: `已原位修改 ${patched.report.applied.length} 个对象（${ops} 项属性），只改第 ${[...new Set(patched.report.applied.map(item => item.slide))].join("、")} 页，其余页面和部件保持原样；新版本 ${saved.name}，原文件保留`,
      details: warnings, sha256,
    });
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
      ...(publishVisualEvidence(visual) ? { visualReview: publishVisualEvidence(visual) } : {}),
    });
  db.pruneWorkspaceFamily(conversationId, lineage?.familyId ?? saved.familyId, 3);
  const sha256 = createHash("sha256").update(readWorkspaceFile(db, conversationId, saved.id).bytes).digest("hex");
  return finalDocumentResult(saved, {
    headline: `已生成可继续编辑的新版本 ${saved.name}，共 ${plan.slides.length} 页；原文件保留`,
    details: `${visual.summary}${trimmedPages.length ? ` 第 ${trimmedPages.join("、")} 页内容超出容量已压缩（原文在备注），建议改写更短或拆页。` : ""}`,
    sha256,
  });
}

export async function convertPresentationDocument(
  db: AppDatabase,
  conversationId: string,
  a: DocumentConvertArgs,
  options: ExecuteDocumentOptions & { planPresentation?: PlanPresentation; operationId?: string; visualReview?: ReviewPresentation },
): Promise<ChatDocResult> {
  const { planPresentation, operationId, visualReview } = options;
  const file = documentSource(db, conversationId, a.fileId);
  const mind = file.mind
    ?? (file.bytes && /\.xmind$/i.test(file.name) ? await parseXmind(file.bytes) : null)
    ?? (file.bytes && /\.(md|markdown|txt|csv)$/i.test(file.name) ? markdownToMind(decodeText(file.bytes), file.name.replace(/\.[^.]+$/, "")) : null);
  if (!mind) throw new Error("当前支持 XMind、Markdown、文本与 CSV 转 PPTX");
  if (!planPresentation) throw new Error("AI 幻灯片规划不可用，请检查对话模型后重试；没有生成文件。");
  // 只有 xmind 是 zip、才有主题图片；Markdown 来源没有可提取的图片
  const extracted = file.bytes && /\.xmind$/i.test(file.name) ? await extractMindImages(file.bytes, mind) : { images: [], skipped: 0 };
  let reference: PresentationDesign | undefined;
  let referenceHash = "";
  if (a.referenceFileId) {
    const ref = documentSource(db, conversationId, a.referenceFileId);
    if (!ref.bytes || !/\.pptx$/i.test(ref.name)) throw new Error("风格参考必须是本会话的 PPTX 文件");
    referenceHash = createHash("sha256").update(ref.bytes).digest("hex");
    reference = (await readPresentationStyle(ref.bytes)).design;
  }
  const design = a.design || reference ? { ...reference, ...a.design } : undefined;
  const fingerprint = createHash("sha256").update(file.bytes ?? JSON.stringify(mind)).update(referenceHash);
  let cover: { title: string; data: string } | undefined;
  let coverSha256: string | undefined;
  if (a.coverAssetId) {
    const image = await readPptImage(db, conversationId, a.coverAssetId, "封面");
    cover = { title: "封面图片", data: `${image.mimeType};base64,${image.bytes.toString("base64")}` };
    coverSha256 = createHash("sha256").update(image.bytes).digest("hex");
    fingerprint.update("\0cover\0").update(a.coverAssetId).update(image.bytes);
  }
  const pageAssets: Array<{ title: string; data: string }> = [];
  const mapped = a.pageImages ?? [];
  if (new Set(mapped.map(item => `${item.page}:${item.assetId}`)).size !== mapped.length) throw new Error("同一页不能重复放入同一张配图");
  /** assetId → 图片目录索引 + 该图片字节的哈希，供契约门禁核对身份而不仅是数量。 */
  const indexes = new Map<string, { imageIndex: number; sha256: string }>();
  for (const { assetId } of mapped) {
    if (indexes.has(assetId)) continue;
    const image = await readPptImage(db, conversationId, assetId);
    indexes.set(assetId, {
      imageIndex: extracted.images.length + Number(Boolean(cover)) + pageAssets.length,
      sha256: createHash("sha256").update(image.bytes).digest("hex"),
    });
    pageAssets.push({ title: `会话素材 ${assetId}`, data: `${image.mimeType};base64,${image.bytes.toString("base64")}` });
    fingerprint.update("\0page-image\0").update(assetId).update(image.bytes);
  }
  if (mapped.length) fingerprint.update(JSON.stringify(mapped));
  const placements = mapped.map(({ page, assetId }) => ({ page, imageIndex: indexes.get(assetId)!.imageIndex }));
  const assetBindings = [
    // 封面素材也必须有身份绑定，否则「指定封面图」无法与页面上的图片对上。
    ...(a.coverAssetId && coverSha256
      ? [{ assetId: a.coverAssetId, imageIndex: extracted.images.length, sha256: coverSha256, cover: true as const }]
      : []),
    ...[...indexes.entries()].map(([assetId, bound]) => ({ assetId, imageIndex: bound.imageIndex, sha256: bound.sha256 })),
  ];
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
    // 内容审校的逐项结论在这里按「候选哈希 + Spec revision + 要求 ID」绑定，文件一变即失效。
    const verdicts = template.requirementVerifications?.map(item => ({ ...item, verifiedBy: "content-audit" as const }));
    const saved = saveWorkspaceDocument(db, conversationId, template.draft ? `草稿-${base}` : base, "pptx", bytes, snapshot, template, runFamily ? { familyId: runFamily } : undefined,
      {
        plan,
        ...(template.specRef ? { specRef: template.specRef } : {}),
        ...(assetBindings.length ? { assetBindings } : {}),
        ...(verdicts?.length ? { requirementVerifications: verdicts } : {}),
      });
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
    const details = `${summary}${cover ? "指定封面图已嵌入。" : ""}${imageSummary}${extracted.images.length ? `已观察 ${countImageDescriptions(mind)}/${extracted.images.length} 张原图的内容。` : ""}${extracted.skipped ? `有 ${extracted.skipped} 张源文件图片未能提取。` : ""}`;
    return finalDocumentResult(saved, {
      headline: `${headline}，共 ${plan.slides.length} 页`,
      details, paused,
      uiData: { ...uiData, presentation: finalReport },
    });
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
  const saved = saveWorkspaceDocument(db, conversationId, file.name.replace(/\.[^.]+$/, ""), "pptx", bytes, operationId, undefined, undefined, {
    plan: presentation,
    ...(options.specRef ? { specRef: options.specRef } : {}),
    ...(assetBindings.length ? { assetBindings } : {}),
    ...(publishVisualEvidence(visual) ? { visualReview: publishVisualEvidence(visual) } : {}),
  });
  const details = `${cover ? "指定图片已嵌入封面。" : ""}${imageSummary}来源文字和关联关系保存在演讲备注中。已提取 ${extracted.images.length} 张主题图片并放在相关内容附近${extracted.skipped ? `，${extracted.skipped} 张未能导入` : ""}；其中 ${countImageDescriptions(mind)} 张已由视觉模型观察，观察可能有误。${visual.summary}。原布局没有还原，请核对内容。${!file.bytes ? " 该旧附件未保存原文件，无法提取图片，请重新上传。" : ""}${mind.warnings.length ? ` ${mind.warnings.join(" ")}` : ""}`;
  return finalDocumentResult(saved, {
    headline: `AI 已整理导图，生成 ${saved.name}，共 ${presentation.slides.length} 页`,
    details,
  });
}
