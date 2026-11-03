import { z } from "zod";

const variant = z.object({ id: z.string().min(1).max(80), name: z.string().trim().min(1).max(40).refine((name) => !/[、,，]/.test(name), "版本名称不能包含逗号或顿号"), prompt: z.string().max(1000).default(""), assetId: z.string().max(80).nullable().default(null) });
const setting = z.object({ name: z.string().trim().min(1).max(80), prompt: z.string().max(1000).default(""), assetId: z.string().max(80).nullable().default(null), variants: z.array(variant).max(12).default([]) });
export const storyboardShotSchema = z.object({
  id: z.string().min(1).max(80),
  prompt: z.string().trim().min(1).max(2000),
  duration: z.number().min(0.5).max(120).default(5),
  character: z.string().max(120).default(""),
  scene: z.string().max(80).default(""),
  characterVersions: z.record(z.string().max(80), z.string().max(80)).default({}),
  sceneVersionId: z.string().max(80).default(""),
  props: z.string().max(200).default(""),
  propVersions: z.record(z.string().max(80), z.string().max(80)).default({}),
  sourceText: z.string().max(3000).default(""),
  dialogue: z.string().max(1000).default(""),
  speaker: z.string().max(120).default(""),
  shotSize: z.string().max(40).default(""),
  cameraMove: z.string().max(80).default(""),
  videoPrompt: z.string().max(2000).default(""),
  soundEffect: z.string().max(500).default(""),
  finalImagePrompt: z.string().max(5000).default(""),
  finalVideoPrompt: z.string().max(5000).default(""),
});
export const storyboardProjectDataSchema = z.object({
  name: z.string().trim().min(1).max(80),
  brief: z.object({ contentType: z.string().max(80).default(""), duration: z.string().max(80).default(""), aspectRatio: z.string().max(40).default(""), style: z.string().max(300).default(""), density: z.string().max(80).default(""), fidelity: z.string().max(200).default("") }).default({ contentType: "", duration: "", aspectRatio: "", style: "", density: "", fidelity: "" }),
  characters: z.array(setting).max(12),
  scenes: z.array(setting).max(12),
  props: z.array(setting).max(12).default([]),
  shots: z.array(storyboardShotSchema).min(1).max(60),
}).superRefine((data, ctx) => {
  if (new Set(data.shots.map((shot) => shot.id)).size !== data.shots.length) ctx.addIssue({ code: "custom", message: "镜头 ID 重复", path: ["shots"] });
  for (const [field, values] of [["characters", data.characters], ["scenes", data.scenes], ["props", data.props]] as const) {
    if (new Set(values.map((item) => item.name)).size !== values.length) ctx.addIssue({ code: "custom", message: "名称不能重复", path: [field] });
    for (const [index, item] of values.entries()) {
      if (new Set(item.variants.map((entry) => entry.id)).size !== item.variants.length || new Set(item.variants.map((entry) => entry.name)).size !== item.variants.length) ctx.addIssue({ code: "custom", message: "同一设定的版本名称不能重复", path: [field, index, "variants"] });
    }
  }
});
export type StoryboardProjectData = z.infer<typeof storyboardProjectDataSchema>;
export type StoryboardProject = { id: string; revision: number; data: StoryboardProjectData };

export type StoryboardPreviewBoard = { id: string; title: string; shots: Array<{ shotId: string; image: import("./types.js").Asset | null; video: import("./types.js").Asset | null; audio: import("./types.js").Asset | null }> };

/** Deterministic prompt assembly; generated text remains editable by the user. */
export function assembleStoryboardPrompt(shot: Pick<StoryboardProjectData["shots"][number], "prompt" | "videoPrompt" | "shotSize" | "cameraMove">, kind: "image" | "video"): string {
  let text = kind === "image" ? shot.prompt.trim() : (shot.videoPrompt.trim() || [shot.prompt.trim(), "基于首帧保持角色和场景一致，动作自然连贯。"].filter(Boolean).join("；"));
  const fields: Array<[string, string]> = kind === "image" ? [["景别", shot.shotSize]] : [["景别", shot.shotSize], ["运镜", shot.cameraMove]];
  for (const [label, value] of fields) if (value.trim() && !text.includes(value.trim())) text += `${kind === "image" ? "，" : "；"}${label}：${value.trim()}`;
  return text;
}
