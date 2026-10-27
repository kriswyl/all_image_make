import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { BRAIN_DEFAULT_MAX_TOKENS, BRAIN_RETRY_MAX_TOKENS } from "../src/server/brain";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe("推理模型空正文自救", () => {
  it("第一次把额度全用在 reasoning 上，自动加长 max_tokens 再请求一次", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        bodies.push(body);
        res.writeHead(200, { "content-type": "application/json" });
        if (bodies.length === 1) {
          res.end(JSON.stringify({
            choices: [{
              message: { role: "assistant", content: "", reasoning_content: "很长很长的思考过程" },
              finish_reason: "length",
            }],
            usage: { prompt_tokens: 10000, completion_tokens: 4096, reasoning_tokens: 4096 },
          }));
          return;
        }
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: JSON.stringify({ tool: "reply", args: { text: "拆好了" }, say: "拆好了" }),
            },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 10000, completion_tokens: 80, reasoning_tokens: 40 },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-brain-retry-"));
    const { app, context } = createApp({ dataDir });
    cleanups.push(async () => {
      context.db.close();
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    await request(app).post("/api/channels").send({
      name: "Retry brain", baseUrl: base, adapterType: "openai-chat", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "/v1/chat/completions",
      models: ["deepseek-v4-1-flash"], allowPrivateNetwork: true, enabled: true,
    }).expect(201);
    const conversationId = (await request(app).post("/api/conversations").send({}).expect(201)).body.data.id as string;
    await request(app).post(`/api/conversations/${conversationId}/messages`).send({ text: "拆一下" }).expect(202);

    type Message = { role: string; content: string | null; status: string };
    let messages: Message[] = [];
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      messages = (await request(app).get(`/api/conversations/${conversationId}`).expect(200)).body.data.messages;
      if (messages.some((message) => message.role === "assistant" && message.content?.includes("拆好了"))) break;
    }

    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.max_tokens).toBe(BRAIN_DEFAULT_MAX_TOKENS);
    expect(bodies[1]!.max_tokens).toBe(BRAIN_RETRY_MAX_TOKENS);
    expect(messages.some((message) => message.role === "assistant" && message.content?.includes("拆好了"))).toBe(true);
    expect(messages.some((message) => message.status === "error" && message.content?.includes("大脑没有返回内容"))).toBe(false);
  });
});
