/*
 * 浏览器预览用的 Vite 启动器。
 *
 * `npm run dev:web` 本身不带 VITE_API_BASE_URL，浏览器模式下 apiBase 为空、
 * 请求会打到 Vite 的 /api 代理；而代理写死 17891。桌面热重载常常把 API
 * 起在 17892，于是预览面板里所有请求都 502。
 *
 * 这里先探一下 17892 / 17891 哪个活着，再让 Vite 把同源 /api 代理过去。
 * 不走 VITE_API_BASE_URL：那会变成跨域请求，而后端的 CORS 只放行 5173。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const candidates = [
  process.env.API_PORT && `http://127.0.0.1:${process.env.API_PORT}`,
  "http://127.0.0.1:17892",
  "http://127.0.0.1:17891",
].filter(Boolean);

async function pickApiBase() {
  if (process.env.VITE_API_BASE_URL) return process.env.VITE_API_BASE_URL;
  for (const base of candidates) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1200) });
      if (response.ok) return base;
    } catch {
      // 这个端口没有后端，试下一个
    }
  }
  return candidates[candidates.length - 1];
}

const apiBase = await pickApiBase();
const port = process.env.PREVIEW_PORT || "5199";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

console.log(`[preview-web] API ${apiBase} · Vite http://127.0.0.1:${port}`);

const child = spawn(npm, ["run", "dev:web", "--", "--port", port], {
  cwd: projectRoot,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, VITE_API_PROXY: apiBase, VITE_API_BASE_URL: "" },
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill());
}
child.on("exit", (code) => process.exit(code ?? 0));
