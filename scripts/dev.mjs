import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [
  spawn(npm, ["run", "dev:server"], { stdio: "inherit" }),
  spawn(npm, ["run", "dev:web"], { stdio: "inherit" }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 150);
}

for (const child of children) {
  child.on("exit", (code) => {
    if (!stopping && code && code !== 0) stop(code);
  });
}

process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
