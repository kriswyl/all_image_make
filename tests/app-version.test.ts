import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 版本号散落在 6 个文件里：前端显示的 APP_VERSION、package.json、
 * package-lock.json（两处）、tauri.conf.json、Cargo.toml、Cargo.lock。
 *
 * v2.4.1 发版时漏改了 app-config.ts，结果用户明明装上了新版，界面还写着
 * 旧版本（「已是最新版本 v2.4.0」/「本地运行 v2.4.0」）。这类错误用户看得见、
 * 又不影响功能，光靠手工核对必漏——钉一道测试，发版前跑一次就能挡住。
 */
const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const json = (file: string) => JSON.parse(read(file)) as Record<string, unknown>;

describe("版本号一致性", () => {
  const fromPackage = (json("package.json").version as string).trim();

  it("package.json 的版本号是合法语义版本", () => {
    expect(fromPackage).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("前端显示的 APP_VERSION 等于 package.json（界面显示不能停在旧版）", async () => {
    const { APP_VERSION } = await import("../src/shared/app-config");
    expect(APP_VERSION).toBe(fromPackage);
  });

  it("package-lock.json 的根版本与包版本一致", () => {
    const lock = json("package-lock.json");
    expect(lock.version).toBe(fromPackage);
    const packages = lock.packages as Record<string, { version?: string }>;
    expect(packages?.[""]?.version).toBe(fromPackage);
  });

  it("Tauri 配置与 Cargo 清单的版本一致", () => {
    const tauri = json("src-tauri/tauri.conf.json") as { version?: string };
    expect(tauri.version).toBe(fromPackage);
    const cargoToml = read("src-tauri/Cargo.toml").replace(/\r\n/g, "\n");
    expect(cargoToml).toMatch(new RegExp(`^version = "${fromPackage}"$`, "m"));
  });

  it("Cargo.lock 里主包的版本一致", () => {
    const cargoToml = read("src-tauri/Cargo.toml").replace(/\r\n/g, "\n");
    const packageName = /^name = "(.+)"$/m.exec(cargoToml)?.[1];
    expect(packageName).toBeTruthy();
    const lock = read("src-tauri/Cargo.lock").replace(/\r\n/g, "\n");
    const block = new RegExp(`\\[\\[package\\]\\]\\nname = "${packageName}"\\nversion = "([^"]+)"`);
    expect(lock.match(block)?.[1]).toBe(fromPackage);
  });
});
