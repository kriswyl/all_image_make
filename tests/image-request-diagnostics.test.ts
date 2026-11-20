import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { expect, it, vi } from "vitest";
import type { Diagnostic } from "../src/shared/types";
import { sendPreparedRequest } from "../src/server/adapters";
import { createApp } from "../src/server/app";

it("honors a configured request deadline beyond the transport header and body timeouts", async () => {
  const server = http.createServer((_req, res) => {
    const headersTimer = setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{");
      const bodyTimer = setTimeout(() => res.end('"data":[]}'), 1750);
      res.once("close", () => clearTimeout(bodyTimer));
    }, 1750);
    res.once("close", () => clearTimeout(headersTimer));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const previous = getGlobalDispatcher();
  const shortTimeouts = new Agent({ headersTimeout: 40, bodyTimeout: 40 });
  setGlobalDispatcher(shortTimeouts);
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock unavailable");
    const url = `http://127.0.0.1:${address.port}/v1/images/generations`;
    await expect(fetch(url, { signal: AbortSignal.timeout(5000) })).rejects.toMatchObject({ cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
    await expect(sendPreparedRequest({
      url, method: "POST", headers: { "Content-Type": "application/json" }, body: { prompt: "test" },
      allowPrivateNetwork: true, timeoutMs: 15 * 60_000,
    })).resolves.toMatchObject({ status: 200, payload: { data: [] } });
  } finally {
    setGlobalDispatcher(previous);
    await shortTimeouts.destroy();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10_000);

it.each([
  { scenario: "no headers", phase: "upstream", errorCode: "REQUEST_TIMEOUT", httpStatus: null },
  { scenario: "partial body", phase: "response_body", errorCode: "REQUEST_TIMEOUT", httpStatus: 200 },
  { scenario: "disconnect", phase: "upstream", errorCode: "REQUEST_NETWORK_ERROR", httpStatus: null },
  { scenario: "rate limit", phase: "upstream", errorCode: "REMOTE_REQUEST_FAILED", httpStatus: 429 },
  { scenario: "no image", phase: "parse_result", errorCode: "RESPONSE_PARSE_FAILED", httpStatus: null },
])("records the $scenario request stage", async ({ scenario, phase, errorCode, httpStatus }) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "chatcanvas-image-diagnostic-"));
  let dispatched = 0;
  const server = http.createServer((_req, res) => {
    dispatched++;
    if (scenario === "disconnect") { res.destroy(); return; }
    if (scenario === "no headers") return;
    res.writeHead(scenario === "rate limit" ? 429 : 200, {
      "content-type": "application/json", "x-request-id": "image-request-123",
    });
    if (scenario === "partial body") { res.write("{"); return; }
    res.end(scenario === "rate limit" ? '{"error":{"message":"模拟限流"}}' : '{"data":[]}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { app, context } = createApp({ dataDir });
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => originalTimeout(delay === 10_000 ? 450 : delay));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("mock unavailable");
    const channel = (await request(app).post("/api/channels").send({
      name: "Image test", baseUrl: `http://127.0.0.1:${address.port}`, adapterType: "openai-images", authType: "none",
      authHeaderName: "", secretEnv: "", endpoint: "", models: ["gpt-image"], allowPrivateNetwork: true, enabled: true,
    }).expect(201)).body.data;
    const task = (await request(app).post("/api/generations").send({
      channelId: channel.id, model: "gpt-image", prompt: "diagnostic test", timeoutMs: 10_000,
    }).expect(202)).body.data;
    const result = await context.runner.waitFor(task.id, { timeoutMs: 4000 });
    expect(dispatched).toBe(1);
    expect(result).toMatchObject({ status: "failed", errorCode });
    const diagnostics: Diagnostic[] = (await request(app).get(`/api/generations/${task.id}/diagnostics`).expect(200)).body.data;
    const failure = diagnostics[0]!;
    expect(failure).toMatchObject({ httpStatus, trace: {
      phase, outcome: "failed", startedAt: expect.any(String), finishedAt: expect.any(String), error: { code: errorCode },
    } });
    if (httpStatus !== null) expect(failure.trace).toMatchObject({ upstreamRequestId: "image-request-123", responseAt: expect.any(String) });
    if (phase === "parse_result") {
      expect(diagnostics[1]).toMatchObject({ httpStatus: 200, trace: { outcome: "succeeded", upstreamRequestId: "image-request-123" } });
    } else {
      expect(diagnostics).toHaveLength(1);
      expect(failure.trace?.timeoutMs).toBe(10_000);
    }
    if (scenario === "no headers") {
      expect(failure.trace?.responseAt).toBeUndefined();
      expect(failure.trace?.error?.message).toContain("未收到上游 HTTP 响应");
    }
    if (scenario === "partial body") expect(failure.trace?.error?.message).toContain("读取响应内容超时");
  } finally {
    timeoutSpy.mockRestore();
    context.agent.dispose();
    context.db.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }
});
