/**
 * C 阶段：修改范围与检查集合（docs/document-reliability-development.md §4、§6.1）。
 *
 * 纯函数层，不依赖数据库或渲染器。ChangeScope 由**服务端根据操作参数推导**，
 * 模型不能自报 targets 或 effects；页码是 1-based 原页码，截取子集时不得重编号。
 */

export type ScopeEffect = "content" | "appearance" | "order" | "page_count" | "shared_resource";

export type ChangeScope = {
  fileId: string;
  sha256: string;
  targets: number[];
  preserveRest: true;
  effects: ScopeEffect[];
};

export type ChangeInputs = {
  fileId: string;
  sha256: string;
  /** 修改前源文件的页数，用于校验 targets 不越界。 */
  totalPages: number;
  pages?: number[];
  appendSlides?: number;
  order?: boolean;
  design?: boolean;
  imageAssetIds?: number;
};

/** 会改变整稿呈现或依赖关系的 effect：命中任一项就把三个检查集合扩大到全稿。 */
const WIDENING_EFFECTS = new Set<ScopeEffect>(["appearance", "order", "page_count", "shared_resource"]);

export function deriveChangeScope(input: ChangeInputs): ChangeScope {
  if (!Number.isSafeInteger(input.totalPages) || input.totalPages < 1) throw new Error("源文件页数不合法");
  // pages: [] 允许与 appendSlides/design 等操作共存；完全没有 effect 才拒绝。
  const effects: ScopeEffect[] = [];
  if (input.pages?.length) effects.push("content");
  if (input.design) effects.push("appearance");
  if (input.order) effects.push("order");
  if ((input.appendSlides ?? 0) > 0) effects.push("page_count");
  if ((input.imageAssetIds ?? 0) > 0) effects.push("shared_resource");
  if (!effects.length) throw new Error("没有可推导的修改范围");

  const targets = [...new Set(input.pages ?? [])].sort((a, b) => a - b);
  for (const page of targets) {
    if (!Number.isSafeInteger(page) || page < 1 || page > input.totalPages) {
      throw new Error(`修改页码 ${page} 超出源文件 1–${input.totalPages} 页范围`);
    }
  }
  return { fileId: input.fileId, sha256: input.sha256, targets, preserveRest: true, effects };
}

export type CheckSets = {
  /** 内容生成 / 重新提交模型的页面集合。 */
  contentPages: number[];
  /** 内容审校页面集合。 */
  auditPages: number[];
  /** 视觉检查页面集合。WPS 仍可能加载整稿，这里只约束模型提交范围。 */
  visualPages: number[];
  widened: boolean;
  reason: string;
  effects: ScopeEffect[];
};

export function resolveCheckSets(scope: ChangeScope, totalPages: number): CheckSets {
  if (!Number.isSafeInteger(totalPages) || totalPages < 1) throw new Error("目标文件页数不合法");
  const all = Array.from({ length: totalPages }, (_, index) => index + 1);
  const widening = scope.effects.filter(effect => WIDENING_EFFECTS.has(effect));
  if (widening.length) {
    return {
      contentPages: all, auditPages: all, visualPages: all,
      widened: true,
      reason: `共享主题、资源、页序或页数变化需要扩域：${widening.join(", ")}`,
      effects: scope.effects,
    };
  }
  const targets = scope.targets.filter(page => page <= totalPages);
  return {
    contentPages: targets, auditPages: targets, visualPages: targets,
    widened: false, reason: "仅局部内容页变化", effects: scope.effects,
  };
}

/** 缓存键上下文：主题、资源、渲染尺寸、引擎版本与检查策略都参与，不能只依赖页码。 */
export type CheckCacheContext = {
  themeHash: string;
  resourceHash: string;
  renderSize: string;
  engineVersion: string;
  checkPolicy: string;
};

/**
 * 返回稳定的可组合键字符串（调用方可直接用作 map key 或再取 sha256）。
 * 旧版本的检查状态不会被无条件复制到新版本：fileId/sha256/targets/effects 都参与。
 */
export function changeScopeCacheKey(scope: ChangeScope, context: CheckCacheContext): string {
  return JSON.stringify([
    "change-scope-v1", scope.fileId, scope.sha256,
    [...scope.targets].sort((a, b) => a - b),
    [...scope.effects].sort(),
    context.themeHash, context.resourceHash, context.renderSize,
    context.engineVersion, context.checkPolicy,
  ]);
}
