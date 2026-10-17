import fs from "node:fs";
import path from "node:path";
import { createZip } from "./zip-archive.mjs";

const projectDir = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
const version = String(packageJson.version);
const releaseDir = path.join(projectDir, "src-tauri", "target", "release");
const artifactDir = path.join(projectDir, "artifacts");
const artifactName = `ezcanvas-v${version}-portable-win-x64`;
const portableDir = path.join(artifactDir, artifactName);
const zipPath = path.join(artifactDir, `${artifactName}.zip`);

const requiredPaths = [
  path.join(releaseDir, "image_relay_studio.exe"),
  path.join(releaseDir, "node.exe"),
  path.join(releaseDir, "resources"),
];
for (const requiredPath of requiredPaths) {
  if (!fs.existsSync(requiredPath)) {
    throw new Error(`Missing release artifact: ${requiredPath}. Run npm run tauri:build:exe first.`);
  }
}

// maxRetries: 便携目录有一百多兆，删到一半被 Defender 拦住会间歇性 EPERM
fs.rmSync(portableDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
fs.rmSync(zipPath, { force: true });
fs.mkdirSync(portableDir, { recursive: true });
fs.copyFileSync(
  path.join(releaseDir, "image_relay_studio.exe"),
  path.join(portableDir, "image_relay_studio.exe"),
);
fs.copyFileSync(path.join(releaseDir, "node.exe"), path.join(portableDir, "node.exe"));
fs.cpSync(path.join(releaseDir, "resources"), path.join(portableDir, "resources"), {
  recursive: true,
});

/**
 * 出货前最后一道闸。prepare-tauri.mjs 里也断言过一次，但那一次查的是**源树**；
 * 真正被打进包的是 Tauri 拷到 target/release 的那份副本，而那个拷贝是增量的
 * （只加不删），源树剪干净了副本里也可能还留着上次的残影。这里查的是**已经拷进
 * 便携目录的这一份**，也就是用户解压出来的东西本身。
 * 上限 180 是给「用户选的目录 + 便携包根目录名」留出余量，Windows 的 MAX_PATH 是 260。
 */
const MAX_RELATIVE_PATH = 180;
let longestEntry = 0;
let snapshotDirs = 0;
const inspectPortableTree = (current) => {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__image_snapshots__") snapshotDirs += 1;
      inspectPortableTree(full);
    } else {
      longestEntry = Math.max(longestEntry, path.relative(portableDir, full).length);
    }
  }
};
inspectPortableTree(portableDir);
if (snapshotDirs > 0) {
  throw new Error(
    `便携目录里还有 ${snapshotDirs} 个 __image_snapshots__，说明 ${path.join(releaseDir, "resources")} 是没清干净的旧副本。删掉它重新跑 npm run tauri:build:exe。`,
  );
}
if (longestEntry > MAX_RELATIVE_PATH) {
  throw new Error(
    `便携包里最长的相对路径有 ${longestEntry} 字符（上限 ${MAX_RELATIVE_PATH}），解压后会超过 Windows 的 260 字符上限，资源管理器和 Expand-Archive 都解不开。`,
  );
}
fs.writeFileSync(
  path.join(portableDir, "README-PORTABLE.txt"),
  [
    `ezcanvas v${version} portable Windows build`,
    "",
    "Run image_relay_studio.exe. Keep node.exe and resources\\ next to it.",
    "First launch: use the add-channel wizard to create channels, then fill in each model group's API key.",
    "Keys entered in the app are stored in %APPDATA%\\com.imagerelay.studio\\data\\channel-keys.json and reload on the next start.",
    "User data: %APPDATA%\\com.imagerelay.studio\\data",
    "",
  ].join("\r\n"),
  "utf8",
);

createZip({ zipPath, cwd: artifactDir, paths: [path.basename(portableDir)] });
