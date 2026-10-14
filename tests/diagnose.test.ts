/**
 * 参数核对与补救的测试（需求.md 问题 1）。
 *
 * 这套东西的价值全在「说实话」：卡片上说参数发出去了，请求体里就真得有；
 * 说是默认值补的，就真不是用户要的。所以这里的断言盯着**出网 body 的真实形状**
 * （`generationConfig.imageConfig.imageSize` 这种嵌套路径），而不是函数自己的返回值。
 *
 * `isParameterRejection` 的假阳性代价最大——它会触发一次真的重发、真的再计一次费，
 * 所以超时 / 5xx 那几档单独钉死。
 */
import { describe, expect, it } from "vitest";
import { auditParameters, isParameterRejection, planParameterSalvage } from "../src/server/diagnose";
import { resolveImageSize } from "../src/server/tasks";

describe("auditParameters", () => {
  it("gemini 真收到了 imageConfig.imageSize 就标 applied", () => {
    const notes = auditParameters(
      "gemini-content",
      { imageSize: "2K", aspectRatio: "2:3" },
      { generationConfig: { imageConfig: { imageSize: "2K", aspectRatio: "2:3" } } },
    );
    expect(notes).toEqual([
      { label: "宽高比", value: "2:3", status: "applied" },
      { label: "尺寸", value: "2K", status: "applied" },
    ]);
  });

  it("没人要、由默认值补上的标 defaulted（卡片上的「尺寸 2K（默认）」）", () => {
    const notes = auditParameters(
      "gemini-content",
      {},
      { generationConfig: { imageConfig: { imageSize: "2K" } } },
    );
    expect(notes).toEqual([{ label: "尺寸", value: "2K", status: "defaulted" }]);
  });

  it("gemini 的 size 标 dropped —— 这正是截图 1 那类失败", () => {
    const notes = auditParameters(
      "gemini-content",
      { size: "2K" },
      { generationConfig: { candidateCount: 1, responseModalities: ["IMAGE"] } },
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ label: "尺寸(size)", value: "2K", status: "dropped" });
    expect(notes[0]?.hint).toContain("不认");
  });

  it("OpenAI 系的 size 标 applied", () => {
    const notes = auditParameters(
      "openai-images",
      { size: "1024x1024" },
      { model: "gpt-image-1", size: "1024x1024", n: 1 },
    );
    expect(notes).toEqual([{ label: "尺寸", value: "1024x1024", status: "applied" }]);
  });

  it("OpenAI 系下 imageSize 标 dropped（反方向也要说实话）", () => {
    const notes = auditParameters("openai-chat-image", { imageSize: "2K" }, { model: "gpt-image-1", n: 1 });
    expect(notes).toEqual([{ label: "尺寸(imageSize)", value: "2K", status: "dropped", hint: "这个适配器不认 imageSize，写多少都发不出去" }]);
  });

  it("没人要、body 里却有的 size 记成 defaulted：工作台设了默认值时就是这种情况", () => {
    const notes = auditParameters("openai-images", {}, { size: "1024x1024" });
    expect(notes).toEqual([{ label: "尺寸", value: "1024x1024", status: "defaulted" }]);
  });

  it("body 为空 / 形状不对时不炸，且请求过的参数都记成 dropped", () => {
    expect(auditParameters("gemini-content", {}, null)).toEqual([]);
    expect(auditParameters("gemini-content", { imageSize: "2K" }, { generationConfig: "oops" }))
      .toEqual([{ label: "尺寸", value: "2K", status: "dropped", hint: "请求体里没有这个字段" }]);
  });

  it("rawParameters 把值盖掉时以真正出网的值为准", () => {
    const notes = auditParameters(
      "gemini-content",
      { aspectRatio: "1:1" },
      { generationConfig: { imageConfig: { aspectRatio: "16:9" } } },
    );
    expect(notes).toEqual([{ label: "宽高比", value: "16:9", status: "applied" }]);
  });
});

describe("isParameterRejection", () => {
  it("认上游的参数类措辞", () => {
    expect(isParameterRejection("REMOTE_REQUEST_FAILED", "Unsupported resolution: check the imageSize parameter (case-sensitive, e.g. 1K, 2K, 4K)")).toBe(true);
    expect(isParameterRejection("REMOTE_REQUEST_FAILED", "invalid aspect_ratio")).toBe(true);
    expect(isParameterRejection("REMOTE_REQUEST_FAILED", "不支持的尺寸")).toBe(true);
  });

  it("绝不认超时 / 网络 / 5xx —— 再发一次只会白花一笔钱", () => {
    expect(isParameterRejection("REQUEST_TIMEOUT", "请求超时")).toBe(false);
    expect(isParameterRejection("TASK_WAIT_TIMEOUT", "等待生成结果超时")).toBe(false);
    expect(isParameterRejection("REMOTE_REQUEST_FAILED", "中转接口返回错误")).toBe(false);
    expect(isParameterRejection("REMOTE_REQUEST_FAILED", "Bad Gateway")).toBe(false);
    expect(isParameterRejection("REMOTE_REQUEST_FAILED", "upstream unreachable: fetch failed")).toBe(false);
  });

  it("定义上就不该重试的错误码一律短路，哪怕消息里恰好有参数字样", () => {
    expect(isParameterRejection("TASK_ABORTED", "用户叫停了 imageSize 的等待")).toBe(false);
    expect(isParameterRejection("RESPONSE_PARSE_FAILED", "响应中没有找到图片或视频")).toBe(false);
    expect(isParameterRejection("INVALID_INPUT", "参数不合法")).toBe(false);
  });

  it("没有消息就没什么可判的", () => {
    expect(isParameterRejection("REMOTE_REQUEST_FAILED", null)).toBe(false);
    expect(isParameterRejection(null, undefined)).toBe(false);
  });
});

describe("planParameterSalvage", () => {
  it("请求体里没有尺寸 → 补默认值重试", () => {
    const salvage = planParameterSalvage("gemini-content", { generationConfig: { candidateCount: 1 } }, "2K");
    expect(salvage?.patch).toEqual({ imageSize: "2K" });
    expect(salvage?.note).toContain("补上 2K");
  });

  it("大脑编了个上游不认的值 → 换成默认值重试", () => {
    const salvage = planParameterSalvage(
      "gemini-content",
      { generationConfig: { imageConfig: { imageSize: "8K" } } },
      "2K",
    );
    expect(salvage?.patch).toEqual({ imageSize: "2K" });
    expect(salvage?.note).toContain("8K 被上游拒绝");
  });

  it("发出去的就是兜底值 → 补也白补，不重试", () => {
    expect(planParameterSalvage("gemini-content", { generationConfig: { imageConfig: { imageSize: "2K" } } }, "2K")).toBeNull();
  });

  it("设置里的默认值本身是脏的也要洗干净再补 —— 否则只是把「缺失」换成「非法」", () => {
    expect(planParameterSalvage("gemini-content", {}, "")?.patch).toEqual({ imageSize: "2K" });
    expect(planParameterSalvage("gemini-content", {}, null)?.patch).toEqual({ imageSize: "2K" });
    expect(planParameterSalvage("gemini-content", {}, "8K")?.patch).toEqual({ imageSize: "2K" });
  });

  it("非 gemini 渠道没有安全兜底值，替用户决定画面形状比失败更糟", () => {
    expect(planParameterSalvage("openai-images", { size: "1024x1024" }, "2K")).toBeNull();
  });
});

describe("resolveImageSize", () => {
  it("请求方写了就用请求方的", () => {
    expect(resolveImageSize("gemini-content", "4K", "2K")).toBe("4K");
    expect(resolveImageSize("openai-images", "1024x1024", "2K")).toBe("1024x1024");
  });

  it("gemini 没写就补默认值 —— 这是问题 1 的根因修复", () => {
    expect(resolveImageSize("gemini-content", undefined, "2K")).toBe("2K");
    expect(resolveImageSize("gemini-content", undefined, null)).toBe("2K");
    expect(resolveImageSize("gemini-content", undefined, "  ")).toBe("2K");
    expect(resolveImageSize("gemini-content", undefined, "4K")).toBe("4K");
  });

  it("设置里的默认值是脏值时洗干净，而不是把非法值发出去", () => {
    expect(resolveImageSize("gemini-content", undefined, "8K")).toBe("2K");
    expect(resolveImageSize("gemini-content", undefined, "2k")).toBe("2K");
  });

  it("别的适配器不补：它们没有这个参数，硬塞一个只会被上游拒", () => {
    expect(resolveImageSize("openai-images", undefined, "2K")).toBeUndefined();
    expect(resolveImageSize("openai-chat-image", undefined, "2K")).toBeUndefined();
  });
});
