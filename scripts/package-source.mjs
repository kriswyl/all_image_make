import fs from "node:fs";
import path from "node:path";
import { createZip } from "./zip-archive.mjs";

const projectDir = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
const version = String(packageJson.version);
const artifactDir = path.join(projectDir, "artifacts");
const zipPath = path.join(artifactDir, `ezcanvas-v${version}-source-with-handoff.zip`);

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
createZip({ zipPath, cwd: projectDir, paths: ["."], excludes: excludedPaths });
