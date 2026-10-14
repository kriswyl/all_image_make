import fs from "node:fs";
import path from "node:path";

const projectDir = process.cwd();
const serverSource = path.join(projectDir, "dist", "server");
const serverTarget = path.join(projectDir, "src-tauri", "resources", "server");
const binaryDir = path.join(projectDir, "src-tauri", "binaries");
const packageJsonPath = path.join(projectDir, "package.json");
const packageLockPath = path.join(projectDir, "package-lock.json");
/**
 * Windows 上刚写完的一百多兆文件常常还在被 Defender 扫，这时候删除会间歇性 EPERM
 * （报 `EPERM, Permission denied` 然后整个打包失败，重跑一次又好了）。
 * Node 的 rmSync 在 Windows 上会对 EPERM/EBUSY 重试，但默认次数是 0，得自己补。
 */
function removeTree(target) {
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
}

const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE || "x86_64-pc-windows-msvc";
// externalBin 的命名规则：Windows 带 .exe 后缀，macOS/Linux 无后缀
const binarySuffix = process.platform === "win32" ? ".exe" : "";
const nodeTarget = path.join(binaryDir, `node-${targetTriple}${binarySuffix}`);

if (!fs.existsSync(path.join(serverSource, "server", "index.js"))) {
  throw new Error("dist/server/server/index.js 不存在，请先完成后端构建");
}

// 要打进安装包的依赖，从「编译产物里真的 import 了什么」推出来，而不是维护一份手写名单。
// 手写名单漏一个的代价是安装包启动即崩（`ERR_MODULE_NOT_FOUND`），而 web 开发模式
// **永远复现不出来**——那儿加载的是项目根的 node_modules，什么都在。jimp 就是这么漏的：
// src/server/vision.ts 引了它，名单里却只有 express / multer / zod，于是 2.1.0 装完打不开。
function collectBareSpecifiers(dir) {
  const specifiers = new Set();
  const importPattern = /(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".js")) {
        for (const match of fs.readFileSync(full, "utf8").matchAll(importPattern)) {
          const specifier = match[1];
          // 相对路径、绝对路径和内置模块（node:）都不需要打包
          if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) continue;
          specifiers.add(specifier);
        }
      }
    }
  };
  walk(dir);
  return specifiers;
}

// `@scope/pkg/deep/path` → `@scope/pkg`；`pkg/deep/path` → `pkg`
function packageNameOf(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

/**
 * 剪掉运行时用不到、却会把解压路径撑爆的东西：
 * - `__image_snapshots__`：上游包自带的 jest 快照。@jimp/plugin-print 里那些文件名动辄上百
 *   字符，加上便携包的根目录就突破 Windows 的 260 字符 MAX_PATH，资源管理器 / .NET 的
 *   Expand-Archive 会报 DirectoryNotFoundException 而**根本解不开**（Info-ZIP 能解，但用户
 *   看到的只是解压失败）。一共才 1.5MB，剔掉它相对路径从 175 掉回 102。
 * - `*.map`：只有调试器会读。
 * `src/` **不能**一起删：debug 和 gifwrap 的 package.json main 就是 `src/index.js`，而 Express 依赖 debug。
 */
const prunableDirectories = new Set(["__image_snapshots__"]);

function pruneNonRuntimeFiles(current) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (prunableDirectories.has(entry.name)) {
        removeTree(full);
      } else {
        pruneNonRuntimeFiles(full);
      }
    } else if (entry.name.endsWith(".map")) {
      fs.rmSync(full, { force: true });
    }
  }
}

function longestRelativePath(dir) {
  let longest = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        longest = Math.max(longest, path.relative(dir, full).length);
      }
    }
  };
  walk(dir);
  return longest;
}

const declaredDependencies = new Set(Object.keys(JSON.parse(fs.readFileSync(packageJsonPath, "utf8")).dependencies || {}));
const serverDependencies = [...new Set([...collectBareSpecifiers(serverSource)].map(packageNameOf))].sort();
for (const name of serverDependencies) {
  if (!declaredDependencies.has(name)) {
    throw new Error(`服务端引用了 ${name}，但 package.json 的 dependencies 里没有它——先 npm install ${name}，再重新打包`);
  }
}

removeTree(serverTarget);
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
  if (!fs.existsSync(source)) {
    // 直接依赖缺席是硬错误：少一份就是安装包启动即崩。
    // 传递依赖可能只是本平台没装的 optionalDependencies，跳过但要留个话。
    if (serverDependencies.includes(relativePath.slice("node_modules/".length))) {
      throw new Error(`${relativePath} 在 package-lock.json 里但本地没安装——先 npm install，再重新打包`);
    }
    console.warn(`跳过未安装的可选依赖 ${relativePath}`);
    continue;
  }
  const target = path.join(serverTarget, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

pruneNonRuntimeFiles(serverTarget);

/**
 * Tauri 把 `src-tauri/resources` 拷到 `target/release/resources` 时是**增量**的：
 * 只新增和覆盖，从不删除。所以上面剪掉的文件会完整地留在上一次构建的副本里，
 * 而 package-portable / package-installer 读的恰好就是那份副本——于是「源树干净、
 * 包里全是快照」，MAX_PATH 那个毛病在包里原地复活（2.1.1 第一次构建就是这样：
 * 源树 0 个 `__image_snapshots__`，包里 42 条、最长条目名 227 字符）。
 * 每次都把副本删干净，逼 Tauri 从当前源树重新拷。
 */
removeTree(path.join(projectDir, "src-tauri", "target", "release", "resources"));

// 解压后的绝对路径 = 用户选的目录 + 便携包根目录名 + 这里的相对路径。
// Windows 的 MAX_PATH 是 260，在这一层就拦住，别等用户解不开包才发现。
const MAX_RELATIVE_PATH = 180;
const longest = longestRelativePath(serverTarget);
if (longest > MAX_RELATIVE_PATH) {
  throw new Error(
    `resources/server 里最长的相对路径有 ${longest} 字符（上限 ${MAX_RELATIVE_PATH}），解压后会超过 Windows 的 260 字符上限。请检查新加进来的依赖里有没有又长又没用的文件名。`,
  );
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
console.log(`服务端直接依赖：${serverDependencies.join(", ")}`);
console.log(`最长相对路径：${longest} 字符（上限 ${MAX_RELATIVE_PATH}）`);
