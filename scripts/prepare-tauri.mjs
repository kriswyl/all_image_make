import fs from "node:fs";
import path from "node:path";

const projectDir = process.cwd();
const serverSource = path.join(projectDir, "dist", "server");
const serverTarget = path.join(projectDir, "src-tauri", "resources", "server");
const binaryDir = path.join(projectDir, "src-tauri", "binaries");
const packageJsonPath = path.join(projectDir, "package.json");
const packageLockPath = path.join(projectDir, "package-lock.json");
const serverDependencies = ["express", "multer", "zod"];
const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE || "x86_64-pc-windows-msvc";
// externalBin 的命名规则：Windows 带 .exe 后缀，macOS/Linux 无后缀
const binarySuffix = process.platform === "win32" ? ".exe" : "";
const nodeTarget = path.join(binaryDir, `node-${targetTriple}${binarySuffix}`);

if (!fs.existsSync(path.join(serverSource, "server", "index.js"))) {
  throw new Error("dist/server/server/index.js 不存在，请先完成后端构建");
}

fs.rmSync(serverTarget, { recursive: true, force: true });
fs.mkdirSync(path.dirname(serverTarget), { recursive: true });
fs.cpSync(serverSource, serverTarget, { recursive: true });
fs.copyFileSync(packageJsonPath, path.join(serverTarget, "package.json"));

const packageLock = JSON.parse(fs.readFileSync(packageLockPath, "utf8"));
const lockedPackages = packageLock.packages || {};
const productionPackages = new Set(serverDependencies.map((name) => `node_modules/${name}`));
const pendingPackages = [...productionPackages];

function resolveDependency(packagePath, dependencyName) {
  let currentPath = packagePath;
  while (currentPath.startsWith("node_modules/")) {
    const nestedPath = `${currentPath}/node_modules/${dependencyName}`;
    if (lockedPackages[nestedPath]) return nestedPath;
    const parentIndex = currentPath.lastIndexOf("/node_modules/");
    if (parentIndex < 0) break;
    currentPath = currentPath.slice(0, parentIndex);
  }
  const rootPath = `node_modules/${dependencyName}`;
  return lockedPackages[rootPath] ? rootPath : undefined;
}

while (pendingPackages.length > 0) {
  const packagePath = pendingPackages.pop();
  const metadata = lockedPackages[packagePath];
  if (!metadata) throw new Error(`Missing ${packagePath} in package-lock.json`);
  const dependencies = {
    ...(metadata.dependencies || {}),
    ...(metadata.optionalDependencies || {}),
  };

  for (const dependencyName of Object.keys(dependencies)) {
    const dependencyPath = resolveDependency(packagePath, dependencyName);
    if (!dependencyPath || productionPackages.has(dependencyPath)) continue;
    productionPackages.add(dependencyPath);
    pendingPackages.push(dependencyPath);
  }
}

for (const relativePath of productionPackages) {
  const source = path.join(projectDir, relativePath);
  if (!fs.existsSync(source)) continue;
  const target = path.join(serverTarget, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

fs.mkdirSync(binaryDir, { recursive: true });
if (!["win32", "darwin"].includes(process.platform)) {
  throw new Error(`不支持的打包平台：${process.platform}`);
}
fs.copyFileSync(process.execPath, nodeTarget);
// macOS 要求 sidecar 二进制带可执行位，否则打进 .app 后无法启动
if (process.platform !== "win32") fs.chmodSync(nodeTarget, 0o755);

console.log(
  `Prepared Tauri server resources with ${productionPackages.size} production packages and ${path.basename(nodeTarget)}`,
);
