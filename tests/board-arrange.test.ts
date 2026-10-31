import { describe, expect, it } from "vitest";
import { arrangePositions } from "../src/shared/board-layout";
import { boardOpSchema } from "../src/shared/board-ops";

const items = [
  { x: 0, y: 0, width: 100, height: 80 },
  { x: 0, y: 0, width: 100, height: 60 },
  { x: 0, y: 0, width: 80, height: 80 },
];

describe("画布排版计算", () => {
  it("纵向排成一列，按每个节点自己的高度累加", () => {
    const positions = arrangePositions(items, { axis: "y", gap: 20 });
    expect(positions).toEqual([{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 0, y: 180 }]);
  });

  it("横向排成一行，按宽度累加", () => {
    const positions = arrangePositions(items, { axis: "x", gap: 20 });
    expect(positions).toEqual([{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 240, y: 0 }]);
  });

  it("columns 是轨道数：先填满一列再换下一列，轨道间距按最宽节点算", () => {
    const positions = arrangePositions(items, { axis: "y", gap: 20, columns: 2 });
    expect(positions).toEqual([{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 120, y: 0 }]);
  });

  it("可以指定起点，并保持入参顺序", () => {
    const positions = arrangePositions(items, { axis: "y", gap: 10, origin: { x: 300, y: 40 } });
    expect(positions).toEqual([{ x: 300, y: 40 }, { x: 300, y: 130 }, { x: 300, y: 200 }]);
  });

  it("空数组和单节点都不报错", () => {
    expect(arrangePositions([], { axis: "y" })).toEqual([]);
    expect(arrangePositions([items[0]!], { axis: "x" })).toEqual([{ x: 0, y: 0 }]);
  });

  it("op 协议默认纵向排列", () => {
    const parsed = boardOpSchema.parse({ op: "arrange", nodeRefs: ["n3", "n5"], group: "分镜图" });
    expect(parsed).toMatchObject({ op: "arrange", axis: "y", nodeRefs: ["n3", "n5"], group: "分镜图" });
    expect(() => boardOpSchema.parse({ op: "arrange", nodeRefs: [] })).toThrow();
  });
});
