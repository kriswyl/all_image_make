import http from "node:http";
import { expect, it } from "vitest";
import { callBrain } from "../src/server/brain";
import type { DbChannel } from "../src/server/db";

it("拼接流式工具调用与正文，也读取非流式工具调用", async () => {
  let requestCount = 0;
  const server = http.createServer((req, res) => {
    req.resume(); req.on("end", () => {
      requestCount++;
      if (requestCount === 1) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunks = [
          { choices: [{ delta: { content: "正在处理", tool_calls: [{ index: 0, id: "c1", function: { name: "doc_", arguments: '{"con' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "create", arguments: 'tent":"你好"}' } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "doc_create", arguments: "" } }] }, finish_reason: "tool_calls" }] },
        ];
        for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.end("data: [DONE]\n\n");
      } else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "doc_list", arguments: "{}" } }] }, finish_reason: "tool_calls" }] })); }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address(); if (!address || typeof address === "string") throw new Error("mock");
    const channel = { id: "1", name: "mock", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-chat", authType: "none", endpoint: "/v1/chat/completions", allowPrivateNetwork: true } as DbChannel;
    const options = { channel, key: "", model: "test", messages: [{ role: "user" as const, content: "创建" }] };
    const first = await callBrain(options); expect(first.content).toBe("正在处理"); expect(first.toolCalls).toEqual([{ id: "c1", name: "doc_create", arguments: '{"content":"你好"}' }]);
    const second = await callBrain(options); expect(second.toolCalls).toEqual([{ id: "c2", name: "doc_list", arguments: "{}" }]);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
