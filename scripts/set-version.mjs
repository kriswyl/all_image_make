import fs from "node:fs";
import path from "node:path";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  throw new Error("Usage: npm run version:set -- 1.0.1");
}

const projectDir = process.cwd();
const packageSource = fs.readFileSync(path.join(projectDir, "package.json"), "utf8");
const currentVersion = JSON.parse(packageSource).version;
const [major, minor, patch] = version.split(".").map(Number);
const nextPatchVersion = `${major}.${minor}.${patch + 1}`;

function replaceFirst(relativePath, pattern, replacement) {
  const filePath = path.join(projectDir, relativePath);
  const source = fs.readFileSync(filePath, "utf8");
  if (!pattern.test(source)) throw new Error(`Version field not found in ${relativePath}`);
  const updated = source.replace(pattern, replacement);
  fs.writeFileSync(filePath, updated, "utf8");
}

replaceFirst("package.json", /("version"\s*:\s*")\d+\.\d+\.\d+(")/, `$1${version}$2`);
replaceFirst("package-lock.json", /("version"\s*:\s*")\d+\.\d+\.\d+(")/, `$1${version}$2`);
replaceFirst("package-lock.json", /("packages"\s*:\s*\{\s*""\s*:\s*\{[\s\S]*?"version"\s*:\s*")\d+\.\d+\.\d+(")/, `$1${version}$2`);
replaceFirst("src-tauri/tauri.conf.json", /("version"\s*:\s*")\d+\.\d+\.\d+(")/, `$1${version}$2`);
replaceFirst("src-tauri/Cargo.toml", /(^version\s*=\s*")\d+\.\d+\.\d+(")/m, `$1${version}$2`);
replaceFirst("src-tauri/Cargo.lock", /(name = "image_relay_studio"\s+version = ")\d+\.\d+\.\d+(")/, `$1${version}$2`);
replaceFirst("src/shared/app-config.ts", /(export const APP_VERSION = ")\d+\.\d+\.\d+(")/, `$1${version}$2`);

for (const relativePath of ["README.md", "PACKAGING.md", "DEVELOPMENT_HANDOFF.md"]) {
  const filePath = path.join(projectDir, relativePath);
  const source = fs.readFileSync(filePath, "utf8");
  const updated = source
    .replaceAll(currentVersion, version)
    .replace(/npm run version:set -- \d+\.\d+\.\d+/, `npm run version:set -- ${nextPatchVersion}`);
  fs.writeFileSync(filePath, updated, "utf8");
}

console.log(`Updated project version to ${version}`);
