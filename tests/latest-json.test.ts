/**
 * 更新 manifest 的测试。
 *
 * 这一层是整个自动更新链路里唯一能脱离网络和安装环境验证的部分，而且
 * 写错的后果很具体：平台键错了 → 更新器认为「没有可用更新」；URL 拼错了 →
 * 下载 404；signature 写成路径 → 下载后校验失败。三种都不会在本地开发时暴露。
 */
import { describe, expect, it } from "vitest";
import { buildLatestJson, extractChangelogNotes } from "../scripts/write-latest-json";

const signature = [
  "untrusted comment: signature from tauri secret key",
  "RWSabc123+/def456==",
].join("\n");

const base = {
  version: "2.2.1",
  notes: "修复了一些问题",
  pubDate: "2026-10-17T06:00:00.000Z",
  baseUrl: "https://github.com/kriswyl/all_image_make/releases/download/v2.2.1",
  fileName: "ezcanvas_2.2.1_x64-setup.nsis.zip",
  signature,
};

describe("buildLatestJson", () => {
  it("生成 Tauri updater 认得的形状：windows-x86_64 + 完整下载 URL", () => {
    const latest = buildLatestJson(base);
    expect(latest.version).toBe("2.2.1");
    expect(latest.notes).toBe("修复了一些问题");
    expect(latest.pub_date).toBe(base.pubDate);
    expect(Object.keys(latest.platforms)).toEqual(["windows-x86_64"]);
    expect(latest.platforms["windows-x86_64"].url).toBe(
      "https://github.com/kriswyl/all_image_make/releases/download/v2.2.1/ezcanvas_2.2.1_x64-setup.nsis.zip",
    );
    expect(latest.platforms["windows-x86_64"].signature).toBe(signature);
  });

  it("signature 保存的是内容而不是路径", () => {
    const latest = buildLatestJson(base);
    expect(latest.platforms["windows-x86_64"].signature).not.toContain(".sig");
    expect(latest.platforms["windows-x86_64"].signature.split("\n")).toHaveLength(2);
  });

  it("文件名里的空格与中文会被 URL 编码", () => {
    const latest = buildLatestJson({ ...base, fileName: "ezcanvas 安装包 2.2.1.zip" });
    expect(latest.platforms["windows-x86_64"].url).toContain("ezcanvas%20%E5%AE%89%E8%A3%85%E5%8C%85%202.2.1.zip");
  });

  it("baseUrl 末尾多余的斜杠不会拼出双斜杠", () => {
    const latest = buildLatestJson({ ...base, baseUrl: `${base.baseUrl}///` });
    expect(latest.platforms["windows-x86_64"].url).toBe(
      "https://github.com/kriswyl/all_image_make/releases/download/v2.2.1/ezcanvas_2.2.1_x64-setup.nsis.zip",
    );
  });

  it("拒绝不合法的版本号", () => {
    expect(() => buildLatestJson({ ...base, version: "v2.2.1" })).toThrow(/版本号/);
    expect(() => buildLatestJson({ ...base, version: "2.2" })).toThrow(/版本号/);
  });

  it("拒绝空签名和「把路径当签名」", () => {
    expect(() => buildLatestJson({ ...base, signature: "  " })).toThrow(/签名内容为空/);
    expect(() => buildLatestJson({ ...base, signature: "C:\\tmp\\a.sig" })).toThrow(/文件路径/);
    expect(() => buildLatestJson({ ...base, signature: "/tmp/a.sig" })).toThrow(/文件路径/);
  });

  it("拒绝非 http(s) 的 baseUrl", () => {
    expect(() => buildLatestJson({ ...base, baseUrl: "ftp://example.com" })).toThrow(/http/);
  });
});

describe("extractChangelogNotes", () => {
  const changelog = [
    "# 更新日志",
    "",
    "## v2.2.1 — 2026-10-17",
    "",
    "### 修复",
    "",
    "- 第一处修复",
    "- 第二处修复",
    "",
    "---",
    "",
    "## v2.2.0 — 2026-10-17",
    "",
    "更早的内容",
  ].join("\n");

  it("只截取目标版本的小节，不把上一版带进来", () => {
    const notes = extractChangelogNotes(changelog, "2.2.1");
    expect(notes).toContain("第一处修复");
    expect(notes).toContain("第二处修复");
    expect(notes).not.toContain("更早的内容");
    expect(notes).not.toContain("## v2.2.0");
  });

  it("支持带 v 前缀的版本号", () => {
    expect(extractChangelogNotes(changelog, "v2.2.1")).toContain("第一处修复");
  });

  it("版本不存在时返回空串而不是报错", () => {
    expect(extractChangelogNotes(changelog, "9.9.9")).toBe("");
  });
});
