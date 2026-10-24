/**
 * 外观主题的三档值只有「跟随系统 / 浅色 / 深色」，但存储里的值可能是旧版本、
 * 手改过的、甚至 null（第一次启动）。这里钉住两件事：
 * 认不出来的值一律退回「跟随系统」，以及「跟随系统」到底怎么解析。
 */
import { describe, expect, it } from "vitest";

import { normalizeThemeMode, resolveTheme } from "../src/client/theme";

describe("主题模式", () => {
  it("只认三档，其余一律回退到跟随系统", () => {
    expect(normalizeThemeMode("dark")).toBe("dark");
    expect(normalizeThemeMode("light")).toBe("light");
    expect(normalizeThemeMode("system")).toBe("system");
    expect(normalizeThemeMode("")).toBe("system");
    expect(normalizeThemeMode("sepia")).toBe("system");
    expect(normalizeThemeMode(null)).toBe("system");
    expect(normalizeThemeMode(undefined)).toBe("system");
  });

  it("手动模式不理会系统偏好", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("跟随系统时按系统偏好解析", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });
});
