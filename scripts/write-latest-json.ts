import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Tauri 更新器的 manifest（latest.json）。
 *
 * 这个文件里最容易写错的两处：
 * - 平台键必须是 `windows-x86_64`，不是 `win-x64`；
 * - `signature` 要的是 `.sig` 文件的**内容**，不是文件路径。
 * 所以核心逻辑做成纯函数，配单元测试，CLI 只负责读文件、拼 URL、写盘。
 */

export type LatestJsonInput = {
  version: string;
  notes: string;
  pubDate: string;
  baseUrl: string;
  fileName: string;
  signature: string;
};

export type LatestJson = {
  version: string;
  notes: string;
  pub_date: string;
  platforms: {
    "windows-x86_64": {
      url: string;
      signature: string;
    };
  };
};

export function buildLatestJson(input: LatestJsonInput): LatestJson {
  const version = input.version.trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`版本号格式不对：${version}（应为 X.Y.Z）`);
  }
  const signature = input.signature.trim();
  if (!signature) throw new Error("签名内容为空");
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(signature)) {
    // 常见误用：把 .sig 的路径当成了内容
    throw new Error(`signature 看起来是文件路径而不是内容：${signature}`);
  }
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl)) throw new Error(`baseUrl 必须是 http(s) 地址：${input.baseUrl}`);

  return {
    version,
    notes: input.notes.trim(),
    pub_date: input.pubDate,
    platforms: {
      "windows-x86_64": {
        url: `${baseUrl}/${encodeURIComponent(input.fileName)}`,
        signature,
      },
    },
  };
}

/**
 * 从 CHANGELOG.md 里截取某个版本的小节作为更新说明。
 * 找不到就返回空串——更新说明缺了不影响安装，不该因此让发版失败。
 */
export function extractChangelogNotes(source: string, version: string): string {
  const lines = source.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => new RegExp(`^##\\s+v?${escapeRegExp(version)}\\b`).test(line.trim()));
  if (headingIndex < 0) return "";
  const collected: string[] = [];
  for (const line of lines.slice(headingIndex + 1)) {
    // 下一个一级小节，或者文档里的 `---` 分隔线，都是这一段结束的信号
    if (/^##\s+/.test(line) || /^---\s*$/.test(line)) break;
    collected.push(line);
  }
  return collected.join("\n").replace(/\s+$/, "").trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseArgs(argv: string[]) {
  const options: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} 缺少值`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function runCli() {
  const options = parseArgs(process.argv.slice(2));
  const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const version = options.version;
  const fileName = options.fileName;
  const baseUrl = options.baseUrl;
  const signaturePath = options.signature;
  if (!version || !fileName || !baseUrl || !signaturePath) {
    throw new Error(
      "Usage: tsx scripts/write-latest-json.ts --version 2.2.1 --file-name <asset.zip> --base-url <release-url> --signature <file.sig> [--changelog CHANGELOG.md] [--out latest.json]",
    );
  }
  const changelogPath = options.changelog ?? path.join(projectDir, "CHANGELOG.md");
  const notes = options.notes
    ?? extractChangelogNotes(fs.readFileSync(changelogPath, "utf8"), version);
  const signature = fs.readFileSync(signaturePath, "utf8");
  const latest = buildLatestJson({
    version,
    notes,
    pubDate: options.pubDate ?? new Date().toISOString(),
    baseUrl,
    fileName,
    signature,
  });
  const outPath = options.out ?? path.join(projectDir, "latest.json");
  fs.writeFileSync(outPath, `${JSON.stringify(latest, null, 2)}\n`, "utf8");
  console.log(`Wrote ${outPath}`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
