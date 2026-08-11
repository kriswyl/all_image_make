import path from "node:path";
import { createApp } from "./app.js";
import { loadEnvFiles } from "./security.js";

loadEnvFiles();

const port = Number(process.env.PORT || 17891);
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve("data");
const { app, context } = createApp({ dataDir });

const server = app.listen(port, "127.0.0.1", () => {
  console.log(`Image Relay Studio API: http://127.0.0.1:${port}`);
  context.runner.resume();
});

function shutdown() {
  server.close(() => {
    context.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
