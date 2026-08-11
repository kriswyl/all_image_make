import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const projectDir = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
const version = String(packageJson.version);
const releaseDir = path.join(projectDir, "src-tauri", "target", "release");
const artifactDir = path.join(projectDir, "artifacts");
const artifactName = `向量生图-v${version}-portable-win-x64`;
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

fs.rmSync(portableDir, { recursive: true, force: true });
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
fs.writeFileSync(
  path.join(portableDir, "README-PORTABLE.txt"),
  [
    `向量生图 v${version} portable Windows build`,
    "",
    "Run image_relay_studio.exe. Keep node.exe and resources\\ next to it.",
    "Configure the VectorEngine API key inside the app or through VECTORENGINE_API_KEY.",
    "The app includes default VectorEngine channels; replace {向量引擎key} with your own key.",
    "User data: %APPDATA%\\com.imagerelay.studio\\data",
    "",
  ].join("\r\n"),
  "utf8",
);

const tar = spawnSync(
  "tar.exe",
  ["-a", "-c", "-f", zipPath, "-C", artifactDir, path.basename(portableDir)],
  { stdio: "inherit" },
);
if (tar.error) throw tar.error;
if (tar.status !== 0) throw new Error(`tar exited with ${tar.status}`);

console.log(`Created ${zipPath}`);
