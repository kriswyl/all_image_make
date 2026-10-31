import { describe, expect, it } from "vitest";
import { buildDraftContent, type DraftShot } from "../src/server/jianying-draft";

const clip = (name: string, durationUs: number) => ({ path: `D:/drafts/materials/${name}.mp4`, name: `${name}.mp4`, durationUs });

function shots(): DraftShot[] {
  return [
    { clip: clip("001", 3_000_000), clipKind: "video", durationUs: 3_000_000 },
    { clip: clip("002", 2_000_000), clipKind: "video", audio: { path: "D:/drafts/materials/002.wav", name: "002.wav", durationUs: 2_000_000 }, durationUs: 2_000_000 },
    { clip: { path: "D:/drafts/materials/003.png", name: "003.png", durationUs: 0 }, clipKind: "photo", durationUs: 1_500_000 },
  ];
}

describe("剪映草稿", () => {
  it("按镜头顺序累积时间线，视频轨与音频轨分开", () => {
    const { content, durationUs } = buildDraftContent({ name: "成片", width: 1920, height: 1080, shots: shots() });
    expect(durationUs).toBe(6_500_000);
    expect(content.duration).toBe(6_500_000);

    const tracks = content.tracks as Array<{ type: string; segments: Array<{ target_timerange: { start: number; duration: number } }> }>;
    const video = tracks.find((track) => track.type === "video")!;
    const audio = tracks.find((track) => track.type === "audio")!;
    expect(video.segments.map((item) => item.target_timerange.start)).toEqual([0, 3_000_000, 5_000_000]);
    expect(audio.segments).toHaveLength(1);
    expect(audio.segments[0]!.target_timerange.start).toBe(3_000_000);

    const materials = content.materials as { videos: Array<{ type: string }>; audios: unknown[]; speeds: unknown[]; canvases: unknown[]; sound_channel_mappings: unknown[] };
    expect(materials.videos).toHaveLength(3);
    expect(materials.videos.filter((item) => item.type === "photo")).toHaveLength(1);
    expect(materials.audios).toHaveLength(1);
    // 每个 segment 都要有 speed / canvas / mapping 可引用，数量必须和镜头对得上
    expect(materials.speeds).toHaveLength(4);
    expect(materials.canvases).toHaveLength(4);
    expect(materials.sound_channel_mappings).toHaveLength(4);
  });

  it("没有镜头时不产生轨道", () => {
    const { content, durationUs } = buildDraftContent({ name: "空", width: 1080, height: 1920, shots: [] });
    expect(durationUs).toBe(0);
    expect(content.tracks).toEqual([]);
  });
});
