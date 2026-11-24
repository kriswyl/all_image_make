import fs from "node:fs";
import path from "node:path";
import { openAsBlob } from "node:fs";
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

const token = process.env.GITEE_TOKEN;

async function api(route, init = {}) {
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
  let response = await api(`/releases/tags/${encodeURIComponent(tag)}`);
  if (response.ok) {
    const release = await response.json();
    console.log(`使用已有 Gitee 发行版 ${tag} (id=${release.id})`);
    return release;
  }
  if (response.status !== 404) throw new Error(`读取 ${tag} 发行版失败 HTTP ${response.status}: ${await response.text()}`);

  const repoResponse = await api("");
  const repoInfo = repoResponse.ok ? await repoResponse.json() : null;
  const targetCommitish = repoInfo?.default_branch || "master";
  response = await api("/releases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tag_name: tag, name: title, body, target_commitish: targetCommitish, prerelease: false }),
  });
  if (!response.ok) throw new Error(`创建 ${tag} 发行版失败 HTTP ${response.status}: ${await response.text()}`);
  const release = await response.json();
  console.log(`已创建 Gitee 发行版 ${tag} (id=${release.id}, 分支 ${targetCommitish})`);
  return release;
}

async function removeAsset(release, name) {
  const existing = release.assets?.find((asset) => asset.name === name);
  if (!existing) return false;
  const response = await api(`/releases/${release.id}/attach_files/${existing.id}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`删除旧附件 ${name} 失败 HTTP ${response.status}: ${await response.text()}`);
  console.log(`已删除旧附件 ${name}`);
  return true;
}

async function attach(release, file, { replace = false } = {}) {
  const name = path.basename(file);
  const size = fs.statSync(file).size;
  if (size > MAX_ASSET_BYTES) {
    throw new Error(
      `附件 ${name} 为 ${(size / 1024 / 1024).toFixed(1)} MB，超过 Gitee 单附件上限 100 MB。` +
        "请改用便携版外链下载，不要把安装包塞进发行版。",
    );
  }
  if (release.assets?.some((asset) => asset.name === name)) {
    if (!replace) {
      console.log(`已有附件 ${name}，跳过`);
      return;
    }
    await removeAsset(release, name);
  }
  const form = new FormData();
  form.set("file", await openAsBlob(file), name);
  console.log(`正在上传 ${name} (${size} bytes)`);
  const response = await api(`/releases/${release.id}/attach_files`, { method: "POST", body: form });
  if (!response.ok) throw new Error(`上传 ${name} 失败 HTTP ${response.status}: ${await response.text()}`);
  console.log(`上传完成 ${name}`);
}

function parseArgs(argv) {
  const files = [];
  let tag = "";
  let updater = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--updater") {
      updater = argv[index + 1] ?? "";
      if (!updater) throw new Error("--updater 缺少文件路径");
      index += 1;
      continue;
    }
    if (!tag) tag = arg;
    else files.push(arg);
  }
  return { tag, files, updater };
}

async function main() {
  const { tag, files, updater } = parseArgs(process.argv.slice(2));
  if (!tag || (!files.length && !updater)) {
    throw new Error("用法：GITEE_TOKEN=... node scripts/publish-gitee-release.mjs <tag> <文件...> [--updater latest.json]");
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
    await attach(release, updater, { replace: true });
  }

  console.log("全部完成");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
