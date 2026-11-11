/**
 * 视频模式表：界面渲染、服务端守卫、适配器组装共用这一份。
 *
 * 这几条断言就是「不能只做界面切换」的底线：渠道没有的模式不出现、模型不支持的
 * 模式要拦在服务端、换模型后参数要收敛到新档位。
 */
import { describe, expect, it } from "vitest";
import {
  VIDEO_FORMAT_CHOICES, VIDEO_MODE_LABELS, VIDEO_VARIANT_CHOICES,
  maxImagesForMode, resolveStudioMode, resolutionOptionsFor, studioAssetSpec, studioModeForConcrete,
  videoModeSpec, videoModesFor, videoModeLabel,
} from "../src/shared/video-modes";
import { defaultVideoDraft, draftKey, reconcileVideoDraft, applySnapshotToDraft } from "../src/shared/video-draft";

describe("视频模式矩阵", () => {
  it("万相界面收成 4 个入口：提示词 / 首尾帧 / 视频编辑 / 视频延长", () => {
    const ids = videoModesFor("wan-video", "wan2.5-i2v").map((item) => item.id);
    expect(ids).toEqual(["prompt", "frames", "video-edit", "video-extend"]);
    // 页面没有粘贴地址的入口，这个模式在界面上没法用；接口与适配器仍然认它
    expect(ids).not.toContain("file-to-video");
    expect(videoModeSpec("wan-video", "wan2.5-i2v", "file-to-video")?.label).toBe("参考文件生视频");
  });

  it("提示词入口把文生与参考合成一个：不传素材是文生，传了就是参考", () => {
    const prompt = videoModesFor("wan-video", "wan2.5-i2v").find((item) => item.id === "prompt")!;
    expect(prompt.compose).toBe("prompt");
    expect(prompt.imageRepeatable).toBe(true);
    expect(prompt.imageSlots).toEqual(["reference_image"]);
    expect(prompt.acceptsReferenceVideo).toBe(true);
    expect(prompt.acceptsReferenceAudio).toBe(true);

    expect(resolveStudioMode("wan-video", "wan2.5-i2v", "prompt", { images: 0, video: false, audio: false })?.mode)
      .toBe("text-to-video");
    const reference = resolveStudioMode("wan-video", "wan2.5-i2v", "prompt", { images: 2, video: true, audio: false });
    expect(reference?.mode).toBe("reference");
    // 解析出来的 spec 就是具体模式的槽位，素材构造按它分配角色
    expect(reference?.spec.imageSlots).toEqual(["reference_image"]);
  });

  it("首帧与首尾帧合成一个：1 张图走首帧，2 张图走首尾帧", () => {
    const frames = videoModesFor("wan-video", "wan2.5-i2v").find((item) => item.id === "frames")!;
    expect(frames.compose).toBe("frames");
    expect(frames.imageSlots).toEqual(["first_frame", "last_frame"]);
    expect(frames.imageMin).toBe(1);
    expect(resolveStudioMode("wan-video", "wan2.5-i2v", "frames", { images: 1, video: false, audio: false })?.mode)
      .toBe("first-frame");
    expect(resolveStudioMode("wan-video", "wan2.5-i2v", "frames", { images: 2, video: false, audio: false })?.mode)
      .toBe("first-last-frame");
  });

  it("参考素材只走本地上传：接受与必需分开，没有 urlSlots 之类的链接槽", () => {
    const reference = videoModeSpec("wan-video", "wan2.5-i2v", "reference");
    expect(reference?.acceptsReferenceVideo).toBe(true);
    expect(reference?.needsReferenceVideo).toBe(false);
    expect(reference?.acceptsReferenceAudio).toBe(true);
    expect(videoModeSpec("wan-video", "wan2.5-i2v", "video-edit")?.needsReferenceVideo).toBe(true);
    expect("urlSlots" in (reference as object)).toBe(false);
  });

  it("Seedance 只有两个入口，不渲染没有后端语义的编辑/延长", () => {
    const ids = videoModesFor("seedance-video", "doubao-seedance-2.5").map((item) => item.id);
    expect(ids).toEqual(["prompt", "frames"]);
    expect(ids).not.toContain("video-edit");
    expect(ids).not.toContain("video-extend");
  });

  it("可灵按模型收敛：omni 的提示词入口才有参考图，运动控制只给 kling-3.0", () => {
    const omni = videoModesFor("kling-video", "kling-3.0-omni");
    expect(omni.map((item) => item.id)).toEqual(["prompt", "frames"]);
    expect(omni[0]!.imageRepeatable).toBe(true);
    expect(resolveStudioMode("kling-video", "kling-3.0-omni", "prompt", { images: 2, video: false, audio: false })?.mode)
      .toBe("reference");

    // 没有参考模式的模型：提示词入口就是纯文生，不给图片槽，免得放进去只能当首帧
    const turbo = videoModesFor("kling-video", "kling-2.5-turbo");
    expect(turbo.map((item) => item.id)).toEqual(["prompt", "frames"]);
    expect(turbo[0]!.label).toBe("文生视频");
    expect(turbo[0]!.imageSlots).toEqual([]);
    expect(resolveStudioMode("kling-video", "kling-2.5-turbo", "prompt", { images: 1, video: false, audio: false })?.mode)
      .toBe("text-to-video");

    expect(videoModesFor("kling-video", "kling-3.0").map((item) => item.id)).toContain("motion-control");
    expect(videoModesFor("kling-video", "kling-3.0-omni").map((item) => item.id)).not.toContain("motion-control");
  });

  it("Grok 不渲染模式胶囊，但创作框仍有一份素材规格（参考图可传）", () => {
    expect(videoModesFor("grok-video", "grok-video")).toEqual([]);
    expect(videoModeSpec("grok-video", "grok-video", "text-to-video")).toBeNull();
    const spec = studioAssetSpec("grok-video", "grok-video");
    expect(spec?.id).toBe("prompt");
    expect(spec?.imageRepeatable).toBe(true);
    expect(spec?.acceptsReferenceVideo).toBe(false);
    expect(maxImagesForMode("grok-video", "grok-video", "prompt")).toBe(7);
    // 没有可用生成方式 → 之前 generate() 直接报错，现在能解析出规格
    expect(resolveStudioMode("grok-video", "grok-video", "prompt", { images: 0, video: false, audio: false })?.spec)
      .toEqual(spec);
    expect(studioAssetSpec("wan-video", "wan2.5-i2v-preview")).toBeNull();
  });

  it("图片上限按入口与渠道算：首尾帧是 2，参考图按渠道上限", () => {
    expect(maxImagesForMode("wan-video", "wan", "frames")).toBe(2);
    expect(maxImagesForMode("wan-video", "wan", "prompt")).toBe(10);
    expect(maxImagesForMode("seedance-video", "doubao-seedance-2.0", "prompt")).toBe(9);
    expect(maxImagesForMode("seedance-video", "doubao-seedance-2.5", "prompt")).toBe(30);
    expect(maxImagesForMode("kling-video", "kling-3.0", "prompt")).toBe(0);
  });

  it("历史任务的具体模式折回合并入口，快照复用才找得到", () => {
    expect(studioModeForConcrete("text-to-video")).toBe("prompt");
    expect(studioModeForConcrete("reference")).toBe("prompt");
    expect(studioModeForConcrete("first-frame")).toBe("frames");
    expect(studioModeForConcrete("first-last-frame")).toBe("frames");
    expect(studioModeForConcrete("motion-control")).toBe("motion-control");
  });

  it("分辨率档位跟模式走，运动控制没有 4K", () => {
    expect(resolutionOptionsFor("kling-video", "motion-control")).toEqual(["720p", "1080p"]);
    expect(resolutionOptionsFor("kling-video", "text-to-video")).toContain("4k");
  });

  it("格式与数量是锁定项：上游没有这些字段", () => {
    expect(VIDEO_FORMAT_CHOICES.find((item) => item.value === "mov")?.supported).toBe(false);
    expect(VIDEO_VARIANT_CHOICES.filter((item) => item.supported).map((item) => item.value)).toEqual([1]);
  });

  it("历史任务的模式 id 能翻译成中文名", () => {
    expect(videoModeLabel("video-extend")).toBe("视频延长");
    expect(VIDEO_MODE_LABELS["motion-control"]).toBe("运动控制");
    expect(VIDEO_MODE_LABELS["prompt"]).toBe("提示词生视频");
    expect(VIDEO_MODE_LABELS["frames"]).toBe("首尾帧生视频");
    expect(videoModeLabel("unknown-mode")).toBeUndefined();
  });
});

describe("草稿与参数收敛", () => {
  it("草稿键区分渠道与模式，互不覆盖", () => {
    expect(draftKey("wan-video", "prompt")).not.toBe(draftKey("seedance-video", "prompt"));
    expect(draftKey("wan-video", "frames")).not.toBe(draftKey("wan-video", "prompt"));
  });

  it("换到运动控制后 4K 会被收敛到 1080P，并说明原因", () => {
    const draft = { ...defaultVideoDraft("kling-video", "motion-control"), resolution: "4k" };
    const result = reconcileVideoDraft(draft, { adapter: "kling-video", model: "kling-3.0", mode: "motion-control" });
    expect(result.draft.resolution).toBe("1080p");
    expect(result.notices.some((item) => item.key === "resolution")).toBe(true);
  });

  it("Seedance 2.5 的首尾帧入口强制自适应比例，2.0 不强制", () => {
    const base = { ...defaultVideoDraft("seedance-video", "frames"), ratio: "16:9" };
    const v25 = reconcileVideoDraft(base, { adapter: "seedance-video", model: "doubao-seedance-2.5", mode: "frames" });
    expect(v25.draft.ratio).toBe("adaptive");
    const v20 = reconcileVideoDraft(base, { adapter: "seedance-video", model: "doubao-seedance-2.0", mode: "frames" });
    expect(v20.draft.ratio).toBe("16:9");
  });

  it("时长越界会被夹回区间，智能时长（-1）保持不动", () => {
    const draft = { ...defaultVideoDraft("wan-video", "text-to-video"), duration: 120 };
    expect(reconcileVideoDraft(draft, { adapter: "wan-video", model: "wan", mode: "text-to-video" }).draft.duration).toBe(30);
    const smart = { ...draft, duration: -1 };
    expect(reconcileVideoDraft(smart, { adapter: "wan-video", model: "wan", mode: "text-to-video" }).draft.duration).toBe(-1);
  });

  it("复用快照只回填文本与数值，素材（含上游返回的地址）都计数为需重新上传", () => {
    const draft = defaultVideoDraft("wan-video", "reference");
    const result = applySnapshotToDraft(draft, {
      prompt: "城市夜景延时",
      resolution: "720P",
      ratio: "16:9",
      duration: 5,
      audio: true,
      imageCount: 2,
      media: [
        { type: "reference_image", inlineBytes: 1024 },
        { type: "reference_video", url: "https://cdn.example.com/a.mp4" },
      ],
    });
    expect(result.draft.prompt).toBe("城市夜景延时");
    expect(result.draft.duration).toBe(5);
    expect(result.droppedMedia).toBe(4);
  });
});
