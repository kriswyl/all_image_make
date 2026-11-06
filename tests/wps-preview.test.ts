import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import JSZip from "jszip";
import request from "supertest";
import { expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { renderAiPresentation } from "../src/server/mind-document";

it("WPS 任务只允许持有令牌者读取临时副本和预览页", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wps-preview-test-")); const { app, context } = createApp({ dataDir: dir });
  try {
    await request(app).get("/wps-addon/runner.html").expect(200);
    await request(app).get("/wps-addon/wpsjsrpcsdk.js").expect(200).expect("Content-Type", /javascript/);
    const chat = context.db.createConversation({ title: "预览", brainChannelId: "brain", brainModel: "mock", videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false });
    const other = context.db.createConversation({ title: "隔离", brainChannelId: "brain", brainModel: "mock", videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false });
    const ppt = await renderAiPresentation({ title: "测试", theme: "ink", slides: [{ layout: "content", title: "第一页", subtitle: "", lines: ["内容"], notes: "" }] });
    const workspace = path.join(dir, "documents", chat.id); await fs.mkdir(workspace, { recursive: true }); await fs.writeFile(path.join(workspace, "test.pptx"), ppt);
    const file = context.db.addWorkspaceDocument(chat.id, "test.pptx", ppt.length);
    await request(app).post(`/api/conversations/${chat.id}/documents/files/${file.id}/wps-preview`).set("Origin", "https://untrusted.example").send({ first: 1 }).expect(403);
    await request(app).post(`/api/conversations/${other.id}/documents/files/${file.id}/wps-preview`).send({ first: 1 }).expect(404);
    const response = await request(app).post(`/api/conversations/${chat.id}/documents/files/${file.id}/wps-preview`).send({ first: 1 }).expect(201);
    const job = response.body.data;
    expect(job).toMatchObject({ first: 1, last: 1, total: 1 });
    await request(app).get(`/api/wps-preview/${job.id}/claim`).set("Authorization", `Bearer ${"0".repeat(64)}`).expect(404);
    const claimed = (await request(app).get(`/api/wps-preview/${job.id}/claim`).set("Authorization", `Bearer ${job.secret}`).expect(200)).body.data;
    expect(await fs.readFile(claimed.source)).toEqual(ppt);
    await request(app).options(`/api/wps-preview/${job.id}/claim`).set("Origin", "http://127.0.0.1:17892").expect("Access-Control-Allow-Origin", "http://127.0.0.1:17892").expect(204);
    const deniedCors = await request(app).options(`/api/wps-preview/${job.id}/claim`).set("Origin", "https://untrusted.example").expect(204);
    expect(deniedCors.headers["access-control-allow-origin"]).toBeUndefined();
    const png = Buffer.alloc(45); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(13, 8); png.write("IHDR", 12); png.writeUInt32BE(1600, 16); png.writeUInt32BE(900, 20); Buffer.from("0000000049454e44ae426082", "hex").copy(png, png.length - 12);
    await fs.writeFile(path.join(claimed.dir, "page-001"), png);
    expect((await request(app).get(`/api/wps-preview/${job.id}/diagnostics`).set("Authorization", `Bearer ${job.secret}`).expect(200)).body.data.ready).toBe(1);
    await request(app).get(`/api/wps-preview/${job.id}/pages/1`).set("Authorization", `Bearer ${job.secret}`).expect(200).expect("Content-Type", /image\/png/);
    await request(app).delete(`/api/wps-preview/${job.id}`).set("Authorization", `Bearer ${job.secret}`).expect(200);
    await expect(fs.stat(claimed.dir)).rejects.toThrow();
  } finally { context.agent.dispose(); context.db.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

it("WPS 调用桥只接受可信父页面的预览任务", async () => {
  const script = await fs.readFile(path.resolve("src/client/public/wps-addon/runner.js"), "utf8");
  let handler: ((event: any) => void) | undefined; const sent: any[] = []; const invocations: any[] = [];
  const parent = { postMessage: (message: unknown, origin: string) => sent.push({ message, origin }) };
  function FakeClient(this: any, type: string) { this.InvokeAsHttp = (...args: any[]) => { invocations.push({ type, args }); args[3]({ status: 0 }); }; }
  const sandbox: any = { location: { origin: "http://127.0.0.1:17892" }, window: { parent, addEventListener: (_type: string, fn: typeof handler) => { handler = fn; }, WpsClient: FakeClient, WpsInvoke: { ClientType: { wpp: "wpp" } } } };
  vm.runInNewContext(script, sandbox);
  const data = { channel: "chatcanvas-wps-preview", action: "render", requestId: "12345678-1234-1234-1234-123456789abc", id: "12345678-1234-1234-1234-123456789abc", secret: "a".repeat(64) };
  handler!({ source: parent, origin: "https://untrusted.example", data }); expect(invocations).toHaveLength(0);
  handler!({ source: parent, origin: "http://tauri.localhost", data });
  expect(invocations).toHaveLength(1); expect(invocations[0].args[1]).toBe("RenderPreview");
  expect(sent[0].origin).toBe("http://tauri.localhost"); expect(sent[0].message.result.status).toBe(0);
});

it("WPS 加载项仅用任务提供的临时路径，只读打开并关闭自己的副本", async () => {
  const script = await fs.readFile(path.resolve("src/client/public/wps-addon/main.js"), "utf8");
  const exported: Array<[number, string]> = []; let closed = 0; let opened: unknown[] = [];
  const task = { source: "C:\\Temp\\job\\source.pptx", dir: "C:\\Temp\\job", first: 2, last: 3, total: 3 };
  class Xhr { status = 200; responseText = JSON.stringify({ ok: true, data: task }); open() {} setRequestHeader() {} send() {} }
  const sandbox: any = { location: { origin: "http://127.0.0.1:17892" }, XMLHttpRequest: Xhr, window: { Application: { Presentations: { Open: (...args: unknown[]) => { opened = args; return { Slides: { Count: 3, Item: (page: number) => ({ Export: (target: string) => exported.push([page, target]) }) }, Close: () => { closed++; } }; } } } } };
  vm.runInNewContext(script, sandbox);
  const result = sandbox.RenderPreview(JSON.stringify({ id: "12345678-1234-1234-1234-123456789abc", secret: "a".repeat(64) }));
  expect(result.ok).toBe(true); expect(opened).toEqual([task.source, -1, 0, 0]);
  expect(exported).toHaveLength(2); expect(exported[0][1]).toContain("page-002"); expect(closed).toBe(1);
  expect(sandbox.RenderPreview(JSON.stringify({ id: "x", secret: "bad" })).message).toContain("参数无效");
});

it("拒绝带外部链接的 PPTX 进入自动预览", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wps-preview-external-")); const { app, context } = createApp({ dataDir: dir });
  try {
    const chat = context.db.createConversation({ title: "预览", brainChannelId: "brain", brainModel: "mock", videoConfirmPolicy: "auto_only", visionEnabled: false, verbatimPrompt: false });
    const bytes = await renderAiPresentation({ title: "测试", theme: "ink", slides: [{ layout: "content", title: "标题", subtitle: "", lines: ["内容"], notes: "" }] });
    const archive = await JSZip.loadAsync(bytes); archive.file("ppt/slides/_rels/slide1.xml.rels", '<Relationships><Relationship TargetMode="External" Target="https://example.com/"/></Relationships>');
    const modified = await archive.generateAsync({ type: "nodebuffer" });
    const workspace = path.join(dir, "documents", chat.id); await fs.mkdir(workspace, { recursive: true }); await fs.writeFile(path.join(workspace, "external.pptx"), modified);
    const file = context.db.addWorkspaceDocument(chat.id, "external.pptx", modified.length);
    const result = await request(app).post(`/api/conversations/${chat.id}/documents/files/${file.id}/wps-preview`).send({ first: 1 }).expect(400);
    expect(result.body.error.message).toContain("外部链接");
  } finally { context.agent.dispose(); context.db.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
