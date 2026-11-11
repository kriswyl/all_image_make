/**
 * 参考素材的类型判定。
 *
 * 现实里最常出问题的是 `.m4a`：Windows 上 `File.type` 常常是空串，表单以
 * application/octet-stream 发出去，服务端的 MIME 白名单直接拒掉。判定改成
 * 扩展名优先之后，大写 `.M4A`、空类型、octet-stream 都得认得出来。
 */
import { expect, it } from "vitest";
import { fileExtension, referenceMediaType } from "../src/shared/reference-media";

it("扩展名统一转小写", () => {
  expect(fileExtension("clip.MP4")).toBe("mp4");
  expect(fileExtension("no-extension")).toBe("");
});

it("小写与大写 m4a 都按音频处理，并补上规范 MIME", () => {
  expect(referenceMediaType({ name: "voice.m4a", type: "" })).toEqual({ kind: "audio", mime: "audio/mp4" });
  expect(referenceMediaType({ name: "voice.M4A", type: "" })).toEqual({ kind: "audio", mime: "audio/mp4" });
  // 浏览器把类型报成 octet-stream 时也不能误判
  expect(referenceMediaType({ name: "voice.m4a", type: "application/octet-stream" }))
    .toEqual({ kind: "audio", mime: "audio/mp4" });
});

it("其余音频格式同样按扩展名认", () => {
  expect(referenceMediaType({ name: "a.mp3", type: "" })?.mime).toBe("audio/mpeg");
  expect(referenceMediaType({ name: "a.WAV", type: "" })?.mime).toBe("audio/wav");
  expect(referenceMediaType({ name: "a.aac", type: "" })?.mime).toBe("audio/aac");
});

it("视频只认 MP4 / MOV", () => {
  expect(referenceMediaType({ name: "clip.MOV", type: "" })).toEqual({ kind: "video", mime: "video/quicktime" });
  expect(referenceMediaType({ name: "clip.mp4", type: "video/mp4" })).toEqual({ kind: "video", mime: "video/mp4" });
  // 扩展名不认识就看 MIME；webm 不是这里的合法参考视频
  expect(referenceMediaType({ name: "clip", type: "video/webm" })).toBeNull();
  expect(referenceMediaType({ name: "notes.txt", type: "text/plain" })).toBeNull();
});
