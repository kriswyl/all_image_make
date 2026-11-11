import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import type { StoredFileRef } from "../db.js";

/** 用系统文件管理器打开目录：Windows 是 explorer，macOS 是 open，Linux 是 xdg-open */
export function revealFolder(dir: string) {
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  // 用 spawn + 参数数组而不是拼命令字符串：目录名里的引号、空格不会变成命令注入
  const child = spawn(command, [dir], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

/** 产物按记录自带的目录清理，参考图固定在 inputs/ */
export async function removeStoredFiles(assets: StoredFileRef[], inputs: string[], inputsDir: string) {
  await Promise.all([
    ...assets.map((asset) => removeStoredFile(asset.baseDir, asset.relativePath)),
    ...inputs.map((relativePath) => removeStoredFile(inputsDir, relativePath)),
  ]);
}

async function removeStoredFile(baseDir: string, relativePath: string) {
  const absolutePath = path.resolve(baseDir, relativePath);
  if (!absolutePath.startsWith(path.resolve(baseDir) + path.sep)) return;
  await fs.promises.rm(absolutePath, { force: true }).catch(() => undefined);
}
