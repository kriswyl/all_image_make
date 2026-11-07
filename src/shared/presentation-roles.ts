/**
 * D1：整稿页面职责与布局计划（docs/document-reliability-development.md §6.3）。
 *
 * 只做**声明式规划**：给每页分配 role / seriesId / 推荐 layout，并做确定性的
 * 「连续同构图」检测。坐标仍由可信渲染代码生成，这里的输出不进入几何层。
 *
 * 版式字面量必须与 presentation-templates 的 slideContentSchema.layout 保持一致，
 * 由 server 侧测试断言两者不漂移。
 */
export const SLIDE_LAYOUTS = ["bullets", "cards", "process", "comparison", "table", "chart", "image"] as const;
export type SlideLayout = typeof SLIDE_LAYOUTS[number];

export const PAGE_ROLES = ["claim", "evidence", "comparison", "process", "case", "action", "section", "appendix"] as const;
export type PageRole = typeof PAGE_ROLES[number];

export const ROLE_LABEL: Record<PageRole, string> = {
  claim: "核心结论",
  evidence: "数据证据",
  comparison: "方案对比",
  process: "流程步骤",
  case: "案例",
  action: "行动建议",
  section: "章节转折",
  appendix: "附录",
};

/** 每种职责的候选版式。第一个是首选，后续是容量/内容不匹配时的降级选项。 */
const PREFERRED: Record<PageRole, SlideLayout[]> = {
  claim: ["bullets", "cards"],
  evidence: ["table", "chart", "bullets"],
  comparison: ["comparison", "table"],
  process: ["process", "cards"],
  case: ["cards", "bullets"],
  action: ["bullets", "process"],
  section: ["bullets"],
  appendix: ["table", "bullets"],
};

export function preferredLayouts(role: PageRole): SlideLayout[] {
  return [...PREFERRED[role]];
}

/** 模型没给 role 时的确定性兜底，避免整稿退化成一类页面。 */
export function inferRole(title: string, goal = "", position?: { index: number; contentCount: number }): PageRole {
  const text = `${title} ${goal}`;
  if (/对比|对照|比较|差异|优劣/.test(text)) return "comparison";
  if (/流程|步骤|阶段|路径|顺序|SOP/i.test(text)) return "process";
  if (/案例|实例|实践|复盘/.test(text)) return "case";
  if (/(数据|指标|趋势|统计|报表|证据|数字)/.test(text)) return "evidence";
  if (/行动|建议|下一步|落地|计划|待办/.test(text)) return "action";
  if (/附录|术语|参考|备查/.test(text)) return "appendix";
  if (position && position.contentCount > 1 && position.index === position.contentCount - 1) return "action";
  return "claim";
}

export type DeckPlanPage = {
  /** 1-based 正文页序号（不含封面），仅用于计划内部对齐。 */
  page: number;
  role: PageRole;
  /** 整稿规划里的系列标识；同系列的连续页允许使用同一版式。 */
  seriesId?: string;
  preferred: SlideLayout[];
  layout?: SlideLayout;
};

export type RepeatedRun = { start: number; end: number; layout: SlideLayout; roles: PageRole[]; pages: number[] };

/**
 * D3 的初始规则（D1 先用于报告与提示）：
 * 非同一系列、连续 ≥3 页使用同一版式、且承担不同职责 → 视为「无理由重复」。
 * 同 seriesId 的连续页（案例系列、步骤系列）不算重复。
 */
export function findRepeatedRuns(pages: DeckPlanPage[], minRun = 3): RepeatedRun[] {
  const runs: RepeatedRun[] = [];
  let start = 0;
  for (let index = 1; index <= pages.length; index++) {
    const current = pages[start]!;
    const next = pages[index];
    if (next && next.layout === current.layout) continue;
    const run = pages.slice(start, index);
    const roles = [...new Set(run.map(page => page.role))];
    const series = new Set(run.map(page => page.seriesId ?? `__solo_${page.page}`));
    if (run.length >= minRun && roles.length > 1 && series.size > 1) {
      runs.push({
        start: run[0]!.page, end: run[run.length - 1]!.page,
        layout: current.layout ?? current.preferred[0]!, roles, pages: run.map(page => page.page),
      });
    }
    start = index;
  }
  return runs;
}

/** 版式是否落在该职责的候选集合内；不在候选内只报告，不阻断交付。 */
export function layoutFitsRole(role: PageRole, layout: SlideLayout): boolean {
  return PREFERRED[role].includes(layout);
}

export type RoleConcentration = { role: PageRole; count: number; ratio: number };

/**
 * 职责集中度。模型容易把大多数单元都标成 claim，此时「连续同构图」规则会因为
 * 「职责相同」而失效；这里用确定性阈值把规划偷懒暴露出来（D1 只提示，D3 再定升级条件）。
 */
export function summarizeRoles(pages: DeckPlanPage[], threshold = 0.6): {
  distribution: Record<string, number>;
  concentration: RoleConcentration | null;
} {
  const distribution: Record<string, number> = {};
  for (const page of pages) distribution[page.role] = (distribution[page.role] ?? 0) + 1;
  const total = pages.length;
  if (!total) return { distribution, concentration: null };
  const top = Object.entries(distribution).sort((left, right) => right[1] - left[1])[0];
  if (!top) return { distribution, concentration: null };
  const ratio = top[1] / total;
  return {
    distribution,
    concentration: ratio >= threshold ? { role: top[0] as PageRole, count: top[1], ratio } : null,
  };
}
