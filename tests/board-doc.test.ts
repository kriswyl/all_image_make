import { describe, expect, it } from "vitest";
import {
  BOARD_LIMITS,
  BoardValidationError,
  allocateNodeRef,
  boardDocAssetIds,
  composeConfigPrompt,
  createEmptyBoardDoc,
  directUpstreamImages,
  directUpstreamText,
  parseBoardDoc,
  type BoardDoc,
  type BoardEdge,
  type BoardNode,
  type ConfigBoardNode,
  type ImageBoardNode,
  type TextBoardNode,
} from "../src/shared/board.js";

const at = "2026-10-26T00:00:00.000Z";

function base(ref: string, x: number, y: number) {
  return {
    id: `id-${ref}`,
    ref,
    x,
    y,
    width: 280,
    height: 180,
    title: ref,
    createdAt: at,
    updatedAt: at,
  };
}

function text(ref: string, textValue: string, x = 0, y = 0): TextBoardNode {
  return { ...base(ref, x, y), type: "text", text: textValue };
}

function image(ref: string, assetId: string | null, x = 0, y = 0): ImageBoardNode {
  return { ...base(ref, x, y), type: "image", assetId, source: "upload", status: assetId ? "succeeded" : "empty" };
}

function config(ref: string, x = 0, y = 0): ConfigBoardNode {
  return { ...base(ref, x, y), type: "config", mode: "image", prompt: "", useUpstreamText: true, count: 1, status: "idle" };
}

function edge(source: string, target: string, kind: "input" | "result", role?: BoardEdge["role"]): BoardEdge {
  return { id: `e-${source}-${target}-${kind}`, source: `id-${source}`, target: `id-${target}`, kind, ...(role ? { role } : {}) };
}

function doc(nodes: BoardNode[], edges: BoardEdge[] = []): BoardDoc {
  return { version: 1, nextRef: 1, nodes, edges };
}

describe("无限画布文档 schema", () => {
  it("空文档合法", () => {
    const parsed = parseBoardDoc(createEmptyBoardDoc());
    expect(parsed).toEqual(createEmptyBoardDoc());
  });

  it("补齐节点默认值并归一 nextRef", () => {
    const parsed = parseBoardDoc({
      version: 1,
      nextRef: 1,
      nodes: [{ ...base("n7", 0, 0), type: "image", assetId: null }],
      edges: [],
    });
    expect(parsed.nodes[0]).toMatchObject({ type: "image", source: "upload", status: "empty" });
    expect(parsed.nextRef).toBe(8);
  });

  it("节点 id / ref 重复会被拒绝", () => {
    expect(() => parseBoardDoc(doc([text("n1", "a"), text("n1", "b")]))).toThrow(BoardValidationError);
    expect(() => parseBoardDoc(doc([
      { ...text("n1", "a"), id: "same" },
      { ...text("n2", "b"), id: "same" },
    ]))).toThrow(/id 重复/);
  });

  it("输入连线可以连到生成节点，但文本节点不能当目标、配置节点不能链式", () => {
    // 图片 / 视频 / 音频节点现在自己就能生成，所以允许接收输入
    expect(() => parseBoardDoc(doc([text("n1", "a"), image("n2", "asset-1")], [edge("n1", "n2", "input")])))
      .not.toThrow();
    expect(() => parseBoardDoc(doc([text("n1", "a"), text("n2", "b")], [edge("n1", "n2", "input")])))
      .toThrow(/输入连线只能连到/);
    expect(() => parseBoardDoc(doc([config("n1"), config("n2")], [edge("n1", "n2", "input")])))
      .toThrow(/链式|配置节点/);
    // 音频只吃文本，不接图片
    expect(() => parseBoardDoc(doc([image("n1", "asset-1"), { ...text("n2", ""), type: "audio", assetId: null, source: "generated", status: "empty" } as never], [edge("n1", "n2", "input")])))
      .toThrow(/音频节点只接受文本/);
  });

  it("结果连线只能从配置节点指向图片 / 视频", () => {
    expect(() => parseBoardDoc(doc([config("n1"), image("n2", "asset-1")], [edge("n1", "n2", "result")])))
      .not.toThrow();
    expect(() => parseBoardDoc(doc([text("n1", "a"), image("n2", "asset-1")], [edge("n1", "n2", "result")])))
      .toThrow(/结果连线/);
  });

  it("重复连线、自己连自己、指向不存在的节点都会被拒绝", () => {
    const nodes = [text("n1", "a"), config("n2")];
    expect(() => parseBoardDoc(doc(nodes, [edge("n1", "n2", "input"), edge("n1", "n2", "input")])))
      .toThrow(/连线重复/);
    expect(() => parseBoardDoc(doc(nodes, [edge("n1", "n1", "input")])))
      .toThrow(/自己/);
    expect(() => parseBoardDoc(doc(nodes, [edge("n1", "n9", "input")])))
      .toThrow(/不存在/);
  });

  it("结果图再喂回同一个配置节点会形成环，必须拒绝", () => {
    const nodes = [text("n1", "a"), config("n2"), image("n3", "asset-1")];
    const edges = [edge("n1", "n2", "input"), edge("n2", "n3", "result"), edge("n3", "n2", "input")];
    expect(() => parseBoardDoc(doc(nodes, edges))).toThrow(/环/);
  });

  it("文本超长和节点超限会被拒绝", () => {
    expect(() => parseBoardDoc(doc([text("n1", "x".repeat(BOARD_LIMITS.maxTextChars + 1))]))).toThrow();
    const nodes = Array.from({ length: BOARD_LIMITS.maxNodes + 1 }, (_, index) => text(`n${index + 1}`, "a"));
    expect(() => parseBoardDoc(doc(nodes))).toThrow();
  });

  it("按画布位置排序直接上游，而不是按连线顺序", () => {
    const d = doc([
      text("n1", "下面", 0, 400),
      text("n2", "上面左", 0, 100),
      text("n3", "上面右", 400, 100),
      config("n4"),
    ], [
      edge("n1", "n4", "input"),
      edge("n3", "n4", "input"),
      edge("n2", "n4", "input"),
    ]);
    expect(directUpstreamText(d, "id-n4").map((node) => node.text)).toEqual(["上面左", "上面右", "下面"]);
  });

  it("拼提示词时自己的 prompt 在前，上游文本在后；可以关闭上游文本", () => {
    const d = doc([
      text("n1", "第一段"),
      text("n2", "第二段"),
      { ...config("n3"), prompt: "自己的" },
    ], [edge("n1", "n3", "input"), edge("n2", "n3", "input")]);
    expect(composeConfigPrompt(d, { id: "id-n3", prompt: "自己的", useUpstreamText: true })).toBe("自己的\n\n第一段\n\n第二段");
    expect(composeConfigPrompt(d, { id: "id-n3", prompt: "自己的", useUpstreamText: false })).toBe("自己的");
  });

  it("参考图只取有 assetId 的图片节点，并按位置排序", () => {
    const d = doc([
      image("n1", null, 0, 0),
      image("n2", "asset-b", 0, 200),
      image("n3", "asset-a", 0, 100),
      config("n4"),
    ], [
      edge("n1", "n4", "input"),
      edge("n2", "n4", "input"),
      edge("n3", "n4", "input"),
    ]);
    expect(directUpstreamImages(d, "id-n4").map((node) => node.assetId)).toEqual(["asset-a", "asset-b"]);
  });

  it("分配 nX 引用时跳过已用的最大号", () => {
    const d = doc([text("n3", "a"), text("n7", "b")]);
    expect(allocateNodeRef(d)).toEqual({ ref: "n8", nextRef: 9 });
  });

  it("提取文档引用到的素材 id 并去重", () => {
    const d = doc([image("n1", "asset-a"), image("n2", "asset-a"), image("n3", "asset-b"), text("n4", "x")]);
    expect(boardDocAssetIds(d)).toEqual(["asset-a", "asset-b"]);
  });

  it("分组会归一 collapsed，并拒绝重复 id / 不存在节点 / 重复归属", () => {
    const d: BoardDoc = {
      ...doc([text("n1", "a"), text("n2", "b")]),
      groups: [{ id: "g1", title: "开场", nodeIds: ["id-n1", "id-n2"], collapsed: false }],
    };
    expect(parseBoardDoc(d).groups).toEqual([
      { id: "g1", title: "开场", nodeIds: ["id-n1", "id-n2"], collapsed: false },
    ]);
    expect(() => parseBoardDoc({
      ...d,
      groups: [
        { id: "g1", title: "a", nodeIds: ["id-n1"] },
        { id: "g1", title: "b", nodeIds: ["id-n2"] },
      ],
    })).toThrow(/分组 id 重复/);
    expect(() => parseBoardDoc({
      ...d,
      groups: [{ id: "g1", title: "a", nodeIds: ["id-n9"] }],
    })).toThrow(/节点不存在/);
    expect(() => parseBoardDoc({
      ...d,
      groups: [
        { id: "g1", title: "a", nodeIds: ["id-n1"] },
        { id: "g2", title: "b", nodeIds: ["id-n1"] },
      ],
    })).toThrow(/多个分组/);
  });

  it("结果连线可以指向文本节点（生文本）", () => {
    const d = doc([config("n1"), text("n2", "生成结果")], [edge("n1", "n2", "result")]);
    expect(() => parseBoardDoc(d)).not.toThrow();
  });
});
