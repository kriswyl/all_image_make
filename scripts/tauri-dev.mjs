import { spawn } from "node:child_process";
import { desktopApiEnv } from "./brand.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const env = desktopApiEnv();
const backend = spawn(npm, ["run", "dev:server"], {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});
const web = spawn(npm, ["run", "dev:web"], {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  backend.kill();
  web.kill();
  setTimeout(() => process.exit(code), 150);
}

for (const child of [backend, web]) {
  child.on("exit", (code) => {
    if (!stopping && code && code !== 0) stop(code);
  });
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
