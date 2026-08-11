import fs from "node:fs";
import path from "node:path";

const projectDir = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
const version = String(packageJson.version);
const source = path.join(
  projectDir,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "nsis",
  `向量生图_${version}_x64-setup.exe`,
);
const artifactDir = path.join(projectDir, "artifacts");
const target = path.join(artifactDir, `向量生图-v${version}-win-x64-setup.exe`);

if (!fs.existsSync(source)) throw new Error(`Missing installer: ${source}. Run npm run tauri:build first.`);
fs.mkdirSync(artifactDir, { recursive: true });
fs.copyFileSync(source, target);

console.log(`Created ${target}`);
