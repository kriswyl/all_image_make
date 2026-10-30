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
  mergeConfirmArgs, parsePlan, repairPlan, salvagePlan, shouldConfirm,
  withConfirmedVideoSelection,
} from "../src/server/agent";
import { DEFAULT_CONVERSATION_TITLE } from "../src/shared/agent-types";
import { TOOL_SCHEMAS } from "../src/server/agent-tools";
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

  it("把版本写进别名，不再按位置编号", () => {
    // 老做法是 seedance-1 / seedance-2（按出现顺序编号），和真实版本号对不上：
    // 用户按 sd-2.5 说，命中的却是 sd-2.0。别名要自带版本。
    const seedance = aliases.filter((item) => item.model.startsWith("sd-2"));
    expect(seedance.map((item) => item.alias).sort()).toEqual(["seedance-2.0", "seedance-2.5"]);
    expect(aliases.some((item) => item.model === "flux-pro")).toBe(false);
    expect(aliases.some((item) => item.model === "deepseek-v4-1-flash")).toBe(false);
  });

  it("resolves the variants a model actually writes", () => {
    const exact = resolveAlias(aliases, "gemini", "image");
    expect(exact?.model).toBe("gemini-3-pro-image");
    expect(exact?.usedFallback).toBe(false);
    expect(resolveAlias(aliases, "  GEMINI  ", "image")?.model).toBe("gemini-3-pro-image");
    expect(resolveAlias(aliases, "seedance", "video")?.usedFallback).toBe(false);
  });

  it("用户说版本号或直接说真实模型 ID 都要命中", () => {
    // 用户原话就是「用 seedance2.5」——没有分隔符
    expect(resolveAlias(aliases, "seedance2.5", "video")?.model).toBe("sd-2.5");
    expect(resolveAlias(aliases, "seedance-2.5", "video")?.model).toBe("sd-2.5");
    // 直接报真实模型 ID 也得认（他截图里说的就是 sd-2.5）
    expect(resolveAlias(aliases, "sd-2.5", "video")?.model).toBe("sd-2.5");
    expect(resolveAlias(aliases, "sd-2.0", "video")?.model).toBe("sd-2.0");
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
    for (const tool of ["generate_image", "edit_image", "view_images", "optimize_prompt", "set_canvas", "ask", "reply"] as const) {
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

describe("withConfirmedVideoSelection", () => {
  it("新卡片按 videoInputs 把选中的图和模式写回参数", () => {
    const args = withConfirmedVideoSelection({ prompt: "x" }, {
      reason: "video_policy", prompt: "x", model: "m", channelName: "", mode: "first-last-frame",
      videoInputs: [
        { assetId: "a", role: "first_frame" },
        { assetId: "b", role: "last_frame" },
      ],
      message: "",
    });
    expect(args.imageRefs).toEqual(["a", "b"]);
    expect(args.mode).toBe("first-last-frame");
  });

  it("升级前的老卡片按当时显示的 referenceAssetId 补成首帧；Grok 改成 reference", () => {
    const legacy = {
      reason: "video_policy" as const, prompt: "x", model: "m", channelName: "",
      referenceAssetId: "old", message: "",
    };
    expect(withConfirmedVideoSelection({ prompt: "x" }, legacy).imageRefs).toEqual(["old"]);
    expect(withConfirmedVideoSelection({ prompt: "x" }, { ...legacy, adapterType: "grok-video" }).mode).toBe("reference");
  });

  it("已经写了 imageRefs 的不再覆盖", () => {
    const args = { prompt: "x", imageRefs: ["explicit"] };
    expect(withConfirmedVideoSelection(args, {
      reason: "video_policy", prompt: "x", model: "m", channelName: "",
      referenceAssetId: "old", message: "",
    })).toEqual(args);
  });
});

describe("confirm args round-trip", () => {
  it("persists edited video args so a reload shows what will actually run", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-agent-db-"));
    const db = new AppDatabase(dataDir);
    cleanups.push(() => { db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const conversation = db.createConversation({
      title: "画一只猫", brainChannelId: "c1", brainModel: "m1",
      videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
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
    const preview = await request(app).post("/api/html-previews").send({ html: "<script>document.body.textContent='ok'</script>" }).expect(200);
    const rendered = await request(app).get(`/api/html-previews/${preview.body.data.id}`).expect(200);
    expect(rendered.headers["content-security-policy"]).toContain("sandbox allow-scripts");
    expect(rendered.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(rendered.text).toContain("document.body.textContent");

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

    // 新产物只进素材库，不自动占用画布；图片本身仍然可读
    const producedId = messages[2]!.assetId!;
    expect(producedId).toBeTruthy();
    expect((view as { canvasAssetIds: string[] }).canvasAssetIds).toEqual([]);
    expect((view as { canvasImages: unknown[] }).canvasImages).toHaveLength(0);
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
      videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
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

describe("会话自动命名（对齐 Codex）", () => {
  /**
   * 会话名取第一条指令的前 20 个字。这里钉两件事：默认名会被顶替、超长要截断；
   * 以及**用户改过名之后不能再被覆盖**——后者是这条规则唯一的真实风险，
   * 覆盖了就等于「重命名」这个功能白点，而且每发一条消息名字都会被改回去。
   */
  it("把第一条指令当前几个字，但绝不覆盖用户改过的名字", async () => {
    const mock = http.createServer((req, res) => {
      req.on("data", () => undefined);
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        // 大脑只会「回一句话」：这条测试关心的是会话名，不是生成链路
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ tool: "reply", args: { text: "好" } }) } }] }));
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { mock.close(() => resolve()); }));
    const address = mock.address();
    if (!address || typeof address === "string") throw new Error("mock server did not start");

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-agent-title-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const brain = (await request(app).post("/api/channels").send({
      name: "Brain", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat", authType: "bearer",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
      models: ["deepseek-v4-1-flash"], allowPrivateNetwork: true, enabled: true,
    }).expect(201)).body.data;
    context.sessionKeys.set(brain.id, "sk-brain-secret-value");

    /** 发一条消息，等到这一轮跑完再返回 */
    async function sendAndSettle(conversationId: string, text: string) {
      await request(app).post(`/api/conversations/${conversationId}/messages`).send({ text }).expect(202);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const view = (await request(app).get(`/api/conversations/${conversationId}`).expect(200)).body.data;
        if (view.status === "idle") return view as { title: string };
      }
      throw new Error("这一轮没跑完");
    }

    async function newConversation() {
      return (await request(app).post("/api/conversations").send({}).expect(201)).body.data;
    }

    // 短指令：原样当名字
    const shortOne = await newConversation();
    expect(shortOne.title).toBe(DEFAULT_CONVERSATION_TITLE);
    expect((await sendAndSettle(shortOne.id, "画一只戴草帽的橘猫站在向日葵地里")).title).toBe("画一只戴草帽的橘猫站在向日葵地里");

    // 长指令：截到 20 个字再加省略号，多行也折成一行
    const longOne = await newConversation();
    const longText = "帮我画一张赛博朋克夜景\n要有霓虹灯和雨，构图参考 Blade Runner，画幅 16:9";
    const longTitle = (await sendAndSettle(longOne.id, longText)).title;
    expect(longTitle).toBe(`${longText.replace(/\s+/g, " ").slice(0, 20)}…`);
    expect(longTitle).not.toContain("\n");

    // 改过名的不动：这才是「重命名」不失效的保证
    const renamed = await newConversation();
    await request(app).patch(`/api/conversations/${renamed.id}`).send({ title: "我的项目" }).expect(200);
    expect((await sendAndSettle(renamed.id, "再画一张")).title).toBe("我的项目");
  });
});

describe("generate_video 的 mode 兜底", () => {
  /**
   * 用户的实际现象：每次调 wan，第一次必报错，重试一次才成。
   * 根因是提示词里只列了参数名、没列合法值，大脑自己去发明（「image-to-video」这类），
   * 校验不通过 → 整轮失败 → 重新问一次大脑。这里钉住「写错也不该让整轮失败」。
   */
  it("不认识的值只丢掉这个字段，不让整次调用失败", () => {
    const bad = TOOL_SCHEMAS.generate_video.safeParse({ prompt: "做一个 2 秒视频", mode: "image-to-video" });
    expect(bad.success).toBe(true);
    expect(bad.success ? bad.data.mode : "unreachable").toBeUndefined();
    // 合法值照旧
    const good = TOOL_SCHEMAS.generate_video.safeParse({ prompt: "x", mode: "first-frame" });
    expect(good.success ? good.data.mode : null).toBe("first-frame");
    // 别的字段该报错还是要报错，别为了兜 mode 把整个 schema 变成来者不拒
    expect(TOOL_SCHEMAS.generate_video.safeParse({ mode: "first-frame" }).success).toBe(false);
  });
});

describe("本会话的图不重复", () => {
  /**
   * 用户的实际现象：在画布里来回切几次，同一张图就多出好几个副本。
   * 根因是 listConversationAssets 走 messages JOIN assets——产出它那条算一次，
   * 之后每次 set_canvas 也会落一条带 assetId 的消息。
   */
  it("同一个产物被多条消息引用时只出现一次，轮次号也不跳", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-agent-dupe-"));
    const { context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const conversation = context.db.createConversation({
      title: "去重", brainChannelId: "c1", brainModel: "m1",
      videoConfirmPolicy: "auto_only", visionEnabled: true, verbatimPrompt: false,
    });
    const addAsset = (id: string, taskId: string) => context.db.insertAsset({
      id, taskId, fileName: `${id}.png`, mimeType: "image/png", byteSize: 1,
      relativePath: `${id}.png`, baseDir: context.db.assetsDir, sha256: id, thumbPath: "",
    });
    const reference = (id: string, content: string) => context.db.appendMessage({
      conversationId: conversation.id, role: "tool", content, assetId: id, taskId: "task-1",
    });

    addAsset("img00001", "task-1");
    reference("img00001", "生图完成");
    // 第二次引用同一个产物：set_canvas 那一类消息也会带上 assetId
    reference("img00001", "已设为当前画布");
    // 第二张来自另一个任务；同一个 task 的多个产物（比如音乐两首）才共享轮次
    addAsset("img00002", "task-2");
    reference("img00002", "生图完成");

    const view = context.agent.buildView(conversation.id)!;
    expect(view.sessionImages.map((item) => item.asset.id)).toEqual(["img00001", "img00002"]);
    // 第 2 张要是第 2 轮，不能因为中间那条重复引用跳到第 3 轮
    expect(view.sessionImages.map((item) => item.round)).toEqual([1, 2]);
  });
});

describe("空会话不堆积", () => {
  /**
   * 用户的实际现象：侧栏一屏全是「新对话」——点一下「新对话」就多一条，
   * 但真正用过的没几条。空会话没有任何消息，也就没有产物和上传图，新建时顺手清掉不会丢东西。
   */
  it("新建时清掉之前没动过的空会话，动过的留下", async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-agent-empty-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    // 建会话要先有一个能当大脑的对话渠道。这条测试不真的发消息，所以不需要真能连通的地址；
    // 但地址得是回环（allowPrivateNetwork 才会跳过 DNS 检查），否则光建档就先失败了
    await request(app).post("/api/channels").send({
      name: "Brain", baseUrl: "http://127.0.0.1:1/v1", adapterType: "openai-chat", authType: "bearer",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
      models: ["mock-brain"], allowPrivateNetwork: true, enabled: true,
    }).expect(201);

    const first = (await request(app).post("/api/conversations").send({}).expect(201)).body.data;
    const second = (await request(app).post("/api/conversations").send({}).expect(201)).body.data;
    const afterTwo = (await request(app).get("/api/conversations").expect(200)).body.data;
    // 第一条还没用就被第二条顶掉了
    expect(afterTwo.map((item: { id: string }) => item.id)).toEqual([second.id]);
    expect(first.id).not.toBe(second.id);

    // 有消息的那条不算空壳，后面再建也不能动它
    context.db.appendMessage({ conversationId: second.id, role: "user", content: "画一只猫" });
    const third = (await request(app).post("/api/conversations").send({}).expect(201)).body.data;
    const afterThree = (await request(app).get("/api/conversations").expect(200)).body.data;
    expect(afterThree.map((item: { id: string }) => item.id).sort()).toEqual([second.id, third.id].sort());
  });
});

describe("视频做完，对话里有回音", () => {
  /**
   * 用户的实际反馈：「视频生成完了，好像并没有提醒」。
   *
   * 这条链路上有两件事都得成立：结果要**写回那条消息**（胶囊变成产物），
   * 而且要**自动起一轮**让大脑说一句「做好了」——只写库不吭声，
   * 用户对着一个已经跑完的界面是看不出区别的。测试把两步一起钉住。
   */
  it("任务结束会把结果写回消息，并让大脑接着说一句", async () => {
    let mockOrigin = "";
    let pollCount = 0;
    let videoSucceeded = false;
    let chatCalls = 0;

    const mock = http.createServer((req, res) => {
      if (req.url?.includes("/chat/completions")) {
        req.on("data", () => undefined);
        req.on("end", () => {
          chatCalls += 1;
          // 第一次让它去生视频；之后按「视频好了没有」如实回话——
          // 这样「做完之后的回音」一定是任务完成带来的，而不是第一轮就编出来的
          const plan = chatCalls === 1
            ? { tool: "generate_video", args: { prompt: "一只猫在跑", duration: 5 }, say: "这就去做。" }
            : { tool: "reply", args: { text: videoSucceeded ? "视频做好了。" : "还在做，稍等。" }, say: videoSucceeded ? "视频做好了。" : "还在做，稍等。" };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(plan) } }] }));
        });
        return;
      }
      if (req.url === "/api/v3/contents/generations/tasks" && req.method === "POST") {
        req.on("data", () => undefined);
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "cgt-1" }));
        });
        return;
      }
      if (req.url === "/api/v3/contents/generations/tasks/cgt-1" && req.method === "GET") {
        pollCount += 1;
        const done = pollCount >= 2;
        if (done) videoSucceeded = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(done
          ? { id: "cgt-1", status: "succeeded", content: { video_url: `${mockOrigin}/out.mp4` } }
          : { id: "cgt-1", status: "running" }));
        return;
      }
      if (req.url === "/out.mp4" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "video/mp4" });
        res.end(Buffer.from("fake-mp4-bytes"));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { mock.close(() => resolve()); }));
    const address = mock.address();
    if (!address || typeof address === "string") throw new Error("mock server did not start");
    mockOrigin = `http://127.0.0.1:${address.port}`;

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-agent-video-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const brain = (await request(app).post("/api/channels").send({
      name: "Brain", baseUrl: mockOrigin, adapterType: "openai-chat", authType: "bearer",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
      models: ["deepseek-v4-1-flash"], allowPrivateNetwork: true, enabled: true,
    }).expect(201)).body.data;
    context.sessionKeys.set(brain.id, "sk-brain");
    (await request(app).post("/api/channels").send({
      name: "Seedance", baseUrl: mockOrigin, adapterType: "seedance-video", authType: "bearer",
      authHeaderName: "", secretEnv: "", endpoint: "/api/v3/contents/generations/tasks",
      models: ["sd-2.5"], allowPrivateNetwork: true, enabled: true, apiKey: "sk-video",
    }).expect(201));

    // 直接生成，不弹确认卡片：这条测试只关心「做完之后有没有回音」
    const conversationId = (await request(app).post("/api/conversations").send({ videoConfirmPolicy: "never" }).expect(201)).body.data.id as string;
    await request(app).post(`/api/conversations/${conversationId}/messages`).send({ text: "用 seedance 做一个 5 秒视频" }).expect(202);

    type Msg = { role: string; content: string | null; toolName: string | null; assetId: string | null };
    let view: { status: string; messages: Msg[] } = { status: "", messages: [] };
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      view = (await request(app).get(`/api/conversations/${conversationId}`).expect(200)).body.data;
      if (view.status === "waiting_task") break;
    }
    expect(view.status).toBe("waiting_task");

    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      view = (await request(app).get(`/api/conversations/${conversationId}`).expect(200)).body.data;
      if (view.messages.some((message) => (message.content ?? "").includes("视频做好了"))) break;
    }

    expect(pollCount).toBeGreaterThanOrEqual(2);
    // 结果写回了那条消息：胶囊要靠 assetId 才能变成产物缩略图
    const videoMessage = view.messages.find((message) => message.role === "tool" && message.toolName === "generate_video");
    expect(videoMessage?.assetId).toBeTruthy();
    // 而且大脑真的被叫回来说了一句
    expect(view.messages.some((message) => (message.content ?? "").includes("视频做好了"))).toBe(true);
  });
});

describe("提交即失败也不会丢", () => {
  /**
   * 提交那一步就失败（渠道没配 key、上游直接拒）时，任务会比工具消息**先**结束。
   * 这一条钉住那个时间窗：事件到达时那行消息还不存在，`handleTaskEvent` 按 taskId
   * 找不到人接手，事情就会彻底丢掉——消息停在 pending、会话卡在 waiting_task，
   * 用户等不到任何回音。修法是落库之后再自查一次任务的终态。
   *
   * 这条测试当初是**先把 bug 复现出来**才写的：没修之前它会失败在「状态停在 pending」。
   */
  it("任务比消息先结束：失败照样写回消息，会话收回 idle", async () => {
    const mock = http.createServer((req, res) => {
      req.on("data", () => undefined);
      req.on("end", () => {
        if (req.url?.includes("/chat/completions")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ tool: "generate_video", args: { prompt: "一只猫在跑", duration: 5 }, say: "这就去做。" }) } }] }));
          return;
        }
        // 这条链路走不到这里：没有 key，请求根本发不出去
        res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { mock.close(() => resolve()); }));
    const address = mock.address();
    if (!address || typeof address === "string") throw new Error("mock server did not start");
    const origin = `http://127.0.0.1:${address.port}`;

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-agent-video-fail-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const brain = (await request(app).post("/api/channels").send({
      name: "Brain", baseUrl: origin, adapterType: "openai-chat", authType: "bearer",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
      models: ["deepseek-v4-1-flash"], allowPrivateNetwork: true, enabled: true,
    }).expect(201)).body.data;
    context.sessionKeys.set(brain.id, "sk-brain");
    // 故意不给 key
    (await request(app).post("/api/channels").send({
      name: "Seedance", baseUrl: origin, adapterType: "seedance-video", authType: "bearer",
      authHeaderName: "", secretEnv: "", endpoint: "/api/v3/contents/generations/tasks",
      models: ["sd-2.5"], allowPrivateNetwork: true, enabled: true,
    }).expect(201));

    const conversationId = (await request(app).post("/api/conversations").send({ videoConfirmPolicy: "never" }).expect(201)).body.data.id as string;
    await request(app).post(`/api/conversations/${conversationId}/messages`).send({ text: "用 seedance 做一个 5 秒视频" }).expect(202);

    type Msg = { role: string; content: string | null; toolName: string | null; status: string };
    let view: { status: string; messages: Msg[] } = { status: "", messages: [] };
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      view = (await request(app).get(`/api/conversations/${conversationId}`).expect(200)).body.data;
      if (view.status === "idle" && view.messages.some((message) => message.role === "tool")) break;
    }

    const videoMessage = view.messages.find((message) => message.role === "tool" && message.toolName === "generate_video");
    // 关键：不能停在 pending——那就是「用户等不到任何回音」的样子
    expect(videoMessage?.status).toBe("error");
    expect(videoMessage?.content ?? "").not.toContain("已提交");
    expect(view.status).toBe("idle");
  });
});

describe("引用已有产物", () => {
  /**
   * 用户从画布/消息里把已生成的图拖进输入框再发送时，只留一句文字是看不出他指的是哪几张的。
   * 引用的那几张要跟着**同一条消息**记下来（不是各开一条消息），气泡上照原样摆出来。
   */
  it("拖进来的图跟着这句话一起记，同一条消息", async () => {
    const mock = http.createServer((req, res) => {
      req.on("data", () => undefined);
      req.on("end", () => {
        // 大脑故意报错：这条测试只看用户消息有没有把引用记下来，
        // 用最省的方式跑完一轮（不会真的生成任何东西）
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "nope" } }));
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { mock.close(() => resolve()); }));
    const address = mock.address();
    if (!address || typeof address === "string") throw new Error("mock server did not start");
    const origin = `http://127.0.0.1:${address.port}`;

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-agent-refs-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const brain = (await request(app).post("/api/channels").send({
      name: "Brain", baseUrl: origin, adapterType: "openai-chat", authType: "bearer",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
      models: ["deepseek-v4-1-flash"], allowPrivateNetwork: true, enabled: true,
    }).expect(201)).body.data;
    context.sessionKeys.set(brain.id, "sk-brain");

    const conversationId = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id as string;
    await request(app).post(`/api/conversations/${conversationId}/messages`)
      .send({ text: "把这两张合起来", assetRefs: ["img-aaa", "img-bbb"] })
      .expect(202);

    type Msg = { role: string; content: string | null; assetRefs: string[] };
    let view: { messages: Msg[] } = { messages: [] };
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      view = (await request(app).get(`/api/conversations/${conversationId}`).expect(200)).body.data;
      if (view.messages.some((message) => message.content === "把这两张合起来")) break;
    }

    const userMessage = view.messages.find((message) => message.content === "把这两张合起来");
    expect(userMessage?.assetRefs).toEqual(["img-aaa", "img-bbb"]);
    // 一条消息装下全部引用，不是每张单开一条
    expect(view.messages.filter((message) => message.role === "user")).toHaveLength(1);
  });
});

describe("原话直发", () => {
  /**
   * 用户反馈「这个开关有时候切换不生效」。根因是它原本只写在系统提示词里——
   * 模型听不听全看心情。现在服务端在工具层直接把 prompt 换成用户那句话，
   * 大脑写什么都影响不了结果。这条测试就是钉住这件事：**请求体里必须是用户的原话**。
   */
  it("开了之后，出网的提示词是用户原话，大脑改写过的那版被丢掉", async () => {
    const imageBodies: string[] = [];
    let chatCalls = 0;

    const mock = http.createServer((req, res) => {
      if (req.url?.includes("/chat/completions")) {
        req.on("data", () => undefined);
        req.on("end", () => {
          chatCalls += 1;
          // 大脑**故意**改写：写成一段很具体的画面描述
          const plan = chatCalls === 1
            ? { tool: "generate_image", args: { prompt: "一只戴着草帽的橘色虎斑猫，坐在向日葵地里，逆光，胶片颗粒" }, say: "这就画。" }
            : { tool: "reply", args: { text: "画好了。" }, say: "画好了。" };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(plan) } }] }));
        });
        return;
      }
      if (req.url === "/v1/images/generations" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
          imageBodies.push(Buffer.concat(chunks).toString("utf8"));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { mock.close(() => resolve()); }));
    const address = mock.address();
    if (!address || typeof address === "string") throw new Error("mock server did not start");
    const origin = `http://127.0.0.1:${address.port}`;

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-agent-verbatim-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const brain = (await request(app).post("/api/channels").send({
      name: "Brain", baseUrl: origin, adapterType: "openai-chat", authType: "bearer",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
      models: ["deepseek-v4-1-flash"], allowPrivateNetwork: true, enabled: true,
    }).expect(201)).body.data;
    context.sessionKeys.set(brain.id, "sk-brain");
    (await request(app).post("/api/channels").send({
      name: "Images", baseUrl: origin, adapterType: "openai-images", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations",
      models: ["mock-image"], allowPrivateNetwork: true, enabled: true,
    }).expect(201));

    const conversationId = (await request(app).post("/api/conversations").send({ verbatimPrompt: true }).expect(201)).body.data.id as string;
    const userSaid = "一只戴草帽的橘猫，水彩风";
    await request(app).post(`/api/conversations/${conversationId}/messages`).send({ text: userSaid }).expect(202);

    // 等到这一轮真的落定：图传回来了不算完，任务还要落盘、写库、大脑还要收尾。
    // 不等就结束的话 teardown 会先把库关了，后台任务撞上去就是一句 "database is not open"
    let settled = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const view = (await request(app).get(`/api/conversations/${conversationId}`).expect(200)).body.data;
      if (imageBodies.length && view.status === "idle") { settled = true; break; }
    }
    expect(settled).toBe(true);

    expect(imageBodies).toHaveLength(1);
    expect(imageBodies[0]).toContain(userSaid);
    expect(imageBodies[0]).not.toContain("向日葵地里");
  });

  /** 关掉的时候照旧：润色是默认行为，效果更好 */
  it("没开的时候仍然用大脑改写过的版本", async () => {
    const imageBodies: string[] = [];
    let chatCalls = 0;
    const mock = http.createServer((req, res) => {
      if (req.url?.includes("/chat/completions")) {
        req.on("data", () => undefined);
        req.on("end", () => {
          chatCalls += 1;
          const plan = chatCalls === 1
            ? { tool: "generate_image", args: { prompt: "扩写过的画面描述" }, say: "这就画。" }
            : { tool: "reply", args: { text: "画好了。" }, say: "画好了。" };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(plan) } }] }));
        });
        return;
      }
      if (req.url === "/v1/images/generations" && req.method === "POST") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
          imageBodies.push(Buffer.concat(chunks).toString("utf8"));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] }));
        });
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => { mock.close(() => resolve()); }));
    const address = mock.address();
    if (!address || typeof address === "string") throw new Error("mock server did not start");
    const origin = `http://127.0.0.1:${address.port}`;

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "image-relay-agent-polish-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });

    const brain = (await request(app).post("/api/channels").send({
      name: "Brain", baseUrl: origin, adapterType: "openai-chat", authType: "bearer",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
      models: ["deepseek-v4-1-flash"], allowPrivateNetwork: true, enabled: true,
    }).expect(201)).body.data;
    context.sessionKeys.set(brain.id, "sk-brain");
    (await request(app).post("/api/channels").send({
      name: "Images", baseUrl: origin, adapterType: "openai-images", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations",
      models: ["mock-image"], allowPrivateNetwork: true, enabled: true,
    }).expect(201));

    const conversationId = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id as string;
    await request(app).post(`/api/conversations/${conversationId}/messages`).send({ text: "一只猫" }).expect(202);

    // 等到这一轮真的落定：图传回来了不算完，任务还要落盘、写库、大脑还要收尾。
    // 不等就结束的话 teardown 会先把库关了，后台任务撞上去就是一句 "database is not open"
    let settled = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const view = (await request(app).get(`/api/conversations/${conversationId}`).expect(200)).body.data;
      if (imageBodies.length && view.status === "idle") { settled = true; break; }
    }
    expect(settled).toBe(true);
    expect(imageBodies).toHaveLength(1);
    expect(imageBodies[0]).toContain("扩写过的画面描述");
  });
});

describe("普通聊天模式", () => {
  it("仅在长度截断时按会话设置自动续写并保存完整正文", async () => {
    const requests: any[] = [];
    const mock = http.createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk; });
      req.on("end", () => {
        requests.push(JSON.parse(data));
        const index = requests.length;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: index === 1 ? "第一段" : "第二段" }, finish_reason: index === 1 ? "length" : "stop" }] }));
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => mock.close(() => resolve())));
    const address = mock.address();
    if (!address || typeof address === "string") throw new Error("mock server did not start");
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "plain-continuation-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });
    const brain = (await request(app).post("/api/channels").send({ name: "Brain", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat", authType: "none", authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions", models: ["mock"], allowPrivateNetwork: true, enabled: true }).expect(201)).body.data;
    const id = (await request(app).post("/api/conversations").send({ brainChannelId: brain.id, brainModel: "mock" }).expect(201)).body.data.id;
    await request(app).patch(`/api/conversations/${id}`).send({ chatMode: "chat", chatAutoContinueLimit: 1 }).expect(200);
    expect(context.db.getConversation(id)?.chatAutoContinueLimit).toBe(1);
    await request(app).post(`/api/conversations/${id}/messages`).send({ text: "写长文" }).expect(202);
    for (let i = 0; i < 100 && context.db.getConversation(id)?.status !== "idle"; i++) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.some((message: any) => message.role === "assistant" && message.content === "第一段")).toBe(true);
    expect(context.db.listMessagesAfter(id, 0).some((message) => message.role === "assistant" && message.content === "第一段第二段")).toBe(true);
    await request(app).patch(`/api/conversations/${id}`).send({ chatAutoContinueLimit: 0 }).expect(200);
    expect(context.db.getConversation(id)?.chatAutoContinueLimit).toBe(0);
    await request(app).patch(`/api/conversations/${id}`).send({ chatAutoContinueLimit: 101 }).expect(400);
  });
  it("保留待确认操作，纯文本不执行工具，并在切换后正确回放历史", async () => {
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    let imageCalls = 0;
    const malicious = '{"tool":"generate_image","args":{"prompt":"猫"}}';
    const mock = http.createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk; });
      req.on("end", () => {
        if (req.url?.includes("/images/generations")) {
          imageCalls += 1;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] }));
          return;
        }
        requests.push(JSON.parse(data));
        const content = requests.length === 1 ? malicious : JSON.stringify({ tool: "reply", args: { text: "继续创作" } });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => mock.close(() => resolve())));
    const address = mock.address();
    if (!address || typeof address === "string") throw new Error("mock server did not start");
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "plain-chat-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });
    const brain = (await request(app).post("/api/channels").send({
      name: "Brain", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions", models: ["mock-brain"], allowPrivateNetwork: true, enabled: true,
    }).expect(201)).body.data;
    await request(app).post("/api/channels").send({ name: "Images", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-images", authType: "none", authHeaderName: "", secretEnv: "", endpoint: "/v1/images/generations", models: ["mock-image"], allowPrivateNetwork: true, enabled: true }).expect(201);
    const created = (await request(app).post("/api/conversations").send({ brainChannelId: brain.id, brainModel: "mock-brain" }).expect(201)).body.data;
    expect(created.chatMode).toBe("creative");
    const card = context.db.appendMessage({ conversationId: created.id, role: "assistant", status: "pending", content: "确认生成视频", toolName: "generate_image", toolArgs: { prompt: "猫" }, confirm: { reason: "session_limit", message: "确认吗？", prompt: "猫", model: "mock", channelName: "mock" } });
    await request(app).patch(`/api/conversations/${created.id}`).send({ chatMode: "chat" }).expect(200);
    const settle = async () => {
      for (let i = 0; i < 100; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        const view = (await request(app).get(`/api/conversations/${created.id}`).expect(200)).body.data;
        if (!view.running && view.status === "idle") return view;
      }
      throw new Error("聊天未完成");
    };
    await request(app).post(`/api/conversations/${created.id}/messages`).send({ text: "你好" }).expect(202);
    const plainView = await settle();
    expect(plainView.messages.find((m: any) => m.id === card.id).confirm).toBeTruthy();
    expect(plainView.messages.some((m: any) => m.role === "assistant" && m.content === malicious)).toBe(true);
    expect(plainView.taskCount).toBe(0);
    const plainContext = JSON.stringify(requests[0]!.messages);
    expect(plainContext).toContain("看不到画布图片");
    expect(plainContext).not.toContain("可用能力（modelHint");
    expect(plainContext).not.toContain('\\"tool\\":\\"generate_image\\"');
    await request(app).post(`/api/conversations/${created.id}/confirm`).send({ messageId: card.id, decision: "approve" }).expect(200);
    const afterConfirm = await settle();
    expect(imageCalls).toBe(1);
    expect(requests).toHaveLength(1);
    expect(afterConfirm.messages.find((m: any) => m.id === card.id).confirm).toBeNull();
    await request(app).patch(`/api/conversations/${created.id}`).send({ chatMode: "creative" }).expect(200);
    await request(app).post(`/api/conversations/${created.id}/messages`).send({ text: "继续" }).expect(202);
    await settle();
    expect(requests[1]!.messages.some((m) => m.role === "assistant" && typeof m.content === "string" && m.content.includes(malicious) && m.content.includes("非工具调用"))).toBe(true);
  });
});

describe("普通聊天视觉输入", () => {
  it("只发送本轮附件，不自动发送已有画布图片", async () => {
    const requests: any[] = [];
    const mock = http.createServer((req, res) => {
      let body = ""; req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        requests.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "你好" } }] }));
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => mock.close(() => resolve())));
    const address = mock.address(); if (!address || typeof address === "string") throw new Error("mock server did not start");
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "plain-vision-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });
    const brain = (await request(app).post("/api/channels").send({ name: "Brain", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat", authType: "none", endpoint: "/v1/chat/completions", models: ["mock-brain"], allowPrivateNetwork: true, enabled: true }).expect(201)).body.data;
    const id = (await request(app).post("/api/conversations").send({ brainChannelId: brain.id, brainModel: "mock-brain" }).expect(201)).body.data.id;
    await request(app).patch(`/api/conversations/${id}`).send({ chatMode: "chat" }).expect(200);
    const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const uploaded = (await request(app).post(`/api/conversations/${id}/uploads`).attach("images", image, { filename: "test.png", contentType: "image/png" }).expect(201)).body.data;
    const assetId = uploaded.canvasAssetIds[0];
    const send = async (text: string, assetRefs: string[] = []) => {
      await request(app).post(`/api/conversations/${id}/messages`).send({ text, assetRefs }).expect(202);
      for (let i = 0; i < 100; i++) { await new Promise((resolve) => setTimeout(resolve, 20)); const v = (await request(app).get(`/api/conversations/${id}`)).body.data; if (!v.running && v.status === "idle") return; }
      throw new Error("聊天未完成");
    };
    await send("描述图片", [assetId]);
    expect(JSON.stringify(requests[0].messages)).toContain("image_url");
    await send("从素材里再次发送", [assetId]);
    expect(JSON.stringify(requests[1].messages)).toContain("image_url");
    await send("继续聊天");
    expect(JSON.stringify(requests[2].messages)).not.toContain("image_url");
    expect(JSON.stringify(requests[2].messages)).toContain("本轮没有可供查看的图片");
  });
});

it("普通模式下后台任务完成只更新结果，不自动续跑", async () => {
  const { handleTaskEvent } = await import("../src/server/agent-task-events");
  const { vi } = await import("vitest");
  const conversation = { id: "chat", kind: "chat", chatMode: "chat", status: "waiting_task", autoContinueCount: 0 };
  const pending = { id: "message", taskId: "task", confirm: null, toolResult: { async: true, ok: true, summary: "已提交" } };
  const db = {
    findConversationByTask: () => conversation,
    listPendingMessages: () => [pending],
    getChannel: () => ({ adapterType: "seedance-video" }),
    updateMessage: vi.fn(), getMessage: () => ({ ...pending, status: "ok" }),
    setConversationStatus: vi.fn(), bumpAutoContinue: vi.fn(),
  };
  const startTurn = vi.fn();
  const host = { db, startTurn, broadcast: vi.fn(), hasActiveTurn: () => false, reportTurnFailure: vi.fn() };
  handleTaskEvent(host as any, { task: { id: "task", status: "succeeded", channelId: "video", model: "mock", assets: [{ id: "asset", mimeType: "video/mp4" }] } } as any);
  expect(db.updateMessage).toHaveBeenCalled();
  expect(db.setConversationStatus).toHaveBeenCalledWith("chat", "idle", { touch: false });
  expect(startTurn).not.toHaveBeenCalled();
});

describe("上下文压缩", () => {
  it("只压缩较早历史，保留原始记录和待确认操作的实时状态", async () => {
    const requests: any[] = [];
    const mock = http.createServer((req, res) => {
      let body = ""; req.on("data", (chunk) => { body += chunk; }); req.on("end", () => {
        requests.push(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "用户偏好水彩风格。" } }] }));
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => mock.close(() => resolve())));
    const address = mock.address(); if (!address || typeof address === "string") throw new Error("mock server did not start");
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-summary-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });
    const brain = (await request(app).post("/api/channels").send({ name: "Brain", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat", authType: "none", endpoint: "/v1/chat/completions", models: ["mock-brain"], allowPrivateNetwork: true, enabled: true }).expect(201)).body.data;
    const id = (await request(app).post("/api/conversations").send({ brainChannelId: brain.id, brainModel: "mock-brain" }).expect(201)).body.data.id;
    await request(app).patch(`/api/conversations/${id}`).send({ chatMode: "chat", contextBudget: 8000 }).expect(200);
    context.db.appendMessage({ conversationId: id, role: "user", content: "我喜欢水彩风格" });
    const card = context.db.appendMessage({ conversationId: id, role: "assistant", status: "pending", content: "确认生成", toolName: "generate_image", toolArgs: { prompt: "猫" }, confirm: { reason: "session_limit", message: "确认吗", prompt: "猫", model: "mock", channelName: "mock" } });
    for (let i = 0; i < 14; i++) {
      context.db.appendMessage({ conversationId: id, role: "user", content: `用户第 ${i} 轮 ${"文字".repeat(180)}` });
      context.db.appendMessage({ conversationId: id, role: "assistant", content: `回答 ${i}` });
    }
    const before = context.db.listMessagesAfter(id, 0);
    const { BrainRunner } = await import("../src/server/agent-brain");
    const events: any[] = [];
    const runner = new BrainRunner({ db: context.db, sessionKeys: context.sessionKeys, broadcast: (_id, event) => events.push(event) });
    const conversation = context.db.getConversation(id)!;
    await runner.prepareCompression(conversation, new AbortController());
    const saved = context.db.getContextSummary(id);
    expect(saved?.text).toBe("用户偏好水彩风格。");
    expect(saved?.anchorIds).toContain(card.id);
    expect(context.db.listMessagesAfter(id, 0)).toHaveLength(before.length);
    expect(events.some((event) => event.type === "context_summary")).toBe(true);
    expect(requests.length).toBeGreaterThan(0);
    context.db.updateMessage(card.id, { confirm: null, status: "error", errorMessage: "用户取消了这次生成" });
    const built = await runner.buildBrainMessages(conversation, []);
    const text = JSON.stringify(built.messages);
    expect(text).toContain("用户偏好水彩风格");
    expect(text).toContain("用户取消了这次生成");
    expect(text).toContain("用户第 13 轮");
    expect(text).not.toContain("用户第 0 轮");
    const view = (await request(app).get(`/api/conversations/${id}`).expect(200)).body.data;
    expect(view.messages).toHaveLength(before.length);
    expect(view.contextSummary.text).toBe("用户偏好水彩风格。");
  });

  it("摘要失败时不丢弃历史或覆盖旧摘要", async () => {
    const mock = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "" } }] })); });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => mock.close(() => resolve())));
    const address = mock.address(); if (!address || typeof address === "string") throw new Error("mock server did not start");
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "context-fail-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });
    const brain = (await request(app).post("/api/channels").send({ name: "Brain", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat", authType: "none", endpoint: "/v1/chat/completions", models: ["mock-brain"], allowPrivateNetwork: true, enabled: true }).expect(201)).body.data;
    const id = (await request(app).post("/api/conversations").send({ brainChannelId: brain.id, brainModel: "mock-brain" }).expect(201)).body.data.id;
    await request(app).patch(`/api/conversations/${id}`).send({ contextBudget: 4000 }).expect(200);
    for (let i = 0; i < 12; i++) context.db.appendMessage({ conversationId: id, role: "user", content: `第${i}条` });
    context.db.saveContextSummary(id, "旧摘要", 1, []);
    const { BrainRunner } = await import("../src/server/agent-brain");
    const runner = new BrainRunner({ db: context.db, sessionKeys: context.sessionKeys, broadcast: () => undefined });
    await runner.prepareCompression(context.db.getConversation(id)!, new AbortController());
    expect(context.db.getContextSummary(id)?.text).toBe("旧摘要");
    expect(context.db.getContextSummary(id)?.throughSeq).toBe(1);
    expect(context.db.listMessagesAfter(id, 1).some((item) => item.content === "第1条")).toBe(true);
    expect(context.db.listMessagesAfter(id, 0).some((item) => item.content?.includes("摘要不完整"))).toBe(true);
  });
});

it("默认 350k，可手动压缩并广播进度，保留最近对话", async () => {
  const mock = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "早期用户偏好：水彩。" } }] }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => mock.close(() => resolve())));
  const address = mock.address(); if (!address || typeof address === "string") throw new Error("mock server did not start");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "manual-summary-"));
  const { app, context } = createApp({ dataDir });
  cleanups.push(() => { context.db.close(); return fs.rm(dataDir, { recursive: true, force: true }); });
  const brain = (await request(app).post("/api/channels").send({ name: "Brain", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat", authType: "none", endpoint: "/v1/chat/completions", models: ["mock-brain"], allowPrivateNetwork: true, enabled: true }).expect(201)).body.data;
  const conversation = (await request(app).post("/api/conversations").send({ brainChannelId: brain.id, brainModel: "mock-brain" }).expect(201)).body.data;
  expect(conversation.contextBudget).toBe(350000);
  for (let i = 0; i < 12; i++) {
    context.db.appendMessage({ conversationId: conversation.id, role: "user", content: `第 ${i} 轮` });
    context.db.appendMessage({ conversationId: conversation.id, role: "assistant", content: `答案 ${i}` });
  }
  const events: any[] = [];
  const unsubscribe = context.agent.subscribe(conversation.id, (event) => events.push(event));
  const response = (await request(app).post(`/api/conversations/${conversation.id}/compress`).expect(200)).body.data;
  unsubscribe();
  expect(response.compressed).toBe(true);
  expect(events.filter((event) => event.type === "context_compression").map((event) => event.status)).toEqual(["started", "finished"]);
  expect(context.db.listMessagesAfter(conversation.id, 0)).toHaveLength(24);
  expect(context.db.getContextSummary(conversation.id)?.text).toContain("水彩");
  const { BrainRunner } = await import("../src/server/agent-brain");
  const runner = new BrainRunner({ db: context.db, sessionKeys: context.sessionKeys, broadcast: () => undefined });
  const built = await runner.buildBrainMessages(context.db.getConversation(conversation.id)!, []);
  expect(JSON.stringify(built.messages)).toContain("第 11 轮");
  expect(JSON.stringify(built.messages)).not.toContain("第 0 轮");
  const second = (await request(app).post(`/api/conversations/${conversation.id}/compress`).expect(200)).body.data;
  expect(second.compressed).toBe(false);
  expect(second.message).toContain("最近 8 轮");
  context.db.setConversationStatus(conversation.id, "waiting_task");
  await request(app).post(`/api/conversations/${conversation.id}/compress`).expect(409);
});
