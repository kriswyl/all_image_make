import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Jimp, JimpMime } from "jimp";
import request from "supertest";
import { expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { ImageSkillRun } from "../src/shared/skills";

it("maps each sample to its own approved task, retries one failure and reuses a saved set in another conversation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatcanvas-image-skill-"));
  const { app, context } = createApp({ dataDir: root });
  const { db, agent } = context;
  const images = await Promise.all([0x123456ff, 0xabcdefff, 0x706070ff, 0x683812ff, 0x823262ff].map((color) =>
    new Jimp({ width: 96, height: 96, color }).getBuffer(JimpMime.png)));
  const common = { authType: "none" as const, authHeaderName: "", secretEnv: "", allowPrivateNetwork: true, enabled: true };
  const brain = db.saveChannel({ ...common, name: "Vision", adapterType: "openai-chat",
    baseUrl: "http://127.0.0.1:1", endpoint: "/vision", models: ["mock-vision"] });
  const image = db.saveChannel({ ...common, name: "Images", adapterType: "openai-images",
    baseUrl: "http://127.0.0.1:2", endpoint: "/edit", models: ["gpt-image-2"] });
  const upstream: Array<{ prompt: string; size: string; images: File[] }> = [];
  const decisions: Array<{ samples: Array<{ name: string; lighting: string }>; hasSubject: boolean;
    request: string; savedSkill?: { rules: string }; history: Array<{ user: string; agent: string }> }> = [];
  let analyzed = 0;
  vi.stubGlobal("fetch", vi.fn(async (address: string, init?: RequestInit) => {
    if (new URL(address).port === "1") {
      const messages = JSON.parse(String(init?.body)).messages;
      if (String(messages[0]?.content).includes("出图 Agent")) {
        const last = messages.at(-1).content.at(-1);
        const turn = JSON.parse(last.text) as (typeof decisions)[number];
        decisions.push(turn);
        const answer = !turn.hasSubject || !turn.samples.length
          ? { status: "ask", reply: "请补充底图和样片文件夹。" }
          : !turn.history.length && !turn.savedSkill
            ? { status: "ask", reply: "样片有侧光和暖色背景，您希望保留哪一项？" }
            : { status: "ready", reply: "两张样片逐张对应，请确认后生成。", requirements: turn.request,
              fields: ["lighting"], reusableRules: "保留侧光", size: "1024x1024" };
        return Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }] });
      }
      const index = ++analyzed;
      const analysis = { composition: `构图 ${index}`, colors: `配色 ${index}`, lighting: `布光 ${index}`, background: `背景 ${index}`, texture: `质感 ${index}` };
      return Response.json({ choices: [{ message: { content: JSON.stringify(analysis) } }] });
    }
    if (new URL(address).port !== "2") throw new Error("Unexpected upstream");
    const form = init?.body as FormData;
    upstream.push({ prompt: String(form.get("prompt")), size: String(form.get("size")),
      images: [...form.values()].filter((file): file is File => typeof file !== "string") });
    if (upstream.length === 2) return Response.json({ error: { message: "模拟生成失败" } }, { status: 400 });
    return Response.json({ data: [{ b64_json: images[0]!.toString("base64") }] });
  }));

  async function createConversation() {
    const created = await request(app).post("/api/conversations").send({ brainChannelId: brain.id, brainModel: "mock-vision" }).expect(201);
    return String(created.body.data.id);
  }
  async function upload(conversationId: string, index: number) {
    const response = await request(app).post(`/api/conversations/${conversationId}/uploads?keepCanvas=1`)
      .attach("images", images[index]!, `image-${index}.png`).expect(201);
    return String(response.body.data.uploadedAssetIds[0]);
  }
  async function runView(base: string, id: string): Promise<ImageSkillRun> {
    return (await request(app).get(`${base}/runs/${id}`).expect(200)).body.data;
  }

  try {
    const first = await createConversation();
    const base = `/api/conversations/${first}/skills/sample-image-batch`;
    const subjectId = await upload(first, 0);
    const sampleIds = [await upload(first, 1), await upload(first, 2), await upload(first, 3)];
    const target = { channelId: image.id, model: "gpt-image-2", size: "1024x1024" };
    const preview = (await request(app).post(`${base}/prepare`).send({
      ...target, subjectId, samples: sampleIds.map((assetId, index) => ({ assetId, name: `样片 ${index + 1}.png` })),
      requirements: "去掉背景文字",
    }).expect(201)).body.data as ImageSkillRun;
    expect(preview.confirmed).toBe(false);
    expect(preview.items.map((row) => row.sample.id)).toEqual(sampleIds);
    expect(upstream).toHaveLength(0);
    expect(analyzed).toBe(3);

    const fields = [["lighting"], ["background"], ["composition"]];
    await request(app).post(`${base}/runs/${preview.id}/confirm`).send({ fields }).expect(200);
    await request(app).post(`${base}/runs/${preview.id}/confirm`).send({ fields }).expect(200);
    await vi.waitFor(async () => {
      const run = await runView(base, preview.id);
      expect(run.submitting).toBe(false);
      expect(run.items.map((row) => row.task?.status)).toEqual(["succeeded", "failed", "succeeded"]);
    }, { timeout: 5000 });
    expect(upstream).toHaveLength(3);
    expect(upstream[0]?.prompt).toContain("光线：布光");
    expect(upstream[0]?.prompt).not.toContain("配色：");
    expect(upstream[1]?.prompt).toContain("背景：背景");
    expect(upstream[1]?.prompt).toContain("去掉背景文字");
    expect(upstream[2]?.prompt).toContain("构图：构图");
    expect(upstream[0]?.size).toBe("1024x1024");
    for (const [index, call] of upstream.entries()) {
      expect(await Promise.all(call.images.map(async (file) => Buffer.from(await file.arrayBuffer()))))
        .toEqual([images[0], images[index + 1]]);
    }

    const beforeRetry = await runView(base, preview.id);
    await request(app).post(`${base}/runs/${preview.id}/items/1/retry`).expect(200);
    await vi.waitFor(async () => {
      const run = await runView(base, preview.id);
      expect(run.items.map((row) => row.task?.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
      expect(run.items[0]?.task?.id).toBe(beforeRetry.items[0]?.task?.id);
      expect(run.items[1]?.task?.id).not.toBe(beforeRetry.items[1]?.task?.id);
      expect(run.items[2]?.task?.id).toBe(beforeRetry.items[2]?.task?.id);
    }, { timeout: 5000 });
    expect(upstream).toHaveLength(4);
    expect(db.listConversationAssets(first).filter(({ source }) => source === "generate")).toHaveLength(3);

    const saved = (await request(app).post(`${base}/runs/${preview.id}/references`).send({ name: "商品图范例", selected: fields }).expect(201)).body.data;
    const second = await createConversation();
    const anotherBase = `/api/conversations/${second}/skills/sample-image-batch`;
    const anotherSubject = await upload(second, 4);
    const secondPreview = (await request(app).post(`${anotherBase}/prepare`).send({
      ...target, size: "1536x1024", subjectId: anotherSubject, referenceSetId: saved.id, samples: [], requirements: "仅处理背景",
    }).expect(201)).body.data as ImageSkillRun;
    expect(secondPreview.items.map((row) => row.fields)).toEqual(fields);
    expect(secondPreview.target.size).toBe("1536x1024");
    expect(analyzed).toBe(3);
    expect(upstream).toHaveLength(4);
    await request(app).get(`${anotherBase}/runs/${preview.id}`).expect(404);

    const third = await createConversation();
    const chatBase = `/api/conversations/${third}/skills/sample-image-batch`;
    async function stage(conversationId: string, index: number) {
      const upload = await request(app).post(`/api/conversations/${conversationId}/uploads?staged=1`)
        .attach("images", images[index]!, `staged-${index}.png`).expect(201);
      return String(upload.body.data.uploadedAssetIds[0]);
    }
    const thirdSubject = await stage(third, 0);
    const ordered = [await stage(third, 1), await stage(third, 2)];
    const folder = { name: "样片目录", samples: [
      { assetId: ordered[1], name: "sample10.png" }, { assetId: ordered[0], name: "sample2.png" },
    ] };
    expect(db.listMessages(third)).toHaveLength(0);
    await request(app).post(`${chatBase}/chat`).send({
      text: "按这个文件夹批量出图", folder, subjectId: thirdSubject, target,
    }).expect(200);
    expect(decisions[0]?.samples.map(({ name, lighting }) => [name, lighting])).toEqual([
      ["sample2.png", preview.items[0]!.analysis.lighting], ["sample10.png", preview.items[1]!.analysis.lighting],
    ]);
    expect(db.listMessages(third).at(-1)?.content).toContain("希望保留哪一项");
    expect(upstream).toHaveLength(4);
    const planned = (await request(app).post(`${chatBase}/chat`).send({ text: "只保留侧光" }).expect(200)).body.data;
    expect(decisions[1]?.history[0]?.user).toBe("按这个文件夹批量出图");
    expect(db.listMessages(third).at(-1)?.toolArgs?.imageSkillRunId).toBe(planned.runId);
    const plannedRun = await runView(chatBase, planned.runId);
    expect(plannedRun.items.map(({ sample }) => sample.id)).toEqual(ordered);
    const save = `${chatBase}/runs/${planned.runId}/save-skill`;
    await request(app).post(save).send({ name: "商品布光", rules: "保留侧光" }).expect(409);
    await request(app).post(`${chatBase}/runs/${planned.runId}/confirm`).send({ fields: [["lighting"], ["lighting"]] }).expect(200);
    await vi.waitFor(async () => expect((await runView(chatBase, planned.runId)).items.map(({ task }) => task?.status)).toEqual(["succeeded", "succeeded"]), { timeout: 5000 });
    const savedSkill = (await request(app).post(save).send({ name: "商品布光", rules: "保留侧光" }).expect(201)).body.data;
    const document = await request(app).get(`/api/skills/saved/${savedSkill.id}/SKILL.md`).expect(200);
    expect(document.text).toContain(`name: ${savedSkill.id}`);
    expect(document.text).toContain("保留侧光");
    expect(document.text).not.toContain("sample2.png");
    expect((await request(app).get(`${chatBase}/chat`).expect(200)).body.data).toBeNull();

    const fresh = await createConversation();
    const freshBase = `/api/conversations/${fresh}/skills/sample-image-batch`;
    await request(app).post(`${freshBase}/chat`).send({ text: "载入已保存 Skill", savedSkillId: savedSkill.id, target }).expect(200);
    const freshState = (await request(app).get(`${freshBase}/chat`).expect(200)).body.data;
    expect(freshState.savedSkillId).toBe(savedSkill.id);
    expect(freshState.samples).toEqual([]);
    expect(decisions.at(-1)?.savedSkill?.rules).toBe("保留侧光");
    const newSubject = await stage(fresh, 4);
    const newSample = await stage(fresh, 3);
    const reused = (await request(app).post(`${freshBase}/chat`).send({
      text: "这批用新底图和样片", subjectId: newSubject, folder: { name: "新目录", samples: [{ name: "new.png", assetId: newSample }] },
    }).expect(200)).body.data;
    expect((await runView(freshBase, reused.runId)).items.map(({ sample }) => sample.id)).toEqual([newSample]);
    expect(decisions.at(-1)?.savedSkill?.rules).toBe("保留侧光");
    expect(upstream).toHaveLength(6);

    const restarted = createApp({ dataDir: root });
    try {
      const restored = (await request(restarted.app).get(`${base}/latest`).expect(200)).body.data as ImageSkillRun;
      expect(restored.id).toBe(preview.id);
      expect(restored.items.map(({ task }) => task?.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
    } finally {
      restarted.context.agent.dispose();
      restarted.context.db.close();
    }
  } finally {
    vi.unstubAllGlobals();
    agent.dispose();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
