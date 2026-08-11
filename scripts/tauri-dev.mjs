import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const backend = spawn(npm, ["run", "dev:server"], {
  stdio: "inherit",
  env: { ...process.env, PORT: "17892" },
  shell: process.platform === "win32",
});
const web = spawn(npm, ["run", "dev:web"], {
  stdio: "inherit",
  env: { ...process.env, VITE_API_BASE_URL: "http://127.0.0.1:17892" },
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
