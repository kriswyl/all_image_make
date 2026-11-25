import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Gitee 发布脚本的回归测试。
 *
 * 这里守的是四种「脚本报告成功、客户端却拿不到更新」的故障：
 *   1. 读不到线上清单却把它删了；
 *   2. 清单版本倒退；
 *   3. 同名附件等长但内容不同（只比大小会漏）；
 *   4. 内容真的相同时要能幂等跳过。
 *
 * 脚本是 CLI，通过 mock 全局 fetch 来模拟 Gitee 的响应。
 */
// @ts-ignore 脚本是 .mjs，没有类型声明
const mod = await import("../scripts/publish-gitee-release.mjs");
const { compareVersions, attach, replaceManifest } = mod as {
  compareVersions: (a: string, b: string) => number;
  attach: (release: unknown, file: string, options?: { immutable?: boolean }) => Promise<void>;
  replaceManifest: (release: unknown, file: string, options?: { allowDowngrade?: boolean }) => Promise<void>;
};

let dir = "";
const calls: string[] = [];

function writeTemp(name: string, content: string | Buffer) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

function manifestAsset(url = "https://example.com/latest.json") {
  return { id: 9, name: "latest.json", browser_download_url: url };
}

function releaseWith(assets: Array<{ id: number; name: string; browser_download_url: string }>, id = 1) {
  return { id, assets };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitee-test-"));
  calls.length = 0;
  process.env.GITEE_TOKEN = "test-token";
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.GITEE_TOKEN;
});

describe("compareVersions", () => {
  it("按数字比较，不按字典序", () => {
    expect(compareVersions("2.4.10", "2.4.9")).toBe(1);
    expect(compareVersions("2.4.9", "2.4.10")).toBe(-1);
    expect(compareVersions("2.4.7", "2.4.7")).toBe(0);
    expect(compareVersions("2.5.0", "2.4.99")).toBe(1);
  });
});

describe("replaceManifest", () => {
  it("线上清单读不到时直接失败，且不发出删除请求", async () => {
    vi.stubGlobal("fetch", async (input: string | URL, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      // 只有清单的下载地址返回 503，模拟对象存储抖动
      return new Response("", { status: 503 });
    });

    const release = releaseWith([manifestAsset()]);
    const file = writeTemp("latest.json", JSON.stringify({ version: "2.4.8", platforms: {} }));

    await expect(replaceManifest(release, file)).rejects.toThrow(/读取失败/);
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);
    // 附件列表不能被改动
    expect(release.assets).toHaveLength(1);
  });

  it("清单内容不是合法 JSON 时拒绝覆盖", async () => {
    vi.stubGlobal("fetch", async (input: string | URL, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return new Response("<html>login</html>", { status: 200 });
    });

    const release = releaseWith([manifestAsset()]);
    const file = writeTemp("latest.json", JSON.stringify({ version: "2.4.8", platforms: {} }));

    await expect(replaceManifest(release, file)).rejects.toThrow(/不是合法 JSON/);
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);
  });

  it("线上版本更高时拒绝降级", async () => {
    vi.stubGlobal("fetch", async (input: string | URL, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      return new Response(JSON.stringify({ version: "2.5.0", platforms: {} }), { status: 200 });
    });

    const release = releaseWith([manifestAsset()]);
    const file = writeTemp("latest.json", JSON.stringify({ version: "2.4.8", platforms: {} }));

    await expect(replaceManifest(release, file)).rejects.toThrow(/版本会倒退/);
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);
  });

  it("显式允许时才放过降级", async () => {
    vi.stubGlobal("fetch", async (input: string | URL, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (init?.method === "POST") return new Response("{}", { status: 201 });
      return new Response(JSON.stringify({ version: "2.5.0", platforms: {} }), { status: 200 });
    });

    const release = releaseWith([manifestAsset()]);
    const file = writeTemp("latest.json", JSON.stringify({ version: "2.4.8", platforms: {} }));

    await expect(replaceManifest(release, file, { allowDowngrade: true })).resolves.toBeUndefined();
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(true);
  });
});

describe("attach", () => {
  it("同名附件等长但内容不同必须拒绝（只比大小会漏）", async () => {
    const local = Buffer.from("BUILD-AAAA-111");
    const online = Buffer.from("BUILD-BBBB-222"); // 同长度、不同内容
    expect(local.length).toBe(online.length);

    vi.stubGlobal("fetch", async () => new Response(new Uint8Array(online), { status: 200 }));
    const release = releaseWith([{ id: 3, name: "setup.exe", browser_download_url: "https://example.com/setup.exe" }]);
    const file = writeTemp("setup.exe", local);

    await expect(attach(release, file)).rejects.toThrow(/内容和本次构建不同/);
  });

  it("内容完全一致时幂等跳过，不重复上传", async () => {
    const same = Buffer.from("SAME-BUILD");
    vi.stubGlobal("fetch", async (input: string | URL, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (init?.method === "POST") return new Response("{}", { status: 201 });
      return new Response(new Uint8Array(same), { status: 200 });
    });

    const release = releaseWith([{ id: 3, name: "setup.exe", browser_download_url: "https://example.com/setup.exe" }]);
    const file = writeTemp("setup.exe", same);

    await expect(attach(release, file)).resolves.toBeUndefined();
    expect(calls.some((call) => call.startsWith("POST"))).toBe(false);
  });

  it("线上附件读不到时不猜，直接失败", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 503 }));
    const release = releaseWith([{ id: 3, name: "setup.exe", browser_download_url: "https://example.com/setup.exe" }]);
    const file = writeTemp("setup.exe", Buffer.from("x"));

    await expect(attach(release, file)).rejects.toThrow(/读取失败/);
  });

  it("清单类附件允许覆盖（immutable: false）", async () => {
    vi.stubGlobal("fetch", async (input: string | URL, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (init?.method === "POST") return new Response("{}", { status: 201 });
      return new Response(new Uint8Array(Buffer.from("OLD")), { status: 200 });
    });

    const release = releaseWith([manifestAsset()]);
    const file = writeTemp("latest.json", JSON.stringify({ version: "2.4.8" }));

    await expect(attach(release, file, { immutable: false })).resolves.toBeUndefined();
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(true);
    expect(calls.some((call) => call.startsWith("POST"))).toBe(true);
  });
});
