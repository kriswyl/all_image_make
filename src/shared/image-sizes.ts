/**
 * OpenAI Images 渠道的常用尺寸预设。
 *
 * 工作台（生成页）和无限画布检查器共用这一份，避免两边列表慢慢漂移。
 * 只是「建议值」：上游实际接受哪些尺寸取决于模型和渠道，所以两边都允许手填。
 */
export const OPENAI_SIZE_GROUPS = [
  { label: "方形", sizes: ["1024x1024", "2048x2048"] },
  { label: "横向", sizes: ["1280x720", "1536x1024", "1600x1200", "2048x1152", "3840x2160"] },
  { label: "纵向", sizes: ["720x1280", "1024x1536", "1200x1600", "1152x2048", "2160x3840"] },
] as const;

/** 拍平后的预设，给 `<datalist>` 这种不支持分组的地方用 */
export const OPENAI_SIZE_PRESETS: readonly string[] = OPENAI_SIZE_GROUPS.flatMap((group) => [...group.sizes]);
