import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import request from "supertest";
import { expect, it, vi } from "vitest";
vi.mock("../src/server/wps-auto-render", () => ({ renderWithLocalWps: async () => { throw new Error("测试环境未启用 WPS"); } }));
import { createApp } from "../src/server/app";
import { executeChatDocumentTool } from "../src/server/chat-tools/documents";

it.each([
  { pause: false, cover: false },
  { pause: true, cover: false },
  { pause: true, cover: true },
])("普通聊天从 XMind 生成 PPT（暂停 $pause，生成封面并重启 $cover）", async ({ pause, cover }) => {
  let reviewCalls = 0; let hitBudget = false; let readingCalls = 0; let structuredSubmissions = 0; let fileId = ""; let ordinaryCalls = 0; let plannerInput = "";
  const coverBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  let imageRequests = 0;
  let finishImageRequest: (() => void) | undefined;
  let coverAssetId: string | undefined;
  const mock = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on("data", (chunk) => chunks.push(Buffer.from(chunk))); req.on("end", () => {
      if (req.url === "/v1/images/generations") {
        imageRequests++;
        finishImageRequest = () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ b64_json: coverBytes.toString("base64") }] }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const planning = String(body.messages?.[0]?.content).includes("演示文稿策划");
      let message: unknown;
      let promptTokens = 100;
      const vision = String(body.messages?.[0]?.content).includes("描述图片中可见的内容");
      if (vision) message = { content: "图片是一张物流流程图" };
      else if (String(body.messages?.[0]?.content).includes("阅读分析员")) {
        readingCalls++;
        const items = JSON.parse(body.messages[1].content.split("素材（JSON 数据）：\n")[1]);
        message = { content: JSON.stringify({ summary: "物流和关联", keyFacts: ["FBA 与自发货"], conditions: [], sourceIds: items.map((item: any) => item.id) }) };
      }
      else if (String(body.messages?.[0]?.content).includes("演示文稿总策划")) {
        const overview = JSON.parse(body.messages[1].content.split("导图批次目录（仅供全局策划，JSON 数据）：\n")[1]);
        message = { content: JSON.stringify({ title: "运营培训", audience: "新手", objective: "理解物流", narrative: "先认识再选择", sections: [{ title: "物流", goal: "理解方式", batchIds: overview.map((item: any) => item.batchId) }] }) };
      }
      else if (String(body.messages?.[0]?.content).includes("页面策划员")) {
        const data = JSON.parse(body.messages[1].content);
        message = { content: JSON.stringify({ pages: [{ title: "物流方式如何选择", goal: "保留所有来源并解释物流", sourceIds: data.sources.map((item: any) => item.id) }] }) };
      }
      else if (planning) {
        if (String(body.messages[0].content).includes("内容审校员")) {
          reviewCalls++;
          if (pause && !hitBudget) { promptTokens = 200_000; hitBudget = true; }
          message = { content: JSON.stringify({ issues: [] }) };
        }
        else {
          plannerInput += JSON.stringify(body.messages);
          const items = JSON.parse(body.messages[1].content.split("素材（JSON 数据）：\n")[1]);
          message = { content: JSON.stringify({ title: "运营培训", theme: "blue", slides: [
          { layout: "content", title: "物流方式如何选择", subtitle: "", lines: [], notes: "两种方式各有流程", sourceIds: items.map((item: any) => item.id), elements: [
            { id: "title", type: "text", x: 0.8, y: 0.5, w: 11.5, h: 0.8, text: "物流方式如何选择", style: { fontSize: 28, bold: true } },
            { id: "body", type: "text", x: 0.8, y: 2, w: 5.3, h: 2, text: "根据业务选择平台仓储或自行发货" },
            { id: "source-image", type: "image", x: 6.5, y: 2, w: 5.5, h: 4, imageIndex: 0 },
          ] },
          ] }) };
        }
      } else if (++ordinaryCalls <= 2 && cover) {
        const imageCall = { id: "make-cover", type: "function", function: { name: "generate_image", arguments: JSON.stringify({ prompt: "物流培训封面，抽象线条与纸箱插画", fromScratch: true }) } };
        const premature = { id: "premature", type: "function", function: { name: "doc_convert", arguments: JSON.stringify({ fileId, to: "pptx" }) } };
        message = { tool_calls: ordinaryCalls === 1 ? [{ ...imageCall, id: "batched-image" }, premature] : [imageCall] };
      } else if (ordinaryCalls === (cover ? 3 : 1)) {
        if (cover) {
          const generated = body.messages.find((item: { tool_call_id?: string }) => item.tool_call_id === "make-cover");
          coverAssetId = JSON.parse(generated.content).assetIds[0];
        }
        message = { tool_calls: [{ id: "convert-1", type: "function", function: { name: "doc_convert", arguments: JSON.stringify({ fileId, to: "pptx", coverAssetId }) } }] };
      }
      else message = { content: "已根据内容生成 PPT。" };
      if (body.tools?.[0]?.function.name === "submit_presentation_result" && (message as any).content) {
        structuredSubmissions++; expect(body.tool_choice).toEqual({ type: "function", function: { name: "submit_presentation_result" } });
        const submission = { id: "structured", type: "function", function: { name: "submit_presentation_result", arguments: (message as any).content } };
        message = { content: "", tool_calls: pause ? [submission, { ...submission, id: "duplicate" }] : [submission] };
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 100 } }));
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address(); if (!address || typeof address === "string") throw new Error("mock");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-ai-ppt-")); let { app, context } = createApp({ dataDir: dir });
  try {
    await request(app).post("/api/channels").send({ name: "Brain", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat", authType: "none", authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions", models: ["mock"], allowPrivateNetwork: true, enabled: true }).expect(201);
    const id = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id;
    await request(app).patch(`/api/conversations/${id}`).send({ visionEnabled: true, ...(cover ? { toolScope: "all" } : { chatMode: "chat" }) }).expect(200);
    if (cover) await request(app).post("/api/channels").send({ name: "Images", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-images", authType: "none", authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations", models: ["mock-image"], allowPrivateNetwork: true, enabled: true }).expect(201);
    const zip = new JSZip(); zip.file("content.json", JSON.stringify([{ rootTopic: { id: "root", title: "店铺运营", children: { attached: [{ id: "logistics", title: "物流", image: { src: "xap:resources/test.png" }, notes: { plain: { content: "FBA 与自发货" } } }, ...(pause ? Array.from({ length: 273 }, (_, i) => ({ id: `topic-${i}`, title: `运营案例 ${i + 1}` })) : [])] } }, relationships: [{ end1Id: "root", end2Id: "logistics", title: "支持" }] }]));
    zip.file("resources/test.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aV8AAAAASUVORK5CYII=", "base64"));
    const uploaded = (await request(app).post(`/api/conversations/${id}/mind-documents`).attach("file", await zip.generateAsync({ type: "nodebuffer" }), "test.xmind").expect(201)).body.data;
    fileId = uploaded.messages.flatMap((message: any) => message.documents).at(-1).id;
    await request(app).post(`/api/conversations/${id}/messages`).send({ text: `面向新手重点讲物流，把导图转成PPT${cover ? "，先生成一张物流插画并用作封面" : ""}` }).expect(202);
    if (cover) {
      await vi.waitFor(() => expect(context.db.getConversation(id)?.status).toBe("awaiting_confirmation"));
      expect(imageRequests).toBe(0);
      const premature = context.db.listMessages(id).find(row => row.role === "tool" && row.toolName === "doc_convert");
      expect(premature?.toolResult).toMatchObject({ ok: false, summary: expect.stringContaining("取得素材后") });
      expect(readingCalls).toBe(0);
      const confirmation = context.db.listPendingMessages(id).find(row => row.confirm)!;
      await request(app).post(`/api/conversations/${id}/confirm`).send({ messageId: confirmation.id, decision: "approve" }).expect(200);
      await vi.waitFor(() => {
        expect(finishImageRequest).toBeDefined();
        expect(context.db.getConversation(id)?.status).toBe("waiting_task");
      });
      const imageTask = context.db.listPendingMessages(id).find(row => row.taskId)!;
      // Simulate losing the process after the task result has committed but before the Agent can consume it.
      context.agent.dispose();
      finishImageRequest!();
      await vi.waitFor(() => expect(context.db.getTaskView(imageTask.taskId!)?.status).toBe("succeeded"));
      context.db.close();
      ({ app, context } = createApp({ dataDir: dir }));
      context.agent.recoverStaleConversations();
    }
    async function waitForResults(count: number) {
      for (let n = 0; n < 150; n++) {
        const view = (await request(app).get(`/api/conversations/${id}`)).body.data;
        if (view.status === "idle" && view.messages.filter((m: any) => m.role === "tool" && m.toolName === "doc_convert").length >= count + Number(cover)) return view;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      throw new Error("PPT 转换未在测试时限内结束");
    }
    let view = await waitForResults(1);
    if (pause) {
      const paused = view.messages.findLast((m: any) => m.role === "tool" && m.toolName === "doc_convert");
      expect(paused.toolResult.data.presentationPaused).toBe(true);
      expect(paused.content).toMatch(/已达到 PPT 用量上限.*已通过内容审校 1\//);
      expect(ordinaryCalls).toBe(cover ? 3 : 1);
      expect(reviewCalls).toBe(1);
      const savedReadings = readingCalls;
      const savedRun = context.db.getPresentationResume(id)!;
      if (cover) expect(JSON.parse(savedRun.args).coverAssetId).toBe(coverAssetId);
      expect(savedRun.tokens).toBeGreaterThanOrEqual(200_000);
      context.agent.dispose();
      context.db.close();
      ({ app, context } = createApp({ dataDir: dir }));
      await request(app).post(`/api/conversations/${id}/messages`).send({ text: "继续 PPT" }).expect(202);
      view = await waitForResults(2);
      expect(ordinaryCalls).toBe(cover ? 3 : 1);
      expect(readingCalls).toBe(savedReadings);
      expect(plannerInput.match(/当前批次：1\//g)).toHaveLength(1);
      expect(context.db.getPresentationResume(id)).toBeNull();
      expect(context.db.getWorkspaceDocumentByOperation(id, savedRun.operationId)).not.toBeNull();
    }
    expect(structuredSubmissions).toBeGreaterThanOrEqual(4);
    expect(plannerInput).toContain("面向新手重点讲物流"); expect(plannerInput).toContain("FBA 与自发货");
    expect(plannerInput).toContain("店铺运营 ↔ 物流（支持）");
    expect(plannerInput).toContain("图片是一张物流流程图");
    const row = view.messages.findLast((message: any) => message.role === "tool" && message.toolName === "doc_convert");
    expect(row.toolResult.ok).toBe(true);
    const callRow = view.messages.findLast((message: any) => message.role === "assistant" && message.toolName === "doc_convert");
    expect(callRow.toolArgs).toMatchObject({ fileId, to: "pptx" });
    const output = context.db.getWorkspaceDocument(id, row.toolResult.data.workspaceFileId)!;
    const archive = await JSZip.loadAsync(await fs.readFile(path.join(dir, "documents", id, output.name)));
    expect(await archive.file("ppt/slides/slide2.xml")!.async("string")).toContain("物流方式如何选择");
    expect(await archive.file("ppt/slides/slide2.xml")!.async("string")).toContain("<p:pic>");
    if (cover) {
      expect(imageRequests).toBe(1);
      expect(coverAssetId).toBeTruthy();
      expect(callRow.toolArgs.coverAssetId).toBe(coverAssetId);
      const slide = await archive.file("ppt/slides/slide1.xml")!.async("string");
      expect(slide).toContain("运营培训");
      const embed = /<a:blip\b[^>]*r:embed="(rId\d+)"/.exec(slide)?.[1];
      expect(embed).toBeTruthy();
      const relationships = await archive.file("ppt/slides/_rels/slide1.xml.rels")!.async("string");
      const target = relationships.match(/<Relationship\b[^>]+>/g)?.find(entry => entry.includes(`Id="${embed}"`))?.match(/Target="([^"]+)"/)?.[1];
      expect(target).toBeTruthy();
      const embedded = await archive.file(path.posix.normalize(path.posix.join("ppt/slides", target!)))!.async("nodebuffer");
      expect(embedded.equals(coverBytes)).toBe(true);
      expect(await archive.file("ppt/notesSlides/notesSlide1.xml")!.async("string")).toContain(coverAssetId);
      const other = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id;
      const source = await executeChatDocumentTool(context.db, other, "doc_create", JSON.stringify({ kind: "md", name: "另一份资料", content: "# 另一份资料" }));
      const planner = vi.fn();
      const rejected = await executeChatDocumentTool(context.db, other, "doc_convert", JSON.stringify({ fileId: source.data!.fileId, to: "pptx", coverAssetId }), planner);
      expect(rejected.ok).toBe(false);
      expect(rejected.summary).toContain("封面素材必须是本会话内的图片");
      expect(planner).not.toHaveBeenCalled();
    }
    expect(Object.keys(archive.files).some((name) => name.startsWith("ppt/media/"))).toBe(true);
    const slideCount = Object.keys(archive.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length;
    if (pause) expect(slideCount).toBeGreaterThan(10);
    else expect(slideCount).toBe(3);
    expect(archive.file("chatcanvas/presentation.json")).not.toBeNull();
  } finally { context.agent.dispose(); context.db.close(); await fs.rm(dir, { recursive: true, force: true }); await new Promise<void>((resolve) => { mock.close(() => resolve()); mock.closeAllConnections(); }); }
}, 20000);
