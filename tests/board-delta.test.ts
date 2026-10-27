import { describe, expect, it } from "vitest";
import { buildBoardDelta } from "../src/server/board";
import { applyBoardDeltaToDoc, type BoardDoc, type BoardNode } from "../src/shared/board";

const at = "2026-10-26T00:00:00.000Z";
function text(id: string, ref: string, value: string): BoardNode {
  return {
    id, ref, type: "text", x: 0, y: 0, width: 300, height: 180,
    title: ref, text: value, createdAt: at, updatedAt: at,
  };
}

describe("画布增量 SSE", () => {
  it("只返回新增 / 修改 / 删除的节点、连线和分组", () => {
    const before: BoardDoc = {
      version: 1,
      nextRef: 4,
      nodes: [text("a", "n1", "旧"), text("b", "n2", "保留"), text("c", "n3", "删除")],
      edges: [
        { id: "e1", source: "a", target: "b", kind: "input", role: "text" },
        { id: "e2", source: "b", target: "c", kind: "input", role: "text" },
      ],
      groups: [{ id: "g1", title: "组", nodeIds: ["a", "b"], collapsed: false }],
    };
    const after: BoardDoc = {
      version: 1,
      nextRef: 5,
      nodes: [text("a", "n1", "改过"), { ...text("b", "n2", "保留"), x: 100 }, text("d", "n4", "新增")],
      edges: [
        { id: "e1", source: "a", target: "b", kind: "input", role: "text" },
        { id: "e3", source: "d", target: "b", kind: "input", role: "text" },
      ],
      groups: [{ id: "g1", title: "新组名", nodeIds: ["a", "b"], collapsed: true }],
    };

    const delta = buildBoardDelta("board-1", before, after, 1, 2);
    expect(delta).toMatchObject({
      boardId: "board-1", baseVersion: 1, version: 2, nextRef: 5,
      removedNodeIds: ["c"],
      removedEdgeIds: ["e2"],
      removedGroupIds: [],
    });
    expect(delta.nodes.map((node) => node.id).sort()).toEqual(["a", "b", "d"]);
    expect(delta.edges.map((edge) => edge.id)).toEqual(["e3"]);
    expect(delta.groups).toHaveLength(1);
    expect(delta.groups[0]).toMatchObject({ id: "g1", collapsed: true });

    // 客户端合并后的文档应该和服务端的新文档一致
    expect(applyBoardDeltaToDoc(before, delta)).toEqual(after);
  });

  it("没有变化时返回空增量", () => {
    const doc: BoardDoc = {
      version: 1, nextRef: 2, nodes: [text("a", "n1", "x")], edges: [],
    };
    const delta = buildBoardDelta("board-1", doc, structuredClone(doc), 1, 2);
    expect(delta.nodes).toEqual([]);
    expect(delta.edges).toEqual([]);
    expect(delta.groups).toEqual([]);
    expect(delta.removedNodeIds).toEqual([]);
  });
});
