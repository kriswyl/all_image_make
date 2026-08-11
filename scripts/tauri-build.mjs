import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const env = { ...process.env, VITE_API_BASE_URL: "http://127.0.0.1:17892" };

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env, shell: process.platform === "win32" && command.toLowerCase().endsWith(".cmd") });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
  });
}

await run(npm, ["run", "build"]);
await run(process.execPath, ["scripts/prepare-tauri.mjs"]);
