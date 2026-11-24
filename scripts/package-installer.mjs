import fs from "node:fs";
import path from "node:path";
import { readBrand } from "./brand.mjs";

const projectDir = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
const version = String(packageJson.version);
const bundleDir = path.join(projectDir, "src-tauri", "target", "release", "bundle", "nsis");
const brand = readBrand();
const bundleName = `${brand.productName}_${version}_x64-setup`;
const source = path.join(bundleDir, `${bundleName}.exe`);
const artifactDir = path.join(projectDir, "artifacts");
/**
 * 从 NSIS 目录收产物（安装包 + 更新包 + 签名）。
 *
 * Tauri 按 productName 命名产物，中文品牌会得到中文文件名；而更新清单里的
 * `url` 必须是可预测的 ASCII 名，Gitee 上传也需要它。所以这里统一改写成
 * `<品牌 id>-v<版本>-win-x64-setup.*`，exe 与 .sig 一一对应。
 */
const artifactBase = `${brand.id}-v${version}-win-x64-setup`;
const pairs = [
  [`${bundleName}.exe`, `${artifactBase}.exe`],
  [`${bundleName}.exe.sig`, `${artifactBase}.exe.sig`],
  [`${bundleName}.nsis.zip`, `${artifactBase}.nsis.zip`],
  [`${bundleName}.nsis.zip.sig`, `${artifactBase}.nsis.zip.sig`],
];

fs.mkdirSync(artifactDir, { recursive: true });
let copiedInstaller = false;
for (const [from, to] of pairs) {
  const sourceFile = path.join(bundleDir, from);
  if (!fs.existsSync(sourceFile)) continue;
  const copied = path.join(artifactDir, to);
  fs.copyFileSync(sourceFile, copied);
  console.log(`Created ${copied}`);
  if (to.endsWith(".exe")) copiedInstaller = true;
}
if (!copiedInstaller) throw new Error(`Missing installer: ${source}. Run npm run tauri:build first.`);
