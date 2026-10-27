import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import { createBoardExport } from "../src/shared/board";
import type { BoardDoc, BoardNode } from "../src/shared/board";

const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function tempApp() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatcanvas-board-import-"));
  const created = createApp({ dataDir });
  cleanups.push(async () => {
    created.context.db.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return created;
}

function nodeBase(ref: string, type: BoardNode["type"], extra: Record<string, unknown> = {}): BoardNode {
  const at = new Date().toISOString();
  return {
    id: `node-${ref}`,
    ref,
    type,
    x: 0,
    y: 0,
    width: 300,
    height: 200,
    title: ref,
    createdAt: at,
    updatedAt: at,
    ...extra,
  } as BoardNode;
}

describe("无限画布导入 / 导出", () => {
  it("导入同一台机器上的导出文件时复用素材，并保留分组和连线", async () => {
    const { app, context } = await tempApp();
    const created = await request(app).post("/api/boards").send({ title: "源无限画布" }).expect(201);
    const boardId = created.body.data.id as string;
    const uploaded = await request(app)
      .post(`/api/boards/${boardId}/assets`)
      .attach("file", Buffer.from(pngBase64, "base64"), { filename: "scene.png", contentType: "image/png" })
      .expect(201);
    const assetId = uploaded.body.data.id as string;

    const text = nodeBase("n1", "text", { text: "雨夜巷口" });
    const image = nodeBase("n2", "image", { assetId, source: "upload", status: "succeeded" });
    const config = nodeBase("n3", "config", {
      mode: "image", prompt: "电影感", useUpstreamText: true, count: 1, status: "idle",
    });
    const doc: BoardDoc = {
      version: 1,
      nextRef: 4,
      nodes: [text, image, config],
      edges: [
        { id: "edge-1", source: text.id, target: config.id, kind: "input", role: "text" },
        { id: "edge-2", source: image.id, target: config.id, kind: "input", role: "reference" },
      ],
      groups: [{ id: "group-1", title: "开场参考", nodeIds: [text.id, image.id], collapsed: true }],
    };
    const saved = await request(app).put(`/api/boards/${boardId}`).send({ doc, baseVersion: 1 }).expect(200);

    const file = createBoardExport("导出的板", saved.body.data.doc);
    const imported = await request(app).post("/api/boards/import").send({ file }).expect(201);
    const importedBoard = imported.body.data.board;
    expect(imported.body.data.missingAssets).toEqual([]);
    expect(importedBoard.id).not.toBe(boardId);
    expect(importedBoard.title).toBe("导出的板");
    expect(importedBoard.doc.nodes).toHaveLength(3);
    expect(importedBoard.doc.edges).toHaveLength(2);
    expect(importedBoard.doc.groups).toMatchObject([{ title: "开场参考", collapsed: true }]);
    expect(importedBoard.doc.nodes.find((node: BoardNode) => node.id === image.id)).toMatchObject({ assetId });

    // 同一张素材现在同时属于两块无限画布
    const refs = context.db.findBoardAssetRefs(assetId).map((ref) => ref.boardId);
    expect(new Set(refs)).toEqual(new Set([boardId, importedBoard.id]));
    const assets = await request(app).get(`/api/boards/${importedBoard.id}/assets`).expect(200);
    expect(assets.body.data.map((asset: { id: string }) => asset.id)).toContain(assetId);
  });

  it("素材在当前安装里不存在时清空节点，并返回缺失的 ref", async () => {
    const { app } = await tempApp();
    const doc: BoardDoc = {
      version: 1,
      nextRef: 2,
      nodes: [nodeBase("n1", "image", {
        assetId: "00000000-0000-4000-8000-000000000000", source: "generated", status: "succeeded",
      })],
      edges: [],
    };
    const imported = await request(app).post("/api/boards/import").send({ file: doc }).expect(201);
    expect(imported.body.data.missingAssets).toEqual(["n1"]);
    expect(imported.body.data.board.doc.nodes[0]).toMatchObject({ assetId: null, status: "empty" });
  });

  it("不是无限画布 JSON 时返回 400", async () => {
    const { app } = await tempApp();
    const rejected = await request(app).post("/api/boards/import").send({ file: { hello: "world" } }).expect(400);
    expect(rejected.body.error.code).toBe("BOARD_IMPORT_INVALID");
  });
});
