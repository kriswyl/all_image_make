import { describe, expect, it } from "vitest";
import { GifWriter } from "omggif";
import { readGifAnimation } from "../src/server/media-frames";

function buildGif(colors: Array<[number, number, number]>, width = 4, height = 4, delay = 10) {
  const buffer = Buffer.alloc(1024 * 1024);
  const writer = new GifWriter(buffer, width, height, { loop: 0 });
  for (const [r, g, b] of colors) {
    const palette = [0x000000, (r << 16) | (g << 8) | b];
    const pixels = new Uint8Array(width * height).fill(1);
    writer.addFrame(0, 0, width, height, pixels, { palette, delay });
  }
  return buffer.subarray(0, writer.end());
}

describe("动图 GIF 抽帧", () => {
  it("按帧解码并保留时间戳", async () => {
    const gif = buildGif([[255, 0, 0], [0, 255, 0], [0, 0, 255]]);
    const animation = await readGifAnimation(gif, 6);
    expect(animation).not.toBeNull();
    expect(animation!.frameCount).toBe(3);
    expect(animation!.durationMs).toBe(300);
    expect(animation!.frames.map((frame) => frame.index)).toEqual([0, 1, 2]);
    expect(animation!.frames.map((frame) => frame.timeMs)).toEqual([0, 100, 200]);
    for (const frame of animation!.frames) {
      expect(frame.jpeg.length).toBeGreaterThan(100);
      expect(frame.jpeg.subarray(0, 2).toString("hex")).toBe("ffd8");
    }
  });

  it("帧数超过上限时首尾和中间都抽到", async () => {
    const gif = buildGif(Array.from({ length: 30 }, (_, index) => [index % 2 ? 255 : 0, 0, 0] as [number, number, number]));
    const animation = await readGifAnimation(gif, 4);
    expect(animation).not.toBeNull();
    expect(animation!.frameCount).toBe(30);
    expect(animation!.frames.length).toBe(4);
    expect(animation!.frames[0]!.index).toBe(0);
    expect(animation!.frames.at(-1)!.index).toBe(29);
    const indexes = animation!.frames.map((frame) => frame.index);
    expect(new Set(indexes).size).toBe(indexes.length);
  });

  it("单帧 GIF 也能读出帧数，供调用方标注静态图", async () => {
    const gif = buildGif([[255, 255, 255]]);
    const animation = await readGifAnimation(gif, 6);
    expect(animation!.frameCount).toBe(1);
    expect(animation!.frames).toHaveLength(1);
  });

  it("损坏或非 GIF 字节返回 null，不抛异常", async () => {
    expect(await readGifAnimation(Buffer.from("not a gif"))).toBeNull();
    expect(await readGifAnimation(Buffer.alloc(0))).toBeNull();
  });
});
