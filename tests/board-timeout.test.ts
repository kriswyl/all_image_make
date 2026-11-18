/**
 * 画布超时设置：视频默认 800 秒，节点可以自己改。
 *
 * 这里既钉住纯函数的默认值 / 夹取，也走一遍 generateBoardVideo，
 * 确认节点的 timeoutSeconds 真的换成了交给 TaskRunner 的 timeoutMs。
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { generateBoardVideo } from "../src/server/board-generation-video";
import { BOARD_TIMEOUT, configNodeSchema, resolveBoardTimeoutMs, type BoardDoc, type ConfigBoardNode, type BoardNode } from "../src/shared/board";
import type { GenerationInput, Task } from "../src/shared/types";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function tempDb() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-board-timeout-"));
  const created = createApp({ dataDir });
  cleanups.push(async () => {
    created.context.db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return created.context.db;
}

function nodeBase(ref: string, type: BoardNode["type"], extra: Record<string, unknown> = {}): BoardNode {
  const at = new Date().toISOString();
  return { id: `node-${ref}`, ref, type, x: 0, y: 0, width: 300, height: 200, title: ref, createdAt: at, updatedAt: at, ...extra } as BoardNode;
}

describe("画布超时换算", () => {
  it("不填时按类型取默认值，视频是 800 秒", () => {
    expect(BOARD_TIMEOUT.defaults).toMatchObject({ image: 300, video: 800 });
    expect(resolveBoardTimeoutMs("video", undefined)).toBe(800_000);
    expect(resolveBoardTimeoutMs("image", undefined)).toBe(300_000);
    expect(resolveBoardTimeoutMs("audio", undefined)).toBe(900_000);
    expect(resolveBoardTimeoutMs("text", undefined)).toBe(240_000);
  });

  it("填了就照填的算，并夹在 10–1800 秒之间", () => {
    expect(resolveBoardTimeoutMs("video", 1_200)).toBe(1_200_000);
    expect(resolveBoardTimeoutMs("video", 1)).toBe(BOARD_TIMEOUT.minSeconds * 1_000);
    expect(resolveBoardTimeoutMs("video", 99_999)).toBe(BOARD_TIMEOUT.maxSeconds * 1_000);
    // 非法值退回默认，不会变成 0 秒
    expect(resolveBoardTimeoutMs("video", Number.NaN)).toBe(800_000);
    expect(resolveBoardTimeoutMs("video", 0)).toBe(800_000);
  });

  it("配置节点的 timeoutSeconds 走 schema 校验，越界值不收", () => {
    const base = {
      id: "node-n1", ref: "n1", type: "config", x: 0, y: 0, width: 300, height: 200,
      title: "n1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), mode: "video",
    };
    expect(configNodeSchema.safeParse({ ...base, timeoutSeconds: 800 }).success).toBe(true);
    expect(configNodeSchema.safeParse({ ...base, timeoutSeconds: 5 }).success).toBe(false);
    expect(configNodeSchema.safeParse({ ...base, timeoutSeconds: 2_000 }).success).toBe(false);
    expect(configNodeSchema.parse({ ...base }).timeoutSeconds).toBeUndefined();
  });
});

describe("画布视频超时落到任务上", () => {
  async function runVideo(timeoutSeconds?: number) {
    const db = await tempDb();
    db.saveChannel({
      name: "Mock video",
      baseUrl: "http://127.0.0.1:1",
      adapterType: "wan-video",
      authType: "none",
      authHeaderName: "",
      secretEnv: "",
      endpoint: "/api/v1/services/aigc/video-generation/video-synthesis",
      models: ["wan-test"],
      allowPrivateNetwork: true,
      enabled: true,
    });

    const text = nodeBase("n1", "text", { text: "一只猫在雨里跑" });
    const config = nodeBase("n2", "config", {
      mode: "video",
      prompt: "电影感",
      useUpstreamText: true,
      count: 1,
      model: "wan-test",
      status: "idle",
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    }) as ConfigBoardNode;
    const doc: BoardDoc = {
      version: 1,
      nextRef: 3,
      nodes: [text, config],
      edges: [{ id: "edge-text", source: text.id, target: config.id, kind: "input", role: "text" }],
    };
    const board = db.createBoardRecord({ id: "board-1", title: "超时", threadConversationId: "thread-1", doc });

    const created: GenerationInput[] = [];
    const runner = {
      create: async (input: GenerationInput) => {
        created.push(input);
        return { id: "task-1", status: "running" } as unknown as Task;
      },
      cancel: () => ({ id: "task-1" }) as unknown as Task,
    };

    await generateBoardVideo({
      db,
      // 只用到 create / cancel，这里不必造完整 TaskRunner
      runner: runner as never,
      boardId: board.id,
      board: db.getBoardRecord(board.id)!,
      config,
      prompt: "电影感",
    });
    return created[0]!;
  }

  it("没填超时时视频按 800 秒提交", async () => {
    const generation = await runVideo();
    expect(generation.timeoutMs).toBe(800_000);
  });

  it("填了 120 秒就按 120 秒提交", async () => {
    const generation = await runVideo(120);
    expect(generation.timeoutMs).toBe(120_000);
  });
});
