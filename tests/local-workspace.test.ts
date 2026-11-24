import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { Jimp, JimpMime } from "jimp";
import { expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import { listWorkspaceFiles, readWorkspaceText } from "../src/server/local-workspaces";
import type { LocalWorkspace, WorkspaceImageReview, WorkspaceSkillDraft } from "../src/shared/local-workspace";

it("把工作区对话的上传、生成和已发送的公共素材原样归档", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatcanvas-workspace-media-"));
  const project = path.join(root, "project");
  await mkdir(project);
  const target = path.join(project, "ChatCanvas 素材");
  const { app, context: { db, runner, agent } } = createApp({ dataDir: path.join(root, "db") });
  const common = { authType: "none" as const, authHeaderName: "", secretEnv: "", allowPrivateNetwork: true, enabled: true };
  const brain = db.saveChannel({ ...common, name: "Brain", adapterType: "openai-chat",
    baseUrl: "http://127.0.0.1:1", endpoint: "/chat", models: ["mock-chat"] });
  const images = db.saveChannel({ ...common, name: "Images", adapterType: "openai-images",
    baseUrl: "http://127.0.0.1:2", endpoint: "/images", models: ["mock-image"] });
  const videos = db.saveChannel({ ...common, name: "Video", adapterType: "minimax-video",
    baseUrl: "http://127.0.0.1:3", endpoint: "/v1/video/generations", models: ["MiniMax-H3"] });
  const speech = db.saveChannel({ ...common, name: "Speech", adapterType: "gemini-tts",
    baseUrl: "http://127.0.0.1:4", endpoint: "/tts", models: ["mock-voice"] });
  const photo = await new Jimp({ width: 64, height: 64, color: 0xffbb22ff }).getBuffer(JimpMime.png);
  const wav = Buffer.from("RIFF0000WAVE");
  const mp4 = Buffer.from("0000ftypisom");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "http://127.0.0.1:2/images") return Response.json({ data: [{ b64_json: photo.toString("base64") }] });
    if (url === "http://127.0.0.1:1/chat") return Response.json({ choices: [{ message: { content: "收到素材" }, finish_reason: "stop" }] });
    if (url === "http://127.0.0.1:3/v1/video/generations") return Response.json({ task_id: "test-video", status: "queued" });
    if (url === "http://127.0.0.1:3/v1/videos/test-video") return Response.json({ status: "completed", metadata: { url: "http://127.0.0.1:3/output" } });
    if (url === "http://127.0.0.1:3/output") return new Response(new Uint8Array(mp4), { headers: { "Content-Type": "video/mp4" } });
    if (url.startsWith("http://127.0.0.1:4/")) {
      return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: wav.toString("base64") } }] } }] });
    }
    throw new Error("Unexpected upstream");
  }));
  try {
    const workspace = await db.localWorkspaces.add(project);
    const id = (await request(app).post("/api/conversations")
      .send({ workspaceId: workspace.id, brainChannelId: brain.id, brainModel: "mock-chat", toolScope: "all" }).expect(201)).body.data.id;
    const url = `/api/conversations/${id}`;
    await request(app).post(`${url}/uploads`).set("Host", "example.test").attach("images", photo, "猫.png").expect(403);
    await expect(readdir(target)).rejects.toMatchObject({ code: "ENOENT" });
    const uploaded = (await request(app).post(`${url}/uploads`).attach("images", photo, "猫.png").expect(201)).body.data;
    const media = (await request(app).post(`${url}/media`).attach("files", wav, "旁白.wav").attach("files", mp4, "示例.mp4").expect(201)).body.data;
    const uploads = path.join(target, "上传");
    expect(await readdir(uploads)).toHaveLength(3);
    expect(await readFile(path.join(uploads, `猫-${uploaded.uploadedAssetIds[0]}.png`))).toEqual(photo);
    const wavFile = (await readdir(uploads)).find(file => file.endsWith(".wav"))!;
    const mp4File = (await readdir(uploads)).find(file => file.endsWith(".mp4"))!;
    expect(await readFile(path.join(uploads, wavFile))).toEqual(wav);
    expect(await readFile(path.join(uploads, mp4File))).toEqual(mp4);
    expect(media.mediaAssets).toHaveLength(3);

    const input = { channelId: images.id, model: "mock-image", prompt: "无真实请求" };
    const generated = await runner.waitFor((await runner.create(input, [], undefined, "conversation", id)).id);
    expect(generated.status).toBe("succeeded");
    const generatedDir = path.join(target, "生成");
    expect(await readFile(path.join(generatedDir, `图片-${generated.assets[0]!.id}.png`))).toEqual(photo);
    const video = await runner.waitFor((await runner.create({ channelId: videos.id, model: "MiniMax-H3", prompt: "视频" }, [], undefined, "conversation", id)).id);
    const audio = await runner.waitFor((await runner.create({ channelId: speech.id, model: "mock-voice", prompt: "旁白" }, [], undefined, "conversation", id)).id);
    expect(video.status).toBe("succeeded");
    expect(audio.status).toBe("succeeded");
    expect(await readFile(path.join(generatedDir, `视频-${video.assets[0]!.id}.mp4`))).toEqual(mp4);
    expect(await readFile(path.join(generatedDir, `旁白-${audio.assets[0]!.id}.wav`))).toEqual(wav);
    const shared = await runner.waitFor((await runner.create(input)).id);
    expect(shared.status).toBe("succeeded");
    const assetId = shared.assets[0]!.id;
    const references = path.join(target, "引用");
    await expect(readdir(references)).rejects.toMatchObject({ code: "ENOENT" });
    for (let index = 0; index < 2; index++) {
      await request(app).post(`${url}/messages`).send({ text: "参考这个", libraryAssetIds: [assetId] }).expect(202);
      await vi.waitFor(() => expect(agent.isRunning(id)).toBe(false));
    }
    expect(await readdir(references)).toEqual([`图片-${assetId}.png`]);
    expect(await readFile(path.join(references, `图片-${assetId}.png`))).toEqual(photo);
    await request(app).get(shared.assets[0]!.url).expect(200);

    const unavailable = path.join(root, "unavailable");
    await mkdir(unavailable);
    const blocked = await db.localWorkspaces.add(unavailable);
    const unsafe = path.join(unavailable, "ChatCanvas 素材");
    await symlink(project, unsafe, process.platform === "win32" ? "junction" : "dir");
    const secondId = (await request(app).post("/api/conversations")
      .send({ workspaceId: blocked.id, brainChannelId: brain.id, brainModel: "mock-chat" }).expect(201)).body.data.id;
    const protectedResult = await runner.waitFor((await runner.create(input, [], undefined, "conversation", secondId)).id);
    expect(protectedResult.status).toBe("succeeded");
    expect(db.listMessages(secondId).at(-1)?.content).toContain("未能保存到工作区");
    expect(await readdir(generatedDir)).toHaveLength(3);
    expect(await readdir(project)).toEqual(["ChatCanvas 素材"]);
    await request(app).get(protectedResult.assets[0]!.url).expect(200);

    await request(app).delete(`/api/local-workspaces/${workspace.id}`).send({}).expect(200);
    expect(await readFile(path.join(uploads, wavFile))).toEqual(wav);
  } finally {
    vi.unstubAllGlobals();
    agent.dispose();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("shares local files and explicitly approved skills across normal chats in a workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatcanvas-workspace-"));
  const directory = path.join(root, "project");
  const skills = path.join(directory, ".agents", "skills");
  const images = path.join(directory, "samples");
  const original = path.join(skills, "lookbook");
  await mkdir(original, { recursive: true });
  await mkdir(images);
  await writeFile(path.join(directory, "brief.md"), "保留商品原色");
  await writeFile(path.join(images, "sample.png"), await new Jimp({ width: 64, height: 64, color: 0x123456ff }).getBuffer(JimpMime.png));
  await writeFile(path.join(directory, ".env"), "hidden-secret");
  await writeFile(path.join(root, "outside.txt"), "outside-secret");
  await symlink(root, path.join(directory, "escape"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(path.join(original, "SKILL.md"), "---\nname: lookbook\ndescription: >-\n  为系列产品图\n  规划布光\n---\n\n读取画册隐藏标记 LOOKBOOK_BODY");
  const { app, context: { db, agent } } = createApp({ dataDir: path.join(root, "db") });
  const calls: Array<{ tools?: { function: { name: string } }[]; messages: Array<{ role: string; content?: string; tool_call_id?: string }> }> = [];
  const invoke = (id: string, name: string, args: object) => ({ content: "", tool_calls: [
    { type: "function", id, function: { name, arguments: JSON.stringify(args) } },
  ] });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (!url.startsWith("http://127.0.0.1:1/")) throw new Error("Unexpected network");
    const payload = JSON.parse(String(init.body)) as (typeof calls)[number];
    calls.push(payload);
    const last = payload.messages.at(-1);
    const user = payload.messages.filter(message => message.role === "user").at(-1);
    const context = payload.messages.map(message => message.content).join("\n");
    let message;
    if (last?.tool_call_id === "list") {
      expect(last.content).toContain("brief.md");
      expect(last.content).not.toContain("escape");
      message = invoke("read", "workspace_read", { path: "brief.md" });
    } else if (last?.tool_call_id === "read") {
      expect(last.content).toContain("保留商品原色");
      message = { content: "已读取需求，请问要方图还是横图？" };
    } else if (last?.tool_call_id === "image") {
      expect(last.content).toMatch(/会话素材 #[0-9a-f]+/);
      message = { content: "已引用指定样片。" };
    } else if (last?.tool_call_id === "draft") message = { content: "请审阅 Skill 草稿。" };
    else if (user?.content?.includes("$product-style")) {
      expect(context).toContain("KEEP_COLOR_BODY");
      expect(context).not.toContain("LOOKBOOK_BODY");
      message = { content: "我会沿用保留原色的做法。" };
    } else if (user?.content?.includes("封装")) {
      message = invoke("draft", "workspace_draft_skill", { name: "product-style", description: "制作商品图", instructions: "KEEP_COLOR_BODY\n确认画幅并保留产品原色。" });
    } else if (user?.content?.includes("读需求")) message = invoke("list", "workspace_list", {});
    else if (user?.content?.includes("引用样片")) message = invoke("image", "workspace_use_image", { path: "samples/sample.png" });
    else message = { content: "普通聊天" };
    return Response.json({ choices: [{ message, finish_reason: "tool_calls" in message ? "tool_calls" : "stop" }], usage: { prompt_tokens: 12, completion_tokens: 9 } });
  }));
  try {
    await request(app).post("/api/local-workspaces").set("Host", "example.test").send({ directory }).expect(403);
    await request(app).post("/api/local-workspaces").set("Origin", "https://example.test").send({ directory }).expect(403);
    const workspace = (await request(app).post("/api/local-workspaces").send({ directory }).expect(201)).body.data as LocalWorkspace;
    expect((await request(app).post("/api/local-workspaces").send({ directory }).expect(201)).body.data.id).toBe(workspace.id);
    expect((await request(app).get(`/api/local-workspaces/${workspace.id}/skills`).expect(200)).body.data).toEqual([
      { name: "lookbook", description: "为系列产品图 规划布光" },
    ]);
    await expect(readWorkspaceText(workspace, "../outside.txt", 0)).rejects.toThrow();
    await expect(readWorkspaceText(workspace, "escape/outside.txt", 0)).rejects.toThrow();
    await expect(readWorkspaceText(workspace, ".env", 0)).rejects.toThrow();
    expect((await listWorkspaceFiles(workspace, ".")).entries.map(item => item.path)).toEqual(["brief.md", "samples"]);
    const channel = db.saveChannel({ name: "Vision", adapterType: "openai-chat", baseUrl: "http://127.0.0.1:1",
      endpoint: "/v1/chat/completions", models: ["mock"], authType: "none", authHeaderName: "", secretEnv: "", allowPrivateNetwork: true, enabled: true });
    async function newChat(workspaceId?: string) {
      const response = await request(app).post("/api/conversations").send({ workspaceId, brainChannelId: channel.id, brainModel: "mock", toolScope: "all" }).expect(201);
      return String(response.body.data.id);
    }
    async function talk(id: string, text: string, expected: string) {
      await request(app).post(`/api/conversations/${id}/messages`).send({ text }).expect(202);
      await vi.waitFor(() => {
        expect(db.listMessages(id).at(-1)?.content).toBe(expected);
        expect(agent.isRunning(id)).toBe(false);
      });
    }
    const first = await newChat(workspace.id);
    await talk(first, "先读需求然后提问", "已读取需求，请问要方图还是横图？");
    expect(calls[0]?.tools?.map(tool => tool.function.name)).toContain("workspace_list");
    expect(JSON.stringify(calls[0]?.messages)).toContain("lookbook");
    expect(JSON.stringify(calls[0]?.messages)).not.toContain("LOOKBOOK_BODY");
    expect(db.listConversationAssets(first)).toHaveLength(0);
    await talk(first, "引用样片", "已引用指定样片。");
    expect(db.listConversationAssets(first).map(({ asset }) => asset.mimeType)).toEqual(["image/png"]);
    await talk(first, "把流程封装成 Skill", "请审阅 Skill 草稿。");
    const draft = db.listMessages(first).map(message => message.toolResult?.data?.workspaceSkillDraft).find(Boolean) as WorkspaceSkillDraft;
    const skillMd = path.join(skills, "product-style", "SKILL.md");
    await expect(readFile(skillMd)).rejects.toThrow();
    const second = await newChat(workspace.id);
    await request(app).post(`/api/conversations/${second}/workspace-skills/${draft.id}/save`).send({}).expect(404);
    const save = `/api/conversations/${first}/workspace-skills/${draft.id}/save`;
    await request(app).post(save).send({}).expect(200);
    await request(app).post(save).send({}).expect(200);
    expect(await readFile(skillMd, "utf8")).toContain("KEEP_COLOR_BODY");
    await talk(second, "$product-style 再做一批", "我会沿用保留原色的做法。");
    expect(db.listMessages(second).filter(message => message.role === "user")).toHaveLength(1);
    const standalone = await newChat();
    await talk(standalone, "你好", "普通聊天");
    expect(calls.at(-1)?.tools?.map(tool => tool.function.name)).not.toContain("workspace_list");
    await request(app).delete(`/api/local-workspaces/${workspace.id}`).send({}).expect(200);
    expect(db.getConversation(first)?.workspaceId).toBeUndefined();
    expect(db.getConversation(second)?.workspaceId).toBeUndefined();
    expect(await readFile(skillMd, "utf8")).toContain("KEEP_COLOR_BODY");
  } finally {
    vi.unstubAllGlobals();
    agent.dispose();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("reads all 16 workspace images in four batches and retries only an omitted image", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatcanvas-workspace-review-"));
  const project = path.join(root, "project");
  const samples = path.join(project, "samples");
  await mkdir(samples, { recursive: true });
  const png = await new Jimp({ width: 32, height: 32, color: 0x80ff77ff }).getBuffer(JimpMime.png);
  for (let index = 1; index <= 16; index++) await writeFile(path.join(samples, `sample${index}.png`), png);
  const { app, context: { db, agent } } = createApp({ dataDir: path.join(root, "db") });
  const batches: number[][] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (!url.startsWith("http://127.0.0.1:1/")) throw new Error("Unexpected network");
    const payload = JSON.parse(String(init.body));
    expect(payload.tools).toBeUndefined();
    const parts = payload.messages.at(-1).content as Array<{ type: string; text?: string }>;
    const ids = parts.filter(part => part.type === "text").slice(1).map(part => Number(JSON.parse(part.text!).id));
    expect(parts.filter(part => part.type === "image_url")).toHaveLength(ids.length);
    batches.push(ids);
    const images = ids.filter(id => batches.length !== 2 || id !== 7)
      .map(id => ({ id, observation: `第 ${id + 1} 张观察` }));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ images }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 20 } });
  }));
  try {
    const workspace = (await request(app).post("/api/local-workspaces").send({ directory: project }).expect(201)).body.data as LocalWorkspace;
    const channel = db.saveChannel({ name: "Vision", adapterType: "openai-chat", baseUrl: "http://127.0.0.1:1",
      endpoint: "/v1/chat/completions", models: ["mock"], authType: "none", authHeaderName: "", secretEnv: "", allowPrivateNetwork: true, enabled: true });
    const id = (await request(app).post("/api/conversations").send({
      workspaceId: workspace.id, brainChannelId: channel.id, brainModel: "mock", toolScope: "all",
    }).expect(201)).body.data.id as string;
    const run = async (text: string, results: number) => {
      await request(app).post(`/api/conversations/${id}/messages`).send({ text }).expect(202);
      return vi.waitFor(() => {
        const reports = db.listMessages(id).filter(message => message.role === "tool" && message.toolName === "workspace_review_images");
        expect(reports).toHaveLength(results);
        expect(agent.isRunning(id)).toBe(false);
        return reports.at(-1)!.toolResult!;
      }, { timeout: 5000 });
    };
    const partial = await run("先将工作区图片看完", 1);
    expect(partial.ok).toBe(false);
    expect(partial.summary).toContain("15/16");
    const rows = (partial.data?.workspaceImageReview as WorkspaceImageReview).items;
    expect(rows[7]).toEqual({ path: "samples/sample8.png", error: "模型遗漏了这张图片的分析" });
    expect(batches).toEqual([[0, 1, 2, 3], [4, 5, 6, 7], [8, 9, 10, 11], [12, 13, 14, 15]]);
    expect(db.listConversationAssets(id)).toHaveLength(0);
    db.updateConversation(id, { chatModelCallLimit: 1 });
    const complete = await run("继续看工作区图片", 2);
    expect(batches.at(-1)).toEqual([7]);
    expect(batches).toHaveLength(5);
    expect(complete.ok).toBe(true);
    expect(complete.summary).toContain("16/16");
    expect(db.localWorkspaces.imageReview(id, workspace.id)?.items.every(item => item.observation)).toBe(true);
  } finally {
    vi.unstubAllGlobals();
    agent.dispose();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
