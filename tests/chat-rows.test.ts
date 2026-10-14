/**
 * 消息流折叠的测试。
 *
 * `buildRows` 的输入是**已经落库**的东西，所以这里不测渲染、只测配对规则：
 * 一次工具调用被折成一张卡、两次调用各自配对、缺结果的行不能被吞掉。
 * 这些错了的表现是「用户看到助手调了工具但结果不见了」，从界面很难反推，钉住最便宜。
 */
import { describe, expect, it } from "vitest";
import { buildRows } from "../src/client/chat/rows";
import type { ChatMessage, ConfirmPreview, MessageRole } from "../src/shared/agent-types";

let counter = 0;
function message(role: MessageRole, overrides: Partial<ChatMessage> = {}): ChatMessage {
  counter += 1;
  return {
    id: `m${counter}`,
    conversationId: "c1",
    seq: counter,
    role,
    content: null,
    plan: null,
    toolName: null,
    toolArgs: null,
    toolResult: null,
    confirm: null,
    taskId: null,
    assetId: null,
    status: "ok",
    errorMessage: null,
    createdAt: "",
    ...overrides,
  };
}

describe("buildRows", () => {
  it("keeps plain conversation in order", () => {
    const rows = buildRows([
      message("user", { content: "画只猫" }),
      message("assistant", { content: "好" }),
      message("system", { content: "已中断本轮处理" }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["user", "assistant", "note"]);
    expect(rows[2]!.message.content).toBe("已中断本轮处理");
  });

  it("folds an assistant tool call and its result into one card", () => {
    const call = message("assistant", { toolName: "generate_image", toolArgs: { prompt: "a cat" } });
    const result = message("tool", { content: "画好了", assetId: "a1" });
    const rows = buildRows([message("user", { content: "画只猫" }), call, result, message("assistant", { content: "画好了" })]);

    expect(rows.map((row) => row.kind)).toEqual(["user", "tool", "assistant"]);
    const card = rows[1]!;
    expect(card.kind).toBe("tool");
    if (card.kind !== "tool") throw new Error("unreachable");
    expect(card.message.id).toBe(call.id);
    expect(card.result?.id).toBe(result.id);
  });

  it("pairs two consecutive calls with their own results", () => {
    const callA = message("assistant", { toolName: "generate_image" });
    const resultA = message("tool");
    const callB = message("assistant", { toolName: "optimize_prompt" });
    const resultB = message("tool");
    const rows = buildRows([callA, resultA, callB, resultB]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => (row.kind === "tool" ? row.result?.id : null))).toEqual([resultA.id, resultB.id]);
    // 折走的结果行绝不能自己再冒出来一张卡
    expect(rows.reduce((count, row) => count + (row.kind === "tool" ? 1 : 0), 0)).toBe(2);
  });

  it("does not swallow a tool row whose call never arrived", () => {
    const orphan = message("tool", { content: "上游报错" });
    const rows = buildRows([orphan]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("tool");
    if (rows[0]!.kind !== "tool") throw new Error("unreachable");
    // 自己和自己配对：卡片至少能把 summary 显示出来，而不是空白
    expect(rows[0]!.result?.id).toBe(orphan.id);
  });

  it("renders a pending confirmation as a confirm card, not a tool card", () => {
    const preview: ConfirmPreview = {
      reason: "video_policy", prompt: "镜头慢慢推近", model: "wan-2.5", channelName: "测试渠道",
      mode: "first-frame", duration: 5, message: "这条要花一张视频额度",
    };
    const row = message("assistant", { toolName: "generate_video", confirm: preview });
    const rows = buildRows([row]);
    expect(rows[0]!.kind).toBe("confirm");
    if (rows[0]!.kind !== "confirm") throw new Error("unreachable");
    expect(rows[0]!.preview).toEqual(preview);
  });

  it("only pairs backwards-lookalike rows that are actually adjacent", () => {
    // 中间插了一条 system（用户中断），结果行不该越过它去配对
    const call = message("assistant", { toolName: "generate_image" });
    const note = message("system", { content: "已中断本轮处理" });
    const result = message("tool");
    const rows = buildRows([call, note, result]);
    expect(rows.map((row) => row.kind)).toEqual(["tool", "note", "tool"]);
    const first = rows[0]!;
    if (first.kind !== "tool") throw new Error("unreachable");
    expect(first.result).toBeNull();
  });
});
