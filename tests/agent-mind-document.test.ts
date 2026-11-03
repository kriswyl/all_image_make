import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import request from "supertest";
import { expect, it } from "vitest";
import { createApp } from "../src/server/app";

it("创作助手读取导图、生成 PPT 并修改指定页，保留旧版本", async () => {
  let calls = 0; const received: string[] = [];
  const mock = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      received.push(Buffer.concat(chunks).toString("utf8")); calls++;
      const plans = [
        { tool: "document_read", args: {}, say: "先看看导图。" },
        { tool: "document_make_pptx", args: {}, say: "正在生成。" },
        { tool: "reply", args: { text: "PPT 已生成。" } },
        { tool: "document_read", args: {}, say: "先读取内容。" },
        { tool: "document_make_pptx", args: { edits: [{ page: 2, title: "新标题" }] }, say: "正在修改。" },
        { tool: "reply", args: { text: "已修改。" } },
      ];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(plans[calls - 1] ?? plans[5]) } }] }));
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const address = mock.address(); if (!address || typeof address === "string") throw new Error("mock");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mind-agent-"));
  const { app, context } = createApp({ dataDir: dir });
  try {
    await request(app).post("/api/channels").send({ name: "Brain", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat", authType: "none", authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions", models: ["mock"], allowPrivateNetwork: true, enabled: true }).expect(201);
    const id = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id;
    await request(app).patch(`/api/conversations/${id}`).send({ chatMode: "creative" }).expect(200);
    const zip = new JSZip(); zip.file("content.json", JSON.stringify([{ rootTopic: { title: "主题", children: { attached: [{ title: "章节", children: { attached: [{ title: "原内容" }] } }] } } }]));
    await request(app).post(`/api/conversations/${id}/mind-documents`).attach("file", await zip.generateAsync({ type: "nodebuffer" }), "test.xmind").expect(201);
    async function send(text: string, target: number) {
      await request(app).post(`/api/conversations/${id}/messages`).send({ text }).expect(202);
      for (let n = 0; n < 100; n++) { await new Promise((resolve) => setTimeout(resolve, 50)); const view = (await request(app).get(`/api/conversations/${id}`)).body.data; if (view.status === "idle" && calls >= target) return view; }
      throw new Error(`助手未完成：${calls}`);
    }
    await send("把这个导图转成 PPT", 3);
    expect(received[1]).toContain("原内容");
    const view = await send("把第二页标题改成新标题", 6);
    const outputs = view.messages.filter((m: any) => m.role === "tool" && m.toolName === "document_make_pptx").map((m: any) => m.toolResult.data.documentOutputId);
    expect(outputs).toHaveLength(2); expect(outputs[0]).not.toBe(outputs[1]);
    const first = context.db.getDocumentOutput(outputs[0])!; const second = context.db.getDocumentOutput(outputs[1])!;
    expect(await (await JSZip.loadAsync(first.data)).file("ppt/slides/slide2.xml")!.async("string")).toContain("章节");
    expect(await (await JSZip.loadAsync(second.data)).file("ppt/slides/slide2.xml")!.async("string")).toContain("新标题");
    const other = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id;
    await request(app).get(`/api/conversations/${other}/document-outputs/${outputs[1]}`).expect(404);
    await request(app).get(`/api/conversations/${id}/document-outputs/${outputs[1]}`).expect(200);
  } finally { context.db.close(); await fs.rm(dir, { recursive: true, force: true }); await new Promise<void>((resolve) => mock.close(() => resolve())); }
}, 20000);
