import fs from "node:fs";
import os from "node:os";
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
  console.log(`已删除旧附件 ${name}`);
  return true;
}

/** 线上附件的实际字节数。Gitee 的 asset 对象不一定带 size，只能 HEAD 一下。 */
async function remoteSize(asset) {
  try {
    const head = await fetch(asset.browser_download_url, { method: "HEAD", redirect: "follow" });
    return Number(head.headers.get("content-length")) || 0;
  } catch {
    return 0;
  }
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
  const existing = release.assets?.find((asset) => asset.name === name);
  if (existing) {
    if (!replace) {
      // 跳过同名附件看起来无害，但如果本地这份是「重新构建」出来的，
      // 清单里的签名就会指向线上那份旧包，客户端下载后验签必然失败。
      // 大小不同就是最直接的证据，宁可报错让人显式决定。
      const online = await remoteSize(existing);
      if (online && online !== size) {
        throw new Error(
          [
            `线上已有同名附件 ${name}，但大小不一致：线上 ${online} B，本地 ${size} B。`,
            "这说明它是上一次构建的产物。直接跳过会让更新清单里的签名与线上安装包对不上，客户端会验签失败。",
            "确认要用本次构建覆盖，请加 --replace 重新上传安装包和签名。",
          ].join("\n"),
        );
      }
      console.log(`已有附件 ${name}（大小一致），跳过`);
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

/** 读线上的最新清单；没有就返回 null。 */
async function readOnlineManifest() {
  const lookup = await api(`/releases/tags/${UPDATER_TAG}`);
  const info = lookup.ok ? await lookup.json().catch(() => null) : null;
  const asset = info?.assets?.find((item) => item.name === "latest.json");
  if (!asset) return null;
  const response = await fetch(asset.browser_download_url, { redirect: "follow" });
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

/**
 * 替换自动更新清单。
 *
 * 不能简单地「删旧 → 传新」：中间任何一步失败，线上就没有清单了，
 * 所有已安装用户的检查更新会直接中断。这里的做法是先把旧内容读进内存，
 * 上传失败时用同一份内容补回去。
 */
async function replaceManifest(release, file, { allowDowngrade = false } = {}) {
  const next = JSON.parse(fs.readFileSync(file, "utf8"));
  const current = await readOnlineManifest();
  if (current?.version && compareVersions(next.version, current.version) < 0 && !allowDowngrade) {
    throw new Error(
      `更新清单版本会倒退：线上 ${current.version} → 本次 ${next.version}。\n` +
        "客户端不会把降级当成更新，还会让已经升到新版的用户看不到后续版本。确认要回退请加 --allow-downgrade。",
    );
  }

  const existing = release.assets?.find((asset) => asset.name === "latest.json");
  let backup = null;
  if (existing) {
    const response = await fetch(existing.browser_download_url, { redirect: "follow" });
    if (response.ok) backup = await response.text();
    await removeAsset(release, "latest.json");
  }

  try {
    await attach(release, file);
  } catch (error) {
    if (backup) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitee-manifest-"));
      const restorePath = path.join(dir, "latest.json");
      fs.writeFileSync(restorePath, backup, "utf8");
      try {
        await attach(release, restorePath);
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
  let replace = false;
  let allowDowngrade = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--replace") {
      replace = true;
      continue;
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
  return { tag, files, updater, replace, allowDowngrade };
}

async function main() {
  const { tag, files, updater, replace, allowDowngrade } = parseArgs(process.argv.slice(2));
  if (!tag || (!files.length && !updater)) {
    throw new Error(
      "用法：GITEE_TOKEN=... node scripts/publish-gitee-release.mjs <tag> <文件...> [--updater latest.json] [--replace] [--allow-downgrade]",
    );
  }

  const notes = changelogSection(tag) || `${brand.productName} ${tag}`;

  if (files.length) {
    const release = await ensureRelease(
      tag,
      `${brand.productName} ${tag}`,
      `## 更新内容\n\n${notes}\n\n提供 Windows x64 安装包。`,
    );
    for (const file of files) await attach(release, file, { replace });
  }

  // 清单永远最后传：先保证不可变附件都在，再切版本指向。
  if (updater) {
    const release = await ensureRelease(UPDATER_TAG, UPDATER_TAG, "自动更新清单（latest.json），由发布流程维护，请勿手动修改。");
    await replaceManifest(release, updater, { allowDowngrade });
  }

  console.log("全部完成");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
