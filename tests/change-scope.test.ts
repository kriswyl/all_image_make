import { expect, it } from "vitest";
import { deriveChangeScope, resolveCheckSets, changeScopeCacheKey, type ChangeInputs } from "../src/shared/change-scope";

/** C 阶段：ChangeScope 推导与三个检查集合（文档 §4、§6.1）。 */
const base = (overrides: Partial<ChangeInputs> = {}): ChangeInputs => ({
  fileId: "file-1", sha256: "sha-1", totalPages: 10, ...overrides,
});
const allPages = (total: number) => Array.from({ length: total }, (_, index) => index + 1);

it("C01：只改第 3 页时，内容/审校/视觉集合都只含原页码 3", () => {
  const scope = deriveChangeScope(base({ pages: [3] }));
  expect(scope.effects).toEqual(["content"]);
  expect(scope.targets).toEqual([3]);
  expect(scope.preserveRest).toBe(true);
  const sets = resolveCheckSets(scope, 10);
  expect(sets).toMatchObject({
    contentPages: [3], auditPages: [3], visualPages: [3], widened: false,
  });
});

it("C02：多页局部修改保留原页码，不重编号、去重并升序", () => {
  const scope = deriveChangeScope(base({ pages: [7, 3, 7] }));
  expect(scope.targets).toEqual([3, 7]);
  const sets = resolveCheckSets(scope, 10);
  expect(sets.visualPages).toEqual([3, 7]);
  expect(sets.widened).toBe(false);
});

it("C03：整稿主题变化必须扩大到全稿集合", () => {
  const scope = deriveChangeScope(base({ pages: [3], design: true }));
  expect(scope.effects).toContain("appearance");
  const sets = resolveCheckSets(scope, 10);
  expect(sets.widened).toBe(true);
  expect(sets.contentPages).toEqual(allPages(10));
  expect(sets.auditPages).toEqual(allPages(10));
  expect(sets.visualPages).toEqual(allPages(10));
  expect(sets.reason).toMatch(/appearance/);
});

it("C04：页序 / 页数 / 共享资源变化同样扩域", () => {
  for (const overrides of [{ order: true }, { appendSlides: 2 }, { imageAssetIds: 1 }]) {
    const scope = deriveChangeScope(base({ pages: [3], ...overrides }));
    const sets = resolveCheckSets(scope, 10);
    expect(sets.widened).toBe(true);
    expect(sets.visualPages).toEqual(allPages(10));
  }
  expect(deriveChangeScope(base({ appendSlides: 2 })).effects).toContain("page_count");
  expect(deriveChangeScope(base({ order: true })).effects).toContain("order");
  expect(deriveChangeScope(base({ imageAssetIds: 1 })).effects).toContain("shared_resource");
});

it("C05：新增页后的全稿集合包含新页，不越界也不丢页", () => {
  const scope = deriveChangeScope(base({ appendSlides: 2, totalPages: 12 }));
  const sets = resolveCheckSets(scope, 12);
  expect(sets.visualPages).toEqual(allPages(12));
  expect(sets.visualPages.at(-1)).toBe(12);
});

it("C06：页码越界或非法必须拒绝，不静默截断", () => {
  expect(() => deriveChangeScope(base({ pages: [0] }))).toThrow();
  expect(() => deriveChangeScope(base({ pages: [11] }))).toThrow();
  expect(() => deriveChangeScope(base({ pages: [] }))).toThrow();
});

it("C07：缓存键包含主题、资源、渲染尺寸、引擎版本与检查策略", () => {
  const scope = deriveChangeScope(base({ pages: [3] }));
  const context = {
    themeHash: "theme-1", resourceHash: "res-1", renderSize: "1280x720",
    engineVersion: "template-v2", checkPolicy: "background",
  };
  const key = changeScopeCacheKey(scope, context);
  expect(key).toBe(changeScopeCacheKey(scope, { ...context }));
  for (const field of Object.keys(context) as Array<keyof typeof context>) {
    expect(changeScopeCacheKey(scope, { ...context, [field]: `${field}-changed` })).not.toBe(key);
  }
  // 页码集合不同也不能命中同一份检查缓存。
  expect(changeScopeCacheKey(deriveChangeScope(base({ pages: [4] })), context)).not.toBe(key);
  // 整稿扩域与局部检查不能共用缓存。
  expect(changeScopeCacheKey(deriveChangeScope(base({ pages: [3], design: true })), context)).not.toBe(key);
});
