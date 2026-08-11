import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const projectDir = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
const version = String(packageJson.version);
const artifactDir = path.join(projectDir, "artifacts");
const zipPath = path.join(artifactDir, `Image-Relay-Studio-v${version}-source-with-handoff.zip`);

fs.mkdirSync(artifactDir, { recursive: true });
fs.rmSync(zipPath, { force: true });

const excludedPaths = [
  "./.env",
  "./artifacts",
  "./data",
  "./dist",
  "./node_modules",
  "./server.err.log",
  "./server.out.log",
  "./tmp-runtime-data",
  "./src-tauri/binaries",
  "./src-tauri/resources/server",
  "./src-tauri/target",
];
const excludeArgs = excludedPaths.map((excludedPath) => `--exclude=${excludedPath}`);
const tar = spawnSync(
  "tar.exe",
  ["-a", "-c", "-f", zipPath, ...excludeArgs, "."],
  { cwd: projectDir, stdio: "inherit" },
);
if (tar.error) throw tar.error;
if (tar.status !== 0) throw new Error(`tar exited with ${tar.status}`);

console.log(`Created ${zipPath}`);
