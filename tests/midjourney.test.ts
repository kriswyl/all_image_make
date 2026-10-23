import { describe, expect, it } from "vitest";
import { buildGenerationRequest } from "../src/server/adapters";
import { asyncProviderSpec } from "../src/server/async-providers";
import {
  midjourneyButtonLabel,
  midjourneyModelForCustomId,
  midjourneyUsableButtons,
} from "../src/shared/midjourney";
import type { DbChannel } from "../src/server/db";
import type { GenerationInput } from "../src/shared/types";

const channel: DbChannel = {
  id: "mj-channel", name: "Midjourney", baseUrl: "https://api.tiantoken.com",
  adapterType: "midjourney", authType: "bearer", authHeaderName: "", secretEnv: "",
  endpoint: "/mj/submit/imagine", models: [
    "mj_imagine", "mj_edits", "mj_upscale", "mj_variation", "mj_reroll",
  ],
  allowPrivateNetwork: false, enabled: true, createdAt: "", updatedAt: "",
};

function request(input: Partial<GenerationInput> = {}) {
  return buildGenerationRequest(channel, {
    channelId: channel.id,
    model: "mj_imagine",
    prompt: "a cat",
    ...input,
  }, "secret");
}

describe("Midjourney 请求体", () => {
  it("文生图走 /mj/submit/imagine，原生参数留在 prompt 里", () => {
    const built = request({ prompt: "a cat", aspectRatio: "16:9", midjourneyVersion: "7", negativePrompt: "text" });
    expect(built.url).toBe("https://api.tiantoken.com/mj/submit/imagine");
    expect(built.body).toEqual({ prompt: "a cat --ar 16:9 --v 7 --no text" });
    expect(built.body).not.toHaveProperty("model");
  });

  it("提示词里已经有 --ar/--no 时不重复追加", () => {
    const built = request({ prompt: "a cat --ar 9:16 --no dog", aspectRatio: "16:9", negativePrompt: "text" });
    expect(built.body).toEqual({ prompt: "a cat --ar 9:16 --no dog" });
  });

  it("有参考图时走 /mj/submit/edits，图片放 image 字段", () => {
    const built = request({
      model: "mj_edits",
      prompt: "make it blue",
      referenceImages: [{ base64: "AAA", mimeType: "image/png", fileName: "a.png" }],
    });
    expect(built.url).toBe("https://api.tiantoken.com/mj/submit/edits");
    expect(built.body).toEqual({ prompt: "make it blue", image: "data:image/png;base64,AAA" });
  });

  it("mj_edits 没有参考图时本地拒绝", () => {
    expect(() => request({ model: "mj_edits", prompt: "make it blue" }))
      .toThrow(/需要 1 张参考图/);
  });

  it("后续动作走 /mj/submit/action，只带 taskId + customId", () => {
    const built = request({
      model: "mj_upscale",
      prompt: "U1",
      midjourneyAction: { taskId: "179", customId: "MJ::JOB::upsample::1::abc", label: "U1" },
    });
    expect(built.url).toBe("https://api.tiantoken.com/mj/submit/action");
    expect(built.body).toEqual({ taskId: "179", customId: "MJ::JOB::upsample::1::abc" });
  });
});

describe("Midjourney 轮询与按钮", () => {
  it("提交响应的 result 才是任务 id，状态能解析进度/失败原因", () => {
    const spec = asyncProviderSpec("midjourney")!;
    expect(spec.extractTaskId?.({ code: 1, result: "179" })).toBe("179");
    expect(spec.pollPath("179")).toBe("/mj/task/179/fetch");
    expect(spec.extractStatus({
      status: "IN_PROGRESS",
      progress: "35%",
      buttons: [],
    })).toMatchObject({ status: "in_progress", progress: 35, error: null });
    expect(spec.extractStatus({ status: "FAILURE", progress: "100%", failReason: "blocked" }))
      .toMatchObject({ status: "failure", error: "blocked" });
  });

  it("成功时把 imageUrl 作为强候选，并把按钮落进 meta", () => {
    const spec = asyncProviderSpec("midjourney")!;
    const status = spec.extractStatus({
      status: "SUCCESS",
      progress: "100%",
      imageUrl: "https://api.tiantoken.com/mj/image/179",
      buttons: [{ customId: "MJ::JOB::upsample::1::abc", label: "U1" }],
    });
    expect(status.meta).toMatchObject({
      midjourney: { buttons: [{ customId: "MJ::JOB::upsample::1::abc", label: "U1" }] },
    });
    expect(spec.extractResults({
      imageUrl: "https://api.tiantoken.com/mj/image/179",
    })).toMatchObject([{ kind: "image", url: "https://api.tiantoken.com/mj/image/179", strong: true }]);
  });

  it("从 customId 认出动作和按钮名字", () => {
    expect(midjourneyModelForCustomId("MJ::JOB::upsample::2::x")).toBe("mj_upscale");
    expect(midjourneyModelForCustomId("MJ::JOB::upscale::2::x")).toBe("mj_upscale");
    expect(midjourneyModelForCustomId("MJ::JOB::variation::3::x")).toBe("mj_variation");
    expect(midjourneyModelForCustomId("MJ::JOB::reroll::0::x::SOLO")).toBe("mj_reroll");
    expect(midjourneyModelForCustomId("unknown")).toBeNull();
    expect(midjourneyButtonLabel({ customId: "MJ::JOB::reroll::0::x::SOLO" })).toBe("重绘");
    expect(midjourneyButtonLabel({ customId: "MJ::JOB::upsample::1::x", label: "U1" })).toBe("放大 U1");
    expect(midjourneyButtonLabel({ customId: "MJ::JOB::upscale::1::x", label: "Upscale (Subtle)" })).toBe("放大（细腻）");
    expect(midjourneyButtonLabel({ customId: "MJ::JOB::variation::1::x", label: "Vary (Strong)" })).toBe("变体（强烈）");
  });

  it("只保留能直接执行的动作，区域变体/缩放/动画都隐藏", () => {
    const buttons = midjourneyUsableButtons([
      { customId: "MJ::JOB::upsample::1::x", label: "U1" },
      { customId: "MJ::JOB::variation::1::x", label: "V1" },
      { customId: "MJ::JOB::variation_region::1::x", label: "Vary (Region)" },
      { customId: "MJ::JOB::zoom::1::x", label: "Zoom Out 2x" },
      { customId: "MJ::JOB::animate::1::x", label: "Animate (High motion)" },
    ]);
    expect(buttons.map((button) => button.label)).toEqual(["U1", "V1"]);
  });
});
