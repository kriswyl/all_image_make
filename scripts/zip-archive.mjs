import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Windows 上必须取 System32 里的 bsdtar：只有它支持 `-a`（按扩展名生成 zip）。
 * Git Bash 的 PATH 里排在前面的是 GNU tar，它压根做不出 zip——`-a` 被忽略，
 * 于是静默产出**一份未压缩的 tar，还顶着 .zip 的名字**。2.0.0~2.1.0 的便携包
 * 全是这样：所谓 115/217MB 的「zip」其实是一样大的 tar，一个字节都没压。
 * 这个坑在 web 开发模式下完全看不出来，只有把包解开才发现。
 *
 * bsdtar 也不认 GNU 专有的 `--force-local`，所以这里不传它——bsdtar 本身就是
 * Windows 程序，不会把 "D:" 当成远程主机名（那个参数当初正是为 GNU tar 加的）。
 */
const tarCommand =
  process.platform === "win32"
    ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
    : "tar";

export function createZip({ zipPath, cwd, paths, excludes = [] }) {
  fs.rmSync(zipPath, { force: true });
  const result = spawnSync(
    tarCommand,
    ["-a", "-c", "-f", zipPath, ...excludes.map((excluded) => `--exclude=${excluded}`), ...paths],
    { cwd, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`tar exited with ${result.status}`);

  // 兜底：真 zip 一定以 "PK" 开头。上面那个坑只能在这里拦住，
  // 否则会一路发出去，直到有人拿解压工具打开才发现。
  const header = Buffer.alloc(2);
  const handle = fs.openSync(zipPath, "r");
  try {
    fs.readSync(handle, header, 0, 2, 0);
  } finally {
    fs.closeSync(handle);
  }
  if (header.toString("latin1") !== "PK") {
    throw new Error(`${zipPath} 不是 zip 文件（tar 可能解析到了不支持 zip 的 GNU tar）`);
  }

  console.log(`Created ${zipPath}`);
}
