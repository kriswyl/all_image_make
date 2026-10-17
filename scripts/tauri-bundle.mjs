import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `tauri build` 的本地入口。
 *
 * 开了 `createUpdaterArtifacts` 之后，每次「打安装包」都必须有 minisign 私钥；
 * 而私钥不能进仓库，所以构建前在这里从固定位置找一次。找不到就**当场说清楚**，
 * 而不是让 Tauri 在打包最后一步抛一句含糊的签名失败。
 *
 * `--no-bundle`（只出 exe，便携版用）不产出更新包，不需要私钥，直接放行。
 */
const args = process.argv.slice(2);
const noBundle = args.includes("--no-bundle");
const env = { ...process.env };

if (!noBundle && !env.TAURI_SIGNING_PRIVATE_KEY && !env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
  const keyPath = env.TAURI_UPDATER_KEY_PATH || path.join(os.homedir(), ".tauri", "chatcanvas-updater.key");
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      [
        `找不到更新签名私钥：${keyPath}`,
        "",
        "首次生成（私钥只生成一次，丢了就再也无法给已安装用户推送更新）：",
        '  npx tauri signer generate -w "%USERPROFILE%\\.tauri\\chatcanvas-updater.key"',
        "",
        "已有私钥放在别处时，用 TAURI_UPDATER_KEY_PATH 指向它。",
        "只打便携版（不需要更新包）请用 npm run tauri:build:exe。",
      ].join("\n"),
    );
  }
  // 用内容而不是 *_KEY_PATH：打包器的签名步骤只认 TAURI_SIGNING_PRIVATE_KEY
  //（PATH 那个变量只对 `tauri signer sign` 生效），传路径会报
  // "A public key has been found, but no private key."
  env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(keyPath, "utf8").trim();
  // 密钥是加密格式（哪怕密码为空）。不显式给一个空密码，CLI 会停下来
  // 交互式要密码，在无 TTY 的构建里就卡死。
  if (env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "";
  }
  console.log(`使用更新签名私钥：${keyPath}`);
}

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriCli = path.join(projectDir, "node_modules", "@tauri-apps", "cli", "tauri.js");

const child = spawn(process.execPath, [tauriCli, "build", ...args], {
  stdio: "inherit",
  env,
  cwd: projectDir,
});
child.on("error", (error) => {
  console.error(`启动 Tauri CLI 失败：${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Tauri CLI 被信号 ${signal} 终止`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
