import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openAsBlob } from "node:fs";
import { fileURLToPath } from "node:url";
import { readBrand } from "./brand.mjs";

/**
 * Gitee 发行版发布（按品牌参数化）。
 *
 * 用法：
 *   GITEE_TOKEN=xxx node scripts/publish-gitee-release.mjs <tag> <文件...>
 *   GITEE_TOKEN=xxx node scripts/publish-gitee-release.mjs <tag> <文件...> --updater latest.json
 *
 * 品牌从 CHATCANVAS_BRAND 决定（默认 chatcanvas），仓库地址取 brand.json 的
 * `desktop.updater.releasesUrl`，所以航天ai 不需要另写一份脚本。
 *
 * 两条容易踩的规则：
 * ① Gitee 不接受同名附件覆盖，更新清单必须「先删后传」，否则会堆出一串 latest.json；
 * ② 建 release 必须带 target_commitish，缺了会 400。
 */

/** Gitee 普通仓库单附件上限。超了先在这里报错，别等传到一半失败。 */
const MAX_ASSET_BYTES = 100 * 1024 * 1024;
/** 自动更新清单的固定标签，和 GitHub 那套保持一致。 */
const UPDATER_TAG = "updater";

const brand = readBrand();
const releasesUrl = brand.desktop.updater.releasesUrl;
// 用字符串构造而不是字面量：这个文件会被不同 shell / CI 环境读写，
// 字面量里的 `\/` 在个别环境下会被改写，导致正则只匹配到 "https:"。
const parsed = new RegExp("^https://gitee\\.com/([^/]+)/([^/]+)/releases/?$").exec(releasesUrl);
if (!parsed) throw new Error(`releasesUrl 不是 Gitee 发行版地址：${releasesUrl}`);
const [, owner, repo] = parsed;
const apiBase = `https://gitee.com/api/v5/repos/${owner}/${repo}`;

async function api(route, init = {}) {
  // 每次调用时再读：模块加载时就固定下来会让测试没法注入令牌，
  // 也会让「先 import 再设环境变量」的用法失效。
  const token = process.env.GITEE_TOKEN;
  if (!token) throw new Error("缺少 GITEE_TOKEN 环境变量");
  const response = await fetch(`${apiBase}${route}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
  });
  return response;
}

/** 取 CHANGELOG 里某个版本的小节；找不到就返回空串，别让说明缺失阻断发版。 */
function changelogSection(tag) {
  const file = path.join(process.cwd(), brand.desktop.updater.changelog);
  if (!fs.existsSync(file)) return "";
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const version = tag.replace(/^[a-z-]*v/, "");
  // 标题写法各版本不统一（`## v2.4.6` / `## 2.4.6`），三种都试一遍。
  const start = [`## ${tag} `, `## v${version} `, `## ${version} `]
    .map((heading) => text.indexOf(heading))
    .find((index) => index >= 0);
  if (start === undefined) return "";
  const bodyStart = text.indexOf("\n", start) + 1;
  const next = text.indexOf("\n## ", bodyStart);
  return text.slice(bodyStart, next < 0 ? undefined : next).trim();
}

async function ensureRelease(tag, title, body) {
  const lookup = await api(`/releases/tags/${encodeURIComponent(tag)}`);
  // Gitee 在 tag 不存在时可能返回 200 + 空 body（而不是 404），
  // 直接按 `response.ok` 判断会把 null 当成发行版往下用。
  const existing = lookup.ok ? await lookup.json().catch(() => null) : null;
  if (existing?.id) {
    console.log(`使用已有 Gitee 发行版 ${tag} (id=${existing.id})`);
    return existing;
  }
  if (!lookup.ok && lookup.status !== 404) {
    throw new Error(`读取 ${tag} 发行版失败 HTTP ${lookup.status}: ${await lookup.text()}`);
  }

  const repoResponse = await api("");
  const repoInfo = repoResponse.ok ? await repoResponse.json() : null;
  const targetCommitish = repoInfo?.default_branch || "master";
  const created = await api("/releases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tag_name: tag, name: title, body, target_commitish: targetCommitish, prerelease: false }),
  });
  if (!created.ok) throw new Error(`创建 ${tag} 发行版失败 HTTP ${created.status}: ${await created.text()}`);
  const release = await created.json();
  console.log(`已创建 Gitee 发行版 ${tag} (id=${release.id}, 分支 ${targetCommitish})`);
  return release;
}

async function removeAsset(release, name) {
  const existing = release.assets?.find((asset) => asset.name === name);
  if (!existing) return false;
  const response = await api(`/releases/${release.id}/attach_files/${existing.id}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`删除旧附件 ${name} 失败 HTTP ${response.status}: ${await response.text()}`);
  // 必须同步内存里的列表：后面 attach 会用它判断「是否已存在」，
  // 不同步就会出现「文件已删除、脚本却以为还在，于是跳过上传并报告成功」。
  release.assets = (release.assets ?? []).filter((asset) => asset.name !== name);
  console.log(`已删除旧附件 ${name}`);
  return true;
}

/** 下载附件内容；失败返回 null（调用方必须把 null 当成「无法确认」。 */
async function downloadAsset(asset) {
  try {
    const response = await fetch(asset.browser_download_url, { redirect: "follow" });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * 上传附件。
 *
 * `immutable`（安装包与签名）为 true 时，同名附件只要内容不同就拒绝——
 * 已发布的安装包被覆盖会让清单里的签名对不上，已装用户下载后验签失败。
 * 只有生成出来的清单走 `immutable: false`，且它由 replaceManifest 备份保护。
 *
 * 这里比对的是完整内容而不是大小：等长但内容不同的两次构建并不罕见，
 * 只看 size 会把它们当成同一份，最后表现为「发布成功、客户端验签失败」。
 */
async function attach(release, file, { immutable = true } = {}) {
  const name = path.basename(file);
  const local = fs.readFileSync(file);
  const size = local.length;
  if (size > MAX_ASSET_BYTES) {
    throw new Error(
      `附件 ${name} 为 ${(size / 1024 / 1024).toFixed(1)} MB，超过 Gitee 单附件上限 100 MB。` +
        "请改用便携版外链下载，不要把安装包塞进发行版。",
    );
  }

  const existing = release.assets?.find((asset) => asset.name === name);
  if (existing) {
    if (!immutable) {
      await removeAsset(release, name);
    } else {
      const online = await downloadAsset(existing);
      if (!online) {
        throw new Error(
          `线上已有 ${name}，但读取失败，无法确认它和本次构建是否同一份文件。\n` +
            "这种情况下继续发布，更新清单的签名可能指向错误内容，所以本次不继续。稍后重试。",
        );
      }
      if (online.length === size && online.equals(local)) {
        console.log(`${name} 已存在且内容一致，跳过`);
        return;
      }
      throw new Error(
        [
          `线上已有 ${name}，但内容和本次构建不同（线上 ${online.length} B，本地 ${size} B）。`,
          "已发布的安装包不能覆盖：更新清单里的签名会对不上，已安装用户下载后会验签失败。",
          "正确做法是把版本号加一后重新发布，不要复用同一个 tag。",
        ].join("\n"),
      );
    }
  }

  const form = new FormData();
  form.set("file", await openAsBlob(file), name);
  console.log(`正在上传 ${name} (${size} bytes)`);
  const response = await api(`/releases/${release.id}/attach_files`, { method: "POST", body: form });
  if (!response.ok) throw new Error(`上传 ${name} 失败 HTTP ${response.status}: ${await response.text()}`);
  console.log(`上传完成 ${name}`);
  release.assets = [...(release.assets ?? []), { name }];
}

/** 语义化比较，只处理 X.Y.Z（更新清单里就是这个格式）。 */
function compareVersions(left, right) {
  const parse = (value) => String(value).split(".").map((part) => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * 替换自动更新清单。
 *
 * 三条硬规则，每一条都对应一种「发布成功但客户端挂了」的故障：
 *   1. 线上已有清单却读不到 → 直接放弃。拿不到备份就删，等于让所有用户的检查更新中断；
 *   2. 读到了但不合法 → 放弃，不猜；
 *   3. 版本会倒退 → 放弃，除非显式 --allow-downgrade。
 * 只有三条都过，才动线上文件。
 */
async function replaceManifest(release, file, { allowDowngrade = false } = {}) {
  const next = JSON.parse(fs.readFileSync(file, "utf8"));
  const existing = release.assets?.find((asset) => asset.name === "latest.json");

  let backupText = null;
  if (existing) {
    const online = await downloadAsset(existing);
    if (!online) {
      throw new Error(
        "线上已有更新清单，但读取失败（网络或附件地址异常）。\n" +
          "此时删除它会让所有已安装用户的检查更新中断，所以本次不替换；稍后重试。",
      );
    }
    backupText = online.toString("utf8");
    let current;
    try {
      current = JSON.parse(backupText);
    } catch {
      throw new Error("线上更新清单不是合法 JSON，无法判断版本。请先人工确认线上状态再发布。");
    }
    if (current?.version && compareVersions(next.version, current.version) < 0 && !allowDowngrade) {
      throw new Error(
        `更新清单版本会倒退：线上 ${current.version} → 本次 ${next.version}。\n` +
          "客户端不会把降级当成更新，还会让已经升到新版的用户看不到后续版本。确认要回退请加 --allow-downgrade。",
      );
    }
    await removeAsset(release, "latest.json");
  }

  try {
    await attach(release, file, { immutable: false });
  } catch (error) {
    if (backupText) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitee-manifest-"));
      const restorePath = path.join(dir, "latest.json");
      fs.writeFileSync(restorePath, backupText, "utf8");
      try {
        await attach(release, restorePath, { immutable: false });
        console.log("新清单上传失败，已恢复上一份可用清单");
      } catch (restoreError) {
        console.error(`恢复旧清单也失败：${restoreError instanceof Error ? restoreError.message : restoreError}`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    throw error;
  }
}

function parseArgs(argv) {
  const files = [];
  let tag = "";
  let updater = "";
  let allowDowngrade = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--replace") {
      // 曾经允许覆盖已发布的安装包，但那会让清单签名与线上文件对不上。
      throw new Error("--replace 已移除：已发布的安装包不能覆盖，请把版本号加一后重新发布。");
    }
    if (arg === "--allow-downgrade") {
      allowDowngrade = true;
      continue;
    }
    if (arg === "--updater") {
      updater = argv[index + 1] ?? "";
      if (!updater) throw new Error("--updater 缺少文件路径");
      index += 1;
      continue;
    }
    if (!tag) tag = arg;
    else files.push(arg);
  }
  return { tag, files, updater, allowDowngrade };
}

async function main() {
  const { tag, files, updater, allowDowngrade } = parseArgs(process.argv.slice(2));
  if (!tag || (!files.length && !updater)) {
    throw new Error(
      "用法：GITEE_TOKEN=... node scripts/publish-gitee-release.mjs <tag> <文件...> [--updater latest.json] [--allow-downgrade]",
    );
  }

  const notes = changelogSection(tag) || `${brand.productName} ${tag}`;

  if (files.length) {
    const release = await ensureRelease(
      tag,
      `${brand.productName} ${tag}`,
      `## 更新内容\n\n${notes}\n\n提供 Windows x64 安装包。`,
    );
    for (const file of files) await attach(release, file);
  }

  // 清单永远最后传：先保证不可变附件都在，再切版本指向。
  if (updater) {
    const release = await ensureRelease(UPDATER_TAG, UPDATER_TAG, "自动更新清单（latest.json），由发布流程维护，请勿手动修改。");
    await replaceManifest(release, updater, { allowDowngrade });
  }

  console.log("全部完成");
}

/** 项目目录可能是符号链接（Windows junction），两边都要过 realpath 再比。 */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// 导出给测试用：发布链路的几个判断（版本倒退、附件内容比对、清单备份）
// 都是「错了就静默发坏包」的类型，必须有回归测试兜着。
export { compareVersions, attach, replaceManifest, downloadAsset };

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
