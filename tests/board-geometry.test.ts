import { describe, expect, it } from "vitest";
import { clampScale, edgeClass, edgePath, nodesBounds, rectsIntersect } from "../src/client/board/board-geometry";
import type { BoardNode } from "../src/shared/board";

describe("画布几何计算", () => {
  it("限制缩放并保持合法值", () => {
    expect(clampScale(0.001)).toBe(0.05);
    expect(clampScale(5)).toBe(3);
    expect(clampScale(0.7)).toBe(0.7);
  });

  it("计算包含负坐标的节点范围和相交关系", () => {
    const nodes = [{ x: -100, y: 30, width: 50, height: 40 }, { x: 20, y: -40, width: 80, height: 60 }] as BoardNode[];
    expect(nodesBounds([])).toBeNull();
    expect(nodesBounds(nodes)).toEqual({ x: -100, y: -40, width: 200, height: 110 });
    expect(rectsIntersect(nodes[0]!, nodes[1]!)).toBe(false);
    expect(rectsIntersect(nodes[0]!, { x: -90, y: 35, width: 10, height: 10 })).toBe(true);
  });

  it("连线从起点右侧连接到终点左侧，保留角色样式", () => {
    const source = { x: 10, y: 20, width: 100, height: 80 } as BoardNode;
    const target = { x: 220, y: 40, width: 100, height: 80 } as BoardNode;
    expect(edgePath(source, target)).toMatch(/^M 110 60 C .* 220 80$/);
    expect(edgeClass({ id: "e", source: "a", target: "b", kind: "input", role: "first-frame" })).toBe("is-first");
    expect(edgeClass({ id: "e", source: "a", target: "b", kind: "result" })).toBe("is-result");
  });
});
