import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import type { BoardDoc, BoardNode } from "../src/shared/board";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function tempApp() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-board-history-"));
  const created = createApp({ dataDir });
  cleanups.push(async () => {
    created.context.db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return created;
}

function textNode(ref: string, text: string): BoardNode {
  const at = new Date().toISOString();
  return {
    id: `node-${ref}`, ref, type: "text", x: 0, y: 0, width: 300, height: 180,
    title: ref, text, createdAt: at, updatedAt: at,
  };
}

describe("创作历史", () => {
  it("列出快照并恢复到旧版本，当前内容作为新版本保留", async () => {
    const { app } = await tempApp();
    const created = await request(app).post("/api/boards").send({ title: "历史测试" }).expect(201);
    const boardId = created.body.data.id as string;
    const v2doc: BoardDoc = { version: 1, nextRef: 2, nodes: [textNode("n1", "第一版")], edges: [] };
    const v2 = await request(app).put(`/api/boards/${boardId}`).send({ doc: v2doc, baseVersion: 1 }).expect(200);
    const v3doc: BoardDoc = { ...v2doc, nextRef: 3, nodes: [...v2doc.nodes, textNode("n2", "第二版")] };
    const v3 = await request(app).put(`/api/boards/${boardId}`).send({ doc: v3doc, baseVersion: v2.body.data.version }).expect(200);

    const history = await request(app).get(`/api/boards/${boardId}/history`).expect(200);
    expect(history.body.data.currentVersion).toBe(v3.body.data.version);
    expect(history.body.data.entries[0]).toMatchObject({ version: v3.body.data.version, current: true });
    expect(history.body.data.entries.some((entry: { version: number }) => entry.version === 2)).toBe(true);

    const restored = await request(app)
      .post(`/api/boards/${boardId}/history/2/restore`)
      .send({ baseVersion: v3.body.data.version })
      .expect(200);
    expect(restored.body.data.version).toBe(v3.body.data.version + 1);
    expect(restored.body.data.doc.nodes).toHaveLength(1);
    expect(restored.body.data.doc.nodes[0].text).toBe("第一版");

    const after = await request(app).get(`/api/boards/${boardId}/history`).expect(200);
    expect(after.body.data.entries[0]).toMatchObject({
      version: v3.body.data.version + 1,
      reason: `restore:2`,
      current: true,
    });
  });

  it("baseVersion 不匹配时返回 409，版本号不存在时 404", async () => {
    const { app } = await tempApp();
    const created = await request(app).post("/api/boards").send({ title: "历史冲突" }).expect(201);
    const boardId = created.body.data.id as string;
    const doc: BoardDoc = { version: 1, nextRef: 2, nodes: [textNode("n1", "a")], edges: [] };
    await request(app).put(`/api/boards/${boardId}`).send({ doc, baseVersion: 1 }).expect(200);

    await request(app).post(`/api/boards/${boardId}/history/1/restore`).send({ baseVersion: 1 }).expect(409);
    await request(app).post(`/api/boards/${boardId}/history/99/restore`).send({ baseVersion: 2 }).expect(404);
  });
});
