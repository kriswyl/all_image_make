import type { Asset, Task } from "./types.js";

export interface Skill {
  id: string;
  version: number;
  name: string;
  description: string;
}

export const SAMPLE_IMAGE_SKILL = {
  id: "sample-image-batch",
  version: 1,
  name: "按样片批量改图",
  description: "读取实拍图和一组样片，逐张提炼风格，按样片顺序改图。",
} satisfies Skill;

export const MAX_SKILL_SAMPLES = 32;
export const compareSkillSampleNames = new Intl.Collator("zh-CN", { numeric: true }).compare;

export function imageSkillInvocation(text: string): string | undefined {
  const match = /^(?:\/skill\s+sample-image-batch|(?:用|使用)\s*「?按?样片批量改图」?)(?:\s*[：:]\s*([\s\S]*))?$/i.exec(text.trim());
  return match ? (match[1] ?? "").trim() : undefined;
}
export const SAMPLE_FIELDS = {
  composition: "构图",
  colors: "配色",
  lighting: "光线",
  background: "背景",
  texture: "质感",
} as const;
export type SampleField = keyof typeof SAMPLE_FIELDS;
export type SampleAnalysis = Record<SampleField, string>;

export interface ImageSkillTarget {
  channelId: string;
  model: string;
  size?: string;
  aspectRatio?: string;
}

export interface ImageSkillInput extends ImageSkillTarget {
  subjectId: string;
  samples: Array<{ assetId: string; name: string }>;
  referenceSetId?: string;
  requirements: string;
}

export interface ImageSkillRun {
  id: string;
  skillId: string;
  subjectId: string;
  target: ImageSkillTarget;
  requirements: string;
  reusableRules?: string;
  savedSkillId?: string;
  confirmed: boolean;
  submitting: boolean;
  items: Array<{
    sample: Asset;
    name: string;
    analysis: SampleAnalysis;
    fields: SampleField[];
    task: Task | null;
    error: string | null;
  }>;
}

export interface SkillReferenceSet {
  id: string;
  name: string;
  count: number;
}

export interface ImageSkillHistory {
  id: string;
  model: string;
  count: number;
  updatedAt: string;
}

export interface SavedImageSkill extends Skill {
  rules: string;
  fields: SampleField[];
  size?: string;
  aspectRatio?: string;
}

export interface ImageSkillChat {
  folderName?: string;
  samples: ImageSkillInput["samples"];
  subjectId?: string;
  savedSkillId?: string;
  target?: ImageSkillTarget;
  runId?: string;
}

export interface ImageSkillChatInput {
  text: string;
  folder?: { name: string; samples: ImageSkillInput["samples"] };
  subjectId?: string;
  savedSkillId?: string;
  target?: ImageSkillTarget;
}

export function savedImageSkillMarkdown(skill: SavedImageSkill) {
  const dimensions = skill.size ?? skill.aspectRatio;
  return [
    "---", `name: ${skill.id}`, `description: ${JSON.stringify(skill.description)}`, "---", "",
    `# ${skill.name}`, "",
    "1. 读取用户选择的样片目录和明确指定的底图。样片按文件名排序，每张独立分析并对应一张成品。",
    "2. 结合本次需求和样片内容，只询问会实质影响结果的未知条件。本次要求优先于 Skill 默认值。",
    `3. 优先参考样片的${skill.fields.map((field) => SAMPLE_FIELDS[field]).join("、")}。保留底图主体的识别特征。涉及商品时，以底图的商品原色为准，保留形状、标识和包装文字。`,
    "4. 展示逐张对应的方案，确认后逐张提交，保留顺序和执行结果。",
    ...(dimensions ? ["", `默认画幅 ${dimensions}，允许按次覆盖。`] : []),
    ...(skill.rules ? ["", "## 已确认的偏好", "", skill.rules] : []),
    "",
  ].join("\n");
}
