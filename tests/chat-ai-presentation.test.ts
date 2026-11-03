import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import request from "supertest";
import { expect, it, vi } from "vitest";
vi.mock("../src/server/wps-auto-render", () => ({ renderWithLocalWps: async () => { throw new Error("测试环境未启用 WPS"); } }));
import { createApp } from "../src/server/app";

it("普通聊天的 XMind 转换会先让模型理解导图，再根据方案输出 PPT", async () => {
  let fileId = ""; let ordinaryCalls = 0; let plannerInput = "";
  const mock = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on("data", (chunk) => chunks.push(Buffer.from(chunk))); req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const planning = String(body.messages?.[0]?.content).includes("演示文稿策划");
      let message: unknown;
      const vision = String(body.messages?.[0]?.content).includes("描述图片中可见的内容");
      if (vision) message = { content: "图片是一张物流流程图" };
      else if (String(body.messages?.[0]?.content).includes("阅读分析员")) {
        const items = JSON.parse(body.messages[1].content.split("素材（JSON 数据）：\n")[1]);
        message = { content: JSON.stringify({ summary: "物流和关联", keyFacts: ["FBA 与自发货"], conditions: [], sourceIds: items.map((item: any) => item.id) }) };
      }
      else if (String(body.messages?.[0]?.content).includes("演示文稿总策划")) {
        const overview = JSON.parse(body.messages[1].content.split("导图批次目录（仅供全局策划，JSON 数据）：\n")[1]);
        message = { content: JSON.stringify({ title: "运营培训", audience: "新手", objective: "理解物流", narrative: "先认识再选择", sections: [{ title: "物流", goal: "理解方式", batchIds: overview.map((item: any) => item.batchId) }] }) };
      }
      else if (planning) {
        if (String(body.messages[0].content).includes("内容审校员")) message = { content: JSON.stringify({ issues: [] }) };
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
      } else if (++ordinaryCalls === 1) message = { content: "", tool_calls: [{ id: "convert-1", type: "function", function: { name: "doc_convert", arguments: JSON.stringify({ fileId, to: "pptx" }) } }] };
      else message = { content: "已根据内容生成 PPT。" };
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address(); if (!address || typeof address === "string") throw new Error("mock");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-ai-ppt-")); const { app, context } = createApp({ dataDir: dir });
  try {
    await request(app).post("/api/channels").send({ name: "Brain", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat", authType: "none", authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions", models: ["mock"], allowPrivateNetwork: true, enabled: true }).expect(201);
    const id = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id;
    await request(app).patch(`/api/conversations/${id}`).send({ chatMode: "chat", visionEnabled: true }).expect(200);
    const zip = new JSZip(); zip.file("content.json", JSON.stringify([{ rootTopic: { id: "root", title: "店铺运营", children: { attached: [{ id: "logistics", title: "物流", image: { src: "xap:resources/test.png" }, notes: { plain: { content: "FBA 与自发货" } } }] } }, relationships: [{ end1Id: "root", end2Id: "logistics", title: "支持" }] }]));
    zip.file("resources/test.png", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aV8AAAAASUVORK5CYII=", "base64"));
    const uploaded = (await request(app).post(`/api/conversations/${id}/mind-documents`).attach("file", await zip.generateAsync({ type: "nodebuffer" }), "test.xmind").expect(201)).body.data;
    fileId = uploaded.messages.flatMap((message: any) => message.documents).at(-1).id;
    await request(app).post(`/api/conversations/${id}/messages`).send({ text: "面向新手重点讲物流，把导图转成PPT" }).expect(202);
    let view: any;
    for (let n = 0; n < 100; n++) { await new Promise((resolve) => setTimeout(resolve, 40)); view = (await request(app).get(`/api/conversations/${id}`)).body.data; if (view.status === "idle" && ordinaryCalls >= 2) break; }
    expect(plannerInput).toContain("面向新手重点讲物流"); expect(plannerInput).toContain("FBA 与自发货");
    expect(plannerInput).toContain("店铺运营 ↔ 物流（支持）");
    expect(plannerInput).toContain("图片是一张物流流程图");
    const row = view.messages.find((message: any) => message.role === "tool" && message.toolName === "doc_convert");
    expect(row.toolResult.ok).toBe(true);
    const callRow = view.messages.find((message: any) => message.role === "assistant" && message.toolName === "doc_convert");
    expect(callRow.toolArgs).toMatchObject({ fileId, to: "pptx" });
    const output = context.db.getWorkspaceDocument(id, row.toolResult.data.workspaceFileId)!;
    const archive = await JSZip.loadAsync(await fs.readFile(path.join(dir, "documents", id, output.name)));
    expect(await archive.file("ppt/slides/slide2.xml")!.async("string")).toContain("物流方式如何选择");
    expect(await archive.file("ppt/slides/slide2.xml")!.async("string")).toContain("<p:pic>");
    expect(Object.keys(archive.files).some((name) => name.startsWith("ppt/media/"))).toBe(true);
    expect(Object.keys(archive.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(3);
    expect(archive.file("chatcanvas/presentation.json")).not.toBeNull();
  } finally { context.db.close(); await fs.rm(dir, { recursive: true, force: true }); await new Promise<void>((resolve) => mock.close(() => resolve())); }
}, 20000);
