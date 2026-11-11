/**
 * 「参考内容」能加什么。
 *
 * 视频和音频的上限按渠道 + 模型算：Seedance 2.0 各 3 段、2.5 各 10 段，万相/可灵
 * 各 1 段。入口不能因为「已经有了一段」就消失，否则想加第二段或者换一段都没门，
 * 看起来就是「只能上传一次」。
 */
import { expect, it } from "vitest";
import { addableOptions, assetOptions, type AssetOptionInput } from "../src/client/video/asset-options";

const base: AssetOptionInput = {
  maxImages: 4,
  filled: 0,
  maxVideos: 3,
  maxAudios: 3,
  videoCount: 0,
  audioCount: 0,
  canUploadVideo: true,
  disabled: false,
};

it("空着时三种素材都能加，都是「添加」", () => {
  const options = assetOptions(base);
  expect(options.map((item) => `${item.replace ? "替换" : "添加"}${item.kind}`))
    .toEqual(["添加图片", "添加视频", "添加音频"]);
  expect(options[1]!.hint).toContain("还能加 3 段");
});

it("多段渠道：放了一段之后还能继续加，不会变成「替换」", () => {
  const options = assetOptions({ ...base, videoCount: 2, audioCount: 1 });
  const video = options.find((item) => item.kind === "视频")!;
  expect(video.disabled).toBe(false);
  expect(video.replace).toBe(false);
  expect(video.hint).toContain("还能加 1 段");
  expect(options.find((item) => item.kind === "音频")!.hint).toContain("还能加 2 段");
});

it("多段渠道放满后写明已满且点不动，要求先移除", () => {
  const options = assetOptions({ ...base, videoCount: 3 });
  const video = options.find((item) => item.kind === "视频")!;
  expect(video.disabled).toBe(true);
  expect(video.replace).toBe(false);
  expect(video.hint).toContain("已放满 3 段");
});

it("单额度渠道（万相/可灵）：再选就是替换，入口一直在", () => {
  const options = assetOptions({ ...base, maxVideos: 1, maxAudios: 1, videoCount: 1, audioCount: 1 });
  const video = options.find((item) => item.kind === "视频")!;
  expect(video.disabled).toBe(false);
  expect(video.replace).toBe(true);
  expect(video.hint).toContain("替换");
  expect(options.find((item) => item.kind === "音频")!.replace).toBe(true);
});

it("图片加满后不再列图片，视频音频不受影响", () => {
  const options = assetOptions({ ...base, filled: 4 });
  expect(options.map((item) => item.kind)).toEqual(["视频", "音频"]);
});

it("渠道没配上传服务时视频那行写明原因且不可点", () => {
  const options = assetOptions({ ...base, canUploadVideo: false });
  const video = options.find((item) => item.kind === "视频")!;
  expect(video.disabled).toBe(true);
  expect(video.hint).toContain("未配置上传服务");
});

it("「参考内容」这一格不给首尾帧/视频编辑重复摆入口", () => {
  const options = assetOptions(base);
  // 首尾帧：图片有自己的两格，参考内容里不再列图片
  expect(addableOptions(options, { repeatableImages: false, videoSlotRequired: false }).map((item) => item.kind))
    .toEqual(["视频", "音频"]);
  // 视频编辑：参考视频是必填槽位，也不重复列
  expect(addableOptions(options, { repeatableImages: true, videoSlotRequired: true }).map((item) => item.kind))
    .toEqual(["图片", "音频"]);
});
