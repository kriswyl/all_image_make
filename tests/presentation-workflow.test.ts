import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { Jimp } from "jimp";
import { createApp } from "../src/server/app";
import { executeChatDocumentTool, readWorkspaceFile } from "../src/server/chat-tools/documents";
import { markdownToMind } from "../src/server/chat-tools/markdown";
import { renderAiPresentation } from "../src/server/mind-document";
import { checkPresentation } from "../src/server/presentation-check";
import { PresentationPaused, presentationEngine } from "../src/server/presentation-execution";
import { layoutIssues } from "../src/server/presentation-elements";
import { readPresentationProject } from "../src/server/presentation-project";
import { renderContentSlide, renderTemplateCover, slideContentSchema, validSlideContent, type SlideContent } from "../src/server/presentation-templates";
import { runTemplatePresentation, templatePageCount } from "../src/server/presentation-workflow";
import { decodeWorkflowJson, readProviderOutputCap, recoverWorkflowItems } from "../src/server/structured-workflow";
const { renderWps } = vi.hoisted(() => ({ renderWps: vi.fn(async (..._args: unknown[]): Promise<Buffer[]> => { throw new Error("本机 WPS 渲染服务未启动"); }) }));
vi.mock("../src/server/wps-auto-render", () => ({ renderWithLocalWps: renderWps }));

const chapters = [
  ["账户安全", "开启双重验证，保留恢复码"],
  ["商品选择", "销量需要和退货率一起观察"],
  ["供应链", "确认最小起订量和交期"],
  ["商品发布", "标题要反映规格和适用范围"],
  ["物流仓储", "补货周期须包含入库时间"],
  ["成本测算", "毛利要扣除履约费和退货成本"],
  ["广告投放", "以点击和转化分别诊断广告"],
  ["库存管理", "库龄超过阈值时优先处理滞销品"],
  ["售后服务", "记录退货原因并反馈选品"],
  ["复盘决策", "明确下次复盘时间和负责人"],
] as const;
const preamble = "示例只用于培训，不代表实际平台政策";
const markdown = ["# 店铺运营培训", preamble, ...chapters.flatMap(([title, point]) => [`## ${title}`, `- ${point}`])].join("\n");
const mind = markdownToMind(markdown, "运营手册");
it("每章一页是分配规则，不覆盖本轮明确的总页数", () => {
  expect(presentationEngine(null, "")).toBe("template");
  expect(presentationEngine({}, "template")).toBe("legacy");
  expect(presentationEngine({engine:"template"},"legacy")).toBe("template");
  expect(templatePageCount("整理为11页培训PPT，每个模块独立一页",6)).toBe(11);
  expect(templatePageCount("做成12页，每个章节2页",6)).toBe(12);
});
it.each([false,true])("内容问题只修受影响页，修补预算中断=%s 时保留交付和原问题", async budget => {
  const cache=new Map<string,string>();
  let audits=0;
  const corrections:number[]=[];
  const call:Parameters<typeof runTemplatePresentation>[1]=async messages=>{
    const instruction=String(messages[0]?.content),input=JSON.parse(String(messages[1]?.content));
    if(instruction.includes("总策划"))return{content:JSON.stringify(outline(input.catalog)),truncated:false};
    if(instruction.includes("审校员"))return{content:JSON.stringify({issues:++audits===1?[{page:4,detail:"删除无来源的唯一责任限制"}]:[]}),truncated:false};
    if(input.pages.some((p:any)=>p.correction)) {
      corrections.push(...input.pages.map((p:any)=>p.page));
      if(budget)throw new PresentationPaused("修补预算耗尽");
    }
    return{content:JSON.stringify({pages:input.pages.map((item:PageInput & {correction?:string[]})=>({
      ...page(item),...(item.page===4&&!item.correction?{notes:"本岗位是唯一负责人"}:{notes:"按原文核对"}),
    }))}),truncated:false};
  };
  const result=await runTemplatePresentation(mind,call,{request:"做成11页",scope:"repair-test",images:[],get:key=>cache.get(key)??null,set:(key,value)=>{cache.set(key,value);}});
  expect(result.plan?.slides).toHaveLength(11);
  expect(result.template.resume).toBe(false);
  expect(corrections).toEqual([4]);
  if(budget){expect(result.template.audit).toBe("partial");expect(result.template.issues).toHaveLength(1);}
  else {expect(result.template.repairedPages).toEqual([4]);expect(result.template.issues).toEqual([]);expect(audits).toBe(2);}
});
type Catalog = { id: number; chapter: string; sample: string };
type PageInput = { page: number; title: string; source: Array<{ id: string; text: string }> };
const outline = (catalog: Catalog[]) => ({
  title: "店铺运营培训",
  audience: "新手",
  objective: "掌握从开店到运营复盘的关键决策",
  pages: catalog.map((item, index) => ({ title: chapters[index]![0], goal: chapters[index]![1], batchIds: [item.id] })),
});
const page = (input: PageInput): SlideContent => {
  const point = chapters.find(chapter => chapter[0] === input.title)![1];
  return { page: input.page, title: input.title, layout: "bullets", bullets: [point], notes: "结合本章案例讲解" };
};

it("解析修复只改语法，截断结果只接收闭合的页面", () => {
  expect(decodeWorkflowJson('{text: "保留, ]、{word: 与 \\"引号\\"",}')).toEqual({ text: '保留, ]、{word: 与 "引号"' });
  expect(recoverWorkflowItems('{"pages":[{"page":2,"title":"引号 \\" ] }"}, {"page":3', "pages")).toEqual([{ page: 2, title: '引号 " ] }' }]);
  expect(decodeWorkflowJson('先说明 {meta: 1}。结果如下：{"issues": []}，完成。', value => Array.isArray((value as { issues?: unknown }).issues))).toEqual({ issues: [] });
  expect(recoverWorkflowItems('结果如下：{pages:[{"page":2,"title":"例"}, {"page":3', "pages")).toEqual([{ page: 2, title: "例" }]);
  expect(readProviderOutputCap("max_tokens must be less than or equal to 4,096", 8192)).toBe(4096);
  expect(readProviderOutputCap("maximum context length is 4096 tokens", 8192)).toBeUndefined();
  expect(templatePageCount("参考原文第 3 页，做成 10 页 PPT", 11)).toBe(10);
  expect(templatePageCount("参考原文第三页，把它做成五页 PPT", 11, 14)).toBe(5);
  expect(templatePageCount("源文件有 18 页，把它做成 PPT", 8)).toBe(8);
  expect(templatePageCount("控制在 10 页以内", 6)).toBe(6);
  expect(templatePageCount("做成 201 到 250 页", 15)).toBe(200);
  expect(templatePageCount("生成 1000 页", 15)).toBe(200);
  expect(templatePageCount("做一份幻灯片", 11, 1)).toBe(1);
  expect(validSlideContent({ page: 1, title: "账户安全", layout: "bullets", bullets: ["账户安全。"] }, [])).toBe(false);
});

it("模板页剥离附加字段，深色背景下封面和卡片使用高对比文字", async () => {
  const design = { background: "101820", text: "101820", accent: "B9E5F1" };
  const groups = [{ title: "准备", items: ["备齐资料"], sourceIds: ["fake"] }, { title: "执行", items: ["记录结果"] }];
  const parsed = slideContentSchema.parse({ page: 2, title: "运行手册", layout: "cards", groups, sourceIds: ["fake"], layoutHint: "cards" });
  expect(parsed).not.toHaveProperty("sourceIds");
  expect(parsed.groups?.[0]).not.toHaveProperty("sourceIds");
  const cover = renderTemplateCover("深色主题", "", design);
  const body = renderContentSlide(parsed, design, ["real"], "来源原文").slide;
  expect(cover.elements).toContainEqual(expect.objectContaining({ id: "cover-title", style: expect.objectContaining({ color: "FFFFFF" }) }));
  expect(body.elements?.find(element => element.id === "panel-0")).not.toMatchObject({ fill: design.background });
  expect(body.elements).toContainEqual(expect.objectContaining({ id: "heading-0", style: expect.objectContaining({ color: "FFFFFF" }) }));
});

it("固定十章资料的预算暂停导出准确页数，续做只请求未保存页和审校", async () => {
  const cache = new Map<string, string>();
  const options = { request: "请做成 11 页 PPT", scope: "fixture", images: [],
    get: (key: string) => cache.get(key) ?? null, set: (key: string, value: string) => cache.set(key, value) };
  const requested: number[][] = [];
  let planningCalls = 0, auditCalls = 0, paused = true;
  const call: Parameters<typeof runTemplatePresentation>[1] = async (messages) => {
    const input = JSON.parse(String(messages[1]!.content));
    const instruction = String(messages[0]!.content);
    if (instruction.includes("总策划")) {
      planningCalls++;
      return { content: JSON.stringify(outline(input.catalog)), truncated: false };
    }
    if (instruction.includes("审校员")) {
      auditCalls++;
      return { content: JSON.stringify({ issues: [] }), truncated: false };
    }
    const pages = input.pages as PageInput[];
    if (paused && requested.length) throw new PresentationPaused("固定测试预算耗尽");
    requested.push(pages.map(item => item.page));
    return { content: JSON.stringify({ pages: pages.map(page) }), truncated: false };
  };
  const draft = await runTemplatePresentation(mind, call, options);
  expect(draft.plan?.slides).toHaveLength(11);
  expect(draft.template).toMatchObject({ draft: true, audit: "unavailable", pendingPages: [5, 6, 7, 8, 9, 10, 11] });
  expect(draft.plan?.slides[4]?.elements).toContainEqual(expect.objectContaining({ id: "page-status", text: "待补全" }));
  await checkPresentation(await renderAiPresentation(draft.plan!), draft.plan!);

  paused = false;
  const result = await runTemplatePresentation(mind, call, options);
  expect(result.template).toMatchObject({ draft: false, resume: false, audit: "complete", overflowPages: [] });
  expect(result.plan?.slides).toHaveLength(11);
  expect(planningCalls).toBe(1);
  expect(auditCalls).toBe(1);
  expect(requested).toHaveLength(4);
  expect(requested.flat()).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  expect(result.plan?.slides[1]?.notes).toContain(preamble);
  for (const [index, [title, point]] of chapters.entries()) {
    const slide = result.plan!.slides[index + 1]!;
    expect(slide.title).toBe(title);
    expect(slide.elements).toContainEqual(expect.objectContaining({ type: "text", text: point }));
    expect(slide.notes).toContain(point);
    expect(layoutIssues(slide.elements!)).toEqual([]);
  }
  await checkPresentation(await renderAiPresentation(result.plan!), result.plan!);
});

it("只要一页时，指定图片和正文共用该页，Markdown 长行和前言保存在备注", async () => {
  const long = "需要保留的完整原文。".repeat(62) + "长行结尾不能丢";
  const source = markdownToMind(`# 示例\n${preamble}\n## 运作\n${long}`, "示例");
  const result = await runTemplatePresentation(source, async messages => {
    const instruction = String(messages[0]?.content);
    const input = JSON.parse(String(messages[1]?.content));
    if (instruction.includes("总策划")) return { content: JSON.stringify({
      title: "示例", audience: "新手", objective: "说明运作规则",
      pages: [{ title: "运作规则", goal: "了解限制", batchIds: input.catalog.map((item: Catalog) => item.id) }],
    }), truncated: false };
    if (instruction.includes("审校员")) return { content: '{"issues":[]}', truncated: false };
    return { content: JSON.stringify({ pages: [{ page: 1, title: "运作规则", layout: "bullets", bullets: ["确认限制并执行"] }] }), truncated: false };
  }, { request: "做成 1 页", hasCover: true, images: [], scope: "single", get: () => null, set: () => undefined });
  expect(result.plan?.slides).toHaveLength(1);
  const only = result.plan!.slides[0]!;
  expect(only.elements).toContainEqual(expect.objectContaining({ type: "image", imageIndex: 0 }));
  expect(only.elements).toContainEqual(expect.objectContaining({ type: "text", text: "确认限制并执行" }));
  expect(only.notes).toContain(preamble);
  expect(only.notes).toContain(long);
});

it("七种正文版式及封面输出原生元素，长内容移到备注且不会增加页数", async () => {
  const groups = [{ title: "确认需求", items: ["记录需求与限制"] }, { title: "安排执行", items: ["确认责任人"] }];
  const image = { title: "参考图", data: "image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };
  const full = "这一条详细说明包含了需要保留的真实约束和例外情况".repeat(9);
  const variants: Array<Omit<SlideContent, "page" | "title">> = [
    { layout: "bullets", bullets: [full, full, full, full, full, full] },
    { layout: "cards", groups },
    { layout: "process", groups },
    { layout: "comparison", groups },
    { layout: "table", table: [["阶段", "任务"], ["执行", "核对资源"]] },
    { layout: "chart", chart: { type: "bar", categories: ["周一", "周二"], series: [{ name: "订单量", values: [12, 15] }] } },
    { layout: "image", bullets: ["参考图例"], imageIndex: 0 },
  ];
  const design = { accent: "336699", fontFace: "Microsoft YaHei" };
  const slides = [renderTemplateCover("店铺运营培训", "掌握工作步骤", design, 0), ...variants.map((variant, index) =>
    renderContentSlide({ page: index + 2, title: "运营任务", ...variant }, design, ["s1.1"], "来源原文").slide)];
  expect(slides[1]?.notes).toContain(full);
  expect(slides.flatMap(slide => layoutIssues(slide.elements!))).toEqual([]);
  const plan = { title: "运营任务", theme: "blue" as const, design, slides };
  await checkPresentation(await renderAiPresentation(plan, [image]), plan);
});

it("聊天原生工具展示可下载的精简草稿，重启并切回旧开关后仍按原引擎续做", async () => {
  vi.stubEnv("CHATCANVAS_PPT_ENGINE", undefined);
  const calls: number[][] = [];
  let ordinaryCalls = 0, resume = false, fileId: string;
  const mock = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const instruction = String(body.messages[0]?.content);
      let message: object;
      let finishReason = "stop";
      if (body.tools?.[0]?.function?.name === "submit_presentation_result") {
        const input = JSON.parse(body.messages[1].content);
        let content: string;
        if (instruction.includes("总策划")) content = JSON.stringify(outline(input.catalog));
        else if (instruction.includes("审校员")) content = resume ? '{"issues":[]}' : '{"issues":';
        else {
          const pages = input.pages as PageInput[];
          calls.push(pages.map(item => item.page));
          if (!resume && pages[0]?.page === 2) {
            content = `{"pages":[${JSON.stringify(page(pages[0]))}, {"page":3`;
            finishReason = "length";
          } else content = JSON.stringify({ pages: pages.filter(item => resume || ![3, 5, 6].includes(item.page)).map(page) });
        }
        message = { tool_calls: [{ id: "submit", type: "function", function: { name: "submit_presentation_result", arguments: content } }] };
      } else {
        ordinaryCalls++;
        message = { tool_calls: [{ id: "convert", type: "function", function: { name: "doc_convert", arguments: JSON.stringify({ fileId, to: "pptx", pageCount: 11 }) } }] };
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        choices: [{ message, finish_reason: finishReason }], usage: { prompt_tokens: 100, completion_tokens: 100 },
      }));
    });
  });
  await new Promise<void>(resolve => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address();
  if (!address || typeof address === "string") throw new Error("mock");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "template-ppt-"));
  let { app, context } = createApp({ dataDir: dir });
  try {
    await request(app).post("/api/channels").send({ name: "Mock", baseUrl: `http://127.0.0.1:${address.port}`,
      adapterType: "openai-chat", authType: "none", authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
      models: ["mock"], allowPrivateNetwork: true, enabled: true }).expect(201);
    const id = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id;
    await request(app).patch(`/api/conversations/${id}`).send({ chatMode: "chat" }).expect(200);
    const original = await executeChatDocumentTool(context.db, id, "doc_create", JSON.stringify({ kind: "md", name: "运营手册", content: markdown }));
    fileId = original.data!.fileId;
    await request(app).post(`/api/conversations/${id}/messages`).send({ text: "把运营资料做成 11 页 PPT" }).expect(202);
    const outputs = () => context.db.listMessages(id).filter(row => row.role === "tool" && row.toolName === "doc_convert");
    await vi.waitFor(() => expect(outputs()).toHaveLength(1), { timeout: 6000 });
    const draft = outputs()[0]!.toolResult!;
    expect(draft.summary).toContain("未审校");
    expect(draft.data).toMatchObject({ presentationPaused: true, presentation: { draft: true, fallbackPages: [3, 5, 6], audit: "unavailable" } });
    const draftFile = readWorkspaceFile(context.db, id, String(draft.data!.workspaceFileId));
    expect((await readPresentationProject(draftFile.bytes))?.plan.slides).toHaveLength(11);
    expect(calls.filter(batch => batch.includes(2))).toHaveLength(1);
    expect(ordinaryCalls).toBe(1);
    await vi.waitFor(() => expect(context.db.getConversation(id)?.status).toBe("idle"));
    context.agent.dispose();
    context.db.close();
    vi.stubEnv("CHATCANVAS_PPT_ENGINE", "legacy");
    ({ app, context } = createApp({ dataDir: dir }));
    calls.length = 0;
    resume = true;
    await request(app).post(`/api/conversations/${id}/messages`).send({ text: "继续 PPT" }).expect(202);
    await vi.waitFor(() => expect(outputs()).toHaveLength(2), { timeout: 6000 });
    const final = outputs()[1]!.toolResult!;
    expect(final.data).toMatchObject({ presentation: { draft: false, fallbackPages: [], audit: "complete" } });
    expect(final.data!.workspaceFileId).not.toBe(draft.data!.workspaceFileId);
    expect(calls.flat()).toEqual([3, 5, 6]);
    expect(ordinaryCalls).toBe(1);
    expect(context.db.getPresentationResume(id)).toBeNull();
  } finally {
    context.agent.dispose();
    context.db.close();
    mock.close();
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it("单页精简正常交付，按版本补做和补审，后台 WPS 只更新各自报告", async () => {
  vi.stubEnv("CHATCANVAS_PPT_ENGINE", "template");
  const blank = await new Jimp({ width: 64, height: 36, color: 0x223344ff }).getBuffer("image/png");
  let releaseWps!: () => void;
  const wpsGate = new Promise<void>(resolve => { releaseWps = resolve; });
  renderWps.mockImplementationOnce(async () => {
    await wpsGate;
    return Array<Buffer>(11).fill(blank);
  });
  let ordinary = 0, repairCalls = 0, fileId: string, supplement = false;
  const pageRequests: Array<{ pages: number[]; cap: number }> = [];
  const mock = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const instruction = String(body.messages[0]?.content);
      let message: object;
      let finish_reason = "stop";
      if (body.tools?.[0]?.function?.name === "submit_presentation_result") {
        const input = JSON.parse(body.messages[1].content);
        let output: string;
        if (instruction.includes("总策划")) output = `说明 {extra: true}，结果：${JSON.stringify(outline(input.catalog))}`;
        else if (instruction.includes("审校员")) output = supplement ? '{"issues":[{"page":3,"detail":"核对销量观察口径"}]}' : '{"issues":';
        else if (instruction.includes("补做指定")) {
          repairCalls++;
          expect(input.page).toBe(3);
          expect(input.source).toContain(chapters[1][1]);
          output = JSON.stringify({ page: 3, title: chapters[1][0], layout: "bullets", bullets: [chapters[1][1]], sourceIds: ["forged"] });
        } else {
          const pages = input.pages as PageInput[];
          pageRequests.push({ pages: pages.map(item => item.page), cap: body.max_tokens });
          const valid = pages.filter(item => item.page !== 3).map(item => ({ ...page(item), layoutHint: "bullets" }));
          if (pages.some(item => item.page === 2)) {
            output = `结果如下：{"pages":[${valid.map(item => JSON.stringify(item)).join(",")}, {"page":3`;
            finish_reason = "length";
          } else output = JSON.stringify({ pages: valid });
        }
        message = { tool_calls: [{ id: "submit", type: "function", function: { name: "submit_presentation_result", arguments: output } }] };
      } else {
        ordinary++;
        message = ordinary === 2 ? { tool_calls: [{ id: "convert", type: "function", function: { name: "doc_convert",
          arguments: JSON.stringify({ fileId, to: "pptx", pageCount: 5, pageCountEvidence: "旧方案做成五页" }) } }] } : { content: "已收到。" };
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message, finish_reason }],
        usage: { prompt_tokens: 100, completion_tokens: 100 } }));
    });
  });
  await new Promise<void>(resolve => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address();
  if (!address || typeof address === "string") throw new Error("mock");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "template-ppt-versions-"));
  const { app, context } = createApp({ dataDir: dir });
  try {
    await request(app).post("/api/channels").send({ name: "Mock", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat",
      authType: "none", authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions", models: ["mock"], allowPrivateNetwork: true, enabled: true }).expect(201);
    const id = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id;
    await request(app).patch(`/api/conversations/${id}`).send({ chatMode: "chat" }).expect(200);
    const source = await executeChatDocumentTool(context.db, id, "doc_create", JSON.stringify({ kind: "md", name: "运营手册", content: markdown }));
    fileId = source.data!.fileId;
    const send = (text: string) => request(app).post(`/api/conversations/${id}/messages`).send({ text }).expect(202);
    await send("旧方案做成五页");
    await vi.waitFor(() => expect(context.db.getConversation(id)?.status).toBe("idle"));
    await send("参考原文第 3 页，重新把整份资料做成 PPT");
    const output = () => context.db.listMessages(id).find(row => row.role === "tool" && row.toolName === "doc_convert")?.toolResult;
    await vi.waitFor(() => expect(output()?.data?.workspaceFileId).toBeTypeOf("string"), { timeout: 6000 });
    const original = String(output()!.data!.workspaceFileId);
    const route = (target: string) => `/api/conversations/${id}/documents/files/${target}/presentation-status`;
    expect(output()?.data).toMatchObject({ presentation: { fallbackPages: [3], draft: false, resume: false, audit: "unavailable" } });
    expect(output()?.data?.presentationPaused).toBeUndefined();
    expect(pageRequests.filter(item => item.pages.includes(3))).toEqual([{ pages: [2, 3, 4], cap: 8192 }, { pages: [3], cap: 16_384 }]);
    const originalFile = readWorkspaceFile(context.db, id, original);
    const originalProject = (await readPresentationProject(originalFile.bytes))!;
    expect(originalProject.plan.slides).toHaveLength(11);
    const status = (await request(app).get(route(original)).expect(200)).body.data;
    expect(status.visual.status).toBe("running");
    await vi.waitFor(() => expect(context.db.getConversation(id)?.status).toBe("idle"));
    await request(app).post(route(original)).send({ kind: "page", page: 3, sha256: "0".repeat(64) }).expect(409);
    expect(repairCalls).toBe(0);
    const revision = (await request(app).post(route(original)).send({ kind: "page", page: 3, sha256: status.sha256 }).expect(200)).body.data.fileId;
    expect(revision).not.toBe(original);
    expect(repairCalls).toBe(1);
    expect((await request(app).post(route(original)).send({ kind: "page", page: 3, sha256: status.sha256 }).expect(200)).body.data.fileId).toBe(revision);
    expect(repairCalls).toBe(1);
    const changed = (await readPresentationProject(readWorkspaceFile(context.db, id, revision).bytes))!;
    expect(changed.plan.slides[2]?.elements).toContainEqual(expect.objectContaining({ type: "text", text: chapters[1][1] }));
    expect(changed.plan.slides[2]?.sourceIds).toEqual(originalProject.plan.slides[2]?.sourceIds);
    expect(changed.plan.slides.filter((_, index) => index !== 2)).toEqual(originalProject.plan.slides.filter((_, index) => index !== 2));
    expect(readWorkspaceFile(context.db, id, original).bytes).toEqual(originalFile.bytes);
    releaseWps();
    await vi.waitFor(() => expect(context.db.getPresentationVersion(id, original)?.visual).toMatchObject({ status: "checked", issues: expect.arrayContaining([expect.objectContaining({ page: 1 })]) }));
    await vi.waitFor(() => expect(context.db.getPresentationVersion(id, revision)?.visual.status).toBe("unavailable"));
    supplement = true;
    const fresh = context.db.getPresentationVersion(id, revision)!;
    await request(app).post(route(revision)).send({ kind: "audit", sha256: fresh.sha256 }).expect(200);
    expect(context.db.getPresentationVersion(id, revision)).toMatchObject({ sha256: fresh.sha256, report: { fallbackPages: [], audit: "complete" } });
    expect(context.db.getPresentationVersion(id, original)?.report.audit).toBe("unavailable");
  } finally {
    releaseWps();
    context.agent.dispose();
    context.db.close();
    mock.close();
    vi.unstubAllEnvs();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
