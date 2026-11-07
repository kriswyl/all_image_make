/** 验收期望：由开发者根据虚构资料独立编写，模型输出不得修改本文件。 */
export const EXPECTED = {
  totalPages: 10,
  revisedPages: 12,
  contentPages: 9,
  /** 18 章必须能在 9 个正文页内合并，不能按章节数拆成 19 页 */
  chapterEstimate: 19,
  visibleFactsRequired: 3,
  visibleCasesRequired: 3,
  /** 只修改第 3 页时，其他 9 页结构化内容必须完全一致 */
  localEditTargets: [3],
  readiness: "ready" as const,
  draftNotUsable: true,
  forkMustNotInherit: true,
  neutralChatMustNotCreateSpec: true,
};
