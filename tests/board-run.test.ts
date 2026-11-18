import { expect, it } from "vitest";
import { boardFitViewport } from "../src/client/board/board-geometry";
import { nextBoardRunStep, planBoardRun, refreshBoardRun, type BoardRun } from "../src/client/board/board-run";
import type { BoardDoc, BoardEdge, ImageBoardNode, VideoBoardNode } from "../src/shared/board";

const base = { title: "", x: 0, y: 0, width: 260, height: 180, createdAt: "", updatedAt: "", status: "empty" as const, assetId: null, source: "generated" as const };
const edges: BoardEdge[] = [];
const nodes = Array.from({ length: 10 }, (_, i): Array<ImageBoardNode | VideoBoardNode> => {
  edges.push({ id: `edge${i}`, source: `image${i}`, target: `video${i}`, kind: "input", role: "first-frame" });
  return [{ ...base, id: `image${i}`, ref: `n${i * 2 + 1}`, type: "image", prompt: "首帧", count: i === 0 ? 2 : 1 },
    { ...base, id: `video${i}`, ref: `n${i * 2 + 2}`, type: "video", prompt: "视频" }];
}).flat();
const doc: BoardDoc = { version: 1, nextRef: 21, nodes, edges };

it("为十镜选择上游并计算限流，失败只阻塞依赖该节点的镜头", () => {
  const steps = planBoardRun(doc, nodes.map(({ id }) => id), "selection");
  expect(steps.reduce((sum, step) => sum + step.requestCount, 0)).toBe(21);
  expect(steps[1]?.dependencies).toEqual(["image0"]);
  const run: BoardRun = { boardId: "board", createdAt: "", concurrency: 1,
    steps: steps.map((step) => ({ ...step, channelId: step.kind === "image" ? "images" : "video" })) };
  expect(nextBoardRunStep(run)?.nodeId).toBe("image0");
  run.steps[0]!.state = "waiting";
  expect(nextBoardRunStep(run)).toBeUndefined();
  run.steps[0]!.state = "failed";
  const updated = refreshBoardRun(run, doc);
  expect(updated.steps[1]?.state).toBe("blocked");
  expect(updated.steps[3]?.state).toBe("pending");
  expect(nextBoardRunStep(updated)?.nodeId).toBe("image1");
});

it("从单镜运行下游，多图部分成功且当前主图失败时等待人工确认", () => {
  const steps = planBoardRun(doc, ["image0"], "downstream");
  expect(steps.map(({ nodeId }) => nodeId)).toEqual(["image0", "video0"]);
  const source = nodes[0] as ImageBoardNode;
  const run: BoardRun = { boardId: "board", createdAt: "", steps: [
    { ...steps[0]!, state: "waiting", taskIds: ["one", "two"], resultIds: ["image0", "image-alt"] }, steps[1]!,
  ] };
  const updated = refreshBoardRun(run, { ...doc, nodes: [{ ...source, status: "failed", taskId: "one" }, ...nodes.slice(1),
    { ...source, id: "image-alt", ref: "n21", taskId: "two", status: "succeeded", assetId: "asset" }] });
  expect(updated.steps[0]?.state).toBe("choosing");
  expect(nextBoardRunStep(updated)).toBeUndefined();
});

it("大跨度画布可以缩小到 30% 以下并让内容落在视口内", () => {
  const view = boardFitViewport({ x: 70, y: 90, width: 7500, height: 420 }, { width: 1280, height: 800 });
  expect(view.scale).toBeLessThan(0.3);
  expect(view.x + 70 * view.scale).toBeGreaterThan(0);
  expect(view.x + 7570 * view.scale).toBeLessThan(1280);
});
