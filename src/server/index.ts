import path from "node:path";
import { createApp } from "./app.js";
import { loadEnvFiles } from "./security.js";

loadEnvFiles();

const port = Number(process.env.PORT || 17891);
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve("data");
const { app, context } = createApp({ dataDir });

const server = app.listen(port, "127.0.0.1", () => {
  console.log(`益达工作台 API: http://127.0.0.1:${port}`);
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

/**
 * 被桌面端拉起时（EXIT_WITH_PARENT=1）看守父进程：父进程消失就退出。
 *
 * 否则强杀桌面端（任务管理器、崩溃、卸载覆盖安装）会留下一个仍在监听
 * 17892 的后端孤儿进程，下次启动的新后端连端口都抢不回来，界面会连到
 * 旧进程上，出现“渠道保存不了”这类莫名故障。
 */
if (process.env.EXIT_WITH_PARENT === "1") {
  const parentPid = process.ppid;
  const guard = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      console.log("父进程已退出，后端随之退出");
      process.exit(0);
    }
  }, 5000);
  guard.unref();
}
