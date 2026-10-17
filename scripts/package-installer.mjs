import fs from "node:fs";
import path from "node:path";

const projectDir = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
const version = String(packageJson.version);
const bundleDir = path.join(projectDir, "src-tauri", "target", "release", "bundle", "nsis");
const source = path.join(bundleDir, `ChatCanvas_${version}_x64-setup.exe`);
const artifactDir = path.join(projectDir, "artifacts");
const target = path.join(artifactDir, `chatcanvas-v${version}-win-x64-setup.exe`);

if (!fs.existsSync(source)) throw new Error(`Missing installer: ${source}. Run npm run tauri:build first.`);
fs.mkdirSync(artifactDir, { recursive: true });
fs.copyFileSync(source, target);
console.log(`Created ${target}`);

// 开了 createUpdaterArtifacts 之后还会多出 .nsis.zip / .sig。
// 本地 release:installer 也一并收进 artifacts，发版时直接上传这一组。
for (const name of fs.readdirSync(bundleDir)) {
  if (!name.startsWith(`ChatCanvas_${version}_x64-setup.`)) continue;
  if (name.endsWith(".exe")) continue;
  const copied = path.join(artifactDir, name);
  fs.copyFileSync(path.join(bundleDir, name), copied);
  console.log(`Created ${copied}`);
}
