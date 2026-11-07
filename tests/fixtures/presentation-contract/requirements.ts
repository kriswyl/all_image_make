import { FIXTURE_ASSET_ID, REQUIRED_CASES, REQUIRED_FACTS } from "./sources.js";

/** 用户提出的任务契约，与「18 章」的资料规模刻意解耦：章节多不等于页数多。 */
export const REQUIREMENTS = {
  pageCount: { kind: "exact" as const, value: 10, evidenceText: "10 页" },
  pageCountBasis: "total" as const,
  cover: "include" as const,
  requiredCases: REQUIRED_CASES,
  requiredFacts: REQUIRED_FACTS,
  requiredAssetIds: [FIXTURE_ASSET_ID],
  visualPolicy: "background" as const,
  /** 允许把多个章节合并到同一页，不要求一章一页 */
  chaptersMayMerge: true,
};

export const ALL_REQUIRED_TEXT = [...REQUIRED_CASES, ...REQUIRED_FACTS];
