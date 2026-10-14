/**
 * 对话式 Agent 的测试（AGENT_PLAN.md §19）。
 *
 * 大部分是纯函数级的：解析、别名解析、确认闸门、画布指针——
 * 这些规则一旦错了，表现是「模型明明答对了却生成错东西」，
 * 从现象往回查非常费劲，所以要在最小的粒度上钉住。
 *
 * 最后一条是整套跑通：真的起一个假中转站，走完
 * 「大脑 → 计划 → 生图 → 挪画布 → 再问大脑 → 回答」，
 * 顺带断言喂给大脑的提示词里**没有** baseUrl / 密钥 / channelId（§19 的泄漏断言）。
 */
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import {
  canvasAfterProducing, mergeConfirmArgs, parsePlan, repairPlan, salvagePlan, shouldConfirm,
} from "../src/server/agent";
import {
  buildCapabilityAliases, buildCapabilityManifest, describeAliasChoice, resolveAlias,
} from "../src/server/capabilities";
import { AppDatabase } from "../src/server/db";
import { createApp } from "../src/server/app";
import type { DbChannel } from "../src/server/db";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

function channel(overrides: Partial<DbChannel>): DbChannel {
  return {
    id: "channel-1", name: "Test", baseUrl: "https://relay.example.com", adapterType: "openai-images",
    authType: "bearer", authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations",
    models: ["image-model"], allowPrivateNetwork: false, enabled: true, createdAt: "", updatedAt: "",
    ...overrides,
  };
}

describe("parsePlan", () => {
  it("takes a bare JSON object", () => {
    const plan = parsePlan('{"tool":"generate_image","args":{"prompt":"a cat"},"say":"好"}');
    expect(plan?.tool).toBe("generate_image");
    expect(plan?.args).toEqual({ prompt: "a cat" });
    expect(plan?.say).toBe("好");
  });

  it("digs the object out of prose and code fences", () => {
    const fenced = "好的，我来画：\n```json\n{\"tool\": \"reply\", \"args\": {\"text\": \"你好\"}}\n```\n就这样。";
    expect(parsePlan(fenced)?.tool).toBe("reply");
    expect(parsePlan("让我想想… {\"tool\":\"ask\",\"args\":{\"question\":\"多大的？\"}} 以上")?.args.question).toBe("多大的？");
  });

  it("unwraps the extra object layer some models add", () => {
    expect(parsePlan('{"plan":{"tool":"reply","args":{"text":"hi"}}}')?.tool).toBe("reply");
    expect(parsePlan('{"result":{"tool":"ask","args":{"question":"q"}}}')?.tool).toBe("ask");
  });

  it("rejects unknown tools and non-objects", () => {
    expect(parsePlan('{"tool":"delete_everything","args":{}}')).toBeNull();
    expect(parsePlan("[1,2,3]")).toBeNull();
    expect(parsePlan("我画不了。")).toBeNull();
    expect(parsePlan("")).toBeNull();
  });

  it("repairPlan stitches an output cut off mid-JSON back into a usable plan", () => {
    // 推理模型在 JSON 没写完时撞上 max_tokens：工具名和提示词都在，只是尾巴断了
    const truncated = '{"tool":"generate_image","args":{"prompt":"一只橘猫","size":"1024x1024"';
    expect(parsePlan(truncated)).toBeNull();
    expect(salvagePlan(truncated)).toBeNull(); // 括号不平衡，完整对象那条路救不回来
    const repaired = repairPlan(truncated);
    expect(repaired?.tool).toBe("generate_image");
    expect(repaired?.args.prompt).toBe("一只橘猫");
  });

  it("drops the half-written parameter rather than giving up on the whole plan", () => {
    // `"siz` 是个没写完的键，得把它连同那条成员一起丢掉，而不是缝成 {"siz": ...}
    const truncated = '{"tool":"generate_image","args":{"prompt":"一只猫","siz';
    const repaired = repairPlan(truncated);
    expect(repaired?.tool).toBe("generate_image");
    expect(repaired?.args).toEqual({ prompt: "一只猫" });
    expect(repaired?.args).not.toHaveProperty("siz");
  });

  it("still refuses text that never contained a plan", () => {
    expect(repairPlan("我画不了这个，抱歉。")).toBeNull();
    expect(repairPlan('{"tool":"generate_image","args":{"prompt":"猫"}}')).toBeNull(); // 本来就是完整的
  });
});

describe("alias layer", () => {
  const aliases = buildCapabilityAliases([
    channel({ id: "ch-video", adapterType: "seedance-video", models: ["sd-2.5", "sd-2.0"] }),
    channel({ id: "ch-image", adapterType: "gemini-content", models: ["gemini-3-pro-image"] }),
    channel({ id: "ch-sd", adapterType: "openai-images", models: ["sd-xl"] }),
    // 停用的渠道不该出现在大脑的清单里
    channel({ id: "ch-off", adapterType: "openai-images", models: ["flux-pro"], enabled: false }),
    // 对话渠道是大脑自己，不是可选能力
    channel({ id: "ch-brain", adapterType: "openai-chat", models: ["deepseek-v4-1-flash"] }),
  ]);

  it("gives every alias a unique resolution target", () => {
    const pairs = aliases.map((item) => `${item.alias}@${item.kind}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it("does not confuse video sd-* models with stable diffusion", () => {
    // 中转站拿 sd-2.5 指 Seedance；图片类目里的 sd-xl 才是 Stable Diffusion
    const videoAliases = aliases.filter((item) => item.kind === "video").map((item) => item.alias);
    expect(videoAliases.some((alias) => alias.startsWith("sd"))).toBe(false);
    expect(aliases.find((item) => item.model === "sd-2.5")?.alias).toMatch(/^seedance/);
    expect(aliases.find((item) => item.model === "sd-xl")?.alias).toMatch(/^sd/);
  });

  it("numbers same-prefix models and skips disabled channels", () => {
    const seedance = aliases.filter((item) => item.model.startsWith("sd-2"));
    expect(seedance.map((item) => item.alias).sort()).toEqual(["seedance-1", "seedance-2"]);
    expect(aliases.some((item) => item.model === "flux-pro")).toBe(false);
    expect(aliases.some((item) => item.model === "deepseek-v4-1-flash")).toBe(false);
  });

  it("resolves the variants a model actually writes", () => {
    const exact = resolveAlias(aliases, "gemini", "image");
    expect(exact?.model).toBe("gemini-3-pro-image");
    expect(exact?.usedFallback).toBe(false);
    expect(resolveAlias(aliases, "  GEMINI  ", "image")?.model).toBe("gemini-3-pro-image");
    // 带序号和不带序号要能互相命中
    expect(resolveAlias(aliases, "seedance-2", "video")?.model).toBe("sd-2.0");
    expect(resolveAlias(aliases, "seedance", "video")?.usedFallback).toBe(false);
  });

  it("falls back to the category default and says so when the hint is nonsense", () => {
    const resolved = resolveAlias(aliases, "不存在的模型", "image");
    expect(resolved?.usedFallback).toBe(true);
    expect(resolved?.model).toBe("gemini-3-pro-image");
    expect(resolveAlias(aliases, undefined, "image")?.usedFallback).toBe(true);
    // 没有视频渠道时不能凭空造一个
    expect(resolveAlias(aliases.filter((item) => item.kind === "image"), "wan", "video")).toBeNull();
  });

  /**
   * 需求.md 问题 5。「默认模型」以前根本不存在——大脑不点名就碰运气取类目里第一个，
   * 而 `candidates` 的顺序来自渠道列表，用户没有任何办法控制它。
   */
  it("uses the user's configured default model when the brain names none", () => {
    const configured = resolveAlias(aliases, undefined, "image", "sd");
    expect(configured?.alias).toBe("sd");
    expect(configured?.model).toBe("sd-xl");
    expect(configured?.source).toBe("default");
    // 仍然算「没听大脑的」，所以卡片上要解释一句
    expect(configured?.usedFallback).toBe(true);
    expect(describeAliasChoice(configured!)).toContain("sd");

    // 没设默认值时才是类目第一个
    expect(resolveAlias(aliases, undefined, "image")?.source).toBe("fallback");
    expect(resolveAlias(aliases, undefined, "image", "")?.source).toBe("fallback");
    expect(resolveAlias(aliases, undefined, "image", null)?.source).toBe("fallback");
  });

  it("still lets the brain override the configured default", () => {
    // 默认值只管「大脑没说」的时候；点名了就以点名的为准，否则用户说「用 Gemini 画」会失效
    const named = resolveAlias(aliases, "gemini", "image", "sd");
    expect(named?.model).toBe("gemini-3-pro-image");
    expect(named?.source).toBe("hint");
    expect(describeAliasChoice(named!)).toBeNull();
  });

  it("says out loud when the configured default is gone, instead of pretending it was the first", () => {
    // 渠道被停用或删掉之后，存着的 alias 就解析不到了。这是**正常**情况不是错误，
    // 但退回第一个时必须说明白——不然用户会以为「我设的默认值生效了」
    const stale = resolveAlias(aliases, undefined, "image", "flux");
    expect(stale?.source).toBe("fallback");
    expect(stale?.staleDefault).toBe("flux");
    expect(describeAliasChoice(stale!)).toContain("flux");
    expect(describeAliasChoice(stale!)).toContain("已经不可用");
  });

  it("never leaks baseUrl, keys or channelId into the manifest the brain sees", () => {
    const manifest = buildCapabilityManifest(aliases);
    expect(manifest.length).toBeGreaterThan(0);
    for (const item of aliases) {
      expect(manifest).not.toContain(item.channelId);
    }
    expect(manifest).not.toContain("relay.example.com");
    expect(manifest).not.toContain("channel-1");
    expect(manifest).not.toContain("Bearer");
    expect(manifest).not.toContain("sk-");
    // 大脑看到的只有别名和参数——真实模型 ID 本身也是解析目标，一样不外泄
    expect(manifest).toContain("alias=gemini");
    expect(manifest).not.toContain("gemini-3-pro-image");
    // 但能力参数必须给到，否则大脑没法选
    expect(manifest).toContain("图生图=✔");
    expect(manifest).toContain("视觉=✔");
  });
});

describe("shouldConfirm", () => {
  it("only ever gates video", () => {
    for (const tool of ["generate_image", "edit_image", "optimize_prompt", "set_canvas", "ask", "reply"] as const) {
      for (const policy of ["always", "auto_only", "never"] as const) {
        expect(shouldConfirm(tool, true, policy)).toBe(false);
      }
    }
  });

  it("follows the policy for video", () => {
    // 用户直接说「生成个视频」不该被拦；链条上接的视频才符合「我想保留一气呵成」
    expect(shouldConfirm("generate_video", false, "auto_only")).toBe(false);
    expect(shouldConfirm("generate_video", true, "auto_only")).toBe(true);
    expect(shouldConfirm("generate_video", false, "always")).toBe(true);
    expect(shouldConfirm("generate_video", false, "never")).toBe(false);
    expect(shouldConfirm("generate_video", true, "never")).toBe(false);
  });
});

describe("mergeConfirmArgs", () => {
  const stored = {
    prompt: "一只猫", alias: "seedance", duration: 5, resolution: "720p", audio: false, mode: "first-frame",
  };

  it("applies the knobs the card exposes", () => {
    const merged = mergeConfirmArgs("generate_video", stored, {
      duration: 8, resolution: "1080p", audio: true, promptExtend: false,
    });
    expect(merged).toMatchObject({ duration: 8, resolution: "1080p", audio: true, promptExtend: false });
    expect(merged.prompt).toBe("一只猫");
  });

  it("refuses to let the card swap the model", () => {
    // 卡片上那行模型是展示用的。真放开了，页面写着 A 却跑了 B，是最难查的一类 bug
    const merged = mergeConfirmArgs("generate_video", stored, { alias: "wan", model: "other", mode: "text-to-video" });
    expect(merged.alias).toBe("seedance");
    expect(merged.mode).toBe("first-frame");
    expect(merged).not.toHaveProperty("model");
  });

  it("treats a blank field as untouched instead of wiping the channel default", () => {
    const merged = mergeConfirmArgs("generate_video", stored, { resolution: "   ", prompt: "" });
    expect(merged.resolution).toBe("720p");
    expect(merged.prompt).toBe("一只猫");
  });

  it("leaves non-video calls alone", () => {
    expect(mergeConfirmArgs("generate_image", { prompt: "a" }, { duration: 9 })).toEqual({ prompt: "a" });
    expect(mergeConfirmArgs(null, stored, { duration: 9 })).toEqual(stored);
    expect(mergeConfirmArgs("generate_video", stored, undefined)).toEqual(stored);
  });
});

describe("canvas group", () => {
  it("follows a newly produced image", () => {
    expect(canvasAfterProducing(["old"], "generate_image", "new")).toEqual(["new"]);
    expect(canvasAfterProducing(["old"], "edit_image", "new")).toEqual(["new"]);
    expect(canvasAfterProducing([], "generate_image", "new")).toEqual(["new"]);
  });

  it("never points the canvas at a video", () => {
    // 指到视频上之后，「把这张改一下」就没有图可改了
    expect(canvasAfterProducing(["old"], "generate_video", "video-1")).toEqual(["old"]);
    expect(canvasAfterProducing(["old"], "optimize_prompt", "text-1")).toEqual(["old"]);
  });

  it("leaves the canvas alone when the tool produced nothing", () => {
    expect(canvasAfterProducing(["old"], "generate_image", undefined)).toEqual(["old"]);
    expect(canvasAfterProducing([], "generate_image", undefined)).toEqual([]);
  });

  it("replaces a multi-image canvas with the fresh product, not append to it", () => {
    // 一组参考图用完就散：留着它们的话，下一次「再改改」会悄悄把旧参考又发一遍
    expect(canvasAfterProducing(["a", "b", "c"], "edit_image", "d")).toEqual(["d"]);
  });
});

describe("confirm args round-trip", () => {
  it("persists edited video args so a reload shows what will actually run", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-agent-db-"));
    const db = new AppDatabase(dataDir);
    cleanups.push(() => { db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const conversation = db.createConversation({
      title: "画一只猫", brainChannelId: "c1", brainModel: "m1",
      videoConfirmPolicy: "auto_only", visionEnabled: true,
    });
    const message = db.appendMessage({
      conversationId: conversation.id, role: "assistant", toolName: "generate_video",
      toolArgs: { prompt: "一只猫", duration: 5 },
    });
    expect(db.getMessage(message.id)?.toolArgs).toEqual({ prompt: "一只猫", duration: 5 });

    db.updateMessage(message.id, { toolArgs: { prompt: "一只猫", duration: 8 } });
    expect(db.getMessage(message.id)?.toolArgs).toEqual({ prompt: "一只猫", duration: 8 });
  });
});

describe("conversational turn, end to end", () => {
  it("runs brain → image → canvas → brain → answer, leaking nothing to the brain", async () => {
    const seenChatBodies: string[] = [];
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const BRAIN_KEY = "sk-brain-secret-value";

    const mock = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        if (req.url?.includes("/chat/completions")) {
          seenChatBodies.push(body);
          // 第一次让它画图，第二次收尾。够真实：大脑是**看在眼里**的
          const plan = seenChatBodies.length === 1
            ? { tool: "generate_image", args: { prompt: "一只戴草帽的橘猫" }, say: "这就画。" }
            : { tool: "reply", args: { text: "画好了，还满意吗？" }, say: "画好了。" };
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(plan) } }] }));
          return;
        }
        res.end(JSON.stringify({ data: [{ b64_json: pngBase64 }] }));
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { mock.close(() => resolve()); }));
    const address = mock.address();
    if (!address || typeof address === "string") throw new Error("mock server did not start");
    const base = `http://127.0.0.1:${address.port}`;

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-agent-e2e-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const brain = (await request(app).post("/api/channels").send({
      name: "Brain", baseUrl: base, adapterType: "openai-chat", authType: "bearer",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
      models: ["deepseek-v4-1-flash"], allowPrivateNetwork: true, enabled: true,
    }).expect(201)).body.data;
    // 密钥只进 KeyStore（等价于 .env），不落库、不进诊断
    context.sessionKeys.set(brain.id, BRAIN_KEY);

    const image = (await request(app).post("/api/channels").send({
      name: "Images", baseUrl: base, adapterType: "openai-images", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations",
      models: ["mock-image"], allowPrivateNetwork: true, enabled: true,
    }).expect(201)).body.data;

    const brains = (await request(app).get("/api/agent/brains").expect(200)).body.data;
    expect(brains.map((item: { id: string }) => item.id)).toEqual([brain.id]);

    const conversationId = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id as string;
    await request(app).post(`/api/conversations/${conversationId}/messages`).send({ text: "画一只戴草帽的橘猫" }).expect(202);

    let view: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      view = (await request(app).get(`/api/conversations/${conversationId}`).expect(200)).body.data;
      const status = (view as { status: string }).status;
      const messages = (view as { messages: Array<{ role: string }> }).messages;
      if (status === "idle" && messages.some((item) => item.role === "tool")) break;
    }

    type Row = {
      role: string; content: string | null; toolName: string | null;
      toolResult: { ok: boolean; assetId?: string; mimeType?: string } | null; assetId: string | null;
    };
    const messages = (view as unknown as { messages: Row[] }).messages;
    // 用户 → 计划 → 工具结果 → 收尾回答
    expect(messages.map((item) => item.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(messages[1]!.toolName).toBe("generate_image");
    expect(messages[2]!.toolResult?.ok).toBe(true);
    expect(messages[3]!.content).toBe("画好了，还满意吗？");

    // §10.1 规则 1：画布自动落到新产物上，而且它是**图片**，缩略图和原图都拿得到
    const producedId = messages[2]!.assetId!;
    expect(producedId).toBeTruthy();
    expect((view as { canvasAssetIds: string[] }).canvasAssetIds).toEqual([producedId]);
    const canvas = (view as { canvasImages: Array<{ id: string; thumbUrl: string | null }> }).canvasImages;
    expect(canvas).toHaveLength(1);
    expect(canvas[0]!.id).toBe(producedId);
    await request(app).get(`/api/assets/${producedId}/file`).expect(200);
    await request(app).get(`/api/assets/${producedId}/thumb`).expect(200);
    expect((await request(app).get(`/api/assets/${producedId}/file`).expect(200)).headers["content-type"]).toContain("image/");

    // 卡片靠 toolResult.mimeType 决定缩略图用 <img> 还是 <video>（问题 3）；
    // 少了它，视频结果那张卡只能当图片渲染
    expect(messages[2]!.toolResult?.mimeType).toContain("image/");
    const media = (view as { mediaAssets: Array<{ asset: { id: string } }> }).mediaAssets;
    expect(media.map((item) => item.asset.id)).toEqual([producedId]);

    // §19 的泄漏断言，在**真实发出去的那一份**上做，而不是在拼好的字符串上
    expect(seenChatBodies).toHaveLength(2);
    const firstChat = seenChatBodies[0]!;
    expect(firstChat).not.toContain(BRAIN_KEY);
    expect(firstChat).not.toContain(brain.id);
    expect(firstChat).not.toContain(image.id);
    expect(firstChat).not.toContain(base);
    expect(firstChat).not.toContain("apiKey");
    expect(firstChat).not.toContain("channelId");
    // 但别名清单必须真的喂进去了，否则上面那几条断言是空过
    expect(firstChat).toContain("alias=mock-image");

    // 第一张图已经产出，第二次调用大脑时它应当知道「现在画布是这张」
    expect(seenChatBodies[1]!).toContain("alias=mock-image");

    await request(app).delete(`/api/conversations/${conversationId}`).expect(200);
    expect((await request(app).get("/api/conversations").expect(200)).body.data).toHaveLength(0);
  });
});

describe("brain down, end to end", () => {
  /**
   * §15 直通模式。计划里写的是「大脑不可用就直接按原话生成」，落地改成了「先问一句」——
   * 所以这里断言的重点有两个：**退化出口真的出现了**，以及**在用户点头之前一个任务都没提交**。
   * 后者才是这条测试的价值：静默花钱是这个工作区最不能犯的错。
   */
  it("offers a one-click fallback instead of silently spending, and never leaks the relay error", async () => {
    const imagePrompts: string[] = [];
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    let chatCalls = 0;

    const mock = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (req.url?.includes("/chat/completions")) {
          chatCalls += 1;
          // 带上一个「会泄漏」的返回体：上游报错里回显了请求内容，看看我们是不是原样存下来
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "upstream exploded at https://relay.internal.example/v1" } }));
          return;
        }
        imagePrompts.push(JSON.parse(body).prompt as string);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ b64_json: pngBase64 }] }));
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { mock.close(() => resolve()); }));
    const address = mock.address();
    if (!address || typeof address === "string") throw new Error("mock server did not start");
    const base = `http://127.0.0.1:${address.port}`;

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-agent-down-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const brain = (await request(app).post("/api/channels").send({
      name: "Brain", baseUrl: base, adapterType: "openai-chat", authType: "bearer",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
      models: ["deepseek-v4-1-flash"], allowPrivateNetwork: true, enabled: true,
    }).expect(201)).body.data;
    context.sessionKeys.set(brain.id, "sk-brain-secret-value");

    await request(app).post("/api/channels").send({
      name: "Images", baseUrl: base, adapterType: "openai-images", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations",
      models: ["mock-image"], allowPrivateNetwork: true, enabled: true,
    }).expect(201);

    const conversationId = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id as string;
    const raw = "一只戴草帽的橘猫，水彩风";
    await request(app).post(`/api/conversations/${conversationId}/messages`).send({ text: raw }).expect(202);

    type Msg = { id: string; role: string; content: string | null; toolName: string | null; toolArgs: Record<string, unknown> | null; confirm: { reason: string; prompt: string; message: string } | null };
    let view: { status: string; messages: Msg[] } = { status: "", messages: [] };
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      view = (await request(app).get(`/api/conversations/${conversationId}`).expect(200)).body.data;
      if (view.status === "awaiting_confirmation") break;
    }

    // 1) 退化出口出现了：等待确认，而不是一个红色报错收场
    expect(view.status).toBe("awaiting_confirmation");
    const card = view.messages.find((item) => item.confirm)!;
    expect(card).toBeTruthy();
    expect(card.confirm!.reason).toBe("brain_down");
    expect(card.toolName).toBe("generate_image");
    expect(card.toolArgs).toEqual({ prompt: raw });
    // 关键：**还没有提交任何生成任务**
    expect(imagePrompts).toEqual([]);

    // 2) 上游报错里回显的地址不能被原样存下来（会进 SQLite 和界面）
    const stored = JSON.stringify(view);
    expect(stored).not.toContain("relay.internal.example");

    // 3) 用户点了「按这句话生成」：原话当提示词真的生成，且没有再去骚扰已经挂掉的大脑
    const callsBeforeApprove = chatCalls;
    await request(app).post(`/api/conversations/${conversationId}/confirm`)
      .send({ messageId: card.id, decision: "approve" }).expect(200);

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      view = (await request(app).get(`/api/conversations/${conversationId}`).expect(200)).body.data;
      if (view.status === "idle") break;
    }
    expect(imagePrompts).toEqual([raw]);
    expect(view.status).toBe("idle");
    // 生成成功了就说生成成功——大脑接不上话是另一件事，不该说成失败
    expect(view.messages.some((item) => item.content?.includes("生成已经提交并完成"))).toBe(true);
    expect(view.messages.some((item) => item.content?.includes("用不了了"))).toBe(false);
    // 大脑已经挂了，别为了「点评一句」再打两轮无用的请求
    expect(chatCalls - callsBeforeApprove).toBeLessThanOrEqual(2);
  });
});

describe("conversation media split", () => {
  /**
   * 需求.md 问题 3 的现场。灯箱原来只在 `canvasAssets` 里找素材，而那一份**只有图片**，
   * 于是视频的 assetId 永远查不到、mimeType 永远是 undefined，灯箱就照旧按 `<img>` 渲染——
   * 用户看到的是一个裂图，外加一条只剩 `#711e ✕` 的 bar。
   *
   * 这里不碰网络，直接造素材行：要验的是 `buildView` 怎么分流，
   * 不是生成链路（那条链路由上面两个 e2e 覆盖）。
   */
  it("keeps a video out of the canvas but still hands it to the viewer", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-media-"));
    const { context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const conversation = context.db.createConversation({
      title: "猫", brainChannelId: "c1", brainModel: "m1",
      videoConfirmPolicy: "auto_only", visionEnabled: true,
    });

    // assets.task_id 没有外键，所以这里不必造一条真的 task 行
    const insert = (id: string, fileName: string, mimeType: string) => {
      context.db.insertAsset({
        id, taskId: "task-1", fileName, mimeType, byteSize: 1,
        relativePath: fileName, baseDir: context.db.assetsDir, sha256: id, thumbPath: "",
      });
      context.db.appendMessage({
        conversationId: conversation.id, role: "tool", content: `产物 ${id}`, assetId: id, taskId: "task-1",
      });
    };
    insert("img00001", "a.png", "image/png");
    insert("vid00001", "a.mp4", "video/mp4");

    const view = context.agent.buildView(conversation.id)!;
    expect(view.sessionImages.map((item) => item.asset.id)).toEqual(["img00001"]);
    // 视频也要在里面——不在的话前端查不到它的 mimeType，灯箱就当图片渲染
    expect(view.mediaAssets.map((item) => item.asset.id)).toEqual(["img00001", "vid00001"]);
    // 而且视频的 mimeType 必须真的能拿到，光有 assetId 不够
    expect(view.mediaAssets.find((item) => item.asset.id === "vid00001")?.asset.mimeType).toBe("video/mp4");
  });
});
